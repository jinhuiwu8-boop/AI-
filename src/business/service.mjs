import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';
import { queryOrdersIn, periodStatsIn } from './masters.mjs';
import { quoteReturnPriceIn } from './return-prices.mjs';

const clone = value => structuredClone(value);
const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
const canonical = value => JSON.stringify(value, function (key, item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]]));
  return item;
});
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const keyFor = (customerId, skuId, unit) => JSON.stringify([customerId, skuId, unit]);
const integer = (value, label, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_NUMBER', `${label}必须为安全整数且不小于${min}`);
  return value;
};
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('AMOUNT_OVERFLOW', '金额超出范围'); return Number(value); };
const roundDime = cents => safe((BigInt(cents) + 5n) / 10n * 10n);

export function createBusinessService({ store, documentStore, now = () => new Date().toISOString(), validateCustomerReturnQuantity = null }) {
  const boss = actor => { if (actor?.role !== 'boss' || actor.active !== true) fail('FORBIDDEN', '仅当前授权老板可操作', 403); };
  function master(state, customerId, skuId, unit) {
    const customer = state.customers.find(c => c.id === customerId);
    const product = state.products.find(p => p.id === skuId);
    if (!customer || !product || !product.units.includes(unit)) fail('INVALID_MASTER', '客户、商品或计价单位无效');
    return { customer, product };
  }
  function quoteIn(state, input) {
    if (!input || typeof input !== 'object') fail('INVALID_INPUT', '价格查询参数无效');
    const { customerId, skuId, unit } = input;
    const { product } = master(state, customerId, skuId, unit);
    const entry = state.prices[keyFor(customerId, skuId, unit)];
    if (entry) return { customerId, skuId, unit, priceCents: entry.priceCents, version: String(entry.version), source: entry.source ?? 'MANUAL', canRestore: entry.restorePriceCents != null, restorePriceCents: entry.restorePriceCents ?? null };
    const box = unit === '瓶' && state.prices[keyFor(customerId, skuId, '箱')];
    if (box) {
      integer(product.bottlesPerCase, '包装瓶数', 1);
      const divisor = BigInt(product.bottlesPerCase) * 10n;
      const priceCents = safe((BigInt(box.priceCents) + divisor / 2n) / divisor * 10n);
      return { customerId, skuId, unit, priceCents, version: `derived:${box.version}:${product.bottlesPerCase}`, source: 'CASE_DERIVED', canRestore: false, restorePriceCents: null };
    }
    return { customerId, skuId, unit, priceCents: null, version: 'missing', source: 'MISSING', canRestore: false, restorePriceCents: null };
  }
  function putPrice(state, input, source, restore = false) {
    const current = quoteIn(state, input);
    const event = { id: randomUUID(), customerId: input.customerId, skuId: input.skuId, unit: input.unit, priceCents: input.priceCents, previousPriceCents: current.priceCents, source, createdAt: now() };
    state.priceEvents.push(event);
    state.prices[keyFor(input.customerId, input.skuId, input.unit)] = { priceCents: input.priceCents, version: event.id, source, restorePriceCents: restore ? null : current.priceCents };
    return quoteIn(state, input);
  }
  function write(type, input, actor, execute) {
    boss(actor);
    if (!input || typeof input.operationId !== 'string' || !input.operationId.trim()) fail('OPERATION_REQUIRED', '缺少操作ID');
    const signature = hash({ type, input, actorId: actor.id ?? 'boss' });
    return store.transact(state => {
      const old = state.operations[input.operationId];
      if (old) {
        if (old.signature !== signature) fail('IDEMPOTENCY_CONFLICT', '同操作ID不能改变内容或操作人', 409);
        return clone(old.result);
      }
      const result = execute(state);
      state.operations[input.operationId] = { signature, result: clone(result) };
      return clone(result);
    });
  }
  function lines(state, input, previous, checkPrices = true) {
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) fail('INVALID_ITEMS', '商品明细必须为1至100行');
    const ids = new Set();
    return input.items.map(item => {
      if (!item || typeof item !== 'object') fail('INVALID_INPUT', '商品明细无效');
      const { product } = master(state, input.customerId, item.skuId, item.unit);
      integer(item.quantity, '数量', 1); integer(item.priceCents, '单价');
      if (item.priceCents === 0 && item.zeroConfirmed !== true) fail('ZERO_NOT_CONFIRMED', '零价须人工明确确认');
      const q = quoteIn(state, { ...item, customerId: input.customerId });
      if (checkPrices && item.priceVersion !== q.version) fail('PRICE_VERSION_CONFLICT', '价格已变化，请重新核对', 409);
      if (item.manualPrice !== true && item.priceCents !== q.priceCents && checkPrices) fail('PRICE_MISMATCH', '单价与来源不一致');
      const lineId = item.lineId ?? previous?.[input.items.indexOf(item)]?.lineId ?? randomUUID();
      if (ids.has(lineId)) fail('DUPLICATE_LINE', '明细行重复'); ids.add(lineId);
      const prior = previous?.find(row => row.lineId === lineId && row.skuId === item.skuId);
      const packaging = prior ? Object.fromEntries(['bottlesPerCase', 'productVersion'].filter(key => prior[key] != null).map(key => [key, prior[key]]))
        : { bottlesPerCase: integer(product.bottlesPerCase, '包装瓶数', 1), productVersion: String(product.version ?? 1) };
      return { lineId, skuId: item.skuId, productName: product.name, unit: item.unit, quantity: item.quantity, priceCents: item.priceCents, lineAmountCents: safe(BigInt(item.quantity) * BigInt(item.priceCents)), manualPrice: item.manualPrice === true, zeroConfirmed: item.zeroConfirmed === true, ...packaging };
    });
  }
  function totals(items, creditCents = 0, waiverCents = 0) {
    integer(creditCents, '抵扣'); integer(waiverCents, '抹零');
    const goodsCents = safe(items.reduce((sum, row) => sum + BigInt(row.lineAmountCents), 0n));
    const raw = safe(BigInt(goodsCents) - BigInt(creditCents) - BigInt(waiverCents));
    if (raw < 0) fail('EXCESS_ADJUSTMENT', '抵扣与抹零不得超过货款');
    const receivableCents = roundDime(raw);
    return { goodsCents, creditCents, waiverCents, receivableCents, roundingCents: receivableCents - raw };
  }
  function note(input) {
    if (input.note != null && (typeof input.note !== 'string' || input.note.length > 2000)) fail('INVALID_NOTE', '备注必须为不超过2000字符的文本');
    return input.note ?? '';
  }
  function document(order) {
    try {
      const result = documentStore.save(clone(order));
      if (!result?.id || result.mimeType !== 'image/png' || !result.sha256 || !result.relativePath) fail('DOCUMENT_FAILED', '正式图片持久保存回执无效');
      return result;
    } catch (error) { if (error instanceof DomainError) throw error; fail('DOCUMENT_FAILED', '正式图片保存失败', 503); }
  }
  function event(state, type, order, amountCents = order.totals.goodsCents, receivableCents = order.totals.receivableCents) {
    state.salesEvents.push({ id: randomUUID(), type, orderId: order.id, revision: order.revision, customerId: order.customerId, amountCents, receivableCents, createdAt: now() });
  }
  const returned = (state, orderId, lineId) => state.orders.filter(o => o.type === 'RETURN' && o.sourceOrderId === orderId).flatMap(o => o.items).filter(row => row.sourceLineId === lineId).reduce((sum, row) => sum + row.quantity, 0);
  function orderIn(state, id) { const order = state.orders.find(o => o.id === id); if (!order) fail('NOT_FOUND', '订单不存在', 404); return order; }
  function snapshot(order) { const { revisions, ...rest } = order; return clone(rest); }
  function reviewJob(state, input) {
    if (input.sourceJobId == null && input.candidateVersion == null) return null;
    if (typeof input.sourceJobId !== 'string' || !input.sourceJobId.trim() || typeof input.candidateVersion !== 'string' || !input.candidateVersion.trim()) fail('INVALID_REVIEW_SOURCE', '识别确认须携带任务ID和候选版本');
    const job = state.edgeJobs.find(row => row.id === input.sourceJobId);
    if (!job) fail('NOT_FOUND', '识别任务不存在', 404);
    if (job.status !== 'AWAITING_REVIEW' || job.reviewOrderId || job.candidateVersion !== input.candidateVersion) fail('REVIEW_VERSION_CONFLICT', '识别任务已确认或候选版本已变化', 409);
    if (!job.candidate || !Array.isArray(job.candidate.items)) fail('INVALID_REVIEW_SOURCE', '识别候选无效，请重新读取');
    return job;
  }
  function consumeReview(state, job, order) {
    if (!job) return;
    const confirmed = { customerId: order.customerId, items: order.items.map(row => ({ skuId: row.skuId, unit: row.unit, quantity: row.quantity })) };
    const original = { customerId: job.candidate.customerId, items: job.candidate.items.map(row => ({ skuId: row.skuId, unit: row.unit, quantity: row.quantity })) };
    const recognitionKey = value => canonical({ customerId: value.customerId, items: value.items.map(row => canonical(row)).sort() });
    if (recognitionKey(original) !== recognitionKey(confirmed)) {
      const sample = { id: randomUUID(), jobId: job.id, orderId: order.id, orderRevision: order.revision, candidateVersion: job.candidateVersion, originalCandidate: clone(job.candidate), confirmed, status: 'RECORDED', createdAt: now() };
      if (typeof job.modelVersion === 'string') sample.modelVersion = job.modelVersion;
      state.correctionSamples ??= [];
      state.correctionSamples.push(sample);
    }
    job.status = 'REVIEWED'; job.reviewOrderId = order.id; job.reviewedAt = now();
  }
  function customerReturn(state, input) {
    if (input.checked !== true) fail('NOT_CHECKED', '请先核对退货客户、商品、数量和历史价格');
    if (input.sourceOrderId != null || input.expectedSourceRevision != null) fail('RETURN_SOURCE_INVALID', '客户退货不绑定原销售单');
    const customer = state.customers.find(row => row.id === input.customerId);
    if (!customer) fail('INVALID_MASTER', '退货客户不存在');
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) fail('INVALID_ITEMS', '退货明细必须为1至100行');
    const items = input.items.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('INVALID_INPUT', '退货明细无效');
      integer(row.quantity, '退货数量', 1);
      const q = quoteReturnPriceIn(state, { customerId: customer.id, skuId: row.skuId, unit: row.unit });
      if (q.source === 'AMBIGUOUS') fail('RETURN_PRICE_AMBIGUOUS', '最近历史开单存在不同箱价或包装，请先核对历史单');
      if (q.priceCents == null) fail('RETURN_HISTORY_MISSING', '没有该客户此商品的非零历史箱价，不能自动确定退货价');
      if (row.returnPriceVersion !== q.version) fail('RETURN_PRICE_VERSION_CONFLICT', '退货历史价格或包装已变化，请重新核对', 409);
      integer(row.priceCents, '退货单价');
      if (row.priceCents !== q.priceCents) fail('RETURN_PRICE_MISMATCH', '退货必须沿用已核对的历史成交价');
      if (q.requiresPackagingConfirmation && row.packagingConfirmed !== true) fail('RETURN_PACKAGING_CONFIRMATION_REQUIRED', '旧历史单未记录包装，请明确核对每箱瓶数');
      const { product } = master(state, customer.id, row.skuId, row.unit);
      return { lineId: randomUUID(), skuId: row.skuId, productName: product.name, unit: row.unit,
        quantity: row.quantity, priceCents: q.priceCents, lineAmountCents: safe(BigInt(row.quantity) * BigInt(q.priceCents)),
        bottlesPerCase: q.bottlesPerCase, productVersion: q.productVersion,
        priceSource: clone(q), packagingConfirmed: q.requiresPackagingConfirmation ? true : false };
    });
    if (typeof validateCustomerReturnQuantity !== 'function') fail('RETURN_QUANTITY_POLICY_UNCONFIRMED', '退货数量规则尚未确认，当前可核对预览，暂不能保存。', 409);
    const result = validateCustomerReturnQuantity(clone(state), customer.id, clone(items));
    if (result && typeof result.then === 'function') fail('INVALID_RETURN_POLICY', '退货数量校验必须同步完成', 500);
    const order = { id: randomUUID(), type: 'RETURN', returnBasis: 'CUSTOMER_HISTORY', customerId: customer.id,
      customerName: customer.name, customerAddress: customer.address ?? '', mode: 'ELECTRONIC', revision: 1,
      createdAt: now(), items, totals: totals(items), note: note(input), document: null, revisions: [] };
    order.document = document(order); order.revisions.push(snapshot(order)); state.orders.push(order); event(state, 'RETURN', order);
    return order;
  }
  return {
    quote(input) { return clone(quoteIn(store.read(), input)); },
    returnQuote(input) { return clone(quoteReturnPriceIn(store.read(), input)); },
    savePrice(input, actor) { return write('SAVE_PRICE', input, actor, state => {
      integer(input.priceCents, '客户价', 1);
      const q = quoteIn(state, input);
      if (q.version !== input.expectedVersion) fail('PRICE_VERSION_CONFLICT', '价格已变化', 409);
      return putPrice(state, input, 'CUSTOMER_MANUAL');
    }); },
    restorePrice(input, actor) { return write('RESTORE_PRICE', input, actor, state => {
      const q = quoteIn(state, input);
      if (q.version !== input.expectedVersion) fail('PRICE_VERSION_CONFLICT', '价格已变化', 409);
      if (!q.canRestore) fail('NO_RESTORE_POINT', '没有可恢复的前价');
      return putPrice(state, { ...input, priceCents: q.restorePriceCents }, 'RESTORE', true);
    }); },
    createSale(input, actor) { return write('CREATE_SALE', input, actor, state => {
      if (input.checked !== true || !['ELECTRONIC', 'PAPER'].includes(input.mode)) fail('NOT_CHECKED', '请核对并选择开单方式');
      const job = reviewJob(state, input);
      const customer = state.customers.find(c => c.id === input.customerId);
      if (!customer) fail('INVALID_MASTER', '客户不存在');
      const items = lines(state, input);
      const updates = new Map();
      for (const row of items.filter(row => row.manualPrice && row.priceCents > 0)) {
        const key = keyFor(customer.id, row.skuId, row.unit);
        if (updates.has(key) && updates.get(key) !== row.priceCents) fail('CONFLICTING_MANUAL_PRICE', '同商品单位的人工价不一致，请核对');
        updates.set(key, row.priceCents);
      }
      const order = { id: randomUUID(), type: 'SALE', customerId: customer.id, customerName: customer.name, customerAddress: customer.address ?? '', mode: input.mode, createdAt: now(), revision: 1, items, totals: totals(items, input.creditCents, input.waiverCents), note: note(input), document: null, revisions: [] };
      if (job) { order.sourceJobId = job.id; order.candidateVersion = job.candidateVersion; }
      if (order.mode === 'ELECTRONIC') order.document = document(order);
      const writtenPrices = new Set();
      for (const row of items) if (row.manualPrice && row.priceCents > 0) {
        const key = keyFor(customer.id, row.skuId, row.unit);
        if (!writtenPrices.has(key)) { putPrice(state, { customerId: customer.id, ...row }, 'ORDER_MANUAL'); writtenPrices.add(key); }
      }
      order.revisions.push(snapshot(order)); state.orders.push(order); event(state, 'SALE', order);
      consumeReview(state, job, order);
      if (order.mode === 'PAPER') state.printAttempts.push({ id: randomUUID(), orderId: order.id, revision: 1, status: 'PENDING_DEVICE', copies: 1, createdAt: now() });
      return order;
    }); },
    correctSale(orderId, input, actor) { return write('CORRECT_SALE', { ...input, orderId }, actor, state => {
      const old = orderIn(state, orderId);
      if (old.type !== 'SALE' || old.revision !== input.expectedRevision) fail('ORDER_VERSION_CONFLICT', '销售版本已变化', 409);
      const customer = state.customers.find(c => c.id === input.customerId);
      if (!customer) fail('INVALID_MASTER', '客户不存在');
      const items = lines(state, input, old.items, false);
      const returns = state.orders.filter(o => o.type === 'RETURN' && o.sourceOrderId === orderId);
      if (returns.length) {
        if (old.customerId !== input.customerId || (input.creditCents ?? 0) !== old.totals.creditCents || (input.waiverCents ?? 0) !== old.totals.waiverCents) fail('RETURN_CORRECTION_UNSUPPORTED', '已退货销售暂不支持归属或抵扣更正', 409);
        for (const row of old.items) {
          const quantity = returned(state, orderId, row.lineId);
          const next = items.find(i => i.lineId === row.lineId);
          if (quantity && (!next || next.quantity < quantity)) fail('BELOW_RETURNED_QUANTITY', '更正数量不能少于已退数量', 409);
          if (next && (next.skuId !== row.skuId || next.unit !== row.unit || next.priceCents !== row.priceCents)) fail('RETURN_CORRECTION_UNSUPPORTED', '已退货销售暂不支持价格或单位更正', 409);
        }
        if (items.some(row => !old.items.some(o => o.lineId === row.lineId))) fail('RETURN_CORRECTION_UNSUPPORTED', '已退货销售仅支持原行数量更正', 409);
      }
      const priceUpdates = items.filter(row => {
        const previous = old.items.find(item => item.lineId === row.lineId);
        return row.priceCents > 0 && (!previous || old.customerId !== customer.id || previous.skuId !== row.skuId || previous.unit !== row.unit || previous.priceCents !== row.priceCents);
      });
      const prices = new Map();
      for (const row of priceUpdates) {
        const commandRow = input.items[items.indexOf(row)];
        const q = quoteIn(state, { customerId: customer.id, skuId: row.skuId, unit: row.unit });
        if (commandRow?.priceVersion !== q.version) fail('PRICE_VERSION_CONFLICT', '更正价源已变化，请重新核对', 409);
        const key = keyFor(customer.id, row.skuId, row.unit);
        if (prices.has(key) && prices.get(key) !== row.priceCents) fail('CONFLICTING_MANUAL_PRICE', '同商品单位的更正价格不一致');
        prices.set(key, row.priceCents);
      }
      const next = { ...old, customerId: customer.id, customerName: customer.name, customerAddress: customer.address ?? '', revision: old.revision + 1, items, totals: totals(items, input.creditCents, input.waiverCents), note: note(input), correctedAt: now(), document: null, revisions: clone(old.revisions) };
      if (next.mode === 'ELECTRONIC') next.document = document(snapshot(next));
      const writtenPrices = new Set();
      for (const row of priceUpdates) {
        const key = keyFor(customer.id, row.skuId, row.unit);
        if (!writtenPrices.has(key)) { putPrice(state, { customerId: customer.id, ...row }, 'CORRECTION_MANUAL'); writtenPrices.add(key); }
      }
      event(state, 'REVERSAL', old, -old.totals.goodsCents, -old.totals.receivableCents); event(state, 'SALE', next);
      next.revisions.push(snapshot(next)); state.orders[state.orders.indexOf(old)] = next;
      return next;
    }); },
    createReturn(input, actor) { return write('CREATE_RETURN', input, actor, state => {
      if (input.returnBasis === 'CUSTOMER_HISTORY') return customerReturn(state, input);
      if (input.returnBasis != null && input.returnBasis !== 'ORIGINAL_ORDER') fail('RETURN_SOURCE_INVALID', '退货方式无效');
      const source = orderIn(state, input.sourceOrderId);
      if (source.type !== 'SALE' || source.revision !== input.expectedSourceRevision) fail('ORDER_VERSION_CONFLICT', '原销售版本无效', 409);
      if (source.totals.creditCents || source.totals.waiverCents) fail('RETURN_ADJUSTMENT_UNSUPPORTED', '含抵扣或抹零的原单暂不支持退货');
      if (input.customerId && input.customerId !== source.customerId) fail('RETURN_SOURCE_INVALID', '退货客户必须属于原单');
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail('INVALID_ITEMS', '退货明细必须为1至100行');
      const seen = new Set();
      const items = input.items.map(row => {
        if (!row || typeof row !== 'object') fail('INVALID_INPUT', '退货明细无效');
        if (seen.has(row.lineId)) fail('DUPLICATE_LINE', '退货行重复'); seen.add(row.lineId);
        const original = source.items.find(i => i.lineId === row.lineId);
        if (!original) fail('RETURN_SOURCE_INVALID', '退货行不属于原销售');
        if ((row.unit && row.unit !== original.unit) || (row.customerId && row.customerId !== source.customerId) || (row.priceCents != null && row.priceCents !== original.priceCents)) fail('RETURN_SOURCE_INVALID', '退货必须沿用原客户、单位和单价');
        integer(row.quantity, '退货数量', 1);
        if (BigInt(row.quantity) + BigInt(returned(state, source.id, original.lineId)) > BigInt(original.quantity)) fail('RETURN_OVER_LIMIT', '累计退货超过原销售数量', 409);
        return { ...original, lineId: randomUUID(), sourceLineId: original.lineId, sourceRevision: source.revision, quantity: row.quantity, lineAmountCents: safe(BigInt(row.quantity) * BigInt(original.priceCents)) };
      });
      const order = { id: randomUUID(), type: 'RETURN', sourceOrderId: source.id, sourceRevision: source.revision, customerId: source.customerId, customerName: source.customerName, mode: 'ELECTRONIC', revision: 1, createdAt: now(), items, totals: totals(items), note: note(input), document: null, revisions: [] };
      order.document = document(order); order.revisions.push(snapshot(order)); state.orders.push(order); event(state, 'RETURN', order); return order;
    }); },
    listOrders() { return clone(store.read().orders); },
    queryOrders(input) { return queryOrdersIn(store.read(), input); },
    getPeriodStats(input) { return clone(periodStatsIn(store.read(), input)); },
    getOrder(id) { return clone(orderIn(store.read(), id)); },
    getStats() {
      const state = store.read(); let sales = 0n, returns = 0n, receivable = 0n;
      for (const row of state.salesEvents) {
        if (row.type === 'RETURN') { returns += BigInt(row.amountCents); receivable -= BigInt(row.receivableCents); }
        else { sales += BigInt(row.amountCents); receivable += BigInt(row.receivableCents); }
      }
      return { salesCents: safe(sales), returnCents: safe(returns), netSalesCents: safe(sales - returns), receivableCents: safe(receivable), orderCount: state.orders.filter(o => o.type === 'SALE').length, returnCount: state.orders.filter(o => o.type === 'RETURN').length };
    }
  };
}
