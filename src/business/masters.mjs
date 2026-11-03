import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from '../shared/errors.mjs';

const clone = value => structuredClone(value);
const fail = (code, message, status = 400) => { throw new DomainError(code, message, status); };
const canonical = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('INVALID_MASTER', `${label}必须为${required ? '非空且' : ''}不超过${max}字符的文本`);
  return value.trim();
}
function version(value) { return String(value.version ?? 1); }
function safe(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) fail('AMOUNT_OVERFLOW', '统计金额超出范围');
  return Number(value);
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) fail('INVALID_DATE', '日期必须为有效的YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('INVALID_DATE', '日期不存在');
  return value;
}
function boundary(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_DATE', `${label}日期无效`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${validDay(value)}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('INVALID_DATE', `${label}须为YYYY-MM-DD或带时区的ISO时间`);
  validDay(value.slice(0, 10));
  const stamp = Date.parse(value);
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (!Number.isFinite(stamp) || hour > 23 || minute > 59 || second > 59) fail('INVALID_DATE', `${label}时间无效`);
  return stamp;
}

export function queryOrdersIn(state, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_QUERY', '查询参数无效');
  const { customerId, type } = input;
  if (customerId != null && (typeof customerId !== 'string' || !customerId.trim())) fail('INVALID_QUERY', '客户筛选无效');
  if (type != null && !['SALE', 'RETURN'].includes(type)) fail('INVALID_QUERY', '单据类型须为SALE或RETURN');
  const from = boundary(input.from, '开始'), to = boundary(input.to, '结束');
  if (from != null && to != null && from > to) fail('INVALID_DATE_RANGE', '开始日期不能晚于结束日期');
  return clone(state.orders.filter(order => {
    const stamp = Date.parse(order.createdAt);
    return (!customerId || order.customerId === customerId) && (!type || order.type === type)
      && (from == null || stamp >= from) && (to == null || stamp < to);
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)));
}

export function periodStatsIn(state, { period, date } = {}) {
  let from, to;
  if (period === 'day') {
    validDay(date);
    from = Date.parse(`${date}T00:00:00+08:00`); to = from + 86400000;
  } else if (period === 'month') {
    if (typeof date !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(date) || date.startsWith('0000-')) fail('INVALID_DATE', '月份必须为有效的YYYY-MM');
    from = Date.parse(`${date}-01T00:00:00+08:00`);
    const next = new Date(`${date}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
    to = next.getTime() - 8 * 3600000;
  } else fail('INVALID_PERIOD', '统计周期须为day或month');
  let gross = 0n, reversals = 0n, returns = 0n, receivable = 0n;
  const saleOrders = new Set(), returnOrders = new Set();
  const eventCounts = { sale: 0, reversal: 0, return: 0 };
  for (const row of state.salesEvents) {
    const stamp = Date.parse(row.createdAt);
    if (!(stamp >= from && stamp < to)) continue;
    if (row.type === 'SALE') { gross += BigInt(row.amountCents); receivable += BigInt(row.receivableCents); saleOrders.add(row.orderId); eventCounts.sale++; }
    else if (row.type === 'REVERSAL') { reversals -= BigInt(row.amountCents); receivable += BigInt(row.receivableCents); eventCounts.reversal++; }
    else if (row.type === 'RETURN') { returns += BigInt(row.amountCents); receivable -= BigInt(row.receivableCents); returnOrders.add(row.orderId); eventCounts.return++; }
  }
  return {
    period, date, timeZone: 'Asia/Shanghai', from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    saleGrossCents: safe(gross), reversalCents: safe(reversals), salesCents: safe(gross - reversals),
    returnCents: safe(returns), netSalesCents: safe(gross - reversals - returns), receivableCents: safe(receivable),
    orderCount: saleOrders.size, returnCount: returnOrders.size, eventCounts,
  };
}

export function createMasterDataService({ store, now = () => new Date().toISOString() }) {
  function write(type, input, actor, execute) {
    if (actor?.role !== 'boss' || actor.active !== true) fail('FORBIDDEN', '仅当前授权老板可操作', 403);
    if (!input || typeof input.operationId !== 'string' || !input.operationId.trim()) fail('OPERATION_REQUIRED', '缺少操作ID');
    const signature = createHash('sha256').update(canonical({ type, input, actorId: actor.id ?? 'boss' })).digest('hex');
    return store.transact(state => {
      const old = Object.hasOwn(state.operations, input.operationId) && state.operations[input.operationId];
      if (old) {
        if (old.signature !== signature) fail('IDEMPOTENCY_CONFLICT', '同操作ID不能改变内容或操作人', 409);
        return clone(old.result);
      }
      const result = execute(state);
      Object.defineProperty(state.operations, input.operationId, { enumerable: true, configurable: true, writable: true, value: { signature, result: clone(result) } });
      return clone(result);
    });
  }
  function prior(collection, input) {
    if (input.id == null) {
      if (input.expectedVersion != null) fail('MASTER_VERSION_CONFLICT', '新增主档不能携带已有版本', 409);
      return null;
    }
    if (typeof input.id !== 'string' || !input.id.trim()) fail('INVALID_MASTER', '主档ID无效');
    const existing = collection.find(row => row.id === input.id);
    if (!existing) fail('NOT_FOUND', '主档不存在', 404);
    if (input.expectedVersion !== version(existing)) fail('MASTER_VERSION_CONFLICT', '主档已变化，请重新读取', 409);
    return existing;
  }
  function record(state, collection, input, fields) {
    const existing = prior(collection, input);
    const result = { ...fields, id: existing?.id ?? randomUUID(), version: existing ? String(Number(version(existing)) + 1) : '1', createdAt: existing?.createdAt ?? now(), updatedAt: now() };
    if (existing) collection[collection.indexOf(existing)] = result; else collection.push(result);
    return result;
  }
  return {
    saveCustomer(input, actor) { return write('SAVE_CUSTOMER', input, actor, state => {
      const providedAliases = input.aliases ?? [];
      if (!Array.isArray(providedAliases) || providedAliases.length > 100) fail('INVALID_MASTER', '客户别名须为不超过100个的列表');
      const aliases = [...new Set(providedAliases.map(value => text(value, '别名', 200, true)))];
      const fields = { name: text(input.name, '客户名称', 200, true), address: text(input.address, '地址', 500, true), contact: text(input.contact ?? '', '联系人', 100), phone: text(input.phone ?? '', '联系电话', 100), aliases };
      return record(state, state.customers, input, fields);
    }); },
    saveProduct(input, actor) { return write('SAVE_PRODUCT', input, actor, state => {
      if (!Array.isArray(input.units) || !input.units.length || input.units.length > 2 || input.units.some(unit => !['箱', '瓶'].includes(unit)) || new Set(input.units).size !== input.units.length) fail('INVALID_MASTER', '商品单位须为不重复的箱或瓶');
      if (!Number.isSafeInteger(input.bottlesPerCase) || input.bottlesPerCase <= 0) fail('INVALID_MASTER', '每箱瓶数必须为正安全整数');
      return record(state, state.products, input, { name: text(input.name, '商品名称', 200, true), units: [...input.units], bottlesPerCase: input.bottlesPerCase });
    }); },
    matchCustomer(value) {
      const query = text(value, '客户匹配文本', 500, true);
      const rows = store.read().customers;
      const exact = rows.flatMap(row => {
        const reason = row.name === query ? 'EXACT_NAME' : (row.aliases ?? []).includes(query) ? 'EXACT_ALIAS' : null;
        return reason ? [{ customerId: row.id, name: row.name, address: row.address ?? '', reason }] : [];
      });
      const candidates = exact.length ? exact : rows.filter(row => row.name.includes(query) || (row.aliases ?? []).some(alias => alias.includes(query)))
        .map(row => ({ customerId: row.id, name: row.name, address: row.address ?? '', reason: 'CONTAINS' }));
      return { candidates: clone(candidates.slice(0, 5)), ambiguous: candidates.length > 1 };
    },
    queryOrders(input) { return queryOrdersIn(store.read(), input); },
    getPeriodStats(input) { return clone(periodStatsIn(store.read(), input)); },
  };
}
