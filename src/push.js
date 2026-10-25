// Phone / browser push notifications (Web Push), sent to every device a user has switched notifications on.
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from the environment, or generated once and kept in data/vapid.json.
import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { db, now, avatarDir } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
)`);

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY.trim(), privateKey: process.env.VAPID_PRIVATE_KEY.trim() };
  }
  const file = join(dirname(avatarDir), 'vapid.json'); // data/vapid.json
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys, null, 2));
  console.warn('[push] Generated new notification keys in data/vapid.json. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY on your host to keep them stable.');
  return keys;
}

const keys = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@seaplane-watch.local', keys.publicKey, keys.privateKey);
export const vapidPublicKey = keys.publicKey;

// A short name for the device, from its browser info, e.g. "iPhone" or "Android · Chrome".
export function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br && !(os === 'iPhone' || os === 'iPad') ? `${os} · ${br}` : os;
}

export function saveSubscription(userId, sub, ua) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('That notification subscription is incomplete.');
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Invalid notification endpoint.');
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, deviceName(ua), now());
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export const devicesFor = (userId) =>
  db.prepare('SELECT id, device, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC').all(userId);

const record = db.prepare(
  'INSERT INTO outbox (user_id, phone, body, provider, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// Sends one notification to all of a user's devices. The first line of `text` becomes the title.
// opts: { url, tag } – where tapping it goes, and a tag so updates for the same flight replace each other.
export async function sendPush(userId, text, opts = {}) {
  const [title, ...rest] = String(text).split('\n');
  const payload = JSON.stringify({ title, body: rest.join('\n'), url: opts.url || '/#flights', tag: opts.tag, timestamp: now() });
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);

  let sent = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?').run(now(), s.id);
      sent++;
    } catch (e) {
      // 404/410: the phone turned notifications off or the app was removed, so forget that device.
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else errors.push(`${s.device}: ${e.statusCode || ''} ${e.body || e.message}`.trim());
    }
  }

  // Devices that were removed (app uninstalled / notifications turned off) don't count as failures.
  const status = sent ? 'sent' : errors.length ? 'failed' : 'no-device';
  const detail = sent ? `${sent} device${sent > 1 ? 's' : ''}` : errors.length ? errors.join('; ') : 'Notifications not switched on';
  record.run(userId, 'push', text, 'push', status, status === 'sent' ? detail : detail.slice(0, 300), now());
  return { status, sent, devices: subs.length, error: status === 'failed' ? errors.join('; ') : null };
}
