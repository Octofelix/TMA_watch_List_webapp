// Small helpers shared by the route files.
import { now } from './db.js';

export const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// In-memory rate limiter: at most `max` calls per `windowMs` per route + IP (or user).
const hits = new Map();
export function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.path + '|' + (req.user?.id ?? req.ip);
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) return bad(res, 'Too many attempts. Try again in a few minutes.', 429);
    list.push(t);
    hits.set(key, list);
    next();
  };
}

export const avatarUrl = (file) => (file ? `/avatars/${file}` : null);
