import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../../src/shared/store.mjs';
import { createBusinessService } from '../../src/business/service.mjs';

const actor = { id: 'a07-synthetic-owner', role: 'boss', active: true };
const op = () => randomUUID();

function fixture(t, { testOnlyQuantityBypass = false } = {}) {
  const store = createStore();
  t.after(() => store.close());
  store.transact(state => {
    state.customers = [{ id: 'A', name: 'A07合成甲' }, { id: 'B', name: 'A07合成乙' }];
    state.products = [{ id: 'S', name: 'A07合成商品', units: ['箱', '瓶'], bottlesPerCase: 24, version: '1' }];
    state.prices[JSON.stringify(['A', 'S', '箱'])] = { priceCents: 10000, version: 'seed', source: 'SEED' };
    state.prices[JSON.stringify(['B', 'S', '箱'])] = { priceCents: 20000, version: 'seed', source: 'SEED' };
  });
  let tick = 0, documentFails = false, documentSaves = 0;
  const service = createBusinessService({ store,
    now: () => new Date(Date.UTC(2026, 10, 3, 0, 0, tick++)).toISOString(),
    // This fake receipt isolates transactions; it is not evidence of PNG rendering.
    documentStore: { save(order) {
      documentSaves += 1;
      if (documentFails) throw Error('A07 injected persistence failure');
      return { id: `a07-${order.id}-${order.revision}`, mimeType: 'image/png', sha256: 'a'.repeat(64), relativePath: 'synthetic.png' };
    } },
    // Explicit TEST ONLY bypass; no quantity policy has been approved for production.
    ...(testOnlyQuantityBypass ? { validateCustomerReturnQuantity() {} } : {}),
  });
  const quote = (customerId = 'A', unit = '箱') => service.quote({ customerId, skuId: 'S', unit });
  const returnQuote = (customerId = 'A', unit = '瓶') => service.returnQuote({ customerId, skuId: 'S', unit });
  function sale(priceCents = quote().priceCents, extra = {}) {
    const customerId = extra.customerId ?? 'A', unit = extra.unit ?? '箱';
    const q = quote(customerId, unit);
    return service.createSale({ operationId: op(), customerId, checked: true, mode: 'ELECTRONIC',
      items: [{ skuId: 'S', unit, quantity: extra.quantity ?? 1, priceCents,
        priceVersion: q.version, manualPrice: priceCents !== q.priceCents,
        ...(priceCents === 0 ? { zeroConfirmed: true } : {}) }] }, actor);
  }
  function correction(order, changes = {}) {
    return service.correctSale(order.id, { operationId: op(), customerId: order.customerId,
      expectedRevision: order.revision, items: order.items.map(line => ({ ...line,
        priceVersion: quote(order.customerId, line.unit).version, ...changes })) }, actor);
  }
  function returnInput(q = returnQuote(), extra = {}) {
    return { operationId: op(), returnBasis: 'CUSTOMER_HISTORY', checked: true, customerId: 'A',
      items: [{ skuId: 'S', unit: q.unit, quantity: 1, priceCents: q.priceCents,
        returnPriceVersion: q.version, ...(q.requiresPackagingConfirmation ? { packagingConfirmed: true } : {}) }], ...extra };
  }
  return { store, service, sale, correction, quote, returnQuote, returnInput,
    failDocument: value => { documentFails = value; }, documentSaves: () => documentSaves };
}

test('A07: maintained prices are not sales; bottle-only and zero sales do not invent a historical box price', t => {
  const f = fixture(t);
  f.service.savePrice({ operationId: op(), customerId: 'A', skuId: 'S', unit: '箱', expectedVersion: 'seed', priceCents: 11000 }, actor);
  assert.equal(f.returnQuote().source, 'MISSING');
  f.sale(500, { unit: '瓶' }); f.sale(0);
  assert.equal(f.returnQuote().priceCents, null);
  assert.equal(f.returnQuote('B').source, 'MISSING');
});

test('A07: quantity-only corrections keep the newer transaction as return price; price corrections supersede it', t => {
  const f = fixture(t), old = f.sale(10000), recent = f.sale(11000);
  const amendedQuantity = f.correction(old, { quantity: 3 });
  assert.equal(f.returnQuote().sourceOrderId, recent.id);
  const repriced = f.correction(amendedQuantity, { priceCents: 9000 });
  assert.equal(f.returnQuote().sourceOrderId, old.id);
  assert.equal(f.returnQuote().sourceRevision, repriced.revision);
  assert.equal(f.returnQuote().casePriceCents, 9000);
  assert.equal(f.returnQuote().priceCents, 380);
});

test('A07: corrected-away and zeroed sources cannot revive invalid snapshots or cross customer boundaries', t => {
  const f = fixture(t), old = f.sale(8000), newest = f.sale(10000);
  f.correction(newest, { priceCents: 0, zeroConfirmed: true });
  assert.equal(f.returnQuote().sourceOrderId, old.id);
  const fresh = f.sale(12000);
  f.service.correctSale(fresh.id, { operationId: op(), expectedRevision: 1, customerId: 'B',
    items: fresh.items.map(row => ({ ...row, priceVersion: f.quote('B').version })) }, actor);
  assert.equal(f.returnQuote().sourceOrderId, old.id);
  assert.equal(f.returnQuote('B').sourceOrderId, fresh.id);
});

test('A07: frozen packaging is stable; legacy fallback must be confirmed and its version changes with the master', t => {
  const f = fixture(t), frozen = f.sale(), before = f.returnQuote();
  f.store.transact(state => { Object.assign(state.products[0], { bottlesPerCase: 12, version: '2' }); });
  const frozenAfter = f.returnQuote();
  assert.equal(frozenAfter.priceCents, 420); assert.equal(frozenAfter.version, before.version);
  f.store.transact(state => {
    const order = state.orders.find(row => row.id === frozen.id);
    for (const snapshot of [order, ...order.revisions]) for (const line of snapshot.items) {
      delete line.bottlesPerCase; delete line.productVersion;
    }
  });
  const legacy = f.returnQuote();
  assert.equal(legacy.priceCents, 830); assert.equal(legacy.requiresPackagingConfirmation, true);
  assert.equal(legacy.packagingSource, 'CURRENT_MASTER_REQUIRES_CONFIRMATION');
  f.store.transact(state => { Object.assign(state.products[0], { bottlesPerCase: 24, version: '3' }); });
  const changed = f.returnQuote(); assert.equal(changed.priceCents, 420); assert.notEqual(changed.version, legacy.version);
  assert.equal(f.store.read().orders[0].items[0].bottlesPerCase, undefined);
});

test('A07: latest confirmed legacy transaction with multiple prices or packaging blocks instead of falling back', t => {
  for (const changed of [{ priceCents: 11000 }, { bottlesPerCase: 12 }]) {
    const f = fixture(t); f.sale(8000); const last = f.sale();
    f.store.transact(state => {
      const order = state.orders.find(row => row.id === last.id);
      for (const snapshot of [order, ...order.revisions]) {
        snapshot.items.push({ ...snapshot.items[0], lineId: 'a07-legacy-second-line', ...changed });
      }
    });
    const q = f.returnQuote(); assert.equal(q.source, 'AMBIGUOUS'); assert.equal(q.priceCents, null);
    assert.equal(q.sourceOrderId, last.id);
  }
});

test('A07: unresolved quantity policy rejects new saves atomically; old original-order returns remain compatible', t => {
  const f = fixture(t), order = f.sale(), before = f.store.read(), saves = f.documentSaves();
  assert.throws(() => f.service.createReturn(f.returnInput(), actor), { code: 'RETURN_QUANTITY_POLICY_UNCONFIRMED' });
  assert.deepEqual(f.store.read(), before); assert.equal(f.documentSaves(), saves);
  const old = f.service.createReturn({ operationId: op(), sourceOrderId: order.id,
    expectedSourceRevision: 1, items: [{ lineId: order.items[0].lineId, quantity: 1 }] }, actor);
  assert.equal(old.sourceOrderId, order.id); assert.equal(old.items[0].priceCents, 10000);
});

test('A07 TEST-ONLY quantity bypass: 100/24 produces 4.2 per bottle and 100.8 for 24; immutable evidence and one return event', t => {
  const f = fixture(t, { testOnlyQuantityBypass: true }); f.sale();
  const ordinaryPrice = f.quote(), q = f.returnQuote();
  const input = f.returnInput(q); input.items[0].quantity = 24; input.items[0].priceSource = { sourceOrderId: 'forged' };
  const returned = f.service.createReturn(input, actor), replay = f.service.createReturn(input, actor);
  assert.deepEqual(replay, returned); assert.equal(returned.totals.goodsCents, 10080);
  assert.equal(returned.sourceOrderId, undefined); assert.equal(returned.returnBasis, 'CUSTOMER_HISTORY');
  assert.deepEqual(returned.items[0].priceSource, q); assert.equal(returned.items[0].priceCents, 420);
  assert.equal(returned.revisions.length, 1); assert.equal(f.store.read().salesEvents.filter(event => event.type === 'RETURN').length, 1);
  assert.deepEqual(f.quote(), ordinaryPrice); assert.equal(f.store.read().printAttempts.length, 0);
  assert.equal(f.service.getStats().netSalesCents, -80);
  assert.throws(() => f.service.createReturn({ ...input, note: 'different content' }, actor), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('A07 TEST-ONLY quantity bypass: server rejects modified price, stale price version and unchecked packaging without side effects', t => {
  const f = fixture(t, { testOnlyQuantityBypass: true }); const sale = f.sale(); const q = f.returnQuote();
  let before = f.store.read();
  const tampered = f.returnInput(q); tampered.items[0].priceCents += 10;
  assert.throws(() => f.service.createReturn(tampered, actor), { code: 'RETURN_PRICE_MISMATCH' });
  assert.deepEqual(f.store.read(), before);
  f.correction(sale, { priceCents: 11000 }); before = f.store.read();
  assert.throws(() => f.service.createReturn(f.returnInput(q), actor), { code: 'RETURN_PRICE_VERSION_CONFLICT' });
  assert.deepEqual(f.store.read(), before);
  f.store.transact(state => { for (const snapshot of [state.orders[0], ...state.orders[0].revisions]) for (const row of snapshot.items) { delete row.bottlesPerCase; delete row.productVersion; } });
  const legacy = f.returnInput(); delete legacy.items[0].packagingConfirmed; before = f.store.read();
  assert.throws(() => f.service.createReturn(legacy, actor), { code: 'RETURN_PACKAGING_CONFIRMATION_REQUIRED' });
  assert.deepEqual(f.store.read(), before);
});

test('A07 TEST-ONLY quantity bypass: valid history that rounds to zero is accepted without overwriting normal future price', t => {
  const f = fixture(t, { testOnlyQuantityBypass: true }); f.sale(1);
  const q = f.returnQuote(); assert.equal(q.priceCents, 0); assert.equal(q.casePriceCents, 1);
  const current = f.quote(), returned = f.service.createReturn(f.returnInput(q), actor);
  assert.equal(returned.items[0].priceCents, 0); assert.equal(returned.totals.goodsCents, 0);
  assert.deepEqual(f.quote(), current);
});

test('A07 TEST-ONLY quantity bypass: failed document persistence rolls back the return and operation; same input can safely retry', t => {
  const f = fixture(t, { testOnlyQuantityBypass: true }); f.sale();
  const input = f.returnInput(), before = f.store.read(); f.failDocument(true);
  assert.throws(() => f.service.createReturn(input, actor), { code: 'DOCUMENT_FAILED' });
  assert.deepEqual(f.store.read(), before); f.failDocument(false);
  const returned = f.service.createReturn(input, actor);
  assert.equal(f.service.createReturn(input, actor).id, returned.id);
  assert.equal(f.store.read().salesEvents.filter(row => row.type === 'RETURN').length, 1);
});

function quoteHarness() {
  const source = readFileSync(new URL('../../web/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function beginRowQuoteRequest('), end = source.indexOf('function renderBillLine(', start);
  assert.ok(start > 0 && end > start, 'execute actual quote controller, not a duplicated implementation');
  const deferred = [];
  const context = vm.createContext({ URLSearchParams, route: 'orders', bill: { type: 'RETURN', customerId: 'A', items: [] },
    request(url) { return new Promise((resolve, reject) => deferred.push({ url, resolve, reject })); } });
  vm.runInContext(source.slice(start, end), context);
  return { context, deferred };
}

test('A07 actual UI controller: delayed old-customer response cannot overwrite current customer history or confirmation', async () => {
  const { context: c, deferred } = quoteHarness();
  const row = { skuId: 'S', unit: '瓶', price: '', packagingConfirmed: false }; c.bill.items = [row];
  const old = c.quoteBillLine(row, true); c.bill.customerId = 'B'; c.invalidateBillQuote(row);
  const latest = c.quoteBillLine(row, true);
  assert.match(deferred[0].url, /^\/api\/return-prices\?/); assert.match(deferred[1].url, /customerId=B/);
  deferred[1].resolve({ priceCents: 830, version: 'B-current' }); await latest;
  row.packagingConfirmed = true;
  deferred[0].resolve({ priceCents: 420, version: 'A-stale' }); await old;
  assert.equal(row.price, '8.30'); assert.equal(row.quote.version, 'B-current'); assert.equal(row.packagingConfirmed, true);
  assert.equal(row.quoteLoading, false);
});

test('A07 actual UI controller: refreshed same version preserves packaging confirmation; changed version clears it', async () => {
  const { context: c, deferred } = quoteHarness();
  const row = { skuId: 'S', unit: '瓶', price: '4.20', packagingConfirmed: true, quote: { priceCents: 420, version: 'same' } }; c.bill.items = [row];
  const same = c.quoteBillLine(row, true); deferred[0].resolve({ priceCents: 420, version: 'same' }); await same;
  assert.equal(row.packagingConfirmed, true);
  const changed = c.quoteBillLine(row, true); deferred[1].resolve({ priceCents: 830, version: 'changed' }); await changed;
  assert.equal(row.packagingConfirmed, false); assert.equal(row.price, '8.30');
});

test('A07 actual UI controller: explicit server unavailability disables and blocks new return saving while sales stay available', async () => {
  const source = readFileSync(new URL('../../web/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function customerReturnUnavailableReason('), end = source.indexOf('function beginCorrection(', start);
  assert.ok(start > 0 && end > start);
  const messages = [], mutations = [];
  const reason = '退货数量规则尚未确认，当前可核对预览，暂不能保存。';
  const c = vm.createContext({ bill: { type: 'RETURN', checked: true, items: [] },
    data: { customerHistoryReturn: { canSave: false, unavailableReason: reason } }, busy: false, pending: null,
    h: (tag, attributes, ...children) => ({ tag, attributes, children }),
    icon: () => null, notice: text => ({ tag: 'notice', text }), summary: () => null, estimateBill: () => ({}),
    showMessage: (...args) => messages.push(args), mutate: (...args) => mutations.push(args) });
  vm.runInContext(source.slice(start, end), c);
  function submitButton(node) {
    if (node?.tag === 'button' && node.attributes.type === 'submit') return node;
    for (const child of node?.children ?? []) { const match = submitButton(child); if (match) return match; }
    return null;
  }
  assert.equal(c.customerReturnUnavailableReason(), reason);
  const returnCard = c.renderSubmitCard();
  assert.equal(submitButton(returnCard).attributes.disabled, true);
  assert.ok(JSON.stringify(returnCard).includes(reason));
  await c.submitBill();
  assert.equal(mutations.length, 0); assert.equal(messages[0][0], reason); assert.equal(messages[0][1], true);
  c.bill.type = 'SALE';
  assert.equal(c.customerReturnUnavailableReason(), '');
  assert.equal(submitButton(c.renderSubmitCard()).attributes.disabled, false);
  c.bill.type = 'RETURN'; c.data.customerHistoryReturn.canSave = true;
  assert.equal(c.customerReturnUnavailableReason(), '');
  assert.equal(submitButton(c.renderSubmitCard()).attributes.disabled, false);
  c.data.customerHistoryReturn.canSave = false; c.data.customerHistoryReturn.unavailableReason = '';
  assert.equal(c.customerReturnUnavailableReason(), reason);
});
