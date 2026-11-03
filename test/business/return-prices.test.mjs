import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteReturnPriceIn } from '../../src/business/return-prices.mjs';
import { createEmptyState } from '../../src/shared/store.mjs';

function fixture() {
  const state = createEmptyState();
  state.customers = [{ id: 'A' }, { id: 'B' }];
  state.products = [{ id: 'S', units: ['箱', '瓶'], bottlesPerCase: 24, version: '1' }, { id: 'T', units: ['箱', '瓶'], bottlesPerCase: 12, version: '1' }];
  let sequence = 0;
  const row = (priceCents = 10000, extra = {}) => ({ lineId: `line-${++sequence}`, skuId: 'S', unit: '箱', quantity: 1, priceCents, bottlesPerCase: 24, productVersion: '1', ...extra });
  function snapshot(order) { const { revisions, ...value } = order; return structuredClone(value); }
  function event(order, createdAt, type = 'SALE') {
    state.salesEvents.push({ id: `event-${++sequence}`, type, orderId: order.id, revision: order.revision, customerId: order.customerId, createdAt });
  }
  function sale(items = [row()], createdAt = '2026-11-01T00:00:00Z', customerId = 'A') {
    const order = { id: `order-${++sequence}`, type: 'SALE', revision: 1, customerId, createdAt, items: structuredClone(items), revisions: [] };
    order.revisions.push(snapshot(order)); state.orders.push(order); event(order, createdAt); return order;
  }
  function correct(order, changes, createdAt = '2026-11-03T00:00:00Z') {
    event(order, createdAt, 'REVERSAL');
    Object.assign(order, structuredClone(changes), { revision: order.revision + 1, correctedAt: createdAt });
    order.revisions.push(snapshot(order)); event(order, createdAt); return order;
  }
  const quote = (extra = {}) => quoteReturnPriceIn(state, { customerId: 'A', skuId: 'S', unit: '瓶', ...extra });
  return { state, row, sale, correct, quote };
}

test('customer return uses historical box price: 100/24 rounds to 4.2, so 24 bottles are 100.8', () => {
  const f = fixture(), order = f.sale();
  const q = f.quote();
  assert.equal(q.priceCents, 420); assert.equal(q.casePriceCents, 10000);
  assert.equal(q.priceCents * 24, 10080);
  assert.equal(q.source, 'HISTORY_CASE_DERIVED'); assert.equal(q.sourceOrderId, order.id);
  assert.equal(q.sourceRevision, 1); assert.equal(q.sourceLineId, order.items[0].lineId);
  assert.equal(q.priceConfirmedAt, '2026-11-01T00:00:00Z');
  assert.equal(f.quote({ unit: '箱' }).priceCents, 10000);
  assert.equal(f.quote({ unit: '箱' }).source, 'HISTORY_CASE');
});

test('dime rounding is exact at the half boundary and safe-integer limit', () => {
  for (const [casePrice, bottles, expected] of [[9959, 24, 410], [9960, 24, 420], [9961, 24, 420], [Number.MAX_SAFE_INTEGER, 1, 9007199254740990]]) {
    const f = fixture(); f.sale([f.row(casePrice, { bottlesPerCase: bottles })]);
    assert.equal(f.quote().priceCents, expected);
  }
});

test('latest confirmed sale wins; equal timestamps follow persisted event order', () => {
  const f = fixture(); f.sale([f.row(8000)]);
  const latest = f.sale([f.row(11000)], '2026-11-02T00:00:00Z');
  assert.equal(f.quote().sourceOrderId, latest.id);
  const sameTime = f.sale([f.row(12000)], '2026-11-02T00:00:00Z');
  assert.equal(f.quote().sourceOrderId, sameTime.id); assert.equal(f.quote().casePriceCents, 12000);
});

test('customer-maintained current price without confirmed box sale remains missing', () => {
  const f = fixture();
  f.state.prices[JSON.stringify(['A', 'S', '箱'])] = { priceCents: 10000, version: 'manual-price' };
  f.state.priceEvents.push({ customerId: 'A', skuId: 'S', unit: '箱', priceCents: 10000, source: 'CUSTOMER_MANUAL' });
  assert.equal(f.quote().source, 'MISSING'); assert.equal(f.quote().priceCents, null);
});

test('bottle-only sale cannot substitute for absent historical box price', () => {
  const f = fixture(); f.sale([f.row(500, { unit: '瓶' })]);
  assert.equal(f.quote().source, 'MISSING'); assert.equal(f.quote({ unit: '箱' }).source, 'MISSING');
});

test('zero sales and returns cannot eclipse earlier nonzero box sale', () => {
  const f = fixture(); const paid = f.sale();
  f.sale([f.row(0)], '2026-11-02T00:00:00Z');
  const returned = f.sale([f.row(99900)], '2026-11-03T00:00:00Z');
  returned.type = 'RETURN'; returned.revisions[0].type = 'RETURN'; f.state.salesEvents.at(-1).type = 'RETURN';
  assert.equal(f.quote().sourceOrderId, paid.id); assert.equal(f.quote().casePriceCents, 10000);
});

test('prices are isolated by customer and SKU', () => {
  const f = fixture(); f.sale([f.row(8000)]); f.sale([f.row(20000)], '2026-11-02T00:00:00Z', 'B');
  f.sale([f.row(30000, { skuId: 'T' })], '2026-11-03T00:00:00Z');
  assert.equal(f.quote().casePriceCents, 8000);
  assert.equal(f.quote({ customerId: 'B' }).casePriceCents, 20000);
  assert.equal(f.quote({ skuId: 'T' }).casePriceCents, 30000);
});

test('quantity-only correction does not lift an older price above intervening sale', () => {
  const f = fixture(), old = f.sale();
  const recent = f.sale([f.row(11000)], '2026-11-02T00:00:00Z');
  f.correct(old, { items: old.items.map(row => ({ ...row, quantity: 2 })) });
  assert.equal(f.quote().sourceOrderId, recent.id); assert.equal(f.quote().casePriceCents, 11000);
});

test('actual nonzero price correction is a new effective historical source', () => {
  const f = fixture(), old = f.sale(); f.sale([f.row(11000)], '2026-11-02T00:00:00Z');
  f.correct(old, { items: old.items.map(row => ({ ...row, priceCents: 9000 })) });
  const q = f.quote(); assert.equal(q.casePriceCents, 9000); assert.equal(q.sourceOrderId, old.id);
  assert.equal(q.sourceRevision, 2); assert.equal(q.priceConfirmedAt, '2026-11-03T00:00:00Z');
});

test('source moved to another customer is excluded for original customer and confirmed for new one', () => {
  const f = fixture(), original = f.sale(); f.correct(original, { customerId: 'B' });
  assert.equal(f.quote().source, 'MISSING');
  const q = f.quote({ customerId: 'B' }); assert.equal(q.casePriceCents, 10000); assert.equal(q.sourceRevision, 2);
});

test('source changed to zero or another SKU cannot revive invalid older snapshot', () => {
  for (const change of [{ priceCents: 0 }, { skuId: 'T' }]) {
    const f = fixture(); const earlier = f.sale([f.row(8000)]);
    const original = f.sale([f.row(10000)], '2026-11-02T00:00:00Z');
    f.correct(original, { items: original.items.map(row => ({ ...row, ...change })) });
    assert.equal(f.quote().sourceOrderId, earlier.id); assert.equal(f.quote().casePriceCents, 8000);
  }
});

test('frozen sale packaging survives later product version and package changes', () => {
  const f = fixture(); f.sale(); const before = f.quote();
  Object.assign(f.state.products[0], { bottlesPerCase: 12, version: '2' });
  const after = f.quote();
  assert.equal(after.priceCents, 420); assert.equal(after.bottlesPerCase, 24);
  assert.equal(after.productVersion, '1'); assert.equal(after.packagingSource, 'SALE_SNAPSHOT');
  assert.equal(after.requiresPackagingConfirmation, false); assert.equal(after.version, before.version);
});

test('legacy missing packaging explicitly uses current master and changes quote version when master changes', () => {
  const f = fixture(); f.sale([f.row(10000, { bottlesPerCase: undefined, productVersion: undefined })]);
  const before = f.quote();
  assert.equal(before.priceCents, 420); assert.equal(before.packagingSource, 'CURRENT_MASTER_REQUIRES_CONFIRMATION');
  assert.equal(before.requiresPackagingConfirmation, true);
  Object.assign(f.state.products[0], { bottlesPerCase: 12, version: '2' });
  const after = f.quote(); assert.equal(after.priceCents, 830); assert.equal(after.productVersion, '2');
  assert.notEqual(after.version, before.version);
  assert.equal(f.state.orders[0].items[0].bottlesPerCase, undefined);
});

test('current effective revision participates in quote version even for quantity correction', () => {
  const f = fixture(), original = f.sale(); const before = f.quote();
  f.correct(original, { items: original.items.map(row => ({ ...row, quantity: 2 })) });
  const after = f.quote(); assert.equal(after.priceCents, before.priceCents);
  assert.equal(after.sourceRevision, 1); assert.notEqual(after.version, before.version);
});

test('latest event with multiple prices is ambiguous instead of falling back to an older sale', () => {
  const f = fixture(); f.sale([f.row(8000)]);
  const latest = f.sale([f.row(10000), f.row(11000)], '2026-11-02T00:00:00Z');
  const q = f.quote(); assert.equal(q.source, 'AMBIGUOUS'); assert.equal(q.priceCents, null);
  assert.equal(q.sourceOrderId, latest.id); assert.match(q.version, /^return:[a-f0-9]{64}$/);
});

test('duplicate same-price same-packaging rows remain one unambiguous quotation', () => {
  const f = fixture(); f.sale([f.row(10000), f.row(10000)]);
  assert.equal(f.quote().source, 'HISTORY_CASE_DERIVED'); assert.equal(f.quote().priceCents, 420);
});

test('query is pure and returns detached metadata from deeply frozen state', () => {
  const f = fixture(); f.sale(); const before = structuredClone(f.state);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(f.state); const q = f.quote(); q.casePriceCents = 1;
  assert.deepEqual(f.state, before); assert.equal(f.quote().casePriceCents, 10000);
});

test('invalid inputs, masters and packaging reject instead of inventing values', () => {
  const f = fixture();
  for (const input of [null, []]) assert.throws(() => quoteReturnPriceIn(f.state, input), { code: 'INVALID_INPUT' });
  for (const input of [{ customerId: 'unknown' }, { skuId: 'unknown' }, { unit: '件' }]) assert.throws(() => f.quote(input), { code: 'INVALID_MASTER' });
  f.sale([f.row(10000, { bottlesPerCase: undefined })]); f.state.products[0].bottlesPerCase = 0;
  assert.throws(() => f.quote(), { code: 'RETURN_PACKAGING_INVALID' });
});
