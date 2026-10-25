// Destinations and flight watches (active + history), including sharing with all users.
import { Router } from 'express';
import { db, now } from '../db.js';
import { requireUser, requireVerified } from '../auth.js';
import { setStatus, NOTIFIABLE } from '../tracker.js';
import { bad, limit, avatarUrl } from '../http.js';
import { checkTail } from '../aircraft.js';

const r = Router();

// ---- Destinations ----------------------------------------------------------------------

r.get('/destinations', (_req, res) => {
  res.json(db.prepare("SELECT id, name, island, atoll, type, lat, lon FROM destinations ORDER BY type = 'base' DESC, atoll, name").all());
});

r.post('/destinations', requireVerified, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (!name) return bad(res, 'Enter the island or place name.');
  if (!(lat > -1.5 && lat < 7.5 && lon > 72 && lon < 74.5)) return bad(res, 'Pick a location inside the Maldives.');
  const existing = db.prepare('SELECT id FROM destinations WHERE name = ?').get(name);
  if (existing) return res.json({ id: existing.id });
  const { lastInsertRowid } = db
    .prepare('INSERT INTO destinations (name, island, atoll, type, lat, lon, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, name, String(req.body.atoll || '').slice(0, 40) || null, 'island', lat, lon, req.user.id);
  res.json({ id: Number(lastInsertRowid) });
});

// Island search via OpenStreetMap, limited to the Maldives (max 1 lookup per second overall).
let lastSearch = 0;
r.get('/places/search', requireUser, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 3) return res.json([]);
  if (now() - lastSearch < 1100) return bad(res, 'Searching too fast — wait a second.', 429);
  lastSearch = now();
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=mv&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': 'seaplane-watch/0.2' }, signal: AbortSignal.timeout(8000) }
    );
    const hits = resp.ok ? await resp.json() : [];
    const seen = new Set();
    res.json(
      hits
        .filter((h) => {
          const key = (+h.lat).toFixed(3) + ',' + (+h.lon).toFixed(3);
          return !seen.has(key) && seen.add(key);
        })
        .map((h) => ({ name: h.name || h.display_name.split(',')[0], label: h.display_name, lat: +h.lat, lon: +h.lon }))
    );
  } catch {
    bad(res, 'Place search is unavailable right now. Click the map instead.', 502);
  }
});

// ---- Watches ---------------------------------------------------------------------------

// Owner or admin can change a watch; anyone can see a shared one.
function loadWatch(req, { edit = true } = {}) {
  const w = db.prepare('SELECT * FROM watches WHERE id = ?').get(Number(req.params.id));
  if (!w) return null;
  const isOwner = w.user_id === req.user.id;
  if (edit ? isOwner || req.user.isAdmin : isOwner || w.shared || req.user.isAdmin) return w;
  return null;
}

function cleanNotify(list) {
  const arr = (Array.isArray(list) ? list : []).filter((s) => NOTIFIABLE.includes(s));
  return arr.length ? arr.join(',') : null;
}

// Tail codes are stored in the standard "8Q-TMB" form. Accepted inputs include
// "8Q-TMB", "8QTMB" (as Flightradar24 shows it), "8q tmb", "8Q_TMB", "8Q.TMB" and just "TMB".
// Registrations from other countries are kept as typed (uppercased, spaces removed).
export function normalizeTail(input) {
  let t = String(input || '').toUpperCase().trim().replace(/[\s_.–—]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (/^[A-Z]{3}$/.test(t)) t = '8Q' + t; // just the TMA letters
  const mv = /^8Q-?([A-Z0-9]{2,5})$/.exec(t); // Maldives prefix, with or without hyphen
  if (mv) return `8Q-${mv[1]}`;
  return /^[A-Z0-9]{1,3}-?[A-Z0-9]{2,5}$/.test(t) ? t : null;
}

const eventsFor = db.prepare(
  `SELECT e.status, e.detail, e.source, e.created_at, u.name AS by_name
   FROM events e LEFT JOIN users u ON u.id = e.by_user WHERE e.watch_id = ? ORDER BY e.id DESC`
);

// scope=active (default) or history. Shows your own flights, flights others share, and for admins everything.
r.get('/watches', requireUser, (req, res) => {
  const history = req.query.scope === 'history';
  const rows = db
    .prepare(
      `SELECT w.*, d.name AS dest_name, d.atoll AS dest_atoll, d.lat AS dest_lat, d.lon AS dest_lon,
              u.name AS owner_name, u.username AS owner_username, u.avatar AS owner_avatar
       FROM watches w JOIN destinations d ON d.id = w.destination_id JOIN users u ON u.id = w.user_id
       WHERE (w.user_id = ? OR w.shared = 1 OR ?) AND w.archived_at IS ${history ? 'NOT NULL' : 'NULL'}
       ORDER BY ${history ? 'w.archived_at DESC' : 'w.flight_date, w.expected_time, w.id'}
       LIMIT 300`
    )
    .all(req.user.id, req.user.isAdmin ? 1 : 0);
  res.json(
    rows.map((w) => ({
      ...w,
      owner_avatar: avatarUrl(w.owner_avatar),
      is_owner: w.user_id === req.user.id,
      can_edit: w.user_id === req.user.id || req.user.isAdmin,
      events: eventsFor.all(w.id),
    }))
  );
});

r.post('/watches', requireVerified, (req, res) => {
  const destId = Number(req.body.destination_id);
  const date = String(req.body.flight_date || '');
  const time = String(req.body.expected_time || '');
  if (!db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(destId)) return bad(res, 'Choose a destination.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 'Choose the flight date.');
  if (time && !/^\d{2}:\d{2}$/.test(time)) return bad(res, 'Time must look like 14:30.');
  const notify = cleanNotify(req.body.notify) || NOTIFIABLE.join(',');
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO watches (user_id, destination_id, flight_date, expected_time, label, notify, shared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, destId, date, time || null, String(req.body.label || '').trim().slice(0, 60) || null, notify,
      req.body.shared ? 1 : 0, now(), now());
  res.json({ id: Number(lastInsertRowid) });
});

// Step 1: check a tail code against the aircraft registry and live tracking (nothing is saved).
r.get('/aircraft/check', requireVerified, limit(30, 60_000), async (req, res) => {
  const tail = normalizeTail(req.query.tail);
  if (!tail) return bad(res, 'Enter a tail code like 8Q-TMB or 8QTMB.');
  res.json(await checkTail(tail));
});

// Step 2: save the checked tail code -> status "assigned" and a notification.
// The check runs again here, so an unverified code can never be saved.
r.patch('/watches/:id/tail', requireVerified, limit(30, 60_000), async (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  if (w.archived_at) return bad(res, 'This flight is no longer being watched.');
  const tail = normalizeTail(req.body.tail);
  if (!tail) return bad(res, 'Enter a tail code like 8Q-TMB or 8QTMB.');
  const check = await checkTail(tail);
  if (!check.ok) return bad(res, check.problem);
  db.prepare(
    `UPDATE watches SET tail = ?, aircraft_hex = ?, aircraft_type = ?, last_lat = NULL, last_lon = NULL, last_seen_at = NULL,
       distance_km = NULL, eta_min = NULL, updated_at = ? WHERE id = ?`
  ).run(tail, check.aircraft.mode_s || null, check.aircraft.type || null, now(), w.id);
  const swapped = w.tail && w.tail !== tail;
  // First tail code, or the aircraft was swapped before departure: announce "assigned".
  if (w.status === 'scheduled' || (swapped && ['assigned', 'delayed'].includes(w.status))) {
    if (w.status !== 'scheduled') db.prepare("UPDATE watches SET status = 'scheduled' WHERE id = ?").run(w.id);
    await setStatus(w.id, 'assigned', { source: 'manual', byUser: req.user.id, detail: swapped ? `Aircraft changed from ${w.tail}.` : null });
  }
  res.json({ ok: true, tail });
});

r.post('/watches/:id/status', requireVerified, async (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  if (w.archived_at) return bad(res, 'This flight is no longer being watched.');
  const status = String(req.body.status || '');
  if (!NOTIFIABLE.includes(status) || status === 'assigned') return bad(res, 'Unknown status.');
  await setStatus(w.id, status, { source: 'manual', byUser: req.user.id, detail: String(req.body.detail || '').trim().slice(0, 200) || null });
  res.json({ ok: true });
});

r.patch('/watches/:id/notify', requireVerified, (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  db.prepare('UPDATE watches SET notify = ?, updated_at = ? WHERE id = ?').run(cleanNotify(req.body.notify) || '', now(), w.id);
  res.json({ ok: true });
});

r.patch('/watches/:id/shared', requireVerified, (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  db.prepare('UPDATE watches SET shared = ?, updated_at = ? WHERE id = ?').run(req.body.shared ? 1 : 0, now(), w.id);
  res.json({ ok: true });
});

// Stop watching: moves the flight to History. No more tracking or alerts.
r.post('/watches/:id/stop', requireUser, (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  if (!w.archived_at) {
    db.prepare("UPDATE watches SET archived_at = ?, archived_reason = 'stopped', updated_at = ? WHERE id = ?").run(now(), now(), w.id);
    db.prepare("INSERT INTO events (watch_id, status, detail, source, by_user, created_at) VALUES (?, 'stopped', NULL, 'manual', ?, ?)").run(w.id, req.user.id, now());
  }
  res.json({ ok: true });
});

// Put a stopped flight back on the active list.
r.post('/watches/:id/resume', requireUser, (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  if (w.archived_reason !== 'stopped') return bad(res, 'Only flights you stopped can be resumed.');
  db.prepare('UPDATE watches SET archived_at = NULL, archived_reason = NULL, updated_at = ? WHERE id = ?').run(now(), w.id);
  res.json({ ok: true });
});

// Delete permanently (from History).
r.delete('/watches/:id', requireUser, (req, res) => {
  const w = loadWatch(req);
  if (!w) return bad(res, 'Flight not found.', 404);
  db.prepare('DELETE FROM watches WHERE id = ?').run(w.id);
  res.json({ ok: true });
});

export default r;
