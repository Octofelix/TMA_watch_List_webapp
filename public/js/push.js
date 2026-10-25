// Phone notifications: service worker, permission, push subscription, and "install app" help.
import { $, el, api, state, fmtDateTime, storageGet, storageSet } from './core.js';

const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration = null;
let installPrompt = null;

// Android/desktop Chrome offers its own install prompt; keep it for our "Install app" button.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderNotifyCard();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderNotifyCard();
});

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch (e) {
    console.warn('Service worker failed to register', e);
    return null;
  }
}

// One of: unsupported | ios-needs-install | denied | off | on
export async function pushState() {
  if (!supported()) return isIOS && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = registration || (await navigator.serviceWorker.ready);
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const sameKey = (sub) => {
  const k = sub?.options?.applicationServerKey;
  if (!k) return true; // browser doesn't say; assume fine
  const a = new Uint8Array(k), b = keyBytes(state.me.vapidPublicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

// Ask permission (must be called from a tap) and register this device with the server.
export async function enablePush() {
  if (!supported()) throw new Error("This browser can't show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied'
    ? "Notifications are blocked. Allow them for this app in your phone's settings, then try again."
    : 'Notifications were not allowed.');
  const reg = registration || (await navigator.serviceWorker.ready);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub)) { await sub.unsubscribe(); sub = null; } // server keys changed
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.me.vapidPublicKey) });
  return api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
}

export async function disablePush() {
  const reg = registration || (await navigator.serviceWorker.ready);
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}

// If notifications are already allowed, make sure the server still knows this device
// (e.g. after logging in again, or if the server's data was reset).
export async function resyncPush() {
  try {
    if (!supported() || Notification.permission !== 'granted') return;
    const reg = registration || (await navigator.serviceWorker.ready);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.me.vapidPublicKey) });
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
  } catch (e) {
    console.warn('Could not re-register for notifications', e);
  }
}

// ---- The "Get notified on this phone" card on the Flights tab ---------------------------

const DISMISS_KEY = 'notifyCardDismissed';
let cardReady = false;

export async function renderNotifyCard() {
  const card = $('#notifyCard');
  if (!card || !state.user) return;
  if (!cardReady) {
    cardReady = true;
    $('#notifyOnBtn').addEventListener('click', async () => {
      $('#notifyError').textContent = '';
      try {
        await enablePush();
        renderNotifyCard();
        renderDevices();
      } catch (err) {
        $('#notifyError').textContent = err.message;
      }
    });
    $('#installBtn').addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => {});
      installPrompt = null;
      renderNotifyCard();
    });
    $('#notifyDismiss').addEventListener('click', () => {
      storageSet(DISMISS_KEY, String(Date.now()));
      card.hidden = true;
    });
  }

  const st = await pushState();
  const dismissed = Number(storageGet(DISMISS_KEY) || 0) > Date.now() - 3 * 86400_000;
  const canInstall = !!installPrompt && !isStandalone();
  card.hidden = (st === 'on' && !canInstall) || dismissed;
  if (card.hidden) return;

  const text = {
    'ios-needs-install': 'On iPhone, notifications only work once this app is on your Home Screen:',
    unsupported: "This browser can't show notifications. On Android use Chrome; on iPhone use Safari and add the app to your Home Screen.",
    denied: "Notifications are blocked for this app. Allow them in your phone's settings (Settings → Notifications → Seaplane, or your browser's site settings), then reload.",
    off: 'Turn on notifications to hear the moment your seaplane is assigned, departs, approaches and lands.',
    on: 'Notifications are on. Install the app for one-tap access from your home screen.',
  }[st];
  $('#notifyTitle').textContent = st === 'on' ? 'Install Seaplane Watch' : 'Get notified on this phone';
  $('#notifyText').textContent = text;
  $('#iosSteps').hidden = st !== 'ios-needs-install';
  $('#notifyOnBtn').hidden = st !== 'off';
  $('#installBtn').hidden = !canInstall;
}

// ---- The Notifications card on the Profile tab ------------------------------------------

let devicesReady = false;

export async function renderDevices() {
  if (!$('#devicesCard') || !state.user) return;
  if (!devicesReady) {
    devicesReady = true;
    const flash = (msg) => { $('#pushOk').textContent = msg; setTimeout(() => ($('#pushOk').textContent = ''), 4000); };
    const run = (fn) => async () => {
      $('#pushError').textContent = '';
      try { await fn(); } catch (err) { $('#pushError').textContent = err.message; }
      renderDevices();
      renderNotifyCard();
    };
    $('#pushOnBtn').addEventListener('click', run(async () => { await enablePush(); flash('Notifications are on for this device ✓'); }));
    $('#pushOffBtn').addEventListener('click', run(async () => { await disablePush(); flash('Notifications turned off for this device.'); }));
    $('#pushTestBtn').addEventListener('click', run(async () => {
      const r = await api('/api/push/test', { body: {} });
      if (r.status === 'sent') flash(`Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}. It should pop up in a few seconds.`);
      else throw new Error(r.status === 'no-device' ? 'No devices have notifications switched on yet.' : `Couldn't send: ${r.error}`);
    }));
  }

  const st = await pushState();
  $('#pushStatus').textContent = {
    'ios-needs-install': 'On iPhone, add this app to your Home Screen first (Share → Add to Home Screen), then open it from there to turn notifications on.',
    unsupported: "This browser can't show notifications.",
    denied: "Notifications are blocked on this device. Allow them in your phone's settings, then reload.",
    off: 'Notifications are off on this device.',
    on: 'Notifications are on for this device.',
  }[st];
  $('#pushOnBtn').hidden = st !== 'off';
  $('#pushOffBtn').hidden = st !== 'on';

  const devices = await api('/api/push/devices').catch(() => []);
  $('#pushTestBtn').hidden = !devices.length;
  $('#deviceList').replaceChildren(
    ...(devices.length
      ? [el('li', { class: 'muted' }, 'Devices getting your notifications:'),
         ...devices.map((d) => el('li', {}, `📱 ${d.device}`, el('span', { class: 'muted' }, ` · since ${fmtDateTime(d.created_at)}`)))]
      : [el('li', { class: 'muted' }, 'No devices are getting your notifications yet.')])
  );
}
