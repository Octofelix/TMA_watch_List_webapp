import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'sw_session';

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const passwordProblem = (pw) => (String(pw || '').length < 8 ? 'Password must be at least 8 characters.' : null);

// 3–20 characters: letters, numbers, dot, underscore. Stored as typed, compared case-insensitively.
export function normalizeUsername(input) {
  const u = String(input || '').trim();
  return /^[A-Za-z0-9._]{3,20}$/.test(u) ? u : null;
}

export function createSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  const expires = now() + SESSION_DAYS * 86400_000;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 86400_000,
  });
}

export function destroySession(req, res) {
  const token = readCookie(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE);
}

// Log a user out everywhere except (optionally) the current browser.
export function endOtherSessions(userId, req) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, (req && readCookie(req)) || '');
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return match ? decodeURIComponent(match.slice(COOKIE.length + 1)) : null;
}

const findSession = db.prepare(
  `SELECT u.id, u.username, u.name, u.role, u.avatar, u.shared_alerts
   FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token = ? AND s.expires_at > ? AND u.disabled = 0`
);

// Attaches req.user if logged in.
export function loadUser(req, _res, next) {
  const token = readCookie(req);
  req.user = token ? findSession.get(token, now()) ?? null : null;
  if (req.user) req.user.isAdmin = req.user.role === 'admin';
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

// Kept as a separate name for the routes that use it; phone verification no longer exists,
// so any logged-in user passes.
export const requireVerified = requireUser;

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admins only.' });
  next();
}

// Creates the admin account on first start, using ADMIN_USERNAME / ADMIN_PASSWORD from .env.
// Never overwrites an existing account, so a password changed in the app stays changed.
export function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
  if (existing) {
    if (existing.role !== 'admin') db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    return;
  }
  if (!password) {
    console.warn('[admin] ADMIN_PASSWORD is not set in .env, so no admin account was created.');
    return;
  }
  db.prepare(
    "INSERT INTO users (username, name, phone, password_hash, role, verified, created_at) VALUES (?, 'Administrator', NULL, ?, 'admin', 1, ?)"
  ).run(username, hashPassword(password), now());
  console.log(`[admin] Created admin account "${username}".`);
}
