import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createStore, createEmptyState } from '../../src/shared/store.mjs';
import { createBusinessService, createMasterDataService } from '../../src/business/index.mjs';
import { createIntakeService } from '../../src/intake/index.mjs';
import { createEdgeService } from '../../src/edge-cloud/index.mjs';
import { DomainError } from '../../src/shared/errors.mjs';

const owner = Object.freeze({ id: 'a07-w2-owner', role: 'boss', active: true });
const consumeWorker = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
const { createStore } = await import(workerData.storeUrl);
const { createBusinessService } = await import(workerData.serviceUrl);
const store = createStore({ filename: workerData.filename });
try {
  const service = createBusinessService({ store, documentStore: { save() { return { id: randomUUID(), mimeType: 'image/png', sha256: 'd'.repeat(64), relativePath: 'synthetic.png' }; } } });
  parentPort.postMessage({ ready: true });
  Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 5000);
  service.createSale(workerData.command, workerData.actor);
  parentPort.postMessage({ accepted: true });
} catch (error) {
  parentPort.postMessage({ accepted: false, code: error.code ?? 'UNEXPECTED' });
} finally { store.close(); }
`)}`);
const priceKey = (customer = 'A', sku = 'S', unit = '箱') => JSON.stringify([customer, sku, unit]);
function fixture(t, { legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'a07-w2-'));
  const filename = join(directory, 'state.sqlite');
  const state = createEmptyState();
  state.customers = [{ id: 'A', name: '合成甲店', address: '合成东街', aliases: ['甲别名'] }, { id: 'B', name: '合成乙店', address: '合成西街', aliases: [] }];
  state.products = [{ id: 'S', name: '合成商品', units: ['箱', '瓶'], bottlesPerCase: 24 }];
  state.prices[priceKey()] = { priceCents: 10000, version: 'p-A' };
  state.prices[priceKey('B')] = { priceCents: 20000, version: 'p-B' };
  state.sources = [{ id: 'source-A', active: true }];
  if (legacy) { delete state.edgeDevices; delete state.correctionSamples; }
  const store = createStore({ filename, initialState: state });
  const stores = [store];
  let clock = Date.parse('2026-10-31T00:00:00Z'), failDocuments = false;
  const now = () => new Date(clock).toISOString();
  const documents = { save() { if (failDocuments) throw new Error('synthetic disk full'); return { id: randomUUID(), mimeType: 'image/png', sha256: 'd'.repeat(64), relativePath: 'synthetic.png' }; } };
  const business = createBusinessService({ store, documentStore: documents, now });
  const masters = createMasterDataService({ store, now });
  const intake = createIntakeService({ store, now });
  const edge = createEdgeService({ store, now });
  t.after(() => {
    for (const connection of stores) connection.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('a07-w2-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const line = (changes = {}, customerId = 'A') => ({ skuId: 'S', unit: '箱', quantity: 1, priceCents: business.quote({ customerId, skuId: 'S', unit: '箱' }).priceCents, priceVersion: business.quote({ customerId, skuId: 'S', unit: '箱' }).version, ...changes });
  const sale = changes => ({ operationId: randomUUID(), customerId: 'A', mode: 'ELECTRONIC', checked: true, items: [line()], ...changes });
  const register = (capabilities = ['INFER']) => {
    const response = edge.registerDevice({ operationId: randomUUID(), name: '合成隔离设备', capabilities }, owner);
    return { deviceId: response.device.id, token: response.token };
  };
  function batch() {
    const prefix = randomUUID();
    intake.receive({ sourceId: 'source-A', conversationId: prefix, messageId: `${prefix}-c`, type: 'TEXT', kind: 'customer', text: '甲别名', customerHint: '甲别名', media: [] });
    intake.receive({ sourceId: 'source-A', conversationId: prefix, messageId: `${prefix}-p`, type: 'IMAGE', kind: 'product', text: '', media: [{ id: 'synthetic-image', relativePath: 'controlled/image.png' }] });
    clock += 60_000; intake.sealDue();
    return store.read().edgeJobs.at(-1);
  }
  function candidate(result = { customerId: 'A', items: [{ skuId: 'S', unit: '箱', quantity: 1 }], issues: [] }) {
    const job = batch(), credentials = register(), claim = edge.claimInference(credentials);
    const command = { ...credentials, jobId: job.id, leaseToken: claim.leaseToken, result };
    const completion = edge.completeInference(command);
    return { credentials, claim, command, completion, reference: { sourceJobId: job.id, candidateVersion: completion.candidateVersion } };
  }
  return { store, business, masters, edge, intake, now, documents, filename, directory, line, sale, batch, register, candidate,
    clock: value => { clock = typeof value === 'string' ? Date.parse(value) : value; }, advance: value => { clock += value; },
    failDocuments: value => { failDocuments = value; },
    connect: () => { const connection = createStore({ filename }); stores.push(connection); return connection; } };
}
function unchanged(f, fn, code, status) {
  const before = f.store.read();
  assert.throws(fn, error => error instanceof DomainError && error.code === code && (status == null || error.status === status));
  assert.deepEqual(f.store.read(), before, 'Rejected command changed durable business state');
}

test('A07 W2 SQLite: W1 collections survive additive W2 loading and a second real connection', t => {
  const f = fixture(t, { legacy: true });
  const before = f.store.read();
  assert.deepEqual(before.edgeDevices, []); assert.deepEqual(before.correctionSamples, []);
  const second = f.connect();
  f.masters.saveCustomer({ operationId: 'legacy-safe-write', name: '新增合成店', address: '合成南街', aliases: [] }, owner);
  const after = second.read();
  for (const field of ['prices', 'products', 'orders', 'salesEvents', 'sources']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.customers.length, 3); assert.equal(after.schemaVersion, 1);
});

test('A07 W2 candidate: unconfirmed, stale and failed-document commands cannot consume or label; retry consumes once', t => {
  const f = fixture(t);
  const ready = f.candidate({ customerId: null, items: [{ skuId: null, unit: null, quantity: null }], issues: ['合成待核'] });
  const command = f.sale({ ...ready.reference, items: [f.line({ priceCents: 11000, manualPrice: true })] });
  unchanged(f, () => f.business.createSale({ ...command, checked: false }, owner), 'NOT_CHECKED');
  unchanged(f, () => f.business.createSale({ ...command, candidateVersion: 'stale' }, owner), 'REVIEW_VERSION_CONFLICT', 409);
  f.failDocuments(true);
  unchanged(f, () => f.business.createSale(command, owner), 'DOCUMENT_FAILED', 503);
  f.failDocuments(false);
  const created = f.business.createSale(command, owner);
  assert.equal(f.business.createSale(command, owner).id, created.id);
  const snapshot = f.store.read();
  assert.equal(snapshot.edgeJobs[0].status, 'REVIEWED'); assert.equal(snapshot.edgeJobs[0].reviewOrderId, created.id);
  assert.equal(snapshot.salesEvents.length, 1); assert.equal(snapshot.correctionSamples.length, 1);
  assert.equal(snapshot.correctionSamples[0].status, 'RECORDED');
  unchanged(f, () => f.business.createSale({ ...command, operationId: randomUUID() }, owner), 'REVIEW_VERSION_CONFLICT', 409);
  assert.equal(f.business.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 11000);
});

test('A07 W2 candidate: price-only and explicit-zero confirmations produce no OCR correction label', t => {
  const f = fixture(t);
  for (const priceCents of [11000, 0]) {
    const ready = f.candidate();
    f.business.createSale(f.sale({ ...ready.reference, items: [f.line({ priceCents, manualPrice: true, zeroConfirmed: priceCents === 0 })] }), owner);
  }
  assert.equal(f.store.read().correctionSamples.length, 0);
  assert.equal(f.business.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 11000);
  const order = f.business.listOrders()[0];
  const revised = f.business.correctSale(order.id, { operationId: randomUUID(), expectedRevision: 1, customerId: 'A', items: [f.line({ lineId: order.items[0].lineId, priceCents: 9000, manualPrice: true })] }, owner);
  assert.equal(f.business.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 9000);
  f.business.correctSale(order.id, { operationId: randomUUID(), expectedRevision: revised.revision, customerId: 'A', items: [f.line({ lineId: order.items[0].lineId, priceCents: 0, manualPrice: true, zeroConfirmed: true })] }, owner);
  assert.equal(f.business.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 9000);
  assert.equal(f.store.read().correctionSamples.length, 0);
});

test('A07 W2 masters: shared aliases stay ambiguous, trimmed duplicates collapse, stale saves and role spoofing leave no grants', t => {
  const f = fixture(t);
  const input = { operationId: randomUUID(), name: '甲别名', address: '合成北街', aliases: ['  甲别名 ', '甲别名'], contact: '合成联系人', phone: 'synthetic-contact' };
  const created = f.masters.saveCustomer(input, owner);
  assert.deepEqual(created.aliases, ['甲别名']);
  const matched = f.masters.matchCustomer('甲别名');
  assert.equal(matched.ambiguous, true);
  assert.deepEqual(new Set(matched.candidates.map(row => row.customerId)), new Set(['A', created.id]));
  assert.ok(matched.candidates.every(row => !('confidence' in row)));
  unchanged(f, () => f.masters.saveCustomer({ ...input, operationId: randomUUID(), id: created.id, expectedVersion: '0' }, owner), 'MASTER_VERSION_CONFLICT', 409);
  unchanged(f, () => f.masters.saveCustomer({ ...input, operationId: randomUUID() }, { role: 'source', active: true, isBoss: true }), 'FORBIDDEN', 403);
  assert.deepEqual(f.store.read().sources, [{ id: 'source-A', active: true }]);
});

test('A07 W2 master packaging: old bottle quotes reject and frozen names, address and price do not follow edits', t => {
  const f = fixture(t);
  const quote = f.business.quote({ customerId: 'A', skuId: 'S', unit: '瓶' });
  const command = f.sale({ items: [f.line({ unit: '瓶', priceCents: quote.priceCents, priceVersion: quote.version })] });
  const old = f.business.createSale(command, owner);
  f.masters.saveProduct({ operationId: randomUUID(), id: 'S', expectedVersion: '1', name: '更名合成商品', units: ['箱', '瓶'], bottlesPerCase: 10 }, owner);
  f.masters.saveCustomer({ operationId: randomUUID(), id: 'A', expectedVersion: '1', name: '更名合成店', address: '更名合成街', aliases: [] }, owner);
  assert.deepEqual(f.business.getOrder(old.id), old);
  assert.notEqual(f.business.quote({ customerId: 'A', skuId: 'S', unit: '瓶' }).version, quote.version);
  unchanged(f, () => f.business.createSale({ ...command, operationId: randomUUID() }, owner), 'PRICE_VERSION_CONFLICT', 409);
});

test('A07 W2 statistics: UTC+8 boundary assigns sale and later reversal/return to their actual event days', t => {
  const f = fixture(t);
  f.clock('2026-10-31T15:59:59.999Z');
  const sale = f.business.createSale(f.sale({ items: [f.line({ quantity: 2 })] }), owner);
  f.clock('2026-10-31T16:00:00.000Z');
  const revised = f.business.correctSale(sale.id, { operationId: randomUUID(), expectedRevision: 1, customerId: 'A', items: [f.line({ lineId: sale.items[0].lineId, priceCents: 9000, quantity: 2, manualPrice: true })] }, owner);
  f.clock('2026-11-01T16:00:00.000Z');
  f.business.createReturn({ operationId: randomUUID(), sourceOrderId: sale.id, expectedSourceRevision: revised.revision, items: [{ lineId: sale.items[0].lineId, quantity: 1 }] }, owner);
  const oct = f.masters.getPeriodStats({ period: 'month', date: '2026-10' });
  const nov1 = f.masters.getPeriodStats({ period: 'day', date: '2026-11-01' });
  const nov2 = f.masters.getPeriodStats({ period: 'day', date: '2026-11-02' });
  assert.equal(oct.netSalesCents, 20000);
  assert.deepEqual([nov1.saleGrossCents, nov1.reversalCents, nov1.netSalesCents], [18000, 20000, -2000]);
  assert.equal(nov2.returnCents, 9000); assert.equal(nov2.netSalesCents, -9000);
  assert.equal(oct.netSalesCents + nov1.netSalesCents + nov2.netSalesCents, f.business.getStats().netSalesCents);
  assert.equal(f.masters.queryOrders({ from: '2026-10-31', to: '2026-11-01' }).filter(row => row.type === 'SALE').length, 1);
  assert.equal(f.masters.queryOrders({ from: '2026-11-01', to: '2026-11-02' }).filter(row => row.type === 'SALE').length, 0);
  for (const date of ['2026-02-29', '2026-04-31', '0000-01-01']) assert.throws(() => f.masters.getPeriodStats({ period: 'day', date }), e => e.code === 'INVALID_DATE');
});

test('A07 W2 device: raw credentials never persist; wrong capability and immediate revocation block all methods', t => {
  const f = fixture(t); f.batch();
  const infer = f.register(), print = f.register(['PRINT']);
  unchanged(f, () => f.edge.claimInference(print), 'DEVICE_FORBIDDEN', 403);
  const leased = f.edge.claimInference(infer);
  const input = { ...infer, jobId: leased.job.id, leaseToken: leased.leaseToken, result: { customerId: 'A', items: [], issues: [] } };
  assert.equal(JSON.stringify(f.store.read()).includes(infer.token), false);
  assert.equal(JSON.stringify(f.store.read()).includes(leased.leaseToken), false);
  assert.equal(JSON.stringify(f.edge.listDevices()).includes('token'), false);
  f.edge.revokeDevice({ operationId: randomUUID(), deviceId: infer.deviceId }, owner);
  for (const method of ['claimInference', 'renewInference', 'completeInference']) unchanged(f, () => f.edge[method](input), 'DEVICE_FORBIDDEN', 403);
  assert.equal(f.store.read().orders.length, 0); assert.equal(f.store.read().salesEvents.length, 0);
});

test('A07 W2 lease: exact expiry and replacement invalidate old capability even with correct raw device token', t => {
  const f = fixture(t); f.batch();
  const first = f.register(), second = f.register();
  const leased = f.edge.claimInference(first);
  const prior = { ...first, jobId: leased.job.id, leaseToken: leased.leaseToken, result: { customerId: 'A', items: [], issues: [] } };
  f.clock(leased.leaseUntil);
  unchanged(f, () => f.edge.completeInference(prior), 'LEASE_CONFLICT', 409);
  const replaced = f.edge.claimInference(second);
  assert.equal(replaced.job.id, leased.job.id);
  unchanged(f, () => f.edge.renewInference(prior), 'LEASE_CONFLICT', 409);
  unchanged(f, () => f.edge.completeInference({ ...prior, ...second }), 'LEASE_CONFLICT', 409);
  f.edge.completeInference({ ...second, jobId: replaced.job.id, leaseToken: replaced.leaseToken, result: { customerId: null, items: [], issues: ['待人工'] } });
  assert.equal(f.store.read().edgeJobs[0].status, 'AWAITING_REVIEW');
});

test('A07 W2 candidate authority: device cannot submit price/confirmation/master creation or another device lease', t => {
  const f = fixture(t); f.batch();
  const first = f.register(), other = f.register(), leased = f.edge.claimInference(first);
  const base = { ...first, jobId: leased.job.id, leaseToken: leased.leaseToken };
  const valid = { customerId: 'A', items: [{ skuId: 'S', unit: '箱', quantity: 1 }], issues: [] };
  for (const result of [{ ...valid, checked: true }, { ...valid, priceCents: 1 }, { ...valid, customer: { name: '不能建档' } }, { ...valid, items: [{ ...valid.items[0], priceCents: 1 }] }]) {
    unchanged(f, () => f.edge.completeInference({ ...base, result }), 'UNCONTROLLED_RESULT');
  }
  unchanged(f, () => f.edge.completeInference({ ...base, ...other, result: valid }), 'LEASE_CONFLICT', 409);
  unchanged(f, () => f.edge.completeInference({ ...base, result: { ...valid, customerId: 'unknown' } }), 'UNKNOWN_CUSTOMER');
  const completion = f.edge.completeInference({ ...base, result: valid });
  const before = f.store.read();
  assert.equal(f.edge.completeInference({ ...base, result: valid }).candidateVersion, completion.candidateVersion);
  assert.deepEqual(f.store.read(), before);
  assert.equal(before.orders.length, 0); assert.equal(before.priceEvents.length, 0); assert.equal(before.salesEvents.length, 0);
});

test('A07 W2 completed-result replay: later master edits do not invalidate a frozen success acknowledgement', t => {
  const f = fixture(t); const ready = f.candidate();
  f.masters.saveProduct({ operationId: randomUUID(), id: 'S', expectedVersion: '1', name: '合成仅瓶商品', units: ['瓶'], bottlesPerCase: 24 }, owner);
  const before = f.store.read();
  const replay = f.edge.completeInference(ready.command);
  assert.equal(replay.candidateVersion, ready.completion.candidateVersion);
  assert.deepEqual(f.store.read(), before);
});

test('A07 W2 source isolation: duplicated message IDs from another source cannot leak into a claimed job', t => {
  const f = fixture(t); const batchJob = f.batch();
  f.store.transact(state => {
    const original = structuredClone(state.messages[1]);
    state.messages.unshift({ ...original, sourceId: 'other-source', text: 'OTHER_SOURCE_SENTINEL', media: [{ id: 'foreign-media' }] });
  });
  const credentials = f.register(), claim = f.edge.claimInference(credentials);
  assert.equal(claim.job.id, batchJob.id);
  assert.equal(JSON.stringify(claim.job).includes('OTHER_SOURCE_SENTINEL'), false);
  assert.equal(JSON.stringify(claim.job).includes('foreign-media'), false);
});

test('A07 W2 real concurrent SQLite: separate workers can only consume one candidate once', async t => {
  const f = fixture(t), ready = f.candidate({ customerId: null, items: [], issues: [] });
  const signal = new SharedArrayBuffer(4), barrier = new Int32Array(signal);
  const workers = [], readyPromises = [], resultPromises = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  for (let number = 0; number < 2; number++) {
    const worker = new Worker(consumeWorker, { workerData: { filename: f.filename, barrier: signal, command: f.sale(ready.reference), actor: owner,
      storeUrl: new URL('../../src/shared/store.mjs', import.meta.url).href,
      serviceUrl: new URL('../../src/business/index.mjs', import.meta.url).href } });
    workers.push(worker);
    const readySignal = Promise.withResolvers(), result = Promise.withResolvers();
    readyPromises.push(readySignal.promise); resultPromises.push(result.promise);
    worker.on('message', value => { if (value.ready) readySignal.resolve(); else result.resolve(value); });
    worker.on('error', error => { readySignal.reject(error); result.reject(error); });
  }
  await Promise.all(readyPromises);
  Atomics.store(barrier, 0, 1); Atomics.notify(barrier, 0, 2);
  const outcomes = await Promise.all(resultPromises);
  await Promise.all(workers.map(worker => worker.terminate()));
  assert.equal(outcomes.filter(outcome => outcome.accepted).length, 1);
  assert.equal(outcomes.filter(outcome => outcome.code === 'REVIEW_VERSION_CONFLICT').length, 1);
  const persisted = f.connect().read();
  assert.equal(persisted.orders.length, 1); assert.equal(persisted.salesEvents.length, 1); assert.equal(persisted.correctionSamples.length, 1);
});
