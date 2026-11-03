import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createApplication } from '../../src/server.mjs';

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'a07-w2-http-'));
  let clock = Date.parse('2026-10-31T08:00:00Z');
  const app = createApplication({ dataDirectory: directory, now: () => new Date(clock).toISOString() });
  const url = await app.start();
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('a07-w2-http-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const bootstrap = await fetch(`${url}/api/bootstrap`);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], initial = (await bootstrap.json()).data;
  async function request(path, input, headers = {}) {
    const response = await fetch(`${url}${path}`, { method: input == null ? 'GET' : 'POST',
      headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken, ...headers },
      ...(input == null ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, payload: await response.json() };
  }
  async function register(capabilities) {
    const response = await request('/api/devices', { operationId: randomUUID(), name: '合成隔离HTTP设备', capabilities });
    assert.equal(response.status, 200);
    return { deviceId: response.payload.data.device.id, token: response.payload.data.token };
  }
  async function devicePost(path, input, credentials) {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Device-Id': credentials?.deviceId ?? '', Authorization: credentials?.token ? `Bearer ${credentials.token}` : '' }, body: JSON.stringify(input) });
    return { status: response.status, payload: await response.json() };
  }
  async function sale(priceCents = 10000) {
    const quote = app.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
    const response = await request('/api/sales', { operationId: randomUUID(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true,
      items: [{ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents, priceVersion: quote.version, manualPrice: priceCents !== quote.priceCents }] });
    assert.equal(response.status, 200);
    return response.payload.data;
  }
  return { app, url, directory, cookie, request, register, devicePost, sale,
    setClock: value => { clock = typeof value === 'string' ? Date.parse(value) : value; } };
}

test('A07 W2 HTTP handoff: device cookie/body impersonation fails and only one checked candidate sale can persist', async t => {
  const f = await setup(t);
  const device = await f.register(['INFER']), other = await f.register(['INFER']);
  await f.request('/api/intake/messages', { sourceId: 'local-source-1', conversationId: 'independent', messageId: 'name', type: 'TEXT', kind: 'customer', text: '好运店', customerHint: '好运店' });
  await f.request('/api/intake/messages', { sourceId: 'local-source-1', conversationId: 'independent', messageId: 'goods', type: 'TEXT', kind: 'product', text: '合成商品' });
  f.setClock('2026-10-31T08:01:00Z'); f.app.intake.sealDue();
  assert.equal((await f.request('/api/edge/inference/claim', {})).status, 403);
  const claimed = await f.devicePost('/api/edge/inference/claim', {}, device);
  assert.equal(claimed.status, 200);
  const { job, leaseToken } = claimed.payload.data;
  const result = { customerId: null, items: [{ skuId: null, unit: null, quantity: null }], issues: ['合成待人工'] };
  const command = { jobId: job.id, leaseToken, result };
  // Body credentials must never override headers and take another device's lease.
  const spoofed = await f.devicePost('/api/edge/inference/complete', { ...command, ...device }, other);
  assert.equal(spoofed.status, 409);
  const completed = await f.devicePost('/api/edge/inference/complete', command, device);
  assert.equal(completed.status, 200);
  assert.equal(f.app.business.getStats().orderCount, 0);
  const review = await f.request(`/api/review-jobs/${job.id}`);
  assert.equal(review.payload.data.sourceJobId, job.id);
  assert.equal(review.payload.data.originalMessages.length, 2);
  const quote = f.app.business.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  const sale = { operationId: randomUUID(), sourceJobId: job.id, candidateVersion: completed.payload.data.candidateVersion,
    customerId: 'C-A', mode: 'ELECTRONIC', checked: true,
    items: [{ skuId: 'SKU-S', unit: '箱', quantity: 1, priceCents: quote.priceCents, priceVersion: quote.version }] };
  assert.equal((await f.request('/api/sales', { ...sale, checked: false })).status, 400);
  assert.equal((await f.request('/api/sales', { ...sale, candidateVersion: 'stale' })).status, 409);
  const created = await f.request('/api/sales', sale);
  assert.equal(created.status, 200);
  assert.equal((await f.request('/api/sales', sale)).payload.data.id, created.payload.data.id);
  assert.equal((await f.request('/api/sales', { ...sale, operationId: randomUUID() })).status, 409);
  assert.equal(f.app.store.read().correctionSamples.length, 1);
  assert.equal(f.app.store.read().salesEvents.length, 1);
  assert.equal((await f.request(`/api/review-jobs/${job.id}`)).status, 409);
  assert.equal((await f.devicePost('/api/edge/inference/complete', command, device)).status, 200);
  const boot = JSON.stringify((await f.request('/api/bootstrap')).payload.data);
  assert.equal(/tokenHash|leaseTokenHash|completedLeaseTokenHash|receiptSignature/.test(boot), false);
  assert.equal(boot.includes(device.token), false); assert.equal(boot.includes(leaseToken), false);
  assert.equal((await f.request(`/api/devices/${device.deviceId}/revoke`, { operationId: randomUUID() })).status, 200);
  assert.equal((await f.devicePost('/api/edge/inference/complete', command, device)).status, 403);
});

test('A07 W2 HTTP PDF: persisted draft PDF is private and digest-bound; uncalibrated paper cannot be claimed or confirmed', async t => {
  const f = await setup(t), order = await f.sale(), device = await f.register(['PRINT']);
  const queued = await f.request('/api/print-attempts', { operationId: randomUUID(), orderId: order.id });
  assert.equal(queued.status, 200);
  const attempt = queued.payload.data;
  assert.equal(attempt.calibrationStatus, 'UNVALIDATED'); assert.equal(attempt.copies, 1);
  const path = `/api/documents/${attempt.document.id}.pdf`;
  assert.equal((await fetch(`${f.url}${path}`)).status, 401);
  const pdf = await fetch(`${f.url}${path}`, { headers: { cookie: f.cookie } });
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), attempt.document.sha256);
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  const claim = await f.devicePost('/api/edge/print/claim', {}, device);
  assert.equal(claim.status, 200); assert.equal(claim.payload.data.attempt, null);
  assert.equal(claim.payload.data.reason, 'CALIBRATION_REQUIRED');
  assert.equal((await f.request(`/api/print-attempts/${attempt.id}/paper`, { operationId: randomUUID(), printed: true })).status, 409);
  assert.equal((await f.request('/api/edge/print/result', { operationId: randomUUID(), attemptId: attempt.id, outcome: 'SPOOLER_ACCEPTED', queueId: 'synthetic-only' })).status, 403);
  const before = f.app.store.read();
  writeFileSync(join(f.directory, 'documents', attempt.document.relativePath), '%PDF-synthetic-tamper');
  assert.equal((await fetch(`${f.url}${path}`, { headers: { cookie: f.cookie } })).status, 503);
  assert.deepEqual(f.app.store.read(), before);
});

test('A07 W2 HTTP transport-only simulation: expired print lease stays uncertain; manual not-printed yields one identical-version reprint without sale', async t => {
  const f = await setup(t), order = await f.sale(), device = await f.register(['PRINT']);
  const queued = await f.request('/api/print-attempts', { operationId: randomUUID(), orderId: order.id });
  const attempt = queued.payload.data;
  // Isolated transport fixture only: this is explicitly not real iP110 calibration.
  f.app.store.transact(state => { const row = state.printAttempts.find(value => value.id === attempt.id); row.document.calibrationStatus = 'VALIDATED'; row.calibrationStatus = 'VALIDATED'; });
  const claimed = await f.devicePost('/api/edge/print/claim', {}, device);
  assert.equal(claimed.status, 200); assert.equal(claimed.payload.data.attempt.id, attempt.id);
  const leaseToken = claimed.payload.data.leaseToken;
  assert.equal(JSON.stringify((await f.request('/api/bootstrap')).payload.data).includes(leaseToken), false);
  const proof = { 'X-Device-Id': device.deviceId, Authorization: `Bearer ${device.token}`, 'X-Print-Lease-Token': leaseToken };
  assert.equal((await fetch(`${f.url}/api/edge/print/${attempt.id}/document`, { headers: proof })).status, 200);
  assert.equal((await fetch(`${f.url}/api/edge/print/${attempt.id}/document`, { headers: { ...proof, 'X-Print-Lease-Token': 'incorrect' } })).status, 409);
  f.setClock(claimed.payload.data.leaseUntil);
  assert.equal(f.app.printing.expireClaims().uncertainCount, 1);
  const repeatedClaim = await f.devicePost('/api/edge/print/claim', {}, device);
  assert.equal(repeatedClaim.payload.data.attempt, null);
  assert.equal((await f.devicePost('/api/edge/print/result', { operationId: randomUUID(), attemptId: attempt.id, leaseToken, outcome: 'SPOOLER_ACCEPTED', queueId: 'synthetic-spool' }, device)).status, 409);
  const sales = f.app.store.read().salesEvents;
  assert.equal((await f.request(`/api/print-attempts/${attempt.id}/paper`, { operationId: randomUUID(), printed: false })).status, 200);
  const command = { operationId: randomUUID() }, path = `/api/print-attempts/${attempt.id}/reprint`;
  const reprint = await f.request(path, command);
  assert.equal(reprint.status, 200);
  assert.equal(reprint.payload.data.copies, 1); assert.equal(reprint.payload.data.revision, order.revision);
  assert.equal(reprint.payload.data.document.sha256, attempt.document.sha256);
  assert.equal((await f.request(path, command)).payload.data.id, reprint.payload.data.id);
  assert.equal((await f.request(path, { operationId: randomUUID() })).payload.data.id, reprint.payload.data.id);
  assert.equal(f.app.printing.list().length, 2);
  assert.deepEqual(f.app.store.read().salesEvents, sales);
});

test('A07 W2 PDF failure: confirmed PNG sale survives, while over-cell-limit PDF queue creates no partial attempt', async t => {
  const f = await setup(t), order = await f.sale(10_000_000);
  const before = f.app.store.read();
  const response = await f.request('/api/print-attempts', { operationId: randomUUID(), orderId: order.id });
  assert.equal(response.status, 503);
  assert.equal(response.payload.error.code, 'DOCUMENT_NOT_PERSISTED');
  assert.deepEqual(f.app.store.read(), before);
  assert.equal(f.app.business.getStats().salesCents, 10_000_000);
});
