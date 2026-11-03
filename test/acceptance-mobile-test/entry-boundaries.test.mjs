import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { createApplication } from '../../src/server.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'a07-mobile-entry-'));
  const app = createApplication({ dataDirectory: directory });
  const url = await app.start();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => {
    await close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('a07-mobile-entry-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, url, directory, close };
}

test('A07 mobile entry: only opted-in phone app permits same-origin embedding; shell permits only same-origin frames', async t => {
  const { app, url } = await fixture(t), before = app.store.read();
  const shell = await fetch(`${url}/mobile-test`);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get('content-type'), /^text\/html/);
  const csp = shell.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|frame-src \*/);
  const embedded = await fetch(`${url}/mobile?mobile-test=1`, { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(embedded.status, 200);
  assert.match(embedded.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.notEqual(embedded.headers.get('x-frame-options')?.toUpperCase(), 'DENY');
  for (const path of ['/', '/?mobile-test=0', '/?mobile-test=1', '/mobile', '/app.mjs?mobile-test=1', '/style.css?mobile-test=1', '/mobile-test?mobile-test=1']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
  }
  assert.equal((await fetch(`${url}/mobile?mobile-test=1`, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' } })).status, 403);
  assert.deepEqual(app.store.read(), before);
});

test('A07 mobile entry: three static assets are allowlisted with proper MIME; unknown files and source paths remain private', async t => {
  const { app, url } = await fixture(t), before = app.store.read();
  for (const [path, mime] of [['/mobile-test', /^text\/html/], ['/mobile-test.mjs', /^text\/javascript/], ['/mobile-test.css', /^text\/css/]]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), mime);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).length > 30);
    assert.equal((await fetch(`${url}${path}`, { method: 'HEAD' })).status, 200);
  }
  for (const path of ['/mobile-test.html', '/web/mobile-test.html', '/mobile-test/../src/server.mjs', '/mobile-test%2f..%2fsrc/server.mjs', '/package.json']) {
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  }
  assert.equal((await fetch(`${url}/mobile-test`, { method: 'POST' })).status, 405);
  assert.deepEqual(app.store.read(), before);
});

test('A07 mobile entry: iframe-context requests use unchanged session, CSRF and real persistent sale API', async t => {
  const { app, url, close, directory } = await fixture(t);
  const context = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty', Referer: `${url}/mobile?mobile-test=1` };
  const bootstrap = await fetch(`${url}/api/bootstrap`, { headers: context });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], boot = (await bootstrap.json()).data;
  const quote = app.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  const input = { operationId: randomUUID(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true,
    items: [{ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents: quote.priceCents, priceVersion: quote.version }] };
  const headers = { ...context, cookie, Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken };
  assert.equal((await fetch(`${url}/api/sales?mobile-test=1`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body: JSON.stringify(input) })).status, 403);
  const submit = async () => fetch(`${url}/api/sales`, { method: 'POST', headers, body: JSON.stringify(input) });
  const response = await submit();
  assert.equal(response.status, 200);
  const order = (await response.json()).data;
  assert.equal((await (await submit()).json()).data.id, order.id);
  assert.equal(app.store.read().salesEvents.length, 1);
  const image = await fetch(`${url}/api/documents/${order.document.id}.png`, { headers: { ...context, cookie } });
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await image.arrayBuffer()).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.equal((await fetch(`${url}/api/documents/${order.document.id}.png?mobile-test=1`)).status, 401);
  await close();
  const reopened = createApplication({ dataDirectory: directory });
  try {
    assert.equal(reopened.business.getOrder(order.id).id, order.id);
    assert.equal(reopened.business.getStats().orderCount, 1);
  } finally { await reopened.close(); }
});

test('A07 mobile entry: query flag confers no device authority or fake hardware results', async t => {
  const { app, url } = await fixture(t);
  const bootstrap = await fetch(`${url}/api/bootstrap`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], boot = (await bootstrap.json()).data;
  const before = app.store.read();
  const reply = await fetch(`${url}/api/edge/inference/claim?mobile-test=1`, { method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken, Origin: url }, body: '{}' });
  assert.equal(reply.status, 403);
  assert.equal(app.store.read().edgeDevices.length, 0);
  assert.equal(app.store.read().edgeJobs.length, 0);
  assert.equal(app.store.read().printAttempts.length, 0);
  assert.deepEqual(app.store.read(), before);
});

test('A07 mobile entry: workspace-scoped cookies coexist across ports and cannot authorize another workspace or a restarted session', async t => {
  const first = await fixture(t), second = await fixture(t);
  const firstBoot = await fetch(`${first.url}/api/bootstrap`), secondBoot = await fetch(`${second.url}/api/bootstrap`);
  const one = firstBoot.headers.get('set-cookie').split(';')[0], two = secondBoot.headers.get('set-cookie').split(';')[0];
  const oneName = one.split('=')[0], twoName = two.split('=')[0];
  assert.notEqual(oneName, twoName);
  for (const response of [firstBoot, secondBoot]) {
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  }
  const combined = `${one}; ${two}`;
  assert.equal((await fetch(`${first.url}/api/orders`, { headers: { cookie: combined } })).status, 200);
  assert.equal((await fetch(`${second.url}/api/orders`, { headers: { cookie: combined } })).status, 200);
  assert.equal((await fetch(`${first.url}/api/orders`, { headers: { cookie: two } })).status, 401);
  assert.equal((await fetch(`${second.url}/api/orders`, { headers: { cookie: one } })).status, 401);
  await first.close();
  const restarted = createApplication({ dataDirectory: first.directory });
  const restartedUrl = await restarted.start();
  try {
    assert.equal((await fetch(`${restartedUrl}/api/orders`, { headers: { cookie: combined } })).status, 401);
    const response = await fetch(`${restartedUrl}/api/bootstrap`);
    const newCookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal(newCookie.split('=')[0], oneName);
    assert.equal(newCookie === one, false);
    assert.equal((await fetch(`${restartedUrl}/api/orders`, { headers: { cookie: newCookie } })).status, 200);
  } finally { await restarted.close(); }
});
