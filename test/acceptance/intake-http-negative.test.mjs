import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { createStore, createEmptyState } from '../../src/shared/store.mjs';
import { createIntakeService } from '../../src/intake/index.mjs';
import { createApplication } from '../../src/server.mjs';

function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('a07-'));
  rmSync(directory, { recursive: true, force: true });
}

function intakeFixture(t, options = {}) {
  const initialState = createEmptyState();
  initialState.sources = [{ id: 'trusted', active: true }, { id: 'disabled', active: false }];
  const store = createStore({ filename: options.filename ?? ':memory:', initialState });
  let milliseconds = 0;
  const intake = createIntakeService({ store, now: () => new Date(Date.UTC(2026, 9, 31) + milliseconds).toISOString() });
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  t.after(close);
  return { store, intake, close, clock: value => { milliseconds = value; } };
}
const message = (id, changes = {}) => ({ sourceId: 'trusted', conversationId: 'conversation-A', messageId: id, type: 'TEXT', kind: 'product', text: '合成商品一箱', media: [], ...changes });
function intact(store, fn, code) {
  const before = store.read();
  assert.throws(fn, e => e.code === code);
  assert.deepEqual(store.read(), before);
}

test('A07 intake: disabled sources and unsafe metadata fail atomically without phantom batches', t => {
  const { store, intake } = intakeFixture(t);
  for (const sourceId of ['missing', 'disabled']) intact(store, () => intake.receive(message('x', { sourceId })), 'SOURCE_FORBIDDEN');
  for (const relativePath of ['../private', '/private', 'C:/private', 'a\\private', 'a/./b', 'a//b']) {
    intact(store, () => intake.receive(message('x', { type: 'IMAGE', media: [{ id: 'media', relativePath }] })), 'INVALID_MEDIA');
  }
  intact(store, () => intake.receive(message('x', { type: 'VOICE', media: [] })), 'MEDIA_REQUIRED');
  intact(store, () => intake.receive(message('x', { type: 'IMAGE', media: [{ id: 'media', url: 'https://untrusted.invalid' }] })), 'INVALID_MEDIA');
});

test('A07 intake: conversation isolation, same-id changed input and 60-second exact boundary', t => {
  const { store, intake, clock } = intakeFixture(t);
  intake.receive(message('customer', { kind: 'customer', customerHint: '合成甲店', text: '合成甲店' }));
  intake.receive(message('product'));
  assert.equal(intake.receive(message('isolated-product', { conversationId: 'conversation-B' })).status, 'UNASSIGNED');
  clock(59_999);
  assert.equal(intake.receive(message('product')).duplicate, true);
  intact(store, () => intake.receive(message('product', { text: '已变更的数量' })), 'MESSAGE_CONFLICT');
  assert.equal(intake.sealDue().sealedCount, 0);
  clock(60_000);
  assert.equal(intake.sealDue().sealedCount, 1);
  assert.equal(intake.sealDue().sealedCount, 0);
  assert.equal(intake.listJobs().length, 1);
  assert.equal(intake.listJobs()[0].conversationId, 'conversation-A');
  assert.deepEqual(store.read().salesEvents, []);
  assert.deepEqual(store.read().printAttempts, []);
});

test('A07 intake: a new voice product extends deadline but retry cannot create another job', t => {
  const { intake, clock } = intakeFixture(t);
  intake.receive(message('c', { kind: 'customer', customerHint: '合成甲店' }));
  intake.receive(message('p'));
  clock(59_999);
  const voice = message('voice', { type: 'VOICE', media: [{ id: 'synthetic-audio', relativePath: 'controlled/audio.ogg' }] });
  intake.receive(voice);
  clock(60_000);
  assert.equal(intake.sealDue().sealedCount, 0);
  clock(119_999);
  assert.equal(intake.sealDue().sealedCount, 1);
  assert.equal(intake.receive(voice).duplicate, true);
  assert.equal(intake.listJobs().length, 1);
  assert.equal(intake.listJobs()[0].messageIds.length, 3);
});

test('A07 intake persistence: restart expires persisted batch without a phone request or duplicate task', t => {
  const directory = mkdtempSync(join(tmpdir(), 'a07-intake-'));
  t.after(() => cleanup(directory));
  const filename = join(directory, 'intake.sqlite');
  const first = intakeFixture(t, { filename });
  first.intake.receive(message('c', { kind: 'customer', customerHint: '合成甲店' }));
  first.intake.receive(message('p', { type: 'IMAGE', media: [{ id: 'synthetic-image' }] }));
  first.close();
  const second = intakeFixture(t, { filename });
  second.clock(60_001);
  assert.equal(second.intake.sealDue().sealedCount, 1);
  assert.equal(second.intake.sealDue().sealedCount, 0);
  assert.equal(second.intake.listJobs().length, 1);
  assert.equal(second.intake.receive(message('p', { type: 'IMAGE', media: [{ id: 'synthetic-image' }] })).duplicate, true);
  second.close();
});

async function httpFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'a07-http-'));
  const app = createApplication({ dataDirectory: directory });
  const url = await app.start();
  t.after(async () => { await app.close(); cleanup(directory); });
  const bootstrap = await fetch(`${url}/api/bootstrap`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const data = (await bootstrap.json()).data;
  const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': data.csrfToken, origin: url };
  const post = async (path, input, changedHeaders = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, ...changedHeaders }, body: JSON.stringify(input) });
  return { app, url, cookie, headers, post };
}

test('A07 HTTP: session, CSRF, origin and cross-site defenses reject without changing state', async t => {
  const { app, url, headers, post } = await httpFixture(t);
  const before = app.store.read();
  assert.equal((await fetch(`${url}/api/orders`)).status, 401);
  assert.equal((await fetch(`${url}/api/bootstrap`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await post('/api/sales', {}, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await post('/api/sales', {}, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post('/api/sales', {}, { 'content-type': 'text/plain' })).status, 415);
  const malformed = await fetch(`${url}/api/sales`, { method: 'POST', headers, body: '{' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(app.store.read(), before);
});

test('A07 HTTP: Host check and route allowlist cannot expose source or filesystem paths', async t => {
  const { url, cookie } = await httpFixture(t);
  const status = await new Promise((resolveStatus, reject) => {
    http.get(`${url}/api/bootstrap`, { headers: { Host: 'untrusted.invalid' } }, response => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(status, 403);
  for (const path of ['/package.json', '/src/server.mjs', '/api/documents/..%2f..%2fpackage.json', '/api/documents/not-an-id.png']) {
    const response = await fetch(`${url}${path}`, { headers: { cookie } });
    assert.equal(response.status, 404, path);
    assert.equal((await response.json()).ok, false);
  }
});

test('A07 HTTP: malformed URL-encoded business identifier is a client error with no mutation', async t => {
  const { app, url, cookie } = await httpFixture(t);
  const before = app.store.read();
  const response = await fetch(`${url}/api/orders/%E0%A4%A`, { headers: { cookie } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
  assert.deepEqual(app.store.read(), before);
});

test('A07 HTTP+PNG: committed document is real PNG, private, digest-matched and historical', async t => {
  const { app, url, cookie, post } = await httpFixture(t);
  const quote = app.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  const input = { operationId: randomUUID(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true, items: [{ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents: quote.priceCents, priceVersion: quote.version }] };
  const saleResponse = await post('/api/sales', input);
  assert.equal(saleResponse.status, 200);
  const original = (await saleResponse.json()).data;
  assert.equal((await fetch(`${url}/api/documents/${original.document.id}.png`)).status, 401);
  const png = await fetch(`${url}/api/documents/${original.document.id}.png`, { headers: { cookie } });
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.ok(png.headers.get('cache-control').includes('private'));
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), original.document.sha256);
  assert.ok(bytes.length > 1000);
  const correction = await post(`/api/orders/${original.id}/corrections`, { operationId: randomUUID(), expectedRevision: 1, customerId: 'C-A', items: [{ ...input.items[0], lineId: original.items[0].lineId, priceCents: 9000, manualPrice: true }] });
  assert.equal(correction.status, 200);
  const changed = (await correction.json()).data;
  assert.notEqual(changed.document.id, original.document.id);
  const historical = await fetch(`${url}/api/documents/${original.document.id}.png`, { headers: { cookie } });
  assert.equal(createHash('sha256').update(Buffer.from(await historical.arrayBuffer())).digest('hex'), original.document.sha256);
  assert.equal(app.business.getStats().netSalesCents, 9000);
  const nonexistent = await fetch(`${url}/api/documents/${randomUUID()}.png`, { headers: { cookie } });
  assert.equal(nonexistent.status, 404);
});

test('A07 HTTP+PNG: unrenderable financial fields fail instead of clipping and roll back business', async t => {
  const { app, post } = await httpFixture(t);
  const quote = app.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  const before = app.store.read();
  const result = await post('/api/sales', { operationId: randomUUID(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true,
    items: [{ skuId: 'SKU-S', unit: '箱', quantity: Number.MAX_SAFE_INTEGER, priceCents: 1, priceVersion: quote.version, manualPrice: true }] });
  assert.equal(result.status, 503, 'unsafe financial layout must not be accepted as an official bill');
  const payload = await result.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DOCUMENT_NOT_PERSISTED');
  assert.deepEqual(app.store.read(), before, 'rendering failure must not commit a sale, price update or operation result');
});
