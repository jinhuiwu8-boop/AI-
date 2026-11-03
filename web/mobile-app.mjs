import { startApp, ui } from '/app.mjs';

const { h, icon, button, badge, notice, money, dateText, byId } = ui;
const titles = { home: '工作台', orders: '销售订单', mine: '我的', create: '图片开单', pending: '待人工确认', prices: '客户管理', masters: '客户与商品', printing: '打印任务' };
let customerSearch = '';
let customerModal = null;
const billTextDrafts = new WeakMap();
const masterFingerprint = master => JSON.stringify(master);

function orderCard(order) {
  return h('article', { class: 'phone-order-card' }, h('div', { class: 'phone-order-head' }, h('strong', {}, order.customerName), badge(order.type === 'RETURN' ? '退货单' : '已确认销售', order.type === 'RETURN' ? 'return' : '')), h('p', { class: 'phone-order-date' }, `${dateText(order.createdAt)} · 版本 ${order.revision}`), h('div', { class: 'phone-order-values' }, h('span', {}, `${order.items.length} 项商品`), h('span', {}, order.type === 'RETURN' ? '退货抵减 ' : '本单应收 ', h('strong', {}, `${order.type === 'RETURN' ? '−' : ''}¥${money(order.totals.receivableCents)}`))), h('div', { class: 'phone-order-footer' }, h('span', {}, ui.printStatus(order)), button('查看订单 ›', () => ui.openOrder(order), 'ghost')));
}
function statsBlock() {
  ui.ensureStats();
  const state = ui.state(); const query = state.statsQuery;
  const stats = query.period === 'all' ? state.data.stats : query.result;
  const label = query.period === 'all' ? '累计净销售' : query.period === 'month' ? '所选月净销售' : '所选日净销售';
  return h('section', { class: 'phone-stats-section' }, ui.statsControls(), h('div', { class: 'phone-sales-card' }, h('span', {}, label), h('strong', {}, stats ? `¥${money(stats.netSalesCents)}` : '—'), h('small', {}, query.loading ? '正在读取统计…' : query.error || '按实际销售、更正冲回和退货记录统计')), stats && query.period !== 'all' ? h('div', { class: 'phone-stat-details' }, h('span', {}, `销售 ¥${money(stats.salesCents)}`), h('span', {}, `冲回 ¥${money(stats.reversalCents)}`), h('span', {}, `退货 ¥${money(stats.returnCents)}`)) : null);
}
function home() {
  const { data } = ui.state();
  const pending = data.jobs.filter(job => job.status === 'AWAITING_REVIEW').length;
  const waiting = data.jobs.filter(job => job.status === 'WAITING_EDGE').length;
  const prints = data.printAttempts.filter(attempt => ['PENDING_DEVICE', 'SUBMIT_INTENT', 'SPOOLER_ACCEPTED', 'UNCERTAIN'].includes(attempt.status)).length;
  const recent = [...data.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  return h('div', {}, h('div', { class: 'phone-date' }, document.querySelector('#date-label').textContent), h('div', { class: 'phone-priority-grid' }, button([h('span', {}, '待人工确认'), h('strong', {}, pending), h('small', {}, `${waiting} 个等待识别`)], () => ui.navigate('pending'), '', { class: 'phone-priority-card' }), button([h('span', {}, '打印需处理'), h('strong', {}, prints), h('small', {}, '出纸结果单独确认')], () => ui.navigate('printing'), '', { class: 'phone-priority-card' })), button([icon('image', 23), h('strong', {}, '图片开单'), h('span', { class: 'row-arrow' }, '›')], ui.beginSale, '', { class: 'phone-create-entry' }), button([icon('customers', 18), '查客户'], () => ui.navigate('prices'), 'secondary full-width'), h('div', { class: 'phone-section-title' }, h('h2', {}, '最近确认订单'), button('全部 ›', () => ui.navigate('orders'), 'ghost')), recent.length ? recent.map(orderCard) : ui.empty('暂无已确认订单。可从图片开单手工填写。'));
}
function menuRow(label, symbol, action, statusText = '') {
  const content = [h('span', { class: 'phone-menu-icon' }, symbol), h('span', { class: 'phone-menu-label' }, label), statusText ? h('small', {}, statusText) : h('span', { class: 'row-arrow' }, '›')];
  return action ? h('button', { type: 'button', class: 'phone-menu-row', on: { click: action } }, content) : h('div', { class: 'phone-menu-row pending-menu' }, content);
}
function mine() {
  const { data } = ui.state(); const samples = data.correctionSampleCount ?? data.sampleCount;
  return h('div', {}, h('section', { class: 'phone-menu-card' }, menuRow('客户管理', '客', () => ui.navigate('prices')), menuRow('商品资料', '品', () => { ui.editMaster('products'); ui.navigate('masters'); }), menuRow('打印任务', '印', () => ui.navigate('printing'))), h('section', { class: 'phone-menu-card' }, menuRow('识别与训练', '学', null, typeof samples === 'number' ? `已记 ${samples} 条样本 · 训练待接` : '真实训练待接入'), menuRow('允许谁转单', '转', null, '企业微信身份绑定待接'), menuRow('账号安全', '安', null, '单设备与系统认证待接'), menuRow('搭赠实物记录', '赠', null, '后续阶段')), notice('当前是本地老板开发会话。页面保存、样本记录、PDF 生成不代表生产登录、模型训练或真实出纸已完成。'), h('section', { class: 'card form-card section-spacer' }, h('h2', {}, '连接状态'), h('p', { class: 'helper section-spacer' }, `已登记设备 ${data.devices.length} 台；登记不等于在线。华为锁屏提醒、系统认证和原生相册仍待实际接入。`), button('刷新状态', () => ui.refresh().catch(error => ui.showMessage(error.message, true)), 'secondary full-width section-spacer')));
}
function openCustomerModal(record = null) {
  ui.clearMessage(); ui.editMaster('customers', record?.id ?? null);
  const master = ui.state().masterEditor;
  customerModal = { id: master.id, version: master.expectedVersion, original: masterFingerprint(master) };
  ui.rerender();
}
function closeCustomerModal() {
  if (!customerModal) return;
  if (ui.state().busy || ui.state().pending) { ui.showMessage('请先确认当前保存结果，再关闭客户表单。', true); return; }
  if (masterFingerprint(ui.state().masterEditor) !== customerModal.original && !window.confirm('客户资料尚未保存，确定关闭这次填写吗？')) return;
  customerModal = null; document.body.classList.remove('has-modal'); ui.rerender();
}
function customerBrowser() {
  const { data, priceEditor } = ui.state();
  const chosen = byId(data.customers, priceEditor?.customerId);
  const rows = h('div', { class: 'phone-customer-rows' });
  const updateRows = () => {
    const query = customerSearch.trim().toLowerCase();
    const customers = data.customers.filter(customer => !query || [customer.name, customer.address, customer.contact, customer.phone, ...(customer.aliases ?? [])].filter(Boolean).join(' ').toLowerCase().includes(query));
    rows.replaceChildren(...customers.map(customer => button([h('strong', {}, customer.name), h('small', {}, [customer.contact, customer.address].filter(Boolean).join(' · '))], () => ui.selectPriceCustomer(customer.id), '', { class: `phone-customer-row${customer.id === chosen?.id ? ' selected' : ''}` })));
    if (!customers.length) rows.append(ui.empty('没有符合条件的客户。'));
  };
  updateRows();
  return h('div', { class: 'phone-customer-browser' }, h('section', { class: 'card form-card' }, h('div', { class: 'phone-section-title compact' }, h('h2', {}, '客户列表'), button('＋ 新增', () => openCustomerModal(), 'ghost')), h('input', { type: 'search', value: customerSearch, placeholder: '搜索客户、联系人或常用名', 'aria-label': '搜索客户', on: { input: event => { customerSearch = event.target.value; updateRows(); } } }), rows), chosen ? h('section', { class: 'card form-card phone-customer-detail' }, h('div', { class: 'phone-section-title compact' }, h('h2', {}, chosen.name), button('修改资料', () => openCustomerModal(chosen), 'ghost')), h('p', { class: 'helper' }, [chosen.contact, chosen.phone].filter(Boolean).join(' · ') || '未填写联系人电话'), h('div', { class: 'phone-address' }, h('small', {}, '默认送货地址'), h('p', {}, chosen.address || '未填写地址')), h('div', { class: 'detail-actions' }, button('该客户的开单记录 ›', () => ui.customerOrders(chosen.id), 'secondary full-width'))) : null);
}
function customerDialog() {
  if (!customerModal) return null;
  const { masterEditor, pending, busy } = ui.state();
  if (masterEditor?.kind !== 'customers') { customerModal = null; return null; }
  if ((!customerModal.id && masterEditor.id) || (customerModal.id && masterEditor.id === customerModal.id && masterEditor.expectedVersion !== customerModal.version)) { customerModal = null; return null; }
  const form = ui.masterForm();
  const grid = form.querySelector('.form-grid');
  const fields = [...grid.children];
  if (fields.length === 5) grid.replaceChildren(fields[0], fields[2], fields[3], fields[1], fields[4]);
  const save = form.querySelector('button[type="submit"]'); if (save) save.textContent = '保存客户';
  const message = document.querySelector('#message');
  return h('div', { class: 'phone-modal-backdrop', on: { click: event => { if (event.target === event.currentTarget) closeCustomerModal(); } } }, h('section', { class: 'phone-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'customer-modal-title' }, h('div', { class: 'phone-section-title compact' }, h('div', {}, h('small', { class: 'helper' }, '正式客户主档 · 编号由系统生成'), h('h2', { id: 'customer-modal-title' }, customerModal.id ? '修改客户' : '新增客户')), button('×', closeCustomerModal, 'secondary small', { 'aria-label': '关闭客户表单' })), !message.hidden ? notice(message.textContent, message.classList.contains('error') ? 'amber' : 'green') : null, pending ? h('div', { class: 'section-spacer' }, notice('上次提交结果尚待确认，请核对同一请求。重试不会重新开一笔业务。', 'amber'), button('查询 / 重试原请求', ui.retryPending, 'secondary full-width section-spacer', { 'data-mutation': '', disabled: busy })) : null, form, button('取消', closeCustomerModal, 'secondary full-width')));
}
function inputDraft() {
  const { bill } = ui.state();
  return h('section', { class: 'card form-card phone-input-card' }, h('h2', {}, '开单内容'), h('p', { class: 'helper' }, '文字输入仅作当前单的临时草稿，尚未识别。'), h('textarea', { value: billTextDrafts.get(bill) ?? '', placeholder: '可先记录客户和商品文字，再在下方手工核对明细。', 'aria-label': '开单文字草稿（未识别）', on: { input: event => { billTextDrafts.set(bill, event.target.value); ui.resetCheck(); } } }), h('div', { class: 'phone-input-actions' }, button('识别并填写 · 待接入', () => {}, 'secondary', { disabled: true }), button('按住说话 · 待接入', () => {}, 'secondary', { disabled: true })), h('p', { class: 'helper' }, '文字不会自动填商品，也不会写进备注或正式单。录音与识别尚未接入；请核对下方明细后保存。浏览器刷新会清空未保存草稿。'));
}
function billPreview() {
  const { bill, data } = ui.state();
  const hasFields = bill.customerId && bill.items.length && bill.items.every(item => item.skuId && item.unit && item.quantity !== '' && item.price !== '' && item.quote);
  return h('section', { class: 'card form-card phone-draft-preview' }, h('h2', {}, bill.type === 'RETURN' ? '退货图片预览' : '开单图片预览'), h('p', { class: 'helper' }, '尚未保存 · 以下为核对草稿，正式图片在保存成功后生成。'), h('div', { class: 'phone-draft-paper' }, h('strong', {}, byId(data.customers, bill.customerId)?.name ?? '待选客户'), bill.items.map(item => h('div', { class: 'phone-draft-row' }, h('span', {}, byId(data.products, item.skuId)?.name ?? item.candidateProductName ?? '待选商品'), h('span', {}, `${item.quantity || '—'}${item.unit || '待选单位'}`))), hasFields ? ui.summary(ui.billEstimate(), true, bill.type === 'RETURN') : h('p', { class: 'helper section-spacer' }, '客户、商品、数量、单位和价格待核对；未生成正式图片。')));
}
function refreshBillPreview() {
  const { route, bill } = ui.state();
  if (route !== 'create' || !['SALE', 'RETURN'].includes(bill?.type)) return;
  const preview = document.querySelector('.phone-draft-preview');
  if (preview) preview.replaceWith(billPreview());
}
function decorate(route, screen) {
  if (route === 'prices') {
    const editor = screen.querySelector('.price-editor');
    if (editor) { editor.before(customerBrowser()); const label = editor.querySelector('.section-label'); if (label) label.textContent = '该客户的商品开价'; }
  }
  if (route === 'create' && ['SALE', 'RETURN'].includes(ui.state().bill?.type)) {
    const form = screen.querySelector('form'); const submitArea = form?.querySelector('.bill-submit-card .submit-area');
    if (submitArea) submitArea.prepend(billPreview());
    if (form && ui.state().bill.type === 'SALE' && !ui.state().bill.sourceJobId && !ui.state().bill.correction) form.prepend(inputDraft());
  }
  const dialog = route === 'prices' ? customerDialog() : null;
  document.body.classList.toggle('has-modal', Boolean(dialog));
  if (dialog) screen.append(dialog);
}
function renderNavigation() {
  const { route, detailOrderId, bill } = ui.state();
  document.body.dataset.route = route;
  const title = route === 'orders' && detailOrderId ? '订单详情' : route === 'create' && bill?.type === 'RETURN' ? '退货开单' : route === 'create' && bill?.correction ? '更正销售单' : titles[route] ?? '店内打单';
  document.querySelector('#mobile-title').textContent = title;
  const back = document.querySelector('#mobile-back');
  back.hidden = ['home', 'mine'].includes(route) || (route === 'orders' && !detailOrderId);
  const selected = ['home', 'create', 'pending'].includes(route) ? 'home' : route === 'orders' ? 'orders' : 'mine';
  document.querySelector('#phone-nav').replaceChildren(...[['home', '工作台', 'home'], ['orders', '订单', 'orders'], ['mine', '我的', 'customers']].map(([key, label, glyph]) => h('a', { href: `#${key}`, class: `phone-tab${selected === key ? ' active' : ''}`, ...(selected === key ? { 'aria-current': 'page' } : {}) }, icon(glyph, 22), h('span', {}, label))));
}
document.querySelector('#mobile-back').addEventListener('click', () => {
  const { route, detailOrderId } = ui.state();
  ui.navigate(route === 'orders' && detailOrderId ? 'orders' : ['create', 'pending'].includes(route) ? 'home' : 'mine');
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && customerModal) closeCustomerModal(); });
startApp({ presentation: {
  routes: { mine: ['我的', 'customers'] },
  usesPeriodStats: ['orders'], showProductName: true, renderNavigation, renderers: { home, mine }, decorate, refreshBillPreview,
  pageHeading: ({ subtitle, action }) => h('div', { class: 'phone-screen-note' }, h('p', {}, subtitle), action),
  orderIntro: statsBlock,
  orderResults: (orders, state) => orders.length ? h('div', {}, orders.map(orderCard)) : ui.empty(state.loading ? '正在读取订单…' : state.error || '暂无已确认订单。'),
} });
