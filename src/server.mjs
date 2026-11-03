import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './shared/store.mjs';
import { createDemoState } from './shared/seed.mjs';
import { DomainError } from './shared/errors.mjs';
import { createBusinessService, createMasterDataService } from './business/index.mjs';
import { createIntakeService } from './intake/index.mjs';
import { createDocumentStore } from './documents/store.mjs';
import { createEdgeService } from './edge-cloud/index.mjs';
import { createPrintService } from './printing/index.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const boss = Object.freeze({ id: 'local-owner', role: 'boss', active: true });
const MAX_BODY = 512 * 1024;
const constantEqual = (a, b) => {
  if (typeof a !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
function pathId(value) {
  try { return decodeURIComponent(value); }
  catch { throw new DomainError('INVALID_PATH', '路径编码无效', 400); }
}

function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new DomainError('JSON_REQUIRED', '请使用JSON请求', 415);
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0; let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY) { rejected = true; reject(new DomainError('BODY_TOO_LARGE', '内容过大，请减少明细', 413)); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (rejected) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
        resolveBody(value);
      } catch { reject(new DomainError('INVALID_JSON', '请求内容无效', 400)); }
    });
  });
}

export function createApplication({ dataDirectory = join(projectRoot, 'data', 'local'), pythonPath, now = () => new Date().toISOString() } = {}) {
  mkdirSync(dataDirectory, { recursive: true });
  const store = createStore({ filename: join(dataDirectory, 'billing.sqlite'), initialState: createDemoState() });
  const documents = createDocumentStore({ directory: join(dataDirectory, 'documents'), pythonPath });
  const business = createBusinessService({ store, documentStore: documents, now });
  const intake = createIntakeService({ store, now });
  const masters = createMasterDataService({ store, now });
  const edge = createEdgeService({ store, now });
  const printing = createPrintService({ store, documentStore: documents, now,
    authenticateDevice: credentials => edge.authenticate(credentials, 'PRINT') });
  const csrf = randomBytes(32).toString('hex');
  const session = randomBytes(32).toString('hex');
  // Cookies do not distinguish ports. Separate local workspaces must not
  // invalidate each other when the desktop and phone test views stay open.
  const sessionCookieName = `billing_local_session_${createHash('sha256').update(resolve(dataDirectory)).digest('hex').slice(0, 12)}`;
  for (const [customerId, skuId, priceCents] of [['C-A','SKU-S',10000], ['C-B','SKU-S',10000], ['C-A','SKU-T',6000], ['C-B','SKU-T',6000]]) {
    const quote = business.quote({ customerId, skuId, unit: '箱' });
    if (quote.priceCents === null) business.savePrice({ operationId: `seed:${customerId}:${skuId}`, customerId, skuId, unit: '箱', priceCents, expectedVersion: quote.version }, boss);
  }
  let scheduler;
  function publicJobs() {
    return intake.listJobs().map(job => ({
      id: job.id, batchId: job.batchId, batchVersion: job.batchVersion,
      sourceId: job.sourceId, conversationId: job.conversationId, customerHint: job.customerHint,
      messageIds: job.messageIds, status: job.status, createdAt: job.createdAt,
      candidate: job.candidate, candidateVersion: job.candidateVersion,
      completedAt: job.completedAt, reviewOrderId: job.reviewOrderId,
    }));
  }
  function reviewDraft(id) {
    const state = store.read();
    const job = state.edgeJobs.find(item => item.id === id);
    if (!job) throw new DomainError('NOT_FOUND', '识别任务不存在', 404);
    if (job.status !== 'AWAITING_REVIEW' || !job.candidateVersion) throw new DomainError('REVIEW_NOT_READY', '任务尚未完成识别或已被人工确认', 409);
    const originalMessages = state.messages.filter(message => message.sourceId === job.sourceId
      && message.conversationId === job.conversationId && message.result?.batchId === job.batchId
      && job.messageIds.includes(message.messageId)).map(message => ({
        messageId: message.messageId, type: message.type, text: message.text,
        customerHint: message.customerHint, media: message.media, receivedAt: message.receivedAt,
      }));
    return { sourceJobId: job.id, candidateVersion: job.candidateVersion,
      draft: { customerId: job.candidate.customerId, items: job.candidate.items },
      issues: job.candidate.issues, originalMessages };
  }
  function deviceCredentials(req) {
    const authorization = req.headers.authorization;
    return { deviceId: req.headers['x-device-id'], token: typeof authorization === 'string'
      && /^Bearer [^\s]+$/.test(authorization) ? authorization.slice(7) : undefined };
  }
  function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ ok: true, data }));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      const hostName = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!['127.0.0.1','localhost','::1'].includes(hostName)) throw new DomainError('LOCAL_ONLY', '本开发版只接受本机访问', 403);
      const url = new URL(req.url, `http://${host}`);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('CROSS_SITE', '请从本系统页面操作', 403);
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname.startsWith('/api/edge/')) {
          const credentials = deviceCredentials(req);
          const printFile = /^\/api\/edge\/print\/([^/]+)\/document$/.exec(url.pathname);
          if (req.method === 'GET' && printFile) {
            const attempt = printing.readableAttempt({ ...credentials, attemptId: pathId(printFile[1]), leaseToken: req.headers['x-print-lease-token'] });
            const bytes = documents.read(attempt.documentId, 'pdf');
            if (createHash('sha256').update(bytes).digest('hex') !== attempt.documentSha256) throw new DomainError('DOCUMENT_INTEGRITY_FAILED', '打印文件摘要不符', 503);
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(bytes);
          }
          if (req.method !== 'POST') throw new DomainError('METHOD_NOT_ALLOWED', '设备接口须用POST', 405);
          const input = await body(req);
          if (url.pathname === '/api/edge/inference/claim') return json(res, edge.claimInference(credentials));
          if (url.pathname === '/api/edge/inference/renew') return json(res, edge.renewInference({ ...input, ...credentials }));
          if (url.pathname === '/api/edge/inference/complete') return json(res, edge.completeInference({ ...input, ...credentials }));
          if (url.pathname === '/api/edge/print/claim') return json(res, printing.claimPrint(credentials));
          if (url.pathname === '/api/edge/print/result') return json(res, printing.markSubmitted({ ...input, ...credentials }, credentials));
          throw new DomainError('NOT_FOUND', '设备接口不存在', 404);
        }
        if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
          res.setHeader('Set-Cookie', `${sessionCookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
          const state = store.read();
          return json(res, { mode: 'LOCAL_DEVELOPMENT', csrfToken: csrf, customers: state.customers, products: state.products,
            customerHistoryReturn: { canSave: false, unavailableReason: '退货数量规则尚未确认，当前可核对预览，暂不能保存。' },
            prices: Object.values(state.prices), stats: business.getStats(), orders: business.listOrders(),
            batches: intake.listBatches(), jobs: publicJobs(), printAttempts: printing.list(),
            devices: edge.listDevices(), correctionSampleCount: state.correctionSamples.length });
        }
        const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
        if (!constantEqual(cookie, session)) throw new DomainError('SESSION_REQUIRED', '本地会话已失效，请刷新页面', 401);
        if (req.method === 'POST') {
          if (!constantEqual(req.headers['x-csrf-token'], csrf)) throw new DomainError('CSRF_REQUIRED', '操作校验已失效，请刷新后重试', 403);
          if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new DomainError('ORIGIN_REJECTED', '来源不符', 403);
          const input = await body(req);
          if (url.pathname === '/api/prices/save') return json(res, business.savePrice(input, boss));
          if (url.pathname === '/api/prices/restore') return json(res, business.restorePrice(input, boss));
          if (url.pathname === '/api/sales') return json(res, business.createSale(input, boss));
          if (url.pathname === '/api/returns') return json(res, business.createReturn(input, boss));
          if (url.pathname === '/api/intake/messages') return json(res, intake.receive(input));
          if (url.pathname === '/api/customers') return json(res, masters.saveCustomer(input, boss));
          if (url.pathname === '/api/products') return json(res, masters.saveProduct(input, boss));
          if (url.pathname === '/api/devices') return json(res, edge.registerDevice(input, boss));
          const revoke = /^\/api\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
          if (revoke) return json(res, edge.revokeDevice({ ...input, deviceId: pathId(revoke[1]) }, boss));
          const correction = /^\/api\/orders\/([^/]+)\/corrections$/.exec(url.pathname);
          if (correction) return json(res, business.correctSale(pathId(correction[1]), input, boss));
          if (url.pathname === '/api/print-attempts') return json(res, printing.queue(input, boss));
          const paper = /^\/api\/print-attempts\/([^/]+)\/paper$/.exec(url.pathname);
          if (paper) return json(res, printing.confirmPaper({ ...input, attemptId: pathId(paper[1]) }, boss));
          const reprint = /^\/api\/print-attempts\/([^/]+)\/reprint$/.exec(url.pathname);
          if (reprint) return json(res, printing.reprint({ ...input, attemptId: pathId(reprint[1]) }, boss));
          throw new DomainError('NOT_FOUND', '接口不存在', 404);
        }
        if (req.method !== 'GET') throw new DomainError('METHOD_NOT_ALLOWED', '请求方式不支持', 405);
        if (url.pathname === '/api/prices') return json(res, business.quote(Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/return-prices') return json(res, business.returnQuote(Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/orders') return json(res, masters.queryOrders(Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/stats') return json(res, masters.getPeriodStats(Object.fromEntries(url.searchParams)));
        if (url.pathname === '/api/customers/match') return json(res, masters.matchCustomer(url.searchParams.get('q')));
        if (url.pathname === '/api/devices') return json(res, edge.listDevices());
        if (url.pathname === '/api/print-attempts') return json(res, printing.list());
        const review = /^\/api\/review-jobs\/([^/]+)$/.exec(url.pathname);
        if (review) return json(res, reviewDraft(pathId(review[1])));
        const document = /^\/api\/documents\/([a-f0-9-]{36})\.(png|pdf)$/.exec(url.pathname);
        if (document) {
          const state = store.read();
          const mimeType = document[2] === 'pdf' ? 'application/pdf' : 'image/png';
          const known = [...state.orders.flatMap(o => [o.document, ...(o.revisions ?? []).map(v => v.document)]),
            ...state.printAttempts.map(attempt => attempt.document)].find(value => value?.id === document[1] && value.mimeType === mimeType);
          if (!known) throw new DomainError('NOT_FOUND', '单据不存在', 404);
          const bytes = documents.read(document[1], document[2]);
          if (createHash('sha256').update(bytes).digest('hex') !== known.sha256) throw new DomainError('DOCUMENT_INTEGRITY_FAILED', '单据文件摘要不符，请检查存储', 503);
          res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(bytes);
        }
        const order = /^\/api\/orders\/([^/]+)$/.exec(url.pathname);
        if (order) return json(res, business.getOrder(pathId(order[1])));
        throw new DomainError('NOT_FOUND', '接口不存在', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError('METHOD_NOT_ALLOWED', '请求方式不支持', 405);
      const staticFiles = new Map([['/','index.html'],['/app.mjs','app.mjs'],['/style.css','style.css'],
        ['/mobile','mobile.html'], ['/mobile-app.mjs','mobile-app.mjs'], ['/mobile.css','mobile.css'],
        ['/mobile-test','mobile-test.html'], ['/mobile-test.mjs','mobile-test.mjs'], ['/mobile-test.css','mobile-test.css']]);
      const name = staticFiles.get(url.pathname);
      if (!name) throw new DomainError('NOT_FOUND', '页面不存在', 404);
      const content = readFileSync(join(projectRoot, 'web', name));
      const type = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(name)];
      // Only the explicit phone test view may be embedded by this same origin.
      // The normal business page and the test shell remain protected against
      // framing by another origin; the shell can only load local frames.
      const phoneFrame = url.pathname === '/mobile' && url.searchParams.get('mobile-test') === '1';
      const frameSources = url.pathname === '/mobile-test' ? "; frame-src 'self'" : '';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors ${phoneFrame ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'${frameSources}` });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const expected = error instanceof DomainError;
      const status = expected ? error.status : 500;
      if (!expected) console.error('Local request failure:', error.message);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: { code: expected ? error.code : 'INTERNAL_ERROR', message: expected ? error.message : '处理失败，请保留原操作后重试', details: expected ? error.details : {} } }));
    }
  });
  return { server, store, business, intake, masters, edge, printing,
    async start({ port = 0 } = {}) {
      intake.sealDue();
      printing.expireClaims();
      scheduler = setInterval(() => { try { intake.sealDue(); printing.expireClaims(); } catch (error) { console.error('Local scheduler:', error.message); } }, 1000);
      scheduler.unref();
      await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { clearInterval(scheduler); await new Promise(resolveClose => server.listening ? server.close(resolveClose) : resolveClose()); store.close(); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mobileTest = process.argv.includes('--mobile-test');
  const port = Number(process.env.BILLING_PORT ?? (mobileTest ? '3213' : '3210'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BILLING_PORT must be 1..65535');
  const app = createApplication(mobileTest ? { dataDirectory: join(projectRoot, 'data', 'mobile-test') } : {});
  const address = await app.start({ port });
  console.log(mobileTest ? `手机端操作测试（独立测试数据）：http://localhost:${port}/mobile-test` : `本地开发版（合成样例）：${address}`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
