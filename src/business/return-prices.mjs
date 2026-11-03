import { createHash } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';

const fail = (code, message) => { throw new DomainError(code, message, 400); };
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function packaging(line, product) {
  const frozen = line.bottlesPerCase != null;
  const bottlesPerCase = frozen ? line.bottlesPerCase : product.bottlesPerCase;
  if (!positiveInteger(bottlesPerCase)) fail('RETURN_PACKAGING_INVALID', '每箱瓶数无效，无法核对退货价格');
  return {
    bottlesPerCase,
    packagingSource: frozen ? 'SALE_SNAPSHOT' : 'CURRENT_MASTER_REQUIRES_CONFIRMATION',
    productVersion: frozen ? (line.productVersion == null ? null : String(line.productVersion)) : String(product.version ?? 1),
    requiresPackagingConfirmation: !frozen,
  };
}

function priceChanged(snapshot, previous, line) {
  if (snapshot.revision === 1) return true;
  // A missing older snapshot cannot establish that a correction changed price.
  if (!previous) return false;
  if (snapshot.customerId !== previous.customerId) return true;
  const before = previous.items?.find(row => row.lineId === line.lineId);
  return !before || before.skuId !== line.skuId || before.unit !== line.unit || before.priceCents !== line.priceCents;
}

/** Read-only historical return quote; ordinary customer price maintenance is not a sale. */
export function quoteReturnPriceIn(state, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '退货价格查询参数无效');
  const { customerId, skuId, unit } = input;
  const customer = state.customers.find(row => row.id === customerId);
  const product = state.products.find(row => row.id === skuId);
  if (!customer || !product || !['箱', '瓶'].includes(unit) || !product.units?.includes(unit)) {
    fail('INVALID_MASTER', '客户、商品或退货单位无效');
  }
  const empty = {
    customerId, skuId, unit, priceCents: null, version: 'missing', source: 'MISSING',
    sourceOrderId: null, sourceRevision: null, sourceLineId: null,
    priceConfirmedAt: null, casePriceCents: null, bottlesPerCase: null,
    packagingSource: null, productVersion: null, requiresPackagingConfirmation: false,
  };
  const sales = (state.salesEvents ?? []).map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'SALE' && Number.isFinite(Date.parse(event.createdAt)))
    .sort((a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt) || b.index - a.index);

  for (const { event } of sales) {
    const order = state.orders.find(row => row.id === event.orderId && row.type === 'SALE');
    if (!order || order.customerId !== customerId) continue;
    const snapshot = order.revisions?.find(row => row.revision === event.revision)
      ?? (order.revision === event.revision ? order : null);
    if (!snapshot || snapshot.customerId !== customerId || snapshot.type !== 'SALE') continue;
    const previous = order.revisions?.find(row => row.revision === snapshot.revision - 1);
    const candidates = (snapshot.items ?? []).flatMap(line => {
      if (line.skuId !== skuId || line.unit !== '箱' || !positiveInteger(line.priceCents)) return [];
      const current = order.items?.find(row => row.lineId === line.lineId);
      if (!current || current.skuId !== skuId || current.unit !== '箱' || current.priceCents !== line.priceCents) return [];
      if (!priceChanged(snapshot, previous, line)) return [];
      return [{ line, packaging: packaging(line, product) }];
    });
    if (!candidates.length) continue;
    const identity = {
      customerId, skuId, unit, eventId: event.id ?? null, sourceOrderId: order.id,
      sourceRevision: snapshot.revision, currentRevision: order.revision,
      priceConfirmedAt: event.createdAt,
      lines: candidates.map(({ line, packaging: pack }) => ({ lineId: line.lineId, casePriceCents: line.priceCents, ...pack })),
    };
    const version = `return:${digest(identity)}`;
    // Different packaging also makes a derived bottle price indeterminate.
    const distinct = new Set(candidates.map(({ line, packaging: pack }) => JSON.stringify([line.priceCents, pack.bottlesPerCase])));
    if (distinct.size > 1) return {
      ...empty, source: 'AMBIGUOUS', version, sourceOrderId: order.id,
      sourceRevision: snapshot.revision, priceConfirmedAt: event.createdAt,
    };
    const { line, packaging: pack } = candidates.at(-1);
    const divisor = BigInt(pack.bottlesPerCase) * 10n;
    const amount = unit === '箱' ? BigInt(line.priceCents)
      : (BigInt(line.priceCents) + divisor / 2n) / divisor * 10n;
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail('AMOUNT_OVERFLOW', '退货单价超出范围');
    return {
      customerId, skuId, unit, priceCents: Number(amount), version,
      source: unit === '箱' ? 'HISTORY_CASE' : 'HISTORY_CASE_DERIVED',
      sourceOrderId: order.id, sourceRevision: snapshot.revision,
      sourceLineId: line.lineId, priceConfirmedAt: event.createdAt,
      casePriceCents: line.priceCents, ...pack,
    };
  }
  return empty;
}
