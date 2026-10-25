// Shared state and helpers for every tab.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const state = { me: null, user: null };

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.user) location.reload(); // session ended
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return e;
}

const TZ = 'Indian/Maldives';
export const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const fmtDateTime = (t) =>
  new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
export const fmtDay = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export function fmtChatTime(t) {
  const d = new Date(t);
  const today = new Date().toLocaleDateString('en-GB', { timeZone: TZ });
  return d.toLocaleDateString('en-GB', { timeZone: TZ }) === today ? fmtTime(t) : fmtDateTime(t);
}

// Round picture, or initials on a colour picked from the user's id.
const AVATAR_COLORS = ['#0b6e8a', '#1592a5', '#2a7f62', '#8a5a0b', '#7a3e8f', '#a03a4a', '#3d5a99', '#5b7a1e'];
export function avatar(user, size = '') {
  const box = el('span', { class: `avatar ${size}`.trim(), title: user?.name || '' });
  if (user?.avatar) {
    box.append(el('img', { src: user.avatar, alt: '' }));
  } else {
    const initials = (user?.name || user?.username || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    box.textContent = initials;
    box.style.background = AVATAR_COLORS[(user?.id ?? user?.user_id ?? 0) % AVATAR_COLORS.length];
  }
  return box;
}

// Crops and shrinks a chosen photo to a 256px square before upload.
export async function resizeImage(file, size = 256) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > 15_000_000) throw new Error('That image is over 15 MB.');
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function storageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

// Message log (notification outbox) renderer, used on Flights, Verify and Admin.
export function renderMessages(container, msgs, { showWho = false } = {}) {
  container.replaceChildren(
    ...(msgs.length
      ? msgs.map((m) =>
          el('div', { class: 'msg' },
            el('pre', {}, m.body),
            el('div', { class: 'meta' },
              `${fmtDateTime(m.created_at)} · `,
              showWho ? `to ${m.name || 'deleted user'} · ` : '',
              m.status === 'sent' ? `delivered to ${m.error || 'phone'}`
                : m.status === 'no-device' ? 'not delivered: notifications not switched on'
                : m.provider !== 'push' ? `sent by ${m.provider} (old)` : '',
              m.status === 'failed' ? el('span', { class: 'failed' }, `failed: ${m.error}`) : null
            )
          )
        )
      : [el('p', { class: 'muted' }, 'No notifications yet.')])
  );
}
