import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/shared/store.mjs';
import { createBusinessService } from '../../src/business/index.mjs';

const actor = { id: 'owner', role: 'boss', active: true };
let sequence = 0;
const op = () => `business-test-${++sequence}`;
function fixture() {
  const store = createStore({ filename: ':memory:' });
  store.transact(s => {
    s.customers = [{ id: 'C-A', name: '合成甲', aliases: [] }, { id: 'C-B', name: '合成乙', aliases: [] }];
    s.products = [{ id: 'SKU-S', name: '合成饮料', units: ['箱', '瓶'], bottlesPerCase: 24 }];
    s.prices = Object.fromEntries(['C-A', 'C-B'].map(id => [JSON.stringify([id, 'SKU-S', '箱']), { priceCents: 10000, version: 'p1', source: 'SEED' }]));
  });
  let failing = false;
  const service = createBusinessService({ store, documentStore: { save: order => { if (failing) throw Error('disk full'); return { id: `doc-${order.id}-${order.revision}`, mimeType: 'image/png', sha256: 'a'.repeat(64), relativePath: 'synthetic.png', createdAt: '2026-10-31' }; } } });
  const line = (quantity = 1, priceCents = 10000, extra = {}) => ({ skuId: 'SKU-S', unit: '箱', quantity, priceCents, priceVersion: service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' }).version, ...extra });
  const sale = (items = [line()], extra = {}) => service.createSale({ operationId: op(), customerId: 'C-A', mode: 'ELECTRONIC', checked: true, items, ...extra }, actor);
  const correct = (order, items, extra = {}) => service.correctSale(order.id, { operationId: op(), expectedRevision: order.revision, customerId: order.customerId, items, creditCents: 0, waiverCents: 0, ...extra }, actor);
  const ret = (order, quantity, extra = {}) => service.createReturn({ operationId: op(), sourceOrderId: order.id, expectedSourceRevision: order.revision, items: [{ lineId: order.items[0].lineId, quantity }], ...extra }, actor);
  return { store, service, line, sale, correct, ret, failDocument: value => { failing = value; } };
}
test('save110 then restore100 appends history; replay cannot toggle; stale price rejected', () => {
  const f = fixture();
  const input = { operationId: op(), customerId: 'C-A', skuId: 'SKU-S', unit: '箱', priceCents: 11000, expectedVersion: 'p1' };
  const changed = f.service.savePrice(input, actor);
  assert.equal(changed.priceCents, 11000);
  const restore = { ...input, operationId: op(), expectedVersion: changed.version }; delete restore.priceCents;
  assert.equal(f.service.restorePrice(restore, actor).priceCents, 10000);
  f.service.restorePrice(restore, actor);
  assert.equal(f.store.read().priceEvents.length, 2);
  assert.throws(() => f.service.savePrice({ ...input, operationId: op() }, actor), { code: 'PRICE_VERSION_CONFLICT' });
  assert.throws(() => f.service.restorePrice({ ...restore, operationId: op(), expectedVersion: f.service.quote(input).version }, actor), { code: 'NO_RESTORE_POINT' });
  f.store.close();
});
test('bottle uses exact dime rounding and goods stays separate from receivable', () => {
  const f = fixture(); const q = f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '瓶' });
  assert.equal(q.priceCents, 420);
  const o = f.sale([f.line(3, 420, { unit: '瓶', priceVersion: q.version })], { creditCents: 5 });
  assert.deepEqual(o.totals, { goodsCents: 1260, creditCents: 5, waiverCents: 0, receivableCents: 1260, roundingCents: 5 });
  assert.equal(f.service.getStats().salesCents, 1260); f.store.close();
});
test('document failure rolls back order, manual price, sale and idempotency record', () => {
  const f = fixture(); f.failDocument(true); const before = f.store.read();
  assert.throws(() => f.sale([f.line(1, 11000, { manualPrice: true })]), { code: 'DOCUMENT_FAILED' });
  assert.deepEqual(f.store.read(), before); f.failDocument(false);
  f.sale([f.line(1, 11000, { manualPrice: true })]); assert.equal(f.service.getStats().salesCents, 11000); f.store.close();
});
test('zero confirmed does not propagate; missing and stale sources cannot bypass validation', () => {
  const f = fixture(); f.sale([f.line(1, 0, { manualPrice: true, zeroConfirmed: true })]);
  assert.equal(f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' }).priceCents, 10000);
  f.sale(); assert.equal(f.service.getStats().salesCents, 10000);
  assert.throws(() => f.sale([f.line(1, 0, { manualPrice: true })]), { code: 'ZERO_NOT_CONFIRMED' });
  assert.throws(() => f.sale([f.line(1, 1, { manualPrice: true, priceVersion: 'old' })]), { code: 'PRICE_VERSION_CONFLICT' }); f.store.close();
});
test('same operation replays once; altered input409; paper only pending no device claim', () => {
  const f = fixture(); const input = { operationId: op(), customerId: 'C-A', mode: 'PAPER', checked: true, items: [f.line()] };
  const first = f.service.createSale(input, actor); assert.deepEqual(f.service.createSale(input, actor), first);
  assert.throws(() => f.service.createSale({ ...input, note: 'changed' }, actor), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.service.getStats().netSalesCents, 10000);
  assert.equal(f.store.read().printAttempts.length, 1); assert.equal(f.store.read().printAttempts[0].status, 'PENDING_DEVICE'); f.store.close();
});
test('price, customer and quantity corrections reverse old economics; actual price correction updates future price', () => {
  for (const kind of ['price', 'customer', 'quantity']) {
    const f = fixture(); const original = f.sale([f.line(kind === 'quantity' ? 2 : 1)]);
    const input = { operationId: op(), expectedRevision: 1, customerId: kind === 'customer' ? 'C-B' : 'C-A', items: [{ ...original.items[0], quantity: 1, priceCents: kind === 'price' ? 9000 : 10000, priceVersion: 'p1' }] };
    const updated = f.service.correctSale(original.id, input, actor); f.service.correctSale(original.id, input, actor);
    assert.equal(updated.revisions.length, 2); assert.equal(updated.revisions[0].totals.goodsCents, kind === 'quantity' ? 20000 : 10000);
    assert.equal(f.service.getStats().netSalesCents, kind === 'price' ? 9000 : 10000);
    assert.equal(f.store.read().salesEvents.length, 3);
    if (kind === 'customer') {
      const amounts = id => f.store.read().salesEvents.filter(e => e.customerId === id).reduce((sum, e) => sum + e.amountCents, 0);
      assert.equal(amounts('C-A'), 0); assert.equal(amounts('C-B'), 10000);
    }
    assert.equal(f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' }).priceCents, kind === 'price' ? 9000 : 10000); f.store.close();
  }
});
test('return original price partial; cumulative and changed-input reject without mutation', () => {
  const f = fixture(); const original = f.sale([f.line(2)]);
  f.service.savePrice({ operationId: op(), customerId: 'C-A', skuId: 'SKU-S', unit: '箱', priceCents: 11000, expectedVersion: 'p1' }, actor);
  const returned = f.ret(original, 1); assert.equal(returned.items[0].priceCents, 10000);
  assert.equal(f.service.getStats().netSalesCents, 10000);
  const before = f.store.read(); assert.throws(() => f.ret(original, 2), { code: 'RETURN_OVER_LIMIT' }); assert.deepEqual(f.store.read(), before);
  for (const row of [{ unit: '瓶' }, { customerId: 'C-B' }, { lineId: 'foreign' }]) {
    assert.throws(() => f.ret(original, 1, { items: [{ lineId: original.items[0].lineId, quantity: 1, ...row }] }), { code: 'RETURN_SOURCE_INVALID' });
  }
  f.store.close();
});
test('returned sale quantity correction preserves prior return; less-than-returned and reprice rollback', () => {
  const f = fixture(); const original = f.sale([f.line(2)]); f.ret(original, 1);
  const corrected = f.correct(original, [{ ...original.items[0], quantity: 1 }]);
  assert.equal(f.service.getStats().salesCents, 10000); assert.equal(f.service.getStats().returnCents, 10000); assert.equal(f.service.getStats().netSalesCents, 0);
  const before = f.store.read(); assert.throws(() => f.correct(corrected, [{ ...corrected.items[0], priceCents: 9000 }] ), { code: 'RETURN_CORRECTION_UNSUPPORTED' }); assert.deepEqual(f.store.read(), before);
  assert.throws(() => f.correct(corrected, [{ ...corrected.items[0], lineId: 'replacement' }] ), { code: 'BELOW_RETURNED_QUANTITY' });
  assert.throws(() => f.ret(corrected, 1), { code: 'RETURN_OVER_LIMIT' }); f.store.close();
});
test('zero-price return stays0; adjusted sale return unsupported; boss cloud authority and deep copies', () => {
  const f = fixture(); const zero = f.sale([f.line(1, 0, { manualPrice: true, zeroConfirmed: true })]); f.ret(zero, 1);
  assert.equal(f.service.getStats().returnCents, 0);
  const adjusted = f.sale(undefined, { creditCents: 100 }); assert.throws(() => f.ret(adjusted, 1), { code: 'RETURN_ADJUSTMENT_UNSUPPORTED' });
  assert.throws(() => f.service.createSale({ operationId: op(), isBoss: true }, { role: 'source', active: true }), { code: 'FORBIDDEN' });
  assert.throws(() => f.service.savePrice({ operationId: op() }, { role: 'boss', active: false }), { code: 'FORBIDDEN' });
  const copy = f.service.getOrder(zero.id); copy.items[0].priceCents = 99999; assert.equal(f.service.getOrder(zero.id).items[0].priceCents, 0); f.store.close();
});
test('two independent SQLite connections cannot both consume last return allowance; restart retains net', () => {
  const f = fixture(); const original = f.sale([f.line(1)]);
  const directory = mkdtempSync(join(tmpdir(), 'business-'));
  const filename = join(directory, 'state.sqlite');
  const first = createStore({ filename, initialState: f.store.read() });
  const second = createStore({ filename });
  const documents = { save: o => ({ id: o.id, mimeType: 'image/png', sha256: 'b'.repeat(64), relativePath: 'test.png' }) };
  try {
    const a = createBusinessService({ store: first, documentStore: documents });
    const b = createBusinessService({ store: second, documentStore: documents });
    const command = { operationId: op(), sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 1 }] };
    a.createReturn(command, actor);
    assert.throws(() => b.createReturn({ ...command, operationId: op() }, actor), { code: 'RETURN_OVER_LIMIT' });
    assert.equal(b.getStats().netSalesCents, 0);
    assert.deepEqual(b.createReturn(command, actor), a.getOrder(first.read().orders.find(o => o.type === 'RETURN').id));
    const reopened = createStore({ filename });
    try { assert.equal(createBusinessService({ store: reopened, documentStore: documents }).getStats().netSalesCents, 0); }
    finally { reopened.close(); }
  } finally { first.close(); second.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('correction and return document failures preserve full ledger and return allowance', () => {
  const f = fixture(); const original = f.sale([f.line(2)]); const before = f.store.read(); f.failDocument(true);
  assert.throws(() => f.correct(original, [{ ...original.items[0], quantity: 1 }]), { code: 'DOCUMENT_FAILED' });
  assert.deepEqual(f.store.read(), before);
  assert.throws(() => f.ret(original, 1), { code: 'DOCUMENT_FAILED' }); assert.deepEqual(f.store.read(), before);
  f.failDocument(false); f.ret(original, 2); assert.equal(f.service.getStats().netSalesCents, 0); f.store.close();
});
test('corrected nonzero price becomes future price; zero correction and quantity-only never overwrite current price', () => {
  const f = fixture(); const original = f.sale();
  const changed = f.correct(original, [{ ...original.items[0], priceCents: 9000, priceVersion: 'p1' }]);
  assert.equal(f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' }).priceCents, 9000);
  f.sale([f.line(1, 9000)]); assert.equal(f.service.getStats().netSalesCents, 18000);
  const zero = f.correct(changed, [{ ...changed.items[0], priceCents: 0, manualPrice: true, zeroConfirmed: true }]);
  assert.equal(f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' }).priceCents, 9000);
  assert.equal(f.service.getStats().netSalesCents, 9000);
  const q = f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  f.service.savePrice({ operationId: op(), ...q, priceCents: 11000, expectedVersion: q.version }, actor);
  f.correct(zero, [{ ...zero.items[0], quantity: 2 }]);
  assert.equal(f.service.quote(q).priceCents, 11000); f.store.close();
  const g = fixture(); const manual = g.sale([g.line(1, 11000, { manualPrice: true })]);
  const current = g.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  g.service.savePrice({ operationId: op(), ...current, priceCents: 12000, expectedVersion: current.version }, actor);
  const events = g.store.read().priceEvents.length;
  g.correct(manual, [{ ...manual.items[0], quantity: 2 }]);
  assert.equal(g.service.quote(current).priceCents, 12000);
  assert.equal(g.store.read().priceEvents.length, events);
  assert.equal(g.service.getStats().netSalesCents, 22000); g.store.close();
});
test('stale correction price and failed document preserve ledger and regular price; bounded input', () => {
  const f = fixture(); const original = f.sale();
  const before = f.store.read();
  assert.throws(() => f.correct(original, [{ ...original.items[0], priceCents: 9000, priceVersion: 'stale' }]), { code: 'PRICE_VERSION_CONFLICT' });
  assert.deepEqual(f.store.read(), before);
  f.failDocument(true);
  assert.throws(() => f.correct(original, [{ ...original.items[0], priceCents: 9000, priceVersion: 'p1' }]), { code: 'DOCUMENT_FAILED' });
  assert.deepEqual(f.store.read(), before); f.failDocument(false);
  assert.throws(() => f.sale(Array.from({ length: 101 }, () => f.line())), { code: 'INVALID_ITEMS' });
  assert.throws(() => f.sale(undefined, { note: 'x'.repeat(2001) }), { code: 'INVALID_NOTE' });
  assert.deepEqual(f.store.read(), before); f.store.close();
});
test('duplicate SKU manual sale writes one price event and restores actual preceding100', () => {
  const f = fixture();
  f.sale([f.line(1, 11000, { manualPrice: true }), f.line(2, 11000, { manualPrice: true })]);
  assert.equal(f.service.getStats().salesCents, 33000);
  assert.equal(f.store.read().priceEvents.length, 1);
  const q = f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  assert.equal(q.restorePriceCents, 10000);
  const restored = f.service.restorePrice({ operationId: op(), ...q, expectedVersion: q.version }, actor);
  assert.equal(restored.priceCents, 10000);
  assert.equal(f.service.getStats().salesCents, 33000); f.store.close();
});
test('duplicate SKU correction writes one price event; restoration100 and conflicting corrections roll back', () => {
  const f = fixture(); const original = f.sale([f.line(), f.line(2)]);
  const corrected = f.correct(original, original.items.map(row => ({ ...row, priceCents: 11000, priceVersion: 'p1' })));
  assert.equal(f.service.getStats().salesCents, 33000);
  assert.equal(f.store.read().priceEvents.length, 1);
  const q = f.service.quote({ customerId: 'C-A', skuId: 'SKU-S', unit: '箱' });
  assert.equal(q.restorePriceCents, 10000);
  f.service.restorePrice({ operationId: op(), ...q, expectedVersion: q.version }, actor);
  const current = f.service.quote(q); assert.equal(current.priceCents, 10000);
  const before = f.store.read();
  assert.throws(() => f.correct(corrected, corrected.items.map((row, index) => ({ ...row, priceCents: index ? 12000 : 13000, priceVersion: current.version }))), { code: 'CONFLICTING_MANUAL_PRICE' });
  assert.deepEqual(f.store.read(), before); f.store.close();
});
