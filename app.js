'use strict';
// LaundryLoop API: one request handler used by the local server (server.js)
// and by the Vercel function (api/index.js).
//
// An order moves through two delivery legs around the homemaker's work:
//   booked → accepted (homemaker) → picked_up (rider, customer OTP) → at_provider (homemaker weighs)
//   → washing / drying / ironing → ready → out_for_delivery (rider collects) → delivered (rider, customer OTP)
const crypto = require('node:crypto');
const { q, init, hashPassword, verifyPassword, APP_TZ } = require('./db');

const COMMISSION = 0.15;          // platform share of the laundry price
const RIDER_FEE = 25;             // paid to whoever does a pickup or delivery leg
const DELIVERY_FEE = 40;          // charged to the customer...
const FREE_DELIVERY_ABOVE = 400;  // ...unless the estimated laundry price is at least this
const MAX_ACTIVE_LEGS = 4;        // jobs a rider can hold at once
const PICKUP_DAYS = 4;            // today + next 3 days
const MAX_TURNAROUND_DAYS = 5;    // latest delivery date after pickup

const SLOTS = [
  { id: '08-10', label: '8–10 AM', start: 8 },
  { id: '12-14', label: '12–2 PM', start: 12 },
  { id: '16-18', label: '4–6 PM', start: 16 },
  { id: '19-21', label: '7–9 PM', start: 19 },
];

const STATUS_LABEL = {
  booked: 'Waiting for provider',
  accepted: 'Accepted',
  picked_up: 'Picked up',
  at_provider: 'At laundry',
  washing: 'Washing',
  drying: 'Drying',
  ironing: 'Ironing',
  ready: 'Ready',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};
const CLOSED = ['delivered', 'cancelled'];
const PROCESSING = ['washing', 'drying', 'ironing', 'ready'];
const ISSUE_TYPES = { missing_item: 'Missing item', damaged: 'Damaged item', late: 'Late pickup or delivery', behaviour: 'Rider or provider behaviour', item_mismatch: 'Item count mismatch', other: 'Other' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();
const money = (n) => Math.round(n);
const otp = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// Dates and slot hours are in the service's local time zone, whatever the server's.
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: 'numeric', hourCycle: 'h23' });
const localDate = (d = new Date()) => dateFmt.format(d);
const localHour = () => Number(hourFmt.format(new Date()));
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const slotById = (id) => SLOTS.find((s) => s.id === id);
const slotText = (date, slot) => `${date}, ${slotById(slot)?.label || slot}`;
function availableSlots(date) {
  const today = localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return [];
  if (date === today) {
    const hour = localHour();
    return SLOTS.filter((s) => s.start > hour);
  }
  return SLOTS;
}
function pickupDates() {
  const out = [];
  for (let i = 0; i < PICKUP_DAYS; i++) {
    const date = addDays(localDate(), i);
    const slots = availableSlots(date).map((s) => s.id);
    if (slots.length) out.push({ date, slots });
  }
  return out;
}
const deliveryFeeFor = (estPrice) => (estPrice >= FREE_DELIVERY_ABOVE ? 0 : DELIVERY_FEE);

const str = (v, name, max = 200) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) fail(400, `${name} is required`);
  if (s.length > max) fail(400, `${name} is too long`);
  return s;
};
const optStr = (v, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `${name} must be between ${min} and ${max}`);
  return n;
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function notify(userId, title, body, orderId = null) {
  if (!userId) return;
  await q.run('INSERT INTO notifications (user_id,title,body,order_id,created_at) VALUES (?,?,?,?,?)', userId, title, body || null, orderId, nowIso());
}
const adminIds = async () => (await q.all("SELECT id FROM users WHERE role='admin' AND active=1")).map((r) => r.id);
const providerUserId = async (providerId) => providerId && (await q.get('SELECT user_id FROM providers WHERE id=?', providerId))?.user_id;
const onlineRiderIds = async () => (await q.all(
  'SELECT r.user_id FROM riders r JOIN users u ON u.id=r.user_id WHERE r.verified=1 AND r.online=1 AND u.active=1')).map((r) => r.user_id);

async function addEvent(orderId, status, note, actorId) {
  await q.run('INSERT INTO order_events (order_id,status,note,actor_id,created_at) VALUES (?,?,?,?,?)', orderId, status, note || null, actorId || null, nowIso());
}
const touch = (orderId) => q.run('UPDATE orders SET updated_at=? WHERE id=?', nowIso(), orderId);

// ---------- auth ----------
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await q.run('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)', token, userId, nowIso());
  return token;
}
async function userFromToken(token) {
  if (!token) return null;
  return q.get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1', token);
}
const providerOf = (user) => q.get('SELECT * FROM providers WHERE user_id=?', user.id);
const riderOf = (user) => q.get('SELECT * FROM riders WHERE user_id=?', user.id);
async function publicUser(u) {
  const { password_hash, ...rest } = u;
  if (u.role === 'provider') rest.provider = await providerOf(u);
  if (u.role === 'rider') rest.rider = await riderOf(u);
  return rest;
}

// ---------- orders ----------
const riderCols = (n, leg) => `r${n}.name AS ${leg}_rider_name, r${n}.phone AS ${leg}_rider_phone, r${n}.role AS ${leg}_rider_role,
  rr${n}.vehicle AS ${leg}_rider_vehicle, rr${n}.lat AS ${leg}_rider_lat, rr${n}.lng AS ${leg}_rider_lng, rr${n}.location_at AS ${leg}_rider_location_at`;
const ORDER_SQL = `
  SELECT o.*, p.business_name AS provider_name, p.area AS provider_area, p.address AS provider_address, p.user_id AS provider_user_id,
         pu.phone AS provider_phone, pu.name AS provider_contact, pp.business_name AS preferred_provider_name,
         c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
         ${riderCols(1, 'pickup')}, ${riderCols(2, 'delivery')},
         (SELECT COUNT(*)::int FROM issues i WHERE i.order_id=o.id AND i.status='open') AS open_issues
  FROM orders o
  LEFT JOIN providers p  ON p.id = o.provider_id
  LEFT JOIN users pu     ON pu.id = p.user_id
  LEFT JOIN providers pp ON pp.id = o.preferred_provider_id
  JOIN users c           ON c.id = o.customer_id
  LEFT JOIN users r1     ON r1.id = o.pickup_rider_id
  LEFT JOIN riders rr1   ON rr1.user_id = o.pickup_rider_id
  LEFT JOIN users r2     ON r2.id = o.delivery_rider_id
  LEFT JOIN riders rr2   ON rr2.user_id = o.delivery_rider_id`;

const flowOf = (o) => ['booked', 'accepted', ...JSON.parse(o.steps)];
const getOrder = async (id) => {
  const n = Number(id);
  if (!Number.isInteger(n)) fail(404, 'Order not found');
  return (await q.get(`${ORDER_SQL} WHERE o.id=?`, n)) || fail(404, 'Order not found');
};

// Which leg is "live" right now, and who is on it.
const PICKUP_LEG = ['accepted', 'picked_up'];
const DELIVERY_LEG = ['ready', 'out_for_delivery'];
function legOf(o, userId) {
  if (o.pickup_rider_id === userId && PICKUP_LEG.includes(o.status)) return 'pickup';
  if (o.delivery_rider_id === userId && DELIVERY_LEG.includes(o.status)) return 'delivery';
  return null;
}
const isOpenPickupJob = (o) => o.status === 'accepted' && !o.pickup_rider_id && !o.needs_reschedule;
const isOpenDeliveryJob = (o) => o.status === 'ready' && !o.delivery_rider_id && !o.needs_reschedule;

async function canSee(o, user) {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return o.customer_id === user.id;
  if (o.pickup_rider_id === user.id || o.delivery_rider_id === user.id) return true;
  if (user.role === 'rider') {
    const r = await riderOf(user);
    return !!r?.verified && (isOpenPickupJob(o) || isOpenDeliveryJob(o));
  }
  const p = await providerOf(user);
  if (!p) return false;
  if (o.provider_id === p.id) return true;
  return o.status === 'booked' && !o.provider_id && p.verified === 1 && (!o.preferred_provider_id || o.preferred_provider_id === p.id);
}

function orderView(o, user) {
  const flow = flowOf(o);
  const { steps, pickup_otp, delivery_otp, ...v } = o;
  v.flow = flow;
  v.next_status = CLOSED.includes(o.status) ? null : flow[flow.indexOf(o.status) + 1] || null;
  v.progress = o.status === 'cancelled' ? 0 : flow.indexOf(o.status) / (flow.length - 1);
  v.laundry_price = o.final_price ?? o.est_price;
  v.total = v.laundry_price + (o.delivery_fee || 0);
  v.my_leg = legOf(o, user.id);
  v.rider_fee = RIDER_FEE;

  if (user.role === 'customer') {
    // Codes the customer reads out to the rider at the door.
    v.pickup_otp = ['booked', 'accepted'].includes(o.status) ? pickup_otp : null;
    v.delivery_otp = DELIVERY_LEG.includes(o.status) ? delivery_otp : null;
    // Only show where a rider is while they are heading to the customer.
    if (o.status !== 'accepted') for (const k of ['lat', 'lng', 'location_at']) v[`pickup_rider_${k}`] = null;
    if (o.status !== 'out_for_delivery') for (const k of ['lat', 'lng', 'location_at']) v[`delivery_rider_${k}`] = null;
  } else {
    v.provider_earning = money(v.laundry_price * (1 - COMMISSION));
    v.platform_fee = money(v.laundry_price * COMMISSION);
  }
  // Providers see the exact address and phone once they've accepted.
  if (user.role === 'provider' && !o.provider_id) {
    v.address_text = null;
    v.customer_phone = null;
    v.customer_email = null;
  }
  if (user.role === 'rider') {
    delete v.provider_earning;
    delete v.platform_fee;
    // An open job only shows areas; addresses and phones come with taking it.
    if (o.pickup_rider_id !== user.id && o.delivery_rider_id !== user.id) {
      v.address_text = null;
      v.customer_phone = null;
      v.customer_email = null;
      v.provider_address = null;
      v.provider_phone = null;
    }
  }
  return v;
}

async function loadOrderFor(id, user) {
  const o = await getOrder(id);
  if (!(await canSee(o, user))) fail(404, 'Order not found');
  return o;
}

async function raiseIssue(order, raisedBy, type, description) {
  await q.run('INSERT INTO issues (order_id,raised_by,type,description,created_at) VALUES (?,?,?,?,?)', order.id, raisedBy, type, description, nowIso());
  for (const id of await adminIds()) await notify(id, `Issue on ${order.code}: ${ISSUE_TYPES[type]}`, description, order.id);
  await touch(order.id);
}

// ---------- routing ----------
const ANY = 'any';
const routes = [];
// opts.raw: the request body is binary (read as a Buffer, up to RAW_LIMIT) rather than JSON.
function route(method, pattern, roles, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, roles, handler, raw: !!opts.raw });
}

// --- public ---
route('GET', '/api/config', null, () => ({
  slots: SLOTS, statusLabel: STATUS_LABEL, commission: COMMISSION, riderFee: RIDER_FEE, deliveryFee: DELIVERY_FEE,
  freeDeliveryAbove: FREE_DELIVERY_ABOVE, issueTypes: ISSUE_TYPES,
  demo: process.env.DEMO_LOGINS !== '0', demoAdmin: !process.env.ADMIN_PASSWORD,
  // Opt-in (PREFILL_ADMIN_LOGIN=1): publish the admin login so every device gets it filled in.
  // Anyone who opens the site can then sign in as admin, so only use it for a demo.
  adminLogin: process.env.PREFILL_ADMIN_LOGIN === '1'
    ? { email: 'admin@laundryloop.test', password: process.env.ADMIN_PASSWORD || 'admin123' } : null,
}));

route('GET', '/api/slots', null, () => ({ pickupDates: pickupDates(), slots: SLOTS, maxTurnaround: MAX_TURNAROUND_DAYS }));

route('GET', '/api/services', null, async ({ user, query }) => {
  const all = user?.role === 'admin' && query.get('all');
  return (await q.all(`SELECT * FROM services ${all ? '' : 'WHERE active=1'} ORDER BY id`)).map((s) => ({ ...s, steps: JSON.parse(s.steps) }));
});

const RATING_SQL = `(SELECT ROUND(AVG(rating)::numeric,1)::float FROM orders WHERE provider_id=p.id AND rating IS NOT NULL)`;

route('GET', '/api/providers', null, () => q.all(`
  SELECT p.id, p.business_name, p.area, p.bio, p.accepting, ${RATING_SQL} AS rating,
         (SELECT COUNT(rating)::int FROM orders WHERE provider_id=p.id) AS rating_count,
         (SELECT COUNT(*)::int FROM orders WHERE provider_id=p.id AND status='delivered') AS completed
  FROM providers p JOIN users u ON u.id=p.user_id
  WHERE p.verified=1 AND u.active=1
  ORDER BY rating DESC NULLS LAST, completed DESC`));

// --- auth ---
route('POST', '/api/auth/register', null, async ({ body }) => {
  const role = ['provider', 'rider'].includes(body.role) ? body.role : 'customer';
  const name = str(body.name, 'Name', 80);
  const email = str(body.email, 'Email', 120).toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email');
  const phone = str(body.phone, 'Phone', 20);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (await q.get('SELECT id FROM users WHERE email=?', email)) fail(409, 'An account with this email already exists');

  let business, area, vehicle;
  if (role === 'provider') business = str(body.business_name, 'Business name', 80);
  if (role !== 'customer') area = str(body.area, role === 'rider' ? 'Area' : 'Service area', 60);
  if (role === 'rider') vehicle = str(body.vehicle, 'Vehicle', 30);

  const userId = (await q.get('INSERT INTO users (role,name,email,phone,password_hash,created_at) VALUES (?,?,?,?,?,?) RETURNING id',
    role, name, email, phone, hashPassword(password), nowIso())).id;
  if (role === 'provider') {
    await q.run('INSERT INTO providers (user_id,business_name,area,address,bio,created_at) VALUES (?,?,?,?,?,?)',
      userId, business, area, optStr(body.address), optStr(body.bio), nowIso());
    for (const id of await adminIds()) await notify(id, 'New provider awaiting verification', `${business} (${area}) signed up.`);
  }
  if (role === 'rider') {
    await q.run('INSERT INTO riders (user_id,area,vehicle,created_at) VALUES (?,?,?,?)', userId, area, vehicle, nowIso());
    for (const id of await adminIds()) await notify(id, 'New delivery partner awaiting verification', `${name} (${vehicle}, ${area}) signed up.`);
  }
  const user = await q.get('SELECT * FROM users WHERE id=?', userId);
  return { token: await createSession(userId), user: await publicUser(user) };
});

route('POST', '/api/auth/login', null, async ({ body }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const user = await q.get('SELECT * FROM users WHERE email=?', email);
  if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) fail(401, 'Wrong email or password');
  if (!user.active) fail(403, 'This account has been suspended. Contact support.');
  return { token: await createSession(user.id), user: await publicUser(user) };
});

route('POST', '/api/auth/logout', ANY, async ({ token, user }) => {
  await q.run('DELETE FROM sessions WHERE token=?', token);
  if (user.role === 'rider') await q.run('UPDATE riders SET online=0 WHERE user_id=?', user.id);
});

route('GET', '/api/me', ANY, ({ user }) => publicUser(user));

route('PATCH', '/api/me', ANY, async ({ user, body }) => {
  await q.run('UPDATE users SET name=?, phone=? WHERE id=?', str(body.name ?? user.name, 'Name', 80), str(body.phone ?? user.phone, 'Phone', 20), user.id);
  return publicUser(await q.get('SELECT * FROM users WHERE id=?', user.id));
});

// Cheap change-detection for clients: they poll this and refetch when a value moves.
route('GET', '/api/pulse', ANY, async ({ user }) => {
  const n = await q.get('SELECT COALESCE(MAX(id),0)::int AS m, COUNT(*) FILTER (WHERE read=0)::int AS u FROM notifications WHERE user_id=?', user.id);
  let o;
  let p = '';
  const mine = `pickup_rider_id=${Number(user.id)} OR delivery_rider_id=${Number(user.id)}`;
  if (user.role === 'customer') {
    o = await q.get('SELECT MAX(updated_at) AS t, COUNT(*)::int AS c FROM orders WHERE customer_id=?', user.id);
  } else if (user.role === 'provider') {
    const me = await providerOf(user);
    o = await q.get(`SELECT MAX(updated_at) AS t, COUNT(*)::int AS c FROM orders
                     WHERE provider_id=? OR ${mine} OR (status='booked' AND provider_id IS NULL AND (preferred_provider_id IS NULL OR preferred_provider_id=?))`, me?.id ?? -1, me?.id ?? -1);
    p = `${me?.verified}${me?.accepting}`;
  } else if (user.role === 'rider') {
    const me = await riderOf(user);
    o = await q.get(`SELECT MAX(updated_at) AS t, COUNT(*)::int AS c FROM orders
                     WHERE ${mine} OR (status='accepted' AND pickup_rider_id IS NULL) OR (status='ready' AND delivery_rider_id IS NULL)`);
    p = `${me?.verified}${me?.online}`;
  } else {
    o = await q.get('SELECT MAX(updated_at) AS t, COUNT(*)::int AS c FROM orders');
    const pr = await q.get(`SELECT
        (SELECT COUNT(*) FROM providers)::int || '.' || (SELECT COALESCE(SUM(verified),0) FROM providers)::int || '.' ||
        (SELECT COALESCE(SUM(accepting),0) FROM providers)::int || '.' || (SELECT COALESCE(SUM(active),0) FROM users)::int || '.' ||
        (SELECT COUNT(*) FROM riders)::int || '.' || (SELECT COALESCE(SUM(verified),0) FROM riders)::int || '.' ||
        (SELECT COALESCE(SUM(online),0) FROM riders)::int || '.' || (SELECT COUNT(*) FROM issues WHERE status='open')::int AS s`);
    p = pr.s;
  }
  return { n: `${n.m}.${n.u}`, o: `${o.t}.${o.c}`, p };
});

// --- notifications ---
route('GET', '/api/notifications', ANY, async ({ user }) => ({
  items: await q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 40', user.id),
  unread: (await q.get('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=? AND read=0', user.id)).n,
}));
route('POST', '/api/notifications/read', ANY, async ({ user }) => { await q.run('UPDATE notifications SET read=1 WHERE user_id=? AND read=0', user.id); });

// --- addresses (customer) ---
route('GET', '/api/addresses', ['customer'], ({ user }) => q.all('SELECT * FROM addresses WHERE user_id=? ORDER BY id', user.id));
route('POST', '/api/addresses', ['customer'], async ({ user, body }) => q.get(
  'INSERT INTO addresses (user_id,label,line1,area,city,created_at) VALUES (?,?,?,?,?,?) RETURNING *',
  user.id, str(body.label || 'Home', 'Label', 30), str(body.line1, 'Address', 160), str(body.area, 'Area', 60), str(body.city || 'Mumbai', 'City', 60), nowIso()));
route('DELETE', '/api/addresses/:id', ['customer'], async ({ user, params }) => {
  await q.run('DELETE FROM addresses WHERE id=? AND user_id=?', Number(params.id) || 0, user.id);
});

// --- orders ---
route('GET', '/api/orders', ANY, async ({ user, query }) => {
  const where = [];
  const args = [];
  if (user.role === 'customer') { where.push('o.customer_id=?'); args.push(user.id); }
  if (user.role === 'provider') { where.push('o.provider_id=?'); args.push((await providerOf(user))?.id ?? -1); }
  if (user.role === 'rider') { where.push('(o.pickup_rider_id=? OR o.delivery_rider_id=?)'); args.push(user.id, user.id); }
  const status = query.get('status');
  if (status === 'active') where.push(`o.status NOT IN ('delivered','cancelled')`);
  else if (status === 'unassigned') where.push(`o.status='booked'`);
  else if (status === 'needs_rider') where.push(`((o.status='accepted' AND o.pickup_rider_id IS NULL) OR (o.status='ready' AND o.delivery_rider_id IS NULL))`);
  else if (status === 'attention') where.push(`(o.needs_reschedule IS NOT NULL OR EXISTS (SELECT 1 FROM issues i WHERE i.order_id=o.id AND i.status='open'))`);
  else if (status && STATUS_LABEL[status]) { where.push('o.status=?'); args.push(status); }
  const search = query.get('q');
  if (search && user.role === 'admin') {
    where.push('(o.code ILIKE ? OR c.name ILIKE ? OR p.business_name ILIKE ? OR r1.name ILIKE ? OR r2.name ILIKE ?)');
    args.push(...Array(5).fill(`%${search}%`));
  }
  const rows = await q.all(`${ORDER_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT 300`, ...args);
  return rows.map((o) => orderView(o, user));
});

route('GET', '/api/orders/:id', ANY, async ({ user, params }) => {
  const o = await loadOrderFor(params.id, user);
  const events = await q.all(`SELECT e.status, e.note, e.created_at, u.name AS actor_name, u.role AS actor_role
                        FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.id`, o.id);
  const issues = ['customer', 'admin'].includes(user.role) || o.provider_user_id === user.id
    ? await q.all('SELECT i.*, u.name AS raised_by_name FROM issues i LEFT JOIN users u ON u.id=i.raised_by WHERE i.order_id=? ORDER BY i.id DESC', o.id)
    : [];
  return { ...orderView(o, user), events, issues };
});

function validateDelivery(pickupDate, deliveryDate, deliverySlot) {
  if (!slotById(deliverySlot)) fail(400, 'Choose a delivery slot');
  if (deliveryDate < addDays(pickupDate, 1) || deliveryDate > addDays(pickupDate, MAX_TURNAROUND_DAYS)) {
    fail(400, `Delivery must be 1–${MAX_TURNAROUND_DAYS} days after pickup`);
  }
}
function validatePickup(date, slot) {
  if (!availableSlots(date).some((s) => s.id === slot) || date > addDays(localDate(), PICKUP_DAYS - 1)) {
    fail(400, 'That pickup slot is no longer available');
  }
}

route('POST', '/api/orders', ['customer'], async ({ user, body }) => {
  const service = (await q.get('SELECT * FROM services WHERE id=? AND active=1', Number(body.service_id) || 0)) || fail(400, 'Choose a service');
  const estKg = num(body.est_kg, 'Estimated weight', 1, 30);
  const addr = (await q.get('SELECT * FROM addresses WHERE id=? AND user_id=?', Number(body.address_id) || 0, user.id)) || fail(400, 'Choose a pickup address');
  const pickupDate = String(body.pickup_date || '');
  const pickupSlot = String(body.pickup_slot || '');
  validatePickup(pickupDate, pickupSlot);
  const deliveryDate = String(body.delivery_date || '');
  const deliverySlot = String(body.delivery_slot || '');
  validateDelivery(pickupDate, deliveryDate, deliverySlot);

  let preferred = null;
  if (body.provider_id) {
    const p = await q.get('SELECT p.* FROM providers p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.verified=1 AND u.active=1', Number(body.provider_id) || 0);
    if (!p) fail(400, 'That provider is not available');
    if (!p.accepting) fail(400, `${p.business_name} is not taking new orders right now`);
    preferred = p.id;
  }

  const ts = nowIso();
  const estPrice = money(service.price_per_kg * estKg);
  const id = (await q.get(`INSERT INTO orders (customer_id,preferred_provider_id,service_id,service_name,price_per_kg,steps,est_kg,est_price,
      address_text,area,pickup_date,pickup_slot,delivery_date,delivery_slot,notes,delivery_fee,pickup_otp,delivery_otp,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    user.id, preferred, service.id, service.name, service.price_per_kg, service.steps, estKg, estPrice,
    `${addr.line1}, ${addr.area}, ${addr.city}`, addr.area, pickupDate, pickupSlot, deliveryDate, deliverySlot, optStr(body.notes),
    deliveryFeeFor(estPrice), otp(), otp(), ts, ts)).id;
  await q.run('UPDATE orders SET code=? WHERE id=?', 'LL-' + (2287 + id), id);
  await addEvent(id, 'booked', null, user.id);

  const o = await getOrder(id);
  await notify(user.id, 'Pickup booked', `${o.code}: we'll let you know when a provider accepts.`, id);
  const providerUsers = preferred
    ? [await providerUserId(preferred)]
    : (await q.all('SELECT user_id FROM providers WHERE verified=1 AND accepting=1')).map((r) => r.user_id);
  for (const uid of providerUsers) await notify(uid, 'New pickup request', `${o.service_name}, ~${estKg} kg in ${o.area}.`, id);
  return orderView(o, user);
});

route('POST', '/api/orders/:id/cancel', ['customer', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (user.role === 'customer' && !['booked', 'accepted'].includes(o.status)) fail(400, 'Orders can only be cancelled before pickup');
  if (CLOSED.includes(o.status)) fail(400, 'This order is already closed');
  const reason = optStr(body.reason) || (user.role === 'admin' ? 'Cancelled by support' : 'Cancelled by customer');
  await q.run(`UPDATE orders SET status='cancelled', cancel_reason=?, needs_reschedule=NULL, updated_at=? WHERE id=?`, reason, nowIso(), o.id);
  await addEvent(o.id, 'cancelled', reason, user.id);
  if (user.role === 'admin') await notify(o.customer_id, 'Order cancelled', `${o.code}: ${reason}`, o.id);
  if (o.provider_id) await notify(o.provider_user_id, 'Order cancelled', `${o.code} was cancelled.`, o.id);
  const rider = legOf(o, o.pickup_rider_id) ? o.pickup_rider_id : legOf(o, o.delivery_rider_id) ? o.delivery_rider_id : null;
  if (rider && rider !== o.provider_user_id) await notify(rider, 'Job cancelled', `${o.code} was cancelled. No need to go.`, o.id);
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/orders/:id/rate', ['customer'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (o.status !== 'delivered') fail(400, 'You can rate after delivery');
  if (o.rating) fail(400, 'Already rated');
  const rating = Math.round(num(body.rating, 'Rating', 1, 5));
  await q.run('UPDATE orders SET rating=?, review=?, updated_at=? WHERE id=?', rating, optStr(body.review), nowIso(), o.id);
  await notify(o.provider_user_id, `New ${rating}★ rating`, `${o.code}${optStr(body.review) ? ': “' + optStr(body.review, 80) + '”' : ''}`, o.id);
  return orderView(await getOrder(o.id), user);
});

// Customer (or support) picks a new pickup or delivery slot, e.g. after a missed visit.
route('POST', '/api/orders/:id/reschedule', ['customer', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  const leg = body.leg === 'delivery' ? 'delivery' : 'pickup';
  const date = String(body.date || '');
  const slot = String(body.slot || '');
  if (leg === 'pickup') {
    if (!['booked', 'accepted'].includes(o.status)) fail(400, 'Pickup is already done');
    validatePickup(date, slot);
    // Keep the delivery at least a day after the new pickup.
    let dDate = o.delivery_date;
    if (dDate < addDays(date, 1)) dDate = addDays(date, 1);
    if (dDate > addDays(date, MAX_TURNAROUND_DAYS)) dDate = addDays(date, MAX_TURNAROUND_DAYS);
    await q.run(`UPDATE orders SET pickup_date=?, pickup_slot=?, delivery_date=?, needs_reschedule=NULL, updated_at=? WHERE id=?`, date, slot, dDate, nowIso(), o.id);
  } else {
    if (['out_for_delivery', ...CLOSED].includes(o.status) || !['picked_up', 'at_provider', ...PROCESSING].includes(o.status)) {
      fail(400, o.status === 'out_for_delivery' ? 'Your order is already on its way' : 'Delivery can be rescheduled after pickup');
    }
    if (!availableSlots(date).some((s) => s.id === slot) || date > addDays(localDate(), MAX_TURNAROUND_DAYS)) fail(400, 'That delivery slot is not available');
    await q.run(`UPDATE orders SET delivery_date=?, delivery_slot=?, needs_reschedule=NULL, updated_at=? WHERE id=?`, date, slot, nowIso(), o.id);
  }
  await addEvent(o.id, o.status, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} rescheduled to ${slotText(date, slot)}`, user.id);
  if (o.provider_user_id) await notify(o.provider_user_id, `${o.code} rescheduled`, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} now ${slotText(date, slot)}.`, o.id);
  const rider = leg === 'pickup' ? o.pickup_rider_id : o.delivery_rider_id;
  if (rider && rider !== o.provider_user_id) await notify(rider, `${o.code} rescheduled`, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} now ${slotText(date, slot)}.`, o.id);
  if (user.role === 'admin') await notify(o.customer_id, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} rescheduled`, `${o.code}: ${slotText(date, slot)}.`, o.id);
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/orders/:id/issues', ['customer'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (['booked', 'accepted', 'cancelled'].includes(o.status)) fail(400, 'You can report a problem once your clothes are picked up');
  const type = ISSUE_TYPES[body.type] && body.type !== 'item_mismatch' ? body.type : fail(400, 'Choose what went wrong');
  await raiseIssue(o, user.id, type, str(body.description, 'Description', 1000));
  await notify(user.id, "We've got your report", `Support will look into ${o.code} and get back to you.`, o.id);
  return { ok: true };
});

// --- provider workflow ---
async function requireVerified(user) {
  const p = await providerOf(user);
  if (!p) fail(403, 'Provider profile missing');
  if (!p.verified) fail(403, 'Your account is waiting for admin verification');
  return p;
}

route('GET', '/api/provider/open', ['provider'], async ({ user }) => {
  const p = await providerOf(user);
  if (!p?.verified) return [];
  return (await q.all(`${ORDER_SQL} WHERE o.status='booked' AND o.provider_id IS NULL AND (o.preferred_provider_id IS NULL OR o.preferred_provider_id=?)
                ORDER BY o.pickup_date, o.pickup_slot`, p.id)).map((o) => orderView(o, user));
});

route('POST', '/api/orders/:id/accept', ['provider'], async ({ user, params }) => {
  const p = await requireVerified(user);
  const id = Number(params.id) || 0;
  // Conditional update so only one provider can win the order.
  const r = await q.run(`UPDATE orders SET provider_id=?, status='accepted', updated_at=?
                   WHERE id=? AND status='booked' AND provider_id IS NULL AND (preferred_provider_id IS NULL OR preferred_provider_id=?)`,
    p.id, nowIso(), id, p.id);
  if (!r.changes) fail(409, 'This order was already taken or cancelled');
  await addEvent(id, 'accepted', null, user.id);
  const o = await getOrder(id);
  await notify(o.customer_id, `${p.business_name} accepted your order`, `A delivery partner will pick up ${slotText(o.pickup_date, o.pickup_slot)}.`, id);
  for (const rid of await onlineRiderIds()) await notify(rid, 'New pickup job', `${o.area} → ${p.area} · ${slotText(o.pickup_date, o.pickup_slot)} · ₹${RIDER_FEE}`, id);
  return orderView(o, user);
});

route('POST', '/api/orders/:id/decline', ['provider'], async ({ user, params }) => {
  const p = await requireVerified(user);
  const o = await loadOrderFor(params.id, user);
  if (o.status !== 'booked' || o.preferred_provider_id !== p.id) fail(400, 'Only direct requests can be declined');
  await q.run('UPDATE orders SET preferred_provider_id=NULL, updated_at=? WHERE id=?', nowIso(), o.id);
  await addEvent(o.id, 'booked', `${p.business_name} couldn't take it; opened to all nearby providers`, user.id);
  await notify(o.customer_id, `${p.business_name} is unavailable`, `${o.code} is now open to other nearby providers.`, o.id);
  return { ok: true };
});

route('POST', '/api/orders/:id/release', ['provider'], async ({ user, params, body }) => {
  const p = await requireVerified(user);
  const o = await loadOrderFor(params.id, user);
  if (o.provider_id !== p.id || o.status !== 'accepted') fail(400, 'Only accepted orders that are not picked up can be released');
  await q.run(`UPDATE orders SET provider_id=NULL, preferred_provider_id=NULL, pickup_rider_id=NULL, status='booked', updated_at=? WHERE id=?`, nowIso(), o.id);
  await addEvent(o.id, 'booked', optStr(body.reason) || `${p.business_name} released the order`, user.id);
  await notify(o.customer_id, 'Finding you another provider', `${p.business_name} can't make it. ${o.code} is open to other nearby providers.`, o.id);
  if (o.pickup_rider_id && o.pickup_rider_id !== user.id) await notify(o.pickup_rider_id, 'Job cancelled', `${o.code} was released by the provider. No need to go.`, o.id);
  return { ok: true };
});

// Homemaker confirms the rider handed the clothes over, and weighs them.
route('POST', '/api/orders/:id/receive', ['provider', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (user.role === 'provider' && o.provider_id !== (await requireVerified(user)).id) fail(403, 'This order is not assigned to you');
  if (o.status !== 'picked_up') fail(409, o.status === 'accepted' ? 'The clothes have not been picked up yet' : 'Already received');
  const kg = Math.round(num(body.actual_kg, 'Weight', 0.5, 50) * 10) / 10;
  const items = Math.round(num(body.items_received, 'Item count', 1, 500));
  const finalPrice = money(o.price_per_kg * kg);
  const r = await q.run(`UPDATE orders SET status='at_provider', actual_kg=?, final_price=?, items_received=?, updated_at=? WHERE id=? AND status='picked_up'`,
    kg, finalPrice, items, nowIso(), o.id);
  if (!r.changes) fail(409, 'This order was already updated. Refresh and try again.');
  await addEvent(o.id, 'at_provider', `Weighed ${kg} kg · ₹${finalPrice} · ${items} items`, user.id);
  await notify(o.customer_id, `${o.provider_name} received your clothes`, `${items} items, ${kg} kg. Laundry price ₹${finalPrice}${o.delivery_fee ? ` + ₹${o.delivery_fee} delivery` : ''}.`, o.id);
  if (o.items_count && items !== o.items_count) {
    await raiseIssue(o, user.id, 'item_mismatch', `Rider collected ${o.items_count} items but ${o.provider_name} received ${items}.`);
  }
  return orderView(await getOrder(o.id), user);
});

// Processing steps (washing → … → ready) are the homemaker's.
route('POST', '/api/orders/:id/advance', ['provider', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (user.role === 'provider' && o.provider_id !== (await requireVerified(user)).id) fail(403, 'This order is not assigned to you');
  const flow = flowOf(o);
  const next = CLOSED.includes(o.status) ? null : flow[flow.indexOf(o.status) + 1];
  if (!next || !PROCESSING.includes(next) || ['booked', 'accepted', 'picked_up'].includes(o.status)) {
    fail(400, next === 'at_provider' ? 'Confirm you received the clothes first' : 'This step is done by the delivery partner');
  }
  if (body.expected && body.expected !== next) fail(409, 'This order was already updated. Refresh and try again.');
  const r = await q.run('UPDATE orders SET status=?, updated_at=? WHERE id=? AND status=?', next, nowIso(), o.id, o.status);
  if (!r.changes) fail(409, 'This order was already updated. Refresh and try again.');
  await addEvent(o.id, next, optStr(body.note), user.id);

  const msgs = {
    washing: ['Your laundry is being washed', null],
    drying: ['Your laundry is drying', null],
    ironing: ['Your laundry is being ironed', null],
    ready: ['Your laundry is ready', `A delivery partner will bring it ${slotText(o.delivery_date, o.delivery_slot)}.`],
  };
  const [title, text] = msgs[next];
  await notify(o.customer_id, title, text || `${o.code} · ${STATUS_LABEL[next]}`, o.id);
  if (user.role === 'admin') await notify(o.provider_user_id, 'Status updated by support', `${o.code} → ${STATUS_LABEL[next]}`, o.id);
  if (next === 'ready' && !o.delivery_rider_id) {
    for (const rid of await onlineRiderIds()) await notify(rid, 'New delivery job', `${o.provider_area} → ${o.area} · ${slotText(o.delivery_date, o.delivery_slot)} · ₹${RIDER_FEE}`, o.id);
  }
  return orderView(await getOrder(o.id), user);
});

// --- delivery legs (riders, or the homemaker doing it themselves) ---
async function requireRiderReady(user) {
  const r = await riderOf(user);
  if (!r) fail(403, 'Delivery partner profile missing');
  if (!r.verified) fail(403, 'Your account is waiting for admin verification');
  if (!r.online) fail(400, 'Go online to take jobs');
  return r;
}
async function activeLegs(userId) {
  return (await q.get(`SELECT COUNT(*)::int AS n FROM orders WHERE
    (pickup_rider_id=? AND status IN ('accepted','picked_up')) OR (delivery_rider_id=? AND status IN ('ready','out_for_delivery'))`, userId, userId)).n;
}
function requireLeg(o, user, leg) {
  if (user.role === 'admin') return;
  if (legOf(o, user.id) !== leg) fail(403, 'This job is not assigned to you');
}

route('GET', '/api/rider/jobs', ['rider'], async ({ user }) => {
  const r = await riderOf(user);
  if (!r?.verified || !r.online) return [];
  return (await q.all(`${ORDER_SQL} WHERE o.needs_reschedule IS NULL AND
      ((o.status='accepted' AND o.pickup_rider_id IS NULL) OR (o.status='ready' AND o.delivery_rider_id IS NULL))
      ORDER BY CASE WHEN o.status='accepted' THEN o.pickup_date ELSE o.delivery_date END,
               CASE WHEN o.status='accepted' THEN o.pickup_slot ELSE o.delivery_slot END`)).map((o) => orderView(o, user));
});

route('POST', '/api/orders/:id/take', ['rider', 'provider'], async ({ user, params }) => {
  const o = await loadOrderFor(params.id, user);
  const leg = o.status === 'accepted' ? 'pickup' : o.status === 'ready' ? 'delivery' : fail(409, 'This job is no longer available');
  if (user.role === 'rider') {
    await requireRiderReady(user);
    if ((await activeLegs(user.id)) >= MAX_ACTIVE_LEGS) fail(400, `Finish a job first. You can hold ${MAX_ACTIVE_LEGS} at a time.`);
  } else if (o.provider_id !== (await requireVerified(user)).id) {
    fail(403, 'This order is not assigned to you');
  }
  const col = `${leg}_rider_id`;
  const r = await q.run(`UPDATE orders SET ${col}=?, updated_at=? WHERE id=? AND status=? AND ${col} IS NULL AND needs_reschedule IS NULL`,
    user.id, nowIso(), o.id, o.status);
  if (!r.changes) fail(409, 'Someone else already took this job');
  const who = user.role === 'provider' ? `${o.provider_name} (self)` : user.name;
  await addEvent(o.id, o.status, `${who} will ${leg === 'pickup' ? 'pick up from you' : 'deliver'}`, user.id);
  if (leg === 'pickup') {
    await notify(o.customer_id, `${user.name} will pick up your clothes`, `${slotText(o.pickup_date, o.pickup_slot)}. Share your pickup code at the door.`, o.id);
    if (user.role === 'rider') await notify(o.provider_user_id, 'Rider assigned for pickup', `${user.name} will bring ${o.code} to you.`, o.id);
  } else {
    await notify(o.customer_id, `${user.name} will deliver your laundry`, `${slotText(o.delivery_date, o.delivery_slot)}. Keep your delivery code ready.`, o.id);
    if (user.role === 'rider') await notify(o.provider_user_id, 'Rider assigned for delivery', `${user.name} will collect ${o.code} from you.`, o.id);
  }
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/orders/:id/drop-job', ['rider', 'provider'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  const leg = legOf(o, user.id);
  if (!leg || (leg === 'pickup' && o.status !== 'accepted') || (leg === 'delivery' && o.status !== 'ready')) {
    fail(400, "You've already collected the clothes, so you can't drop this job");
  }
  await q.run(`UPDATE orders SET ${leg}_rider_id=NULL, updated_at=? WHERE id=?`, nowIso(), o.id);
  await addEvent(o.id, o.status, optStr(body.reason) || `${user.name} dropped the ${leg} job`, user.id);
  for (const rid of await onlineRiderIds()) {
    if (rid !== user.id) await notify(rid, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} job available again`, `${o.code} in ${o.area}.`, o.id);
  }
  return { ok: true };
});

// Rider at the customer's door: checks the pickup code and counts the items.
route('POST', '/api/orders/:id/pickup', ['rider', 'provider', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  requireLeg(o, user, 'pickup');
  if (o.status !== 'accepted') fail(409, 'Already picked up');
  const items = Math.round(num(body.items_count, 'Item count', 1, 500));
  if (user.role !== 'admin' && String(body.otp || '').trim() !== (await q.get('SELECT pickup_otp FROM orders WHERE id=?', o.id)).pickup_otp) {
    fail(400, "That pickup code doesn't match. Ask the customer for the code in their app.");
  }
  const ts = nowIso();
  const r = await q.run(`UPDATE orders SET status='picked_up', items_count=?, picked_up_at=?, updated_at=? WHERE id=? AND status='accepted'`, items, ts, ts, o.id);
  if (!r.changes) fail(409, 'This order was already updated. Refresh and try again.');
  await addEvent(o.id, 'picked_up', `${items} items collected${user.role === 'admin' ? ' (confirmed by support)' : ''}`, user.id);
  await notify(o.customer_id, 'Clothes picked up', `${items} items collected. They're on the way to ${o.provider_name}.`, o.id);
  if (o.provider_user_id !== user.id) await notify(o.provider_user_id, 'Clothes on the way to you', `${o.code}: ${items} items. Weigh them when they arrive.`, o.id);
  return orderView(await getOrder(o.id), user);
});

// Rider collects the finished laundry from the homemaker.
route('POST', '/api/orders/:id/collect', ['rider', 'provider', 'admin'], async ({ user, params }) => {
  const o = await loadOrderFor(params.id, user);
  requireLeg(o, user, 'delivery');
  if (o.status !== 'ready') fail(409, o.status === 'out_for_delivery' ? 'Already collected' : 'The laundry is not ready yet');
  const r = await q.run(`UPDATE orders SET status='out_for_delivery', updated_at=? WHERE id=? AND status='ready'`, nowIso(), o.id);
  if (!r.changes) fail(409, 'This order was already updated. Refresh and try again.');
  const who = o.delivery_rider_name || user.name;
  await addEvent(o.id, 'out_for_delivery', `${who} collected from ${o.provider_name}`, user.id);
  await notify(o.customer_id, 'Out for delivery', `${who} is bringing ${o.code}. Your delivery code: check the app. Amount due ₹${money(o.final_price + o.delivery_fee)}.`, o.id);
  return orderView(await getOrder(o.id), user);
});

// Rider at the customer's door: checks the delivery code and records payment.
route('POST', '/api/orders/:id/deliver', ['rider', 'provider', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  requireLeg(o, user, 'delivery');
  if (o.status !== 'out_for_delivery') fail(409, o.status === 'ready' ? 'Collect the laundry from the provider first' : 'Already delivered');
  if (user.role !== 'admin' && String(body.otp || '').trim() !== (await q.get('SELECT delivery_otp FROM orders WHERE id=?', o.id)).delivery_otp) {
    fail(400, "That delivery code doesn't match. Ask the customer for the code in their app.");
  }
  const alreadyPaid = o.payment_status === 'paid';
  const method = alreadyPaid ? o.payment_method : ['cash', 'upi'].includes(body.payment_method) ? body.payment_method : fail(400, 'Choose how the customer paid');
  const amount = money(o.final_price + o.delivery_fee);
  const ts = nowIso();
  const r = await q.run(`UPDATE orders SET status='delivered', delivered_at=?, updated_at=?, payment_status='paid', payment_method=?, collected_by=?
                         WHERE id=? AND status='out_for_delivery'`, ts, ts, method, alreadyPaid ? o.collected_by : (user.role === 'admin' ? o.delivery_rider_id : user.id), o.id);
  if (!r.changes) fail(409, 'This order was already updated. Refresh and try again.');
  await addEvent(o.id, 'delivered', alreadyPaid ? 'Delivered (already paid)' : `${method === 'cash' ? 'Cash' : 'UPI'} ₹${amount} received`, user.id);
  await notify(o.customer_id, 'Delivered', `${o.code} is delivered. How did ${o.provider_name} do? Leave a rating.`, o.id);
  if (o.provider_user_id !== user.id) await notify(o.provider_user_id, 'Order delivered', `${o.code} reached the customer.`, o.id);
  return orderView(await getOrder(o.id), user);
});

// Nobody home: the attempt is logged and the customer is asked to pick a new slot.
route('POST', '/api/orders/:id/attempt-failed', ['rider', 'provider', 'admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  const leg = user.role === 'admin' ? (o.status === 'accepted' ? 'pickup' : 'delivery') : legOf(o, user.id);
  const reason = optStr(body.reason) || 'Customer not available';
  if (leg === 'pickup' && o.status === 'accepted' && o.pickup_rider_id) {
    await q.run(`UPDATE orders SET pickup_rider_id=NULL, pickup_attempts=pickup_attempts+1, needs_reschedule='pickup', updated_at=? WHERE id=?`, nowIso(), o.id);
    await addEvent(o.id, 'accepted', `Pickup attempt failed: ${reason}`, user.id);
    await notify(o.customer_id, 'We missed you', `${o.pickup_rider_name} couldn't pick up ${o.code} (${reason}). Please choose a new pickup slot.`, o.id);
  } else if (leg === 'delivery' && o.status === 'out_for_delivery') {
    // The laundry goes back to the homemaker until the customer picks a new slot.
    await q.run(`UPDATE orders SET status='ready', delivery_rider_id=NULL, delivery_attempts=delivery_attempts+1, needs_reschedule='delivery', updated_at=? WHERE id=?`, nowIso(), o.id);
    await addEvent(o.id, 'ready', `Delivery attempt failed: ${reason}. Returned to ${o.provider_name}`, user.id);
    await notify(o.customer_id, 'We missed you', `${o.delivery_rider_name} couldn't deliver ${o.code} (${reason}). Please choose a new delivery slot.`, o.id);
    if (o.provider_user_id !== user.id) await notify(o.provider_user_id, 'Delivery failed', `${o.code} is coming back to you until the customer reschedules.`, o.id);
  } else {
    fail(400, 'There is no visit in progress for this job');
  }
  for (const id of await adminIds()) await notify(id, `Failed ${leg} on ${o.code}`, reason, o.id);
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/rider/location', ['rider'], async ({ user, body }) => {
  const lat = num(body.lat, 'Latitude', -90, 90);
  const lng = num(body.lng, 'Longitude', -180, 180);
  await q.run('UPDATE riders SET lat=?, lng=?, location_at=? WHERE user_id=?', lat, lng, nowIso(), user.id);
});

route('PATCH', '/api/rider/profile', ['rider'], async ({ user, body }) => {
  const r = (await riderOf(user)) || fail(404, 'Delivery partner profile missing');
  if (body.online && !r.verified) fail(403, 'Your account is waiting for admin verification');
  if (body.online === false && (await activeLegs(user.id)) > 0) fail(400, 'Finish or drop your current jobs before going offline');
  await q.run('UPDATE riders SET area=?, vehicle=?, online=? WHERE id=?',
    body.area !== undefined ? str(body.area, 'Area', 60) : r.area,
    body.vehicle !== undefined ? str(body.vehicle, 'Vehicle', 30) : r.vehicle,
    body.online !== undefined ? (body.online ? 1 : 0) : r.online,
    r.id);
  return publicUser(user);
});

// Money a partner owes the platform (cash in hand) and is owed by it (fees and laundry share).
const SETTLEMENT_SQL = `
  SELECT u.id, u.name, u.role, u.phone,
    (SELECT COALESCE(SUM(final_price + delivery_fee),0)::float FROM orders WHERE collected_by=u.id AND payment_method='cash' AND cash_settled=0) AS cash_in_hand,
    (SELECT COUNT(*)::int FROM orders WHERE pickup_rider_id=u.id AND picked_up_at IS NOT NULL AND pickup_leg_settled=0)
      + (SELECT COUNT(*)::int FROM orders WHERE delivery_rider_id=u.id AND delivered_at IS NOT NULL AND delivery_leg_settled=0) AS legs_due,
    (SELECT COALESCE(SUM(o.final_price),0)::float FROM orders o JOIN providers p ON p.id=o.provider_id
      WHERE p.user_id=u.id AND o.status='delivered' AND o.provider_paid=0) AS laundry_due
  FROM users u`;
function settlementView(s) {
  const earnings = money(s.legs_due * RIDER_FEE + s.laundry_due * (1 - COMMISSION));
  return { ...s, cash_in_hand: money(s.cash_in_hand), earnings_due: earnings, net: money(earnings - s.cash_in_hand) };
}

route('GET', '/api/rider/stats', ['rider'], async ({ user }) => {
  const today = localDate();
  const legs = await q.all(`SELECT picked_up_at AS at FROM orders WHERE pickup_rider_id=? AND picked_up_at IS NOT NULL
                            UNION ALL SELECT delivered_at FROM orders WHERE delivery_rider_id=? AND delivered_at IS NOT NULL`, user.id, user.id);
  const s = settlementView(await q.get(`${SETTLEMENT_SQL} WHERE u.id=?`, user.id));
  return {
    active: await activeLegs(user.id),
    legs_total: legs.length,
    legs_today: legs.filter((l) => localDate(new Date(l.at)) === today).length,
    earnings_today: legs.filter((l) => localDate(new Date(l.at)) === today).length * RIDER_FEE,
    earnings_total: legs.length * RIDER_FEE,
    cash_in_hand: s.cash_in_hand,
    earnings_due: s.earnings_due,
    net: s.net,
    rider_fee: RIDER_FEE,
  };
});

route('GET', '/api/provider/stats', ['provider'], async ({ user }) => {
  const pid = (await providerOf(user))?.id ?? -1;
  const today = localDate();
  const delivered = await q.all(`SELECT final_price, delivered_at, updated_at FROM orders WHERE provider_id=? AND status='delivered'`, pid);
  const earn = (rows) => money(rows.reduce((s, r) => s + (r.final_price || 0), 0) * (1 - COMMISSION));
  const s = settlementView(await q.get(`${SETTLEMENT_SQL} WHERE u.id=?`, user.id));
  return {
    active: (await q.get(`SELECT COUNT(*)::int AS n FROM orders WHERE provider_id=? AND status NOT IN ('delivered','cancelled')`, pid)).n,
    completed: delivered.length,
    earnings_total: earn(delivered),
    earnings_today: earn(delivered.filter((r) => localDate(new Date(r.delivered_at || r.updated_at)) === today)),
    payout_due: s.earnings_due,
    cash_in_hand: s.cash_in_hand,
    rating: await q.get('SELECT ROUND(AVG(rating)::numeric,1)::float AS r, COUNT(rating)::int AS n FROM orders WHERE provider_id=? AND rating IS NOT NULL', pid),
    commission: COMMISSION,
  };
});

route('PATCH', '/api/provider/profile', ['provider'], async ({ user, body }) => {
  const p = (await providerOf(user)) || fail(404, 'Provider profile missing');
  await q.run('UPDATE providers SET business_name=?, area=?, address=?, bio=?, accepting=? WHERE id=?',
    body.business_name !== undefined ? str(body.business_name, 'Business name', 80) : p.business_name,
    body.area !== undefined ? str(body.area, 'Service area', 60) : p.area,
    body.address !== undefined ? optStr(body.address) : p.address,
    body.bio !== undefined ? optStr(body.bio) : p.bio,
    body.accepting !== undefined ? (body.accepting ? 1 : 0) : p.accepting,
    p.id);
  return publicUser(user);
});

// --- admin ---
route('POST', '/api/orders/:id/assign', ['admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (!['booked', 'accepted'].includes(o.status)) fail(400, 'Orders can only be reassigned before pickup');
  const p = (await q.get('SELECT p.* FROM providers p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.verified=1 AND u.active=1', Number(body.provider_id) || 0))
    || fail(400, 'Choose a verified, active provider');
  if (p.id === o.provider_id) fail(400, 'Already assigned to this provider');
  const previous = o.provider_user_id;
  // A provider doing their own pickup loses it when the order moves.
  const clearSelf = o.pickup_rider_id && o.pickup_rider_id === previous ? ', pickup_rider_id=NULL' : '';
  await q.run(`UPDATE orders SET provider_id=?, status='accepted', updated_at=?${clearSelf} WHERE id=?`, p.id, nowIso(), o.id);
  await addEvent(o.id, 'accepted', `Assigned to ${p.business_name} by support`, user.id);
  await notify(p.user_id, 'Order assigned to you', `${o.code}: pickup ${slotText(o.pickup_date, o.pickup_slot)} in ${o.area}.`, o.id);
  if (previous) await notify(previous, 'Order reassigned', `${o.code} was moved to another provider.`, o.id);
  await notify(o.customer_id, `${p.business_name} will handle your order`, `Pickup ${slotText(o.pickup_date, o.pickup_slot)}.`, o.id);
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/orders/:id/assign-rider', ['admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  const leg = o.status === 'accepted' ? 'pickup' : o.status === 'ready' ? 'delivery' : fail(400, 'A rider can be assigned while the order waits for pickup or delivery');
  const r = (await q.get(`SELECT r.*, u.name FROM riders r JOIN users u ON u.id=r.user_id WHERE r.user_id=? AND r.verified=1 AND u.active=1`, Number(body.rider_user_id) || 0))
    || fail(400, 'Choose a verified, active delivery partner');
  const previous = o[`${leg}_rider_id`];
  if (previous === r.user_id) fail(400, 'Already assigned to this delivery partner');
  await q.run(`UPDATE orders SET ${leg}_rider_id=?, needs_reschedule=NULL, updated_at=? WHERE id=?`, r.user_id, nowIso(), o.id);
  await addEvent(o.id, o.status, `${r.name} assigned to ${leg} by support`, user.id);
  const when = leg === 'pickup' ? slotText(o.pickup_date, o.pickup_slot) : slotText(o.delivery_date, o.delivery_slot);
  await notify(r.user_id, `${leg === 'pickup' ? 'Pickup' : 'Delivery'} job assigned to you`, `${o.code}: ${when}.`, o.id);
  if (previous) await notify(previous, 'Job reassigned', `${o.code} was given to another delivery partner.`, o.id);
  await notify(o.customer_id, `${r.name} will ${leg === 'pickup' ? 'pick up' : 'deliver'} your order`, when, o.id);
  return orderView(await getOrder(o.id), user);
});

route('POST', '/api/orders/:id/paid', ['admin'], async ({ user, params, body }) => {
  const o = await loadOrderFor(params.id, user);
  if (o.status === 'cancelled' || o.final_price == null) fail(400, 'Nothing to collect yet');
  if (o.payment_status === 'paid') fail(400, 'Already paid');
  await q.run(`UPDATE orders SET payment_status='paid', payment_method=?, updated_at=? WHERE id=?`, body.method === 'cash' ? 'cash' : 'upi', nowIso(), o.id);
  await addEvent(o.id, o.status, `Payment of ₹${money(o.final_price + o.delivery_fee)} recorded by support`, user.id);
  await notify(o.customer_id, 'Payment received', `₹${money(o.final_price + o.delivery_fee)} for ${o.code}. Thank you!`, o.id);
  return orderView(await getOrder(o.id), user);
});

route('GET', '/api/admin/stats', ['admin'], async () => {
  const today = localDate();
  const byStatus = Object.fromEntries((await q.all('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status')).map((r) => [r.status, r.n]));
  const d = await q.get(`SELECT COALESCE(SUM(final_price),0)::float AS gmv, COALESCE(SUM(delivery_fee),0)::float AS fees,
      (COUNT(*) FILTER (WHERE pickup_rider_id IS NOT NULL) + COUNT(*) FILTER (WHERE delivery_rider_id IS NOT NULL))::int AS legs
    FROM orders WHERE status='delivered'`);
  const all = await q.all('SELECT created_at FROM orders');
  const count = async (sql) => (await q.get(sql)).n;
  return {
    byStatus,
    total: all.length,
    today: all.filter((r) => localDate(new Date(r.created_at)) === today).length,
    active: await count(`SELECT COUNT(*)::int AS n FROM orders WHERE status NOT IN ('delivered','cancelled')`),
    unassigned: byStatus.booked || 0,
    needs_rider: await count(`SELECT COUNT(*)::int AS n FROM orders WHERE needs_reschedule IS NULL AND ((status='accepted' AND pickup_rider_id IS NULL) OR (status='ready' AND delivery_rider_id IS NULL))`),
    needs_reschedule: await count(`SELECT COUNT(*)::int AS n FROM orders WHERE needs_reschedule IS NOT NULL AND status NOT IN ('cancelled','delivered')`),
    open_issues: await count(`SELECT COUNT(*)::int AS n FROM issues WHERE status='open'`),
    gmv: money(d.gmv + d.fees),
    platform_revenue: money(d.gmv * COMMISSION + d.fees - d.legs * RIDER_FEE),
    cash_with_partners: money(await count(`SELECT COALESCE(SUM(final_price + delivery_fee),0)::float AS n FROM orders WHERE payment_method='cash' AND cash_settled=0 AND collected_by IS NOT NULL`)),
    customers: await count(`SELECT COUNT(*)::int AS n FROM users WHERE role='customer'`),
    providers_verified: await count('SELECT COUNT(*)::int AS n FROM providers WHERE verified=1'),
    providers_pending: await count('SELECT COUNT(*)::int AS n FROM providers WHERE verified=0'),
    riders_online: await count('SELECT COUNT(*)::int AS n FROM riders WHERE verified=1 AND online=1'),
    riders_verified: await count('SELECT COUNT(*)::int AS n FROM riders WHERE verified=1'),
    riders_pending: await count('SELECT COUNT(*)::int AS n FROM riders WHERE verified=0'),
    avg_rating: (await q.get('SELECT ROUND(AVG(rating)::numeric,1)::float AS r FROM orders WHERE rating IS NOT NULL')).r,
    commission: COMMISSION,
    rider_fee: RIDER_FEE,
  };
});

route('GET', '/api/admin/providers', ['admin'], () => q.all(`
  SELECT p.*, u.name AS owner_name, u.email, u.phone, u.active, ${RATING_SQL} AS rating,
         (SELECT COUNT(*)::int FROM orders WHERE provider_id=p.id AND status='delivered') AS completed,
         (SELECT COUNT(*)::int FROM orders WHERE provider_id=p.id AND status NOT IN ('delivered','cancelled')) AS active_orders
  FROM providers p JOIN users u ON u.id=p.user_id ORDER BY p.verified, p.id DESC`));

route('PATCH', '/api/admin/providers/:id', ['admin'], async ({ params, body }) => {
  const p = (await q.get('SELECT * FROM providers WHERE id=?', Number(params.id) || 0)) || fail(404, 'Provider not found');
  const verified = body.verified ? 1 : 0;
  await q.run('UPDATE providers SET verified=? WHERE id=?', verified, p.id);
  await notify(p.user_id, verified ? "You're verified!" : 'Verification removed',
    verified ? 'You can now accept pickup requests on LaundryLoop.' : 'Contact support to restore your provider account.');
  return { ok: true };
});

route('GET', '/api/admin/riders', ['admin'], () => q.all(`
  SELECT r.*, u.name, u.email, u.phone, u.active,
    (SELECT COUNT(*)::int FROM orders WHERE (pickup_rider_id=u.id AND status IN ('accepted','picked_up')) OR (delivery_rider_id=u.id AND status IN ('ready','out_for_delivery'))) AS active_jobs,
    (SELECT COUNT(*)::int FROM orders WHERE pickup_rider_id=u.id AND picked_up_at IS NOT NULL)
      + (SELECT COUNT(*)::int FROM orders WHERE delivery_rider_id=u.id AND delivered_at IS NOT NULL) AS legs_done,
    (SELECT COALESCE(SUM(final_price + delivery_fee),0)::float FROM orders WHERE collected_by=u.id AND payment_method='cash' AND cash_settled=0) AS cash_in_hand
  FROM riders r JOIN users u ON u.id=r.user_id ORDER BY r.verified, r.online DESC, r.id DESC`));

route('PATCH', '/api/admin/riders/:id', ['admin'], async ({ params, body }) => {
  const r = (await q.get('SELECT * FROM riders WHERE id=?', Number(params.id) || 0)) || fail(404, 'Delivery partner not found');
  const verified = body.verified ? 1 : 0;
  await q.run(`UPDATE riders SET verified=?${verified ? '' : ', online=0'} WHERE id=?`, verified, r.id);
  await notify(r.user_id, verified ? "You're verified!" : 'Verification removed',
    verified ? 'Go online in the app to start taking pickup and delivery jobs.' : 'Contact support to restore your account.');
  return { ok: true };
});

route('GET', '/api/admin/users', ['admin'], async ({ query }) => {
  const role = ['customer', 'provider', 'rider', 'admin'].includes(query.get('role')) ? query.get('role') : 'customer';
  return q.all(`SELECT u.id, u.role, u.name, u.email, u.phone, u.active, u.created_at,
                  (SELECT COUNT(*)::int FROM orders WHERE customer_id=u.id) AS orders,
                  (SELECT COALESCE(SUM(final_price + delivery_fee),0)::float FROM orders WHERE customer_id=u.id AND status='delivered') AS spent
                FROM users u WHERE u.role=? ORDER BY u.id DESC`, role);
});

route('PATCH', '/api/admin/users/:id', ['admin'], async ({ user, params, body }) => {
  const target = (await q.get('SELECT * FROM users WHERE id=?', Number(params.id) || 0)) || fail(404, 'User not found');
  if (target.id === user.id) fail(400, "You can't suspend yourself");
  await q.run('UPDATE users SET active=? WHERE id=?', body.active ? 1 : 0, target.id);
  if (!body.active) {
    await q.run('DELETE FROM sessions WHERE user_id=?', target.id);
    await q.run('UPDATE riders SET online=0 WHERE user_id=?', target.id);
  }
  return { ok: true };
});

route('GET', '/api/admin/issues', ['admin'], async ({ query }) => q.all(`
  SELECT i.*, o.code, o.status AS order_status, u.name AS raised_by_name, u.role AS raised_by_role, c.name AS customer_name
  FROM issues i JOIN orders o ON o.id=i.order_id LEFT JOIN users u ON u.id=i.raised_by JOIN users c ON c.id=o.customer_id
  ${query.get('status') === 'all' ? '' : "WHERE i.status='open'"} ORDER BY i.status, i.id DESC LIMIT 200`));

route('PATCH', '/api/admin/issues/:id', ['admin'], async ({ params, body }) => {
  const i = (await q.get('SELECT * FROM issues WHERE id=?', Number(params.id) || 0)) || fail(404, 'Issue not found');
  if (i.status === 'resolved') fail(400, 'Already resolved');
  const resolution = str(body.resolution, 'Resolution', 1000);
  const refund = body.refund_amount ? num(body.refund_amount, 'Refund', 0, 100000) : null;
  await q.run(`UPDATE issues SET status='resolved', resolution=?, refund_amount=?, resolved_at=? WHERE id=?`, resolution, refund, nowIso(), i.id);
  const o = await getOrder(i.order_id);
  await addEvent(o.id, o.status, `Issue resolved: ${resolution}${refund ? ` · refund ₹${money(refund)}` : ''}`, null);
  await notify(o.customer_id, `Update on your ${ISSUE_TYPES[i.type].toLowerCase()} report`, `${resolution}${refund ? ` Refund: ₹${money(refund)}.` : ''}`, o.id);
  await touch(o.id);
  return { ok: true };
});

route('GET', '/api/admin/settlements', ['admin'], async () => (await q.all(`${SETTLEMENT_SQL} WHERE u.role IN ('rider','provider')`))
  .map(settlementView).filter((s) => s.cash_in_hand || s.earnings_due)
  .sort((a, b) => Math.abs(b.net) - Math.abs(a.net)));

// Cash collected and earnings owed are squared up in one go, as a weekly payout would.
route('POST', '/api/admin/settlements/:userId', ['admin'], async ({ params }) => {
  const uid = Number(params.userId) || 0;
  const s = settlementView((await q.get(`${SETTLEMENT_SQL} WHERE u.id=?`, uid)) || fail(404, 'Partner not found'));
  await q.run(`UPDATE orders SET cash_settled=1 WHERE collected_by=? AND payment_method='cash' AND cash_settled=0`, uid);
  await q.run(`UPDATE orders SET pickup_leg_settled=1 WHERE pickup_rider_id=? AND picked_up_at IS NOT NULL`, uid);
  await q.run(`UPDATE orders SET delivery_leg_settled=1 WHERE delivery_rider_id=? AND delivered_at IS NOT NULL`, uid);
  await q.run(`UPDATE orders o SET provider_paid=1 FROM providers p WHERE p.id=o.provider_id AND p.user_id=? AND o.status='delivered'`, uid);
  const msg = s.net >= 0 ? `₹${s.net} paid to you.` : `₹${-s.net} cash handed in.`;
  await notify(uid, 'Settlement done', `${msg} Earnings ₹${s.earnings_due}, cash collected ₹${s.cash_in_hand}.`);
  return s;
});

route('POST', '/api/admin/services', ['admin'], async ({ body }) => {
  const name = str(body.name, 'Name', 40);
  const price = num(body.price_per_kg, 'Price per kg', 1, 2000);
  const wanted = Array.isArray(body.steps) ? body.steps : [];
  const processing = ['washing', 'drying', 'ironing'].filter((s) => wanted.includes(s));
  if (!processing.length) fail(400, 'Pick at least one processing step');
  const steps = ['picked_up', 'at_provider', ...processing, 'ready', 'out_for_delivery', 'delivered'];
  const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Date.now().toString(36);
  await q.run('INSERT INTO services (code,name,description,price_per_kg,steps) VALUES (?,?,?,?,?)', code, name, optStr(body.description), price, JSON.stringify(steps));
  return { ok: true };
});

route('PATCH', '/api/admin/services/:id', ['admin'], async ({ params, body }) => {
  const s = (await q.get('SELECT * FROM services WHERE id=?', Number(params.id) || 0)) || fail(404, 'Service not found');
  await q.run('UPDATE services SET name=?, description=?, price_per_kg=?, active=? WHERE id=?',
    body.name !== undefined ? str(body.name, 'Name', 40) : s.name,
    body.description !== undefined ? optStr(body.description) : s.description,
    body.price_per_kg !== undefined ? num(body.price_per_kg, 'Price per kg', 1, 2000) : s.price_per_kg,
    body.active !== undefined ? (body.active ? 1 : 0) : s.active,
    s.id);
  return { ok: true };
});

// --- presentation decks (hidden /present page), shared across the admin's devices ---
// Vercel caps a request or response at ~4.5 MB, so files move in DECK_CHUNK pieces.
const DECK_CHUNK = 3 * 1024 * 1024;
const DECK_MAX = 80 * 1024 * 1024;
const RAW_LIMIT = DECK_CHUNK + 1024;
const deckRow = (d) => ({ ...d, files: JSON.parse(d.files), size: Number(d.size) });
async function loadDeck(id) {
  const d = await q.get('SELECT * FROM decks WHERE id=?', Number(id));
  if (!d) fail(404, 'Deck not found');
  return deckRow(d);
}

route('GET', '/api/decks', ['admin'], async () => ({
  chunkSize: DECK_CHUNK,
  decks: (await q.all('SELECT * FROM decks WHERE complete=1 ORDER BY created_at DESC')).map(deckRow),
}));

route('POST', '/api/decks', ['admin'], async ({ user, body }) => {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) fail(400, 'Name the deck');
  if (!['pptx', 'pdf', 'image'].includes(body.kind)) fail(400, 'Upload a .pptx, .pdf or images');
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 200).map((f) => ({
    name: String(f.name || 'file').slice(0, 200), type: String(f.type || '').slice(0, 100), size: Math.round(num(f.size, 'File size', 1, DECK_MAX)),
  }));
  if (!files.length) fail(400, 'No files');
  files.forEach((f) => { f.chunks = Math.ceil(f.size / DECK_CHUNK); });
  const size = files.reduce((t, f) => t + f.size, 0);
  if (size > DECK_MAX) fail(413, `Decks can be up to ${DECK_MAX / 1048576} MB`);
  const cover = typeof body.cover === 'string' && body.cover.startsWith('data:image/') && body.cover.length < 300000 ? body.cover : null;
  // Uploads abandoned for a day are cleared out.
  await q.run('DELETE FROM decks WHERE complete=0 AND created_at < ?', new Date(Date.now() - 864e5).toISOString());
  const now = nowIso();
  const d = await q.get(`INSERT INTO decks (name,kind,files,size,slides,cover,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`,
    name, body.kind, JSON.stringify(files), size, Math.round(num(body.slides, 'Slides', 1, 5000)), cover, user.id, now, now);
  return { ...deckRow(d), chunkSize: DECK_CHUNK };
});

route('PUT', '/api/decks/:id/files/:f/chunks/:n', ['admin'], async ({ params, body }) => {
  const d = await loadDeck(params.id);
  if (d.complete) fail(409, 'This deck is already uploaded');
  const f = Number(params.f), n = Number(params.n);
  const file = d.files[f];
  if (!file || !Number.isInteger(n) || n < 0 || n >= file.chunks) fail(400, 'Unknown chunk');
  const want = n === file.chunks - 1 ? file.size - n * DECK_CHUNK : DECK_CHUNK;
  if (body.length !== want) fail(400, `Chunk should be ${want} bytes, got ${body.length}`);
  await q.run(`INSERT INTO deck_chunks (deck_id,file_idx,idx,data) VALUES (?,?,?,?)
               ON CONFLICT (deck_id,file_idx,idx) DO UPDATE SET data=EXCLUDED.data`, d.id, f, n, body);
}, { raw: true });

route('POST', '/api/decks/:id/complete', ['admin'], async ({ params }) => {
  const d = await loadDeck(params.id);
  const have = await q.get('SELECT COUNT(*)::int AS c FROM deck_chunks WHERE deck_id=?', d.id);
  const want = d.files.reduce((t, f) => t + f.chunks, 0);
  if (have.c !== want) fail(409, `Upload incomplete: ${have.c} of ${want} parts arrived`);
  await q.run('UPDATE decks SET complete=1, updated_at=? WHERE id=?', nowIso(), d.id);
  return loadDeck(d.id);
});

route('GET', '/api/decks/:id/files/:f/chunks/:n', ['admin'], async ({ params }) => {
  const c = await q.get('SELECT data FROM deck_chunks WHERE deck_id=? AND file_idx=? AND idx=?', Number(params.id), Number(params.f), Number(params.n));
  if (!c) fail(404, 'Chunk not found');
  return Buffer.from(c.data);
});

route('PATCH', '/api/decks/:id', ['admin'], async ({ params, body }) => {
  const d = await loadDeck(params.id);
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) fail(400, 'Name the deck');
  await q.run('UPDATE decks SET name=?, updated_at=? WHERE id=?', name, nowIso(), d.id);
  return loadDeck(d.id);
});

route('DELETE', '/api/decks/:id', ['admin'], async ({ params }) => {
  await q.run('DELETE FROM decks WHERE id=?', Number(params.id));
});

// ---------- HTTP plumbing ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > RAW_LIMIT) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // On Vercel the original path arrives as ?__path=... after the rewrite.
  if (url.searchParams.has('__path')) {
    url.pathname = '/api/' + url.searchParams.get('__path');
    url.searchParams.delete('__path');
  }
  try {
    let match = null;
    let r = null;
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      match = candidate.re.exec(url.pathname);
      if (match) { r = candidate; break; }
    }
    if (!r) fail(404, 'Not found');
    await init();
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    const user = await userFromToken(token);
    if (r.roles) {
      if (!user) fail(401, 'Please sign in');
      if (r.roles !== ANY && !r.roles.includes(user.role)) fail(403, 'Not allowed');
    }
    const body = req.method === 'GET' ? {} : r.raw ? await readRaw(req) : await readJson(req);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const result = await r.handler({ req, user, token, body, params, query: url.searchParams });
    if (Buffer.isBuffer(result)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': result.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
      return res.end(result);
    }
    sendJson(res, 200, result ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
    else { console.error(e); sendJson(res, 500, { error: 'Something went wrong' }); }
  }
}

module.exports = { handleApi, init };
