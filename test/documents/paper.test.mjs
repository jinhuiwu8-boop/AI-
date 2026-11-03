import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createDocumentStore } from '../../src/documents/store.mjs';

const python = process.env.BILLING_PYTHON || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const sample = () => ({ type: 'SALE', customerName: '合成测试商店', createdAt: '2026-10-31T08:00:00Z',
  items: [{ productName: '合成测试酒', unit: '箱', quantity: 2, priceCents: 12340, lineAmountCents: 24680 }],
  totals: { goodsCents: 24680, creditCents: 0, waiverCents: 0, receivableCents: 24680 } });

test('paper PDF is persisted, hash verified, Chinese embedded and physical size 130x190mm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-paper-'));
  try {
    const documents = createDocumentStore({ directory: dir });
    const paper = documents.savePaper(sample());
    const bytes = documents.read(paper.id, 'pdf');
    assert.equal(paper.mimeType, 'application/pdf');
    assert.equal(paper.calibrationStatus, 'UNVALIDATED');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), paper.sha256);
    assert.deepEqual(bytes, readFileSync(join(dir, paper.relativePath)));
    const inspect = spawnSync(python, ['-X', 'utf8', '-c',
      "import json,sys;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);p=r.pages[0];print(json.dumps({'width':float(p.mediabox.width)*25.4/72,'height':float(p.mediabox.height)*25.4/72,'text':p.extract_text(),'font':str(p['/Resources']['/Font'].get_object())},ensure_ascii=False))",
      join(dir, paper.relativePath)], { encoding: 'utf8', windowsHide: true });
    assert.equal(inspect.status, 0, inspect.stderr);
    const info = JSON.parse(inspect.stdout);
    assert.ok(Math.abs(info.width - 130) < 0.001);
    assert.ok(Math.abs(info.height - 190) < 0.001);
    assert.ok(info.text.includes('合成测试商店'));
    assert.ok(info.text.includes('合成测试酒'));
    assert.ok(info.text.includes('123.40'));
    assert.equal(info.text.includes('文博'), false, 'fixed stationery must not be reprinted');
    assert.throws(() => documents.read(paper.id, 'png'), { code: 'DOCUMENT_NOT_FOUND' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paper rejects amounts that cannot fit rather than truncating or saving a false success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-paper-limit-'));
  try {
    const documents = createDocumentStore({ directory: dir });
    const tooLarge = sample(); tooLarge.items[0].lineAmountCents = 10000000;
    assert.throws(() => documents.savePaper(tooLarge), { code: 'DOCUMENT_NOT_PERSISTED' });
    const tooWide = sample(); tooWide.items[0].productName = '非常长的商品名称'.repeat(30);
    assert.throws(() => documents.savePaper(tooWide), { code: 'DOCUMENT_NOT_PERSISTED' });
    assert.throws(() => documents.savePaper(sample(), { offsetXmm: 21 }), { code: 'DOCUMENT_NOT_PERSISTED' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
