import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../../src/server.mjs';

async function client(app) {
  const url = await app.start();
  const boot = await fetch(url + '/api/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  const initial = (await boot.json()).data;
  return {
    url, cookie, initial,
    async get(path) {
      const response = await fetch(url + path, { headers: { cookie } });
      return { status: response.status, body: await response.json() };
    },
    async post(path, value, headers = {}) {
      const response = await fetch(url + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken, ...headers }, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('HTTP real PNG, correction price, partial return, print idempotency and restart preserve economic results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-http-'));
  let app = createApplication({ dataDirectory: dir });
  try {
    let c = await client(app);
    const q = (await c.get('/api/prices?customerId=C-A&skuId=SKU-S&unit=' + encodeURIComponent('箱'))).body.data;
    assert.equal(q.priceCents, 10000);
    const request = { operationId: 'http-sale-1', customerId: 'C-A', mode: 'ELECTRONIC', checked: true,
      items: [{ skuId: 'SKU-S', unit: '箱', quantity: 2, priceCents: 10000, priceVersion: q.version }], creditCents: 0, waiverCents: 0 };
    const saleResult = await c.post('/api/sales', request);
    assert.equal(saleResult.status, 200, JSON.stringify(saleResult.body));
    const sale = saleResult.body.data;
    assert.equal(sale.totals.goodsCents, 20000);
    const pngResponse = await fetch(c.url + `/api/documents/${sale.document.id}.png`, { headers: { cookie: c.cookie } });
    assert.equal(pngResponse.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await pngResponse.arrayBuffer());
    assert.equal(png.readUInt32BE(16), 1000);
    assert.ok(png.length > 1000);
    assert.equal(createHash('sha256').update(png).digest('hex'), sale.document.sha256);
    assert.equal((await c.post('/api/sales', request)).body.data.id, sale.id);
    const corrected = await c.post(`/api/orders/${sale.id}/corrections`, {
      operationId: 'http-correction-1', expectedRevision: 1, customerId: 'C-A',
      items: [{ ...request.items[0], lineId: sale.items[0].lineId, priceCents: 9000 }], creditCents: 0, waiverCents: 0,
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    assert.equal(corrected.body.data.revisions.length, 2);
    assert.equal(corrected.body.data.revisions[0].items[0].priceCents, 10000);
    assert.equal((await c.get('/api/prices?customerId=C-A&skuId=SKU-S&unit=' + encodeURIComponent('箱'))).body.data.priceCents, 9000);
    const retRequest = { operationId: 'http-return-1', sourceOrderId: sale.id, expectedSourceRevision: 2, items: [{ lineId: sale.items[0].lineId, quantity: 1 }] };
    const ret = await c.post('/api/returns', retRequest);
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    assert.equal(ret.body.data.type, 'RETURN');
    assert.equal(ret.body.data.items[0].priceCents, 9000);
    const q90 = (await c.get('/api/prices?customerId=C-A&skuId=SKU-S&unit=' + encodeURIComponent('箱'))).body.data;
    const zero = await c.post('/api/sales', { ...request, operationId: 'http-zero-1', items: [{ ...request.items[0], quantity: 1, priceCents: 0, priceVersion: q90.version, manualPrice: true, zeroConfirmed: true }] });
    assert.equal(zero.status, 200, JSON.stringify(zero.body));
    assert.equal((await c.get('/api/prices?customerId=C-A&skuId=SKU-S&unit=' + encodeURIComponent('箱'))).body.data.priceCents, 9000);
    const printRequest = { operationId: 'http-print-1', orderId: sale.id };
    const firstPrint = await c.post('/api/print-attempts', printRequest);
    assert.equal(firstPrint.status, 200);
    assert.equal(firstPrint.body.data.status, 'PENDING_DEVICE');
    assert.equal(firstPrint.body.data.revision, 2);
    assert.equal((await c.post('/api/print-attempts', printRequest)).body.data.id, firstPrint.body.data.id);
    assert.equal((await c.post('/api/print-attempts', { ...printRequest, operationId: 'http-print-2' })).status, 409);
    const before = (await c.get('/api/orders')).body.data;
    assert.equal(before.length, 3);
    assert.equal((await c.post('/api/returns', { ...retRequest, operationId: 'over-return', items: [{ lineId: sale.items[0].lineId, quantity: 2 }] })).status, 409);
    await app.close();
    app = createApplication({ dataDirectory: dir });
    c = await client(app);
    assert.equal(c.initial.stats.netSalesCents, 9000);
    assert.equal(c.initial.stats.returnCents, 9000);
    assert.equal(c.initial.printAttempts.length, 1);
    assert.equal(c.initial.orders.length, 3);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP rejects missing session, CSRF, foreign origin, unknown paths and malformed commands without writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-guards-'));
  const app = createApplication({ dataDirectory: dir });
  try {
    const c = await client(app);
    assert.equal((await fetch(c.url + '/api/orders')).status, 401);
    assert.equal((await c.post('/api/sales', {}, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await c.post('/api/sales', {}, { origin: 'http://untrusted.invalid' })).status, 403);
    assert.equal((await c.post('/api/sales', [])).status, 400);
    assert.equal((await c.get('/api/documents/../../package.json')).status, 404);
    assert.equal((await c.get('/api/absent')).status, 404);
    assert.equal(app.store.read().orders.length, 0);
    assert.equal(app.store.read().salesEvents.length, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
