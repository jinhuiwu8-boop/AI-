import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/shared/store.mjs';
import { createBusinessService, createMasterDataService } from '../../src/business/index.mjs';

const boss = { id: 'w2-boss', role: 'boss', active: true };
let sequence = 0;
const op = () => `w2-business-${++sequence}`;
function fixture() {
  const store = createStore({ filename: ':memory:' });
  store.transact(state => {
    state.customers = [{ id: 'C1', name: '合成甲', address: '合成街1号', aliases: ['甲店'] }];
    state.products = [{ id: 'S1', name: '合成饮品', units: ['箱', '瓶'], bottlesPerCase: 24 }];
    state.prices[JSON.stringify(['C1', 'S1', '箱'])] = { priceCents: 10000, version: 'p1' };
    state.correctionSamples = [];
  });
  let time = '2026-10-31T15:59:59.000Z', failing = false;
  const now = () => time;
  const documentStore = { save(order) {
    if (failing) throw Error('synthetic disk failure');
    return { id: `d-${order.id}-${order.revision}`, mimeType: 'image/png', sha256: 'c'.repeat(64), relativePath: 'synthetic.png' };
  } };
  const service = createBusinessService({ store, documentStore, now });
  const masters = createMasterDataService({ store, now });
  const line = (extra = {}) => ({ skuId: 'S1', unit: '箱', quantity: 1, priceCents: 10000, priceVersion: service.quote({ customerId: 'C1', skuId: 'S1', unit: '箱' }).version, ...extra });
  const command = (extra = {}) => ({ operationId: op(), checked: true, mode: 'ELECTRONIC', customerId: 'C1', items: [line()], ...extra });
  const candidate = (extra = {}) => {
    const job = { id: `job-${op()}`, status: 'AWAITING_REVIEW', candidateVersion: `candidate-${op()}`, candidate: { customerId: 'C1', items: [{ skuId: 'S1', unit: '箱', quantity: 1 }], issues: [] }, ...extra };
    store.transact(state => { state.edgeJobs.push(job); });
    return { sourceJobId: job.id, candidateVersion: job.candidateVersion };
  };
  return { store, service, masters, line, command, candidate, documentStore, setTime: value => { time = value; }, failDocument: value => { failing = value; } };
}

test('customer IDs stay stable, same-name addresses and shared aliases retain ambiguity without confidence', () => {
  const f = fixture();
  const a = f.masters.saveCustomer({ operationId: op(), name: '同名店', address: '南街1号', aliases: ['  小店  ', '小店'], contact: '合成联系人', phone: 'synthetic-only' }, boss);
  const b = f.masters.saveCustomer({ operationId: op(), name: '同名店', address: '北街2号', aliases: ['小店'] }, boss);
  assert.notEqual(a.id, b.id); assert.deepEqual(a.aliases, ['小店']);
  for (const name of ['同名店', '小店']) {
    const match = f.masters.matchCustomer(name);
    assert.equal(match.ambiguous, true); assert.equal(match.candidates.length, 2);
    assert.deepEqual(new Set(match.candidates.map(row => row.address)), new Set(['南街1号', '北街2号']));
    assert.equal(match.candidates.some(row => 'confidence' in row), false);
  }
  const changed = f.masters.saveCustomer({ operationId: op(), ...a, expectedVersion: a.version, name: '改名店' }, boss);
  assert.equal(changed.id, a.id); assert.equal(changed.version, '2');
  assert.equal(f.masters.matchCustomer('改名店').candidates[0].reason, 'EXACT_NAME');
  assert.equal(f.masters.matchCustomer('改名').candidates[0].reason, 'CONTAINS');
  assert.deepEqual(f.masters.matchCustomer('不存在的合成名称'), { candidates: [], ambiguous: false });
  f.store.close();
});

test('customer write replay and stale versions are atomic; metadata does not grant source authority', () => {
  const f = fixture(); const input = { operationId: op(), name: '合成店', address: '合成街', aliases: [] };
  const first = f.masters.saveCustomer(input, boss);
  assert.deepEqual(f.masters.saveCustomer(input, boss), first);
  const before = f.store.read();
  assert.throws(() => f.masters.saveCustomer({ ...input, name: '改变' }, boss), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => f.masters.saveCustomer({ ...input, operationId: op(), id: first.id, expectedVersion: 'stale' }, boss), { code: 'MASTER_VERSION_CONFLICT' });
  assert.throws(() => f.masters.saveCustomer({ ...input, operationId: op() }, { role: 'source', active: true }), { code: 'FORBIDDEN' });
  assert.deepEqual(f.store.read(), before); assert.deepEqual(f.store.read().sources, []);
  const result = f.masters.saveCustomer({ ...input, operationId: op(), id: first.id, expectedVersion: first.version, phone: 'synthetic' }, boss);
  result.aliases.push('external mutation'); assert.deepEqual(f.store.read().customers.at(-1).aliases, []);
  f.store.close();
});

test('exact names and aliases from different customers remain ambiguous and list limits do not hide ambiguity', () => {
  const f = fixture();
  for (let i = 0; i < 7; i++) f.masters.saveCustomer({ operationId: op(), name: i === 0 ? '公共名' : `合成店${i}`, address: `路${i}`, aliases: ['公共名'] }, boss);
  const match = f.masters.matchCustomer('公共名');
  assert.equal(match.candidates.length, 5); assert.equal(match.ambiguous, true);
  assert.equal(match.candidates[0].reason, 'EXACT_NAME');
  f.store.close();
});

test('master validation rejects invalid packaging and missing address without partial writes', () => {
  const f = fixture(); const before = f.store.read();
  for (const bottlesPerCase of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '24']) assert.throws(() => f.masters.saveProduct({ operationId: op(), name: '合成商品', units: ['箱', '瓶'], bottlesPerCase }, boss), { code: 'INVALID_MASTER' });
  assert.throws(() => f.masters.saveProduct({ operationId: op(), name: '商品', units: ['箱', '箱'], bottlesPerCase: 12 }, boss), { code: 'INVALID_MASTER' });
  assert.throws(() => f.masters.saveCustomer({ operationId: op(), name: '客户', address: ' ', aliases: [] }, boss), { code: 'INVALID_MASTER' });
  assert.deepEqual(f.store.read(), before); f.store.close();
});

test('packaging and customer master updates affect future quotes but not frozen order snapshots', () => {
  const f = fixture(); const quote = f.service.quote({ customerId: 'C1', skuId: 'S1', unit: '瓶' });
  const order = f.service.createSale(f.command({ items: [f.line({ unit: '瓶', priceCents: quote.priceCents, priceVersion: quote.version })] }), boss);
  const changed = f.masters.saveProduct({ operationId: op(), id: 'S1', expectedVersion: '1', name: '新商品名', units: ['箱', '瓶'], bottlesPerCase: 10 }, boss);
  assert.equal(changed.version, '2');
  const next = f.service.quote({ customerId: 'C1', skuId: 'S1', unit: '瓶' });
  assert.equal(next.priceCents, 1000); assert.notEqual(next.version, quote.version);
  f.masters.saveCustomer({ operationId: op(), id: 'C1', expectedVersion: '1', name: '新客户名', address: '新地址', aliases: [] }, boss);
  assert.deepEqual(f.service.getOrder(order.id), order);
  assert.equal(order.customerName, '合成甲'); assert.equal(order.customerAddress, '合成街1号'); assert.equal(order.items[0].productName, '合成饮品'); assert.equal(order.items[0].priceCents, 420);
  f.store.close();
});

test('inference candidate remains zero-sale before explicit check; corrected nulls produce one recorded sample', () => {
  const f = fixture();
  const reference = f.candidate({ candidate: { customerId: null, items: [{ skuId: null, productName: '未识别', unit: null, quantity: null }], issues: ['待人工补充'] }, modelVersion: 'synthetic-v1' });
  assert.equal(f.service.getStats().salesCents, 0); assert.equal(f.store.read().correctionSamples.length, 0);
  const input = f.command(reference); const before = f.store.read();
  assert.throws(() => f.service.createSale({ ...input, checked: false }, boss), { code: 'NOT_CHECKED' }); assert.deepEqual(f.store.read(), before);
  const order = f.service.createSale(input, boss);
  assert.deepEqual(f.service.createSale(input, boss), order);
  assert.equal(f.store.read().edgeJobs[0].status, 'REVIEWED'); assert.equal(f.store.read().edgeJobs[0].reviewOrderId, order.id);
  const sample = f.store.read().correctionSamples[0];
  assert.equal(sample.status, 'RECORDED'); assert.equal(sample.modelVersion, 'synthetic-v1'); assert.equal(sample.orderId, order.id);
  assert.equal(sample.originalCandidate.customerId, null); assert.deepEqual(sample.confirmed.items, [{ skuId: 'S1', unit: '箱', quantity: 1 }]);
  assert.equal(f.store.read().correctionSamples.length, 1);
  assert.throws(() => f.service.createSale({ ...input, operationId: op() }, boss), { code: 'REVIEW_VERSION_CONFLICT' });
  assert.equal(f.service.getStats().salesCents, 10000); f.store.close();
});

test('document failure preserves candidate, sample, sales and price; stale candidate rejects before save', () => {
  const f = fixture(); const reference = f.candidate({ candidate: { customerId: null, items: [], issues: [] } });
  const input = f.command({ ...reference, items: [f.line({ manualPrice: true, priceCents: 11000 })] });
  const before = f.store.read(); f.failDocument(true);
  assert.throws(() => f.service.createSale(input, boss), { code: 'DOCUMENT_FAILED' }); assert.deepEqual(f.store.read(), before);
  f.failDocument(false);
  assert.throws(() => f.service.createSale({ ...input, candidateVersion: 'old' }, boss), { code: 'REVIEW_VERSION_CONFLICT' }); assert.deepEqual(f.store.read(), before);
  f.service.createSale(input, boss); assert.equal(f.store.read().correctionSamples.length, 1); assert.equal(f.store.read().edgeJobs[0].status, 'REVIEWED'); f.store.close();
});

test('matching recognition and price-only edits never become recognition correction samples', () => {
  const f = fixture();
  for (const priceCents of [11000, 0]) {
    const reference = f.candidate();
    f.service.createSale(f.command({ ...reference, items: [f.line({ priceCents, manualPrice: true, zeroConfirmed: priceCents === 0 })] }), boss);
  }
  assert.equal(f.store.read().correctionSamples.length, 0);
  assert.equal(f.service.quote({ customerId: 'C1', skuId: 'S1', unit: '箱' }).priceCents, 11000);
  f.service.createSale(f.command({ items: [f.line({ priceCents: 11000 })] }), boss);
  assert.equal(f.store.read().correctionSamples.length, 0); f.store.close();
});

test('reordering valid candidate lines is not a recognition error; malformed source pairs cannot bypass review', () => {
  const f = fixture();
  const reference = f.candidate({ candidate: { customerId: 'C1', items: [{ skuId: 'S1', unit: '箱', quantity: 1 }, { skuId: 'S1', unit: '箱', quantity: 2 }], issues: [] } });
  const input = f.command({ ...reference, items: [f.line({ quantity: 2 }), f.line()] });
  const before = f.store.read();
  for (const malformed of [{ sourceJobId: reference.sourceJobId }, { candidateVersion: reference.candidateVersion }]) assert.throws(() => f.service.createSale(f.command(malformed), boss), { code: 'INVALID_REVIEW_SOURCE' });
  assert.deepEqual(f.store.read(), before);
  f.service.createSale(input, boss); assert.equal(f.store.read().correctionSamples.length, 0); f.store.close();
});

test('different SQLite connections cannot consume a candidate twice', () => {
  const f = fixture(); const reference = f.candidate(); const directory = mkdtempSync(join(tmpdir(), 'w2-review-'));
  const filename = join(directory, 'state.sqlite'); const first = createStore({ filename, initialState: f.store.read() }); const second = createStore({ filename });
  try {
    const a = createBusinessService({ store: first, documentStore: f.documentStore }); const b = createBusinessService({ store: second, documentStore: f.documentStore });
    const input = f.command(reference); const order = a.createSale(input, boss);
    assert.throws(() => b.createSale({ ...input, operationId: op() }, boss), { code: 'REVIEW_VERSION_CONFLICT' });
    assert.deepEqual(b.createSale(input, boss), order); assert.equal(second.read().orders.length, 1); assert.equal(second.read().salesEvents.length, 1);
  } finally { first.close(); second.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Beijing day/month statistics use actual event timestamps across correction and return boundaries', () => {
  const f = fixture(); const first = f.service.createSale(f.command({ items: [f.line({ quantity: 2 })] }), boss);
  f.setTime('2026-10-31T16:00:00.000Z');
  const corrected = f.service.correctSale(first.id, { operationId: op(), expectedRevision: 1, customerId: 'C1', items: [{ ...first.items[0], quantity: 2, priceCents: 9000, priceVersion: 'p1' }] }, boss);
  f.setTime('2026-11-01T16:00:00.000Z');
  f.service.createReturn({ operationId: op(), sourceOrderId: first.id, expectedSourceRevision: 2, items: [{ lineId: corrected.items[0].lineId, quantity: 1 }] }, boss);
  const october = f.masters.getPeriodStats({ period: 'month', date: '2026-10' });
  assert.equal(october.salesCents, 20000); assert.equal(october.netSalesCents, 20000); assert.equal(october.reversalCents, 0);
  const november = f.service.getPeriodStats({ period: 'month', date: '2026-11' });
  assert.deepEqual([november.saleGrossCents, november.reversalCents, november.salesCents, november.returnCents, november.netSalesCents, november.receivableCents], [18000, 20000, -2000, 9000, -11000, -11000]);
  assert.deepEqual(november.eventCounts, { sale: 1, reversal: 1, return: 1 });
  const dayOne = f.service.getPeriodStats({ period: 'day', date: '2026-11-01' });
  assert.equal(dayOne.netSalesCents, -2000); assert.equal(dayOne.from, '2026-10-31T16:00:00.000Z');
  const dayTwo = f.service.getPeriodStats({ period: 'day', date: '2026-11-02' });
  assert.equal(dayTwo.netSalesCents, -9000); assert.equal(dayTwo.returnCount, 1);
  assert.equal(f.service.getStats().netSalesCents, october.netSalesCents + november.netSalesCents);
  f.store.close();
});

test('order filters use inclusive from/exclusive to in Beijing, while history is not recomputed from current order', () => {
  const f = fixture(); const first = f.service.createSale(f.command(), boss);
  f.setTime('2026-10-31T16:00:00.000Z'); const second = f.service.createSale(f.command(), boss);
  assert.deepEqual(f.masters.queryOrders({ customerId: 'C1', type: 'SALE', from: '2026-10-31', to: '2026-11-01' }).map(row => row.id), [first.id]);
  assert.deepEqual(f.service.queryOrders({ from: '2026-11-01', to: '2026-11-02' }).map(row => row.id), [second.id]);
  assert.equal(f.service.queryOrders({ customerId: 'unmatched' }).length, 0);
  assert.equal(f.service.queryOrders({ from: '2026-10-31T16:00:00Z', to: '2026-10-31T16:00:00Z' }).length, 0);
  const copy = f.masters.queryOrders({}); copy[0].items[0].quantity = 999;
  assert.equal(f.service.getOrder(second.id).items[0].quantity, 1); f.store.close();
});

test('period and query validation reject impossible dates, unspecific times, invalid types and reverse ranges', () => {
  const f = fixture();
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-1', '0000-01-01']) assert.throws(() => f.masters.getPeriodStats({ period: 'day', date }), { code: 'INVALID_DATE' });
  for (const date of ['2026-13', '2026-00', '2026-1']) assert.throws(() => f.masters.getPeriodStats({ period: 'month', date }), { code: 'INVALID_DATE' });
  assert.equal(f.service.getPeriodStats({ period: 'day', date: '2024-02-29' }).netSalesCents, 0);
  assert.throws(() => f.service.getPeriodStats({ period: 'week', date: '2026-10-31' }), { code: 'INVALID_PERIOD' });
  for (const from of ['2026-10-31T00:00:00', '2026-02-30T00:00:00Z', '2026-10-31T24:00:00Z']) assert.throws(() => f.service.queryOrders({ from }), { code: 'INVALID_DATE' });
  assert.throws(() => f.service.queryOrders({ from: '2026-11-01', to: '2026-10-31' }), { code: 'INVALID_DATE_RANGE' });
  assert.throws(() => f.service.queryOrders({ type: 'FAKE' }), { code: 'INVALID_QUERY' }); f.store.close();
});
