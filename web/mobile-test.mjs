const routes = new Map([
  ['home', '工作台'], ['orders', '销售订单'], ['create', '图片开单'], ['pending', '待核订单'],
  ['prices', '客户价格'], ['masters', '客户与商品'], ['printing', '打印任务'], ['mine', '我的'],
]);
const frame = document.querySelector('#phone-frame');
const phoneArea = document.querySelector('#phone-area');
const phoneFit = document.querySelector('#phone-fit');
const moduleButtons = [...document.querySelectorAll('[data-route]')];
const status = document.querySelector('#connection-status');
const currentModule = document.querySelector('#current-module');
const viewportInfo = document.querySelector('#viewport-info');
const openPhone = document.querySelector('#open-phone');
let width = 430;
let scale = 100;
let displayMode = 'fit';
let currentRoute = 'home';
let attachedWindow = null;
let ready = false;
let observedHash = null;

function setStatus(message, error = false) {
  if (status.textContent !== message) status.textContent = message;
  status.classList.toggle('error', error);
}
function sameOriginAppWindow() {
  try {
    const child = frame.contentWindow;
    if (!child || child.location.origin !== location.origin || child.location.pathname !== '/mobile' || new URLSearchParams(child.location.search).get('mobile-test') !== '1') return null;
    return child;
  } catch { return null; }
}
function updateMenu(route) {
  if (!routes.has(route)) return;
  currentRoute = route;
  currentModule.textContent = routes.get(route);
  for (const button of moduleButtons) {
    const active = button.dataset.route === route;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  openPhone.href = `/mobile?mobile-test=1#${route}`;
}
function syncFromFrame() {
  const child = sameOriginAppWindow();
  if (!child) {
    ready = false;
    for (const button of moduleButtons) button.disabled = true;
    setStatus('暂时无法读取同源手机界面，请等待载入完成；模块切换不会强制重载或覆盖填写内容。', true);
    return;
  }
  try {
    const hash = child.location.hash;
    const route = hash.slice(1) || 'home';
    ready = true;
    for (const button of moduleButtons) button.disabled = false;
    if (hash !== observedHash) {
      observedHash = hash;
      if (routes.has(route)) updateMenu(route);
    }
    setStatus(routes.has(route) ? '手机页面已就绪，可直接用鼠标填写和点击；页面内容在手机窗口内滚动。' : '手机内当前地址不在八个测试模块中，请从左侧选择模块。', !routes.has(route));
  } catch {
    ready = false;
    setStatus('手机窗口当前不可安全访问，已停止切换；没有重载手机页面。', true);
  }
}
function attachFrame() {
  try { attachedWindow?.removeEventListener('hashchange', syncFromFrame); attachedWindow?.removeEventListener('popstate', syncFromFrame); } catch { /* A navigated frame may no longer be same-origin. */ }
  attachedWindow = sameOriginAppWindow();
  if (attachedWindow) {
    try { attachedWindow.addEventListener('hashchange', syncFromFrame); attachedWindow.addEventListener('popstate', syncFromFrame); } catch { attachedWindow = null; }
  }
  observedHash = null;
  syncFromFrame();
}
function fitPhone() {
  phoneArea.classList.toggle('full-size', displayMode === 'actual');
  const availableWidth = Math.max(80, phoneArea.clientWidth - 32);
  const availableHeight = Math.max(175.2, phoneArea.clientHeight - 24);
  const ratio = Math.min(1, availableWidth / (width + 16), availableHeight / 876);
  const nextScale = displayMode === 'actual' ? 100 : Math.max(20, Math.min(100, Math.floor(ratio * 20) * 5));
  phoneFit.classList.remove(`scale-${scale}`);
  scale = nextScale;
  phoneFit.classList.add(`scale-${scale}`);
  viewportInfo.textContent = `真实视口 ${width} × 860 · 显示 ${scale}%`;
}
for (const button of moduleButtons) {
  button.disabled = true;
  button.addEventListener('click', () => {
    const route = button.dataset.route;
    if (!routes.has(route)) return;
    const child = sameOriginAppWindow();
    if (!ready || !child) { setStatus('手机窗口尚未就绪，请稍候。没有重新载入或清空手机页面。', true); return; }
    try {
      child.location.hash = route;
      syncFromFrame();
    } catch { setStatus('模块切换暂不可用；为保留填写内容，没有重新载入手机页面。', true); }
  });
}
for (const input of document.querySelectorAll('input[name="phone-width"]')) {
  input.addEventListener('change', () => {
    if (!input.checked || !['390', '430'].includes(input.value)) return;
    phoneFit.classList.remove(`width-${width}`);
    width = Number(input.value);
    frame.width = String(width);
    phoneFit.classList.add(`width-${width}`);
    fitPhone();
  });
}
for (const input of document.querySelectorAll('input[name="phone-display"]')) {
  input.addEventListener('change', () => {
    if (!input.checked || !['fit', 'actual'].includes(input.value)) return;
    displayMode = input.value;
    fitPhone(); phoneArea.scrollTop = 0; phoneArea.scrollLeft = 0;
  });
}
frame.addEventListener('load', attachFrame);
window.addEventListener('resize', fitPhone);
const resizeObserver = new ResizeObserver(fitPhone);
resizeObserver.observe(phoneArea);
// The phone app also uses pushState/replaceState, which do not emit hashchange.
// Observe only the same-origin URL; never call a business API or drive an action.
let routeObserver = window.setInterval(() => { if (!document.hidden && ready) syncFromFrame(); }, 350);
window.addEventListener('pagehide', () => {
  window.clearInterval(routeObserver); routeObserver = null; resizeObserver.disconnect();
  try { attachedWindow?.removeEventListener('hashchange', syncFromFrame); attachedWindow?.removeEventListener('popstate', syncFromFrame); } catch { /* No cross-origin access is attempted. */ }
});
window.addEventListener('pageshow', () => {
  if (routeObserver === null) routeObserver = window.setInterval(() => { if (!document.hidden && ready) syncFromFrame(); }, 350);
  resizeObserver.observe(phoneArea); attachFrame(); fitPhone();
});
updateMenu(currentRoute);
fitPhone();
if (sameOriginAppWindow()) attachFrame();
