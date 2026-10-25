// Sign-up, login, the user's own profile, and switching phone notifications on/off.
import { Router } from 'express';
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { db, now, avatarDir, root } from '../db.js';
import {
  hashPassword, checkPassword, passwordProblem, normalizeUsername,
  createSession, destroySession, endOtherSessions, requireUser,
} from '../auth.js';
import { vapidPublicKey, saveSubscription, removeSubscription, devicesFor, sendPush } from '../push.js';
import { mvtDate, NOTIFIABLE, STATUSES } from '../tracker.js';
import { bad, limit, avatarUrl } from '../http.js';

const r = Router();
const usernameTaken = (username, exceptId = 0) =>
  !!db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, exceptId);
export function publicMe(user) {
  if (!user) return null;
  const { id, username, name, role, avatar, shared_alerts } = user;
  return { id, username, name, role, shared_alerts, avatar: avatarUrl(avatar), isAdmin: role === 'admin' };
}

r.post('/register', limit(10, 15 * 60_000), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!name) return bad(res, 'Enter your name.');
  if (!username) return bad(res, 'Username must be 3–20 letters, numbers, dots or underscores.');
  if (usernameTaken(username)) return bad(res, 'That username is taken.', 409);
  if (passwordProblem(password)) return bad(res, passwordProblem(password));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, name, password_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(username, name, hashPassword(password), now());
  const id = Number(lastInsertRowid);
  createSession(res, id);
  res.json({ ok: true });
});

// Log in with a username.
r.post('/login', limit(15, 15 * 60_000), (req, res) => {
  const login = String(req.body.login || '').trim();
  const u = db.prepare('SELECT id, password_hash, disabled FROM users WHERE username = ?').get(login);
  if (!u || !checkPassword(String(req.body.password || ''), u.password_hash)) return bad(res, 'Wrong username or password.', 401);
  if (u.disabled) return bad(res, 'This account has been disabled. Contact the admin.', 403);
  createSession(res, u.id);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

// The first image dropped into public/brand is used as the logo.
function brandLogo() {
  try {
    const f = readdirSync(join(root, 'public', 'brand')).find((n) => /\.(png|jpe?g|svg|webp)$/i.test(n));
    return f ? `/brand/${encodeURIComponent(f)}` : null;
  } catch {
    return null;
  }
}

r.get('/me', (req, res) => {
  res.json({ user: publicMe(req.user), vapidPublicKey, today: mvtDate(), statuses: STATUSES, notifiable: NOTIFIABLE, logo: brandLogo() });
});

// ---- Profile ---------------------------------------------------------------------------

r.patch('/profile', requireUser, (req, res) => {
  const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 80) : req.user.name;
  const username = req.body.username !== undefined ? normalizeUsername(req.body.username) : req.user.username;
  if (!name) return bad(res, 'Enter your name.');
  if (!username) return bad(res, 'Username must be 3–20 letters, numbers, dots or underscores.');
  if (usernameTaken(username, req.user.id)) return bad(res, 'That username is taken.', 409);
  const sharedAlerts = req.body.shared_alerts !== undefined ? (req.body.shared_alerts ? 1 : 0) : req.user.shared_alerts;
  db.prepare('UPDATE users SET name = ?, username = ?, shared_alerts = ? WHERE id = ?').run(name, username, sharedAlerts, req.user.id);
  res.json({ ok: true });
});

r.post('/profile/password', requireUser, limit(10, 15 * 60_000), (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!checkPassword(String(req.body.current || ''), u.password_hash)) return bad(res, 'Your current password is wrong.');
  const problem = passwordProblem(req.body.next);
  if (problem) return bad(res, problem);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.next)), req.user.id);
  endOtherSessions(req.user.id, req); // sign out other devices
  res.json({ ok: true });
});

// Profile picture, sent from the browser already resized (see profile.js).
const SIGNATURES = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] };

export function saveAvatar(userId, dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Upload a PNG, JPG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 600_000) throw new Error('That image is too large.');
  if (!SIGNATURES[m[1]].every((b, i) => buf[i] === b)) throw new Error("That file isn't a valid image.");
  const file = `${userId}-${randomBytes(6).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  writeFileSync(join(avatarDir, file), buf);
  removeAvatar(userId);
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(file, userId);
  return avatarUrl(file);
}

export function removeAvatar(userId) {
  const old = db.prepare('SELECT avatar FROM users WHERE id = ?').get(userId)?.avatar;
  if (old) {
    try { unlinkSync(join(avatarDir, old)); } catch { /* already gone */ }
  }
  db.prepare('UPDATE users SET avatar = NULL WHERE id = ?').run(userId);
}

r.post('/profile/avatar', requireUser, limit(20, 15 * 60_000), (req, res) => {
  try {
    res.json({ avatar: saveAvatar(req.user.id, req.body.image) });
  } catch (e) {
    bad(res, e.message);
  }
});

r.delete('/profile/avatar', requireUser, (req, res) => {
  removeAvatar(req.user.id);
  res.json({ ok: true });
});

// ---- Phone notifications -------------------------------------------------------------

// The browser hands over a push subscription once the user allows notifications.
r.post('/push/subscribe', requireUser, limit(20, 15 * 60_000), (req, res) => {
  try {
    saveSubscription(req.user.id, req.body.subscription, req.headers['user-agent']);
    res.json({ ok: true, devices: devicesFor(req.user.id) });
  } catch (e) {
    bad(res, e.message);
  }
});

r.post('/push/unsubscribe', requireUser, (req, res) => {
  removeSubscription(req.user.id, String(req.body.endpoint || ''));
  res.json({ ok: true, devices: devicesFor(req.user.id) });
});

r.get('/push/devices', requireUser, (req, res) => res.json(devicesFor(req.user.id)));

r.post('/push/test', requireUser, limit(10, 15 * 60_000), async (req, res) => {
  res.json(await sendPush(req.user.id, '✅ Notifications are working\nYou will get seaplane updates on this device.', { tag: 'test' }));
});

r.get('/outbox', requireUser, (req, res) => {
  res.json(db.prepare('SELECT body, provider, status, error, created_at FROM outbox WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id));
});

export default r;
