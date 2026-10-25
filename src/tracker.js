// Status changes (manual or automatic) and live ADS-B tracking by tail code.
import { db, now } from './db.js';
import { sendPush } from './push.js';
import { lookupLive } from './aircraft.js';

export const STATUSES = ['scheduled', 'assigned', 'departed', 'approaching', 'landed', 'delayed', 'cancelled'];
export const NOTIFIABLE = ['assigned', 'departed', 'approaching', 'landed', 'delayed', 'cancelled'];
const ACTIVE = ['assigned', 'departed', 'approaching', 'delayed'];

const POLL_SECONDS = Number(process.env.TRACK_POLL_SECONDS || 30);
const APPROACH_KM = 15; // "approaching" when within this distance of the destination
const LANDED_KM = 5; // "landed" when on the water / slow within this distance

// Maldives Time (UTC+5) date string, YYYY-MM-DD
export const mvtDate = (t = Date.now()) => new Date(t + 5 * 3600_000).toISOString().slice(0, 10);

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const getWatch = db.prepare(
  `SELECT w.*, d.name AS dest_name, d.lat AS dest_lat, d.lon AS dest_lon, u.name AS user_name,
     (u.disabled = 0) AS owner_active
   FROM watches w JOIN destinations d ON d.id = w.destination_id JOIN users u ON u.id = w.user_id
   WHERE w.id = ?`
);

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function messageFor(w, status, detail) {
  const where = w.dest_name;
  const tail = w.tail || 'Your seaplane';
  const ref = w.label ? ` (${w.label})` : '';
  const dist = w.distance_km != null ? ` ${w.distance_km.toFixed(0)} km away` : '';
  const eta = w.eta_min != null ? `, about ${w.eta_min} min` : '';
  const extra = detail ? `\n${detail}` : '';
  switch (status) {
    case 'assigned':
      return `✈️ Seaplane assigned${ref}\nFlight to ${where} on ${fmtDate(w.flight_date)}${w.expected_time ? ` (expected ${w.expected_time})` : ''}\nAircraft: ${w.tail}${w.aircraft_type ? ` (${w.aircraft_type})` : ''}\nWe'll notify you when it departs.${extra}`;
    case 'departed':
      return `🛫 ${tail} has departed${ref}\nHeading to ${where} —${dist || ' en route'}${eta}.${extra}`;
    case 'approaching':
      return `🛬 ${tail} is approaching ${where}${ref}\n${dist.trim() || 'Nearly there'}${eta}. Get ready to meet it at the jetty.${extra}`;
    case 'landed':
      return `✅ ${tail} has landed at ${where}${ref}.${extra}`;
    case 'delayed':
      return `⏳ The seaplane to ${where}${ref} is delayed.${extra}`;
    case 'cancelled':
      return `❌ The seaplane to ${where}${ref} has been cancelled.${extra}`;
    default:
      return `Update for your seaplane to ${where}${ref}: ${status}.${extra}`;
  }
}

// Everyone else who should hear about a shared flight (only people with notifications switched on).
const sharedRecipients = db.prepare(
  `SELECT u.id FROM users u
   WHERE u.id != ? AND u.disabled = 0 AND u.shared_alerts = 1
     AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = u.id)`
);

// Changes a watch's status, records an event and sends the phone notifications.
// Landed or cancelled flights stop being watched automatically and move to History.
export async function setStatus(watchId, status, { detail = null, source = 'manual', byUser = null } = {}) {
  const w = getWatch.get(watchId);
  if (!w || w.status === status) return w;
  const finished = status === 'landed' || status === 'cancelled';
  db.prepare(
    `UPDATE watches SET status = ?, updated_at = ?,
       archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
       archived_reason = CASE WHEN ? THEN ? ELSE archived_reason END
     WHERE id = ?`
  ).run(status, now(), finished ? 1 : 0, now(), finished ? 1 : 0, status, watchId);
  db.prepare('INSERT INTO events (watch_id, status, detail, source, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    watchId, status, detail, source, byUser, now()
  );
  const fresh = getWatch.get(watchId);
  if (!fresh.notify.split(',').includes(status)) return fresh;

  const text = messageFor(fresh, status, detail);
  const opts = { tag: `watch-${fresh.id}`, url: finished ? '/#history' : '/#flights' };
  if (fresh.owner_active) await sendPush(fresh.user_id, text, opts);
  if (fresh.shared) {
    const shared = `${text}\n📢 Shared by ${fresh.user_name}`;
    for (const r of sharedRecipients.all(fresh.user_id)) await sendPush(r.id, shared, opts);
  }
  return fresh;
}

// ---- Live tracking ----------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const updatePos = db.prepare(
  `UPDATE watches SET last_lat = ?, last_lon = ?, last_alt = ?, last_gs = ?, last_seen_at = ?,
   distance_km = ?, eta_min = ?, updated_at = ? WHERE id = ?`
);

export async function trackOnce() {
  const placeholders = ACTIVE.map(() => '?').join(',');
  const watches = db
    .prepare(`SELECT id, tail, aircraft_hex FROM watches WHERE tail IS NOT NULL AND archived_at IS NULL AND flight_date = ? AND status IN (${placeholders})`)
    .all(mvtDate(), ...ACTIVE);
  const byTail = new Map();
  const hexes = new Map();
  for (const w of watches) {
    byTail.set(w.tail, [...(byTail.get(w.tail) || []), w.id]);
    if (w.aircraft_hex) hexes.set(w.tail, w.aircraft_hex);
  }

  for (const [tail, ids] of byTail) {
    const ac = await lookupLive(tail, hexes.get(tail));
    await sleep(1100); // stay within the free APIs' 1 request/second limit
    for (const id of ids) {
      const w = getWatch.get(id);
      if (!ac) {
        await inferLanding(w);
        continue;
      }
      if (ac.seen_pos != null && ac.seen_pos > 120) continue; // stale position
      const onGround = ac.alt_baro === 'ground';
      const alt = onGround ? 0 : Number(ac.alt_baro) || 0;
      const gs = Number(ac.gs) || 0;
      const airborne = !onGround && (alt > 200 || gs > 50);
      const hasDest = w.dest_lat != null && w.dest_lon != null;
      const dist = hasDest ? haversineKm(ac.lat, ac.lon, w.dest_lat, w.dest_lon) : null;
      const eta = dist != null && gs > 30 ? Math.max(1, Math.round((dist / (gs * 1.852)) * 60)) : null;
      updatePos.run(ac.lat, ac.lon, alt, gs, now(), dist, eta, now(), id);

      if (airborne && (w.status === 'assigned' || w.status === 'delayed') && (dist == null || dist > APPROACH_KM)) {
        await setStatus(id, 'departed', { source: 'auto' });
      } else if (airborne && dist != null && dist <= APPROACH_KM && ['assigned', 'delayed', 'departed'].includes(w.status)) {
        await setStatus(id, 'approaching', { source: 'auto' });
      } else if (!airborne && dist != null && dist <= LANDED_KM && ['departed', 'approaching'].includes(w.status)) {
        await setStatus(id, 'landed', { source: 'auto' });
      }
    }
  }
}

// Seaplanes often drop off ADS-B coverage just before touchdown at remote atolls.
// If the plane was on final approach (close and low) and has gone silent for 3+ minutes, call it landed.
async function inferLanding(w) {
  if (w.status !== 'approaching' || !w.last_seen_at) return;
  const silentFor = now() - w.last_seen_at;
  if (silentFor > 3 * 60_000 && w.distance_km != null && w.distance_km <= LANDED_KM && (w.last_alt ?? 9999) < 800) {
    await setStatus(w.id, 'landed', { source: 'auto', detail: 'Tracking signal ended on final approach.' });
  }
}

export function startTracker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await trackOnce();
    } catch (e) {
      console.error('[tracker]', e.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_SECONDS * 1000);
  tick();
  console.log(`[tracker] polling live aircraft data every ${POLL_SECONDS}s`);
}
