import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from '../../src/server.mjs';

test('A07 HTTP: history quotation uses confirmed sale; unapproved quantity policy denies new return atomically behind session and CSRF', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'a07-customer-return-'));
  const app = createApplication({ dataDirectory: directory });
  const url = await app.start();
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('a07-customer-return-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const context = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', Referer: `${url}/mobile?mobile-test=1` };
  const bootstrap = await fetch(`${url}/api/bootstrap`, { headers: context });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], boot = (await bootstrap.json()).data;
  assert.deepEqual(boot.customerHistoryReturn, { canSave: false,
    unavailableReason: '退货数量规则尚未确认，当前可核对预览，暂不能保存。' });
  async function call(path, input, expectedStatus = 200, expectedCode) {
    const response = await fetch(`${url}${path}`, { method: input == null ? 'GET' : 'POST',
      headers: { ...context, cookie, ...(input == null ? {} : { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }) },
      ...(input == null ? {} : { body: JSON.stringify(input) }) });
    assert.equal(response.status, expectedStatus, `${path} status`);
    const body = await response.json();
    if (expectedCode) assert.equal(body.error.code, expectedCode);
    return body.data;
  }
  const quotePath = '/api/return-prices?customerId=C-A&skuId=SKU-S&unit=%E7%93%B6';
  const unauthorized = await fetch(`${url}${quotePath}`, { headers: context });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'SESSION_REQUIRED');
  assert.equal((await call(quotePath)).source, 'MISSING');
  const saleQuote = await call('/api/prices?customerId=C-A&skuId=SKU-S&unit=%E7%AE%B1');
  const sold = await call('/api/sales', { operationId: randomUUID(), customerId: 'C-A', checked: true, mode: 'ELECTRONIC',
    items: [{ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents: 10000, priceVersion: saleQuote.version, manualPrice: true }] });
  const q = await call(quotePath);
  assert.equal(q.priceCents, 420); assert.equal(q.sourceOrderId, sold.id);
  const image = await fetch(`${url}/api/documents/${sold.document.id}.png`, { headers: { ...context, cookie } });
  assert.equal(image.status, 200);
  assert.ok(Buffer.from(await image.arrayBuffer()).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const command = { operationId: randomUUID(), returnBasis: 'CUSTOMER_HISTORY', customerId: 'C-A', checked: true,
    items: [{ skuId: 'SKU-S', unit: '瓶', quantity: 1, priceCents: q.priceCents, returnPriceVersion: q.version }] };
  const before = app.store.read();
  const csrfFailure = await fetch(`${url}/api/returns`, { method: 'POST', headers: { ...context, cookie, Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  assert.equal(csrfFailure.status, 403); assert.equal((await csrfFailure.json()).error.code, 'CSRF_REQUIRED');
  assert.deepEqual(app.store.read(), before);
  await call('/api/returns', command, 409, 'RETURN_QUANTITY_POLICY_UNCONFIRMED');
  assert.deepEqual(app.store.read(), before);
  const compatible = await call('/api/returns', { operationId: randomUUID(), sourceOrderId: sold.id, expectedSourceRevision: 1,
    items: [{ lineId: sold.items[0].lineId, quantity: 1 }] });
  assert.equal(compatible.sourceOrderId, sold.id); assert.equal(compatible.items[0].priceCents, 10000);
  assert.equal(app.store.read().salesEvents.filter(event => event.type === 'RETURN').length, 1);
});
