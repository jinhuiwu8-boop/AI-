import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../shared/errors.mjs';

const script = fileURLToPath(new URL('../../tools/render_bill_image.py', import.meta.url));
const paperScript = fileURLToPath(new URL('../../tools/render_bill_pdf.py', import.meta.url));
const bundledPython = 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';

export function createDocumentStore({ directory, pythonPath = process.env.BILLING_PYTHON || bundledPython }) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  function persist(bytes, extension, mimeType, snapshot, extra = {}) {
    const id = randomUUID();
    const temporary = join(root, `${id}.tmp`);
    const target = join(root, `${id}.${extension}`);
    let fd;
    try {
      fd = openSync(temporary, 'wx');
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, target);
      const actual = readFileSync(target);
      const sha256 = createHash('sha256').update(actual).digest('hex');
      if (sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Document readback mismatch');
      return { id, mimeType, sha256, relativePath: `${id}.${extension}`, createdAt: snapshot.createdAt ?? new Date().toISOString(), ...extra };
    } catch {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* Not created or already renamed. */ }
      throw new DomainError('DOCUMENT_NOT_PERSISTED', '单据文件尚未持久保存，未完成本次处理。', 503);
    }
  }
  return {
    save(snapshot) {
      const rendered = spawnSync(pythonPath, ['-X', 'utf8', script], {
        input: Buffer.from(JSON.stringify(snapshot)), timeout: 15000, maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      const png = rendered.stdout;
      if (rendered.error || rendered.status !== 0 || !png?.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        throw new DomainError('DOCUMENT_NOT_PERSISTED', '正式图片生成失败，订单尚未完成，请重试同一请求。', 503);
      }
      return persist(png, 'png', 'image/png', snapshot);
    },
    savePaper(snapshot, template = {}) {
      const rendered = spawnSync(pythonPath, ['-X', 'utf8', paperScript], {
        input: Buffer.from(JSON.stringify({ snapshot, template })), timeout: 15000,
        maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      if (rendered.error || rendered.status !== 0 || !rendered.stdout?.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new DomainError('DOCUMENT_NOT_PERSISTED', '套打PDF生成失败或金额超出纸面，请核对后重试。', 503);
      }
      return persist(rendered.stdout, 'pdf', 'application/pdf', snapshot, {
        templateId: 'wenbo-130x190-draft1', calibrationStatus: 'UNVALIDATED',
        widthMm: 130, heightMm: 190,
      });
    },
    read(id, extension = 'png') {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new DomainError('DOCUMENT_NOT_FOUND', '单据不存在', 404);
      if (!['png','pdf'].includes(extension)) throw new DomainError('DOCUMENT_NOT_FOUND', '单据不存在', 404);
      try { return readFileSync(join(root, `${id}.${extension}`)); }
      catch { throw new DomainError('DOCUMENT_NOT_FOUND', '单据不存在', 404); }
    },
  };
}
