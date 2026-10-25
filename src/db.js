import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || join(root, 'data', 'seaplane-watch.db');
mkdirSync(dirname(dbPath), { recursive: true });
export const avatarDir = join(dirname(dbPath), 'avatars');
mkdirSync(avatarDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

const USERS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,                   -- E.164, e.g. +9607771234 (admin may have none)
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',   -- user | admin
  verified INTEGER NOT NULL DEFAULT 0,
  verify_code TEXT,
  verify_expires INTEGER,
  pending_phone TEXT,                  -- (no longer used: phone numbers were removed)
  avatar TEXT,                         -- file name in data/avatars
  shared_alerts INTEGER NOT NULL DEFAULT 1, -- get notifications for flights others share
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`;

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ---- Migrate databases created by version 0.1 (no usernames / roles) --------------------
if (columns('users').length && !columns('users').includes('username')) {
  // SQLite's recommended way: build the new table, copy, drop the old one, rename.
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  db.exec(USERS_SQL.replace('IF NOT EXISTS users', 'users_new'));
  const old = db.prepare('SELECT * FROM users').all();
  const ins = db.prepare(
    'INSERT INTO users_new (id, username, name, phone, password_hash, verified, verify_code, verify_expires, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  for (const u of old) {
    const base = (u.name || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'user';
    ins.run(u.id, `${base}${u.id}`, u.name, u.phone, u.password_hash, u.verified, u.verify_code, u.verify_expires, u.created_at);
  }
  db.exec('DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT;');
}
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
${USERS_SQL};
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  island TEXT,
  atoll TEXT,
  type TEXT NOT NULL DEFAULT 'resort',  -- base | resort | island
  lat REAL,
  lon REAL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(name)
);
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  destination_id INTEGER NOT NULL REFERENCES destinations(id),
  flight_date TEXT NOT NULL,           -- YYYY-MM-DD (Maldives time)
  expected_time TEXT,                  -- HH:MM, optional
  label TEXT,                          -- e.g. guest name / booking ref
  tail TEXT,                           -- e.g. 8Q-TMA, entered once confirmed
  status TEXT NOT NULL DEFAULT 'scheduled',
  notify TEXT NOT NULL DEFAULT 'assigned,departed,approaching,landed,delayed,cancelled',
  shared INTEGER NOT NULL DEFAULT 0,   -- visible to (and alerts) all users
  archived_at INTEGER,                 -- set when watching stops; then it shows in History
  archived_reason TEXT,                -- landed | cancelled | stopped
  last_lat REAL, last_lon REAL, last_alt INTEGER, last_gs REAL, last_seen_at INTEGER,
  distance_km REAL, eta_min INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL,                -- auto | manual
  by_user INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,                -- sent | logged | failed
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Add columns that 0.1 databases don't have yet.
for (const [table, col, def] of [
  ['watches', 'shared', 'INTEGER NOT NULL DEFAULT 0'],
  ['watches', 'archived_at', 'INTEGER'],
  ['watches', 'archived_reason', 'TEXT'],
  ['events', 'by_user', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['watches', 'aircraft_hex', 'TEXT'],   // transponder ID from the registry, used for live tracking
  ['watches', 'aircraft_type', 'TEXT'],  // e.g. "DHC-6 Twin Otter 300"
]) {
  if (!columns(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// Phone verification was removed, so every account counts as verified.
db.exec("UPDATE users SET verified = 1 WHERE verified = 0");

// Flights that finished before auto-stop existed belong in History.
db.exec(`UPDATE watches SET archived_at = updated_at, archived_reason = status
         WHERE archived_at IS NULL AND status IN ('landed', 'cancelled')`);

// Seed TMA destinations from data/destinations.json (safe to re-run; skips existing names).
const seedFile = join(root, 'data', 'destinations.json');
if (existsSync(seedFile)) {
  const insert = db.prepare(
    `INSERT INTO destinations (name, island, atoll, type, lat, lon) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET lat = COALESCE(destinations.lat, excluded.lat), lon = COALESCE(destinations.lon, excluded.lon)`
  );
  for (const d of JSON.parse(readFileSync(seedFile, 'utf8'))) {
    insert.run(d.name, d.island ?? null, d.atoll ?? null, d.type ?? 'resort', d.lat ?? null, d.lon ?? null);
  }
}

export const now = () => Date.now();
