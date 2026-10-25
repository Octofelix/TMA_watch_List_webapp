// One group chat room for all users.
import { Router } from 'express';
import { db, now } from '../db.js';
import { requireVerified } from '../auth.js';
import { bad, limit, avatarUrl } from '../http.js';

const r = Router();

const SELECT = `SELECT m.id, m.body, m.created_at, m.user_id, u.name, u.username, u.avatar, u.role
                FROM chat_messages m JOIN users u ON u.id = m.user_id`;
const shape = (req) => (m) => ({ ...m, avatar: avatarUrl(m.avatar), mine: m.user_id === req.user.id, can_delete: m.user_id === req.user.id || req.user.isAdmin });

// ?after=<id> returns only newer messages (for polling); otherwise the latest 100.
// ?from=<id> also returns which messages from that id on still exist, so deleted ones disappear for everyone.
r.get('/chat', requireVerified, (req, res) => {
  const after = Number(req.query.after) || 0;
  const from = Number(req.query.from) || 0;
  const rows = after
    ? db.prepare(`${SELECT} WHERE m.id > ? ORDER BY m.id LIMIT 200`).all(after)
    : db.prepare(`${SELECT} ORDER BY m.id DESC LIMIT 100`).all().reverse();
  const ids = from ? db.prepare('SELECT id FROM chat_messages WHERE id >= ? AND id <= ?').all(from, after).map((x) => x.id) : null;
  res.json({ messages: rows.map(shape(req)), ids });
});

r.get('/chat/latest', requireVerified, (_req, res) => {
  res.json({ id: db.prepare('SELECT MAX(id) AS id FROM chat_messages').get().id || 0 });
});

r.post('/chat', requireVerified, limit(30, 60_000), (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) return bad(res, 'Type a message.');
  const { lastInsertRowid } = db.prepare('INSERT INTO chat_messages (user_id, body, created_at) VALUES (?, ?, ?)').run(req.user.id, body, now());
  res.json(shape(req)(db.prepare(`${SELECT} WHERE m.id = ?`).get(Number(lastInsertRowid))));
});

r.delete('/chat/:id', requireVerified, (req, res) => {
  const m = db.prepare('SELECT user_id FROM chat_messages WHERE id = ?').get(Number(req.params.id));
  if (!m) return bad(res, 'Message not found.', 404);
  if (m.user_id !== req.user.id && !req.user.isAdmin) return bad(res, "You can only delete your own messages.", 403);
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

export default r;
