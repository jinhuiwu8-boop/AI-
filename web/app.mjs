const main = document.querySelector('#main');
let presentation = null;
let started = false;
const paths = {
  home: ['工作台', 'home'], orders: ['销售订单', 'orders'], create: ['图片开单', 'edit'],
  prices: ['客户价格', 'customers'], masters: ['客户与商品', 'customers'], pending: ['待核订单', 'pending'], printing: ['打印任务', 'print'],
};
const iconPaths = {
  home: 'M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9',
  orders: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6',
  edit: 'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5M10 14l-1 4 4-1 9-9-4-4-8 10Z',
  customers: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m14-13a4 4 0 0 1 0 8m5 5v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  pending: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v6l4 2',
  progress: 'M4 20h17M7 16v-5m5 5V5m5 11V8',
  wallet: 'M3 6h16v14H3V4h14m-2 8h6v4h-6v-4Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5', plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-6-6m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  print: 'M6 8V3h12v5M6 17H3V9h18v8h-3M6 14h12v7H6v-7Z',
  image: 'M3 3h18v18H3V3Zm0 13 6-6 6 6 3-3 3 3M15 7h.01',
  return: 'M8 3 3 8l5 5M3 8h11a7 7 0 0 1 0 14',
  check: 'M5 12l4 4L19 6',
};
const money = cents => new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents ?? 0) / 100);
const dateText = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
const byId = (rows, id) => rows.find(row => row.id === id);
const operationId = () => crypto.randomUUID();
let data = null;
let bootstrapGeneration = 0;
let route = 'home';
let detailOrderId = null;
let busy = false;
let priceEditor = null;
let bill = null;
let orderFilter = 'ALL';
let orderSearch = '';
let masterEditor = null;
const orderQuery = { customerId: '', from: '', to: '', rows: null, loading: false, error: null, generation: 0 };
const todayInShanghai = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const statsQuery = { period: 'day', date: todayInShanghai(), result: null, loading: false, error: null, generation: 0 };
let reviewGeneration = 0;
let loadingReviewJobId = null;
const printQuery = { loaded: false, loading: false, error: null, generation: 0 };
let pending = null;
try { pending = JSON.parse(sessionStorage.getItem('yunjoo.pending') || 'null'); } catch { sessionStorage.removeItem('yunjoo.pending'); }

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  const { on, ...rest } = attrs;
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  for (const [key, value] of Object.entries(rest)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key in node && !key.startsWith('aria-') && key !== 'role') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const [name, handler] of Object.entries(on ?? {})) node.addEventListener(name, handler);
  return node;
}
function icon(name, size = 21) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', iconPaths[name] ?? iconPaths.orders); svg.append(path); return svg;
}
function button(text, action, kind = '', attrs = {}) { return h('button', { type: 'button', class: `btn ${kind}`, on: { click: action }, ...attrs }, text); }
function link(text, href, className = '') { return h('a', { href, class: className }, text); }
function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
function notice(text, kind = '') { return h('div', { class: `notice ${kind}` }, text); }
function field(label, control, helper, className = '') { return h('label', { class: `field ${className}` }, h('span', {}, label), control, helper ? h('span', { class: 'helper' }, helper) : null); }
function select(rows, value, onChange, attrs = {}) {
  return h('select', { value: value ?? '', on: { change: onChange }, ...attrs }, rows.map(row => h('option', { value: row.value }, row.label)));
}
function pageHeading(title, subtitle, action) {
  if (presentation?.pageHeading) return presentation.pageHeading({ title, subtitle, action }, ui);
  return h('div', { class: 'heading' }, h('div', {}, h('div', { class: 'eyebrow' }, 'YUN JIU ZHANG / STORE'), h('h1', {}, title), h('p', {}, subtitle)), action);
}
function card(title, subtitle, body, action) {
  return h('section', { class: 'card' }, h('div', { class: 'card-header' }, h('div', {}, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null), action), body);
}
function empty(text, name = 'orders') { return h('div', { class: 'empty-state' }, h('div', { class: 'empty-icon' }, icon(name)), text); }
function showMessage(text, error = false) {
  const message = document.querySelector('#message');
  message.textContent = text; message.className = `message${error ? ' error' : ''}`; message.hidden = false;
}
function clearMessage() { document.querySelector('#message').hidden = true; }
function persistPending(value) {
  pending = value;
  if (value) sessionStorage.setItem('yunjoo.pending', JSON.stringify(value)); else sessionStorage.removeItem('yunjoo.pending');
  renderPending();
}
function renderPending() {
  const banner = document.querySelector('#pending-banner'); banner.replaceChildren(); banner.hidden = !pending;
  if (!pending) return;
  banner.append(h('div', {}, h('strong', {}, '这次提交结果待确认'), h('div', {}, '保留了原请求。重试会核对同一笔操作，不会另开一单。')), button('查询 / 重试原请求', () => retryPending(), 'secondary small', { disabled: busy }));
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...options, signal: controller.signal });
    let result;
    try { result = await response.json(); } catch { const error = new Error('服务暂未返回可核对的结果，请重试原请求。'); error.unknown = true; throw error; }
    if (!response.ok || result.ok !== true) {
      const error = new Error(result.error?.message || '操作未完成，请重新核对。');
      error.code = result.error?.code; error.known = result.ok === false; error.status = response.status; throw error;
    }
    return result.data;
  } catch (error) {
    if (!error.known) error.unknown = true;
    throw error;
  } finally { clearTimeout(timer); }
}
async function refresh(renderPage = true) {
  const generation = ++bootstrapGeneration;
  const result = await request('/api/bootstrap');
  if (generation !== bootstrapGeneration) return data;
  data = result;
  for (const name of ['customers', 'products', 'orders', 'batches', 'jobs', 'printAttempts', 'devices']) data[name] ??= [];
  document.querySelector('#environment-note').textContent = '本地开发版 · 合成样例数据，设备尚未接入';
  if (renderPage) {
    if (route === 'home') { statsQuery.result = null; statsQuery.error = null; statsQuery.loading = false; statsQuery.generation += 1; }
    if (route === 'orders' && !detailOrderId) { orderQuery.rows = null; orderQuery.error = null; orderQuery.loading = false; orderQuery.generation += 1; }
    if (route === 'printing') { printQuery.loaded = false; printQuery.error = null; printQuery.loading = false; printQuery.generation += 1; }
    render();
  }
  return data;
}
async function mutate(path, payload, successMessage) {
  if (busy) return null;
  if (pending) { showMessage('上一笔提交结果还未确认，请先点击“查询 / 重试原请求”。', true); return null; }
  persistPending({ path, payload: structuredClone(payload), successMessage });
  return sendPending();
}
async function retryPending() { if (!busy && pending) await sendPending(); }
async function sendPending() {
  if (!pending || busy) return null;
  busy = true; setMutationDisabled(true); renderPending(); clearMessage();
  const attempt = pending;
  try {
    const result = await request(attempt.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken }, body: JSON.stringify(attempt.payload) });
    persistPending(null);
    if (result?.type === 'SALE' || result?.type === 'RETURN') {
      data.orders = [...data.orders.filter(order => order.id !== result.id), result];
      bill = null; navigate('orders', { detailId: result.id, replace: true, clear: false, renderPage: false });
    }
    if (attempt.path.startsWith('/api/prices/') && priceEditor && priceEditor.customerId === result.customerId && priceEditor.skuId === result.skuId && priceEditor.unit === result.unit) {
      priceEditor.quote = result;
      priceEditor.price = result.priceCents == null ? '' : (result.priceCents / 100).toFixed(2);
      priceEditor.loading = false;
    }
    if (attempt.path === '/api/customers' || attempt.path === '/api/products') {
      const kind = attempt.path.endsWith('customers') ? 'customers' : 'products';
      if (result?.id) {
        data[kind] = [...data[kind].filter(item => item.id !== result.id), result];
        if (masterEditor?.kind === kind && masterEditor.id === (attempt.payload.id ?? null)) masterEditor = makeMasterEditor(kind, result);
      }
    }
    if (attempt.path.startsWith('/api/print-attempts') && result?.id) data.printAttempts = [...data.printAttempts.filter(item => item.id !== result.id), result];
    orderQuery.rows = null; orderQuery.error = null; orderQuery.generation += 1; orderQuery.loading = false;
    statsQuery.result = null; statsQuery.error = null; statsQuery.generation += 1; statsQuery.loading = false;
    printQuery.loaded = false; printQuery.error = null; printQuery.generation += 1; printQuery.loading = false;
    let refreshFailed = false;
    try { await refresh(false); } catch { refreshFailed = true; }
    render(); showMessage(attempt.successMessage || '已保存。');
    if (refreshFailed) showMessage(`${attempt.successMessage || '已保存。'} 汇总数据暂未刷新，请稍后点击右上角刷新。`);
    return result;
  } catch (error) {
    if (error.known) {
      persistPending(null);
      showMessage(error.message, true);
      if (['PRICE_VERSION_CONFLICT', 'RETURN_PRICE_VERSION_CONFLICT', 'ORDER_VERSION_CONFLICT', 'RETURN_OVER_LIMIT'].includes(error.code)) {
        if (bill) bill.checked = false;
        if (bill?.type === 'SALE' || bill?.type === 'RETURN') await Promise.all(bill.items.map(row => {
          if (bill.type === 'RETURN') invalidateBillQuote(row);
          return quoteBillLine(row, bill.type === 'RETURN' || (!row.manualPrice && !bill.correction));
        }));
        if (priceEditor) await loadPrice();
      }
    } else showMessage('网络中断或响应未知。这笔操作已保留，请用上方按钮重试原请求。', true);
    return null;
  } finally { busy = false; render(); renderPending(); }
}
function setMutationDisabled(value) { if (value) document.querySelectorAll('[data-mutation]').forEach(node => { node.disabled = true; }); }
function parseCents(value, label = '金额') {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error(`${label}请填写非负金额，最多两位小数。`);
  const [whole, part = ''] = String(value).trim().split('.');
  const cents = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`${label}超出可处理范围。`);
  return cents;
}
function parseQuantity(value, allowZero = false) {
  if (!/^\d+$/.test(String(value))) throw new Error('数量必须是整数。');
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < (allowZero ? 0 : 1)) throw new Error(allowZero ? '退货数量须为非负整数。' : '数量至少为1。');
  return quantity;
}
function safeEstimate(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    const error = new Error('估算金额超出安全范围'); error.amountOverflow = true; throw error;
  }
  return Number(value);
}
function renderNavigation() {
  if (presentation?.renderNavigation) { presentation.renderNavigation(ui); return; }
  const make = key => {
    const [label, glyph] = paths[key];
    const node = link([icon(glyph), label], `#${key}`);
    node.replaceChildren(icon(glyph), h('span', {}, label));
    node.className = `nav-item${route === key ? ' active' : ''}${key === 'create' ? ' create-nav' : ''}`;
    if (route === key) node.setAttribute('aria-current', 'page');
    return node;
  };
  document.querySelector('#desktop-nav').replaceChildren(...Object.keys(paths).map(make));
  document.querySelector('#mobile-nav').replaceChildren(...['home', 'orders', 'create', 'prices', 'pending'].map(make));
  document.querySelector('#breadcrumb').textContent = paths[route]?.[0] ?? '工作台';
}
function availableRoutes() { return { ...paths, ...(presentation?.routes ?? {}) }; }
function navigate(key, { detailId = null, replace = false, clear = true, renderPage = true } = {}) {
  if (!availableRoutes()[key]) return;
  if (key !== 'pending' && loadingReviewJobId) { reviewGeneration += 1; loadingReviewJobId = null; }
  route = key; detailOrderId = detailId;
  const hash = `#${key}`;
  if (location.hash !== hash || replace) history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  if (clear) clearMessage();
  if (renderPage) { render(); window.scrollTo({ top: 0 }); }
}
function openOrder(order) { data.orders = [...data.orders.filter(item => item.id !== order.id), order]; navigate('orders', { detailId: order.id }); }
function render() {
  if (!data) return;
  renderNavigation();
  const content = presentation?.renderers?.[route] ?? defaultScreens[route] ?? renderHome;
  const screen = content(ui);
  presentation?.decorate?.(route, screen, ui);
  main.replaceChildren(screen);
  setMutationDisabled(busy);
}
function newBill() {
  return { type: 'SALE', mode: 'ELECTRONIC', customerId: data.customers[0]?.id ?? '', items: [], checked: false, credit: '0', waiver: '0', note: '', correction: null, sourceJobId: null, candidateVersion: null, candidateIssues: [], originalMessages: [] };
}
function beginSale() { reviewGeneration += 1; loadingReviewJobId = null; bill = newBill(); addBillLine(); navigate('create'); }
function beginReturn(customerId = '') { reviewGeneration += 1; loadingReviewJobId = null; bill = newBill(); bill.type = 'RETURN'; bill.customerId = byId(data.customers, customerId)?.id ?? ''; addBillLine(); navigate('create'); }
async function loadPeriodStats() {
  if (statsQuery.period === 'all') return;
  const generation = ++statsQuery.generation;
  const period = statsQuery.period; const date = statsQuery.date;
  statsQuery.loading = true; statsQuery.error = null; statsQuery.result = null;
  try {
    const result = await request(`/api/stats?${new URLSearchParams({ period, date })}`);
    if (generation === statsQuery.generation) statsQuery.result = result.stats ?? result;
  } catch (error) { if (generation === statsQuery.generation) statsQuery.error = error.message; }
  finally { if (generation === statsQuery.generation) { statsQuery.loading = false; if (route === 'home' || presentation?.usesPeriodStats?.includes(route)) render(); } }
}
function renderStatsControls() {
  const setPeriod = period => {
    statsQuery.period = period; statsQuery.date = period === 'month' ? todayInShanghai().slice(0, 7) : todayInShanghai();
    statsQuery.generation += 1; statsQuery.result = null; statsQuery.error = null; statsQuery.loading = false;
    if (period !== 'all') void loadPeriodStats(); render();
  };
  return h('div', { class: 'period-controls' }, h('div', { class: 'filter-pills', role: 'group', 'aria-label': '销售统计周期' }, [['day', '按日'], ['month', '按月'], ['all', '累计']].map(([period, text]) => button(text, () => setPeriod(period), '', { class: `filter-pill${statsQuery.period === period ? ' active' : ''}` }))), statsQuery.period === 'all' ? h('span', { class: 'helper' }, '全部已记销售事件') : h('input', { type: statsQuery.period === 'month' ? 'month' : 'date', value: statsQuery.date, 'aria-label': '统计日期', on: { change: event => { statsQuery.date = event.target.value; void loadPeriodStats(); render(); } } }), statsQuery.error ? h('span', { class: 'helper danger-text' }, statsQuery.error) : h('span', { class: 'helper' }, statsQuery.loading ? '正在读取统计…' : '按北京时间，冲回和退货分别核算'));
}
function renderHome() {
  if (statsQuery.period !== 'all' && !statsQuery.result && !statsQuery.loading && !statsQuery.error) queueMicrotask(() => loadPeriodStats());
  const stats = statsQuery.period === 'all' ? data.stats ?? {} : statsQuery.result ?? {};
  const prefix = statsQuery.period === 'all' ? '累计' : statsQuery.period === 'month' ? '所选月' : '所选日';
  const waiting = data.jobs.filter(job => job.status === 'WAITING_EDGE').length;
  const reviewWaiting = data.jobs.filter(job => job.status === 'AWAITING_REVIEW').length;
  const printWaiting = data.printAttempts.filter(job => ['PENDING_DEVICE', 'SPOOLER_ACCEPTED', 'UNCERTAIN'].includes(job.status)).length;
  const stat = (label, value, foot, glyph, featured = false) => h('div', { class: `stat-card${featured ? ' featured' : ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value == null ? '—' : [h('span', { class: 'currency' }, '¥'), money(value)]), h('div', { class: 'stat-foot' }, foot), h('span', { class: 'stat-icon' }, icon(glyph)));
  const recent = [...data.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const quick = (label, desc, glyph, action) => h('a', { href: '#create', class: 'quick-action', on: { click: event => { event.preventDefault(); action(); } } }, h('span', { class: 'action-icon' }, icon(glyph)), label, h('small', {}, desc));
  return h('div', {}, pageHeading('工作台', '每一单，核对清楚再开出。', button([icon('plus', 16), '图片开单'], beginSale)),
    renderStatsControls(), h('div', { class: 'stats-grid' }, stat(`${prefix}净销售`, stats.netSalesCents, '销售货款减去已登记退货', 'wallet', true), stat(`${prefix}销售货款`, stats.salesCents, '按真实销售与更正事件计入', 'orders'), stat(`${prefix}退货货款`, stats.returnCents, '按实际退货登记事件计入', 'return'), stat(`${prefix}净应收`, stats.receivableCents, '抵扣、抹零及到角后', 'progress')), stats.saleGrossCents != null && stats.reversalCents != null ? h('p', { class: 'period-reversal' }, `本期销售事件入账 ¥${money(stats.saleGrossCents)} · 更正冲回 ¥${money(stats.reversalCents)} · 退货 ¥${money(stats.returnCents)}；按各自实际登记时间统计。`) : null,
    h('div', { class: 'content-grid' }, card('最近开单', '正式单据与销售记录在这里汇总', recent.length ? h('div', { class: 'row-list' }, recent.map(order => h('a', { href: '#orders', class: 'order-row', on: { click: event => { event.preventDefault(); openOrder(order); } } }, h('span', { class: `order-symbol ${order.type === 'RETURN' ? 'return' : ''}` }, icon(order.type === 'RETURN' ? 'return' : 'orders', 18)), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, order.customerName), h('div', { class: 'row-sub' }, `${dateText(order.createdAt)} · ${order.items.length}项商品`)), h('div', { class: 'row-amount' }, `${order.type === 'RETURN' ? '−' : ''}¥${money(order.totals.receivableCents)}`, h('small', {}, order.type === 'RETURN' ? '退货开单' : '已确认'))))) : empty('还没有正式订单，从图片开单开始。'), link(['查看全部', h('span', { class: 'arrow' }, '→')], '#orders', 'text-link')),
      h('div', { class: 'stack' }, card('快捷开单', '日常操作，一步进入', h('div', { class: 'quick-actions' }, quick('图片开单', '手工电子单', 'image', beginSale), quick('退货开单', '按客户历史成交价', 'return', () => beginReturn()), quick('客户调价', '保存后续生效', 'customers', () => navigate('prices')))),
        card('待办与设备', null, h('div', { class: 'status-list' }, h('a', { href: '#pending', class: 'status-row' }, h('span', { class: 'status-circle waiting' }), '识别 / 人工核对', h('span', { class: 'status-description' }, `${waiting} 等识别 · ${reviewWaiting} 待核对`)), h('a', { href: '#printing', class: 'status-row' }, h('span', { class: 'status-circle waiting' }), '佳能 iP110 打印任务', h('span', { class: 'status-description' }, `${printWaiting} 次待处理 →`)), h('a', { href: '#masters', class: 'status-row' }, h('span', { class: 'status-circle' }), '客户与商品维护', h('span', { class: 'status-description' }, '新增 / 修改 →'))))))
  );
}
function orderQueryParams(filters, type) {
  const params = new URLSearchParams();
  if (filters.customerId) params.set('customerId', filters.customerId);
  if (type !== 'ALL') params.set('type', type);
  if (filters.from) params.set('from', `${filters.from}T00:00:00+08:00`);
  if (filters.to) {
    const next = new Date(`${filters.to}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    if (!Number.isFinite(next.getTime())) throw new Error('结束日期无效。');
    params.set('to', `${next.toISOString().slice(0, 10)}T00:00:00+08:00`);
  }
  return params;
}
async function loadOrderQuery() {
  const generation = ++orderQuery.generation;
  orderQuery.loading = true; orderQuery.error = null; orderQuery.rows = null;
  try {
    const result = await request(`/api/orders?${orderQueryParams(orderQuery, orderFilter)}`);
    if (generation === orderQuery.generation) orderQuery.rows = Array.isArray(result) ? result : result.orders ?? [];
  } catch (error) { if (generation === orderQuery.generation) { orderQuery.error = error.message; orderQuery.rows = []; } }
  finally { if (generation === orderQuery.generation) { orderQuery.loading = false; if (route === 'orders' && !detailOrderId) render(); } }
}
function renderOrders() {
  if (detailOrderId) { const order = byId(data.orders, detailOrderId); if (order) return renderOrderDetail(order); detailOrderId = null; }
  if (!orderQuery.rows && !orderQuery.loading && !orderQuery.error) queueMicrotask(() => loadOrderQuery());
  const rows = presentation?.orderResults ? h('div', { class: 'phone-order-list' }) : h('tbody');
  const updateRows = () => {
    const query = orderSearch.trim().toLowerCase();
    const orders = [...(orderQuery.rows ?? [])].filter(order => !query || `${order.customerName} ${order.id}`.toLowerCase().includes(query)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (presentation?.orderResults) {
      rows.replaceChildren(presentation.orderResults(orders, { loading: orderQuery.loading || !orderQuery.rows, error: orderQuery.error }, ui));
      return;
    }
    rows.replaceChildren(...orders.map(order => h('tr', {}, h('td', {}, h('strong', {}, order.customerName), h('span', { class: 'secondary-text' }, dateText(order.createdAt))), h('td', {}, h('span', { class: 'amount' }, `${order.type === 'RETURN' ? '−' : ''}¥${money(order.totals.receivableCents)}`), h('span', { class: 'secondary-text' }, `货款 ¥${money(order.totals.goodsCents)}`)), h('td', {}, badge(order.type === 'RETURN' ? '退货单' : '销售单', order.type === 'RETURN' ? 'return' : ''), h('span', { class: 'secondary-text' }, `版本 ${order.revision}`)), h('td', {}, badge(printStatus(order), 'amber')), h('td', {}, button('查看 →', () => openOrder(order), 'ghost')))));
    if (!orders.length) rows.append(h('tr', {}, h('td', { colSpan: 5, class: 'no-results' }, orderQuery.loading || !orderQuery.rows ? '正在读取订单…' : orderQuery.error || '没有符合条件的订单。')));
  };
  const filters = h('div', { class: 'filter-pills' });
  const updateFilters = () => filters.replaceChildren(...[['ALL', '全部'], ['SALE', '销售单'], ['RETURN', '退货单']].map(([value, text]) => button(text, () => { orderFilter = value; void loadOrderQuery(); render(); }, '', { class: `filter-pill${orderFilter === value ? ' active' : ''}` })));
  updateFilters(); updateRows();
  const changeQuery = (name, value) => { orderQuery[name] = value; void loadOrderQuery(); render(); };
  const dateFilters = h('div', { class: 'order-date-filters' }, field('客户筛选', select([{ value: '', label: '全部客户' }, ...data.customers.map(item => ({ value: item.id, label: [item.name, item.address].filter(Boolean).join(' · ') }))], orderQuery.customerId, event => changeQuery('customerId', event.target.value))), field('开始日期（含）', h('input', { type: 'date', value: orderQuery.from, on: { change: event => changeQuery('from', event.target.value) } })), field('截至日期（含）', h('input', { type: 'date', value: orderQuery.to, on: { change: event => changeQuery('to', event.target.value) } })), button('重置筛选', () => { orderQuery.customerId = ''; orderQuery.from = ''; orderQuery.to = ''; orderFilter = 'ALL'; void loadOrderQuery(); render(); }, 'secondary small'));
  return h('div', {}, pageHeading('销售订单', '销售、更正和退货都有据可查。', button([icon('plus', 16), '图片开单'], beginSale)), presentation?.orderIntro?.(ui), dateFilters, h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 18), h('input', { type: 'search', value: orderSearch, placeholder: '搜索当前结果的客户名称或单号', 'aria-label': '搜索订单', on: { input: event => { orderSearch = event.target.value; updateRows(); } } })), filters), presentation?.orderResults ? rows : h('div', { class: 'card table-scroll' }, h('table', { class: 'orders-table' }, h('thead', {}, h('tr', {}, ['客户 / 开单时间', '应收金额', '单据类型', '打印状态', '操作'].map(text => h('th', { scope: 'col' }, text)))), rows)));
}
function printStatus(order) {
  const attempts = data.printAttempts.filter(item => item.orderId === order.id && item.revision === order.revision);
  if (!attempts.length) return order.mode === 'ELECTRONIC' ? '电子单 · 未打印' : '待连接打印机';
  const latest = attempts.at(-1);
  return printStatusText(latest.status);
}
function printStatusText(status) {
  return ({ PENDING_DEVICE: '等待打印设备', SUBMIT_INTENT: '提交可能 · 待设备回执', SPOOLER_ACCEPTED: '队列已接受 · 待人工看纸', UNCERTAIN: '结果不确定 · 待人工看纸', PAPER_CONFIRMED: '已人工确认出纸', PAPER_NOT_PRINTED: '已人工确认未出纸', FAILED_BEFORE_SPOOL: '提交前失败', SUPERSEDED: '已由更正版替代' })[status] ?? '打印状态待核实';
}
async function loadPrintAttempts() {
  const generation = ++printQuery.generation; printQuery.loading = true; printQuery.error = null;
  try {
    const result = await request('/api/print-attempts');
    if (generation === printQuery.generation) { data.printAttempts = Array.isArray(result) ? result : result.attempts ?? []; printQuery.loaded = true; }
  } catch (error) { if (generation === printQuery.generation) printQuery.error = error.message; }
  finally { if (generation === printQuery.generation) { printQuery.loading = false; if (route === 'printing') render(); } }
}
function renderPrintAttempt(attempt) {
  const order = byId(data.orders, attempt.orderId);
  const canInspect = ['SPOOLER_ACCEPTED', 'UNCERTAIN'].includes(attempt.status);
  const childAttempt = data.printAttempts.find(child => child.reprintOf === attempt.id);
  const canReprint = ['PAPER_NOT_PRINTED', 'FAILED_BEFORE_SPOOL'].includes(attempt.status) && order?.revision === attempt.revision && !childAttempt;
  const pdfId = attempt.documentId ?? attempt.document?.id;
  const pdfLink = pdfId ? link('下载变量 PDF', `/api/documents/${encodeURIComponent(pdfId)}.pdf`, 'btn secondary small') : null;
  if (pdfLink) pdfLink.setAttribute('download', `套打-${attempt.orderId}-v${attempt.revision}.pdf`);
  const paper = printed => mutate(`/api/print-attempts/${encodeURIComponent(attempt.id)}/paper`, { operationId: operationId(), printed }, printed ? '已记录人工看纸：已出纸。销售未重复计入。' : '已记录人工看纸：未出纸，可手动补打 1 份。');
  const reprint = () => mutate(`/api/print-attempts/${encodeURIComponent(attempt.id)}/reprint`, { operationId: operationId() }, '已新建 1 份补打请求，引用同一冻结单据；未新增销售。');
  return h('section', { class: 'card batch-card' }, h('div', { class: 'batch-head' }, h('h3', {}, order?.customerName ?? '已确认销售单'), badge(printStatusText(attempt.status), attempt.status === 'PAPER_CONFIRMED' ? '' : 'amber')), h('p', { class: 'batch-meta' }, `单据版本 ${attempt.revision} · 每次 1 份 · ${dateText(attempt.createdAt)}`, h('br'), `打印请求：${attempt.id}`),
    h('div', { class: 'detail-actions section-spacer' }, pdfLink, canInspect ? [button('已看到出纸', () => paper(true), 'secondary small', { 'data-mutation': '', disabled: busy || Boolean(pending) }), button('确认未出纸', () => paper(false), 'secondary small', { 'data-mutation': '', disabled: busy || Boolean(pending) })] : null, canReprint ? button([icon('print', 15), '补打 1 份'], reprint, 'secondary small', { 'data-mutation': '', disabled: busy || Boolean(pending) }) : null),
    h('div', { class: 'section-spacer' }, notice(attempt.status === 'PENDING_DEVICE' ? '当前仅登记待设备任务，没有提交或出纸回执，暂不提供人工出纸确认。' : attempt.status === 'SUBMIT_INTENT' ? '可能已提交设备，不能自动重印。等待设备受控回执后再人工看纸。' : canInspect ? '请实际查看打印机是否出纸，再选择上方结果。队列接受不等于纸张已经出来。' : printStatusText(attempt.status), 'amber')),
    pdfId ? h('p', { class: 'helper section-spacer' }, attempt.calibrationStatus === 'VALIDATED' || attempt.document?.calibrationStatus === 'VALIDATED' ? '130×190mm 预印纸变量模板 · 模板状态 VALIDATED；实际出纸仍需人工确认。' : '130×190mm 预印纸变量模板 · UNVALIDATED · 尚未实纸校准，PDF 下载不代表套打对齐已验收。') : null,
    childAttempt ? h('p', { class: 'helper section-spacer' }, `已关联 1 份补打任务：${childAttempt.id}，请处理该任务。`) : null,
    order && order.revision !== attempt.revision ? h('p', { class: 'helper section-spacer' }, '此请求属于旧版本；保留原打印记录，请在订单中使用当前更正版。') : null);
}
function renderPrinting() {
  if (!printQuery.loaded && !printQuery.loading && !printQuery.error) queueMicrotask(() => loadPrintAttempts());
  const attempts = [...data.printAttempts].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const registered = data.devices.filter(device => device.active && device.capabilities?.includes('PRINT')).length;
  return h('div', {}, pageHeading('打印任务', '每次一份，实际看纸后登记；未知状态不自动重印。', button('刷新任务', () => { void loadPrintAttempts(); render(); }, 'secondary')), h('div', { class: 'selection-summary' }, `已登记打印设备 ${registered} 台；登记信息不等于打印机在线。`), printQuery.error ? notice(printQuery.error, 'amber') : null, attempts.length ? attempts.map(renderPrintAttempt) : h('section', { class: 'card' }, empty(printQuery.loading ? '正在读取打印任务…' : '暂无打印任务，请从已确认销售单选择纸质打印。', 'print')));
}
function renderOrderDetail(order) {
  const attempts = data.printAttempts.filter(item => item.orderId === order.id);
  const currentAttempts = attempts.filter(item => item.revision === order.revision && item.status !== 'SUPERSEDED');
  const print = async () => {
    await mutate('/api/print-attempts', { operationId: operationId(), orderId: order.id }, '已登记 1 份打印请求，等待连接打印设备；未新增销售。');
  };
  const needsPdf = currentAttempts.some(attempt => attempt.status === 'PENDING_DEVICE' && !attempt.documentId && !attempt.document?.id);
  const actions = h('div', { class: 'detail-actions' }, order.document ? link([icon('image', 16), '下载正式图片'], `/api/documents/${encodeURIComponent(order.document.id)}.png`, 'btn secondary') : null, order.type === 'SALE' && (currentAttempts.length === 0 || needsPdf) ? button([icon('print', 16), needsPdf ? '待准备套打 PDF' : '纸质打印 1 份'], print, 'secondary', { 'data-mutation': '', disabled: busy || Boolean(pending) }) : order.type === 'SALE' ? link('查看打印任务', '#printing', 'btn secondary') : null);
  if (order.document) actions.querySelector('a').setAttribute('download', `${order.type === 'RETURN' ? '退货' : '销售'}单-${order.id}.png`);
  const detail = h('section', { class: 'card form-card' }, h('div', { class: 'detail-head' }, h('div', {}, badge(order.type === 'RETURN' ? '退货单' : '销售单', order.type === 'RETURN' ? 'return' : ''), h('h2', { class: 'section-spacer' }, order.customerName), h('p', {}, `${dateText(order.createdAt)} · 当前版本 ${order.revision}`)), actions),
    h('div', { class: 'table-scroll' }, h('table', { class: 'detail-items' }, h('thead', {}, h('tr', {}, ['商品名称', '数量', '单位', '单价', '金额'].map(text => h('th', { scope: 'col' }, text)))), h('tbody', {}, order.items.map(item => h('tr', {}, h('td', {}, item.productName), h('td', {}, item.quantity), h('td', {}, item.unit), h('td', {}, money(item.priceCents)), h('td', {}, money(item.lineAmountCents))))))),
    summary(order.totals, false, order.type === 'RETURN'), order.note ? h('p', { class: 'detail-meta section-spacer' }, `备注：${order.note}`) : null,
    h('p', { class: 'detail-meta section-spacer' }, `单号：${order.id}`), order.sourceOrderId ? h('p', { class: 'detail-meta' }, `关联销售单：${order.sourceOrderId} · 原版本 ${order.sourceRevision}`) : null,
    order.type === 'RETURN' && order.returnBasis === 'CUSTOMER_HISTORY' ? h('p', { class: 'detail-meta section-spacer' }, '按客户历史成交价退货；历史销售记录仅作为取价依据。', order.items.map(item => item.priceSource ? h('span', { class: 'secondary-text' }, `${item.productName}：${returnPriceDescription(item.priceSource)}`) : null)) : null,
    order.type === 'SALE' ? h('div', { class: 'detail-actions section-spacer' }, button('老板更正此单', () => beginCorrection(order), 'ghost'), button('为该客户开退货单', () => beginReturn(order.customerId), 'ghost')) : null,
    order.revisions?.length > 1 ? h('details', { class: 'history' }, h('summary', {}, `查看 ${order.revisions.length} 个保留版本`), order.revisions.map(version => h('div', { class: 'history-item' }, `版本 ${version.revision} · ${version.customerName} · 货款 ¥${money(version.totals.goodsCents)} · 应收 ¥${money(version.totals.receivableCents)}`, h('div', {}, version.items.map(item => `${item.productName} ${item.quantity}${item.unit} × ¥${money(item.priceCents)}`).join('；'))))) : null);
  const doc = order.document ? card('正式电子单', '引用确认时冻结的客户、商品及价格', h('div', { class: 'card-body' }, h('div', { class: 'document-preview' }, h('img', { class: 'bill-image', src: `/api/documents/${encodeURIComponent(order.document.id)}.png`, alt: `${order.customerName}的${order.type === 'RETURN' ? '退货' : '销售'}正式单据` })), h('p', { class: 'document-caption' }, '浏览器可下载图片。华为原生相册保存能力尚待 APK 接入验证。'))) : card('纸质开单', null, h('div', { class: 'card-body' }, notice('本单已确认计销。打印设备未连接，待设备接入后处理；没有用浏览器预览冒充真实出纸。', 'amber')));
  return h('div', {}, button('← 返回订单列表', () => { detailOrderId = null; render(); }, 'ghost page-back'), detail, doc, h('div', { class: 'section-spacer' }, notice(`${printStatus(order)}。打印状态单独记录；每次补打 1 份，不会计入第二次销售。`, 'amber')), h('div', { class: 'section-spacer' }, attempts.map(renderPrintAttempt)));
}
function summary(totals, estimated = true, isReturn = false) {
  if (totals.unverified) return h('div', {}, h('div', { class: 'summary-line' }, '商品货款', h('span', {}, '待服务端校验')), h('div', { class: 'summary-line total' }, '预计应收', h('span', {}, '待服务端校验')), h('p', { class: 'summary-note' }, '当前估算超出安全范围，不显示可能失真的金额；请核对输入，正式金额由服务端校验。'));
  return h('div', {}, h('div', { class: 'summary-line' }, '商品货款', h('span', {}, `¥${money(totals.goodsCents)}`)), !isReturn ? h('div', { class: 'summary-line' }, '抵扣', h('span', {}, `− ¥${money(totals.creditCents)}`)) : null, !isReturn ? h('div', { class: 'summary-line' }, '抹零', h('span', {}, `− ¥${money(totals.waiverCents)}`)) : null, h('div', { class: 'summary-line total' }, isReturn ? estimated ? '预计退货金额' : '确认退货金额' : estimated ? '预计应收' : '确认应收', h('strong', {}, `¥${money(totals.receivableCents)}`)), h('p', { class: 'summary-note' }, estimated ? `此处为核对估算；正式金额由服务端确认，最终${isReturn ? '退货金额' : '应收'}四舍五入到角。` : `最终${isReturn ? '退货金额' : '应收'}到角，舍入差额 ¥${money(totals.roundingCents ?? 0)}。`));
}
function preferredReturnUnit(units = []) { return ['瓶', '箱'].find(unit => units.includes(unit)) ?? ''; }
function addBillLine() {
  const product = data.products[0];
  const defaultUnit = bill.type === 'RETURN' ? preferredReturnUnit(product?.units) : product?.units[0] ?? '箱';
  const row = { key: operationId(), skuId: bill.sourceJobId ? '' : product?.id ?? '', unit: bill.sourceJobId ? '' : defaultUnit, quantity: bill.sourceJobId ? '' : '1', price: '', quote: null, manualPrice: false, zeroConfirmed: false, quoteLoading: false, packagingConfirmed: false };
  bill.items.push(row); bill.checked = false;
  if (bill.customerId && row.skuId) void quoteBillLine(row, true);
}
function resetCheck() {
  bill.checked = false;
  const control = document.querySelector('#bill-checked'); if (control) control.checked = false;
  const totals = document.querySelector('#bill-summary'); if (totals) totals.replaceChildren(summary(estimateBill(), true, bill.type === 'RETURN'));
  presentation?.refreshBillPreview?.(ui);
}
function estimateBill() {
  let goods = 0n;
  try {
    goods = bill.items.reduce((sum, row) => sum + BigInt(parseCents(row.price || '0')) * BigInt(parseQuantity(row.quantity || '0', true)), 0n);
    const credit = bill.type === 'RETURN' ? 0 : parseCents(bill.credit || '0');
    const waiver = bill.type === 'RETURN' ? 0 : parseCents(bill.waiver || '0');
    const raw = goods - BigInt(credit) - BigInt(waiver);
    return { goodsCents: safeEstimate(goods), creditCents: credit, waiverCents: waiver, receivableCents: safeEstimate(((raw > 0n ? raw : 0n) + 5n) / 10n * 10n) };
  } catch (error) { return error.amountOverflow ? { unverified: true } : { goodsCents: 0, creditCents: 0, waiverCents: 0, receivableCents: 0 }; }
}
function beginRowQuoteRequest(row, identity) {
  row.quoteIdentity = identity;
  row.quoteRequestGeneration = (row.quoteRequestGeneration ?? 0) + 1;
  return { identity, generation: row.quoteRequestGeneration, priceEditGeneration: row.priceEditGeneration ?? 0 };
}
function isCurrentRowQuoteRequest(row, token) {
  return row.quoteIdentity === token.identity && row.quoteRequestGeneration === token.generation;
}
function markRowPriceEdited(row) { row.priceEditGeneration = (row.priceEditGeneration ?? 0) + 1; }
function applyRowQuoteResponse(row, token, quote, replacePrice) {
  if (!isCurrentRowQuoteRequest(row, token)) return false;
  if (row.quote?.version !== quote.version) row.packagingConfirmed = false;
  row.quote = quote;
  if (replacePrice && (row.priceEditGeneration ?? 0) === token.priceEditGeneration) {
    row.price = quote.priceCents == null ? '' : (quote.priceCents / 100).toFixed(2);
    row.manualPrice = false; row.zeroConfirmed = false;
  }
  return true;
}
async function quoteBillLine(row, replacePrice) {
  if (!bill?.customerId || !row.skuId || !row.unit) return;
  const isReturn = bill.type === 'RETURN';
  const identity = `${bill.type}:${bill.customerId}:${row.skuId}:${row.unit}`;
  const token = beginRowQuoteRequest(row, identity);
  row.quoteLoading = true; row.quoteError = null;
  try {
    const quote = await request(`${isReturn ? '/api/return-prices' : '/api/prices'}?${new URLSearchParams({ customerId: bill.customerId, skuId: row.skuId, unit: row.unit })}`);
    applyRowQuoteResponse(row, token, quote, replacePrice);
  } catch (error) { if (isCurrentRowQuoteRequest(row, token)) { row.quote = null; row.quoteError = error.message; } }
  finally {
    if (isCurrentRowQuoteRequest(row, token)) {
      row.quoteLoading = false;
      if (route === 'create' && bill?.items.includes(row)) { const section = document.querySelector(`[data-row-key="${row.key}"]`); if (section) section.replaceWith(renderBillLine(row, bill.items.indexOf(row))); resetCheck(); }
    }
  }
}
async function quoteAllBillLines(replacePrice) { if (bill) await Promise.all(bill.items.map(row => quoteBillLine(row, replacePrice))); }
function invalidateBillQuote(row, clearPrice = true) {
  row.quoteRequestGeneration = (row.quoteRequestGeneration ?? 0) + 1; row.quoteIdentity = null;
  row.quote = null; row.quoteLoading = false; row.quoteError = null;
  row.packagingConfirmed = false;
  if (clearPrice) { row.price = ''; row.manualPrice = false; row.zeroConfirmed = false; }
}
function renderBillLine(row, index) {
  const isReturn = bill.type === 'RETURN';
  const product = byId(data.products, row.skuId);
  const productSelect = select([{ value: '', label: '请选择商品' }, ...data.products.map(item => ({ value: item.id, label: item.name }))], row.skuId, event => {
    row.skuId = event.target.value;
    const productUnits = byId(data.products, row.skuId)?.units ?? [];
    row.unit = bill.sourceJobId ? '' : (isReturn ? preferredReturnUnit(productUnits) : productUnits[0]) ?? '';
    invalidateBillQuote(row); resetCheck(); render(); void quoteBillLine(row, true);
  }, { 'aria-label': `第${index + 1}行商品` });
  const units = isReturn ? ['瓶', '箱'].filter(value => product?.units.includes(value)) : product?.units ?? [];
  const changeUnit = unit => { if (row.unit === unit) return; row.unit = unit; invalidateBillQuote(row); resetCheck(); render(); void quoteBillLine(row, true); };
  const unitSelect = isReturn ? h('div', { class: 'return-unit-buttons', role: 'group', 'aria-label': `第${index + 1}行退货单位` }, units.map(unit => button(unit === '瓶' ? '瓶（散瓶）' : '箱（整箱）', () => changeUnit(unit), 'secondary', { class: `btn return-unit-button${row.unit === unit ? ' active' : ''}`, 'aria-pressed': row.unit === unit ? 'true' : 'false' })), !units.length ? h('span', { class: 'helper' }, '该商品未配置箱或瓶单位') : null) : select([{ value: '', label: '请选择单位' }, ...units.map(value => ({ value, label: value }))], row.unit, event => changeUnit(event.target.value), { 'aria-label': `第${index + 1}行单位` });
  const unitField = isReturn ? h('div', { class: 'field return-unit-field' }, h('span', {}, '退货单位'), unitSelect, h('span', { class: 'helper' }, units.includes('瓶') ? '最少可退 1 瓶，散瓶与整箱都按整数填写数量。' : units.includes('箱') ? '当前商品仅配置箱单位，数量按整箱填写。' : '请先核对商品资料中支持的箱或瓶单位。')) : field('单位', unitSelect);
  const zeroLabel = h('label', { class: 'check-label zero-label', hidden: row.price === '' || Number(row.price) !== 0 }, h('input', { type: 'checkbox', checked: row.zeroConfirmed, on: { change: event => { markRowPriceEdited(row); row.zeroConfirmed = event.target.checked; resetCheck(); } } }), '我明确确认本行 0 元，不改变以后售价');
  const totalLabel = h('span', { class: 'line-total' });
  const updateTotal = () => { try { totalLabel.textContent = `小计 ¥${money(safeEstimate(BigInt(parseCents(row.price || '0')) * BigInt(parseQuantity(row.quantity || '0', true))))}`; } catch (error) { totalLabel.textContent = error.amountOverflow ? '小计待服务端校验' : '请核对金额'; } };
  const quantity = h('input', { type: 'number', inputMode: 'numeric', min: 1, step: 1, value: row.quantity, on: { input: event => { row.quantity = event.target.value; resetCheck(); updateTotal(); } } });
  const price = h('input', { type: 'text', inputMode: 'decimal', readOnly: isReturn, 'aria-label': `第${index + 1}行单价`, placeholder: isReturn ? '历史价待核对' : row.quote?.source === 'MISSING' ? '请手工填写' : '读取价格中…', value: row.price, on: { input: event => { if (isReturn) return; markRowPriceEdited(row); row.price = event.target.value; row.manualPrice = true; row.zeroConfirmed = false; zeroLabel.hidden = row.price === '' || Number(row.price) !== 0; zeroLabel.querySelector('input').checked = false; resetCheck(); updateTotal(); } } });
  updateTotal();
  const source = row.quoteLoading ? `正在读取${isReturn ? '历史成交价' : '最新客户价'}…` : row.quoteError ? `取价失败：${row.quoteError}` : !row.quote ? '请先补全客户、商品和单位' : isReturn ? returnPriceDescription(row.quote) : row.quote.source === 'MISSING' ? '暂无客户价，需人工填写' : row.quote.source === 'CASE_DERIVED' ? '箱价拆瓶 · 已到角' : '已读取当前客户有效价';
  const packaging = isReturn && row.quote?.requiresPackagingConfirmation ? h('label', { class: 'check-label packaging-check' }, h('input', { type: 'checkbox', checked: Boolean(row.packagingConfirmed), 'aria-label': `第${index + 1}行包装瓶数确认`, on: { change: event => { row.packagingConfirmed = event.target.checked; resetCheck(); } } }), `历史单未冻结包装，现按商品资料每箱 ${row.quote.bottlesPerCase} 瓶；我已核对瓶数`) : null;
  return h('div', { class: 'line-card', 'data-row-key': row.key }, h('div', { class: 'line-top' }, `商品 ${String(index + 1).padStart(2, '0')}`, button('移除', () => { bill.items = bill.items.filter(item => item !== row); resetCheck(); render(); }, 'ghost', { disabled: bill.items.length === 1, 'aria-label': `移除第${index + 1}行商品` })), row.candidateProductName ? h('p', { class: 'candidate-hint' }, `原识别商品提示：${row.candidateProductName}`) : null, h('div', { class: `line-grid${isReturn ? ' return-line-grid' : ''}` }, field('商品名称', productSelect, presentation?.showProductName && product?.name.length > 20 ? product.name : null, 'product-field'), unitField, field(isReturn ? `退货数量${row.unit ? ` / ${row.unit}` : ''}` : '数量', quantity), field('单价 / 元', price, null, 'price-field')), h('div', { class: 'line-meta' }, h('span', { class: `price-source${['MISSING', 'AMBIGUOUS'].includes(row.quote?.source) || row.quoteError || !row.quote ? ' missing' : ''}` }, source), totalLabel), packaging, !isReturn ? zeroLabel : null);
}
function returnPriceDescription(quote) {
  if (quote.source === 'MISSING') return '暂无该客户历史箱价，不能办理此项退货';
  if (quote.source === 'AMBIGUOUS') return '最近历史成交存在多个价格，需先核对，不能保存';
  const price = quote.source === 'HISTORY_CASE_DERIVED' ? `历史箱价 ¥${money(quote.casePriceCents)} ÷ ${quote.bottlesPerCase} 瓶，单瓶已四舍五入到角` : '已读取该客户历史箱价';
  return `${price}${quote.sourceOrderId ? ` · 取价记录 ${quote.sourceOrderId}${quote.sourceRevision ? ` / v${quote.sourceRevision}` : ''}` : ''}`;
}
function renderCreate() {
  if (!bill) { bill = newBill(); addBillLine(); }
  const correction = Boolean(bill.correction);
  const chooseType = type => { if (bill.type !== type) { if (type === 'RETURN') beginReturn(); else beginSale(); } };
  const modeSwitch = correction ? notice(`正在更正原销售单版本 ${bill.correction.expectedRevision}。保存后保留前后记录、冲回旧销售；非零更正单价成为以后售价。`, 'amber') : h('div', { class: 'segmented', role: 'group', 'aria-label': '开单类型' }, button('销售开单', () => chooseType('SALE'), '', { class: bill.type === 'SALE' ? 'active' : '' }), button('退货开单', () => chooseType('RETURN'), '', { class: bill.type === 'RETURN' ? 'active' : '' }));
  const sourceInfo = bill.sourceJobId ? h('section', { class: 'card form-card' }, badge('识别候选 · 必须人工核对', 'amber'), h('p', { class: 'helper section-spacer' }, `任务 ${bill.sourceJobId} · 候选版本 ${bill.candidateVersion}`), bill.candidateIssues.length ? h('ul', { class: 'candidate-issues' }, bill.candidateIssues.map(issue => h('li', {}, issue))) : null, bill.originalMessages.length ? h('details', { class: 'history' }, h('summary', {}, '查看转发原文'), bill.originalMessages.map(message => h('div', { class: 'history-item' }, message.text || (message.type === 'IMAGE' ? '图片消息' : message.type === 'VOICE' ? '语音消息' : '无文字内容'), message.media?.length ? h('p', {}, `附件 ${message.media.length} 份，按受控媒体引用保留`) : null))) : null) : null;
  return h('div', {}, pageHeading(correction ? '更正销售单' : bill.sourceJobId ? '人工核对开单' : bill.type === 'RETURN' ? '退货开单' : '图片开单', bill.type === 'RETURN' ? '选择客户与退回商品，按该客户历史箱价取价；散瓶除以每箱瓶数并四舍五入到角。' : bill.sourceJobId ? '识别结果只是候选；补全缺项、核对价格后再确认。' : '手工填写并核对，生成可下载的正式电子单。', link('查看订单 →', '#orders', 'text-link')), modeSwitch, sourceInfo,
    bill.type === 'RETURN' ? renderReturnForm() : renderSaleForm(),
    h('div', { class: 'section-spacer' }, notice('文字 / 语音自动识别等待 Jetson 接入；当前可手工开单。锁屏提醒和原生相册能力将在 APK 接入后验证。')));
}
function renderSaleForm() {
  const customer = byId(data.customers, bill.customerId);
  const customerSelect = select([{ value: '', label: '请选择客户' }, ...data.customers.map(item => ({ value: item.id, label: `${item.name}${item.address ? ` · ${item.address}` : ''}` }))], bill.customerId, event => { bill.customerId = event.target.value; bill.items.forEach(row => invalidateBillQuote(row, !bill.correction)); resetCheck(); render(); void quoteAllBillLines(!bill.correction); });
  const credit = h('input', { type: 'text', inputMode: 'decimal', value: bill.credit, on: { input: event => { bill.credit = event.target.value; resetCheck(); } } });
  const waiver = h('input', { type: 'text', inputMode: 'decimal', value: bill.waiver, on: { input: event => { bill.waiver = event.target.value; resetCheck(); } } });
  const modeField = bill.sourceJobId ? field('开单方式', select([{ value: 'PAPER', label: '纸质开单 · 确认后登记 1 份打印' }, { value: 'ELECTRONIC', label: '电子图片 · 保存后计销，不自动打印' }], bill.mode, event => { bill.mode = event.target.value; resetCheck(); render(); }), '纸质确认即计销；PDF 准备、设备出纸单独处理。', 'full') : null;
  return h('form', { on: { submit: event => { event.preventDefault(); void submitBill(); } } }, h('section', { class: 'card form-card' }, h('div', { class: 'section-label' }, h('span', {}, '1'), '选择客户'), h('div', { class: 'form-grid' }, field('客户名称', customerSelect), field('客户地址', h('input', { value: customer?.address || '未填写地址', readOnly: true })), modeField)),
    h('section', { class: 'card form-card bill-items-card' }, h('div', { class: 'section-label' }, h('span', {}, '2'), '商品明细'), h('div', {}, bill.items.map(renderBillLine)), button([icon('plus', 16), '添加商品'], () => { addBillLine(); render(); }, 'secondary small', { disabled: bill.items.length >= 100 })),
    h('div', { class: 'form-bottom' }, h('section', { class: 'card form-card' }, h('div', { class: 'section-label' }, h('span', {}, '3'), '抵扣与备注'), h('div', { class: 'form-grid' }, field('抵扣 / 元', credit), field('抹零 / 元', waiver), field('订单备注', h('textarea', { maxLength: 2000, value: bill.note, placeholder: '例如：送货时间、换盖说明', on: { input: event => { bill.note = event.target.value; resetCheck(); } } }), null, 'full'))), renderSubmitCard()));
}
function renderReturnForm() {
  const customer = byId(data.customers, bill.customerId);
  const customerSelect = select([{ value: '', label: '请选择退货客户' }, ...data.customers.map(item => ({ value: item.id, label: `${item.name}${item.address ? ` · ${item.address}` : ''}` }))], bill.customerId, event => { bill.customerId = event.target.value; bill.items.forEach(row => invalidateBillQuote(row)); resetCheck(); render(); void quoteAllBillLines(true); });
  return h('form', { on: { submit: event => { event.preventDefault(); void submitBill(); } } }, h('section', { class: 'card form-card' }, h('div', { class: 'section-label' }, h('span', {}, '1'), '选择退货客户'), h('div', { class: 'form-grid' }, field('客户名称', customerSelect), field('客户地址', h('input', { value: customer?.address || '未填写地址', readOnly: true })))), h('section', { class: 'card form-card bill-items-card' }, h('div', { class: 'section-label' }, h('span', {}, '2'), '退货商品明细'), h('div', {}, bill.items.map(renderBillLine)), button([icon('plus', 16), '添加退货商品'], () => { addBillLine(); render(); }, 'secondary small', { disabled: bill.items.length >= 100 })), h('div', { class: 'form-bottom' }, h('section', { class: 'card form-card' }, field('退货备注', h('textarea', { maxLength: 2000, value: bill.note, placeholder: '记录退货原因或说明', on: { input: event => { bill.note = event.target.value; resetCheck(); } } })), h('div', { class: 'section-spacer' }, notice('退货单抵减销售，不改变客户以后售价。价格由历史开单记录读取，不能在退货中调价；此处记录商品退回，不办理现金退款。'))), renderSubmitCard()));
}
function customerReturnUnavailableReason() {
  return bill?.type === 'RETURN' && data.customerHistoryReturn?.canSave === false ? data.customerHistoryReturn.unavailableReason || '退货数量规则尚未确认，当前可核对预览，暂不能保存。' : '';
}
function renderSubmitCard() {
  const unavailableReason = customerReturnUnavailableReason();
  const check = h('input', { id: 'bill-checked', type: 'checkbox', checked: bill.checked, on: { change: event => { bill.checked = event.target.checked; } } });
  const label = bill.type === 'RETURN' ? '已核对客户、退货商品、数量、历史单价及包装瓶数' : '已核对客户、商品、数量和单价';
  return h('section', { class: 'card form-card bill-submit-card' }, h('div', { class: 'section-label' }, h('span', {}, bill.type === 'RETURN' ? '3' : '4'), bill.type === 'RETURN' ? '确认退货' : '核对并开单'), h('div', { id: 'bill-summary' }, summary(estimateBill(), true, bill.type === 'RETURN')), h('div', { class: 'submit-area' }, unavailableReason ? notice(unavailableReason, 'amber') : null, h('label', { class: 'check-label' }, check, label), h('button', { type: 'submit', class: 'btn', 'data-mutation': '', disabled: busy || Boolean(pending) || Boolean(unavailableReason) }, icon('check', 17), bill.correction ? '确认更正并保存' : bill.type === 'RETURN' ? '确认退货并保存图片' : bill.mode === 'PAPER' ? '核对并纸质开单' : '核对并保存图片'), h('p', { class: 'summary-note' }, bill.correction ? '保留原版本并冲回，计入更正后的结果。' : bill.type === 'RETURN' ? '正式退货图片保存成功后抵减销售；不改变客户以后售价。' : bill.mode === 'PAPER' ? '确认即一次计销；PDF 准备和实际出纸另记，不重复开销售单。' : '正式图片保存成功后计入销售；不会自动打印。')));
}
async function submitBill() {
  if (busy || pending) { if (pending) showMessage('请先核对上一笔提交结果。', true); return; }
  try {
    const unavailableReason = customerReturnUnavailableReason();
    if (unavailableReason) throw new Error(unavailableReason);
    if (!bill.checked) throw new Error('请先勾选人工核对。');
    if (bill.type === 'RETURN') {
      if (!byId(data.customers, bill.customerId) || !bill.items.length) throw new Error('请选择退货客户并添加退货商品。');
      const items = bill.items.map(row => {
        if (!byId(data.products, row.skuId) || !['箱', '瓶'].includes(row.unit) || !byId(data.products, row.skuId).units.includes(row.unit)) throw new Error('请逐行选择退货商品及箱或瓶单位。');
        if (row.quoteLoading || row.quoteError || !row.quote) throw new Error('历史成交价尚未读取，请稍候或重新选择商品重试。');
        if (!['HISTORY_CASE', 'HISTORY_CASE_DERIVED'].includes(row.quote.source) || row.quote.priceCents == null || !row.quote.version) throw new Error(returnPriceDescription(row.quote));
        if (row.quote.requiresPackagingConfirmation && !row.packagingConfirmed) throw new Error('请逐行核对并确认每箱瓶数。');
        const priceCents = parseCents(row.price, '退货单价');
        if (priceCents !== row.quote.priceCents) throw new Error('退货价格与历史报价不一致，请重新取价核对。');
        return { skuId: row.skuId, unit: row.unit, quantity: parseQuantity(row.quantity), priceCents, returnPriceVersion: row.quote.version, ...(row.quote.requiresPackagingConfirmation ? { packagingConfirmed: Boolean(row.packagingConfirmed) } : {}) };
      });
      await mutate('/api/returns', { operationId: operationId(), returnBasis: 'CUSTOMER_HISTORY', checked: true, customerId: bill.customerId, items, note: bill.note }, '退货单正式图片已保存，已抵减销售，原客户售价保持。');
      return;
    }
    if (!bill.customerId || !bill.items.length) throw new Error('请选择客户并添加商品。');
    const items = bill.items.map(row => {
      if (!byId(data.products, row.skuId)) throw new Error('请逐行选择正式商品，不能用未识别商品自动开单。');
      if (!byId(data.products, row.skuId).units.includes(row.unit)) throw new Error('请逐行选择商品计价单位。');
      if (row.quoteLoading || !row.quote) throw new Error('商品客户价尚未读取，请稍候或重新选择商品重试。');
      const priceCents = parseCents(row.price, '商品单价');
      if (priceCents === 0 && !row.zeroConfirmed) throw new Error('0 元商品需要逐行明确确认。');
      return { ...(row.lineId ? { lineId: row.lineId } : {}), skuId: row.skuId, unit: row.unit, quantity: parseQuantity(row.quantity), priceCents, priceVersion: row.quote.version, manualPrice: row.manualPrice || Boolean(bill.correction), zeroConfirmed: row.zeroConfirmed };
    });
    const payload = { operationId: operationId(), customerId: bill.customerId, items, creditCents: parseCents(bill.credit, '抵扣'), waiverCents: parseCents(bill.waiver, '抹零'), note: bill.note };
    if (bill.correction) { payload.expectedRevision = bill.correction.expectedRevision; await mutate(`/api/orders/${encodeURIComponent(bill.correction.orderId)}/corrections`, payload, '更正已保存，前后版本已保留，旧销售已冲回。'); }
    else {
      payload.checked = true; payload.mode = bill.mode;
      if (bill.sourceJobId) { payload.sourceJobId = bill.sourceJobId; payload.candidateVersion = bill.candidateVersion; }
      await mutate('/api/sales', payload, bill.mode === 'PAPER' ? '纸质销售单已确认，已计销一次；请独立准备套打 PDF，再由真实设备处理。' : '正式图片已保存，已确认计销一次。');
    }
  } catch (error) { showMessage(error.message, true); }
}
function beginCorrection(order) {
  reviewGeneration += 1; loadingReviewJobId = null;
  bill = newBill(); bill.customerId = order.customerId; bill.credit = (order.totals.creditCents / 100).toFixed(2); bill.waiver = (order.totals.waiverCents / 100).toFixed(2); bill.note = order.note || ''; bill.correction = { orderId: order.id, expectedRevision: order.revision };
  bill.items = order.items.map(item => ({ key: operationId(), lineId: item.lineId, skuId: item.skuId, unit: item.unit, quantity: String(item.quantity), price: (item.priceCents / 100).toFixed(2), quote: null, manualPrice: false, zeroConfirmed: item.priceCents === 0, quoteLoading: false }));
  navigate('create'); void quoteAllBillLines(false);
}
function makeMasterEditor(kind, record = null) {
  return { kind, id: record?.id ?? null, expectedVersion: String(record?.version ?? 1), name: record?.name ?? '', address: record?.address ?? '', contact: record?.contact ?? '', phone: record?.phone ?? '', aliasesText: (record?.aliases ?? []).join('\n'), units: [...(record?.units ?? ['箱', '瓶'])], bottlesPerCase: String(record?.bottlesPerCase ?? 24) };
}
async function saveMaster() {
  const editor = masterEditor;
  if (busy || pending || !editor) return;
  try {
    if (!editor.name.trim()) throw new Error('请填写名称。');
    const payload = { operationId: operationId(), name: editor.name.trim() };
    if (editor.id) { payload.id = editor.id; payload.expectedVersion = editor.expectedVersion; }
    if (editor.kind === 'customers') {
      if (!editor.address.trim()) throw new Error('请填写客户地址，用于区分同名客户。');
      Object.assign(payload, { address: editor.address.trim(), contact: editor.contact.trim(), phone: editor.phone.trim(), aliases: editor.aliasesText.split(/[\n,，]/).map(value => value.trim()).filter(Boolean) });
    } else {
      if (!editor.units.length) throw new Error('请至少选择一个计价单位。');
      Object.assign(payload, { units: [...editor.units], bottlesPerCase: parseQuantity(editor.bottlesPerCase) });
    }
    await mutate(`/api/${editor.kind}`, payload, editor.kind === 'customers' ? '客户资料已保存；同名客户按地址区分。' : '商品资料已保存，包装修改只影响后续派生价。');
  } catch (error) { showMessage(error.message, true); }
}
function renderMasters() {
  masterEditor ??= makeMasterEditor('customers');
  const editor = masterEditor;
  const customers = editor.kind === 'customers';
  const inputFor = (key, attrs = {}) => h('input', { value: editor[key], on: { input: event => { editor[key] = event.target.value; } }, ...attrs });
  const choose = id => { masterEditor = makeMasterEditor(editor.kind, byId(data[editor.kind], id) ?? null); render(); };
  const options = [{ value: '', label: customers ? '＋ 新增客户' : '＋ 新增商品' }, ...data[editor.kind].map(item => ({ value: item.id, label: customers ? `${item.name} · ${item.address || '地址未填'}` : item.name }))];
  const fields = customers ? [field('客户地址', inputFor('address', { required: true, maxLength: 500 }), '同名客户以地址区分。'), field('联系人', inputFor('contact', { maxLength: 100 })), field('联系电话', inputFor('phone', { type: 'tel', maxLength: 100 })), field('常用别名', h('textarea', { value: editor.aliasesText, placeholder: '每行一个，例如：好运店', on: { input: event => { editor.aliasesText = event.target.value; } } }), '不同客户可有相同别名；有歧义时必须人工选择。', 'full')] : [field('每箱瓶数', inputFor('bottlesPerCase', { type: 'number', inputMode: 'numeric', min: 1, step: 1, required: true }), '用于箱价拆瓶并四舍五入到角。'), h('div', { class: 'field full' }, h('span', {}, '可用计价单位'), h('div', { class: 'unit-options' }, ['箱', '瓶'].map(unit => h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: editor.units.includes(unit), on: { change: event => { editor.units = event.target.checked ? [...new Set([...editor.units, unit])] : editor.units.filter(value => value !== unit); } } }), unit))))];
  return h('div', {}, pageHeading('客户与商品', '维护正式主档；重名保留、版本冲突时重新核对。', link('客户调价 →', '#prices', 'text-link')), h('div', { class: 'segmented', role: 'group', 'aria-label': '主档类别' }, button('客户资料', () => { masterEditor = makeMasterEditor('customers'); render(); }, '', { class: customers ? 'active' : '' }), button('商品资料', () => { masterEditor = makeMasterEditor('products'); render(); }, '', { class: customers ? '' : 'active' })),
    h('section', { class: 'card form-card' }, field(customers ? '选择客户或新增' : '选择商品或新增', select(options, editor.id ?? '', event => choose(event.target.value))), h('div', { class: 'detail-actions section-spacer' }, button(customers ? '新增客户' : '新增商品', () => choose(''), 'secondary small'), editor.id ? button('重新载入当前记录', async () => { try { await refresh(false); if (masterEditor !== editor) return; choose(editor.id); clearMessage(); } catch (error) { showMessage(error.message, true); } }, 'ghost') : null), editor.id ? h('p', { class: 'helper section-spacer' }, `记录 ${editor.id} · 当前编辑版本 ${editor.expectedVersion}`) : null),
    h('form', { class: 'card form-card', on: { submit: event => { event.preventDefault(); void saveMaster(); } } }, h('fieldset', { class: 'master-fieldset', disabled: busy || Boolean(pending) }, h('div', { class: 'section-label' }, editor.id ? '修改资料' : customers ? '新增客户' : '新增商品'), h('div', { class: 'form-grid' }, field(customers ? '客户名称' : '商品名称', inputFor('name', { required: true, maxLength: 200 })), fields), h('div', { class: 'detail-actions section-spacer' }, h('button', { type: 'submit', class: 'btn', 'data-mutation': '', disabled: busy || Boolean(pending) }, '保存资料')))), notice(customers ? '这里维护客户身份和别名，不会授权其成为转单人或管理账号。版本冲突时保留当前填写内容，点击“重新载入当前记录”后再核对。' : '包装和单位修改影响后续取价；已确认订单和单据保持冻结。当前不开放删除历史商品或改动历史单。'));
}
function renderPrices() {
  if (!priceEditor) {
    priceEditor = { customerId: data.customers[0]?.id ?? '', skuId: data.products[0]?.id ?? '', unit: data.products[0]?.units[0] ?? '箱', quote: null, price: '', loading: false };
    queueMicrotask(() => loadPrice());
  }
  const editor = priceEditor;
  const product = byId(data.products, editor.skuId);
  const reload = () => { editor.quote = null; editor.price = ''; void loadPrice(); render(); };
  const priceInput = h('input', { type: 'text', inputMode: 'decimal', value: editor.price, 'aria-label': '编辑客户单价', placeholder: '输入新单价', disabled: editor.loading || !editor.quote, on: { input: event => { editor.priceEditGeneration = (editor.priceEditGeneration ?? 0) + 1; editor.price = event.target.value; } } });
  const step = direction => { try { const value = Math.max(0, parseCents(priceInput.value || '0') + direction * 100); editor.priceEditGeneration = (editor.priceEditGeneration ?? 0) + 1; editor.price = (value / 100).toFixed(2); priceInput.value = editor.price; } catch (error) { showMessage(error.message, true); } };
  const save = async () => { try { if (!editor.quote) throw new Error('请先读取当前价格。'); const priceCents = parseCents(editor.price, '客户价'); if (!priceCents) throw new Error('常规客户价不能保存为 0。0 元商品请在开单时单独确认。'); await mutate('/api/prices/save', { operationId: operationId(), customerId: editor.customerId, skuId: editor.skuId, unit: editor.unit, priceCents, expectedVersion: editor.quote.version }, '客户价已保存，后续开单按新价读取。'); } catch (error) { showMessage(error.message, true); } };
  const restore = async () => { if (!editor.quote?.canRestore) return; await mutate('/api/prices/restore', { operationId: operationId(), customerId: editor.customerId, skuId: editor.skuId, unit: editor.unit, expectedVersion: editor.quote.version }, '已恢复至最近一次调价前有效价，原调价记录保留。'); };
  return h('div', {}, pageHeading('客户价格', '按客户、商品和单位保存价格，已确认历史单保持原样。', link('客户与商品 →', '#masters', 'text-link')), h('div', { class: 'price-editor' }, h('section', { class: 'card form-card' }, h('div', { class: 'section-label' }, h('span', {}, '1'), '选择客户与商品'), h('div', { class: 'form-grid' }, field('客户名称', select(data.customers.map(item => ({ value: item.id, label: [item.name, item.address].filter(Boolean).join(' · ') })), editor.customerId, event => { editor.customerId = event.target.value; reload(); })), field('商品名称', select(data.products.map(item => ({ value: item.id, label: item.name })), editor.skuId, event => { editor.skuId = event.target.value; editor.unit = byId(data.products, editor.skuId).units[0]; reload(); })), field('计价单位', select((product?.units ?? []).map(value => ({ value, label: value })), editor.unit, event => { editor.unit = event.target.value; reload(); })))),
      h('section', { class: 'card form-card' }, h('div', { class: 'section-label' }, h('span', {}, '2'), '调整客户售价'), h('div', { class: 'price-display' }, h('div', {}, h('div', { class: 'price-label' }, '当前有效单价'), h('div', { class: 'price-current' }, editor.loading ? '读取中…' : editor.quote?.priceCents == null ? '暂无价格' : `¥${money(editor.quote.priceCents)}`, h('small', {}, ` / ${editor.unit}`))), badge(editor.quote?.source === 'CASE_DERIVED' ? '箱价拆瓶 · 到角' : editor.quote?.source === 'MISSING' ? '待人工建价' : '客户有效价', editor.quote?.source === 'MISSING' ? 'amber' : '')),
        h('div', { class: 'price-label' }, '新单价 / 元'), h('div', { class: 'stepper' }, button('−1', () => step(-1), '', { 'aria-label': '单价减1元', disabled: editor.loading || !editor.quote }), priceInput, button('＋1', () => step(1), '', { 'aria-label': '单价加1元', disabled: editor.loading || !editor.quote })), h('p', { class: 'helper' }, '加减按钮每次 1 元；点击保存后生效。'), h('div', { class: 'price-buttons section-spacer' }, button('保存新价格', save, '', { 'data-mutation': '', disabled: busy || editor.loading || !editor.quote || Boolean(pending) }), button(editor.quote?.canRestore ? `小恢复 · ¥${money(editor.quote.restorePriceCents)}` : '小恢复 · 暂无前价', restore, 'secondary small', { 'data-mutation': '', disabled: busy || !editor.quote?.canRestore || Boolean(pending) }))), notice('小恢复回到最近一次已保存调价前的有效价，并保留新事件。不会修改历史单，也不会把其他客户的价格一起改动。')));
}
async function loadPrice() {
  const editor = priceEditor; if (!editor?.customerId || !editor.skuId) return;
  const identity = `${editor.customerId}:${editor.skuId}:${editor.unit}`;
  const requestGeneration = (editor.requestGeneration ?? 0) + 1;
  const priceEditGeneration = editor.priceEditGeneration ?? 0;
  editor.requestIdentity = identity; editor.requestGeneration = requestGeneration; editor.loading = true;
  const isCurrent = () => priceEditor === editor && editor.requestIdentity === identity && editor.requestGeneration === requestGeneration;
  try {
    const quote = await request(`/api/prices?${new URLSearchParams({ customerId: editor.customerId, skuId: editor.skuId, unit: editor.unit })}`);
    if (!isCurrent()) return;
    editor.quote = quote;
    if ((editor.priceEditGeneration ?? 0) === priceEditGeneration) editor.price = quote.priceCents == null ? '' : (quote.priceCents / 100).toFixed(2);
  } catch (error) { if (isCurrent()) showMessage(error.message, true); }
  finally { if (isCurrent()) { editor.loading = false; if (route === 'prices') render(); } }
}
function candidateFields(item, products) {
  const product = byId(products, item?.skuId);
  return { skuId: product?.id ?? '', unit: product?.units.includes(item?.unit) ? item.unit : '', quantity: Number.isSafeInteger(item?.quantity) && item.quantity > 0 ? String(item.quantity) : '', candidateProductName: typeof item?.productName === 'string' ? item.productName : '' };
}
async function openReviewJob(jobId) {
  const generation = ++reviewGeneration; loadingReviewJobId = jobId; clearMessage(); render();
  try {
    const result = await request(`/api/review-jobs/${encodeURIComponent(jobId)}`);
    if (generation !== reviewGeneration || route !== 'pending') return;
    if (result.sourceJobId !== jobId || typeof result.candidateVersion !== 'string' || !result.candidateVersion || !Array.isArray(result.draft?.items)) throw new Error('候选草稿不完整，暂不能进入确认。请刷新待核状态。');
    const next = newBill(); next.mode = 'PAPER';
    next.customerId = byId(data.customers, result.draft.customerId)?.id ?? '';
    next.sourceJobId = result.sourceJobId; next.candidateVersion = result.candidateVersion;
    next.candidateIssues = Array.isArray(result.issues) ? result.issues.filter(issue => typeof issue === 'string') : [];
    next.originalMessages = Array.isArray(result.originalMessages) ? result.originalMessages : [];
    next.items = result.draft.items.map(item => ({ key: operationId(), ...candidateFields(item, data.products), price: '', quote: null, manualPrice: false, zeroConfirmed: false, quoteLoading: false }));
    bill = next; navigate('create'); void quoteAllBillLines(true);
  } catch (error) { if (generation === reviewGeneration) showMessage(error.message, true); }
  finally { if (generation === reviewGeneration) { loadingReviewJobId = null; if (route === 'pending') render(); } }
}
function renderBatches() {
  const batches = [...data.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cards = batches.map(batch => {
    const job = data.jobs.find(row => row.batchId === batch.id);
    const needsReview = job?.status === 'AWAITING_REVIEW';
    const status = needsReview ? '识别候选 · 待人工核对' : job?.status === 'REVIEWED' ? '已人工核对开单' : job?.status === 'WAITING_EDGE' ? '等待 Jetson 识别' : job?.status === 'LEASED' ? '设备识别处理中' : batch.status === 'OPEN' ? batch.deadline ? '正在组单' : '等待商品消息' : '批次已封存';
    return h('section', { class: 'card batch-card' }, h('div', { class: 'batch-head' }, h('h3', {}, batch.customerHint || '待识别客户'), badge(status, needsReview || job?.status !== 'REVIEWED' ? 'amber' : '')), h('p', { class: 'batch-meta' }, `${dateText(batch.createdAt)} · ${batch.productCount ?? 0} 条商品消息`, h('br'), batch.deadline && batch.status === 'OPEN' ? `静默截止：${dateText(batch.deadline)}` : job ? `识别任务：${job.id}` : '暂无识别任务'), needsReview ? h('div', { class: 'detail-actions section-spacer' }, button(loadingReviewJobId === job.id ? '正在读取候选…' : '人工核对开单', () => openReviewJob(job.id), '', { disabled: loadingReviewJobId !== null || busy || Boolean(pending) })) : job?.reviewOrderId && byId(data.orders, job.reviewOrderId) ? h('div', { class: 'detail-actions section-spacer' }, button('查看已确认单', () => openOrder(byId(data.orders, job.reviewOrderId)), 'secondary small')) : null, h('div', { class: 'section-spacer' }, notice(needsReview ? '识别候选尚未计销。进入核对页补齐客户、商品、单位、数量和价格，再明确确认；不会自动开单。' : job?.status === 'WAITING_EDGE' ? '消息已存云端并完成组单，尚未收到设备识别结果，暂不能确认销售。' : '组单和识别本身不计销、不打印。已确认结果保留任务与订单关联。')));
  });
  const sampleCount = data.sampleCount ?? data.correctionSampleCount;
  return h('div', {}, pageHeading('待核订单', '先识别，再由老板核对；缺少真实识别结果时保持等待。', button('刷新状态', () => refresh().catch(error => showMessage(error.message, true)), 'secondary')), cards.length ? cards : h('section', { class: 'card' }, empty('暂时没有收单批次。企业微信实际收单与 Jetson 识别尚待接入。', 'pending')), typeof sampleCount === 'number' ? h('div', { class: 'section-spacer' }, notice(`已记录纠错样本 ${sampleCount} 条。样本记录不代表模型已训练或上线。`)) : null, h('div', { class: 'section-spacer' }, notice('图片、语音及真实纠错训练仍在首期范围。此页显示服务端实际批次，不用预设文字模拟模型识别结果。')));
}
const defaultScreens = { home: renderHome, orders: renderOrders, create: renderCreate, prices: renderPrices, masters: renderMasters, pending: renderBatches, printing: renderPrinting };
function selectPriceCustomer(customerId) {
  if (!byId(data.customers, customerId)) return;
  priceEditor ??= { skuId: data.products[0]?.id ?? '', unit: data.products[0]?.units[0] ?? '箱', price: '', quote: null, loading: false };
  priceEditor.customerId = customerId; priceEditor.quote = null; priceEditor.price = '';
  void loadPrice(); render();
}
export const ui = Object.freeze({
  h, icon, button, link, badge, notice, money, dateText, byId, card, empty,
  navigate, openOrder, beginSale, beginCorrection, refresh, showMessage, clearMessage, retryPending, resetCheck,
  rerender: render,
  state: () => ({ data, route, detailOrderId, bill, priceEditor, masterEditor, statsQuery, orderQuery, busy, pending }),
  printStatus,
  statsControls: renderStatsControls,
  ensureStats: () => { if (statsQuery.period !== 'all' && !statsQuery.result && !statsQuery.loading && !statsQuery.error) void loadPeriodStats(); },
  billEstimate: estimateBill,
  summary,
  selectPriceCustomer,
  editMaster: (kind, id = null) => { if (!['customers', 'products'].includes(kind)) return; masterEditor = makeMasterEditor(kind, byId(data[kind], id) ?? null); },
  masterForm: () => renderMasters().querySelector('form'),
  customerOrders: customerId => { orderQuery.customerId = customerId; orderQuery.from = ''; orderQuery.to = ''; orderFilter = 'ALL'; void loadOrderQuery(); navigate('orders'); },
  beginReturn,
});
export function startApp(options = {}) {
  if (started) return;
  started = true; presentation = options.presentation ?? null;
  document.querySelector('#date-label').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  document.querySelector('#refresh-button').addEventListener('click', async event => { event.currentTarget.disabled = true; try { await refresh(); showMessage('数据已刷新。'); } catch (error) { showMessage(error.message, true); } finally { event.currentTarget.disabled = false; } });
  window.addEventListener('hashchange', () => { const target = location.hash.slice(1); if (availableRoutes()[target]) { if (target !== route) { detailOrderId = null; if (loadingReviewJobId) { reviewGeneration += 1; loadingReviewJobId = null; } } route = target; clearMessage(); render(); window.scrollTo({ top: 0 }); } });
  route = availableRoutes()[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  renderPending();
  refresh().catch(error => { main.replaceChildren(h('section', { class: 'card form-card' }, h('h2', {}, '工作台暂未连接'), h('p', { class: 'helper section-spacer' }, error.message), button('重新连接', () => location.reload(), 'secondary section-spacer'))); });
  setInterval(() => { if (!busy && !document.hidden && ['home', 'pending'].includes(route)) refresh().catch(() => {}); }, 20000);
}
if (document.body.dataset.presentation !== 'mobile') startApp();
