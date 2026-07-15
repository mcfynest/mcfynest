/* Manifest — production frontend. Vanilla JS, talks to /api/*.php over
 * fetch(). The render() function preserves focus/selection/typed values
 * across re-renders (see comment above it) — this was a hard requirement
 * carried over from the prototype, do not remove it. */

const STATUSES = [
  {v:'pending', label:'Pending dispatch', badge:'badge-pending'},
  {v:'transit', label:'Out for delivery', badge:'badge-transit'},
  {v:'delivered', label:'Delivered', badge:'badge-delivered'},
  {v:'issue', label:'Issue / unreachable', badge:'badge-issue'},
  {v:'cancelled', label:'Cancelled', badge:'badge-cancelled'},
];
const statusMeta = v => STATUSES.find(s=>s.v===v) || STATUSES[0];
const LOW_STOCK_THRESHOLD = 1;

let csrfToken = null;
let actor = null;
let appMeta = {app_name:'Manifest', currency:'₦'};
let booted = false;

// Store-role in-memory caches
let myProducts = [];
let myOrders = [];
let myAgents = [];

// Admin in-memory caches
let adminOrders = [];
let adminProducts = [];
let adminAccounts = [];
let unseenCount = 0;
let unseenOrders = [];

let storeTab = 'order';
let loginPickMode = null; // 'store' | 'admin' | null (role screen)
let loginError = '';
let modalOrder = null;
let popupOpen = false;
let resetPwTarget = null; // {kind:'agent'|'store', id, label}
let onceCred = null; // {label, storeId, password} shown right after creating a login
let busy = false;
let pollTimer = null;

function money(n){ n = Number(n)||0; return n ? appMeta.currency + n.toLocaleString() : ''; }
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

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
  try{
    const s = await api('session.php');
    csrfToken = s.csrf_token;
    appMeta = {app_name: s.app_name || 'Manifest', currency: s.currency || '₦'};
    actor = s.actor;
  }catch(e){ /* stay logged out */ }
  booted = true;
  if (actor && actor.type === 'store'){ await loadStoreData(); }
  else if (actor && actor.type === 'admin'){ await loadAdminData(); await checkForNewOrders(); startQuietPoll(); }
  render();
  registerServiceWorker();
}

function startQuietPoll(){
  stopQuietPoll();
  pollTimer = setInterval(async () => {
    if (!actor || actor.type !== 'admin') return;
    try{
      const r = await api('unseen.php');
      unseenCount = r.count;
      patchBellBadge();
    }catch(e){ /* silent — this is a background check, never surface errors */ }
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
    if (!count){
      count = document.createElement('span');
      count.className = 'bell-count';
      bell.appendChild(count);
    }
    count.textContent = unseenCount;
  } else if (count){
    count.remove();
  }
}

/* ---------------- DATA LOADERS ---------------- */
async function loadStoreData(){
  const [p, o] = await Promise.all([ api('products.php'), api('orders.php') ]);
  myProducts = p.products;
  myOrders = o.orders;
  if (actor.is_primary){
    try{ const t = await api('team.php'); myAgents = t.agents; }catch(e){ myAgents = []; }
  } else {
    myAgents = [];
  }
}
async function loadAdminData(){
  const [o, p, a] = await Promise.all([ api('orders.php'), api('products.php'), api('stores.php') ]);
  adminOrders = o.orders;
  adminProducts = p.products;
  adminAccounts = a.accounts;
}
async function checkForNewOrders(){
  const r = await api('unseen.php?full=1');
  unseenCount = r.count;
  unseenOrders = r.orders;
  if (unseenOrders.length > 0){ popupOpen = true; }
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
    if (loginPickMode) attachLoginHandlers(); else attachRoleHandlers();
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
    if (el && el.focus){
      el.focus();
      if (selStart!=null && el.setSelectionRange){ try{ el.setSelectionRange(selStart, selEnd); }catch(e){} }
    }
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
  if (loginPickMode === 'store') return storeLoginScreen();
  if (loginPickMode === 'admin') return adminLoginScreen();
  return `
    <div class="role-screen">
      <div class="display role-title">MANIFEST</div>
      <div class="role-tag">A shared dispatch board between you and the stores you deliver for. Stores raise orders straight from stock they've dropped off with you — you and your admins move it through to delivery.</div>
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
function storeLoginScreen(){
  return `
    <div class="role-screen">
      <div class="display role-title" style="font-size:30px;">STORE LOGIN</div>
      <div class="role-tag">Enter the Store ID and password your dispatcher gave you. Store owners and their team members each have their own ID and password.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>Store ID</label>
        <input id="store-id-input" placeholder="e.g. AMK-4821" autocomplete="username" />
        <label>Password</label>
        <div class="pw-field">
          <input id="store-pass-input" type="password" placeholder="Password" autocomplete="current-password" />
          <button type="button" class="pw-toggle" data-target="store-pass-input" aria-label="Show password">👁</button>
        </div>
        ${loginError ? `<div class="alert-banner">${escapeHtml(loginError)}</div>` : ''}
        <button class="btn" id="store-enter-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Enter portal'}</button>
        <button class="btn-outline btn" id="login-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back</button>
      </div>
    </div>`;
}
function adminLoginScreen(){
  return `
    <div class="role-screen">
      <div class="display role-title" style="font-size:30px;">DISPATCH LOGIN</div>
      <div class="role-tag">Sign in with your dispatch admin ID and password.</div>
      <div class="panel" style="max-width:380px;width:100%;">
        <label>Admin ID</label>
        <input id="admin-id-input" placeholder="e.g. ADM-1001" autocomplete="username" />
        <label>Password</label>
        <div class="pw-field">
          <input id="admin-pass-input" type="password" placeholder="Password" autocomplete="current-password" />
          <button type="button" class="pw-toggle" data-target="admin-pass-input" aria-label="Show password">👁</button>
        </div>
        ${loginError ? `<div class="alert-banner">${escapeHtml(loginError)}</div>` : ''}
        <button class="btn" id="admin-enter-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Enter dispatch board'}</button>
        <button class="btn-outline btn" id="login-back-btn" style="width:100%;margin-top:10px;background:none;color:var(--ink);">Back</button>
      </div>
    </div>`;
}
function attachLoginHandlers(){
  attachPasswordToggles();
  const back = document.getElementById('login-back-btn');
  if (back) back.onclick = () => { loginPickMode=null; loginError=''; render(); };

  const storeBtn = document.getElementById('store-enter-btn');
  if (storeBtn){
    const tryLogin = async () => {
      const id = document.getElementById('store-id-input').value.trim();
      const password = document.getElementById('store-pass-input').value;
      if (!id || !password){ showToast('Enter your Store ID and password'); return; }
      busy = true; render();
      try{
        const r = await api('login.php', {method:'POST', body:{mode:'store', id, password}});
        csrfToken = r.csrf_token; actor = r.actor; loginPickMode=null; loginError='';
        await loadStoreData();
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
      if (!id || !password){ showToast('Enter your admin ID and password'); return; }
      busy = true; render();
      try{
        const r = await api('login.php', {method:'POST', body:{mode:'admin', id, password}});
        csrfToken = r.csrf_token; actor = r.actor; loginPickMode=null; loginError='';
        await loadAdminData();
        await checkForNewOrders();
        startQuietPoll();
      }catch(e){ loginError = e.message; }
      busy = false; render();
    };
    adminBtn.onclick = tryLogin;
    document.getElementById('admin-pass-input').addEventListener('keydown', e=>{ if (e.key==='Enter') tryLogin(); });
  }
}

/* ---------------- HEADER ---------------- */
function header(){
  let label, extra = '';
  if (actor.type === 'store'){
    label = `Store: <b>${escapeHtml(actor.store_name)}</b>${!actor.is_primary?' · team member':''}`;
  } else {
    label = `<b>${escapeHtml(actor.name || 'Dispatch Admin')}</b>`;
    extra = `<button class="bell-btn" id="bell-btn">Check for new orders${unseenCount?`<span class="bell-count">${unseenCount}</span>`:''}</button>`;
  }
  return `
    <div class="topbar">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div>
          <div class="brand-name display" style="font-size:18px;">${escapeHtml(appMeta.app_name)}</div>
          <div class="brand-sub">Dispatch &amp; order management</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;">
        <div class="session-tag">${label}</div>
        ${extra}
        <button class="logout" id="logout-btn">Log out</button>
      </div>
    </div>`;
}
function attachHeaderHandlers(){
  document.getElementById('logout-btn').onclick = async () => {
    stopQuietPoll();
    try{ const r = await api('logout.php', {method:'POST'}); csrfToken = r.csrf_token; }catch(e){}
    actor = null; storeTab='order'; popupOpen=false; loginPickMode=null;
    render();
  };
  const bell = document.getElementById('bell-btn');
  if (bell){
    bell.onclick = async () => {
      try{
        await loadAdminData();
        await checkForNewOrders();
        popupOpen = true;
        render();
      }catch(e){ showToast(e.message); }
    };
  }
}

/* ---------------- STORE ---------------- */
function storeScreen(){
  const availableInv = myProducts; // already server-scoped (agents only ever receive their assigned products)
  const lowItems = myProducts.filter(i=>i.qty<=LOW_STOCK_THRESHOLD);

  const tabs = [{k:'order', label:'New order'}];
  if (actor.is_primary) tabs.push({k:'inventory', label:`Stock drop-offs (${myProducts.length})`});
  if (actor.is_primary) tabs.push({k:'team', label:`Team (${myAgents.length})`});
  tabs.push({k:'history', label:`Your orders (${myOrders.length})`});

  return `
    ${header()}
    ${lowItems.length && actor.is_primary ? `<div class="alert-banner">⚠ Low stock: ${lowItems.map(i=>escapeHtml(i.name)+' ('+i.qty+' left)').join(', ')}</div>` : ''}
    <div class="tabs">
      ${tabs.map(t=>`<button class="tab-btn ${storeTab===t.k?'active':''}" data-tab="${t.k}">${t.label}</button>`).join('')}
    </div>
    ${storeTab==='order' ? storeOrderPanel(availableInv) : ''}
    ${storeTab==='inventory' && actor.is_primary ? storeInventoryPanel(myProducts) : ''}
    ${storeTab==='team' && actor.is_primary ? storeTeamPanel(myProducts, myAgents) : ''}
    ${storeTab==='history' ? `<div class="panel"><h2><span class="dot"></span>Your orders</h2>${myOrders.length ? myOrders.slice().sort((a,b)=>b.createdAt-a.createdAt).map(stubCard).join('') : '<div class="empty">No orders yet.</div>'}</div>` : ''}
  `;
}
function storeOrderPanel(availableInv){
  return `
    <div class="panel">
      <h2><span class="dot"></span>New order — from stock dropped off with us</h2>
      ${availableInv.length===0 ? `
        <div class="empty">
          ${actor.is_primary ? "You haven't dropped off any stock with us yet, so there's nothing to order from." : "You don't have any products assigned to you yet — ask your store owner to assign some under Team."}
          ${actor.is_primary ? '<br><br><button class="btn" id="goto-inventory-btn">Log your stock drop-off</button>' : ''}
        </div>` : `
      <div class="row2">
        <div><label>Customer name</label><input id="f-customer" placeholder="e.g. Chidi Okafor" /></div>
        <div>
          <label>Product</label>
          <select id="f-product">
            ${availableInv.map(i=>`<option value="${i.id}" ${i.qty<=0?'disabled':''}>${escapeHtml(i.name)} — ${i.qty} in stock${i.qty<=0?' (out of stock)':''}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row2">
        <div><label>Delivery address</label><input id="f-dropoff" placeholder="Where it's going" /></div>
        <div><label>Phone number</label><input id="f-phone" placeholder="0803 000 0000" /></div>
      </div>
      <label>Specific instructions (optional)</label>
      <textarea id="f-notes" rows="2" placeholder="e.g. fragile, call before arriving, deliver after 4pm"></textarea>
      <button class="btn" id="submit-order-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Submit order'}</button>
      `}
    </div>`;
}
function storeInventoryPanel(myInv){
  return `
    ${onceCred ? onceCredBox() : ''}
    <div class="panel">
      <h2><span class="dot"></span>Log a stock drop-off</h2>
      <p class="hint">When you bring products to us, log them here so we hold accurate stock and can fulfil orders against it.</p>
      <div class="row3">
        <div><label>Product name</label><input id="inv-name" placeholder="e.g. Black sneakers, size 42" /></div>
        <div><label>Quantity dropped off</label><input id="inv-qty" type="number" min="0" value="1" /></div>
        <div style="display:flex;align-items:flex-end;"><button class="btn" id="inv-add-btn" style="width:100%;">Log drop-off</button></div>
      </div>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Stock we're currently holding for you</h2>
      ${myInv.length ? myInv.map(invRow).join('') : '<div class="empty">Nothing logged yet — log your first drop-off above.</div>'}
    </div>`;
}
function storeTeamPanel(myInv, myAgentsList){
  return `
    ${onceCred ? onceCredBox() : ''}
    <div class="panel">
      <h2><span class="dot"></span>Add a team member</h2>
      <p class="hint">We'll generate a unique ID for them — set a password too, and give them both. Pick which of your products they should handle; they'll only see orders and stock for those.</p>
      <label>Password (at least 6 characters)</label>
      <div class="pw-field">
        <input id="agent-password" type="password" placeholder="Set a password" />
        <button type="button" class="pw-toggle" data-target="agent-password" aria-label="Show password">👁</button>
      </div>
      <label>Products this team member handles <span style="text-transform:none;font-weight:400;">(hold Ctrl/Cmd to select more than one)</span></label>
      ${myInv.length ? `
        <select id="agent-products-select" multiple size="${Math.min(6, Math.max(3, myInv.length))}">
          ${myInv.map(i=>`<option value="${i.id}">${escapeHtml(i.name)} — ${i.qty} in stock</option>`).join('')}
        </select>
      ` : `<div class="empty" style="margin-bottom:16px;">Log some stock drop-offs first, then come back to assign products.</div>`}
      <button class="btn" id="agent-create-btn" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Generate team ID'}</button>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Team (${myAgentsList.length})</h2>
      ${myAgentsList.length ? myAgentsList.map(a=>agentRow(a)).join('') : '<div class="empty">No team members yet — add one above.</div>'}
    </div>
    ${resetPwTarget && resetPwTarget.kind==='agent' ? resetPasswordModal() : ''}`;
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
function agentRow(a){
  const names = (a.products||[]).map(p=>p.name);
  return `
    <div class="admin-row" style="grid-template-columns:1fr auto auto;">
      <div class="admin-main">
        <div class="item">Store ID: <span class="mono" style="font-size:14px;font-weight:800;">${escapeHtml(a.store_id)}</span></div>
        <div class="sub">Handles: ${names.length ? escapeHtml(names.join(', ')) : 'no products assigned'}</div>
      </div>
      <button class="admin-update-btn" data-reset-agent="${a.id}">Reset password</button>
      <button class="admin-update-btn" data-remove-agent="${a.id}">Remove</button>
    </div>`;
}
function invRow(i){
  const low = i.qty<=LOW_STOCK_THRESHOLD;
  return `
    <div class="inv-row">
      <div class="inv-name">${escapeHtml(i.name)}</div>
      <span class="badge ${low?'badge-low':'badge-ok'}">${low ? (i.qty<=0?'Out of stock':'Low stock') : 'In stock'}</span>
      <div class="inv-qty">${i.qty}</div>
      <div class="inv-actions">
        <button class="qty-btn" data-inv="${i.id}" data-delta="-1">−</button>
        <button class="qty-btn" data-inv="${i.id}" data-delta="1">+</button>
      </div>
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
function attachStoreHandlers(){
  attachHeaderHandlers();
  attachPasswordToggles();
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn=>{
    btn.onclick = () => { storeTab = btn.dataset.tab; onceCred=null; render(); };
  });
  const gotoInvBtn = document.getElementById('goto-inventory-btn');
  if (gotoInvBtn) gotoInvBtn.onclick = () => { storeTab='inventory'; render(); };

  const submitBtn = document.getElementById('submit-order-btn');
  if (submitBtn){
    submitBtn.onclick = async () => {
      const productId = parseInt(document.getElementById('f-product').value, 10);
      const customer = document.getElementById('f-customer').value.trim();
      const phone = document.getElementById('f-phone').value.trim();
      const dropoff = document.getElementById('f-dropoff').value.trim();
      const notes = document.getElementById('f-notes').value.trim();
      if (!productId || !customer || !phone || !dropoff){ showToast('Fill in name, product, address and phone number'); return; }
      busy = true; render();
      try{
        await api('orders.php', {method:'POST', body:{product_id:productId, customer, phone, dropoff, notes}});
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
      if (!name || isNaN(qty) || qty<0){ showToast('Enter a product name and valid quantity'); return; }
      try{
        await api('products.php', {method:'POST', body:{name, qty}});
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
      const sel = document.getElementById('agent-products-select');
      const productIds = sel ? Array.from(sel.selectedOptions).map(o=>parseInt(o.value,10)) : [];
      if (!password || password.length < 6){ showToast('Set a password of at least 6 characters'); return; }
      busy = true; render();
      try{
        const r = await api('team.php', {method:'POST', body:{password, product_ids:productIds}});
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
function stubCard(o){
  const sm = statusMeta(o.status);
  const hasCharges = (o.deliveryFee||0) > 0 || (o.otherCharges||0) > 0;
  return `
    <div class="stub">
      <div class="stub-top">
        <div>
          <div class="stub-id mono">#${escapeHtml(o.id)}</div>
          <div class="stub-item">${escapeHtml(o.item)}</div>
        </div>
        <span class="badge ${sm.badge}">${sm.label}</span>
      </div>
      <div class="stub-grid">
        <div><span class="k">Customer:</span> ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}</div>
        <div><span class="k">Deliver to:</span> ${escapeHtml(o.dropoff)}</div>
      </div>
      ${o.notes ? `<div class="stub-remark"><span class="k">Instructions:</span> ${escapeHtml(o.notes)}</div>` : ''}
      ${o.remark ? `<div class="stub-remark"><span class="k">Dispatch note:</span> ${escapeHtml(o.remark)}</div>` : ''}
      ${hasCharges ? `<div class="stub-charges">
          ${o.deliveryFee ? `<span>Delivery fee: <b>${money(o.deliveryFee)}</b></span>` : ''}
          ${o.otherCharges ? `<span>Other charges: <b>${money(o.otherCharges)}</b>${o.chargeNote?' — '+escapeHtml(o.chargeNote):''}</span>` : ''}
        </div>` : ''}
      <div class="stub-meta">Submitted ${new Date(o.createdAt).toLocaleString()}${o.rider ? ' · Rider: '+escapeHtml(o.rider) : ''}</div>
    </div>`;
}

/* ---------------- ADMIN ---------------- */
function adminScreen(){
  const storeNames = [...new Set(adminOrders.map(o=>o.store).concat(adminProducts.map(i=>i.store_name)))].sort();
  const filterStore = window._filterStore || 'all';
  const filterStatus = window._filterStatus || 'all';
  const searchTerm = (window._searchTerm || '').toLowerCase();
  let list = adminOrders.slice().sort((a,b)=>b.createdAt-a.createdAt);
  if (filterStore!=='all') list = list.filter(o=>o.store===filterStore);
  if (filterStatus!=='all') list = list.filter(o=>o.status===filterStatus);
  if (searchTerm) list = list.filter(o=>
    o.customer.toLowerCase().includes(searchTerm) ||
    o.phone.toLowerCase().includes(searchTerm) ||
    o.id.toLowerCase().includes(searchTerm)
  );

  const counts = {}; STATUSES.forEach(s=>counts[s.v]=0);
  adminOrders.forEach(o=>counts[o.status]=(counts[o.status]||0)+1);
  const totalFees = adminOrders.reduce((sum,o)=>sum+(o.deliveryFee||0)+(o.otherCharges||0),0);

  const lowStockAll = adminProducts.filter(i=>i.qty<=LOW_STOCK_THRESHOLD);
  const invFilterStore = window._invFilterStore || 'all';
  let invList = adminProducts.slice().sort((a,b)=> (a.store_name+a.name).localeCompare(b.store_name+b.name));
  if (invFilterStore!=='all') invList = invList.filter(i=>i.store_name===invFilterStore);

  return `
    ${header()}
    ${lowStockAll.length ? `<div class="alert-banner">⚠ ${lowStockAll.length} product${lowStockAll.length>1?'s':''} low or out of stock: ${lowStockAll.map(i=>escapeHtml(i.store_name)+' — '+escapeHtml(i.name)+' ('+i.qty+')').join(', ')}</div>` : ''}
    <div class="stat-row">
      <div class="stat"><div class="n">${adminOrders.length}</div><div class="l">Total orders</div></div>
      ${STATUSES.map(s=>`<div class="stat"><div class="n">${counts[s.v]}</div><div class="l">${s.label}</div></div>`).join('')}
      <div class="stat"><div class="n">${money(totalFees)||(appMeta.currency+'0')}</div><div class="l">Fees &amp; charges</div></div>
    </div>

    <div class="panel">
      <h2><span class="dot"></span>All orders (${list.length})</h2>
      <div class="filters">
        <input id="search-orders" placeholder="Search customer, phone, or order #" value="${escapeHtml(window._searchTerm||'')}" />
        <button class="btn-outline btn" id="search-btn" style="padding:10px 16px;">Search</button>
        <select id="filter-store">
          <option value="all">All stores</option>
          ${storeNames.map(s=>`<option value="${escapeHtml(s)}" ${s===filterStore?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
        <select id="filter-status">
          <option value="all">All statuses</option>
          ${STATUSES.map(s=>`<option value="${s.v}" ${s.v===filterStatus?'selected':''}>${s.label}</option>`).join('')}
        </select>
      </div>
      ${list.length ? list.map(adminRow).join('') : '<div class="empty">No orders match this filter.</div>'}
    </div>

    <div class="panel">
      <h2><span class="dot"></span>Inventory across stores (${invList.length})</h2>
      <div class="filters">
        <select id="inv-filter-store">
          <option value="all">All stores</option>
          ${storeNames.map(s=>`<option value="${escapeHtml(s)}" ${s===invFilterStore?'selected':''}>${escapeHtml(s)}</option>`).join('')}
        </select>
      </div>
      ${invList.length ? invList.map(adminInvRow).join('') : '<div class="empty">No inventory logged by any store yet.</div>'}
    </div>

    ${onceCred ? onceCredBox() : ''}
    <div class="panel">
      <h2><span class="dot"></span>Create a store</h2>
      <p class="hint">We'll generate a unique Store ID — set a password too, and give the store both.</p>
      <div class="row3">
        <div><label>Store name</label><input id="acc-storename" placeholder="e.g. Amaka's Boutique" /></div>
        <div>
          <label>Password (at least 6 characters)</label>
          <div class="pw-field">
            <input id="acc-password" type="password" placeholder="Set a password" />
            <button type="button" class="pw-toggle" data-target="acc-password" aria-label="Show password">👁</button>
          </div>
        </div>
        <div style="display:flex;align-items:flex-start;padding-top:24px;"><button class="btn" id="acc-create-btn" style="width:100%;" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Generate Store ID'}</button></div>
      </div>
    </div>
    <div class="panel">
      <h2><span class="dot"></span>Store &amp; team logins (${adminAccounts.length})</h2>
      ${adminAccounts.length ? adminAccounts.map(accountRow).join('') : '<div class="empty">No logins created yet — add one above.</div>'}
    </div>

    ${modalOrder ? updateModal(modalOrder) : ''}
    ${popupOpen ? newOrdersPopup(unseenOrders) : ''}
    ${resetPwTarget && resetPwTarget.kind==='store' ? resetPasswordModal() : ''}
  `;
}
function adminRow(o){
  const sm = statusMeta(o.status);
  const total = (o.deliveryFee||0)+(o.otherCharges||0);
  return `
    <div class="admin-row">
      <div class="admin-store">${escapeHtml(o.store)}</div>
      <div class="admin-main">
        <div class="item">${escapeHtml(o.item)} <span class="mono" style="color:var(--slate);font-size:11px;">#${escapeHtml(o.id)}</span></div>
        <div class="sub">${escapeHtml(o.customer)} · ${escapeHtml(o.phone)} — to ${escapeHtml(o.dropoff)}</div>
      </div>
      <span class="badge ${sm.badge}">${sm.label}</span>
      <div class="admin-charges">${total ? `<b>${money(total)}</b>` : '—'}</div>
      <div class="sub" style="max-width:160px;">${o.notes ? escapeHtml(o.notes) : ''}</div>
      <button class="admin-update-btn" data-id="${escapeHtml(o.id)}">Update</button>
    </div>`;
}
function adminInvRow(i){
  const low = i.qty<=LOW_STOCK_THRESHOLD;
  return `
    <div class="inv-row">
      <div class="inv-name">${escapeHtml(i.name)} <span class="mono" style="color:var(--slate);font-size:11px;">${escapeHtml(i.store_name)}</span></div>
      <span class="badge ${low?'badge-low':'badge-ok'}">${low ? (i.qty<=0?'Out of stock':'Low stock') : 'In stock'}</span>
      <div class="inv-qty">${i.qty}</div>
      <div></div>
    </div>`;
}
function accountRow(a){
  const isAgent = a.role === 'agent';
  const roleTag = isAgent ? `<span class="badge badge-role">team · ${escapeHtml(a.owner_name||a.store_name)}</span>` : `<span class="badge badge-ok">store</span>`;
  const displayName = isAgent ? (a.owner_name||a.store_name) + ' — team member' : a.store_name;
  return `
    <div class="admin-row" style="grid-template-columns:1fr auto auto auto;">
      <div class="admin-main"><div class="item">${escapeHtml(displayName)}</div><div class="sub">Store ID: <span class="mono" style="font-size:14px;font-weight:800;color:var(--ink);">${escapeHtml(a.store_id)}</span></div></div>
      ${roleTag}
      <button class="admin-update-btn" data-reset-store="${a.id}" data-label="${escapeHtml(displayName)} (${escapeHtml(a.store_id)})">Reset password</button>
      <button class="admin-update-btn" data-remove-store="${a.id}">Remove</button>
    </div>`;
}
function updateModal(o){
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal">
        <h3>${escapeHtml(o.item)}</h3>
        <div class="id mono">#${escapeHtml(o.id)} · ${escapeHtml(o.store)}</div>
        <label>Status</label>
        <select id="modal-status">
          ${STATUSES.map(s=>`<option value="${s.v}" ${s.v===o.status?'selected':''}>${s.label}</option>`).join('')}
        </select>
        <label>Rider / driver (optional)</label>
        <input id="modal-rider" value="${escapeHtml(o.rider||'')}" placeholder="e.g. Tunde" />
        <div class="row2">
          <div><label>Delivery fee</label><input id="modal-delivery-fee" type="number" min="0" value="${o.deliveryFee||0}" /></div>
          <div><label>Other charges</label><input id="modal-other-charges" type="number" min="0" value="${o.otherCharges||0}" /></div>
        </div>
        <label>Charge note (e.g. failed delivery fee, re-delivery fee)</label>
        <input id="modal-charge-note" value="${escapeHtml(o.chargeNote||'')}" placeholder="e.g. Failed delivery — customer unreachable" />
        <label>Dispatch note</label>
        <textarea id="modal-remark" rows="3" placeholder="e.g. Customer not picking calls, rescheduled for tomorrow">${escapeHtml(o.remark||'')}</textarea>
        <div class="modal-actions">
          <button class="btn btn-outline" id="modal-cancel">Cancel</button>
          <button class="btn" id="modal-save" ${busy?'disabled':''}>${busy?'<span class="spinner-inline"></span>':'Save update'}</button>
        </div>
      </div>
    </div>`;
}
function newOrdersPopup(list){
  return `
    <div class="modal-overlay" id="popup-overlay">
      <div class="modal">
        <h3>${list.length ? 'New orders waiting' : "You're all caught up"}</h3>
        <div class="id">${list.length ? list.length + ' order' + (list.length>1?'s':'') + ' need attention across your stores' : 'No unseen orders right now'}</div>
        ${list.length ? list.slice(0,12).map(o=>`
          <div class="new-order-item">
            <span class="store-tag">${escapeHtml(o.store)}</span>${escapeHtml(o.item)} — ${escapeHtml(o.customer)} · ${escapeHtml(o.phone)}
          </div>`).join('') : ''}
        ${list.length>12 ? `<div class="sub" style="margin-bottom:10px;">+ ${list.length-12} more…</div>` : ''}
        <div class="modal-actions">
          <button class="btn btn-outline" id="popup-close">Close</button>
          ${list.length ? '<button class="btn" id="popup-mark-seen">Mark all as seen</button>' : ''}
        </div>
      </div>
    </div>`;
}
function attachAdminHandlers(){
  attachHeaderHandlers();
  attachPasswordToggles();
  const fs = document.getElementById('filter-store');
  const fst = document.getElementById('filter-status');
  const invFs = document.getElementById('inv-filter-store');
  const search = document.getElementById('search-orders');
  if (fs) fs.onchange = e => { window._filterStore = e.target.value; render(); };
  if (fst) fst.onchange = e => { window._filterStatus = e.target.value; render(); };
  if (invFs) invFs.onchange = e => { window._invFilterStore = e.target.value; render(); };
  if (search){
    search.oninput = e => { window._searchTerm = e.target.value; };
    search.addEventListener('keydown', e=>{ if (e.key==='Enter'){ render(); } });
  }
  const searchBtn = document.getElementById('search-btn');
  if (searchBtn) searchBtn.onclick = () => render();

  document.querySelectorAll('.admin-update-btn[data-id]').forEach(btn=>{
    btn.onclick = () => { modalOrder = adminOrders.find(o=>o.id===btn.dataset.id); render(); };
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
      if (!confirm('Remove this login? They will no longer be able to log in. Their order history stays intact.')) return;
      try{
        await api('stores.php', {method:'DELETE', body:{id:parseInt(btn.dataset.removeStore,10)}});
        await loadAdminData();
        showToast('Login removed');
        render();
      }catch(e){ showToast(e.message); }
    };
  });
  document.querySelectorAll('[data-reset-store]').forEach(btn=>{
    btn.onclick = () => {
      resetPwTarget = {kind:'store', id: parseInt(btn.dataset.resetStore,10), label: btn.dataset.label};
      render();
    };
  });
  attachResetPasswordModalHandlers(async (newPassword) => {
    const r = await api('stores.php', {method:'PATCH', body:{id: resetPwTarget.id, new_password: newPassword}});
    onceCred = {label:'New password set — share it with them:', storeId: resetPwTarget.label, password:r.new_password};
    resetPwTarget = null;
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
        await loadAdminData();
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
          unseenCount = 0; unseenOrders = [];
          popupOpen = false;
          patchBellBadge();
          render();
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
