import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../../src/server.mjs';

async function browser(app) {
  const base = await app.start();
  const response = await fetch(base + '/api/bootstrap');
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const initial = (await response.json()).data;
  const request = async (path, input) => {
    const reply = await fetch(base + path, { method: input ? 'POST' : 'GET',
      headers: { cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: reply.status, body: await reply.json() };
  };
  return { base, initial, cookie, request };
}

test('W2 HTTP normalized intake to device candidate, human sale, PDF preview and protected credential projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-w2-http-'));
  let clock = '2026-10-31T08:00:00Z';
  const app = createApplication({ dataDirectory: dir, now: () => clock });
  try {
    const c = await browser(app);
    const device = (await c.request('/api/devices', { operationId: 'register', name: '合成测试识别设备', capabilities: ['INFER', 'PRINT'] })).body.data;
    const devicePost = async (path, input) => {
      const res = await fetch(c.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: 'Bearer ' + device.token, 'X-Device-Id': device.device.id }, body: JSON.stringify(input) });
      return { status: res.status, body: await res.json() };
    };
    await c.request('/api/intake/messages', { sourceId: 'local-source-1', conversationId: 'test-conversation', messageId: 'name', type: 'TEXT', kind: 'customer', text: '好运店', customerHint: '好运店' });
    await c.request('/api/intake/messages', { sourceId: 'local-source-1', conversationId: 'test-conversation', messageId: 'product', type: 'TEXT', kind: 'product', text: '啤酒2箱' });
    clock = '2026-10-31T08:01:01Z'; app.intake.sealDue();
    assert.equal((await c.request('/api/edge/inference/claim', {})).status, 403, 'boss browser cookie cannot impersonate an edge device');
    const claim = await devicePost('/api/edge/inference/claim', {});
    assert.equal(claim.status, 200);
    const { job, leaseToken } = claim.body.data;
    const candidate = { customerId: 'C-A', items: [{ skuId: 'SKU-S', unit: '箱', quantity: 2 }], issues: [] };
    const completion = await devicePost('/api/edge/inference/complete', { jobId: job.id, leaseToken, result: candidate });
    assert.equal(completion.status, 200, JSON.stringify(completion.body));
    assert.equal(app.business.getStats().orderCount, 0);
    const review = await c.request('/api/review-jobs/' + job.id);
    assert.equal(review.status, 200);
    assert.deepEqual(review.body.data.draft.items, candidate.items);
    assert.equal(review.body.data.originalMessages.length, 2);
    const quoted = (await c.request('/api/prices?customerId=C-A&skuId=SKU-S&unit=' + encodeURIComponent('箱'))).body.data;
    const input = { operationId: 'candidate-sale', sourceJobId: job.id, candidateVersion: completion.body.data.candidateVersion,
      customerId: 'C-A', checked: true, mode: 'PAPER', items: [{ ...candidate.items[0], quantity: 3, priceCents: quoted.priceCents, priceVersion: quoted.version }] };
    const result = await c.request('/api/sales', input);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const sale = result.body.data;
    assert.equal((await c.request('/api/sales', input)).body.data.id, sale.id);
    assert.equal((await c.request('/api/sales', { ...input, operationId: 'second-consumption' })).status, 409);
    assert.equal(app.store.read().correctionSamples.length, 1);
    assert.equal(app.store.read().salesEvents.length, 1);
    const prepared = await c.request('/api/print-attempts', { operationId: 'prepare-paper', orderId: sale.id });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const attempt = prepared.body.data;
    assert.equal(attempt.document.mimeType, 'application/pdf');
    assert.equal(attempt.calibrationStatus, 'UNVALIDATED');
    const pdf = await fetch(c.base + `/api/documents/${attempt.document.id}.pdf`, { headers: { cookie: c.cookie } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal((await devicePost('/api/edge/print/claim', {})).body.data.attempt, null, 'unvalidated stationery cannot be sent to a physical printer');
    assert.equal((await c.request(`/api/print-attempts/${attempt.id}/paper`, { operationId: 'fake-paper', printed: true })).status, 409);
    const boot = (await c.request('/api/bootstrap')).body.data;
    const serialized = JSON.stringify(boot);
    assert.equal(/tokenHash|leaseTokenHash|completedLeaseTokenHash|receiptSignature/.test(serialized), false);
    assert.equal(serialized.includes(device.token), false);
    assert.equal(boot.correctionSampleCount, 1);
    assert.equal(boot.stats.netSalesCents, 30000);
    const stats = await c.request('/api/stats?period=day&date=2026-10-31');
    assert.equal(stats.body.data.netSalesCents, 30000);
    const tampered = join(dir, 'documents', attempt.document.relativePath);
    writeFileSync(tampered, '%PDF-corrupt');
    const corrupt = await fetch(c.base + `/api/documents/${attempt.document.id}.pdf`, { headers: { cookie: c.cookie } });
    assert.equal(corrupt.status, 503, 'a stored file with a different digest must not be delivered');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('W2 HTTP master edits require versions, aliases retain ambiguity and device revoke is immediate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-w2-master-http-'));
  const app = createApplication({ dataDirectory: dir });
  try {
    const c = await browser(app);
    const created = await c.request('/api/customers', { operationId: 'customer-new', name: '同名商店', address: '合成地址甲', aliases: ['好运店'] });
    assert.equal(created.status, 200);
    assert.equal((await c.request('/api/customers', { operationId: 'customer-edit', id: created.body.data.id, name: '同名商店', address: '合成地址乙' })).status, 409);
    assert.equal((await c.request('/api/customers/match?q=' + encodeURIComponent('好运店'))).body.data.ambiguous, true);
    const registered = (await c.request('/api/devices', { operationId: 'device-new', name: '合成设备', capabilities: ['INFER'] })).body.data;
    await c.request(`/api/devices/${registered.device.id}/revoke`, { operationId: 'device-revoke' });
    const refused = await fetch(c.base + '/api/edge/inference/claim', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer ' + registered.token, 'X-Device-Id': registered.device.id }, body: '{}' });
    assert.equal(refused.status, 403);
    assert.equal((await c.request('/api/stats?period=day&date=2026-02-30')).status, 400);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
