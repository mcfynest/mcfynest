/* McFynest Logistics — production frontend. Vanilla JS, talks to
 * /api/*.php over fetch(). The render() function preserves focus/
 * selection/typed values across re-renders — a hard requirement carried
 * over from the prototype (an earlier auto-refresh design wiped
 * in-progress form input). Do not remove that behavior. Real-time-ish
 * updates (the admin unseen-order badge) only ever patch a small piece
 * of the DOM directly — they never call render(). */

const STATUSES = [
  {v:'pending', label:'Pending dispatch', badge:'badge-pending'},
  {v:'transit', label:'Out for delivery', badge:'badge-transit'},
  {v:'delivered', label:'Delivered', badge:'badge-delivered'},
  {v:'issue', label:'Issue / unreachable', badge:'badge-issue'},
  {v:'cancelled', label:'Cancelled', badge:'badge-cancelled'},
];
const statusMeta = v => STATUSES.find(s=>s.v===v) || STATUSES[0];
const LOW_STOCK_THRESHOLD = 1;
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const REMEMBERED_STORE_KEY = 'mcf_remembered_store';
const REMEMBERED_ADMIN_KEY = 'mcf_remembered_admin';

const STORE_TEAM_PERMS = [
  {k:'order', label:'New Order'}, {k:'inventory', label:'Stock Drop-offs'}, {k:'history', label:'Order History'},
];
const ADMIN_PERMS = [
  {k:'orders', label:'Orders'}, {k:'inventory', label:'Inventory'}, {k:'stores', label:'Stores'},
  {k:'team', label:'Admin Team'}, {k:'withdrawals', label:'Withdrawals'}, {k:'expenses', label:'Expenses'},
];

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
let resetRequestsStore = [];
let resetRequestsAdmin = [];
let unseenCount = 0;
let unseenOrders = [];

let reportData = {store:null, rows:[], totals:{amount:0, charge:0, balance:0}};

let storeTab = 'order';
let adminTab = 'orders';
let loginPickMode = null;   // 'store' | 'admin' | null (role screen)
let forgotMode = null;      // 'store' | 'admin' | null
let forgotSentContact = null;
let loginError = '';
let modalOrder = null;
let popupOpen = false;
let reportPopupOpen = false;
let pwChangeOpen = false;
let greetingDismissed = false;
let resetPwTarget = null;   // {kind:'agent'|'store'|'admin', id, label}
let onceCred = null;        // {label, storeId, password} shown right after creating/resetting a login
let expandedStores = new Set();
let busy = false;
let pollTimer = null;
let idleTimer = null;
let lastActivityAt = Date.now();

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
  if (actor && actor.type === 'store'){ await loadStoreData(); await checkForSentReports(); startIdleTimer(); }
  else if (actor && actor.type === 'admin'){ await loadAdminData(); await checkForNewOrders(); startQuietPoll(); startIdleTimer(); }
  render();
  registerServiceWorker();
}

/* ---------------- IDLE AUTO-LOGOUT (30 min of no clicks/typing) ---------------- */
function startIdleTimer(){
  lastActivityAt = Date.now();
  stopIdleTimer();
  idleTimer = setInterval(async () => {
    if (actor && Date.now() - lastActivityAt > IDLE_LIMIT_MS){
      stopIdleTimer(); stopQuietPoll();
      try{ await api('logout.php', {method:'POST'}); }catch(e){}
      actor = null; storeTab='order'; adminTab='orders'; popupOpen=false; loginPickMode=null;
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
    try{ const r = await api('unseen.php'); unseenCount = r.count; patchBellBadge(); }
    catch(e){ /* silent — background check, never surface errors */ }
  }, 25000);
}
function stopQuietPoll(){ if (pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

/** Updates only the little count bubble on the bell button — never
 * touches the rest of the DOM, so it can never steal focus or blow away
 * text an admin is mid-typing. This is the "quiet badge" requirement. */
function patchBellBadge(){
  const bell = document.getElementById('bell-btn');
  if (!bell) return;
  let count = bell.querySelector('.bell-count');
  if (unseenCount > 0){
    if (!count){ count = document.createElement('span'); count.className = 'bell-count'; bell.appendChild(count); }
    count.textContent = unseenCount;
  } else if (count){ count.remove(); }
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
  // Wallet is one of the two tabs every team member always has, and can
  // be the very first tab shown (e.g. a team member with every other
  // permission unchecked) — load it eagerly so it's never stale on
  // first paint, not just when the tab is clicked.
  try{ await loadWalletData(); }catch(e){ /* non-fatal — tab click will retry */ }
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
async function checkForSentReports(){
  try{ const r = await api('sent-reports.php'); mySentReports = r.pending; if (mySentReports.length){ reportPopupOpen = true; } }catch(e){}
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

/* ---------------- RENDER (focus-preserving) ---------------- */
function render(){
  const root = document.getElementById('root');
  const priorValues = {};
  root.querySelectorAll('input, textarea').forEach(el=>{ if(el.id) priorValues[el.id] = el.value; });
  const activeEl = document.activeElement;
  const activeId = (activeEl && root.contains(activeEl) && activeEl.id) ? activeEl.id : null;
  const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = activeEl && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

  if (!booted){ root.innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (!actor){
    root.innerHTML = roleScreen();
    if (forgotMode) attachForgotHandlers();
    else if (loginPickMode) attachLoginHandlers();
    else attachRoleHandlers();
    return;
  }
  if (actor.type === 'store'){ root.innerHTML = storeScreen(); attachStoreHandlers(); }
  else { root.innerHTML = adminScreen(); attachAdminHandlers(); }

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

/* ---------------- ROLE SELECT / LOGIN ---------------- */
function roleScreen(){
  if (forgotMode) return forgotScreen();
  if (loginPickMode === 'store') return storeLoginScreen();
  if (loginPickMode === 'admin') return adminLoginScreen();
  return `
    <div class="role-screen">
      <div class="display role-title">MCFYNEST LOGISTICS</div>
      <div class="role-tag">Keeping every delivery on track, together.</div>
      <div class="role-cards">
        <div class="role-card" id="pick-store">
          <div class="num">01 — STORE ACCESS</div>
          <h3>Store Portal</h3>
          <p>Log in with the Store ID and password your dispatcher created, raise orders, and track them.</p>
        </div>
        <div class="role-card" id="pick-admin">
          <div class="num">02 — DISPATCH ACCESS</div>
          <h3>Dispatch Admin</h3>
          <p>See every order and stock level, update status and charges, never miss a new order.</p>
        </div>
      </div>
    </div>`;
}
function attachRoleHandlers(){
  const s = document.getElementById('pick-store');
  const a = document.getElementById('pick-admin');
  if (s) s.onclick = () => { loginPickMode='store'; loginError=''; render(); };
  if (a) a.onclick = () => { loginPickMode='admin'; loginError=''; render(); };
}
function rememberedCreds(key){
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function storeLoginScreen(){
  const remembered = rememberedCreds(REMEMBERED_STORE_KEY);
  return `
    <div class="role-screen">
      <div class="display role-title" style="font-size:30px;">STORE LOGIN</div>
      <div class="role-tag">Enter the Store ID and password your dispatcher gave you.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>Store ID</label>
        <input id="store-id-input" placeholder="e.g. AMK-4821" value="${escapeHtml(remembered?remembered.id:'')}" autocomplete="username" />
        <label>Password</label>
        <div class="pw-field">
          <input id="store-pass-input" type="password" placeholder="Password" value="${escapeHtml(remembered?remembered.password:'')}" autocomplete="current-password" />
          <button type="button" class="pw-toggle" data-target="store-pass-input" aria-label="Show password">👁</button>
        </div>
        <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:13px;color:var(--ink);">
          <input type="checkbox" id="store-remember-cb" style="width:auto;margin:0;" ${remembered?'checked':''}> Remember my Store ID and password on this device
        </label>
        ${loginError ? `<div class="alert-banner">${escapeHtml(loginError)}</div>` : ''}
        <button class="btn" id="store-enter-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Enter portal'}</button>
        <button class="btn-outline btn" id="login-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back</button>
        <div style="text-align:center;margin-top:14px;"><a href="#" id="store-forgot-link" style="font-size:12px;color:var(--slate);">Forgot your Store ID or password?</a></div>
      </div>
    </div>`;
}
function adminLoginScreen(){
  const remembered = rememberedCreds(REMEMBERED_ADMIN_KEY);
  return `
    <div class="role-screen">
      <div class="display role-title" style="font-size:30px;">DISPATCH LOGIN</div>
      <div class="role-tag">Sign in with your dispatch admin ID and password.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>Admin ID</label>
        <input id="admin-id-input" placeholder="e.g. ADM-1001" value="${escapeHtml(remembered?remembered.id:'')}" autocomplete="username" />
        <label>Password</label>
        <div class="pw-field">
          <input id="admin-pass-input" type="password" placeholder="Password" value="${escapeHtml(remembered?remembered.password:'')}" autocomplete="current-password" />
          <button type="button" class="pw-toggle" data-target="admin-pass-input" aria-label="Show password">👁</button>
        </div>
        <label style="display:flex;align-items:center;gap:8px;text-transform:none;font-weight:400;font-size:13px;color:var(--ink);">
          <input type="checkbox" id="admin-remember-cb" style="width:auto;margin:0;" ${remembered?'checked':''}> Remember my Admin ID and password on this device
        </label>
        ${loginError ? `<div class="alert-banner">${escapeHtml(loginError)}</div>` : ''}
        <button class="btn" id="admin-enter-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Enter dispatch board'}</button>
        <button class="btn-outline btn" id="login-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back</button>
        <div style="text-align:center;margin-top:14px;"><a href="#" id="admin-forgot-link" style="font-size:12px;color:var(--slate);">Forgot your Admin ID or password?</a></div>
      </div>
    </div>`;
}
function attachLoginHandlers(){
  attachPasswordToggles();
  const back = document.getElementById('login-back-btn');
  if (back) back.onclick = () => { loginPickMode=null; loginError=''; render(); };
  const storeForgot = document.getElementById('store-forgot-link');
  if (storeForgot) storeForgot.onclick = (e) => { e.preventDefault(); forgotMode='store'; forgotSentContact=null; render(); };
  const adminForgot = document.getElementById('admin-forgot-link');
  if (adminForgot) adminForgot.onclick = (e) => { e.preventDefault(); forgotMode='admin'; forgotSentContact=null; render(); };

  const storeBtn = document.getElementById('store-enter-btn');
  if (storeBtn){
    const tryLogin = async () => {
      const id = document.getElementById('store-id-input').value.trim();
      const password = document.getElementById('store-pass-input').value;
      const remember = document.getElementById('store-remember-cb').checked;
      if (!id || !password){ showToast('Enter your Store ID and password'); return; }
      busy = true; render();
      try{
        const r = await api('login.php', {method:'POST', body:{mode:'store', id, password}});
        csrfToken = r.csrf_token; actor = r.actor; loginPickMode=null; loginError=''; greetingDismissed=false;
        if (remember){ localStorage.setItem(REMEMBERED_STORE_KEY, JSON.stringify({id, password})); }
        else { localStorage.removeItem(REMEMBERED_STORE_KEY); }
        await loadStoreData(); await checkForSentReports(); startIdleTimer();
      }catch(e){ loginError = e.message; }
      busy = false; render();
    };
    storeBtn.onclick = tryLogin;
    document.getElementById('store-pass-input').addEventListener('keydown', e=>{ if (e.key==='Enter') tryLogin(); });
  }
  const adminBtn = document.getElementById('admin-enter-btn');
  if (adminBtn){
    const tryLogin = async () => {
      const id = document.getElementById('admin-id-input').value.trim();
      const password = document.getElementById('admin-pass-input').value;
      const remember = document.getElementById('admin-remember-cb').checked;
      if (!id || !password){ showToast('Enter your admin ID and password'); return; }
      busy = true; render();
      try{
        const r = await api('login.php', {method:'POST', body:{mode:'admin', id, password}});
        csrfToken = r.csrf_token; actor = r.actor; loginPickMode=null; loginError=''; greetingDismissed=false;
        if (remember){ localStorage.setItem(REMEMBERED_ADMIN_KEY, JSON.stringify({id, password})); }
        else { localStorage.removeItem(REMEMBERED_ADMIN_KEY); }
        await loadAdminData(); await checkForNewOrders(); startQuietPoll(); startIdleTimer();
      }catch(e){ loginError = e.message; }
      busy = false; render();
    };
    adminBtn.onclick = tryLogin;
    document.getElementById('admin-pass-input').addEventListener('keydown', e=>{ if (e.key==='Enter') tryLogin(); });
  }
}
function forgotScreen(){
  if (forgotSentContact){
    return `
      <div class="role-screen">
        <div class="display role-title" style="font-size:26px;">REQUEST SENT</div>
        <div class="role-tag">Your dispatch admin has been notified and will verify your identity, then reset your login and contact you at ${escapeHtml(forgotSentContact)}.</div>
        <button class="btn" id="forgot-done-btn">Back to login</button>
      </div>`;
  }
  return `
    <div class="role-screen">
      <div class="display role-title" style="font-size:28px;">FORGOT LOGIN?</div>
      <div class="role-tag">Tell us who you are and how to reach you — this sends a request to your dispatch admin, who'll verify it's really you and reset your login.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>Your name / store name</label>
        <input id="forgot-label" placeholder="e.g. Amaka's Boutique" />
        <label>Your email or phone number</label>
        <input id="forgot-contact" placeholder="So we can reach you back" />
        <button class="btn" id="forgot-submit-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Send request'}</button>
        <button class="btn-outline btn" id="forgot-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back to login</button>
      </div>
    </div>`;
}
function attachForgotHandlers(){
  const doneBtn = document.getElementById('forgot-done-btn');
  if (doneBtn) doneBtn.onclick = () => { forgotMode=null; forgotSentContact=null; render(); };
  const backBtn = document.getElementById('forgot-back-btn');
  if (backBtn) backBtn.onclick = () => { loginPickMode = forgotMode; forgotMode=null; render(); };
  const submitBtn = document.getElementById('forgot-submit-btn');
  if (submitBtn){
    submitBtn.onclick = async () => {
      const label = document.getElementById('forgot-label').value.trim();
      const contact = document.getElementById('forgot-contact').value.trim();
      if (!label || !contact){ showToast('Fill in both fields'); return; }
      busy = true; render();
      try{
        await api('reset-requests.php', {method:'POST', body:{type: forgotMode, label, contact}});
        forgotSentContact = contact;
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
}

/* ---------------- GREETING BANNER ---------------- */
function greetingBanner(){
  if (greetingDismissed) return '';
  const hour = new Date().getHours();
  const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const fullName = actor.type === 'store' ? actor.store_name : actor.name;
  const firstName = (fullName || '').split(' ')[0];
  return `<div class="greeting-banner"><span>Good ${part}, ${escapeHtml(firstName)} — we're here to help you keep every delivery on track today.</span><button id="greeting-close-btn">×</button></div>`;
}
function attachGreetingHandler(){
  const btn = document.getElementById('greeting-close-btn');
  if (btn) btn.onclick = () => { greetingDismissed = true; render(); };
}

/* ---------------- HEADER ---------------- */
function header(){
  let label, extra = '';
  if (actor.type === 'store'){
    label = `Store: <b>${escapeHtml(actor.store_name)}</b>${!actor.is_primary?' · '+escapeHtml(actor.position||'Team member'):''}`;
    extra = `<button class="pw-change-btn" id="pw-change-open-btn">Change password</button>`;
  } else {
    label = `<b>${escapeHtml(actor.name || 'Dispatch Admin')}</b>${actor.position?' · '+escapeHtml(actor.position):''} <span class="mono" style="color:var(--slate);">(${escapeHtml(actor.admin_id)})</span>`;
    extra = `<button class="bell-btn" id="bell-btn">Check for new orders${unseenCount?`<span class="bell-count">${unseenCount}</span>`:''}</button>
             <button class="pw-change-btn" id="pw-change-open-btn">Change password</button>`;
  }
  return `
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div>
          <div class="brand-name display" style="font-size:18px;">${escapeHtml(appMeta.app_name.toUpperCase())}</div>
          <div class="brand-sub">Keeping every delivery on track, together.</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <div class="session-tag">${label}</div>
        ${extra}
        <button class="logout" id="logout-btn">Log out</button>
      </div>
    </div>`;
}
function attachHeaderHandlers(){
  document.getElementById('logout-btn').onclick = async () => {
    stopQuietPoll(); stopIdleTimer();
    try{ const r = await api('logout.php', {method:'POST'}); csrfToken = r.csrf_token; }catch(e){}
    actor = null; storeTab='order'; adminTab='orders'; popupOpen=false; loginPickMode=null;
    render();
  };
  const bell = document.getElementById('bell-btn');
  if (bell){
    bell.onclick = async () => {
      try{ await loadAdminData(); await checkForNewOrders(); popupOpen = true; render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const pwBtn = document.getElementById('pw-change-open-btn');
  if (pwBtn) pwBtn.onclick = () => { pwChangeOpen = true; render(); };
}
function passwordChangeModal(){
  const label = actor.type === 'admin' ? `${actor.name} (${actor.admin_id})` : `${actor.store_name} (${actor.store_id})`;
  return `<div class="modal-overlay" id="pw-modal-overlay"><div class="modal">
    <h3>Change your password</h3>
    <div class="id">Logged in as ${escapeHtml(label)}</div>
    <label>New password</label>
    <div class="pw-field"><input id="pw-new" type="password" placeholder="New password" /><button type="button" class="pw-toggle" data-target="pw-new">👁</button></div>
    <label>Confirm new password</label>
    <div class="pw-field"><input id="pw-confirm" type="password" placeholder="Confirm new password" /><button type="button" class="pw-toggle" data-target="pw-confirm">👁</button></div>
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
    <div class="once-box">
      <div>${escapeHtml(onceCred.label)}</div>
      <div class="cred">ID: <span class="mono">${escapeHtml(onceCred.storeId)}</span> &nbsp;·&nbsp; Password: <span class="mono">${escapeHtml(onceCred.password)}</span></div>
      <div class="warn">Copy this now — for security we can't show this password again after you leave this screen.</div>
      <button class="btn btn-sm btn-outline" id="once-cred-dismiss" style="margin-top:10px;">I've copied it</button>
    </div>`;
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
          <input id="reset-pw-input" type="password" placeholder="New password" />
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

/* ---------------- DATE QUICK FILTERS ---------------- */
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
  return `<div class="quickdate" style="margin-bottom:18px;">
    <button data-quickdate="all" data-quickkey="${activeKey}" class="${q==='all'?'active':''}">All time</button>
    <button data-quickdate="today" data-quickkey="${activeKey}" class="${q==='today'?'active':''}">Today</button>
    <button data-quickdate="week" data-quickkey="${activeKey}" class="${q==='week'?'active':''}">This week</button>
    <button data-quickdate="month" data-quickkey="${activeKey}" class="${q==='month'?'active':''}">This month</button>
  </div>`;
}

/* ---------------- STORE ---------------- */
function storePerms(){ return actor.is_primary ? {order:true, inventory:true, history:true} : (actor.permissions || {}); }
function storeScreen(){
  const perms = storePerms();
  const lowItems = myProducts.filter(i=>i.qty<=LOW_STOCK_THRESHOLD);
  const tabs = [];
  if (perms.order) tabs.push({k:'order', label:'New order'});
  if (perms.inventory) tabs.push({k:'inventory', label:`Stock drop-offs (${myProducts.length})`});
  if (actor.is_primary) tabs.push({k:'team', label:`Team (${myAgents.length})`});
  if (perms.history) tabs.push({k:'history', label:`Your orders (${myOrders.length})`});
  tabs.push({k:'wallet', label:'Wallet'});
  tabs.push({k:'report', label:'Daily report'});
  if (!tabs.find(t=>t.k===storeTab)) storeTab = tabs[0].k;

  return `
    ${header()}
    ${greetingBanner()}
    ${lowItems.length ? `<div class="alert-banner">⚠ Low stock: ${lowItems.map(i=>escapeHtml(i.name)+' ('+i.qty+' left)').join(', ')}</div>` : ''}
    <div class="tabs">${tabs.map(t=>`<button class="tab-btn ${storeTab===t.k?'active':''}" data-tab="${t.k}">${t.label}</button>`).join('')}</div>
    ${storeTab==='order' ? storeOrderPanel(myProducts) : ''}
    ${storeTab==='inventory' && perms.inventory ? storeInventoryPanel(myProducts) : ''}
    ${storeTab==='team' && actor.is_primary ? storeTeamPanel(myProducts, myAgents) : ''}
    ${storeTab==='history' && perms.history ? storeHistoryPanel(myOrders) : ''}
    ${storeTab==='wallet' ? storeWalletPanel() : ''}
    ${storeTab==='report' ? reportPanel(false, null) : ''}
    ${pwChangeOpen ? passwordChangeModal() : ''}
    ${reportPopupOpen ? sentReportPopup(mySentReports) : ''}
    ${resetPwTarget && resetPwTarget.kind==='agent' ? resetPasswordModal() : ''}
  `;
}
function storeOrderPanel(availableInv){
  return `
    <div class="panel">
      <h2><span class="dot"></span>New order — from stock dropped off with us</h2>
      ${availableInv.length===0 ? `
        <div class="empty">
          You haven't dropped off any stock with us yet.
          ${storePerms().inventory ? '<br><br><button class="btn" id="goto-inventory-btn">Log a stock drop-off</button>' : ''}
        </div>` : `
      <div class="row3">
        <div><label>Customer name</label><input id="f-customer" placeholder="e.g. Chidi Okafor" /></div>
        <div><label>Product</label><select id="f-product">
          ${availableInv.map(i=>`<option value="${i.id}" ${i.qty<=0?'disabled':''}>${escapeHtml(i.name)} — ${i.qty} in stock${i.qty<=0?' (out of stock)':''}</option>`).join('')}
        </select></div>
        <div><label>Quantity</label><input id="f-qty" type="number" min="1" value="1" /></div>
      </div>
      <div class="row3">
        <div><label>Delivery address</label><input id="f-dropoff" placeholder="Where it's going" /></div>
        <div><label>Phone number</label><input id="f-phone" placeholder="0803 000 0000" /></div>
        <div><label>Alternate phone (optional)</label><input id="f-altphone" placeholder="Backup contact" /></div>
      </div>
      <div class="row2">
        <div><label>Amount (optional)</label><input id="f-amount" type="number" min="0" placeholder="e.g. 33000" /></div>
        <div><label>Specific instructions (optional)</label><input id="f-notes" placeholder="e.g. fragile, call before arriving" /></div>
      </div>
      <button class="btn" id="submit-order-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Submit order'}</button>
      `}
    </div>`;
}
function storeInventoryPanel(myInv){
  return `
    <div class="panel">
      <h2><span class="dot"></span>Log a stock drop-off</h2>
      <p class="hint">When you bring products to us, log them here.</p>
      <div class="row3">
        <div><label>Product name</label><input id="inv-name" placeholder="e.g. Black sneakers, size 42" /></div>
        <div><label>Quantity dropped off</label><input id="inv-qty" type="number" min="0" value="1" /></div>
        <div><label>Date dropped off</label><input id="inv-date" type="date" value="${todayStr()}" /></div>
      </div>
      <button class="btn" id="inv-add-btn">Log drop-off</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Stock we're currently holding for you</h2>
      ${myInv.length ? myInv.map(invRow).join('') : '<div class="empty">Nothing logged yet.</div>'}
    </div>`;
}
function storeTeamPanel(myInv, myAgentsList){
  return `
    ${onceCred ? onceCredBox() : ''}
    <div class="panel">
      <h2><span class="dot"></span>Add a team member</h2>
      <p class="hint">Give a team member their own login. Tick what their position covers below — everything's checked by default, so they start with full access like you, minus managing the team.</p>
      <div class="row2">
        <div><label>Position / title</label><input id="agent-position" placeholder="e.g. Customer Care Agent" /></div>
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="agent-password" type="password" placeholder="Set a password" /><button type="button" class="pw-toggle" data-target="agent-password">👁</button></div></div>
      </div>
      <label>What this position handles</label>
      <div class="checklist">
        ${STORE_TEAM_PERMS.map(p=>`<label><input type="checkbox" class="agent-perm-cb" value="${p.k}" checked> ${p.label}</label>`).join('')}
        <label><input type="checkbox" checked disabled> Wallet (view balance only) &amp; Daily Report <span style="color:var(--slate);">(always included)</span></label>
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
function invRow(i){
  const low = i.qty<=LOW_STOCK_THRESHOLD;
  return `<div class="inv-row"><div><div class="inv-name">${escapeHtml(i.name)}</div>${i.dropped_off_at ? `<div class="inv-date">Dropped off ${escapeHtml(i.dropped_off_at)}</div>` : ''}</div>
    <span class="badge ${low?'badge-low':'badge-ok'}">${low ? (i.qty<=0?'Out of stock':'Low stock') : 'In stock'}</span>
    <div class="inv-qty">${i.qty}</div>
    <div class="inv-actions"><button class="qty-btn" data-inv="${i.id}" data-delta="-1">−</button><button class="qty-btn" data-inv="${i.id}" data-delta="1">+</button></div><div></div></div>`;
}
function storeHistoryPanel(mine){
  return `<div class="panel"><h2><span class="dot"></span>Your orders</h2>
    ${dateFilterBar('_historyDateQuick')}
    ${mine.length ? mine.slice().sort((a,b)=>b.createdAt-a.createdAt).map(stubCard).join('') : '<div class="empty">No orders in this range.</div>'}
  </div>`;
}
function storeWalletPanel(){
  const balance = myWallet.balance || 0;
  const hasBank = myBank.bankName && myBank.accountNumber && myBank.accountName;
  const alreadyToday = myWallet.requestedToday;
  return `
    <div class="panel">
      <h2><span class="dot"></span>Wallet</h2>
      <p class="hint">Your balance updates automatically the moment an order is marked Delivered — the amount collected, minus delivery charges, lands here.</p>
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
function sentReportPopup(pending){
  return `<div class="modal-overlay" id="sentreport-overlay"><div class="modal">
    <h3>Your dispatch team sent a report</h3>
    <div class="id">${pending.length} report${pending.length>1?'s':''} ready for you to review</div>
    ${pending.map(r=>`<div class="new-order-item">📅 ${escapeHtml(formatDateRangeLabel(r.dateFrom, r.dateTo))} — sent ${new Date(r.sentAt).toLocaleString()}. Open the Daily Report tab to see the full breakdown.</div>`).join('')}
    <div class="modal-actions"><button class="btn" id="sentreport-ack-btn">Got it</button></div>
    </div></div>`;
}
function stubCard(o){
  const sm = statusMeta(o.status);
  const dCharge = (o.deliveryFee||0)+(o.otherCharges||0);
  return `<div class="stub"><div class="stub-top"><div><div class="stub-id mono">#${escapeHtml(o.id)}</div><div class="stub-item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</div></div><span class="badge ${sm.badge}">${sm.label}</span></div>
    <div class="stub-grid"><div><span class="k">Customer:</span> ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}${o.altPhone?' / '+escapeHtml(o.altPhone):''}</div><div><span class="k">Deliver to:</span> ${escapeHtml(o.dropoff)}</div></div>
    ${o.notes ? `<div class="stub-remark"><span class="k">Instructions:</span> ${escapeHtml(o.notes)}</div>` : ''}
    ${o.remark ? `<div class="stub-remark"><span class="k">Dispatch note:</span> ${escapeHtml(o.remark)}</div>` : ''}
    <div class="stub-charges">
      ${o.amount ? `<span>Amount: <b>${money(o.amount)}</b></span>` : ''}
      ${dCharge ? `<span>Delivery charge: <b>${money(dCharge)}</b></span>` : ''}
      ${o.amount || dCharge ? `<span>Balance: <b>${money((o.amount||0)-dCharge)}</b></span>` : ''}
    </div>
    <div class="stub-meta">Submitted ${new Date(o.createdAt).toLocaleString()}${o.rider ? ' · Rider: '+escapeHtml(o.rider) : ''}${o.lastUpdatedBy ? ' · Last updated by '+escapeHtml(o.lastUpdatedBy) : ''}</div></div>`;
}
async function reloadStoreHistoryWithDate(){
  const perms = storePerms();
  if (!perms.history) return;
  const params = new URLSearchParams();
  if (window._historyDateFrom) params.set('date_from', window._historyDateFrom);
  if (window._historyDateTo) params.set('date_to', window._historyDateTo);
  const r = await api('orders.php?' + params.toString());
  myOrders = r.orders;
}
function attachStoreHandlers(){
  attachHeaderHandlers();
  attachPasswordToggles();
  attachGreetingHandler();
  attachPasswordChangeHandlers();
  attachReportHandlers(false);
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn=>{
    btn.onclick = async () => {
      storeTab = btn.dataset.tab; onceCred=null; render();
      if (storeTab === 'wallet'){ try{ await loadWalletData(); render(); }catch(e){ showToast(e.message); } }
      if (storeTab === 'report'){ try{ await loadReportData(null, ''); render(); }catch(e){ showToast(e.message); } }
    };
  });
  document.querySelectorAll('[data-quickdate]').forEach(btn=>{
    btn.onclick = async () => {
      const key = btn.dataset.quickkey;
      window[key] = btn.dataset.quickdate;
      const {from, to} = quickRangeDates(btn.dataset.quickdate);
      if (key === '_historyDateQuick'){
        window._historyDateFrom = from; window._historyDateTo = to;
        try{ await reloadStoreHistoryWithDate(); render(); }catch(e){ showToast(e.message); }
      }
    };
  });
  const gotoInvBtn = document.getElementById('goto-inventory-btn');
  if (gotoInvBtn) gotoInvBtn.onclick = () => { storeTab='inventory'; render(); };

  const submitBtn = document.getElementById('submit-order-btn');
  if (submitBtn){
    submitBtn.onclick = async () => {
      const productId = parseInt(document.getElementById('f-product').value, 10);
      const customer = document.getElementById('f-customer').value.trim();
      const phone = document.getElementById('f-phone').value.trim();
      const altPhone = document.getElementById('f-altphone').value.trim();
      const dropoff = document.getElementById('f-dropoff').value.trim();
      const notes = document.getElementById('f-notes').value.trim();
      const amount = parseFloat(document.getElementById('f-amount').value) || 0;
      const qty = parseInt(document.getElementById('f-qty').value, 10) || 1;
      if (!productId || !customer || !phone || !dropoff){ showToast('Fill in name, product, address and phone number'); return; }
      if (qty < 1){ showToast('Quantity must be at least 1'); return; }
      busy = true; render();
      try{
        await api('orders.php', {method:'POST', body:{product_id:productId, customer, phone, altPhone, dropoff, notes, amount, qty}});
        await loadStoreData();
        showToast('Order submitted — stock updated');
      }catch(e){ showToast(e.message); }
      busy = false; render();
    };
  }
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
  document.querySelectorAll('.qty-btn').forEach(btn=>{
    btn.onclick = async () => {
      try{
        await api('products.php', {method:'PATCH', body:{id:parseInt(btn.dataset.inv,10), delta:parseInt(btn.dataset.delta,10)}});
        await loadStoreData();
        render();
      }catch(e){ showToast(e.message); }
    };
  });
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
  const onceDismiss = document.getElementById('once-cred-dismiss');
  if (onceDismiss) onceDismiss.onclick = () => { onceCred = null; render(); };

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
  attachResetPasswordModalHandlers(async (newPassword) => {
    const r = await api('team.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
    onceCred = {label:'New password set — share it with your team member:', storeId: myAgents.find(a=>a.id===resetPwTarget.id).store_id, password:r.new_password};
    resetPwTarget = null;
  });

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
  const sentReportOverlay = document.getElementById('sentreport-overlay');
  if (sentReportOverlay){
    document.getElementById('sentreport-ack-btn').onclick = async () => {
      try{ await api('sent-reports.php', {method:'POST', body:{action:'ack'}}); mySentReports = []; reportPopupOpen = false; render(); }
      catch(e){ showToast(e.message); }
    };
  }
}

/* ---------------- REPORT (shared store + admin) ---------------- */
function formatDateRangeLabel(from, to){
  if (!from && !to) return 'All time — no date limit';
  const fmt = (s) => { const d = new Date(s+'T00:00:00'); return d.toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}); };
  if (from===to) return fmt(from);
  return fmt(from) + ' – ' + fmt(to);
}
function reportPanel(isAdmin, storeNames){
  if (window._reportDateFrom === undefined){
    const {from, to} = quickRangeDates('today');
    window._reportDateQuick = 'today'; window._reportDateFrom = from; window._reportDateTo = to;
  }
  const q = window._reportDateQuick || 'today';
  const rows = reportData.rows || [];
  const totals = reportData.totals || {amount:0, charge:0, balance:0};
  return `<div class="panel">
    <h2><span class="dot"></span>Report ${reportData.store?'— '+escapeHtml(reportData.store):''}</h2>
    <div style="font-size:14px;font-weight:800;color:var(--ink);margin-bottom:12px;">📅 ${formatDateRangeLabel(window._reportDateFrom, window._reportDateTo)}</div>
    <p class="hint">Grouped by the day each order was last resolved (e.g. delivered), not the day it was placed — so orders dropped off earlier still show up on the day they were actually completed.</p>
    <div class="filters">
      ${isAdmin ? `<select id="report-store-select">${(storeNames||[]).map(s=>`<option value="${escapeHtml(s.store_id)}" ${s.store_id===window._reportStoreId?'selected':''}>${escapeHtml(s.store_name)}</option>`).join('')}</select>` : ''}
      <input id="report-search" placeholder="Search customer or phone" value="${escapeHtml(window._reportSearch||'')}" />
      <div class="quickdate">
        <button data-reportquick="today" class="${q==='today'?'active':''}">Today</button>
        <button data-reportquick="week" class="${q==='week'?'active':''}">This week</button>
        <button data-reportquick="month" class="${q==='month'?'active':''}">This month</button>
        <button data-reportquick="all" class="${q==='all'?'active':''}">All time</button>
      </div>
    </div>
    ${rows.length ? `<div style="overflow-x:auto;"><table class="report">
      <thead><tr><th>Customer</th><th>Product</th><th>Address</th><th>Status</th><th>Amount</th><th>Delivery charge</th><th>Balance</th></tr></thead>
      <tbody>${rows.map(o=>`<tr><td>${escapeHtml(o.customer)}</td><td>${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</td><td>${escapeHtml(o.dropoff)}</td>
        <td><span class="badge ${statusMeta(o.status).badge}">${statusMeta(o.status).label}</span></td>
        <td>${o.amount?money(o.amount):'—'}</td><td>${o.charge?money(o.charge):'—'}</td><td><b>${money(o.balance)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">Totals</td><td>${money(totals.amount)}</td><td>${money(totals.charge)}</td><td>${money(totals.balance)}</td></tr></tfoot>
    </table></div>` : '<div class="empty">No orders in this range.</div>'}
    ${isAdmin && reportData.store ? `<div style="margin-top:18px;"><button class="btn" id="send-report-btn">Send this report to ${escapeHtml(reportData.store)}</button></div>` : ''}
  </div>`;
}
function attachReportHandlers(isAdmin){
  document.querySelectorAll('[data-reportquick]').forEach(btn=>{
    btn.onclick = async () => {
      window._reportDateQuick = btn.dataset.reportquick;
      const {from, to} = quickRangeDates(btn.dataset.reportquick);
      window._reportDateFrom = from; window._reportDateTo = to;
      try{ await loadReportData(isAdmin ? window._reportStoreId : null, window._reportSearch); render(); }
      catch(e){ showToast(e.message); }
    };
  });
  const storeSelect = document.getElementById('report-store-select');
  if (storeSelect){
    storeSelect.onchange = async (e) => {
      window._reportStoreId = e.target.value;
      try{ await loadReportData(window._reportStoreId, window._reportSearch); render(); }
      catch(e){ showToast(e.message); }
    };
  }
  const search = document.getElementById('report-search');
  if (search){
    search.oninput = e => { window._reportSearch = e.target.value; };
    search.addEventListener('keydown', async e => {
      if (e.key==='Enter'){
        try{ await loadReportData(isAdmin ? window._reportStoreId : null, window._reportSearch); render(); }
        catch(err){ showToast(err.message); }
      }
    });
  }
  const sendBtn = document.getElementById('send-report-btn');
  if (sendBtn){
    sendBtn.onclick = async () => {
      const range = window._reportDateQuick || 'today';
      const label = range==='today' ? 'Today' : range==='week' ? 'This week' : range==='month' ? 'This month' : 'All time';
      try{
        await api('report.php', {method:'POST', body:{store_id: window._reportStoreId, range_label: label, date_from: window._reportDateFrom, date_to: window._reportDateTo}});
        showToast(`Report sent to ${reportData.store}`);
      }catch(e){ showToast(e.message); }
    };
  }
}

/* ---------------- ADMIN ---------------- */
function adminScreen(){
  const perms = actor.permissions || {};
  const tabs = ADMIN_PERMS.filter(t=>perms[t.k]).concat([{k:'report', label:'Report'}]);
  if (!tabs.find(t=>t.k===adminTab)) adminTab = tabs[0].k;

  return `
    ${header()}
    ${greetingBanner()}
    <div class="tabs">${tabs.map(t=>`<button class="tab-btn ${adminTab===t.k?'active':''}" data-admintab="${t.k}">${t.label}</button>`).join('')}</div>
    ${adminTab==='orders' && perms.orders ? adminOrdersPanel() : ''}
    ${adminTab==='inventory' && perms.inventory ? adminInventoryPanel() : ''}
    ${adminTab==='stores' && perms.stores ? adminStoresPanel() : ''}
    ${adminTab==='team' && perms.team ? adminTeamPanel() : ''}
    ${adminTab==='withdrawals' && perms.withdrawals ? adminWithdrawalsPanel() : ''}
    ${adminTab==='expenses' && perms.expenses ? adminExpensesPanel() : ''}
    ${adminTab==='report' ? reportPanel(true, reportData.storeOptions || []) : ''}
    ${modalOrder ? updateModal(modalOrder) : ''}
    ${popupOpen ? newOrdersPopup(unseenOrders) : ''}
    ${pwChangeOpen ? passwordChangeModal() : ''}
    ${onceCred ? onceCredBox() : ''}
    ${resetPwTarget && (resetPwTarget.kind==='store'||resetPwTarget.kind==='admin') ? resetPasswordModal() : ''}
  `;
}
async function reloadAdminOrdersWithDate(){
  const params = new URLSearchParams();
  if (window._filterStore && window._filterStore !== 'all') params.set('store_id', window._filterStore);
  if (window._ordersDateFrom) params.set('date_from', window._ordersDateFrom);
  if (window._ordersDateTo) params.set('date_to', window._ordersDateTo);
  const r = await api('orders.php?' + params.toString());
  adminOrders = r.orders;
}
function adminOrdersPanel(){
  const storeOptions = adminAccounts.filter(a=>a.role==='owner').slice().sort((a,b)=>a.store_name.localeCompare(b.store_name));
  const filterStore = window._filterStore || 'all';
  const filterStatus = window._filterStatus || 'all';
  const searchTerm = (window._searchTerm || '').toLowerCase();
  let list = adminOrders.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if (filterStatus!=='all') list = list.filter(o=>o.status===filterStatus);
  if (searchTerm) list = list.filter(o=>
    o.customer.toLowerCase().includes(searchTerm) || o.phone.toLowerCase().includes(searchTerm) || o.id.toLowerCase().includes(searchTerm)
  );
  const counts = {}; STATUSES.forEach(s=>counts[s.v]=0);
  adminOrders.forEach(o=>counts[o.status]=(counts[o.status]||0)+1);
  const lowStockAll = adminProducts.filter(i=>i.qty<=LOW_STOCK_THRESHOLD);

  return `
    ${lowStockAll.length ? `<div class="alert-banner">⚠ ${lowStockAll.length} product${lowStockAll.length>1?'s':''} low or out of stock: ${lowStockAll.map(i=>escapeHtml(i.store_name)+' — '+escapeHtml(i.name)+' ('+i.qty+')').join(', ')}</div>` : ''}
    <div class="stat-row">
      <div class="stat ${filterStatus==='all'?'active':''}" data-statfilter="all"><div class="n">${adminOrders.length}</div><div class="l">Total orders</div></div>
      ${STATUSES.map(s=>`<div class="stat ${filterStatus===s.v?'active':''}" data-statfilter="${s.v}"><div class="n">${counts[s.v]}</div><div class="l">${s.label}</div></div>`).join('')}
    </div>
    <div class="panel">
      <h2><span class="dot"></span>All orders (${list.length})</h2>
      ${dateFilterBar('_ordersDateQuick')}
      <div class="filters">
        <input id="search-orders" placeholder="Search customer, phone, or order #" value="${escapeHtml(window._searchTerm||'')}" />
        <button class="btn-outline btn" id="search-btn" style="padding:10px 16px;">Search</button>
        <select id="filter-store"><option value="all">All stores</option>${storeOptions.map(s=>`<option value="${escapeHtml(s.store_id)}" ${s.store_id===filterStore?'selected':''}>${escapeHtml(s.store_name)}</option>`).join('')}</select>
        <select id="filter-status"><option value="all">All statuses</option>${STATUSES.map(s=>`<option value="${s.v}" ${s.v===filterStatus?'selected':''}>${s.label}</option>`).join('')}</select>
      </div>
      ${list.length ? list.map(adminRow).join('') : '<div class="empty">No orders match this filter.</div>'}
    </div>`;
}
function adminInventoryPanel(){
  const storeNames = [...new Set(adminProducts.map(i=>i.store_name))].sort();
  const invFilterStore = window._invFilterStore || 'all';
  let invList = adminProducts.slice().sort((a,b)=> (a.store_name+a.name).localeCompare(b.store_name+b.name));
  if (invFilterStore!=='all') invList = invList.filter(i=>i.store_name===invFilterStore);
  return `<div class="panel"><h2><span class="dot"></span>Inventory across stores (${invList.length})</h2>
    <div class="filters"><select id="inv-filter-store"><option value="all">All stores</option>${storeNames.map(s=>`<option value="${escapeHtml(s)}" ${s===invFilterStore?'selected':''}>${escapeHtml(s)}</option>`).join('')}</select></div>
    ${invList.length ? invList.map(adminInvRow).join('') : '<div class="empty">No inventory logged yet.</div>'}</div>`;
}
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
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="acc-password" type="password" placeholder="Set a password" /><button type="button" class="pw-toggle" data-target="acc-password">👁</button></div></div>
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
        <div><label>Password (at least 6 characters)</label><div class="pw-field"><input id="admin-password" type="password" placeholder="Set a password" /><button type="button" class="pw-toggle" data-target="admin-password">👁</button></div></div>
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
function adminRow(o){
  const sm = statusMeta(o.status);
  const total = (o.deliveryFee||0)+(o.otherCharges||0);
  const canRestock = (o.status==='cancelled' || o.status==='issue') && !o.restocked;
  return `<div class="admin-row">
    <div class="admin-store">${escapeHtml(o.store)}</div>
    <div class="admin-main"><div class="item">${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''} <span class="mono" style="color:var(--slate);font-size:11px;">#${escapeHtml(o.id)}</span></div>
    <div class="sub">${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}${o.altPhone?' / '+escapeHtml(o.altPhone):''} — to ${escapeHtml(o.dropoff)}${o.lastUpdatedBy?' · by '+escapeHtml(o.lastUpdatedBy):''}</div></div>
    <span class="badge ${sm.badge}">${sm.label}</span>
    <div class="admin-charges">${total ? `<b>${money(total)}</b>` : '—'}</div>
    <div>${canRestock ? `<button class="restock-btn" data-restock="${escapeHtml(o.id)}">Restock</button>` : (o.restocked ? '<span style="font-size:10px;color:var(--slate);">restocked</span>' : '')}</div>
    <button class="admin-update-btn" data-id="${escapeHtml(o.id)}">Update</button></div>`;
}
function adminInvRow(i){
  const low = i.qty<=LOW_STOCK_THRESHOLD;
  return `<div class="inv-row"><div><div class="inv-name">${escapeHtml(i.name)} <span class="mono" style="color:var(--slate);font-size:11px;">${escapeHtml(i.store_name)}</span></div>${i.dropped_off_at?`<div class="inv-date">Dropped off ${escapeHtml(i.dropped_off_at)}</div>`:''}</div>
    <span class="badge ${low?'badge-low':'badge-ok'}">${low ? (i.qty<=0?'Out of stock':'Low stock') : 'In stock'}</span><div class="inv-qty">${i.qty}</div><div></div><div></div></div>`;
}
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
function updateModal(o){
  return `<div class="modal-overlay" id="modal-overlay"><div class="modal">
    <h3>${escapeHtml(o.item)}${o.qty>1?' × '+o.qty:''}</h3><div class="id mono">#${escapeHtml(o.id)} · ${escapeHtml(o.store)}</div>
    <label>Status</label><select id="modal-status">${STATUSES.map(s=>`<option value="${s.v}" ${s.v===o.status?'selected':''}>${s.label}</option>`).join('')}</select>
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
function attachAdminHandlers(){
  attachHeaderHandlers();
  attachPasswordToggles();
  attachPasswordChangeHandlers();
  attachGreetingHandler();
  attachReportHandlers(true);

  document.querySelectorAll('.tab-btn[data-admintab]').forEach(btn=>{
    btn.onclick = async () => {
      adminTab = btn.dataset.admintab; onceCred = null; render();
      try{
        if (adminTab === 'stores'){ await loadResetRequests('store'); render(); }
        if (adminTab === 'team'){ await Promise.all([loadAdminAdmins(), loadResetRequests('admin')]); render(); }
        if (adminTab === 'withdrawals'){ await loadAdminWithdrawals(); render(); }
        if (adminTab === 'expenses'){ await loadExpenses(); render(); }
        if (adminTab === 'report'){
          await loadReportData(window._reportStoreId, window._reportSearch);
          if (!window._reportStoreId && (reportData.storeOptions||[]).length){
            window._reportStoreId = reportData.storeOptions[0].store_id;
            await loadReportData(window._reportStoreId, window._reportSearch);
          }
          render();
        }
      }catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-statfilter]').forEach(btn=>{ btn.onclick = () => { window._filterStatus = btn.dataset.statfilter; render(); }; });
  document.querySelectorAll('[data-quickdate]').forEach(btn=>{
    btn.onclick = async () => {
      window._ordersDateQuick = btn.dataset.quickdate;
      const {from, to} = quickRangeDates(btn.dataset.quickdate);
      window._ordersDateFrom = from; window._ordersDateTo = to;
      try{ await reloadAdminOrdersWithDate(); render(); }catch(e){ showToast(e.message); }
    };
  });

  const fs = document.getElementById('filter-store');
  const fst = document.getElementById('filter-status');
  const invFs = document.getElementById('inv-filter-store');
  const search = document.getElementById('search-orders');
  if (fs) fs.onchange = async e => { window._filterStore = e.target.value; try{ await reloadAdminOrdersWithDate(); render(); }catch(err){ showToast(err.message); } };
  if (fst) fst.onchange = e => { window._filterStatus = e.target.value; render(); };
  if (invFs) invFs.onchange = e => { window._invFilterStore = e.target.value; render(); };
  if (search){ search.oninput = e => { window._searchTerm = e.target.value; }; search.addEventListener('keydown', e=>{ if (e.key==='Enter'){ render(); } }); }
  const searchBtn = document.getElementById('search-btn');
  if (searchBtn) searchBtn.onclick = () => render();

  document.querySelectorAll('.admin-update-btn[data-id]').forEach(btn=>{
    btn.onclick = () => { modalOrder = adminOrders.find(o=>o.id===btn.dataset.id); render(); };
  });
  document.querySelectorAll('.restock-btn[data-restock]').forEach(btn=>{
    btn.onclick = async () => {
      try{
        await api('orders.php', {method:'PATCH', body:{id: btn.dataset.restock, action:'restock'}});
        await reloadAdminOrdersWithDate();
        await loadAdminData();
        showToast('Stock restored to inventory');
        render();
      }catch(e){ showToast(e.message); }
    };
  });

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
  const onceDismiss = document.getElementById('once-cred-dismiss');
  if (onceDismiss) onceDismiss.onclick = () => { onceCred = null; render(); };

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
  document.querySelectorAll('[data-reset-admin]').forEach(btn=>{
    btn.onclick = () => { resetPwTarget = {kind:'admin', id: parseInt(btn.dataset.resetAdmin,10), label: btn.dataset.label}; render(); };
  });
  attachResetPasswordModalHandlers(async (newPassword) => {
    if (resetPwTarget.kind === 'admin'){
      const r = await api('admins.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
      onceCred = {label:'New password set — share it with them:', storeId: resetPwTarget.label, password:r.new_password};
    } else {
      const r = await api('stores.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
      onceCred = {label:'New password set — share it with them:', storeId: resetPwTarget.label, password:r.new_password};
    }
    resetPwTarget = null;
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
  document.querySelectorAll('[data-expensequick]').forEach(btn=>{
    btn.onclick = async () => {
      window._expenseDateQuick = btn.dataset.expensequick;
      const {from, to} = quickRangeDates(btn.dataset.expensequick);
      window._expenseDateFrom = from; window._expenseDateTo = to;
      try{ await loadExpenses(); render(); }catch(e){ showToast(e.message); }
    };
  });
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
      busy = true; render();
      try{
        await api('orders.php', {method:'PATCH', body:{id: modalOrder.id, status, rider, remark, deliveryFee, otherCharges, chargeNote}});
        modalOrder = null;
        await reloadAdminOrdersWithDate();
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
          patchBellBadge(); render();
        }catch(e){ showToast(e.message); }
      };
    }
    popupOverlay.addEventListener('click', e => { if (e.target.id==='popup-overlay'){ popupOpen=false; render(); } });
  }
}

/* ---------------- PWA ---------------- */
function registerServiceWorker(){
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{ /* offline shell is a nice-to-have, ignore failures */ });
  }
}

boot();
