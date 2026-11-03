import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createStore, createEmptyState } from '../../src/shared/store.mjs';
import { createBusinessService } from '../../src/business/index.mjs';
import { DomainError } from '../../src/shared/errors.mjs';

const actor = Object.freeze({ id: 'independent-owner', role: 'boss', active: true });
function cleanup(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('a07-'));
  rmSync(directory, { recursive: true, force: true });
}
const key = (customerId = 'A', skuId = 'S', unit = '箱') => JSON.stringify([customerId, skuId, unit]);
function fixture(t, options = {}) {
  const initialState = createEmptyState();
  initialState.customers = [{ id: 'A', name: '合成甲店' }, { id: 'B', name: '合成乙店' }];
  initialState.products = [{ id: 'S', name: '合成24瓶商品', units: ['箱', '瓶'], bottlesPerCase: 24 }];
  initialState.prices[key()] = { priceCents: 10000, version: 'initial-A', source: 'SYNTHETIC' };
  const store = createStore({ filename: options.filename ?? ':memory:', initialState });
  let failing = false;
  const snapshots = [];
  const documentStore = { save(snapshot) {
    if (failing) throw new Error('synthetic persistence failure');
    snapshots.push(structuredClone(snapshot));
    return { id: randomUUID(), mimeType: 'image/png', sha256: 'd'.repeat(64), relativePath: 'synthetic-not-real.png', createdAt: '2026-10-31T00:00:00Z' };
  } };
  const service = createBusinessService({ store, documentStore, now: () => '2026-10-31T00:00:00Z' });
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(close);
  return { store, service, snapshots, failDocuments: () => { failing = true; }, close };
}
function line(service, changes = {}, customerId = 'A') {
  const quote = service.quote({ customerId, skuId: 'S', unit: '箱' });
  return { skuId: 'S', unit: '箱', quantity: 1, priceCents: quote.priceCents, priceVersion: quote.version, ...changes };
}
function sale(service, changes = {}) {
  return { operationId: randomUUID(), customerId: 'A', mode: 'ELECTRONIC', checked: true, items: [line(service)], ...changes };
}
function rejectedUnchanged(store, command, code, status) {
  const before = store.read();
  assert.throws(command, error => {
    assert.ok(error instanceof DomainError, `expected DomainError, got ${error}`);
    if (code) assert.equal(error.code, code);
    if (status) assert.equal(error.status, status);
    return true;
  });
  assert.deepEqual(store.read(), before, 'Rejected command partially changed persisted business state');
}

test('A07 domain: unknown customer/SKU/unit cannot borrow another master or price', t => {
  const { store, service } = fixture(t);
  for (const changes of [{ customerId: 'unknown' }, { skuId: 'unknown' }, { unit: '托盘' }]) {
    assert.throws(() => service.quote({ customerId: 'A', skuId: 'S', unit: '箱', ...changes }), e => e.code === 'INVALID_MASTER');
  }
  assert.equal(service.quote({ customerId: 'B', skuId: 'S', unit: '箱' }).priceCents, null);
  rejectedUnchanged(store, () => service.createSale(sale(service, { customerId: 'B', items: [line(service)] }), actor), 'PRICE_VERSION_CONFLICT');
});

test('A07 domain: illegal integer quantity and money leave no partial order/price/event', t => {
  const { store, service } = fixture(t);
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    rejectedUnchanged(store, () => service.createSale(sale(service, { items: [line(service, { quantity })] }), actor), 'INVALID_NUMBER');
  }
  for (const priceCents of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10000', null]) {
    rejectedUnchanged(store, () => service.savePrice({ operationId: randomUUID(), customerId: 'A', skuId: 'S', unit: '箱', expectedVersion: 'initial-A', priceCents }, actor), 'INVALID_NUMBER');
  }
  rejectedUnchanged(store, () => service.createSale(sale(service, { items: [line(service, { quantity: Number.MAX_SAFE_INTEGER })] }), actor), 'AMOUNT_OVERFLOW');
});

test('A07 domain: role, active flag and actor-scoped replay are enforced in cloud service', t => {
  const { store, service } = fixture(t);
  const command = sale(service);
  for (const untrusted of [undefined, { role: 'staff', active: true }, { role: 'boss', active: false }, { isBoss: true, active: true }]) {
    rejectedUnchanged(store, () => service.createSale({ ...command, isBoss: true }, untrusted), 'FORBIDDEN', 403);
  }
  const result = service.createSale(command, actor);
  assert.equal(service.createSale(command, actor).id, result.id);
  rejectedUnchanged(store, () => service.createSale(command, { ...actor, id: 'another-actor' }), 'IDEMPOTENCY_CONFLICT', 409);
  rejectedUnchanged(store, () => service.createSale({ ...command, note: 'different' }, actor), 'IDEMPOTENCY_CONFLICT', 409);
  rejectedUnchanged(store, () => service.savePrice({ operationId: command.operationId, customerId: 'A', skuId: 'S', unit: '箱', expectedVersion: 'initial-A', priceCents: 10100 }, actor), 'IDEMPOTENCY_CONFLICT', 409);
});

test('A07 domain: manual edit still rejects stale price version, without reverting latest price', t => {
  const { store, service } = fixture(t);
  const old = sale(service, { items: [line(service, { manualPrice: true, priceCents: 9000 })] });
  service.savePrice({ operationId: 'new-price', customerId: 'A', skuId: 'S', unit: '箱', expectedVersion: 'initial-A', priceCents: 12000 }, actor);
  rejectedUnchanged(store, () => service.createSale(old, actor), 'PRICE_VERSION_CONFLICT', 409);
  assert.equal(service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 12000);
});

test('A07 domain: explicit zero sale and zero correction preserve the ordinary future price', t => {
  const { store, service } = fixture(t);
  rejectedUnchanged(store, () => service.createSale(sale(service, { items: [line(service, { priceCents: 0, manualPrice: true })] }), actor), 'ZERO_NOT_CONFIRMED');
  const zero = service.createSale(sale(service, { items: [line(service, { priceCents: 0, manualPrice: true, zeroConfirmed: true })] }), actor);
  assert.equal(zero.totals.goodsCents, 0);
  assert.equal(service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 10000);
  const normal = service.createSale(sale(service), actor);
  service.correctSale(normal.id, { operationId: 'correct-zero', expectedRevision: 1, customerId: 'A', items: [line(service, { lineId: normal.items[0].lineId, priceCents: 0, zeroConfirmed: true, manualPrice: true })] }, actor);
  assert.equal(service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 10000);
  assert.equal(store.read().priceEvents.length, 0);
});

test('A07 domain: positive correction changes future price, freezes history and reverses exactly once', t => {
  const { store, service } = fixture(t);
  const original = service.createSale(sale(service), actor);
  const originalSnapshot = structuredClone(original.revisions[0]);
  const command = { operationId: 'correction-90', expectedRevision: 1, customerId: 'A', items: [line(service, { lineId: original.items[0].lineId, priceCents: 9000, manualPrice: true })] };
  const corrected = service.correctSale(original.id, command, actor);
  assert.equal(service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 9000);
  assert.deepEqual(corrected.revisions[0], originalSnapshot);
  assert.equal(corrected.revisions.length, 2);
  assert.equal(service.getStats().netSalesCents, 9000);
  assert.equal(service.correctSale(original.id, command, actor).revision, 2);
  assert.equal(store.read().salesEvents.length, 3);
  rejectedUnchanged(store, () => service.correctSale(original.id, { ...command, operationId: 'stale-correction' }, actor), 'ORDER_VERSION_CONFLICT', 409);
  corrected.revisions[0].items[0].priceCents = 1;
  assert.equal(service.getOrder(original.id).revisions[0].items[0].priceCents, 10000);
});

test('A07 domain: original return ownership, units and price are enforced; partial cumulative over-return rejected', t => {
  const { store, service } = fixture(t);
  const original = service.createSale(sale(service, { items: [line(service, { quantity: 2 })] }), actor);
  const input = { operationId: 'return-one', sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 1 }] };
  for (const changed of [{ customerId: 'B' }, { items: [{ lineId: 'foreign-line', quantity: 1 }] }, { items: [{ ...input.items[0], unit: '瓶' }] }, { items: [{ ...input.items[0], priceCents: 20000 }] }]) {
    rejectedUnchanged(store, () => service.createReturn({ ...input, ...changed }, actor), 'RETURN_SOURCE_INVALID');
  }
  const returned = service.createReturn(input, actor);
  assert.equal(returned.items[0].priceCents, 10000);
  assert.equal(service.createReturn(input, actor).id, returned.id);
  rejectedUnchanged(store, () => service.createReturn({ ...input, operationId: 'return-too-many', items: [{ ...input.items[0], quantity: 2 }] }, actor), 'RETURN_OVER_LIMIT', 409);
  assert.equal(service.getStats().netSalesCents, 10000);
  assert.equal(service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 10000);
});

test('A07 domain: existing return plus quantity correction has exact net zero; below returned rejected', t => {
  const { store, service } = fixture(t);
  const original = service.createSale(sale(service, { items: [line(service, { quantity: 2 })] }), actor);
  service.createReturn({ operationId: 'ret', sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 1 }] }, actor);
  const corrected = service.correctSale(original.id, { operationId: 'quantity-fix', expectedRevision: 1, customerId: 'A', items: [line(service, { lineId: original.items[0].lineId, quantity: 1 })] }, actor);
  assert.equal(service.getStats().netSalesCents, 0);
  rejectedUnchanged(store, () => service.createReturn({ operationId: 'extra', sourceOrderId: original.id, expectedSourceRevision: corrected.revision, items: [{ lineId: original.items[0].lineId, quantity: 1 }] }, actor), 'RETURN_OVER_LIMIT');
  rejectedUnchanged(store, () => service.correctSale(original.id, { operationId: 'price-fix-after-return', expectedRevision: 2, customerId: 'A', items: [line(service, { lineId: original.items[0].lineId, priceCents: 8000, manualPrice: true })] }, actor), 'RETURN_CORRECTION_UNSUPPORTED');
  const other = fixture(t);
  const full = other.service.createSale(sale(other.service, { items: [line(other.service, { quantity: 2 })] }), actor);
  other.service.createReturn({ operationId: 'return-both', sourceOrderId: full.id, expectedSourceRevision: 1, items: [{ lineId: full.items[0].lineId, quantity: 2 }] }, actor);
  rejectedUnchanged(other.store, () => other.service.correctSale(full.id, { operationId: 'less-than-returned', expectedRevision: 1, customerId: 'A', items: [line(other.service, { lineId: full.items[0].lineId, quantity: 1 })] }, actor), 'BELOW_RETURNED_QUANTITY', 409);
});

test('A07 domain: document failure rolls back sale, correction and return including prices and operation IDs', t => {
  const first = fixture(t);
  first.failDocuments();
  rejectedUnchanged(first.store, () => first.service.createSale(sale(first.service, { items: [line(first.service, { priceCents: 12000, manualPrice: true })] }), actor), 'DOCUMENT_FAILED');
  const second = fixture(t);
  const original = second.service.createSale(sale(second.service, { items: [line(second.service, { quantity: 2 })] }), actor);
  second.failDocuments();
  rejectedUnchanged(second.store, () => second.service.correctSale(original.id, { operationId: 'failed-correction', expectedRevision: 1, customerId: 'A', items: [line(second.service, { lineId: original.items[0].lineId, priceCents: 12000, manualPrice: true })] }, actor), 'DOCUMENT_FAILED');
  rejectedUnchanged(second.store, () => second.service.createReturn({ operationId: 'failed-return', sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 1 }] }, actor), 'DOCUMENT_FAILED');
});

test('A07 domain: duplicate SKU manual price lines produce one price event and one recoverable before-price', t => {
  const { store, service } = fixture(t);
  const changed = line(service, { priceCents: 11000, manualPrice: true });
  service.createSale(sale(service, { items: [changed, { ...changed }] }), actor);
  const quote = service.quote({ customerId: 'A', skuId: 'S', unit: '箱' });
  assert.equal(quote.restorePriceCents, 10000, 'a single confirmation must retain price before that confirmation');
  assert.equal(store.read().priceEvents.length, 1, 'same price key in one command must update once');
});

test('A07 domain: duplicate SKU corrected price lines update only once and recover true old price', t => {
  const { store, service } = fixture(t);
  const original = service.createSale(sale(service, { items: [line(service), line(service)] }), actor);
  service.correctSale(original.id, { operationId: 'two-row-correction', expectedRevision: 1, customerId: 'A', items: original.items.map(row => line(service, { lineId: row.lineId, priceCents: 9000, manualPrice: true })) }, actor);
  const quote = service.quote({ customerId: 'A', skuId: 'S', unit: '箱' });
  assert.equal(quote.restorePriceCents, 10000);
  assert.equal(store.read().priceEvents.length, 1);
});

test('A07 persistence: restart retains operation result, frozen revisions, return quota and future price', t => {
  const directory = mkdtempSync(join(tmpdir(), 'a07-business-'));
  t.after(() => cleanup(directory));
  const filename = join(directory, 'business.sqlite');
  const first = fixture(t, { filename });
  const command = sale(first.service, { items: [line(first.service, { quantity: 2, priceCents: 11000, manualPrice: true })] });
  const original = first.service.createSale(command, actor);
  first.service.createReturn({ operationId: 'ret-persist', sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 1 }] }, actor);
  first.close();
  const second = fixture(t, { filename });
  assert.equal(second.service.createSale(command, actor).id, original.id);
  assert.equal(second.service.quote({ customerId: 'A', skuId: 'S', unit: '箱' }).priceCents, 11000);
  assert.equal(second.service.getStats().netSalesCents, 11000);
  rejectedUnchanged(second.store, () => second.service.createReturn({ operationId: 'over-after-restart', sourceOrderId: original.id, expectedSourceRevision: 1, items: [{ lineId: original.items[0].lineId, quantity: 2 }] }, actor), 'RETURN_OVER_LIMIT');
  second.close();
});
