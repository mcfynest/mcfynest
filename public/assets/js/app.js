/* McFynest Logistics — v3 production frontend. Vanilla JS, talks to
 * /api/*.php over fetch(). The render() function preserves focus/
 * selection/typed values across re-renders — a hard requirement carried
 * over from the prototype (an earlier auto-refresh design wiped
 * in-progress form input). Do not remove that behavior. Real-time-ish
 * updates (the admin unseen-order badge) only ever patch a small piece
 * of the DOM directly — they never call render(). */

const STATUSES = [
  {v:'pending', label:'Pending dispatch', badge:'badge-pending', dim:'var(--orange-dim)', solid:'var(--orange)'},
  {v:'scheduled', label:'Scheduled', badge:'badge-scheduled', dim:'var(--purple-dim)', solid:'var(--purple)'},
  {v:'shipped', label:'Shipped', badge:'badge-shipped', dim:'var(--teal-dim)', solid:'var(--teal)'},
  {v:'transit', label:'Out for delivery', badge:'badge-transit', dim:'var(--blue-dim)', solid:'var(--blue)'},
  {v:'delivered', label:'Delivered', badge:'badge-delivered', dim:'var(--green-dim)', solid:'var(--green)'},
  {v:'remitted', label:'Remitted', badge:'badge-remitted', dim:'var(--pink-dim)', solid:'var(--pink)'},
  {v:'notpicking', label:'Not picking calls', badge:'badge-notpicking', dim:'var(--gold-dim)', solid:'var(--gold)'},
  {v:'issue', label:'Issue / unreachable', badge:'badge-issue', dim:'var(--red-dim)', solid:'var(--red)'},
  {v:'returned', label:'Returned', badge:'badge-returned', dim:'var(--purple-dim)', solid:'var(--purple)'},
  {v:'cancelled', label:'Cancelled', badge:'badge-cancelled', dim:'#EAEAEA', solid:'#666'},
];
const statusMeta = v => STATUSES.find(s=>s.v===v) || STATUSES[0];
// Statuses tucked out of the default "Active" order view — still fully
// reachable via their own status pill, just not cluttering the default list.
const ARCHIVED_STATUSES = ['remitted', 'cancelled', 'returned'];
const LOW_STOCK_THRESHOLD = 1;       // inline badge/banner — qty<=1 ("low"/"out")
const POPUP_LOW_STOCK_THRESHOLD = 2; // login popup — "2 or fewer units" per spec
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const REMEMBERED_KEY = 'mcf_remembered_login';
const GREETINGS = [
  "we're here to help you keep every delivery on track today.",
  "let's make today's deliveries smooth and stress-free.",
  "ready to get your orders moving?",
  "here's to another day of on-time deliveries.",
  "let's keep the wheels turning today.",
  "your dispatch team has your back today.",
];
const COMMON_ZONES = ['Ikeja','Lekki','Victoria Island','Yaba','Surulere','Badagry','Ajah','Ikorodu','Apapa','Shomolu','Oshodi','Festac','Gbagada','Magodo','Ojota'];

const STORE_TEAM_PERMS = [
  {k:'order', label:'New Order'}, {k:'inventory', label:'Stock Drop-offs'}, {k:'history', label:'Order History'},
];
const ADMIN_PERMS = [
  {k:'orders', label:'Orders'}, {k:'inventory', label:'Inventory'}, {k:'stores', label:'Stores'},
  {k:'team', label:'Admin Team'}, {k:'withdrawals', label:'Withdrawals'}, {k:'expenses', label:'Expenses'},
  {k:'customers', label:'Customers'}, {k:'zones', label:'Delivery Zones'}, {k:'trash', label:'Deleted Orders'},
];
const STORE_SIDEBAR_ICONS = {orders:'📦', inventory:'📥', team:'👥', wallet:'💳', report:'📊'};
const ADMIN_SIDEBAR_ICONS = {orders:'📦', inventory:'📥', stores:'🏬', team:'👥', withdrawals:'💳', expenses:'📊', customers:'👤', zones:'🗺️', trash:'🗑️', report:'📊'};
const ADMIN_SIDEBAR_LABELS = {orders:'Orders', inventory:'Inventory', stores:'Stores', team:'Admin Team', withdrawals:'Withdrawals', expenses:'Expenses', customers:'Customers', zones:'Delivery Zones', trash:'Deleted Orders', report:'Report'};

let csrfToken = null;
let actor = null;
let appMeta = {app_name:'McFynest Logistics', currency:'₦'};
let booted = false;

// Store-role in-memory caches
let myProducts = [];
let myOrders = [];
let myAgents = [];
let myWallet = {balance:0, history:[], requestedToday:false};
let myBank = {bankName:null, accountNumber:null, accountName:null};
let mySentReports = [];

// Admin in-memory caches
let adminOrders = [];
let adminProducts = [];
let adminAccounts = [];
let adminAdmins = [];
let adminWithdrawals = {pending:[], resolved:[]};
let adminExpenses = {feesEarned:0, totalExpenses:0, netProfit:0, expenses:[]};
let adminTrash = [];
let resetRequestsStore = [];
let resetRequestsAdmin = [];
let unseenCount = 0;
let unseenOrders = [];
let unseenWithdrawalCount = 0;
let lowStockAdminCount = 0;
let adminCustomers = [];
let myTrash = []; // store's own trashed orders, loaded on demand

let reportData = {store:null, storeId:null, rows:[], totals:{amount:0, charge:0, balance:0}};
let reportDrillDay = null; // when set, report shows the detailed table for this day only

let activeSection = 'orders';
let loginError = '';
let forgotType = null;      // 'store' | 'admin' | null (forgot form open when non-null)
let forgotSentContact = null;
let modalOrder = null;
let popupOpen = false;
let reportPopupOpen = false;
let lowStockPopupOpen = false;
let withdrawalPopupOpen = false;
let lowStockAdminPopupOpen = false;
let sidebarOpen = false;
let showMyTrash = false; // store view: toggle between active orders and their own trash
let pwChangeOpen = false;
let greetingDismissed = false;
let greetingMsg = '';
let resetPwTarget = null;   // {kind:'agent'|'store'|'admin', id, label}
let onceCred = null;        // {label, storeId, password} shown right after creating/resetting a login
let expandedStores = new Set();
let selectedOrderIds = new Set();
let selectedInvIds = new Set();
let selectedReportIds = new Set();
let reportPreviewOpen = false;
let reportPreviewIds = [];     // order codes the preview modal is currently showing
let reportPreviewStoreId = ''; // the store login ID the preview will send to (needed for the POST, distinct from the display name)
let busy = false;
let pollTimer = null;
let idleTimer = null;
let lastActivityAt = Date.now();

function availableQty(i){ return i.available!=null ? i.available : i.qty; }
function money(n){ n = Number(n)||0; return n ? appMeta.currency + n.toLocaleString() : appMeta.currency + '0'; }
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function dayKey(ts){ const d = new Date(ts); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function todayStr(){ return dayKey(Date.now()); }

async function api(path, {method='GET', body=null} = {}){
  const opts = { method, credentials:'same-origin', headers:{} };
  if (body !== null){ opts.headers['Content-Type']='application/json'; opts.body = JSON.stringify(body); }
  if (method !== 'GET'){ opts.headers['X-CSRF-Token'] = csrfToken || ''; }
  let res;
  try{ res = await fetch('api/' + path, opts); }
  catch(e){ throw new Error('Network error — check your connection and try again.'); }

  let data = null;
  try{ data = await res.json(); }catch(e){ /* no body */ }

  if (res.status === 419){
    try{ const s = await (await fetch('api/session.php', {credentials:'same-origin'})).json(); csrfToken = s.csrf_token; }catch(e){}
    throw new Error('Your session refreshed — please try that again.');
  }
  if (res.status === 401){
    actor = null;
    stopIdleTimer(); stopQuietPoll();
    render();
    throw new Error((data && data.error) || 'Please log in again.');
  }
  if (!res.ok){
    throw new Error((data && data.error) || ('Something went wrong (' + res.status + ').'));
  }
  return data;
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------------- BOOT ---------------- */
async function boot(){
  document.addEventListener('click', ()=>{ lastActivityAt = Date.now(); });
  document.addEventListener('keydown', ()=>{ lastActivityAt = Date.now(); });

  try{
    const s = await api('session.php');
    csrfToken = s.csrf_token;
    appMeta = {app_name: s.app_name || 'McFynest Logistics', currency: s.currency || '₦'};
    actor = s.actor;
  }catch(e){ /* stay logged out */ }
  booted = true;
  if (actor && actor.type === 'store'){
    const hashSection = location.hash.slice(1);
    activeSection = (hashSection && storeSidebarItems().some(i=>i.k===hashSection)) ? hashSection : defaultStoreSection();
    await loadStoreData(); await checkForSentReports(); checkForLowStock(); startIdleTimer();
  } else if (actor && actor.type === 'admin'){
    activeSection = defaultAdminSection(); // sidebar items (and hash validity) depend on data loaded below
    await loadAdminData();
    const hashSection = location.hash.slice(1);
    if (hashSection && adminSidebarItems().some(i=>i.k===hashSection)) activeSection = hashSection;
    await checkForNewOrders(); await checkForPendingWithdrawals(); checkForLowStockAdmin();
    startQuietPoll(); startIdleTimer();
  }
  render();
  registerServiceWorker();
  window.addEventListener('hashchange', onHashChange);
}

function onHashChange(){
  if (!actor) return;
  const h = location.hash.slice(1);
  if (h && sidebarItems().some(i=>i.k===h) && h !== activeSection){
    activeSection = h; selectedOrderIds = new Set(); selectedInvIds = new Set(); sidebarOpen = false; render();
  }
}

function defaultStoreSection(){
  if (!actor) return 'orders';
  const perms = actor.is_primary ? {order:true, inventory:true, history:true} : (actor.permissions || {});
  if (perms.order || perms.history) return 'orders';
  if (perms.inventory) return 'inventory';
  return 'wallet';
}
function defaultAdminSection(){
  if (!actor) return 'orders';
  const perms = actor.permissions || {};
  for (const k of ['orders','inventory','stores','team','withdrawals','expenses','customers','zones']){ if (perms[k]) return k; }
  return 'report';
}

/* ---------------- IDLE AUTO-LOGOUT (30 min of no clicks/typing) ---------------- */
function startIdleTimer(){
  lastActivityAt = Date.now();
  stopIdleTimer();
  idleTimer = setInterval(async () => {
    if (actor && Date.now() - lastActivityAt > IDLE_LIMIT_MS){
      stopIdleTimer(); stopQuietPoll();
      try{ await api('logout.php', {method:'POST'}); }catch(e){}
      actor = null; activeSection='orders'; popupOpen=false;
      showToast("You've been logged out after 30 minutes of inactivity");
      render();
    }
  }, 60000);
}
function stopIdleTimer(){ if (idleTimer){ clearInterval(idleTimer); idleTimer = null; } }

function startQuietPoll(){
  stopQuietPoll();
  pollTimer = setInterval(async () => {
    if (!actor || actor.type !== 'admin') return;
    const perms = actor.permissions || {};
    try{
      const calls = [
        perms.orders ? api('unseen.php') : Promise.resolve({count:0}),
        perms.withdrawals ? api('withdrawals.php?count=1') : Promise.resolve({count:0}),
        perms.inventory ? api('products.php?lowstock_count=1') : Promise.resolve({count:0}),
      ];
      const [o, w, s] = await Promise.all(calls);
      unseenCount = o.count; unseenWithdrawalCount = w.count; lowStockAdminCount = s.count;
      patchBellBadges();
    }catch(e){ /* silent — background check, never surface errors */ }
  }, 25000);
}
function stopQuietPoll(){ if (pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

/** Updates only the little count bubbles on the bell buttons — never
 * touches the rest of the DOM, so it can never steal focus or blow away
 * text an admin is mid-typing. This is the "quiet badge" requirement,
 * now covering all three admin bells (new orders, withdrawals, low stock). */
function patchOneBellBadge(btnId, count){
  const bell = document.getElementById(btnId);
  if (!bell) return;
  let badge = bell.querySelector('.bell-count');
  if (count > 0){
    if (!badge){ badge = document.createElement('span'); badge.className = 'bell-count'; bell.appendChild(badge); }
    badge.textContent = count;
  } else if (badge){ badge.remove(); }
}
function patchBellBadges(){
  patchOneBellBadge('bell-btn', unseenCount);
  patchOneBellBadge('withdraw-bell-btn', unseenWithdrawalCount);
  patchOneBellBadge('lowstock-admin-bell-btn', lowStockAdminCount);
}

/* ---------------- DATA LOADERS ---------------- */
async function loadStoreData(){
  const perms = actor.is_primary ? {order:true, inventory:true, history:true} : (actor.permissions || {});
  const calls = [ api('products.php') ];
  calls.push(perms.history ? api('orders.php') : Promise.resolve({orders:[]}));
  const [p, o] = await Promise.all(calls);
  myProducts = p.products;
  myOrders = o.orders;
  if (actor.is_primary){
    try{ const t = await api('team.php'); myAgents = t.agents; }catch(e){ myAgents = []; }
  } else {
    myAgents = [];
  }
  // Wallet is always visible (view-only for team members) — load it
  // eagerly so it's never stale on first paint, not just on tab click.
  try{ await loadWalletData(); }catch(e){ /* non-fatal — section click will retry */ }
}
async function loadAdminData(){
  const perms = actor.permissions || {};
  const calls = [
    perms.orders ? api('orders.php') : Promise.resolve({orders:[]}),
    perms.inventory ? api('products.php') : Promise.resolve({products:[]}),
    perms.stores ? api('stores.php') : Promise.resolve({accounts:[]}),
  ];
  const [o, p, a] = await Promise.all(calls);
  adminOrders = o.orders; adminProducts = p.products; adminAccounts = a.accounts;
}
async function checkForNewOrders(){
  if (!(actor.permissions || {}).orders) return;
  const r = await api('unseen.php?full=1');
  unseenCount = r.count; unseenOrders = r.orders;
  if (unseenOrders.length > 0){ popupOpen = true; }
}
async function checkForPendingWithdrawals(){
  if (!(actor.permissions || {}).withdrawals) return;
  try{
    const r = await api('withdrawals.php');
    adminWithdrawals = r;
    const unseen = (r.pending || []).filter(w=>!w.seenByAdmin);
    unseenWithdrawalCount = unseen.length;
    if (unseen.length > 0){ withdrawalPopupOpen = true; }
  }catch(e){}
}
function checkForLowStockAdmin(){
  if (!(actor.permissions || {}).inventory) return;
  const low = adminProducts.filter(i=>availableQty(i)<=LOW_STOCK_THRESHOLD);
  lowStockAdminCount = low.length;
  if (low.length > 0){ lowStockAdminPopupOpen = true; }
}
async function checkForSentReports(){
  try{ const r = await api('sent-reports.php'); mySentReports = r.pending; if (mySentReports.length){ reportPopupOpen = true; } }catch(e){}
}
function checkForLowStock(){
  if (myProducts.some(i=>availableQty(i)<=POPUP_LOW_STOCK_THRESHOLD)){ lowStockPopupOpen = true; }
}
async function loadWalletData(){
  const r = await api('withdrawals.php');
  myWallet = {balance: r.balance, history: r.history, requestedToday: r.requestedToday};
  if (actor.is_primary){
    try{ myBank = await api('bank.php'); }catch(e){}
  }
}
async function loadReportData(store, q){
  const params = new URLSearchParams();
  if (store) params.set('store_id', store);
  if (q) params.set('q', q);
  if (window._reportDateFrom) params.set('date_from', window._reportDateFrom);
  if (window._reportDateTo) params.set('date_to', window._reportDateTo);
  reportData = await api('report.php?' + params.toString());
}
async function loadAdminWithdrawals(){ adminWithdrawals = await api('withdrawals.php'); }
async function loadAdminAdmins(){ const r = await api('admins.php'); adminAdmins = r.admins; }
async function loadResetRequests(type){
  const r = await api('reset-requests.php?type=' + type);
  if (type === 'store') resetRequestsStore = r.requests; else resetRequestsAdmin = r.requests;
}
async function loadExpenses(){
  const params = new URLSearchParams();
  if (window._expenseDateFrom) params.set('date_from', window._expenseDateFrom);
  if (window._expenseDateTo) params.set('date_to', window._expenseDateTo);
  adminExpenses = await api('expenses.php?' + params.toString());
}
async function loadTrash(){
  const r = await api('orders.php?trash=1');
  adminTrash = r.orders;
}
async function loadMyTrash(){
  const r = await api('orders.php?trash=1');
  myTrash = r.orders;
}
async function loadCustomers(q){
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const r = await api('customers.php?' + params.toString());
  adminCustomers = r.customers;
}
async function reloadAdminOrdersWithDate(){
  const params = new URLSearchParams();
  if (window._filterStore && window._filterStore !== 'all') params.set('store_id', window._filterStore);
  if (window._ordersDateFrom) params.set('date_from', window._ordersDateFrom);
  if (window._ordersDateTo) params.set('date_to', window._ordersDateTo);
  const r = await api('orders.php?' + params.toString());
  adminOrders = r.orders;
}
async function reloadStoreOrdersWithDate(){
  const perms = storePerms();
  if (!perms.history) return;
  const params = new URLSearchParams();
  if (window._historyDateFrom) params.set('date_from', window._historyDateFrom);
  if (window._historyDateTo) params.set('date_to', window._historyDateTo);
  const r = await api('orders.php?' + params.toString());
  myOrders = r.orders;
}

/* ---------------- RENDER (focus-preserving) ---------------- */
function render(){
  const root = document.getElementById('root');
  const priorValues = {};
  root.querySelectorAll('input, textarea').forEach(el=>{ if(el.id) priorValues[el.id] = el.value; });
  const activeEl = document.activeElement;
  const activeId = (activeEl && root.contains(activeEl) && activeEl.id) ? activeEl.id : null;
  const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = activeEl && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

  if (!booted){ root.innerHTML = '<div class="empty" style="margin-top:100px;">Loading…</div>'; return; }
  if (!actor){
    root.innerHTML = loginScreen();
    if (forgotType) attachForgotHandlers(); else attachLoginHandlers();
    return;
  }
  root.innerHTML = appShell();
  attachShellHandlers();

  Object.keys(priorValues).forEach(id=>{
    const el = document.getElementById(id);
    if (el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA')){ el.value = priorValues[id]; }
  });
  if (activeId){
    const el = document.getElementById(activeId);
    if (el && el.focus){ el.focus(); if (selStart!=null && el.setSelectionRange){ try{ el.setSelectionRange(selStart, selEnd); }catch(e){} } }
  }
}

function attachPasswordToggles(){
  document.querySelectorAll('.pw-toggle').forEach(btn=>{
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      btn.textContent = isHidden ? '🙈' : '👁';
      input.focus();
    };
  });
}

/* ---------------- UNIFIED LOGIN ---------------- */
function rememberedCreds(){
  try{ const raw = localStorage.getItem(REMEMBERED_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function bgIcons(){
  const van = `<svg viewBox="0 0 140 80" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="vanBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F0813A"/><stop offset="100%" stop-color="#C9500A"/></linearGradient>
      <linearGradient id="vanCab" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F6DCC4"/><stop offset="100%" stop-color="#E8630C"/></linearGradient></defs>
    <rect x="5" y="20" width="80" height="35" rx="5" fill="url(#vanBody)"/>
    <path d="M85 20 h25 a8 8 0 0 1 8 8 v19 a8 8 0 0 1 -8 8 h-25 z" fill="url(#vanCab)"/>
    <rect x="93" y="26" width="16" height="14" rx="2" fill="#CFE3F7"/>
    <rect x="10" y="27" width="34" height="5" rx="2" fill="#fff" opacity="0.45"/>
    <circle cx="30" cy="58" r="11" fill="#1B2430"/><circle cx="30" cy="58" r="4.5" fill="#9FB4C9"/>
    <circle cx="95" cy="58" r="11" fill="#1B2430"/><circle cx="95" cy="58" r="4.5" fill="#9FB4C9"/></svg>`;
  const bike = `<svg viewBox="0 0 160 90" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="boxLidGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F0813A"/><stop offset="100%" stop-color="#C9500A"/></linearGradient></defs>
    <circle cx="28" cy="68" r="14" fill="none" stroke="#1B2430" stroke-width="5"/><circle cx="28" cy="68" r="5" fill="#9FB4C9"/>
    <circle cx="95" cy="68" r="14" fill="none" stroke="#1B2430" stroke-width="5"/><circle cx="95" cy="68" r="5" fill="#9FB4C9"/>
    <path d="M28 68 L54 40 L80 40 L95 68" fill="none" stroke="#1D5B96" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M54 40 L59 22 L74 22" fill="none" stroke="#1D5B96" stroke-width="5" stroke-linecap="round"/>
    <rect x="43" y="33" width="26" height="8" rx="3" fill="#1B2430"/>
    <path d="M92 58 L112 58" stroke="#1B2430" stroke-width="4" stroke-linecap="round"/>
    <rect x="88" y="14" width="42" height="46" rx="3" fill="url(#boxLidGrad)"/>
    <rect x="88" y="14" width="42" height="11" rx="3" fill="#C9500A"/>
    <rect x="95" y="30" width="28" height="5" rx="2" fill="#fff" opacity="0.5"/>
    <rect x="95" y="40" width="28" height="5" rx="2" fill="#fff" opacity="0.3"/></svg>`;
  const box = `<svg viewBox="0 0 70 70" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="boxGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#EFD9B8"/><stop offset="100%" stop-color="#C99B5E"/></linearGradient></defs>
    <rect x="8" y="15" width="54" height="47" rx="3" fill="url(#boxGrad)"/>
    <rect x="8" y="15" width="54" height="12" fill="#B5824A"/>
    <rect x="30" y="15" width="10" height="47" fill="#8C6236"/>
    <path d="M35 20 l-9 -13 h18 z" fill="#2F6B4F"/></svg>`;
  const hub = `<svg viewBox="0 0 100 80" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 35 L50 8 L95 35 V72 H5 Z" fill="#1D5B96"/>
    <rect x="20" y="45" width="20" height="27" fill="#E7F1FB"/><rect x="60" y="45" width="20" height="27" fill="#E7F1FB"/>
    <rect x="42" y="52" width="16" height="20" fill="#1B2430"/></svg>`;
  return `<div class="bg-icon i1">${van}</div><div class="bg-icon i2">${bike}</div><div class="bg-icon i3">${box}</div>
    <div class="bg-icon i4">${hub}</div><div class="bg-icon i5">${box}</div><div class="bg-icon i6">${bike}</div>`;
}
function loginScreen(){
  if (forgotType) return forgotScreen();
  const remembered = rememberedCreds();
  return `
    <div class="role-screen">
      ${bgIcons()}
      <div class="display role-title">MCFYNEST LOGISTICS</div>
      <div class="role-tag">Keeping every delivery on track, together.</div>
      <div class="login-panel">
        <label>Login ID <span style="text-transform:none;font-weight:400;">(Store ID or Admin ID)</span></label>
        <input id="login-id-input" placeholder="e.g. AMK-4821 or ADM-1001" value="${escapeHtml(remembered?remembered.id:'')}" autocomplete="off" />
        <label>Password</label>
        <div class="pw-field">
          <input id="login-pass-input" type="password" placeholder="Password" value="${escapeHtml(remembered?remembered.password:'')}" autocomplete="off" />
          <button type="button" class="pw-toggle" data-target="login-pass-input" aria-label="Show password">👁</button>
        </div>
        <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:13px;color:var(--ink);">
          <input type="checkbox" id="login-remember-cb" style="width:auto;margin:0;" ${remembered?'checked':''}> Remember my ID and password on this device
        </label>
        ${loginError ? `<div class="alert-banner">${escapeHtml(loginError)}</div>` : ''}
        <button class="btn" id="login-enter-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Log in'}</button>
        <div style="text-align:center;margin-top:14px;"><a href="#" id="forgot-link" style="font-size:12px;color:var(--slate);">Forgot your ID or password?</a></div>
      </div>
    </div>`;
}
function attachLoginHandlers(){
  attachPasswordToggles();
  document.getElementById('forgot-link').onclick = (e)=>{ e.preventDefault(); forgotType='store'; forgotSentContact=null; render(); };

  const tryLogin = async () => {
    const id = document.getElementById('login-id-input').value.trim();
    const password = document.getElementById('login-pass-input').value;
    const remember = document.getElementById('login-remember-cb').checked;
    if (!id || !password){ showToast('Enter your ID and password'); return; }
    busy = true; render();
    try{
      const r = await api('login.php', {method:'POST', body:{id, password}});
      csrfToken = r.csrf_token; actor = r.actor; loginError=''; greetingDismissed=false;
      if (remember){ localStorage.setItem(REMEMBERED_KEY, JSON.stringify({id, password})); }
      else { localStorage.removeItem(REMEMBERED_KEY); }
      if (actor.type === 'store'){
        activeSection = defaultStoreSection();
        await loadStoreData(); await checkForSentReports(); checkForLowStock(); startIdleTimer();
      } else {
        activeSection = defaultAdminSection();
        await loadAdminData(); await checkForNewOrders(); await checkForPendingWithdrawals(); checkForLowStockAdmin(); startQuietPoll(); startIdleTimer();
      }
    }catch(e){ loginError = e.message; }
    busy = false; render();
  };
  document.getElementById('login-enter-btn').onclick = tryLogin;
  document.getElementById('login-pass-input').addEventListener('keydown', e=>{ if (e.key==='Enter') tryLogin(); });
}
function forgotScreen(){
  if (forgotSentContact){
    return `
      <div class="role-screen">
        ${bgIcons()}
        <div class="display role-title" style="font-size:26px;">REQUEST SENT</div>
        <div class="role-tag">Your dispatch admin has been notified and will verify your identity, then reset your login and contact you at ${escapeHtml(forgotSentContact)}.</div>
        <button class="btn" id="forgot-done-btn">Back to login</button>
      </div>`;
  }
  return `
    <div class="role-screen">
      ${bgIcons()}
      <div class="display role-title" style="font-size:28px;">FORGOT LOGIN?</div>
      <div class="role-tag">Tell us who you are and how to reach you — this sends a request to your dispatch admin, who'll verify it's really you and reset your login.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>I am a</label>
        <select id="forgot-type-select">
          <option value="store" ${forgotType==='store'?'selected':''}>Store</option>
          <option value="admin" ${forgotType==='admin'?'selected':''}>Dispatch admin</option>
        </select>
        <label>Your name / store name</label>
        <input id="forgot-label" placeholder="e.g. Amaka's Boutique" autocomplete="off" />
        <label>Your email or phone number</label>
        <input id="forgot-contact" placeholder="So we can reach you back" autocomplete="off" />
        <button class="btn" id="forgot-submit-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Send request'}</button>
        <button class="btn-outline btn" id="forgot-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back to login</button>
      </div>
    </div>`;
}
function attachForgotHandlers(){
  const doneBtn = document.getElementById('forgot-done-btn');
  if (doneBtn) doneBtn.onclick = () => { forgotType=null; forgotSentContact=null; render(); };
  const backBtn = document.getElementById('forgot-back-btn');
  if (backBtn) backBtn.onclick = () => { forgotType=null; render(); };
  const typeSelect = document.getElementById('forgot-type-select');
  if (typeSelect) typeSelect.onchange = e => { forgotType = e.target.value; render(); };
  const submitBtn = document.getElementById('forgot-submit-btn');
  if (submitBtn){
    submitBtn.onclick = async () => {
      const label = document.getElementById('forgot-label').value.trim();
      const contact = document.getElementById('forgot-contact').value.trim();
      if (!label || !contact){ showToast('Fill in both fields'); return; }
      busy = true; render();
      try{
        await api('reset-requests.php', {method:'POST', body:{type: forgotType, label, contact}});
        forgotSentContact = contact;
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
}

/* ---------------- GREETING BANNER ---------------- */
function greetingBanner(){
  if (greetingDismissed) return '';
  if (!greetingMsg) greetingMsg = GREETINGS[Math.floor(Math.random()*GREETINGS.length)];
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const fullName = actor.type === 'store' ? actor.store_name : actor.name;
  const firstName = (fullName || '').split(' ')[0];
  return `<div class="greeting-banner"><span>Good ${part}, ${escapeHtml(firstName)} — ${escapeHtml(greetingMsg)}</span><button id="greeting-close-btn">×</button></div>`;
}
function attachGreetingHandler(){
  const btn = document.getElementById('greeting-close-btn');
  if (btn) btn.onclick = () => { greetingDismissed = true; render(); };
}

/* ---------------- SIDEBAR SHELL ---------------- */
function storePerms(){ return actor.is_primary ? {order:true, inventory:true, history:true} : (actor.permissions || {}); }
function storeSidebarItems(){
  const perms = storePerms();
  const items = [];
  if (perms.order || perms.history) items.push({k:'orders', label:'Orders'});
  if (perms.inventory) items.push({k:'inventory', label:'Inventory'});
  if (actor.is_primary) items.push({k:'team', label:'Team'});
  items.push({k:'wallet', label:'Wallet'});
  items.push({k:'report', label:'Report'});
  items.push({k:'account', label:'Account'});
  return items.map(i => ({...i, ico: STORE_SIDEBAR_ICONS[i.k] || '⚙️'}));
}
function adminSidebarItems(){
  const perms = actor.permissions || {};
  const keys = ['orders','inventory','stores','team','withdrawals','expenses','customers','zones','trash'];
  const items = keys.filter(k=>perms[k]).map(k=>({k, label:ADMIN_SIDEBAR_LABELS[k], ico:ADMIN_SIDEBAR_ICONS[k]}));
  items.push({k:'report', label:'Report', ico:ADMIN_SIDEBAR_ICONS.report});
  items.push({k:'account', label:'Account', ico:'⚙️'});
  return items;
}
function sidebarItems(){ return actor.type === 'store' ? storeSidebarItems() : adminSidebarItems(); }

function appShell(){
  const items = sidebarItems();
  if (!items.find(i=>i.k===activeSection)) activeSection = items[0] ? items[0].k : 'orders';
  try{ if (location.hash.slice(1) !== activeSection) history.replaceState(null, '', '#' + activeSection); }catch(e){}
  return `
  <div class="shell">
    ${sidebarOpen ? '<div class="sidebar-overlay show" id="sidebar-overlay"></div>' : ''}
    <div class="sidebar ${sidebarOpen?'open':''}" id="app-sidebar">
      <div class="brand"><div class="brand-mark">M</div><div><div class="brand-name">MCFYNEST<br>LOGISTICS</div><div class="brand-sub">Dispatch CRM</div></div></div>
      <div class="side-section-label">${actor.type==='store'?'Store menu':'Admin menu'}</div>
      ${items.map(i=>`<a href="#${i.k}" class="side-item ${activeSection===i.k?'active':''}" data-section="${i.k}"><span class="ico">${i.ico}</span> ${i.label}</a>`).join('')}
    </div>
    <div class="main">
      ${topbar()}
      ${greetingBanner()}
      ${sectionContent()}
      ${modalOrder ? updateModal(modalOrder) : ''}
      ${popupOpen && actor.type==='admin' ? newOrdersPopup(unseenOrders) : ''}
      ${withdrawalPopupOpen && actor.type==='admin' ? withdrawalRequestPopup((adminWithdrawals.pending||[]).filter(w=>!w.seenByAdmin)) : ''}
      ${lowStockAdminPopupOpen && actor.type==='admin' ? lowStockAdminPopup() : ''}
      ${reportPopupOpen && actor.type==='store' ? sentReportPopup(mySentReports) : ''}
      ${lowStockPopupOpen && actor.type==='store' ? lowStockPopup() : ''}
      ${pwChangeOpen ? passwordChangeModal() : ''}
      ${onceCred ? onceCredBox() : ''}
      ${resetPwTarget ? resetPasswordModal() : ''}
      ${reportPreviewOpen && actor.type==='admin' ? reportPreviewModal() : ''}
    </div>
  </div>`;
}
function sectionContent(){
  if (actor.type === 'store'){
    const perms = storePerms();
    if (activeSection==='orders') return storeOrdersSection();
    if (activeSection==='inventory' && perms.inventory) return inventorySection(true);
    if (activeSection==='team' && actor.is_primary) return storeTeamPanel(myProducts, myAgents);
    if (activeSection==='wallet') return storeWalletPanel();
    if (activeSection==='report') return reportPanel(false, null);
    if (activeSection==='account') return accountPanel();
    return storeOrdersSection();
  }
  const perms = actor.permissions || {};
  if (activeSection==='orders' && perms.orders) return adminOrdersSection();
  if (activeSection==='inventory' && perms.inventory) return inventorySection(false);
  if (activeSection==='stores' && perms.stores) return adminStoresPanel();
  if (activeSection==='team' && perms.team) return adminTeamPanel();
  if (activeSection==='withdrawals' && perms.withdrawals) return adminWithdrawalsPanel();
  if (activeSection==='expenses' && perms.expenses) return adminExpensesPanel();
  if (activeSection==='customers' && perms.customers) return customersPanel();
  if (activeSection==='zones' && perms.zones) return zonesPanel();
  if (activeSection==='trash' && perms.trash) return trashPanel();
  if (activeSection==='report') return reportPanel(true, reportData.storeOptions || []);
  if (activeSection==='account') return accountPanel();
  return '<div class="empty">Nothing to show here.</div>';
}
function accountPanel(){
  const label = actor.type === 'admin'
    ? `${escapeHtml(actor.name || 'Dispatch Admin')}${actor.position?' — '+escapeHtml(actor.position):''} (${escapeHtml(actor.admin_id)})`
    : `${escapeHtml(actor.store_name)}${!actor.is_primary?' — '+escapeHtml(actor.position||'Team member'):''} (${escapeHtml(actor.store_id||'')})`;
  return `<div class="panel"><h2><span class="dot"></span>Account</h2>
    <p class="hint">Logged in as: <b>${label}</b></p>
    <button class="btn" id="pw-change-open-btn">Change password</button>
  </div>`;
}

function topbar(){
  let label, extra = '';
  const hamburger = `<button class="hamburger-btn" id="hamburger-btn" aria-label="Menu">☰</button>`;
  if (actor.type === 'store'){
    label = `${hamburger} Store: <b>${escapeHtml(actor.store_name)}</b>${!actor.is_primary?' · '+escapeHtml(actor.position||'Team member'):''}`;
  } else {
    label = `${hamburger} <b>${escapeHtml(actor.name || 'Dispatch Admin')}</b>${actor.position?' · '+escapeHtml(actor.position):''} <span class="mono" style="color:var(--slate);">(${escapeHtml(actor.admin_id)})</span>`;
    const perms = actor.permissions || {};
    const bells = [];
    if (perms.orders) bells.push(`<button class="bell-btn" id="bell-btn">Check for new orders${unseenCount?`<span class="bell-count">${unseenCount}</span>`:''}</button>`);
    if (perms.withdrawals) bells.push(`<button class="bell-btn" id="withdraw-bell-btn">Withdrawal requests${unseenWithdrawalCount?`<span class="bell-count">${unseenWithdrawalCount}</span>`:''}</button>`);
    if (perms.inventory) bells.push(`<button class="bell-btn" id="lowstock-admin-bell-btn">Low stock${lowStockAdminCount?`<span class="bell-count">${lowStockAdminCount}</span>`:''}</button>`);
    extra = bells.join('');
  }
  return `<div class="topbar">
    <div class="session-tag" style="display:flex;align-items:center;gap:10px;">${label}</div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      ${extra}<button class="logout" id="logout-btn">Log out</button>
    </div>
  </div>`;
}
function attachHeaderHandlers(){
  document.getElementById('logout-btn').onclick = async () => {
    stopQuietPoll(); stopIdleTimer();
    try{ const r = await api('logout.php', {method:'POST'}); csrfToken = r.csrf_token; }catch(e){}
    actor = null; activeSection='orders'; popupOpen=false;
    render();
  };
  const bell = document.getElementById('bell-btn');
  if (bell){
    bell.onclick = async () => {
      try{ await loadAdminData(); await checkForNewOrders(); popupOpen = true; render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const withdrawBell = document.getElementById('withdraw-bell-btn');
  if (withdrawBell){
    withdrawBell.onclick = async () => {
      try{ await checkForPendingWithdrawals(); withdrawalPopupOpen = true; render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const lowStockBell = document.getElementById('lowstock-admin-bell-btn');
  if (lowStockBell){
    lowStockBell.onclick = async () => {
      try{ await loadAdminData(); checkForLowStockAdmin(); lowStockAdminPopupOpen = true; render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const pwBtn = document.getElementById('pw-change-open-btn');
  if (pwBtn) pwBtn.onclick = () => { pwChangeOpen = true; render(); };
  const hamburger = document.getElementById('hamburger-btn');
  if (hamburger) hamburger.onclick = () => { sidebarOpen = !sidebarOpen; render(); };
  const overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.onclick = () => { sidebarOpen = false; render(); };
}
function passwordChangeModal(){
  const label = actor.type === 'admin' ? `${actor.name} (${actor.admin_id})` : `${actor.store_name} (${actor.store_id})`;
  return `<div class="modal-overlay" id="pw-modal-overlay"><div class="modal">
    <h3>Change your password</h3>
    <div class="id">Logged in as ${escapeHtml(label)}</div>
    <label>New password</label>
    <div class="pw-field"><input id="pw-new" type="password" placeholder="New password" autocomplete="new-password" /><button type="button" class="pw-toggle" data-target="pw-new">👁</button></div>
    <label>Confirm new password</label>
    <div class="pw-field"><input id="pw-confirm" type="password" placeholder="Confirm new password" autocomplete="new-password" /><button type="button" class="pw-toggle" data-target="pw-confirm">👁</button></div>
    <div class="modal-actions"><button class="btn btn-outline" id="pw-cancel">Cancel</button><button class="btn" id="pw-save" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Save new password'}</button></div>
    </div></div>`;
}
function attachPasswordChangeHandlers(){
  const overlay = document.getElementById('pw-modal-overlay');
  if (!overlay) return;
  attachPasswordToggles();
  document.getElementById('pw-cancel').onclick = () => { pwChangeOpen=false; render(); };
  document.getElementById('pw-save').onclick = async () => {
    const p1 = document.getElementById('pw-new').value;
    const p2 = document.getElementById('pw-confirm').value;
    if (!p1 || p1.length < 6){ showToast('Password must be at least 6 characters'); return; }
    if (p1 !== p2){ showToast('Passwords do not match'); return; }
    busy = true; render();
    try{
      await api('change-password.php', {method:'POST', body:{new_password:p1, confirm:p2}});
      pwChangeOpen = false; showToast('Password updated');
    }catch(e){ showToast(e.message); }
    busy = false; render();
  };
  overlay.addEventListener('click', e=>{ if (e.target.id==='pw-modal-overlay'){ pwChangeOpen=false; render(); } });
}
function onceCredBox(){
  return `
    <div class="modal-overlay" id="oncecred-overlay"><div class="modal">
    <div class="once-box">
      <div>${escapeHtml(onceCred.label)}</div>
      <div class="cred">ID: <span class="mono">${escapeHtml(onceCred.storeId)}</span> &nbsp;·&nbsp; Password: <span class="mono">${escapeHtml(onceCred.password)}</span></div>
      <div class="warn">Copy this now — for security we can't show this password again after you leave this screen.</div>
      <button class="btn btn-sm btn-outline" id="once-cred-dismiss" style="margin-top:10px;">I've copied it</button>
    </div>
    </div></div>`;
}
function resetPasswordModal(){
  const t = resetPwTarget;
  return `
    <div class="modal-overlay" id="reset-pw-overlay">
      <div class="modal">
        <h3>Reset password</h3>
        <div class="id">${escapeHtml(t.label)}</div>
        <label>New password (at least 6 characters)</label>
        <div class="pw-field">
          <input id="reset-pw-input" type="password" placeholder="New password" autocomplete="new-password" />
          <button type="button" class="pw-toggle" data-target="reset-pw-input" aria-label="Show password">👁</button>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="reset-pw-cancel">Cancel</button>
          <button class="btn" id="reset-pw-save">Save new password</button>
        </div>
      </div>
    </div>`;
}
function attachResetPasswordModalHandlers(onSave){
  const overlay = document.getElementById('reset-pw-overlay');
  if (!overlay) return;
  attachPasswordToggles();
  document.getElementById('reset-pw-cancel').onclick = () => { resetPwTarget = null; render(); };
  document.getElementById('reset-pw-save').onclick = async () => {
    const pw = document.getElementById('reset-pw-input').value;
    if (!pw || pw.length < 6){ showToast('New password must be at least 6 characters'); return; }
    try{ await onSave(pw); render(); }catch(e){ showToast(e.message); }
  };
  overlay.addEventListener('click', e => { if (e.target.id==='reset-pw-overlay'){ resetPwTarget=null; render(); } });
}

function attachShellHandlers(){
  attachHeaderHandlers();
  attachPasswordToggles();
  attachGreetingHandler();
  attachPasswordChangeHandlers();

  document.querySelectorAll('.side-item[data-section]').forEach(el=>{
    el.addEventListener('click', async (e) => {
      // Real <a href="#section"> links — let Ctrl/Cmd-click, Shift-click,
      // and middle-click behave normally (these open a new tab); only a
      // plain left-click is intercepted to navigate instantly in-page.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      activeSection = el.dataset.section; onceCred=null; selectedOrderIds=new Set(); selectedInvIds=new Set(); reportDrillDay=null; sidebarOpen=false; showMyTrash=false; window._invDrillStore=null; window._zoneDrill=null;
      render();
      try{
        if (activeSection === 'stores' && actor.type==='admin'){ await loadResetRequests('store'); render(); }
        if (activeSection === 'team' && actor.type==='admin'){ await Promise.all([loadAdminAdmins(), loadResetRequests('admin')]); render(); }
        if (activeSection === 'withdrawals'){ await loadAdminWithdrawals(); render(); }
        if (activeSection === 'expenses'){ await loadExpenses(); render(); }
        if (activeSection === 'customers' && actor.type==='admin'){ await loadCustomers(window._customerSearch); render(); }
        if (activeSection === 'trash'){ await loadTrash(); render(); }
        if (activeSection === 'wallet' && actor.type==='store'){ await loadWalletData(); render(); }
        if (activeSection === 'report'){
          await loadReportData(actor.type==='admin' ? window._reportStoreId : null, window._reportSearch);
          if (actor.type==='admin' && !window._reportStoreId && (reportData.storeOptions||[]).length){
            window._reportStoreId = reportData.storeOptions[0].store_id;
            await loadReportData(window._reportStoreId, window._reportSearch);
          }
          render();
        }
      }catch(e){ showToast(e.message); }
    });
  });

  attachOrdersHandlers();
  attachInventoryHandlers();
  attachTeamHandlers();
  attachWalletHandlers();
  attachStoresHandlers();
  attachAdminTeamHandlers();
  attachWithdrawalsHandlers();
  attachExpensesHandlers();
  attachCustomersHandlers();
  attachZonesHandlers();
  attachTrashHandlers();
  attachReportHandlers(actor.type==='admin');
  attachPopupHandlers();

  // Single dispatcher for the reset-password modal, regardless of which
  // section opened it (agent/store/admin) — must be attached exactly
  // once per render, since several section handlers above run
  // unconditionally and would otherwise race to overwrite each other's
  // save handler on the shared modal.
  if (resetPwTarget){
    attachResetPasswordModalHandlers(async (newPassword) => {
      if (resetPwTarget.kind === 'agent'){
        const r = await api('team.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
        onceCred = {label:'New password set — share it with your team member:', storeId: myAgents.find(a=>a.id===resetPwTarget.id).store_id, password:r.new_password};
      } else if (resetPwTarget.kind === 'store'){
        const r = await api('stores.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
        onceCred = {label:'New password set — share it with them:', storeId: resetPwTarget.label, password:r.new_password};
      } else if (resetPwTarget.kind === 'admin'){
        const r = await api('admins.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
        onceCred = {label:'New password set — share it with them:', storeId: resetPwTarget.label, password:r.new_password};
      }
      resetPwTarget = null;
    });
  }

  const onceDismiss = document.getElementById('once-cred-dismiss');
  if (onceDismiss) onceDismiss.onclick = () => { onceCred = null; render(); };
}

/* ---------------- DATE FILTER (quick buttons + custom range) ---------------- */
function quickRangeDates(range){
  const now = new Date();
  if (range === 'all') return {from:'', to:''};
  if (range === 'today'){ const k = dayKey(now.getTime()); return {from:k, to:k}; }
  if (range === 'week'){ const d = new Date(now); d.setDate(d.getDate()-6); return {from:dayKey(d.getTime()), to:dayKey(now.getTime())}; }
  if (range === 'month'){ const d = new Date(now); d.setDate(d.getDate()-29); return {from:dayKey(d.getTime()), to:dayKey(now.getTime())}; }
  return {from:'', to:''};
}
function dateFilterBar(activeKey){
  const q = window[activeKey] || 'all';
  const fromKey = activeKey.replace('Quick','From'), toKey = activeKey.replace('Quick','To');
  return `<div class="quickdate" style="margin-bottom:18px;">
    <button data-quickdate="all" data-quickkey="${activeKey}" class="${q==='all'?'active':''}">All time</button>
    <button data-quickdate="today" data-quickkey="${activeKey}" class="${q==='today'?'active':''}">Today</button>
    <button data-quickdate="week" data-quickkey="${activeKey}" class="${q==='week'?'active':''}">This week</button>
    <button data-quickdate="month" data-quickkey="${activeKey}" class="${q==='month'?'active':''}">This month</button>
    <span style="font-size:11px;color:var(--slate);margin-left:2px;">or:</span>
    <input type="date" id="custom-${activeKey}-from" value="${window[fromKey]||''}" style="width:auto;margin-bottom:0;">
    <span style="font-size:11px;color:var(--slate);">to</span>
    <input type="date" id="custom-${activeKey}-to" value="${window[toKey]||''}" style="width:auto;margin-bottom:0;">
    <button class="btn btn-sm" data-customapply="${activeKey}">Apply</button>
  </div>`;
}
function attachDateFilterHandlers(activeKey, onApply){
  document.querySelectorAll(`[data-quickdate][data-quickkey="${activeKey}"]`).forEach(btn=>{
    btn.onclick = async () => {
      window[activeKey] = btn.dataset.quickdate;
      const {from, to} = quickRangeDates(btn.dataset.quickdate);
      window[activeKey.replace('Quick','From')] = from; window[activeKey.replace('Quick','To')] = to;
      try{ await onApply(); render(); }catch(e){ showToast(e.message); }
    };
  });
  const applyBtn = document.querySelector(`[data-customapply="${activeKey}"]`);
  if (applyBtn){
    applyBtn.onclick = async () => {
      const from = document.getElementById(`custom-${activeKey}-from`).value;
      const to = document.getElementById(`custom-${activeKey}-to`).value;
      window[activeKey] = 'custom';
      window[activeKey.replace('Quick','From')] = from;
      window[activeKey.replace('Quick','To')] = to;
      try{ await onApply(); render(); }catch(e){ showToast(e.message); }
    };
  }
}

/* ---------------- STATUS PILLS (replaces stat-number boxes) ---------------- */
function statusPillRow(list, allForCounts, filterKey){
  const filterStatus = window[filterKey] || 'all';
  const counts = {}; STATUSES.forEach(s=>counts[s.v]=0);
  allForCounts.forEach(o=>counts[o.status]=(counts[o.status]||0)+1);
  const allActive = filterStatus==='all';
  // "New" (was "Active") shows only orders still in Pending dispatch —
  // i.e. orders dispatch hasn't touched yet. The moment an order moves to
  // any other status it drops out of this default view; find it under
  // that status's own pill instead.
  const newCount = counts['pending'] || 0;
  return `<div class="pill-row">
    <div class="pill" data-statfilter="all" data-statkey="${filterKey}" title="New, unactioned orders only — once an order has been moved to any other status, find it under that status's own pill" style="${allActive?`background:var(--ink);color:#fff;border-color:var(--ink);`:`background:#fff;color:var(--ink);border-color:var(--ink);`}">New <span class="cnt" style="${allActive?'color:#cfd8e0;':''}">(${newCount})</span></div>
    ${STATUSES.map(s=>{ const active=filterStatus===s.v;
      return `<div class="pill" data-statfilter="${s.v}" data-statkey="${filterKey}" style="${active?`background:${s.solid};color:#fff;border-color:${s.solid};`:`background:${s.dim};color:${s.solid};border-color:${s.solid};`}">${s.label} <span class="cnt" style="${active?'color:rgba(255,255,255,.75);':`color:${s.solid};opacity:.7;`}">(${counts[s.v]})</span></div>`;
    }).join('')}
  </div>`;
}
function attachStatusPillHandlers(){
  document.querySelectorAll('[data-statfilter]').forEach(el=>{
    el.onclick = () => { window[el.dataset.statkey] = el.dataset.statfilter; render(); };
  });
}

/* ---------------- BULK ACTION BAR (orders) ---------------- */
/* Status changes stay admin-only (matches the existing Update modal —
 * stores have never been able to change order status themselves, only
 * dispatch can). Stores/team members only get bulk "Move to Trash". */
function bulkBar(isAdmin){
  return `<div class="bulkbar">
    <span>${selectedOrderIds.size} selected</span>
    <select id="bulk-action-select">
      <option value="">Bulk action…</option>
      ${isAdmin ? STATUSES.map(s=>`<option value="status:${s.v}">Mark as ${s.label}</option>`).join('') : ''}
      <option value="trash">Move to Trash</option>
    </select>
    <button class="btn btn-sm" id="bulk-apply-btn">Apply</button>
    <button class="btn-outline btn btn-sm" id="bulk-clear-btn" style="background:none;">Clear selection</button>
  </div>`;
}

/* ---------------- STORE: ORDERS (Add Order + Orders list, combined) ---------------- */
function storeProfileCard(){
  const delivered = myOrders.filter(o=>o.status==='delivered'||o.status==='remitted').length;
  return `<div class="store-profile-card">
    <div class="store-profile-avatar">${escapeHtml((actor.store_name||'?').charAt(0).toUpperCase())}</div>
    <div class="store-profile-info">
      <div class="store-profile-name">${escapeHtml(actor.store_name)}</div>
      <div class="store-profile-meta">
        <span class="mono">${escapeHtml(actor.store_id||'')}</span>
        ${!actor.is_primary ? `<span>· ${escapeHtml(actor.position||'Team member')}</span>` : ''}
      </div>
    </div>
    <div class="store-profile-stats">
      <div><b>${myOrders.length}</b><span>Total orders</span></div>
      <div><b>${delivered}</b><span>Completed</span></div>
    </div>
  </div>`;
}
function storeOrdersSection(){
  const perms = storePerms();
  let panels = '';
  if (perms.order) panels += storeOrderFormPanel(myProducts);
  if (perms.history) panels += storeOrdersListPanel(myOrders);
  return storeProfileCard() + (panels || '<div class="empty">You do not have access to Orders.</div>');
}
function storeOrderFormPanel(availableInv){
  return `
    <div class="panel">
      <h2><span class="dot"></span>Add Order</h2>
      ${availableInv.length===0 ? `
        <div class="empty">
          You haven't logged any stock yet.
          ${storePerms().inventory ? '<br><br><button class="btn" id="goto-inventory-btn">Go to Inventory</button>' : ''}
        </div>` : `
      <div class="row3">
        <div><label>Customer name</label><input id="f-customer" placeholder="e.g. Chidi Okafor" /></div>
        <div><label>Product</label><select id="f-product">
          ${availableInv.map(i=>{ const avail = i.available!=null ? i.available : i.qty;
            return `<option value="${i.id}">${escapeHtml(i.name)} — ${avail} available${avail<=0?' (backorder)':''}</option>`; }).join('')}
        </select></div>
        <div><label>Quantity</label><input id="f-qty" type="number" min="1" value="1" /></div>
      </div>
      <div class="row3">
        <div><label>Delivery address</label><input id="f-dropoff" placeholder="Where it's going" /></div>
        <div><label>Phone number</label><input id="f-phone" placeholder="0803 000 0000" /></div>
        <div><label>Alternate phone (optional)</label><input id="f-altphone" placeholder="Backup contact" /></div>
      </div>
      <div class="row3">
        <div><label>Delivery zone / area</label><input id="f-zone" list="zone-suggestions" placeholder="e.g. Ikeja" />
          <datalist id="zone-suggestions">${COMMON_ZONES.map(z=>`<option value="${z}">`).join('')}</datalist>
        </div>
        <div><label>Amount (optional)</label><input id="f-amount" type="number" min="0" placeholder="e.g. 33000" /></div>
        <div><label>Specific instructions (optional)</label><input id="f-notes" placeholder="e.g. fragile, call before arriving" /></div>
      </div>
      <button class="btn" id="submit-order-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Submit order'}</button>
      `}
    </div>`;
}
function customerOrderCount(phone, list){ if (!phone) return 0; return list.filter(o=>o.phone===phone).length; }
function storeOrdersListPanel(mine){
  if (showMyTrash){
    const trashList = myTrash.slice().sort((a,b)=>b.updatedAt-a.updatedAt);
    return `<div class="panel">
      <h2><span class="dot"></span>Your Trash (${trashList.length})</h2>
      <p class="hint">Orders you moved to Trash. Restore brings one back to your active list. Only an admin can permanently delete.</p>
      <button class="btn-outline btn btn-sm" id="my-trash-back-btn" style="margin-bottom:14px;">← Back to your orders</button>
      ${trashList.length ? trashList.map(o=>{
        const sm = statusMeta(o.status);
        return `<div class="stub">
          <div class="stub-top"><div><div class="stub-id mono">#${escapeHtml(o.id)}</div><div class="stub-item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</div></div><span class="badge ${sm.badge}">${sm.label}</span></div>
          <div class="stub-grid"><div><span class="k">Customer:</span> ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}</div><div><span class="k">Deliver to:</span> ${escapeHtml(o.dropoff)}</div></div>
          <div class="modal-actions" style="justify-content:flex-start;margin-top:10px;"><button class="restore-btn" data-my-restore="${escapeHtml(o.id)}">Restore</button></div>
        </div>`;
      }).join('') : '<div class="empty">Your trash is empty.</div>'}
    </div>`;
  }

  const sorted = mine.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const searchTerm = (window._historySearch||'').toLowerCase();
  let list = sorted;
  const filterStatus = window._historyStatFilter || 'all';
  if (filterStatus!=='all') list = list.filter(o=>o.status===filterStatus);
  else list = list.filter(o=>o.status==='pending');
  if (searchTerm) list = list.filter(o=>o.customer.toLowerCase().includes(searchTerm) || o.phone.toLowerCase().includes(searchTerm) || o.id.toLowerCase().includes(searchTerm));

  return `<div class="panel">
    <h2><span class="dot"></span>Your orders (${list.length})</h2>
    ${statusPillRow(list, sorted, '_historyStatFilter')}
    <div class="filters">
      <input id="search-history" placeholder="Search customer, phone, or order #" value="${escapeHtml(window._historySearch||'')}" />
      <button class="btn-outline btn" id="search-history-btn" style="padding:9px 14px;">Search</button>
      <button class="btn-outline btn" id="my-trash-open-btn" style="padding:9px 14px;">🗑 Your Trash</button>
    </div>
    ${dateFilterBar('_historyDateQuick')}
    <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:12.5px;margin-bottom:10px;">
      <input type="checkbox" id="select-all-cb" style="width:auto;margin:0;" ${list.length && list.every(o=>selectedOrderIds.has(o.id))?'checked':''}> Select all shown
    </label>
    ${selectedOrderIds.size?bulkBar(false):''}
    ${list.length ? list.map(o=>orderRowStub(o, sorted)).join('') : '<div class="empty">No orders in this range.</div>'}
  </div>`;
}
function orderRowStub(o, allMine){
  const sm = statusMeta(o.status);
  const dCharge = (o.deliveryFee||0)+(o.otherCharges||0);
  const repeatCount = allMine ? customerOrderCount(o.phone, allMine) : 0;
  return `<div class="stub">
    <div class="stub-top">
      <label style="display:flex;align-items:flex-start;gap:10px;text-transform:none;font-weight:400;margin:0;">
        <input type="checkbox" class="order-select-cb" data-id="${escapeHtml(o.id)}" ${selectedOrderIds.has(o.id)?'checked':''} style="width:auto;margin-top:3px;" />
        <div><div class="stub-id mono">#${escapeHtml(o.id)}</div><div class="stub-item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}${o.zone?` <span class="badge badge-role">📍 ${escapeHtml(o.zone)}</span>`:''}${repeatCount>1?` <span class="badge badge-ok">↻ Repeat (${repeatCount})</span>`:''}${o.isBackorder?` <span class="badge badge-notpicking">⏳ Backorder</span>`:''}</div></div>
      </label>
      <span class="badge ${sm.badge}">${sm.label}</span>
    </div>
    <div class="stub-grid"><div><span class="k">Customer:</span> ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}${o.altPhone?' / '+escapeHtml(o.altPhone):''}</div><div><span class="k">Deliver to:</span> ${escapeHtml(o.dropoff)}</div></div>
    ${o.notes ? `<div class="stub-remark"><span class="k">Instructions:</span> ${escapeHtml(o.notes)}</div>` : ''}
    ${o.remark ? `<div class="stub-remark"><span class="k">Dispatch note:</span> ${escapeHtml(o.remark)}</div>` : ''}
    <div class="stub-charges">
      ${o.amount ? `<span>Amount: <b>${money(o.amount)}</b></span>` : ''}
      ${dCharge ? `<span>Delivery charge: <b>${money(dCharge)}</b></span>` : ''}
      ${o.amount || dCharge ? `<span>Balance: <b>${money((o.amount||0)-dCharge)}</b></span>` : ''}
    </div>
    <div class="stub-meta">Submitted ${new Date(o.createdAt).toLocaleString()}${o.rider ? ' · Rider: '+escapeHtml(o.rider) : ''}${o.lastUpdatedBy ? ' · Last updated by '+escapeHtml(o.lastUpdatedBy) : ''}</div>
    <div class="modal-actions" style="justify-content:flex-start;margin-top:10px;">
      <button class="danger-btn" data-store-trash="${escapeHtml(o.id)}">Move to Trash</button>
    </div>
  </div>`;
}

/* ---------------- STORE: INVENTORY ---------------- */
function inventorySection(isStore){
  return isStore ? storeInventoryPanel(myProducts) : adminInventoryPanel();
}
/** Shared row renderer. isAdmin=true shows the qty +/- controls and the
 * select checkbox (admin-only quantity edits — round 2 item #9); stores
 * always get a view-only row plus the "last updated by/at" accountability
 * trail, whether they're the one it's shown to or the admin confirming it. */
function invRow(i, isAdmin){
  const available = i.available!=null ? i.available : i.qty;
  const reserved = i.qty - available;
  const low = available<=LOW_STOCK_THRESHOLD;
  return `<div class="inv-row">
    ${isAdmin ? `<input type="checkbox" class="inv-select-cb" data-id="${i.id}" ${selectedInvIds.has(i.id)?'checked':''} />` : '<div></div>'}
    <div><div class="inv-name">${escapeHtml(i.name)}${isAdmin && i.store_name ? ` <span class="mono" style="color:var(--slate);font-size:11px;">${escapeHtml(i.store_name)}</span>` : ''}</div>
      ${i.dropped_off_at ? `<div class="inv-date">Dropped off ${escapeHtml(i.dropped_off_at)}</div>` : ''}
      ${reserved>0 ? `<div class="inv-date">${reserved} reserved by order(s) not yet delivered</div>` : ''}
      ${i.qty_updated_at && i.qty_updated_by ? `<div class="inv-date">Last updated ${new Date(i.qty_updated_at.replace(' ','T')).toLocaleString()} by ${escapeHtml(i.qty_updated_by)}</div>` : ''}</div>
    <span class="badge ${low?'badge-low':'badge-ok'}">${low ? (available<=0?'Out of stock':'Low stock') : 'In stock'}</span>
    <div class="inv-qty">${i.qty}${reserved>0?`<div style="font-size:10px;font-weight:400;color:var(--slate);">${available} available</div>`:''}</div>
    <div class="inv-actions">${isAdmin ? `<button class="qty-btn" data-inv="${i.id}" data-delta="-1">−</button><button class="qty-btn" data-inv="${i.id}" data-delta="1">+</button>` : ''}</div></div>`;
}
function storeInventoryPanel(myInv){
  return `
    <div class="panel">
      <h2><span class="dot"></span>Log a stock drop-off</h2>
      <p class="hint">Once logged, only your dispatch admin can adjust the quantity — this keeps stock counts accurate against what was actually received.</p>
      <div class="row3">
        <div><label>Product name</label><input id="inv-name" placeholder="e.g. Black sneakers, size 42" /></div>
        <div><label>Quantity dropped off</label><input id="inv-qty" type="number" min="0" value="1" /></div>
        <div><label>Date dropped off</label><input id="inv-date" type="date" value="${todayStr()}" /></div>
      </div>
      <button class="btn" id="inv-add-btn">Log drop-off</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Stock we're currently holding for you <span style="text-transform:none;font-weight:400;font-size:11px;color:var(--slate);">(view only)</span></h2>
      ${myInv.length ? myInv.map(i=>invRow(i, false)).join('') : '<div class="empty">Nothing logged yet.</div>'}
    </div>`;
}
function attachInventoryHandlers(){
  if (actor.type==='store'){
    const addInvBtn = document.getElementById('inv-add-btn');
    if (addInvBtn){
      addInvBtn.onclick = async () => {
        const name = document.getElementById('inv-name').value.trim();
        const qty = parseInt(document.getElementById('inv-qty').value, 10);
        const droppedOffAt = document.getElementById('inv-date').value || todayStr();
        if (!name || isNaN(qty) || qty<0){ showToast('Enter a product name and valid quantity'); return; }
        try{
          await api('products.php', {method:'POST', body:{name, qty, droppedOffAt}});
          await loadStoreData();
          showToast('Drop-off logged');
          render();
        }catch(e){ showToast(e.message); }
      };
    }
    return;
  }

  // Admin: store drill-down navigation
  document.querySelectorAll('[data-drill-inv-store]').forEach(row=>{
    row.onclick = () => { window._invDrillStore = row.dataset.drillInvStore; selectedInvIds = new Set(); render(); };
  });
  const invBack = document.getElementById('inv-back-to-stores');
  if (invBack) invBack.onclick = () => { window._invDrillStore = null; render(); };

  // Admin: quantity adjustment (the server-enforced, admin-only action)
  document.querySelectorAll('.qty-btn').forEach(btn=>{
    btn.onclick = async () => {
      try{
        await api('products.php', {method:'PATCH', body:{id:parseInt(btn.dataset.inv,10), delta:parseInt(btn.dataset.delta,10)}});
        await loadAdminData();
        render();
      }catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('.inv-select-cb').forEach(cb=>{
    cb.onchange = () => { if (cb.checked) selectedInvIds.add(parseInt(cb.dataset.id)); else selectedInvIds.delete(parseInt(cb.dataset.id)); render(); };
  });
  const invSelectAll = document.getElementById('inv-select-all-cb');
  if (invSelectAll){
    invSelectAll.onchange = () => {
      const drillStore = window._invDrillStore;
      const invList = adminProducts.filter(i=>i.store_name===drillStore);
      if (invSelectAll.checked) invList.forEach(i=>selectedInvIds.add(i.id)); else invList.forEach(i=>selectedInvIds.delete(i.id));
      render();
    };
  }
  const bulkRemove = document.getElementById('inv-bulk-remove-btn');
  if (bulkRemove){
    bulkRemove.onclick = async () => {
      if (!confirm(`Remove ${selectedInvIds.size} product(s) from inventory?`)) return;
      try{
        await api('products.php', {method:'PATCH', body:{action:'bulk_delete', ids:Array.from(selectedInvIds)}});
        selectedInvIds = new Set();
        await loadAdminData();
        showToast('Removed');
        render();
      }catch(e){ showToast(e.message); }
    };
  }
  const bulkClear = document.getElementById('inv-bulk-clear-btn');
  if (bulkClear) bulkClear.onclick = () => { selectedInvIds = new Set(); render(); };
}
function adminInventoryPanel(){
  const drillStore = window._invDrillStore;

  if (!drillStore){
    const storeNames = [...new Set(adminProducts.map(i=>i.store_name))].sort();
    const rows = storeNames.map(store=>{
      const items = adminProducts.filter(i=>i.store_name===store);
      const lowCount = items.filter(i=>availableQty(i)<=LOW_STOCK_THRESHOLD).length;
      return `<div class="day-row" data-drill-inv-store="${escapeHtml(store)}">
        <span class="dlabel">${escapeHtml(store)}</span>
        <span class="dcount">${items.length} product(s)${lowCount?` · ⚠ ${lowCount} low/out`:''}</span>
        <span class="dbal">▸</span>
      </div>`;
    }).join('');
    return `<div class="panel"><h2><span class="dot"></span>Inventory by store</h2>
      <p class="hint">Click a store to see and confirm its stock — only admin can adjust quantities.</p>
      ${storeNames.length ? rows : '<div class="empty">No inventory logged yet.</div>'}
    </div>`;
  }

  const invList = adminProducts.filter(i=>i.store_name===drillStore).sort((a,b)=>a.name.localeCompare(b.name));
  return `<div class="panel"><h2><span class="dot"></span>Inventory — ${escapeHtml(drillStore)} (${invList.length})</h2>
    <button class="btn-outline btn btn-sm" id="inv-back-to-stores" style="margin-bottom:14px;">← Back to stores</button>
    <p class="hint">Confirm quantities against what was physically received — every adjustment is logged with your name and the time.</p>
    ${invList.length ? `<label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:12.5px;margin-bottom:10px;">
      <input type="checkbox" id="inv-select-all-cb" style="width:auto;margin:0;" ${invList.every(i=>selectedInvIds.has(i.id))?'checked':''}> Select all
    </label>` : ''}
    ${selectedInvIds.size ? `<div class="bulkbar"><span>${selectedInvIds.size} selected</span><button class="btn btn-sm" id="inv-bulk-remove-btn">Remove selected</button><button class="btn-outline btn btn-sm" id="inv-bulk-clear-btn" style="background:none;">Clear</button></div>` : ''}
    ${invList.length ? invList.map(i=>invRow(i, true)).join('') : '<div class="empty">No inventory logged yet.</div>'}</div>`;
}

/* ---------------- STORE: TEAM ---------------- */
function storeTeamPanel(myInv, myAgentsList){
  return `
    <div class="panel">
      <h2><span class="dot"></span>Add a team member</h2>
      <p class="hint">Give a team member their own login. Tick what their position covers below — everything's checked by default, so they start with full access like you, minus managing the team.</p>
      <div class="row2">
        <div><label>Position / title</label><input id="agent-position" placeholder="e.g. Customer Care Agent" /></div>
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="agent-password" type="password" placeholder="Set a password" autocomplete="new-password" /><button type="button" class="pw-toggle" data-target="agent-password">👁</button></div></div>
      </div>
      <label>What this position handles</label>
      <div class="checklist">
        ${STORE_TEAM_PERMS.map(p=>`<label><input type="checkbox" class="agent-perm-cb" value="${p.k}" checked> ${p.label}</label>`).join('')}
        <label><input type="checkbox" checked disabled> Wallet (view balance only) &amp; Report <span style="color:var(--slate);">(always included)</span></label>
      </div>
      <label>Products this position is primarily responsible for <span style="text-transform:none;font-weight:400;">(for your reference — doesn't restrict access)</span></label>
      ${myInv.length ? `<div class="checklist">
        ${myInv.map(i=>`<label><input type="checkbox" class="agent-product-cb" value="${i.id}"> ${escapeHtml(i.name)} <span style="color:var(--slate);">(${i.qty} in stock)</span></label>`).join('')}
      </div>` : `<div class="empty" style="margin-bottom:16px;">Log stock first.</div>`}
      <button class="btn" id="agent-create-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Generate team ID'}</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Team (${myAgentsList.length})</h2>
      ${myAgentsList.length ? myAgentsList.map(a=>agentRow(a)).join('') : '<div class="empty">No team members yet.</div>'}
    </div>`;
}
function agentRow(a){
  const names = (a.products||[]).map(p=>p.name);
  const handles = STORE_TEAM_PERMS.filter(p=>a.permissions && a.permissions[p.k]).map(p=>p.label);
  return `
    <div class="admin-row" style="grid-template-columns:1fr auto auto;">
      <div class="admin-main">
        <div class="item">${escapeHtml(a.position||'Team member')} — <span class="mono">${escapeHtml(a.store_id)}</span></div>
        <div class="sub">Handles: ${handles.length?escapeHtml(handles.join(', ')):'—'}, Wallet, Report · Products: ${names.length ? escapeHtml(names.join(', ')) : 'none tagged'}</div>
      </div>
      <button class="admin-update-btn" data-reset-agent="${a.id}">Reset password</button>
      <button class="admin-update-btn" data-remove-agent="${a.id}">Remove</button>
    </div>`;
}
function attachTeamHandlers(){
  if (actor.type!=='store' || !actor.is_primary) return;
  const agentCreateBtn = document.getElementById('agent-create-btn');
  if (agentCreateBtn){
    agentCreateBtn.onclick = async () => {
      const password = document.getElementById('agent-password').value;
      const position = document.getElementById('agent-position').value.trim();
      const sel = Array.from(document.querySelectorAll('.agent-product-cb:checked')).map(cb=>parseInt(cb.value,10));
      const checkedPerms = Array.from(document.querySelectorAll('.agent-perm-cb:checked')).map(cb=>cb.value);
      if (!password || password.length < 6){ showToast('Set a password of at least 6 characters'); return; }
      busy = true; render();
      try{
        const r = await api('team.php', {method:'POST', body:{password, position, product_ids:sel, permissions:checkedPerms}});
        onceCred = {label:'Team login created — share these with your team member:', storeId:r.store_id, password:r.password};
        await loadStoreData();
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
  document.querySelectorAll('[data-remove-agent]').forEach(btn=>{
    btn.onclick = async () => {
      if (!confirm('Remove this team login? They will no longer be able to log in.')) return;
      try{
        await api('team.php', {method:'DELETE', body:{id:parseInt(btn.dataset.removeAgent,10)}});
        await loadStoreData();
        showToast('Team login removed');
        render();
      }catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-reset-agent]').forEach(btn=>{
    btn.onclick = () => {
      const agent = myAgents.find(a=>a.id === parseInt(btn.dataset.resetAgent,10));
      resetPwTarget = {kind:'agent', id: agent.id, label: 'Team login ' + agent.store_id};
      render();
    };
  });
}

/* ---------------- STORE: WALLET ---------------- */
function storeWalletPanel(){
  const balance = myWallet.balance || 0;
  const hasBank = myBank.bankName && myBank.accountNumber && myBank.accountName;
  const alreadyToday = myWallet.requestedToday;
  return `
    <div class="panel">
      <h2><span class="dot"></span>Wallet</h2>
      <p class="hint">Your balance updates automatically the moment an order is marked Delivered (and stays counted once it's Remitted) — the amount collected, minus delivery charges, lands here.</p>
      <div class="stat" style="cursor:default;min-width:200px;"><div class="n">${money(balance)}</div><div class="l">Available balance</div></div>
    </div>
    ${actor.is_primary ? `
    <div class="panel">
      <h2><span class="dot"></span>Bank account details</h2>
      <p class="hint">Add the account we should pay withdrawals into.</p>
      <div class="row3">
        <div><label>Bank name</label><input id="bank-name" value="${escapeHtml(myBank.bankName||'')}" placeholder="e.g. GTBank" /></div>
        <div><label>Account number</label><input id="bank-account-number" value="${escapeHtml(myBank.accountNumber||'')}" placeholder="0123456789" /></div>
        <div><label>Account name</label><input id="bank-account-name" value="${escapeHtml(myBank.accountName||'')}" placeholder="As it appears on the account" /></div>
      </div>
      <button class="btn" id="bank-save-btn">Save bank details</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Request a withdrawal</h2>
      ${!hasBank ? '<div class="empty">Add your bank account details above before requesting a withdrawal.</div>' : `
        <div class="row2">
          <div><label>Amount</label><input id="withdraw-amount" type="number" min="0" max="${balance}" value="${balance}" /></div>
          <div style="display:flex;align-items:flex-end;"><button class="btn" id="withdraw-request-btn" style="width:100%;" ${balance<=0||alreadyToday?'disabled':''}>Request withdrawal</button></div>
        </div>
        ${alreadyToday ? '<p class="hint">You\'ve already requested a withdrawal today — try again tomorrow.</p>' : ''}
        ${balance<=0 ? '<p class="hint">No available balance to withdraw yet.</p>' : ''}
      `}
    </div>` : `<div class="panel"><div class="empty">Only the store owner can manage bank details and request withdrawals. You can still see the balance above.</div></div>`}
    <div class="panel">
      <h2><span class="dot"></span>Withdrawal history</h2>
      ${myWallet.history.length ? myWallet.history.map(w=>`
        <div class="admin-row" style="grid-template-columns:1fr auto auto;">
          <div class="admin-main"><div class="item">${money(w.amount)}</div><div class="sub">Requested ${new Date(w.requestedAt).toLocaleString()}</div></div>
          <span class="badge ${w.status==='paid'?'badge-ok':w.status==='declined'?'badge-issue':'badge-pending'}">${w.status}</span>
          <div></div>
        </div>`).join('') : '<div class="empty">No withdrawal requests yet.</div>'}
    </div>`;
}
function attachWalletHandlers(){
  if (actor.type!=='store') return;
  const bankSaveBtn = document.getElementById('bank-save-btn');
  if (bankSaveBtn){
    bankSaveBtn.onclick = async () => {
      const bankName = document.getElementById('bank-name').value.trim();
      const accountNumber = document.getElementById('bank-account-number').value.trim();
      const accountName = document.getElementById('bank-account-name').value.trim();
      if (!bankName || !accountNumber || !accountName){ showToast('Fill in all bank details'); return; }
      try{
        await api('bank.php', {method:'POST', body:{bankName, accountNumber, accountName}});
        await loadWalletData();
        showToast('Bank details saved');
        render();
      }catch(e){ showToast(e.message); }
    };
  }
  const withdrawBtn = document.getElementById('withdraw-request-btn');
  if (withdrawBtn){
    withdrawBtn.onclick = async () => {
      const amount = parseFloat(document.getElementById('withdraw-amount').value) || 0;
      if (amount <= 0){ showToast('Enter a valid amount'); return; }
      try{
        await api('withdrawals.php', {method:'POST', body:{amount}});
        await loadWalletData();
        showToast('Withdrawal requested — your dispatch admin will process it');
        render();
      }catch(e){ showToast(e.message); }
    };
  }
}
function sentReportPopup(pending){
  return `<div class="modal-overlay" id="sentreport-overlay"><div class="modal">
    <h3>Your dispatch team sent a report</h3>
    <div class="id">${pending.length} report${pending.length>1?'s':''} ready for you to review</div>
    ${pending.map(r=>`<div class="new-order-item">📅 ${escapeHtml(formatDateRangeLabel(r.dateFrom, r.dateTo))} — sent ${new Date(r.sentAt).toLocaleString()}. Open the Report section to see the full breakdown.</div>`).join('')}
    <div class="modal-actions"><button class="btn" id="sentreport-ack-btn">Got it</button></div>
    </div></div>`;
}
function lowStockPopup(){
  const low = myProducts.filter(i=>availableQty(i)<=POPUP_LOW_STOCK_THRESHOLD);
  return `<div class="modal-overlay" id="lowstock-overlay"><div class="modal">
    <h3>⚠ Time to restock</h3><div class="id">${low.length} product(s) are running low</div>
    ${low.map(i=>`<div class="new-order-item">${escapeHtml(i.name)} — only ${availableQty(i)} available</div>`).join('')}
    <div class="modal-actions"><button class="btn btn-outline" id="lowstock-close">Dismiss</button><button class="btn" id="lowstock-goto">Go to Inventory</button></div>
  </div></div>`;
}
function withdrawalRequestPopup(pending){
  return `<div class="modal-overlay" id="withdraw-popup-overlay"><div class="modal">
    <h3>💳 New withdrawal request${pending.length>1?'s':''}</h3>
    <div class="id">${pending.length} store(s) requesting payment</div>
    ${pending.map(w=>`<div class="new-order-item"><span class="store-tag">${escapeHtml(w.store)}</span>Requesting ${money(w.amount)}</div>`).join('')}
    <div class="modal-actions"><button class="btn btn-outline" id="withdraw-popup-close">Close</button><button class="btn" id="withdraw-popup-goto">Go to Withdrawals</button></div>
  </div></div>`;
}
function lowStockAdminPopup(){
  const low = adminProducts.filter(i=>availableQty(i)<=LOW_STOCK_THRESHOLD);
  const byStore = {};
  low.forEach(i=>{ (byStore[i.store_name] = byStore[i.store_name] || []).push(i); });
  return `<div class="modal-overlay" id="lowstock-admin-overlay"><div class="modal">
    <h3>⚠ ${low.length} product${low.length>1?'s':''} low or out of stock</h3>
    <div class="id">Across ${Object.keys(byStore).length} store(s)</div>
    ${Object.keys(byStore).map(store=>`<div class="new-order-item"><span class="store-tag">${escapeHtml(store)}</span>${byStore[store].map(i=>escapeHtml(i.name)+' ('+availableQty(i)+' available)').join(', ')}</div>`).join('')}
    <div class="modal-actions"><button class="btn btn-outline" id="lowstock-admin-close">Close</button><button class="btn" id="lowstock-admin-goto">Go to Inventory</button></div>
  </div></div>`;
}

/* ---------------- REPORT (shared store + admin, day-grouped w/ drill-down) ---------------- */
function formatDateRangeLabel(from, to){
  if (!from && !to) return 'All time — no date limit';
  const fmt = (s) => { const d = new Date(s+'T00:00:00'); return d.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}); };
  if (from===to) return fmt(from);
  return fmt(from) + ' – ' + fmt(to);
}
function reportDayGroups(rows){
  const byDay = {};
  rows.forEach(r=>{
    if (!byDay[r.date]) byDay[r.date] = {date:r.date, count:0, balance:0};
    byDay[r.date].count++; byDay[r.date].balance += r.balance;
  });
  return Object.values(byDay).sort((a,b)=>b.date.localeCompare(a.date));
}
function reportPanel(isAdmin, storeNames){
  if (window._reportDateFrom === undefined){
    const {from, to} = quickRangeDates('today');
    window._reportDateQuick = 'today'; window._reportDateFrom = from; window._reportDateTo = to;
  }
  const q = window._reportDateQuick || 'today';
  const rows = reportData.rows || [];
  const totals = reportData.totals || {amount:0, charge:0, balance:0};
  const isSingleDay = (q==='today') || (window._reportDateFrom && window._reportDateFrom===window._reportDateTo);
  const showDayList = !isSingleDay && !reportDrillDay;
  const dayGroups = showDayList ? reportDayGroups(rows) : [];
  const detailRows = showDayList ? [] : (reportDrillDay ? rows.filter(r=>r.date===reportDrillDay) : rows);
  const searchTerm = (window._reportSearch||'').toLowerCase();
  const visibleRows = searchTerm ? detailRows.filter(o=>o.customer.toLowerCase().includes(searchTerm)||(o.phone||'').toLowerCase().includes(searchTerm)) : detailRows;
  const detailTotals = showDayList ? totals : visibleRows.reduce((acc,o)=>({amount:acc.amount+o.amount, charge:acc.charge+o.charge, balance:acc.balance+o.balance}), {amount:0,charge:0,balance:0});
  const deliveredInView = visibleRows.filter(o=>o.status==='delivered');

  return `<div class="panel">
    <h2><span class="dot"></span>Report ${reportData.store?'— '+escapeHtml(reportData.store):''}</h2>
    <div style="font-size:14px;font-weight:800;color:var(--ink);margin-bottom:12px;">📅 ${formatDateRangeLabel(window._reportDateFrom, window._reportDateTo)}</div>
    <p class="hint">Grouped by the day each order was last resolved (e.g. delivered), not the day it was placed — so orders dropped off earlier still show up on the day they were actually completed.</p>
    <div class="filters">
      ${isAdmin ? `<select id="report-store-select">${(storeNames||[]).map(s=>`<option value="${escapeHtml(s.store_id)}" ${s.store_id===window._reportStoreId?'selected':''}>${escapeHtml(s.store_name)}</option>`).join('')}</select>` : ''}
      <div class="quickdate">
        <button data-reportquick="today" class="${q==='today'?'active':''}">Today</button>
        <button data-reportquick="week" class="${q==='week'?'active':''}">This week</button>
        <button data-reportquick="month" class="${q==='month'?'active':''}">This month</button>
        <button data-reportquick="all" class="${q==='all'?'active':''}">All time</button>
        <span style="font-size:11px;color:var(--slate);margin-left:2px;">or:</span>
        <input type="date" id="report-custom-from" value="${window._reportDateFrom||''}" style="width:auto;margin-bottom:0;">
        <span style="font-size:11px;color:var(--slate);">to</span>
        <input type="date" id="report-custom-to" value="${window._reportDateTo||''}" style="width:auto;margin-bottom:0;">
        <button class="btn btn-sm" id="report-custom-apply">Apply</button>
      </div>
    </div>
    ${!showDayList && reportDrillDay ? `<div style="margin-bottom:14px;"><a href="#" id="report-back-to-days" style="font-size:12px;color:var(--blue);">← Back to day list</a></div>` : ''}
    ${!showDayList ? `<div class="filters"><input id="report-search" placeholder="Search customer or phone" value="${escapeHtml(window._reportSearch||'')}" /><button class="btn-outline btn" id="report-search-btn" style="padding:9px 14px;">Search</button></div>` : ''}
    ${!showDayList && isAdmin && deliveredInView.length ? `<label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:12.5px;margin-bottom:10px;">
      <input type="checkbox" id="report-select-all-cb" style="width:auto;margin:0;" ${deliveredInView.every(o=>selectedReportIds.has(o.id))?'checked':''}> Select all Delivered orders shown (${deliveredInView.length})
    </label>` : ''}
    ${showDayList ? (
      dayGroups.length ? dayGroups.map(g=>`<div class="day-row" data-drillday="${g.date}"><div><div class="dlabel">${escapeHtml(formatDateRangeLabel(g.date,g.date))}</div><div class="dcount">${g.count} order${g.count===1?'':'s'}</div></div><div class="dbal">${money(g.balance)}</div></div>`).join('') : '<div class="empty">No orders in this range.</div>'
    ) : (
      visibleRows.length ? `<div style="overflow-x:auto;"><table class="report">
        <thead><tr>${isAdmin?'<th></th>':''}<th>Customer</th><th>Product</th><th>Address</th><th>Status</th><th>Amount</th><th>Delivery charge</th><th>Balance</th></tr></thead>
        <tbody>${visibleRows.map(o=>{ const canSelect = isAdmin && o.status==='delivered';
          return `<tr>${isAdmin?`<td>${canSelect?`<input type="checkbox" class="report-select-cb" data-id="${escapeHtml(o.id)}" ${selectedReportIds.has(o.id)?'checked':''} />`:''}</td>`:''}<td>${escapeHtml(o.customer)}</td><td>${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</td><td>${escapeHtml(o.dropoff)}</td>
          <td><span class="badge ${statusMeta(o.status).badge}">${statusMeta(o.status).label}</span></td>
          <td>${o.amount?money(o.amount):'—'}</td><td>${o.charge?money(o.charge):'—'}</td><td><b>${money(o.balance)}</b></td></tr>`; }).join('')}</tbody>
        <tfoot><tr>${isAdmin?'<td></td>':''}<td colspan="4">Totals</td><td>${money(detailTotals.amount)}</td><td>${money(detailTotals.charge)}</td><td>${money(detailTotals.balance)}</td></tr></tfoot>
      </table></div>` : '<div class="empty">No orders in this range.</div>'
    )}
    ${isAdmin && reportData.store && deliveredInView.length ? `<div style="margin-top:18px;"><button class="btn" id="preview-report-btn" data-candidates="${deliveredInView.map(o=>escapeHtml(o.id)).join(',')}">Preview &amp; send to ${escapeHtml(reportData.store)}</button><p class="hint" style="margin-top:8px;">Opens a preview of exactly which orders (checked above, or every Delivered order shown if nothing's checked) will be marked Remitted and sent to ${escapeHtml(reportData.store)} — nothing changes until you confirm there.</p></div>` : ''}
  </div>`;
}
function reportPreviewModal(){
  const items = (reportData.rows || []).filter(o=>reportPreviewIds.includes(o.id));
  let totalAmount = 0, totalCharge = 0, totalBalance = 0;
  items.forEach(o=>{ totalAmount += o.amount; totalCharge += o.charge; totalBalance += o.balance; });
  return `<div class="modal-overlay" id="report-preview-overlay"><div class="modal">
    <h3>Preview report — ${escapeHtml(reportData.store||'')}</h3>
    <div class="id">${items.length} order(s) will be marked Remitted and sent to this store. Nothing else in this view is affected.</div>
    ${items.map(o=>`<div class="new-order-item">${escapeHtml(o.customer)} — ${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''} — Balance: <b>${money(o.balance)}</b></div>`).join('')}
    <p class="hint">Totals: Amount ${money(totalAmount)} · Delivery charge ${money(totalCharge)} · Balance ${money(totalBalance)}</p>
    <div class="modal-actions"><button class="btn btn-outline" id="report-preview-cancel">Cancel</button><button class="btn" id="report-preview-confirm" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Confirm & send'}</button></div>
  </div></div>`;
}
function attachReportHandlers(isAdmin){
  const goReload = async () => {
    try{ await loadReportData(isAdmin ? window._reportStoreId : null, window._reportSearch); reportDrillDay=null; render(); }
    catch(e){ showToast(e.message); }
  };
  document.querySelectorAll('[data-reportquick]').forEach(btn=>{
    btn.onclick = async () => {
      window._reportDateQuick = btn.dataset.reportquick;
      const {from, to} = quickRangeDates(btn.dataset.reportquick);
      window._reportDateFrom = from; window._reportDateTo = to;
      selectedReportIds = new Set();
      await goReload();
    };
  });
  const customApply = document.getElementById('report-custom-apply');
  if (customApply){
    customApply.onclick = async () => {
      window._reportDateFrom = document.getElementById('report-custom-from').value;
      window._reportDateTo = document.getElementById('report-custom-to').value;
      window._reportDateQuick = 'custom';
      selectedReportIds = new Set();
      await goReload();
    };
  }
  const storeSelect = document.getElementById('report-store-select');
  if (storeSelect){
    storeSelect.onchange = async (e) => { window._reportStoreId = e.target.value; selectedReportIds = new Set(); await goReload(); };
  }
  const search = document.getElementById('report-search');
  if (search){
    search.oninput = e => { window._reportSearch = e.target.value; };
    search.addEventListener('keydown', e => { if (e.key==='Enter') render(); });
  }
  const searchBtn = document.getElementById('report-search-btn');
  if (searchBtn) searchBtn.onclick = () => render();
  document.querySelectorAll('[data-drillday]').forEach(row=>{
    row.onclick = () => { reportDrillDay = row.dataset.drillday; render(); };
  });
  const backLink = document.getElementById('report-back-to-days');
  if (backLink) backLink.onclick = (e) => { e.preventDefault(); reportDrillDay = null; render(); };

  document.querySelectorAll('.report-select-cb').forEach(cb=>{
    cb.onchange = () => { if (cb.checked) selectedReportIds.add(cb.dataset.id); else selectedReportIds.delete(cb.dataset.id); render(); };
  });
  const reportSelectAll = document.getElementById('report-select-all-cb');
  if (reportSelectAll){
    reportSelectAll.onchange = () => {
      document.querySelectorAll('.report-select-cb').forEach(cb=>{ if (reportSelectAll.checked) selectedReportIds.add(cb.dataset.id); else selectedReportIds.delete(cb.dataset.id); });
      render();
    };
  }
  const previewBtn = document.getElementById('preview-report-btn');
  if (previewBtn){
    previewBtn.onclick = () => {
      const candidates = previewBtn.dataset.candidates ? previewBtn.dataset.candidates.split(',').filter(Boolean) : [];
      // Whatever's explicitly checked wins; if nothing's checked, every
      // Delivered order currently shown is treated as the candidate set —
      // matches the button's own "or every Delivered order shown" hint text.
      reportPreviewIds = selectedReportIds.size ? Array.from(selectedReportIds) : candidates;
      reportPreviewStoreId = window._reportStoreId;
      reportPreviewOpen = true;
      render();
    };
  }
  const previewOverlay = document.getElementById('report-preview-overlay');
  if (previewOverlay){
    // Cancel — and clicking outside the modal — closes the preview with
    // no server call and no state change at all; only Confirm below
    // actually sends anything.
    document.getElementById('report-preview-cancel').onclick = () => { reportPreviewOpen = false; reportPreviewIds = []; render(); };
    document.getElementById('report-preview-confirm').onclick = async () => {
      const range = window._reportDateQuick || 'today';
      const label = range==='today' ? 'Today' : range==='week' ? 'This week' : range==='month' ? 'This month' : range==='custom' ? 'Custom range' : 'All time';
      busy = true; render();
      try{
        const r = await api('report.php', {method:'POST', body:{store_id: reportPreviewStoreId, order_ids: reportPreviewIds, range_label: label, date_from: window._reportDateFrom, date_to: window._reportDateTo}});
        showToast(r.skippedCount ? `Report sent — ${r.sentCount} order(s) marked Remitted, ${r.skippedCount} had already changed and were skipped` : `Report sent to ${reportData.store} — ${r.sentCount} order(s) marked Remitted`);
        selectedReportIds = new Set(); reportPreviewOpen = false; reportPreviewIds = [];
        await goReload();
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
    previewOverlay.addEventListener('click', e => { if (e.target.id==='report-preview-overlay'){ reportPreviewOpen = false; reportPreviewIds = []; render(); } });
  }
}

/* ---------------- ADMIN: ORDERS ---------------- */
function csvEscape(v){ v=String(v==null?'':v); if(/[",\n]/.test(v)) return '"'+v.replace(/"/g,'""')+'"'; return v; }
function exportOrdersCsv(list){
  const headers=['Order ID','Store','Product','Qty','Customer','Phone','Address','Status','Amount','Delivery Fee','Other Charges','Balance','Created','Updated'];
  const rows=list.map(o=>[o.id,o.store,o.item,o.qty,o.customer,o.phone,o.dropoff,statusMeta(o.status).label,o.amount||0,o.deliveryFee||0,o.otherCharges||0,(o.amount||0)-((o.deliveryFee||0)+(o.otherCharges||0)),new Date(o.createdAt).toLocaleString(),new Date(o.updatedAt).toLocaleString()]);
  const csv=[headers,...rows].map(r=>r.map(csvEscape).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='orders-'+todayStr()+'.csv'; a.click();
  URL.revokeObjectURL(url);
}
/** The admin Orders list as currently filtered/visible (status pill,
 * search, store, date range) — shared by CSV export and the Print
 * slips fallback (used when nothing is checkbox-selected). */
function currentFilteredAdminOrders(){
  const filterStatus = window._filterStatus || 'all';
  const searchTerm = (window._searchTerm || '').toLowerCase();
  let list = adminOrders.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if (filterStatus !== 'all') list = list.filter(o=>o.status===filterStatus);
  else list = list.filter(o=>o.status==='pending');
  if (searchTerm) list = list.filter(o=>o.customer.toLowerCase().includes(searchTerm)||o.phone.toLowerCase().includes(searchTerm)||o.id.toLowerCase().includes(searchTerm));
  return list;
}
function printOrderSlips(list){
  const area = document.getElementById('print-area');
  if (!area) return;
  if (!list.length){ showToast('Select at least one order to print'); return; }
  area.innerHTML = list.map(o=>{
    // Older orders (or ones that predate this column) may have no
    // recorded history — fall back to a single synthesized entry for
    // their current status rather than showing an empty timeline.
    const history = (o.statusHistory && o.statusHistory.length) ? o.statusHistory : [{status:o.status, at:o.updatedAt||o.createdAt, by:o.lastUpdatedBy}];
    return `
    <div class="slip">
      <div class="slip-field"><b>Store:</b> ${escapeHtml(o.store)}</div>
      <div class="slip-field"><b>Date:</b> ${new Date(o.createdAt).toLocaleDateString()}</div>
      <div class="slip-field"><b>Name:</b> ${escapeHtml(o.customer)}</div>
      <div class="slip-field"><b>Address:</b> ${escapeHtml(o.dropoff)}</div>
      <div class="slip-field"><b>Phone number:</b> ${escapeHtml(o.phone)}${o.altPhone?' / '+escapeHtml(o.altPhone):''}</div>
      <table>
        <thead><tr><th>S/N</th><th>ITEM ORDERED</th><th>AMOUNT (${appMeta.currency})</th></tr></thead>
        <tbody><tr><td>1</td><td>${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</td><td>${o.amount?o.amount.toLocaleString():''}</td></tr></tbody>
        <tfoot><tr><td colspan="2">TOTAL</td><td>${money(o.amount||0)}</td></tr></tfoot>
      </table>
      <table class="slip-history">
        <thead><tr><th>Status</th><th>Date</th></tr></thead>
        <tbody>${history.map(h=>`<tr><td>${statusMeta(h.status).label}</td><td>${new Date(h.at).toLocaleString()}</td></tr>`).join('')}</tbody>
      </table>
    </div>
  `;}).join('');
  window.print();
}
function adminOrdersSection(){
  const storeOptions = adminAccounts.filter(a=>a.role==='owner').slice().sort((a,b)=>a.store_name.localeCompare(b.store_name));
  const filterStore = window._filterStore || 'all';
  const searchTerm = (window._searchTerm || '').toLowerCase();
  let list = adminOrders.slice().sort((a,b)=>b.createdAt-a.createdAt);
  const filterStatus = window._filterStatus || 'all';
  if (filterStatus!=='all') list = list.filter(o=>o.status===filterStatus);
  else list = list.filter(o=>o.status==='pending');
  if (searchTerm) list = list.filter(o=>
    o.customer.toLowerCase().includes(searchTerm) || o.phone.toLowerCase().includes(searchTerm) || o.id.toLowerCase().includes(searchTerm)
  );

  return `
    <div class="panel">
      <h2><span class="dot"></span>All orders (${list.length})</h2>
      ${statusPillRow(list, adminOrders, '_filterStatus')}
      <div class="filters">
        <input id="search-orders" placeholder="Search customer, phone, or order #" value="${escapeHtml(window._searchTerm||'')}" />
        <button class="btn-outline btn" id="search-btn" style="padding:9px 14px;">Search</button>
        <select id="filter-store"><option value="all">All stores</option>${storeOptions.map(s=>`<option value="${escapeHtml(s.store_id)}" ${s.store_id===filterStore?'selected':''}>${escapeHtml(s.store_name)}</option>`).join('')}</select>
        <button class="btn-outline btn" id="export-csv-btn" style="padding:9px 14px;">Export CSV</button>
        <button class="btn-outline btn" id="print-slips-btn" style="padding:9px 14px;">Print slips</button>
      </div>
      ${dateFilterBar('_ordersDateQuick')}
      <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:12.5px;margin-bottom:10px;">
        <input type="checkbox" id="select-all-cb" style="width:auto;margin:0;" ${list.length && list.every(o=>selectedOrderIds.has(o.id))?'checked':''}> Select all shown
      </label>
      ${selectedOrderIds.size?bulkBar(true):''}
      ${list.length ? list.map(o=>adminRow(o, adminOrders)).join('') : '<div class="empty">No orders match this filter.</div>'}
    </div>`;
}
function adminRow(o, allForRepeat){
  const sm = statusMeta(o.status);
  const total = (o.deliveryFee||0)+(o.otherCharges||0);
  const repeatCount = allForRepeat ? customerOrderCount(o.phone, allForRepeat) : 0;
  return `<div class="admin-row" style="grid-template-columns:auto 1.3fr auto auto auto auto;">
    <div class="order-row-check-group">
      <input type="checkbox" class="order-select-cb" data-id="${escapeHtml(o.id)}" ${selectedOrderIds.has(o.id)?'checked':''} />
      <div class="admin-store">${escapeHtml(o.store)}</div>
    </div>
    <div class="admin-main"><div class="item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''} <span class="mono" style="color:var(--slate);font-size:11px;">#${escapeHtml(o.id)}</span>${o.zone?` <span class="badge badge-role">📍 ${escapeHtml(o.zone)}</span>`:''}${repeatCount>1?` <span class="badge badge-ok">↻ Repeat (${repeatCount})</span>`:''}${o.isBackorder?` <span class="badge badge-notpicking">⏳ Backorder</span>`:''}</div>
    <div class="sub">${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}${o.altPhone?' / '+escapeHtml(o.altPhone):''} — to ${escapeHtml(o.dropoff)}${o.lastUpdatedBy?' · by '+escapeHtml(o.lastUpdatedBy):''}</div></div>
    <span class="badge ${sm.badge}">${sm.label}</span>
    <div class="admin-charges">${total ? `<b>${money(total)}</b>` : '—'}</div>
    <div class="stock-note">${o.stockDeducted ? 'stock deducted' : 'stock reserved'}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <button class="admin-update-btn" data-id="${escapeHtml(o.id)}">Update</button>
      ${o.prevStatus?`<button class="undo-btn" data-undo="${escapeHtml(o.id)}" title="Reverse back to ${statusMeta(o.prevStatus).label}">Undo</button>`:''}
      <button class="danger-btn" data-admin-trash="${escapeHtml(o.id)}">Trash</button>
    </div></div>`;
}
function updateModal(o){
  const isDelivered = o.status === 'delivered';
  const statusOptions = isDelivered ? STATUSES.filter(s=>s.v==='delivered'||s.v==='remitted') : STATUSES;
  return `<div class="modal-overlay" id="modal-overlay"><div class="modal">
    <h3>${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</h3><div class="id mono">#${escapeHtml(o.id)} · ${escapeHtml(o.store)}</div>
    <label>Status</label><select id="modal-status">${statusOptions.map(s=>`<option value="${s.v}" ${s.v===o.status?'selected':''}>${s.label}</option>`).join('')}</select>
    ${isDelivered?`<p class="hint" style="margin-bottom:16px;">This order is Delivered — from here it can only move forward to Remitted. If it was marked Delivered by mistake, close this and use the <b>Undo</b> button on the order instead.</p>`:''}
    <label>Rider / driver (optional)</label><input id="modal-rider" value="${escapeHtml(o.rider||'')}" placeholder="e.g. Tunde" />
    <div class="row2"><div><label>Delivery fee</label><input id="modal-delivery-fee" type="number" min="0" value="${o.deliveryFee||0}" /></div>
    <div><label>Other charges</label><input id="modal-other-charges" type="number" min="0" value="${o.otherCharges||0}" /></div></div>
    <label>Charge note</label><input id="modal-charge-note" value="${escapeHtml(o.chargeNote||'')}" placeholder="e.g. Failed delivery fee" />
    <label>Dispatch note</label><textarea id="modal-remark" rows="3">${escapeHtml(o.remark||'')}</textarea>
    <div class="modal-actions"><button class="btn btn-outline" id="modal-cancel">Cancel</button><button class="btn" id="modal-save" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Save update'}</button></div>
    </div></div>`;
}
function newOrdersPopup(list){
  return `<div class="modal-overlay" id="popup-overlay"><div class="modal">
    <h3>${list.length ? 'New orders waiting' : "You're all caught up"}</h3>
    <div class="id">${list.length ? list.length + ' order' + (list.length>1?'s':'') + ' need attention' : 'No unseen orders'}</div>
    ${list.slice(0,12).map(o=>`<div class="new-order-item"><span class="store-tag">${escapeHtml(o.store)}</span>${escapeHtml(o.item)} — ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}</div>`).join('')}
    <div class="modal-actions"><button class="btn btn-outline" id="popup-close">Close</button>${list.length ? '<button class="btn" id="popup-mark-seen">Mark all as seen</button>' : ''}</div>
    </div></div>`;
}
function attachOrdersHandlers(){
  attachStatusPillHandlers();
  if (actor.type==='store'){
    attachDateFilterHandlers('_historyDateQuick', reloadStoreOrdersWithDate);
    const gotoInvBtn = document.getElementById('goto-inventory-btn');
    if (gotoInvBtn) gotoInvBtn.onclick = () => { activeSection='inventory'; render(); };

    const submitBtn = document.getElementById('submit-order-btn');
    if (submitBtn){
      submitBtn.onclick = async () => {
        const productId = parseInt(document.getElementById('f-product').value, 10);
        const customer = document.getElementById('f-customer').value.trim();
        const phone = document.getElementById('f-phone').value.trim();
        const altPhone = document.getElementById('f-altphone').value.trim();
        const dropoff = document.getElementById('f-dropoff').value.trim();
        const zone = document.getElementById('f-zone').value.trim();
        const notes = document.getElementById('f-notes').value.trim();
        const amount = parseFloat(document.getElementById('f-amount').value) || 0;
        const qty = parseInt(document.getElementById('f-qty').value, 10) || 1;
        if (!productId || !customer || !phone || !dropoff){ showToast('Fill in name, product, address and phone number'); return; }
        if (qty < 1){ showToast('Quantity must be at least 1'); return; }
        const product = myProducts.find(i=>i.id===productId);
        const available = product && product.available!=null ? product.available : (product ? product.qty : 0);
        if (product && qty > available){
          if (!confirm(`Only ${available} of "${product.name}" available right now. This order will be placed as a backorder, to fulfill once restocked. Continue?`)) return;
        }
        busy = true; render();
        try{
          const r = await api('orders.php', {method:'POST', body:{product_id:productId, customer, phone, altPhone, dropoff, zone, notes, amount, qty}});
          await loadStoreData();
          showToast(r.is_backorder ? 'Order submitted as a backorder' : 'Order submitted');
        }catch(e){ showToast(e.message); }
        busy = false; render();
      };
    }
    const search = document.getElementById('search-history');
    if (search){ search.oninput = e=>{ window._historySearch = e.target.value; }; search.addEventListener('keydown', e=>{ if (e.key==='Enter') render(); }); }
    const searchBtn = document.getElementById('search-history-btn');
    if (searchBtn) searchBtn.onclick = () => render();

    document.querySelectorAll('[data-store-trash]').forEach(btn=>{
      btn.onclick = async () => {
        try{
          await api('orders.php', {method:'PATCH', body:{action:'trash', id:btn.dataset.storeTrash}});
          selectedOrderIds.delete(btn.dataset.storeTrash);
          await reloadStoreOrdersWithDate();
          showToast('Moved to Trash');
          render();
        }catch(e){ showToast(e.message); }
      };
    });

    const myTrashOpenBtn = document.getElementById('my-trash-open-btn');
    if (myTrashOpenBtn){
      myTrashOpenBtn.onclick = async () => {
        try{ await loadMyTrash(); showMyTrash = true; render(); }
        catch(e){ showToast(e.message); }
      };
    }
    const myTrashBackBtn = document.getElementById('my-trash-back-btn');
    if (myTrashBackBtn) myTrashBackBtn.onclick = () => { showMyTrash = false; render(); };
    document.querySelectorAll('[data-my-restore]').forEach(btn=>{
      btn.onclick = async () => {
        try{
          await api('orders.php', {method:'PATCH', body:{action:'restore', id:btn.dataset.myRestore}});
          await loadMyTrash(); await reloadStoreOrdersWithDate();
          showToast('Order restored');
          render();
        }catch(e){ showToast(e.message); }
      };
    });
  } else {
    attachDateFilterHandlers('_ordersDateQuick', reloadAdminOrdersWithDate);
    const fs = document.getElementById('filter-store');
    const search = document.getElementById('search-orders');
    if (fs) fs.onchange = async e => { window._filterStore = e.target.value; try{ await reloadAdminOrdersWithDate(); render(); }catch(err){ showToast(err.message); } };
    if (search){ search.oninput = e => { window._searchTerm = e.target.value; }; search.addEventListener('keydown', e=>{ if (e.key==='Enter'){ render(); } }); }
    const searchBtn = document.getElementById('search-btn');
    if (searchBtn) searchBtn.onclick = () => render();
    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) exportBtn.onclick = () => exportOrdersCsv(currentFilteredAdminOrders());
    const printBtn = document.getElementById('print-slips-btn');
    if (printBtn){
      printBtn.onclick = () => {
        const selected = adminOrders.filter(o=>selectedOrderIds.has(o.id));
        printOrderSlips(selected.length ? selected : currentFilteredAdminOrders());
      };
    }

    document.querySelectorAll('.admin-update-btn[data-id]').forEach(btn=>{
      btn.onclick = () => { modalOrder = adminOrders.find(o=>o.id===btn.dataset.id); render(); };
    });
    document.querySelectorAll('.undo-btn[data-undo]').forEach(btn=>{
      btn.onclick = async () => {
        try{
          await api('orders.php', {method:'PATCH', body:{action:'undo', id:btn.dataset.undo}});
          await reloadAdminOrdersWithDate();
          await loadAdminData();
          showToast('Order reversed');
          render();
        }catch(e){ showToast(e.message); }
      };
    });
    document.querySelectorAll('[data-admin-trash]').forEach(btn=>{
      btn.onclick = async () => {
        try{
          await api('orders.php', {method:'PATCH', body:{action:'trash', id:btn.dataset.adminTrash}});
          selectedOrderIds.delete(btn.dataset.adminTrash);
          await reloadAdminOrdersWithDate();
          showToast('Moved to Trash');
          render();
        }catch(e){ showToast(e.message); }
      };
    });
  }

  // Shared: checkbox selection + bulk bar (both store history list and admin orders list)
  document.querySelectorAll('.order-select-cb').forEach(cb=>{
    cb.onchange = () => { if (cb.checked) selectedOrderIds.add(cb.dataset.id); else selectedOrderIds.delete(cb.dataset.id); render(); };
  });
  const selectAll = document.getElementById('select-all-cb');
  if (selectAll){
    selectAll.onchange = () => {
      const ids = Array.from(document.querySelectorAll('.order-select-cb')).map(cb=>cb.dataset.id);
      if (selectAll.checked) ids.forEach(id=>selectedOrderIds.add(id)); else ids.forEach(id=>selectedOrderIds.delete(id));
      render();
    };
  }
  const bulkApply = document.getElementById('bulk-apply-btn');
  if (bulkApply){
    bulkApply.onclick = async () => {
      const action = document.getElementById('bulk-action-select').value;
      if (!action){ showToast('Choose a bulk action first'); return; }
      const ids = Array.from(selectedOrderIds);
      try{
        if (action === 'trash'){
          await api('orders.php', {method:'PATCH', body:{action:'bulk_trash', ids}});
          showToast(`${ids.length} order(s) moved to Trash`);
        } else if (action.startsWith('status:')){
          const status = action.split(':')[1];
          const r = await api('orders.php', {method:'PATCH', body:{action:'bulk_status', ids, status}});
          showToast(r.skipped ? `${r.updated} order(s) updated, ${r.skipped} skipped (Delivered can only move to Delivered/Remitted)` : `${r.updated} order(s) updated`);
          await loadAdminData(); // status changes can move physical stock (Delivered deducts, reversing credits back)
        }
        selectedOrderIds = new Set();
        if (actor.type==='store') await reloadStoreOrdersWithDate(); else await reloadAdminOrdersWithDate();
        render();
      }catch(e){ showToast(e.message); }
    };
  }
  const bulkClear = document.getElementById('bulk-clear-btn');
  if (bulkClear) bulkClear.onclick = () => { selectedOrderIds = new Set(); render(); };
}

/* ---------------- ADMIN: STORES ---------------- */
function adminStoresPanel(){
  const pending = resetRequestsStore;
  const primaries = adminAccounts.filter(a=>a.role==='owner');
  return `
    ${pending.length ? `<div class="panel"><h2><span class="dot"></span>Login help requests (${pending.length})</h2>
      ${pending.map(r=>`<div class="admin-row" style="grid-template-columns:1fr auto auto;">
        <div class="admin-main"><div class="item">${escapeHtml(r.label)}</div><div class="sub">Reach them at: ${escapeHtml(r.contact)}</div></div>
        <div></div><button class="admin-update-btn" data-resolve-reset="${r.id}">Mark resolved</button></div>`).join('')}
      </div>` : ''}
    <div class="panel"><h2><span class="dot"></span>Create a store</h2>
      <div class="row3">
        <div><label>Store name</label><input id="acc-storename" placeholder="e.g. Amaka's Boutique" /></div>
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="acc-password" type="password" placeholder="Set a password" autocomplete="new-password" /><button type="button" class="pw-toggle" data-target="acc-password">👁</button></div></div>
        <div style="display:flex;align-items:flex-start;"><button class="btn" id="acc-create-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Generate Store ID'}</button></div>
      </div>
    </div>
    <div class="panel"><h2><span class="dot"></span>Store &amp; team logins (${adminAccounts.length})</h2>
      <p class="hint">Click a store name to see its team members.</p>
      ${primaries.length ? primaries.map(storeAccordionRow).join('') : '<div class="empty">No logins created yet.</div>'}
    </div>`;
}
function storeAccordionRow(store){
  const team = adminAccounts.filter(a=>a.role==='agent' && a.parent_store_id===store.id);
  const expanded = expandedStores.has(store.id);
  return `
    <div style="border-bottom:1px solid var(--paper-dim);">
      <div class="admin-row" style="border-bottom:none;cursor:pointer;" data-toggle-store="${store.id}">
        <div class="admin-main"><div class="item">${expanded?'▾':'▸'} ${escapeHtml(store.store_name)}</div><div class="sub">Store ID: <span class="mono" style="font-weight:800;color:var(--ink);">${escapeHtml(store.store_id)}</span> · ${team.length} team member${team.length===1?'':'s'}</div></div>
        <span class="badge badge-ok">store</span><div></div>
        <button class="admin-update-btn" data-reset-store="${store.id}" data-label="${escapeHtml(store.store_name)} (${escapeHtml(store.store_id)})">Reset password</button>
        <button class="admin-update-btn" data-remove-store="${store.id}">Remove</button>
      </div>
      ${expanded ? `<div style="padding-left:24px;background:var(--paper);">
        ${team.length ? team.map(accountRow).join('') : '<div class="empty" style="margin:10px 0;">No team members for this store yet.</div>'}
      </div>` : ''}
    </div>`;
}
function accountRow(a){
  return `<div class="admin-row" style="grid-template-columns:1fr auto auto auto;">
    <div class="admin-main"><div class="item">${escapeHtml(a.position||'Team member')}</div><div class="sub">Store ID: <span class="mono" style="font-weight:800;color:var(--ink);">${escapeHtml(a.store_id)}</span></div></div>
    <span class="badge badge-role">team</span>
    <button class="admin-update-btn" data-reset-store="${a.id}" data-label="${escapeHtml(a.position||'Team member')} (${escapeHtml(a.store_id)})">Reset password</button>
    <button class="admin-update-btn" data-remove-store="${a.id}">Remove</button></div>`;
}
function attachStoresHandlers(){
  if (actor.type!=='admin') return;
  const createAccBtn = document.getElementById('acc-create-btn');
  if (createAccBtn){
    createAccBtn.onclick = async () => {
      const storeName = document.getElementById('acc-storename').value.trim();
      const password = document.getElementById('acc-password').value;
      if (!storeName || !password || password.length < 6){ showToast('Enter a store name and a password of at least 6 characters'); return; }
      busy = true; render();
      try{
        const r = await api('stores.php', {method:'POST', body:{store_name: storeName, password}});
        onceCred = {label:'Store login created — share these with the store:', storeId:r.store_id, password:r.password};
        await loadAdminData();
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
  document.querySelectorAll('[data-remove-store]').forEach(btn=>{
    btn.onclick = async () => {
      if (!confirm('Remove this login? They will no longer be able to log in. Order history stays intact.')) return;
      try{ await api('stores.php', {method:'DELETE', body:{id:parseInt(btn.dataset.removeStore,10)}}); await loadAdminData(); showToast('Login removed'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-reset-store]').forEach(btn=>{
    btn.onclick = () => { resetPwTarget = {kind:'store', id: parseInt(btn.dataset.resetStore,10), label: btn.dataset.label}; render(); };
  });
  document.querySelectorAll('[data-toggle-store]').forEach(row=>{
    row.onclick = (e) => {
      if (e.target.closest('button')) return;
      const id = row.dataset.toggleStore;
      if (expandedStores.has(id)) expandedStores.delete(id); else expandedStores.add(id);
      render();
    };
  });
  document.querySelectorAll('[data-resolve-reset]').forEach(btn=>{
    btn.onclick = async () => {
      try{
        await api('reset-requests.php', {method:'PATCH', body:{id:parseInt(btn.dataset.resolveReset,10)}});
        await Promise.all([loadResetRequests('store'), loadResetRequests('admin')]);
        showToast('Marked resolved'); render();
      }catch(e){ showToast(e.message); }
    };
  });
}

/* ---------------- ADMIN: ADMIN TEAM ---------------- */
function adminTeamPanel(){
  const pending = resetRequestsAdmin;
  return `
    ${pending.length ? `<div class="panel"><h2><span class="dot"></span>Login help requests (${pending.length})</h2>
      ${pending.map(r=>`<div class="admin-row" style="grid-template-columns:1fr auto auto;">
        <div class="admin-main"><div class="item">${escapeHtml(r.label)}</div><div class="sub">Reach them at: ${escapeHtml(r.contact)}</div></div>
        <div></div><button class="admin-update-btn" data-resolve-reset="${r.id}">Mark resolved</button></div>`).join('')}
      </div>` : ''}
    <div class="panel"><h2><span class="dot"></span>Create an admin login</h2>
      <p class="hint">Name their position, set a password, and tick what they're allowed to handle. Report access is always included.</p>
      <div class="row3">
        <div><label>Name</label><input id="admin-name" placeholder="e.g. Tunde" /></div>
        <div><label>Position</label><input id="admin-position" placeholder="e.g. Inventory Manager" /></div>
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="admin-password" type="password" placeholder="Set a password" autocomplete="new-password" /><button type="button" class="pw-toggle" data-target="admin-password">👁</button></div></div>
      </div>
      <label>What can they handle?</label>
      <div class="checklist">
        ${ADMIN_PERMS.map(p=>`<label><input type="checkbox" class="admin-perm-cb" value="${p.k}"> ${p.label}</label>`).join('')}
        <label><input type="checkbox" checked disabled> Report <span style="color:var(--slate);">(always included)</span></label>
      </div>
      <button class="btn" id="admin-create-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Generate Admin ID'}</button>
    </div>
    <div class="panel"><h2><span class="dot"></span>Admin team (${adminAdmins.length})</h2>
      ${adminAdmins.map(adminAccountRow).join('')}
    </div>`;
}
function adminAccountRow(a){
  const isMe = actor.admin_id===a.admin_id;
  const handles = ADMIN_PERMS.filter(p=>a.permissions && a.permissions[p.k]).map(p=>p.label);
  return `<div class="admin-row" style="grid-template-columns:1.3fr 1fr auto auto;">
    <div class="admin-main"><div class="item">${escapeHtml(a.name)}${a.position?' — '+escapeHtml(a.position):''}${isMe?' (you)':''}</div>
    <div class="sub">Admin ID: <span class="mono" style="font-weight:800;color:var(--ink);">${escapeHtml(a.admin_id)}</span></div></div>
    <div class="sub">Handles: ${handles.length?escapeHtml(handles.join(', ')):'—'}, Report</div>
    <div style="display:flex;gap:8px;">
      <button class="admin-update-btn" data-reset-admin="${a.id}" data-label="${escapeHtml(a.name)}${a.position?' — '+escapeHtml(a.position):''}">Reset password</button>
      <button class="admin-update-btn" data-admin="${a.id}" ${adminAdmins.length<=1?'disabled':''}>${adminAdmins.length<=1?'Only admin':'Remove'}</button>
    </div></div>`;
}
function attachAdminTeamHandlers(){
  if (actor.type!=='admin') return;
  document.querySelectorAll('.admin-update-btn[data-admin]').forEach(btn=>{
    btn.onclick = async () => {
      if (!confirm('Remove this admin login?')) return;
      try{ await api('admins.php', {method:'DELETE', body:{id:parseInt(btn.dataset.admin,10)}}); await loadAdminAdmins(); showToast('Admin removed'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
  const createAdminBtn = document.getElementById('admin-create-btn');
  if (createAdminBtn){
    createAdminBtn.onclick = async () => {
      const name = document.getElementById('admin-name').value.trim();
      const position = document.getElementById('admin-position').value.trim();
      const password = document.getElementById('admin-password').value;
      const checked = Array.from(document.querySelectorAll('.admin-perm-cb:checked')).map(cb=>cb.value);
      if (!name || !password || password.length < 6){ showToast('Enter a name and a password of at least 6 characters'); return; }
      busy = true; render();
      try{
        const r = await api('admins.php', {method:'POST', body:{name, position, password, permissions:checked}});
        onceCred = {label:'Admin login created — share these with them:', storeId:r.admin_id, password:r.password};
        await loadAdminAdmins();
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
  document.querySelectorAll('[data-reset-admin]').forEach(btn=>{
    btn.onclick = () => { resetPwTarget = {kind:'admin', id: parseInt(btn.dataset.resetAdmin,10), label: btn.dataset.label}; render(); };
  });
}

/* ---------------- ADMIN: WITHDRAWALS ---------------- */
function adminWithdrawalsPanel(){
  const pending = adminWithdrawals.pending || [];
  const resolved = adminWithdrawals.resolved || [];
  return `
    <div class="panel"><h2><span class="dot"></span>Pending withdrawal requests (${pending.length})</h2>
      ${pending.length ? pending.map(w=>`
        <div class="admin-row" style="grid-template-columns:1fr 1.3fr auto auto;">
          <div class="admin-main"><div class="item">${escapeHtml(w.store)}</div><div class="sub">Requested ${new Date(w.requestedAt).toLocaleString()}</div></div>
          <div class="sub">${w.bankName ? escapeHtml(w.bankName)+' · '+escapeHtml(w.accountNumber)+' · '+escapeHtml(w.accountName) : 'No bank details on file'}</div>
          <div style="font-weight:900;">${money(w.amount)}</div>
          <div style="display:flex;gap:8px;">
            <button class="admin-update-btn" data-withdraw-paid="${w.id}">Mark paid</button>
            <button class="admin-update-btn" data-withdraw-decline="${w.id}">Decline</button>
          </div>
        </div>`).join('') : '<div class="empty">No pending requests.</div>'}
    </div>
    <div class="panel"><h2><span class="dot"></span>Recent history</h2>
      ${resolved.length ? resolved.map(w=>`
        <div class="admin-row" style="grid-template-columns:1fr auto auto;">
          <div class="admin-main"><div class="item">${escapeHtml(w.store)}</div><div class="sub">Requested ${new Date(w.requestedAt).toLocaleString()}</div></div>
          <span class="badge ${w.status==='paid'?'badge-ok':'badge-issue'}">${w.status}</span>
          <div style="font-weight:900;">${money(w.amount)}</div>
        </div>`).join('') : '<div class="empty">No resolved requests yet.</div>'}
    </div>`;
}
function attachWithdrawalsHandlers(){
  if (actor.type!=='admin') return;
  document.querySelectorAll('[data-withdraw-paid]').forEach(btn=>{
    btn.onclick = async () => {
      try{ await api('withdrawals.php', {method:'PATCH', body:{id:parseInt(btn.dataset.withdrawPaid,10), status:'paid'}}); await loadAdminWithdrawals(); showToast('Marked as paid'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-withdraw-decline]').forEach(btn=>{
    btn.onclick = async () => {
      try{ await api('withdrawals.php', {method:'PATCH', body:{id:parseInt(btn.dataset.withdrawDecline,10), status:'declined'}}); await loadAdminWithdrawals(); showToast('Declined — balance returned to store'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
}

/* ---------------- ADMIN: EXPENSES ---------------- */
function adminExpensesPanel(){
  if (window._expenseDateQuick === undefined){
    const {from, to} = quickRangeDates('month');
    window._expenseDateQuick = 'month'; window._expenseDateFrom = from; window._expenseDateTo = to;
  }
  const q = window._expenseDateQuick || 'month';
  const feesEarned = adminExpenses.feesEarned || 0;
  const totalExpenses = adminExpenses.totalExpenses || 0;
  const netProfit = adminExpenses.netProfit || 0;
  const filteredExpenses = adminExpenses.expenses || [];
  return `
    <div class="panel">
      <h2><span class="dot"></span>Earnings summary <span style="text-transform:none;font-weight:400;font-size:11px;color:var(--slate);">(admin only — stores never see this)</span></h2>
      <div class="quickdate" style="margin-bottom:18px;">
        <button data-expensequick="today" class="${q==='today'?'active':''}">Today</button>
        <button data-expensequick="week" class="${q==='week'?'active':''}">This week</button>
        <button data-expensequick="month" class="${q==='month'?'active':''}">This month</button>
        <button data-expensequick="all" class="${q==='all'?'active':''}">All time</button>
        <span style="font-size:11px;color:var(--slate);margin-left:2px;">or:</span>
        <input type="date" id="expense-custom-from" value="${window._expenseDateFrom||''}" style="width:auto;margin-bottom:0;">
        <span style="font-size:11px;color:var(--slate);">to</span>
        <input type="date" id="expense-custom-to" value="${window._expenseDateTo||''}" style="width:auto;margin-bottom:0;">
        <button class="btn btn-sm" id="expense-custom-apply">Apply</button>
      </div>
      <div class="stat-row">
        <div class="stat" style="cursor:default;"><div class="n">${money(feesEarned)}</div><div class="l">Fees billed to stores</div></div>
        <div class="stat" style="cursor:default;"><div class="n">${money(totalExpenses)}</div><div class="l">Rider &amp; other expenses</div></div>
        <div class="stat" style="cursor:default;background:${netProfit>=0?'var(--green-dim)':'var(--red-dim)'};"><div class="n">${money(netProfit)}</div><div class="l">Net profit</div></div>
      </div>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Log an expense</h2>
      <div class="row3">
        <div><label>Type</label><select id="exp-type"><option value="rider">Rider payment</option><option value="other">Other expense</option></select></div>
        <div><label>Rider name / description</label><input id="exp-desc" placeholder="e.g. Tunde" /></div>
        <div><label>Amount</label><input id="exp-amount" type="number" min="0" placeholder="e.g. 1500" /></div>
      </div>
      <div class="row3">
        <div><label>Order # (optional)</label><input id="exp-order" placeholder="e.g. WB99EDXE" /></div>
        <div><label>Date</label><input id="exp-date" type="date" value="${todayStr()}" /></div>
        <div><label>Note (optional)</label><input id="exp-note" placeholder="Any extra detail" /></div>
      </div>
      <button class="btn" id="exp-add-btn">Log expense</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Expenses in this range (${filteredExpenses.length})</h2>
      ${filteredExpenses.length ? filteredExpenses.map(e=>`
        <div class="admin-row" style="grid-template-columns:auto 1fr auto auto;">
          <span class="badge ${e.type==='rider'?'badge-role':'badge-ok'}">${e.type==='rider'?'rider':'other'}</span>
          <div class="admin-main"><div class="item">${escapeHtml(e.desc||'—')}${e.orderRef?' · Order #'+escapeHtml(e.orderRef):''}</div><div class="sub">${escapeHtml(e.date)}${e.note?' · '+escapeHtml(e.note):''}</div></div>
          <div style="font-weight:900;">${money(e.amount)}</div>
          <button class="admin-update-btn" data-expense-remove="${e.id}">Remove</button>
        </div>`).join('') : '<div class="empty">No expenses logged in this range.</div>'}
    </div>`;
}
function attachExpensesHandlers(){
  if (actor.type!=='admin') return;
  document.querySelectorAll('[data-expensequick]').forEach(btn=>{
    btn.onclick = async () => {
      window._expenseDateQuick = btn.dataset.expensequick;
      const {from, to} = quickRangeDates(btn.dataset.expensequick);
      window._expenseDateFrom = from; window._expenseDateTo = to;
      try{ await loadExpenses(); render(); }catch(e){ showToast(e.message); }
    };
  });
  const customApply = document.getElementById('expense-custom-apply');
  if (customApply){
    customApply.onclick = async () => {
      window._expenseDateFrom = document.getElementById('expense-custom-from').value;
      window._expenseDateTo = document.getElementById('expense-custom-to').value;
      window._expenseDateQuick = 'custom';
      try{ await loadExpenses(); render(); }catch(e){ showToast(e.message); }
    };
  }
  const expAddBtn = document.getElementById('exp-add-btn');
  if (expAddBtn){
    expAddBtn.onclick = async () => {
      const type = document.getElementById('exp-type').value;
      const desc = document.getElementById('exp-desc').value.trim();
      const amount = parseFloat(document.getElementById('exp-amount').value) || 0;
      const orderRef = document.getElementById('exp-order').value.trim();
      const date = document.getElementById('exp-date').value || todayStr();
      const note = document.getElementById('exp-note').value.trim();
      if (!desc || amount<=0){ showToast('Enter a description and a valid amount'); return; }
      try{
        await api('expenses.php', {method:'POST', body:{type, desc, amount, orderRef, date, note}});
        await loadExpenses(); showToast('Expense logged'); render();
      }catch(e){ showToast(e.message); }
    };
  }
  document.querySelectorAll('[data-expense-remove]').forEach(btn=>{
    btn.onclick = async () => {
      try{ await api('expenses.php', {method:'DELETE', body:{id:parseInt(btn.dataset.expenseRemove,10)}}); await loadExpenses(); showToast('Expense removed'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
}

/* ---------------- ADMIN: CUSTOMERS (repeat-customer tracking) ---------------- */
function customersPanel(){
  return `<div class="panel"><h2><span class="dot"></span>Customers (${adminCustomers.length})</h2>
    <p class="hint">Tracked by phone number across every store — spot repeat customers and how much they've ordered in total.</p>
    <div class="filters">
      <input id="customer-search" placeholder="Search name or phone" value="${escapeHtml(window._customerSearch||'')}" />
      <button class="btn-outline btn" id="customer-search-btn" style="padding:9px 14px;">Search</button>
    </div>
    ${adminCustomers.length ? adminCustomers.map(c=>`
      <div class="admin-row" style="grid-template-columns:1.3fr auto auto auto;">
        <div class="admin-main"><div class="item">${escapeHtml(c.name)}${c.repeat?' <span class="badge badge-ok">↻ Repeat</span>':''}</div>
        <div class="sub">${escapeHtml(c.phone)} · Ordered from: ${escapeHtml(c.stores)}</div></div>
        <div style="font-weight:900;">${c.orderCount} order${c.orderCount>1?'s':''}</div>
        <div style="font-weight:900;">${money(c.totalAmount)}</div>
        <div style="font-size:11px;color:var(--slate);">Last: ${new Date(c.lastOrderAt).toLocaleDateString()}</div>
      </div>
    `).join('') : '<div class="empty">No customers yet.</div>'}
  </div>`;
}
function attachCustomersHandlers(){
  if (actor.type!=='admin') return;
  const search = document.getElementById('customer-search');
  if (search){
    search.oninput = e=>{ window._customerSearch = e.target.value; };
    search.addEventListener('keydown', async e=>{ if (e.key==='Enter'){ try{ await loadCustomers(window._customerSearch); render(); }catch(err){ showToast(err.message); } } });
  }
  const searchBtn = document.getElementById('customer-search-btn');
  if (searchBtn) searchBtn.onclick = async () => { try{ await loadCustomers(window._customerSearch); render(); }catch(e){ showToast(e.message); } };
}

/* ---------------- ADMIN: DELIVERY ZONES ---------------- */
function zonesPanel(){
  const drillZone = window._zoneDrill;
  const active = adminOrders.filter(o=>!o.deleted && !ARCHIVED_STATUSES.includes(o.status));

  if (!drillZone){
    const byZone = {};
    active.forEach(o=>{ const z = o.zone || 'Unspecified'; (byZone[z] = byZone[z] || []).push(o); });
    const zones = Object.keys(byZone).sort((a,b)=>byZone[b].length-byZone[a].length);
    return `<div class="panel"><h2><span class="dot"></span>Delivery zones</h2>
      <p class="hint">Active orders grouped by delivery area — click a zone to plan routes or batch nearby drops.</p>
      ${zones.length ? zones.map(z=>`<div class="day-row" data-drill-zone="${escapeHtml(z)}">
        <span class="dlabel">📍 ${escapeHtml(z)}</span><span class="dcount">${byZone[z].length} active order(s)</span><span class="dbal">▸</span>
      </div>`).join('') : '<div class="empty">No active orders yet.</div>'}
    </div>`;
  }

  const list = active.filter(o=>(o.zone||'Unspecified')===drillZone);
  return `<div class="panel"><h2><span class="dot"></span>Zone — ${escapeHtml(drillZone)} (${list.length})</h2>
    <button class="btn-outline btn btn-sm" id="zone-back-btn" style="margin-bottom:14px;">← Back to zones</button>
    ${list.length ? list.map(o=>adminRow(o, adminOrders)).join('') : '<div class="empty">No orders in this zone.</div>'}
  </div>`;
}
function attachZonesHandlers(){
  if (actor.type!=='admin') return;
  document.querySelectorAll('[data-drill-zone]').forEach(row=>{
    row.onclick = () => { window._zoneDrill = row.dataset.drillZone; render(); };
  });
  const backBtn = document.getElementById('zone-back-btn');
  if (backBtn) backBtn.onclick = () => { window._zoneDrill = null; render(); };
  if (!window._zoneDrill) return;
  // The zone-drill detail view reuses adminRow (Update/Undo/Trash), so it
  // needs the same row-level handlers the main Orders section attaches.
  document.querySelectorAll('.admin-update-btn[data-id]').forEach(btn=>{
    btn.onclick = () => { modalOrder = adminOrders.find(o=>o.id===btn.dataset.id); render(); };
  });
  document.querySelectorAll('.undo-btn[data-undo]').forEach(btn=>{
    btn.onclick = async () => {
      try{ await api('orders.php', {method:'PATCH', body:{action:'undo', id:btn.dataset.undo}}); await loadAdminData(); showToast('Order reversed'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-admin-trash]').forEach(btn=>{
    btn.onclick = async () => {
      try{ await api('orders.php', {method:'PATCH', body:{action:'trash', id:btn.dataset.adminTrash}}); await loadAdminData(); showToast('Moved to Trash'); render(); }
      catch(e){ showToast(e.message); }
    };
  });
}

/* ---------------- ADMIN: DELETED ORDERS (TRASH) ---------------- */
function trashPanel(){
  const list = adminTrash.slice().sort((a,b)=>b.updatedAt-a.updatedAt);
  return `<div class="panel">
    <h2><span class="dot"></span>Deleted Orders (${list.length})</h2>
    <p class="hint">Orders moved to Trash by stores, team members, or admins. Restore to bring an order back to normal view, or permanently delete — that cannot be undone.</p>
    ${list.length ? list.map(o=>{
      const sm = statusMeta(o.status);
      const total = (o.deliveryFee||0)+(o.otherCharges||0);
      return `<div class="admin-row" style="grid-template-columns:auto 1.3fr auto auto auto;">
        <div class="admin-store">${escapeHtml(o.store)}</div>
        <div class="admin-main"><div class="item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''} <span class="mono" style="color:var(--slate);font-size:11px;">#${escapeHtml(o.id)}</span></div>
        <div class="sub">${escapeHtml(o.customer)} · ${escapeHtml(o.phone)} — to ${escapeHtml(o.dropoff)}</div></div>
        <span class="badge ${sm.badge}">${sm.label}</span>
        <div class="admin-charges">${total ? `<b>${money(total)}</b>` : '—'}</div>
        <div style="display:flex;gap:8px;">
          <button class="restore-btn" data-restore="${escapeHtml(o.id)}">Restore</button>
          <button class="danger-btn" data-perm-delete="${escapeHtml(o.id)}">Delete forever</button>
        </div>
      </div>`;
    }).join('') : '<div class="empty">Trash is empty.</div>'}
  </div>`;
}
function attachTrashHandlers(){
  if (actor.type!=='admin') return;
  document.querySelectorAll('[data-restore]').forEach(btn=>{
    btn.onclick = async () => {
      try{
        await api('orders.php', {method:'PATCH', body:{action:'restore', id:btn.dataset.restore}});
        await loadTrash();
        showToast('Order restored');
        render();
      }catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-perm-delete]').forEach(btn=>{
    btn.onclick = async () => {
      if (!confirm('Permanently delete this order? This cannot be undone.')) return;
      try{
        await api('orders.php', {method:'DELETE', body:{id:btn.dataset.permDelete}});
        await loadTrash();
        showToast('Order permanently deleted');
        render();
      }catch(e){ showToast(e.message); }
    };
  });
}

/* ---------------- POPUPS ---------------- */
function attachPopupHandlers(){
  const overlay = document.getElementById('modal-overlay');
  if (overlay){
    document.getElementById('modal-cancel').onclick = () => { modalOrder = null; render(); };
    document.getElementById('modal-save').onclick = async () => {
      const status = document.getElementById('modal-status').value;
      const rider = document.getElementById('modal-rider').value.trim();
      const remark = document.getElementById('modal-remark').value.trim();
      const deliveryFee = parseFloat(document.getElementById('modal-delivery-fee').value) || 0;
      const otherCharges = parseFloat(document.getElementById('modal-other-charges').value) || 0;
      const chargeNote = document.getElementById('modal-charge-note').value.trim();
      if (status === 'delivered' && deliveryFee <= 0){
        if (!confirm('This order has no delivery fee attached. Continue moving it to Delivered anyway?')) return;
      }
      busy = true; render();
      try{
        await api('orders.php', {method:'PATCH', body:{id: modalOrder.id, status, rider, remark, deliveryFee, otherCharges, chargeNote}});
        modalOrder = null;
        await reloadAdminOrdersWithDate();
        await loadAdminData(); // status change can move physical stock (Delivered deducts, reversing credits back)
        showToast('Order updated');
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
    overlay.addEventListener('click', e => { if (e.target.id==='modal-overlay'){ modalOrder=null; render(); } });
  }
  const popupOverlay = document.getElementById('popup-overlay');
  if (popupOverlay){
    document.getElementById('popup-close').onclick = () => { popupOpen=false; render(); };
    const markSeenBtn = document.getElementById('popup-mark-seen');
    if (markSeenBtn){
      markSeenBtn.onclick = async () => {
        try{
          await api('unseen.php', {method:'POST', body:{action:'mark_seen'}});
          unseenCount = 0; unseenOrders = []; popupOpen = false;
          patchBellBadges(); render();
        }catch(e){ showToast(e.message); }
      };
    }
    popupOverlay.addEventListener('click', e => { if (e.target.id==='popup-overlay'){ popupOpen=false; render(); } });
  }
  const sentOverlay = document.getElementById('sentreport-overlay');
  if (sentOverlay){
    document.getElementById('sentreport-ack-btn').onclick = async () => {
      try{ await api('sent-reports.php', {method:'POST', body:{action:'ack'}}); mySentReports = []; reportPopupOpen = false; render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const lowOverlay = document.getElementById('lowstock-overlay');
  if (lowOverlay){
    const closeBtn = document.getElementById('lowstock-close');
    if (closeBtn) closeBtn.onclick = () => { lowStockPopupOpen=false; render(); };
    const gotoBtn = document.getElementById('lowstock-goto');
    if (gotoBtn) gotoBtn.onclick = () => { lowStockPopupOpen=false; activeSection='inventory'; render(); };
    lowOverlay.addEventListener('click', e => { if (e.target.id==='lowstock-overlay'){ lowStockPopupOpen=false; render(); } });
  }
  const withdrawOverlay = document.getElementById('withdraw-popup-overlay');
  if (withdrawOverlay){
    const markSeen = async () => {
      try{ await api('withdrawals.php', {method:'POST', body:{action:'mark_seen'}}); unseenWithdrawalCount = 0; }catch(e){}
    };
    document.getElementById('withdraw-popup-close').onclick = async () => { await markSeen(); withdrawalPopupOpen=false; render(); };
    document.getElementById('withdraw-popup-goto').onclick = async () => { await markSeen(); withdrawalPopupOpen=false; activeSection='withdrawals'; render(); };
    withdrawOverlay.addEventListener('click', e => { if (e.target.id==='withdraw-popup-overlay'){ withdrawalPopupOpen=false; render(); } });
  }
  const lowAdminOverlay = document.getElementById('lowstock-admin-overlay');
  if (lowAdminOverlay){
    document.getElementById('lowstock-admin-close').onclick = () => { lowStockAdminPopupOpen=false; render(); };
    document.getElementById('lowstock-admin-goto').onclick = () => { lowStockAdminPopupOpen=false; activeSection='inventory'; window._invDrillStore=null; render(); };
    lowAdminOverlay.addEventListener('click', e => { if (e.target.id==='lowstock-admin-overlay'){ lowStockAdminPopupOpen=false; render(); } });
  }
}

/* ---------------- PWA ---------------- */
function registerServiceWorker(){
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline shell is a nice-to-have, ignore failures */ });
  }
}

boot();
