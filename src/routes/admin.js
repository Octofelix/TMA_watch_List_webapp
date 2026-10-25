// Admin-only: manage every user account and see all data.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin, hashPassword, passwordProblem, normalizeUsername, endOtherSessions } from '../auth.js';
import { removeAvatar, saveAvatar } from './account.js';
import { bad, avatarUrl } from '../http.js';
import { sendPush } from '../push.js';

const r = Router();
r.use('/admin', requireAdmin);

r.get('/admin/overview', (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.name, u.role, u.disabled, u.shared_alerts, u.avatar, u.created_at,
         (SELECT COUNT(*) FROM watches w WHERE w.user_id = u.id AND w.archived_at IS NULL) AS active_watches,
         (SELECT COUNT(*) FROM watches w WHERE w.user_id = u.id) AS total_watches,
         (SELECT COUNT(*) FROM chat_messages c WHERE c.user_id = u.id) AS chat_count,
         (SELECT COUNT(*) FROM push_subscriptions p WHERE p.user_id = u.id) AS devices,
         (SELECT MAX(expires_at) FROM sessions s WHERE s.user_id = u.id) AS session_expires
       FROM users u ORDER BY u.role = 'admin' DESC, u.created_at DESC`
    )
    .all()
    .map((u) => ({ ...u, avatar: avatarUrl(u.avatar) }));
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    users,
    stats: {
      users: users.length,
      activeWatches: count('SELECT COUNT(*) AS n FROM watches WHERE archived_at IS NULL'),
      sharedWatches: count('SELECT COUNT(*) AS n FROM watches WHERE archived_at IS NULL AND shared = 1'),
      totalWatches: count('SELECT COUNT(*) AS n FROM watches'),
      messages: count('SELECT COUNT(*) AS n FROM outbox'),
      devices: count('SELECT COUNT(*) AS n FROM push_subscriptions'),
      chat: count('SELECT COUNT(*) AS n FROM chat_messages'),
    },
  });
});

r.patch('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return bad(res, 'User not found.', 404);
  const self = id === req.user.id;
  const b = req.body;

  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : u.name;
  const username = b.username !== undefined ? normalizeUsername(b.username) : u.username;
  if (!name) return bad(res, 'Name cannot be empty.');
  if (!username) return bad(res, 'Username must be 3–20 letters, numbers, dots or underscores.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, id)) return bad(res, 'That username is taken.', 409);

  const role = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'user') : u.role;
  const disabled = b.disabled !== undefined ? (b.disabled ? 1 : 0) : u.disabled;
  if (self && (role !== 'admin' || disabled)) return bad(res, "You can't remove your own admin access or disable yourself.");
  const sharedAlerts = b.shared_alerts !== undefined ? (b.shared_alerts ? 1 : 0) : u.shared_alerts;

  db.prepare('UPDATE users SET name = ?, username = ?, role = ?, disabled = ?, shared_alerts = ? WHERE id = ?').run(
    name, username, role, disabled, sharedAlerts, id
  );
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // log them out
  res.json({ ok: true });
});

r.post('/admin/users/:id/password', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'User not found.', 404);
  const problem = passwordProblem(req.body.password);
  if (problem) return bad(res, problem);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.password)), id);
  if (id === req.user.id) endOtherSessions(id, req);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // they must log in with the new password
  res.json({ ok: true });
});

r.post('/admin/users/:id/avatar', (req, res) => {
  try {
    res.json({ avatar: saveAvatar(Number(req.params.id), req.body.image) });
  } catch (e) {
    bad(res, e.message);
  }
});

r.delete('/admin/users/:id/avatar', (req, res) => {
  removeAvatar(Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/admin/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return bad(res, "You can't delete your own account.");
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'User not found.', 404);
  removeAvatar(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // cascades to their sessions, watches, chat, messages
  res.json({ ok: true });
});

// Send a test notification to every device a user has switched notifications on.
r.post('/admin/users/:id/test-push', async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return bad(res, 'User not found.', 404);
  res.json(await sendPush(id, '✅ Test notification\nSent by the Seaplane Watch admin.', { tag: 'test' }));
});

// Every notification the app has sent.
r.get('/admin/outbox', (_req, res) => {
  res.json(
    db.prepare(
      `SELECT o.id, o.body, o.provider, o.status, o.error, o.created_at, u.name, u.username
       FROM outbox o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200`
    ).all()
  );
});

export default r;
