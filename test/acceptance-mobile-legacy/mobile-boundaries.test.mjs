import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from '../../src/server.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'a07-mobile-legacy-'));
  const app = createApplication({ dataDirectory: directory });
  const url = await app.start();
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('a07-mobile-legacy-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const context = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', Referer: `${url}/mobile?mobile-test=1` };
  const bootstrap = await fetch(`${url}/api/bootstrap`, { headers: context });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const boot = (await bootstrap.json()).data;
  async function call(path, input, expectedStatus = 200, expectedCode) {
    const response = await fetch(`${url}${path}`, { method: input == null ? 'GET' : 'POST',
      headers: { ...context, cookie, ...(input == null ? {} : { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken }) },
      ...(input == null ? {} : { body: JSON.stringify(input) }) });
    assert.equal(response.status, expectedStatus, `${input == null ? 'GET' : 'POST'} ${path} status`);
    const result = await response.json();
    assert.equal(result.ok, expectedStatus === 200, `${path} result envelope`);
    if (expectedCode) assert.equal(result.error?.code, expectedCode, `${path} error code`);
    return result.data;
  }
  const quote = () => call('/api/prices?customerId=C-A&skuId=SKU-S&unit=%E7%AE%B1');
  const line = (q, changes = {}) => ({ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents: q.priceCents, priceVersion: q.version, ...changes });
  const sale = (q, changes = {}) => ({ operationId: randomUUID(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true, items: [line(q)], ...changes });
  return { app, url, directory, call, quote, line, sale, cookie, boot, context };
}

test('A07 W3 frame boundary: only the explicit phone view permits same-origin embedding', async t => {
  const { app, url } = await fixture(t);
  const before = app.store.read();
  for (const path of ['/', '/?mobile-test=1', '/mobile', '/mobile?mobile-test=0', '/mobile?mobile-test=true', '/mobile-test', '/app.mjs?mobile-test=1']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
  }
  const embedded = await fetch(`${url}/mobile?mobile-test=1`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(embedded.status, 200);
  const csp = embedded.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|frame-ancestors \*/);
  const shell = await fetch(`${url}/mobile-test`);
  assert.match(shell.headers.get('content-security-policy'), /frame-src 'self'/);
  const shellText = await shell.text();
  assert.match(shellText, /<iframe\b[^>]*src="\/mobile\?mobile-test=1(?:#home)?"/);
  assert.equal((await fetch(`${url}/mobile?mobile-test=1`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  assert.equal((await fetch(`${url}/web/mobile.html`)).status, 404);
  assert.equal((await fetch(`${url}/mobile`, { method: 'POST' })).status, 405);
  assert.deepEqual(app.store.read(), before);
});

test('A07 W3 presentation boundary: phone HTML and allowlisted assets stay separate from the desktop template', async t => {
  const { app, url } = await fixture(t), before = app.store.read();
  const desktop = await (await fetch(`${url}/`)).text();
  const phone = await (await fetch(`${url}/mobile`)).text();
  assert.match(desktop, /href="\/style\.css"/);
  assert.match(desktop, /src="\/app\.mjs"/);
  assert.match(desktop, /id="desktop-nav"/);
  assert.doesNotMatch(desktop, /data-presentation="mobile"|href="\/mobile\.css"|src="\/mobile-app\.mjs"/);
  assert.match(phone, /data-presentation="mobile"/);
  assert.match(phone, /href="\/mobile\.css"/);
  assert.match(phone, /src="\/mobile-app\.mjs"/);
  assert.doesNotMatch(phone, /id="desktop-nav"|class="sidebar"|href="\/style\.css"/);
  for (const [path, mime] of [['/mobile', /^text\/html/], ['/mobile.css', /^text\/css/], ['/mobile-app.mjs', /^text\/javascript/]]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), mime, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${url}${path}`, { method: 'HEAD' })).status, 200);
  }
  for (const path of ['/mobile.html', '/web/mobile-app.mjs', '/mobile%2f..%2fsrc/server.mjs']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  }
  assert.deepEqual(app.store.read(), before);
});

test('A07 W3 phone API: fresh price versions, explicit zero and one persistent PNG sale retain their meaning', async t => {
  const f = await fixture(t), first = await f.quote();
  const staleInput = f.sale(first);
  const updated = await f.call('/api/prices/save', { operationId: randomUUID(), customerId: 'C-A', skuId: 'SKU-S', unit: '箱', expectedVersion: first.version, priceCents: first.priceCents + 100 });
  const beforeRejection = f.app.store.read();
  await f.call('/api/sales', staleInput, 409, 'PRICE_VERSION_CONFLICT');
  assert.deepEqual(f.app.store.read(), beforeRejection);
  const command = f.sale(updated, { items: [f.line(updated, { priceCents: updated.priceCents + 100, manualPrice: true })] });
  const order = await f.call('/api/sales', command);
  assert.equal((await f.call('/api/sales', command)).id, order.id);
  assert.equal(f.app.store.read().salesEvents.length, 1);
  assert.equal((await f.quote()).priceCents, updated.priceCents + 100);
  const image = await fetch(`${f.url}/api/documents/${order.document.id}.png`, { headers: { ...f.context, cookie: f.cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await image.arrayBuffer()).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const current = await f.quote();
  const zero = f.sale(current, { items: [f.line(current, { priceCents: 0, manualPrice: true })] });
  await f.call('/api/sales', zero, 400, 'ZERO_NOT_CONFIRMED');
  const explicitZero = await f.call('/api/sales', { ...zero, operationId: randomUUID(), items: [{ ...zero.items[0], zeroConfirmed: true }] });
  assert.equal(explicitZero.totals.goodsCents, 0);
  assert.deepEqual(await f.quote(), current);
  assert.equal(f.app.business.getStats().orderCount, 2);
  assert.equal(f.app.store.read().printAttempts.length, 0);
  assert.equal(f.app.store.read().edgeDevices.length, 0);
});

test('A07 W3 phone API: corrected sale keeps revisions and partial return uses its original transaction price', async t => {
  const f = await fixture(t), first = await f.quote();
  const original = await f.call('/api/sales', f.sale(first, { items: [f.line(first, { quantity: 3 })] }));
  const corrected = await f.call(`/api/orders/${original.id}/corrections`, { operationId: randomUUID(), expectedRevision: original.revision,
    customerId: original.customerId, items: [f.line(first, { lineId: original.items[0].lineId, quantity: 3, priceCents: first.priceCents + 200, manualPrice: true })] });
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.revisions.length, 2);
  assert.equal(corrected.revisions[0].items[0].priceCents, first.priceCents);
  assert.deepEqual(f.app.store.read().salesEvents.map(row => row.type), ['SALE', 'REVERSAL', 'SALE']);
  const afterCorrection = await f.quote();
  assert.equal(afterCorrection.priceCents, first.priceCents + 200);
  await f.call('/api/prices/save', { operationId: randomUUID(), customerId: 'C-A', skuId: 'SKU-S', unit: '箱', expectedVersion: afterCorrection.version, priceCents: first.priceCents + 500 });
  const newerPrice = await f.quote();
  const command = { operationId: randomUUID(), sourceOrderId: original.id, expectedSourceRevision: corrected.revision,
    items: [{ lineId: corrected.items[0].lineId, quantity: 1 }] };
  const returned = await f.call('/api/returns', command);
  assert.equal(returned.items[0].priceCents, corrected.items[0].priceCents);
  assert.equal(returned.items[0].quantity, 1);
  assert.equal((await f.call('/api/returns', command)).id, returned.id);
  assert.deepEqual(await f.quote(), newerPrice);
  const state = f.app.store.read();
  await f.call('/api/returns', { ...command, operationId: randomUUID(), items: [{ ...command.items[0], quantity: 3 }] }, 409, 'RETURN_OVER_LIMIT');
  await f.call('/api/returns', { ...command, operationId: randomUUID(), items: [{ ...command.items[0], priceCents: newerPrice.priceCents }] }, 400, 'RETURN_SOURCE_INVALID');
  assert.deepEqual(f.app.store.read(), state);
  assert.equal(f.app.business.getStats().netSalesCents, corrected.totals.goodsCents - returned.totals.goodsCents);
  assert.equal(f.app.store.read().printAttempts.length, 0);
});
