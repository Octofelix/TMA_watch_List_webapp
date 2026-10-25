// Checks that a tail code is a real Trans Maldivian Airways aircraft, and finds it on live tracking.
//   Registry: adsbdb.com (type, owner, transponder ID), with hexdb.io as a backup existence check.
//   Live:     adsb.fi and adsb.lol, by transponder ID first, then by registration.
import { db, now } from './db.js';

const UA = { 'User-Agent': 'seaplane-watch/0.3' };
const REGISTRY_CACHE_MS = 7 * 86400_000; // aircraft details rarely change
const MISS_CACHE_MS = 6 * 3600_000; // re-check unknown codes after a few hours

db.exec(`CREATE TABLE IF NOT EXISTS aircraft (
  registration TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  mode_s TEXT, type TEXT, manufacturer TEXT, owner TEXT, operator_code TEXT, photo TEXT,
  checked_at INTEGER NOT NULL
)`);

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return { response: 'unknown aircraft' };
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

export const isTMA = (a) => a?.operator_code === 'TMW' || /trans\s*maldivian/i.test(a?.owner || '');

// Returns { found, registration, mode_s, type, manufacturer, owner, operator_code, photo }.
// Throws if no registry could be reached, so callers can say "try again" instead of "not found".
export async function lookupRegistry(tail) {
  const cached = db.prepare('SELECT * FROM aircraft WHERE registration = ?').get(tail);
  if (cached && now() - cached.checked_at < (cached.found ? REGISTRY_CACHE_MS : MISS_CACHE_MS)) {
    return { ...cached, found: !!cached.found };
  }

  let result = null;
  try {
    const data = await getJson(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(tail)}`);
    const a = data?.response?.aircraft;
    result = a
      ? {
          found: true, registration: a.registration || tail, mode_s: a.mode_s?.toLowerCase() || null,
          type: a.type || null, manufacturer: a.manufacturer || null, owner: a.registered_owner || null,
          operator_code: a.registered_owner_operator_flag_code || null, photo: a.url_photo_thumbnail || a.url_photo || null,
        }
      : { found: false, registration: tail };
  } catch {
    // Backup: hexdb only tells us whether the registration exists (and its transponder ID).
    const res = await fetch(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(tail)}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error('The aircraft registry is not reachable right now.');
    const hex = (await res.text()).trim();
    result = /^[0-9a-f]{6}$/i.test(hex)
      ? { found: true, registration: tail, mode_s: hex.toLowerCase(), type: null, manufacturer: null, owner: null, operator_code: null, photo: null }
      : { found: false, registration: tail };
  }

  db.prepare(
    `INSERT INTO aircraft (registration, found, mode_s, type, manufacturer, owner, operator_code, photo, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(registration) DO UPDATE SET found = excluded.found, mode_s = excluded.mode_s, type = excluded.type,
       manufacturer = excluded.manufacturer, owner = excluded.owner, operator_code = excluded.operator_code,
       photo = excluded.photo, checked_at = excluded.checked_at`
  ).run(tail, result.found ? 1 : 0, result.mode_s ?? null, result.type ?? null, result.manufacturer ?? null,
    result.owner ?? null, result.operator_code ?? null, result.photo ?? null, now());
  return result;
}

// Live position. Uses the transponder ID when known (it's what the plane actually broadcasts);
// otherwise searches by registration, with and without the hyphen.
export async function lookupLive(tail, hex) {
  const urls = [];
  if (hex) urls.push(`https://opendata.adsb.fi/api/v2/hex/${hex}`, `https://api.adsb.lol/v2/hex/${hex}`);
  else {
    for (const form of new Set([tail, tail.replace(/-/g, '')])) {
      urls.push(`https://opendata.adsb.fi/api/v2/registration/${encodeURIComponent(form)}`, `https://api.adsb.lol/v2/reg/${encodeURIComponent(form)}`);
    }
  }
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const ac = ((await res.json()).ac || []).find((a) => a.lat != null && a.lon != null);
      if (ac) return ac;
    } catch {
      // try the next source
    }
  }
  return null;
}

// Full check used before a tail code can be saved on a watch.
export async function checkTail(tail) {
  let reg;
  try {
    reg = await lookupRegistry(tail);
  } catch (e) {
    return { ok: false, tail, problem: `Couldn't check ${tail}: ${e.message} Try again in a minute.`, retry: true };
  }
  if (!reg.found) {
    return { ok: false, tail, problem: `No aircraft with the code ${tail} was found in the aircraft registry. Check the code and try again.` };
  }
  const tma = isTMA(reg);
  // hexdb backup can't tell the operator; accept Maldives registrations in that case
  const unknownOperator = !reg.owner && !reg.operator_code;
  if (!tma && !(unknownOperator && tail.startsWith('8Q-'))) {
    return {
      ok: false, tail, aircraft: reg,
      problem: `${tail} is a real aircraft${reg.type ? ` (${reg.type})` : ''}, but it's registered to ${reg.owner || 'another operator'}, not Trans Maldivian Airways.`,
    };
  }
  const ac = await lookupLive(tail, reg.mode_s);
  const live = ac
    ? {
        lat: ac.lat, lon: ac.lon,
        alt: ac.alt_baro === 'ground' ? 0 : Number(ac.alt_baro) || 0,
        gs: Number(ac.gs) || 0,
        seconds_ago: Math.round(ac.seen_pos ?? ac.seen ?? 0),
        on_ground: ac.alt_baro === 'ground',
      }
    : null;
  return { ok: true, tail, aircraft: reg, live, operator_unverified: unknownOperator };
}
