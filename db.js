'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

// Postgres everywhere: a hosted database (Neon) when DATABASE_URL is set,
// otherwise an embedded Postgres (PGlite) stored in ./data for local runs.
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const APP_TZ = 'Asia/Kolkata';

let backend; // { query(sql, params) => { rows, rowCount } }
async function connect() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    return { query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql), transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: (s, p) => client.query(s, p) });
        await client.query('COMMIT');
        return out;
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.DB_PATH || path.join(__dirname, 'data', 'pg');
  require('node:fs').mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    query: async (sql, params) => { const r = await db.query(sql, params); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; },
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction((tx) => fn({ query: async (s, p) => { const r = await tx.query(s, p); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } })),
  };
}

// `?` placeholders are rewritten to Postgres' $1, $2, ...
const pgSql = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
const clean = (params) => params.map((p) => (p === undefined ? null : p));

function makeQ(exec) {
  return {
    get: async (sql, ...p) => (await exec(pgSql(sql), clean(p))).rows[0] || null,
    all: async (sql, ...p) => (await exec(pgSql(sql), clean(p))).rows,
    run: async (sql, ...p) => { const r = await exec(pgSql(sql), clean(p)); return { changes: r.rowCount, rows: r.rows }; },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('customer','provider','admin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id),
  business_name TEXT NOT NULL,
  area          TEXT NOT NULL,
  address       TEXT,
  bio           TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  accepting     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addresses (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  label      TEXT NOT NULL,
  line1      TEXT NOT NULL,
  area       TEXT NOT NULL,
  city       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_per_kg DOUBLE PRECISION NOT NULL,
  steps        TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id                    SERIAL PRIMARY KEY,
  code                  TEXT UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES users(id),
  provider_id           INTEGER REFERENCES providers(id),
  preferred_provider_id INTEGER REFERENCES providers(id),
  service_id            INTEGER NOT NULL REFERENCES services(id),
  service_name          TEXT NOT NULL,
  price_per_kg          DOUBLE PRECISION NOT NULL,
  steps                 TEXT NOT NULL,
  est_kg                DOUBLE PRECISION NOT NULL,
  actual_kg             DOUBLE PRECISION,
  est_price             DOUBLE PRECISION NOT NULL,
  final_price           DOUBLE PRECISION,
  address_text          TEXT NOT NULL,
  area                  TEXT NOT NULL,
  pickup_date           TEXT NOT NULL,
  pickup_slot           TEXT NOT NULL,
  delivery_date         TEXT NOT NULL,
  delivery_slot         TEXT NOT NULL,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'booked',
  payment_status        TEXT NOT NULL DEFAULT 'unpaid',
  rating                INTEGER,
  review                TEXT,
  cancel_reason         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders(status);
CREATE TABLE IF NOT EXISTS order_events (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  status     TEXT NOT NULL,
  note       TEXT,
  actor_id   INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  body       TEXT,
  order_id   INTEGER REFERENCES orders(id),
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS riders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id),
  area        TEXT NOT NULL,
  vehicle     TEXT NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0,
  online      INTEGER NOT NULL DEFAULT 0,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  location_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  raised_by     INTEGER REFERENCES users(id),
  type          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  resolution    TEXT,
  refund_amount DOUBLE PRECISION,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_order ON issues(order_id);
-- Presentation decks shared across devices (the hidden /present page). Files are stored in
-- chunks small enough for one serverless request each.
CREATE TABLE IF NOT EXISTS decks (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('pptx','pdf','image')),
  files      TEXT NOT NULL,
  size       BIGINT NOT NULL,
  slides     INTEGER NOT NULL,
  cover      TEXT,
  complete   INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deck_chunks (
  deck_id  INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  file_idx INTEGER NOT NULL,
  idx      INTEGER NOT NULL,
  data     BYTEA NOT NULL,
  PRIMARY KEY (deck_id, file_idx, idx)
);
`;

// Idempotent upgrades for databases created before delivery partners existed.
const MIGRATIONS = `
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer','provider','rider','admin'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_rider_id      INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_rider_id    INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_otp           TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_count          INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_received       INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee         DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method       TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_by         INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_settled         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_paid        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_leg_settled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_leg_settled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at         TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_attempts      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS needs_reschedule     TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_pickup_rider   ON orders(pickup_rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_rider ON orders(delivery_rider_id);
UPDATE orders SET pickup_otp   = lpad((floor(random()*10000))::int::text, 4, '0') WHERE pickup_otp IS NULL;
UPDATE orders SET delivery_otp = lpad((floor(random()*10000))::int::text, 4, '0') WHERE delivery_otp IS NULL;
UPDATE services SET steps = replace(steps, '"picked_up",', '"picked_up","at_provider",') WHERE steps NOT LIKE '%at_provider%';
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

// ---------- seed (empty database only) ----------
async function seed(q) {
  if ((await q.get('SELECT COUNT(*)::int AS n FROM users')).n > 0) return;
  const now = new Date().toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(new Date());
  const day = (offset) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
  const at = (offset, hour) => new Date(`${day(offset)}T${String(hour).padStart(2, '0')}:00:00+05:30`).toISOString();

  const addUser = async (role, name, email, phone, password) =>
    (await q.get('INSERT INTO users (role,name,email,phone,password_hash,created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      role, name, email, phone, hashPassword(password), now)).id;
  const addProvider = async (userId, business, area, address, bio, verified) =>
    (await q.get('INSERT INTO providers (user_id,business_name,area,address,bio,verified,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',
      userId, business, area, address, bio, verified, now)).id;

  const svc = 'INSERT INTO services (code,name,description,price_per_kg,steps) VALUES (?,?,?,?,?)';
  await q.run(svc, 'wash_iron', 'Wash + iron', 'Washed, dried and pressed', 79, JSON.stringify(['picked_up', 'at_provider', 'washing', 'drying', 'ironing', 'ready', 'out_for_delivery', 'delivered']));
  await q.run(svc, 'wash', 'Wash only', 'Washed, dried and folded', 59, JSON.stringify(['picked_up', 'at_provider', 'washing', 'drying', 'ready', 'out_for_delivery', 'delivered']));
  await q.run(svc, 'iron', 'Iron only', 'Pressed and folded', 39, JSON.stringify(['picked_up', 'at_provider', 'ironing', 'ready', 'out_for_delivery', 'delivered']));

  // On a public deployment the admin password comes from ADMIN_PASSWORD, not the demo default.
  await addUser('admin', 'LoopOps Admin', 'admin@laundryloop.test', '9000000001', process.env.ADMIN_PASSWORD || 'admin123');

  const ramesh = await addUser('provider', 'Ramesh Kumar', 'ramesh@laundryloop.test', '9000000002', 'provider123');
  const rameshP = await addProvider(ramesh, "Ramesh's Laundry", 'Wadala', 'Shop 4, Antop Hill Rd, Wadala', 'Family-run laundry since 2009.', 1);
  const sunita = await addUser('provider', 'Sunita Patil', 'sunita@laundryloop.test', '9000000003', 'provider123');
  await addProvider(sunita, 'Sunita Home Laundry', 'Wadala', 'Flat 12, Bhakti Park, Wadala', 'Homemaker partner, careful with delicates.', 1);
  const meena = await addUser('provider', 'Meena Shah', 'meena@laundryloop.test', '9000000004', 'provider123');
  await addProvider(meena, 'Meena Press & Fold', 'Sion', 'Room 7, Sion Koliwada', 'Ironing specialist.', 0);

  const raju = await addUser('rider', 'Raju Yadav', 'raju@laundryloop.test', '9000000006', 'rider123');
  await q.run('INSERT INTO riders (user_id,area,vehicle,verified,online,created_at) VALUES (?,?,?,?,?,?)', raju, 'Wadala', 'Bike', 1, 1, now);
  const imran = await addUser('rider', 'Imran Shaikh', 'imran@laundryloop.test', '9000000007', 'rider123');
  await q.run('INSERT INTO riders (user_id,area,vehicle,verified,online,created_at) VALUES (?,?,?,?,?,?)', imran, 'Sion', 'Bicycle', 0, 0, now);

  const aditya = await addUser('customer', 'Aditya', 'aditya@laundryloop.test', '9000000005', 'customer123');
  await q.run('INSERT INTO addresses (user_id,label,line1,area,city,created_at) VALUES (?,?,?,?,?,?)',
    aditya, 'Hostel', 'VIT Hostel, Room 214', 'Wadala', 'Mumbai', now);

  // One completed past order so history and ratings are not empty.
  const steps = ['picked_up', 'at_provider', 'washing', 'drying', 'ironing', 'ready', 'out_for_delivery', 'delivered'];
  const oid = (await q.get(`INSERT INTO orders (customer_id,provider_id,service_id,service_name,price_per_kg,steps,est_kg,actual_kg,est_price,final_price,
      address_text,area,pickup_date,pickup_slot,delivery_date,delivery_slot,status,payment_status,rating,review,created_at,updated_at,
      pickup_rider_id,delivery_rider_id,pickup_otp,delivery_otp,items_count,items_received,delivery_fee,payment_method,collected_by,
      cash_settled,provider_paid,pickup_leg_settled,delivery_leg_settled,picked_up_at,delivered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    aditya, rameshP, 1, 'Wash + iron', 79, JSON.stringify(steps), 3, 3.2, 237, 253,
    'VIT Hostel, Room 214, Wadala, Mumbai', 'Wadala', day(-3), '16-18', day(-2), '16-18', 'delivered', 'paid', 5, 'Crisp and on time.', at(-4, 11), at(-2, 17),
    raju, raju, '4821', '7310', 11, 11, 40, 'cash', raju, 1, 1, 1, 1, at(-3, 16), at(-2, 17))).id;
  await q.run('UPDATE orders SET code=? WHERE id=?', 'LL-' + (2287 + oid), oid);
  const ev = 'INSERT INTO order_events (order_id,status,note,actor_id,created_at) VALUES (?,?,?,?,?)';
  await q.run(ev, oid, 'booked', null, aditya, at(-4, 11));
  await q.run(ev, oid, 'accepted', null, ramesh, at(-4, 12));
  const timeline = [
    ['picked_up', raju, -3, 16, '11 items collected'], ['at_provider', ramesh, -3, 17, 'Weighed 3.2 kg · ₹253 · 11 items'],
    ['washing', ramesh, -3, 19, null], ['drying', ramesh, -3, 21, null], ['ironing', ramesh, -2, 10, null],
    ['ready', ramesh, -2, 12, null], ['out_for_delivery', raju, -2, 16, null], ['delivered', raju, -2, 17, 'Cash ₹293 collected'],
  ];
  for (const [s, actor, d, h, note] of timeline) await q.run(ev, oid, s, note, actor, at(d, h));
}

// Databases seeded before delivery partners existed get the demo riders too.
async function seedRiders(q) {
  if (await q.get("SELECT id FROM users WHERE role='rider' LIMIT 1")) return;
  const now = new Date().toISOString();
  const demo = [
    ['Raju Yadav', 'raju@laundryloop.test', '9000000006', 'Wadala', 'Bike', 1],
    ['Imran Shaikh', 'imran@laundryloop.test', '9000000007', 'Sion', 'Bicycle', 0],
  ];
  for (const [name, email, phone, area, vehicle, verified] of demo) {
    if (await q.get('SELECT id FROM users WHERE email=?', email)) continue;
    const id = (await q.get("INSERT INTO users (role,name,email,phone,password_hash,created_at) VALUES ('rider',?,?,?,?,?) RETURNING id",
      name, email, phone, hashPassword('rider123'), now)).id;
    await q.run('INSERT INTO riders (user_id,area,vehicle,verified,online,created_at) VALUES (?,?,?,?,?,?)', id, area, vehicle, verified, verified, now);
  }
}

// Connect, create tables and seed once per process; every request awaits this.
let ready;
function init() {
  if (!ready) {
    ready = (async () => {
      backend = await connect();
      // Serialise schema changes and first-run seeding across concurrent cold starts.
      await backend.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(7231001)');
        for (const stmt of (SCHEMA + MIGRATIONS).split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
        const tq = makeQ((s, p) => tx.query(s, p));
        await seed(tq);
        await seedRiders(tq);
      });
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const q = makeQ((sql, params) => backend.query(sql, params));

module.exports = { q, init, hashPassword, verifyPassword, APP_TZ };
