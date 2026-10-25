// Start-up, login screens and tab navigation.
import { $, $$, api, state, formData, avatar } from './core.js';
import { initFlights, refreshActive, refreshHistory } from './flights.js';
import { openChat, closeChat, checkUnread } from './chat.js';
import { initProfile, renderProfile } from './profile.js';
import { openAdmin } from './admin.js';
import { registerServiceWorker, renderNotifyCard, renderDevices, resyncPush } from './push.js';

const VIEWS = ['flights', 'history', 'chat', 'profile', 'admin'];
const ALL_SECTIONS = ['authView', ...VIEWS.map((v) => v + 'View')];

function showOnly(id) {
  for (const s of ALL_SECTIONS) $('#' + s).hidden = s !== id;
}

async function loadMe() {
  state.me = await api('/api/me');
  state.user = state.me.user;
}

function renderHeader() {
  const u = state.user;
  if (state.me.logo) {
    $('#brandLogo').src = state.me.logo;
    $('#brandLogo').hidden = false;
    $('#brandIcon').setAttribute('hidden', ''); // SVG elements have no .hidden property
  }
  $('#who').hidden = !u;
  $('#nav').hidden = !u;
  if (!u) return;
  $('#whoName').textContent = u.name;
  $('#whoAvatar').replaceChildren(avatar(u, 'sm'));
  $('#adminTab').hidden = !u.isAdmin;
}

// Called after the user changes their own details.
async function refreshUser() {
  await loadMe();
  renderHeader();
  renderProfile();
}

async function boot() {
  await loadMe();
  renderHeader();
  if (!state.user) return showOnly('authView');
  await initFlights();
  initProfile(refreshUser);
  route();
  checkUnread();
  resyncPush().then(renderNotifyCard);
}

// ---- Tabs ------------------------------------------------------------------------------

function currentView() {
  const v = location.hash.slice(1);
  if (v === 'admin' && !state.user?.isAdmin) return 'flights';
  return VIEWS.includes(v) ? v : 'flights';
}

async function route() {
  if (!state.user) return;
  const view = currentView();
  showOnly(view + 'View');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  if (view !== 'chat') closeChat();
  try {
    if (view === 'flights') { renderNotifyCard(); await refreshActive(); }
    if (view === 'history') await refreshHistory();
    if (view === 'chat') await openChat();
    if (view === 'profile') { renderProfile(); renderDevices(); }
    if (view === 'admin') await openAdmin(refreshUser);
  } catch (err) {
    console.error(err);
  }
}
window.addEventListener('hashchange', route);

// Keep the open tab fresh (and catch up straight away when the app comes back to the front).
function refreshOpenTab() {
  if (document.visibilityState !== 'visible' || !state.user) return;
  const view = currentView();
  if (view === 'flights') refreshActive();
  if (view === 'history') refreshHistory();
  checkUnread();
}
setInterval(refreshOpenTab, 15_000);
document.addEventListener('visibilitychange', refreshOpenTab);

// ---- Login / sign-up -------------------------------------------------------------------

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#loginForm').hidden = tab.dataset.tab !== 'login';
    $('#registerForm').hidden = tab.dataset.tab !== 'register';
    $('#authError').textContent = '';
  })
);

for (const [form, path] of [['#loginForm', '/api/login'], ['#registerForm', '/api/register']]) {
  $(form).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(path, { body: formData(e.target) });
      boot();
    } catch (err) {
      $('#authError').textContent = err.message;
    }
  });
}

registerServiceWorker();
boot();
