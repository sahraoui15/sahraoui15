const express = require('express');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2; // reads CLOUDINARY_URL automatically
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const fs = require('fs');

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(f.mimetype)) });
const SECRET = process.env.TOKEN_SECRET || 'change-me';
const clean = (v, n) => String(v || '').trim().slice(0, n);
const FEES = { home: 600, desk: 400 }; // delivery fees in DA (edit here and in index.html)

const TZ = 3600e3; // Algeria = UTC+1 (no daylight saving)
const dayOf = ts => new Date(ts + TZ).toISOString().slice(0, 10);          // "2026-11-07"
const dayStart = day => Date.parse(day + 'T00:00:00Z') - TZ;
let lastStamp = 0; // every order gets a different timestamp, so paging through a busy day never skips one
const stamp = () => { const n = Date.now(); lastStamp = n > lastStamp ? n : lastStamp + 1; return lastStamp; };
const acceptsGzip = req => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

const hmac = p => crypto.createHmac('sha256', SECRET).update(p).digest('hex');
const sign = () => { const p = String(Date.now() + 7 * 864e5); return p + '.' + hmac(p); };
const auth = (req, res, next) => {
  const [p, h] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (p && h && +p > Date.now() && h === hmac(p)) return next();
  res.status(401).json({ error: 'unauthorized' });
};
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'server' }); });

/* =====================================================================
   DAILY SUMMARIES  (one small document per day, kept in memory too)
   -> the admin panel and the statistics never have to read all orders
   ===================================================================== */
// ---- DAILY-START
const emptyD = () => ({ orders: 0, revenue: 0, pending: 0, shipped: 0, delivered: 0, cancelled: 0, unreviewed: 0, w: {}, t: {} });
const SAFE = { '.': '․', '/': '∕', '[': '［', ']': '］', '*': '＊', '`': 'ˋ', '~': '～' };
const sk = s => String(s || '-').replace(/[.\/\[\]*`~]/g, c => SAFE[c]).slice(0, 80) || '-';
// what one order adds to its day
const contrib = o => {
  const c = emptyD(), live = o.status !== 'cancelled';
  c.orders = 1;
  if (typeof c[o.status] === 'number') c[o.status] = 1;
  c.unreviewed = (!o.reviewed && live) ? 1 : 0;
  if (live) {
    c.revenue = typeof o.subtotal === 'number' ? o.subtotal : (o.total || 0) - (o.fee || 0); // products only, no delivery fee
    c.w[sk(o.wilaya)] = 1;
    (o.items || []).forEach(i => { const k = sk(i.name); c.t[k] = (c.t[k] || 0) + (i.qty || 0); });
  }
  return c;
};
const addD = (a, b, s) => {
  for (const k in b) {
    const v = b[k];
    if (v && typeof v === 'object') { a[k] = a[k] || {}; addD(a[k], v, s); }
    else a[k] = (a[k] || 0) + s * v;
  }
  return a;
};
const toInc = o => {
  const out = {};
  for (const k in o) {
    const v = o[k];
    if (typeof v === 'number') { if (v) out[k] = admin.firestore.FieldValue.increment(v); }
    else if (v && typeof v === 'object') { const c = toInc(v); if (Object.keys(c).length) out[k] = c; }
  }
  return out;
};
// ---- DAILY-END

let mirror = {};   // day -> summary (memory copy)
let pend = {};     // day -> changes not yet written to Firestore
let dTimer = null;
async function flushDaily() {
  const p = pend; pend = {};
  for (const day in p) {
    const payload = toInc(p[day]);
    if (!Object.keys(payload).length) continue;
    try { await db.collection('daily').doc(day).set(payload, { merge: true }); }
    catch (e) { console.error('daily flush failed:', e.message); addD(pend[day] = pend[day] || emptyD(), p[day], 1); schedFlush(); }
  }
}
function schedFlush() { if (!dTimer) dTimer = setTimeout(() => { dTimer = null; flushDaily(); }, 2000); }
function bump(day, diff) {
  addD(mirror[day] = mirror[day] || emptyD(), diff, 1);
  addD(pend[day] = pend[day] || emptyD(), diff, 1);
  schedFlush();
}
async function loadDaily() {
  const s = await db.collection('daily').get(), m = {};
  s.forEach(d => { m[d.id] = Object.assign(emptyD(), d.data()); });
  mirror = m;
}
// Rebuild every summary from the real orders (runs once automatically on first start, or from the admin button)
async function rebuildDaily() {
  const agg = {}; let last = null, n = 0;
  for (;;) {
    let q = db.collection('orders').orderBy('createdAt').limit(500);
    if (last) q = q.startAfter(last);
    const s = await q.get();
    if (s.empty) break;
    s.forEach(d => { const o = d.data(); addD(agg[dayOf(o.createdAt)] = agg[dayOf(o.createdAt)] || emptyD(), contrib(o), 1); n++; });
    last = s.docs[s.docs.length - 1];
    if (s.size < 500) break;
  }
  let batch = db.batch(), c = 0;
  const commit = async () => { if (c) { await batch.commit(); batch = db.batch(); c = 0; } };
  const old = await db.collection('daily').get();
  for (const d of old.docs) { if (!agg[d.id]) { batch.delete(d.ref); if (++c >= 400) await commit(); } }
  for (const day in agg) { batch.set(db.collection('daily').doc(day), agg[day]); if (++c >= 400) await commit(); }
  await commit();
  mirror = agg; pend = {};
  return n;
}

/* visits: counted in memory, written to Firestore every 30 s */
let visitsM = {}, visitBuf = {};
async function flushVisits() {
  const b = visitBuf; visitBuf = {};
  for (const day in b) {
    try { await db.collection('visits').doc(day).set({ count: admin.firestore.FieldValue.increment(b[day]) }, { merge: true }); }
    catch (e) { console.error('visit flush failed:', e.message); visitBuf[day] = (visitBuf[day] || 0) + b[day]; }
  }
}
async function loadVisits() {
  const s = await db.collection('visits').get(), m = {};
  s.forEach(d => { m[d.id] = d.data().count || 0; });
  visitsM = m;
}

/* =====================================================================
   PRODUCTS CACHE (so 100,000 visitors do NOT mean 100,000 database reads)
   ===================================================================== */
let PC = null, PC_LOADING = null;
const PAGES = new Map();
const invalidate = () => { PC = null; PAGES.clear(); };
function getProducts() {
  if (PC && Date.now() - PC.at < 6 * 3600e3) return Promise.resolve(PC);
  if (!PC_LOADING) {
    PC_LOADING = db.collection('products').orderBy('createdAt', 'desc').get().then(s => {
      const list = s.docs.map(d => ({ id: d.id, ...d.data() })), json = JSON.stringify(list);
      PC = { list, map: new Map(list.map(p => [p.id, p])), json, gz: zlib.gzipSync(json),
        etag: '"' + crypto.createHash('md5').update(json).digest('hex') + '"', at: Date.now() };
      return PC;
    }).finally(() => { PC_LOADING = null; });
  }
  return PC_LOADING;
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=15552000',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://res.cloudinary.com; connect-src 'self'; frame-ancestors 'none'"
  });
  next();
});

// Only index.html is public. server.js and package.json are NOT exposed.
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), INDEX_GZ = zlib.gzipSync(INDEX);
function sendHTML(req, res, html, gz) {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Vary': 'Accept-Encoding' });
  if (gz && acceptsGzip(req)) { res.set('Content-Encoding', 'gzip'); return res.send(gz); }
  res.send(html);
}
app.get('/', (req, res) => sendHTML(req, res, INDEX, INDEX_GZ));

// Each product has its own shareable link: /p/<id>  (with preview for Facebook / WhatsApp)
const attr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/p/:id', async (req, res) => {
  const key = req.params.id + '|' + req.protocol + '|' + req.get('host');
  let pg = PAGES.get(key);
  if (!pg) {
    let html = INDEX, found = false;
    try {
      const p = (await getProducts()).map.get(req.params.id);
      if (p) {
        found = true;
        const url = `${req.protocol}://${req.get('host')}/p/${req.params.id}`;
        const desc = p.description || `${p.price} DA - ABDmoteurs`, og = (p.images && p.images[0]) || p.image;
        html = html.replace('<title>ABDmoteurs</title>', `<title>${attr(p.name)} | ABDmoteurs</title>`).replace('<!--OG-->',
          `<meta property="og:type" content="product"><meta property="og:site_name" content="ABDmoteurs"><meta property="og:title" content="${attr(p.name)}"><meta property="og:description" content="${attr(desc)}"><meta property="og:url" content="${attr(url)}">` +
          (og ? `<meta property="og:image" content="${attr(og)}"><meta name="twitter:card" content="summary_large_image">` : ''));
      }
    } catch (e) { console.error(e); }
    if (!found) return sendHTML(req, res, INDEX, INDEX_GZ);
    pg = { html, gz: zlib.gzipSync(html) };
    if (PAGES.size >= 200) PAGES.clear();
    PAGES.set(key, pg);
  }
  sendHTML(req, res, pg.html, pg.gz);
});

const fails = new Map(); // simple brute-force protection: 5 wrong tries = 15 min block
app.post('/api/login', (req, res) => {
  const f = fails.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60e3) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 5) return res.status(429).json({ error: 'too many attempts' });
  const a = Buffer.from(String(req.body.password || '')), b = Buffer.from(process.env.ADMIN_PASSWORD || '');
  if (b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)) { fails.delete(req.ip); return res.json({ token: sign() }); }
  f.n++; fails.set(req.ip, f);
  res.status(401).json({ error: 'bad password' });
});

app.get('/api/products', wrap(async (req, res) => {
  const c = await getProducts();
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'ETag': c.etag, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' });
  if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
  if (acceptsGzip(req)) { res.set('Content-Encoding', 'gzip'); return res.send(c.gz); }
  res.send(c.json);
}));

const uploadImg = buf => new Promise((ok, no) =>
  cloudinary.uploader.upload_stream({ folder: 'abdmoteur/products', transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 80 }] }, (e, r) => (e ? no(e) : ok(r.secure_url))).end(buf));
const parseCompat = raw => {
  let c = []; try { c = JSON.parse(raw || '[]'); } catch {}
  return (Array.isArray(c) ? c : []).slice(0, 40)
    .map(x => ({ brand: clean(x && x.brand, 30), model: clean(x && x.model, 40) })).filter(x => x.brand);
};

app.post('/api/products', auth, upload.array('images', 6), wrap(async (req, res) => {
  const { name, price, category, description } = req.body;
  if (!clean(name, 100) || !(+price > 0)) return res.status(400).json({ error: 'invalid' });
  const compat = parseCompat(req.body.compat), universal = req.body.universal === '1';
  if (!universal && !compat.length) return res.status(400).json({ error: 'compat required' });
  const images = await Promise.all((req.files || []).slice(0, 6).map(f => uploadImg(f.buffer))), image = images[0] || '';
  const doc = { name: clean(name, 100), price: +price, category: clean(category, 40), description: clean(description, 600),
    compat, universal, available: req.body.available !== '0', image, images, createdAt: Date.now() };
  const ref = await db.collection('products').add(doc);
  invalidate();
  res.json({ id: ref.id, ...doc });
}));

// Edit a product (full edit from the form, or just {available:true/false} from the quick toggle)
app.patch('/api/products/:id', auth, upload.array('images', 6), wrap(async (req, res) => {
  const b = req.body, upd = {};
  if (b.name !== undefined) { if (!clean(b.name, 100)) return res.status(400).json({ error: 'invalid' }); upd.name = clean(b.name, 100); }
  if (b.price !== undefined) { if (!(+b.price > 0)) return res.status(400).json({ error: 'invalid' }); upd.price = +b.price; }
  if (b.category !== undefined) upd.category = clean(b.category, 40);
  if (b.description !== undefined) upd.description = clean(b.description, 600);
  if (b.available !== undefined) upd.available = b.available === true || b.available === '1' || b.available === 'true';
  if (b.compat !== undefined) {
    const compat = parseCompat(b.compat), universal = b.universal === '1';
    if (!universal && !compat.length) return res.status(400).json({ error: 'compat required' });
    upd.compat = compat; upd.universal = universal;
  }
  const ref = db.collection('products').doc(req.params.id);
  // Photos: 'keep' = existing photo URLs to keep (in order), new files are appended. Max 6 in total.
  if (b.keep !== undefined || (req.files && req.files.length)) {
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not found' });
    const o = snap.data(), oldImgs = o.images && o.images.length ? o.images : (o.image ? [o.image] : []);
    let keep = oldImgs;
    if (b.keep !== undefined) {
      let k = []; try { k = JSON.parse(b.keep); } catch {}
      keep = [...new Set(Array.isArray(k) ? k : [])].filter(u => oldImgs.includes(u));
    }
    const files = (req.files || []).slice(0, Math.max(0, 6 - keep.length));
    const added = await Promise.all(files.map(f => uploadImg(f.buffer)));
    upd.images = [...keep, ...added]; upd.image = upd.images[0] || '';
  }
  if (!Object.keys(upd).length) return res.status(400).json({ error: 'invalid' });
  await ref.update(upd);
  invalidate();
  res.json({ ok: true });
}));

app.delete('/api/products/:id', auth, wrap(async (req, res) => {
  await db.collection('products').doc(req.params.id).delete();
  invalidate();
  res.json({ ok: true });
}));

/* ---------------------------- ORDERS ---------------------------- */
const PHONE_DAILY_MAX = 10;  // max orders per phone number per day   <- change this number if you want
const IP_HOURLY_MAX = 300;   // very high safety ceiling per network (many phones in Algeria share one IP)
const phoneDay = new Map();  // phone -> {day, n}
const ordRate = new Map();   // ip -> {n, t}
const recent = new Map();    // phone + basket -> {t, id}   (stops double-click duplicates)
// "+213 555 12 34 56", "0555123456" and "00213555123456" are the same phone
const normPhone = p => { let d = String(p).replace(/\D/g, '').replace(/^00/, ''); if (d.startsWith('213')) d = '0' + d.slice(3); return d; };
app.post('/api/orders', wrap(async (req, res) => {
  const { name, phone, wilaya, address, delivery, items, car } = req.body;
  if (!name || !/^[0-9+\s]{9,15}$/.test(phone || '') || !wilaya || !FEES[delivery] || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'invalid' });
  const now = Date.now(), today = dayOf(now);
  let r = ordRate.get(req.ip);
  if (!r || now - r.t > 3600e3) r = { n: 0, t: now };
  if (r.n >= IP_HOURLY_MAX) return res.status(429).json({ error: 'too many' });
  const byId = (await getProducts()).map;
  const lines = []; let subtotal = 0;
  for (const it of items.slice(0, 50)) {
    const p = byId.get(String(it.id));
    const qty = Math.min(Math.max(parseInt(it.qty) || 0, 1), 99);
    if (!p) continue;
    if (p.available === false) return res.status(400).json({ error: 'unavailable', name: p.name });
    subtotal += p.price * qty;
    // full copy of the product as it was when ordered, so the admin knows exactly what to ship
    lines.push({ id: p.id, name: p.name, price: p.price, qty, category: p.category || '', universal: !!p.universal,
      compat: (p.compat || []).slice(0, 40), description: clean(p.description, 600), image: (p.images && p.images[0]) || p.image || '' });
  }
  if (!lines.length) return res.status(400).json({ error: 'empty' });
  const ph = clean(phone, 15), key = normPhone(ph), sig = key + '|' + lines.map(l => l.id + 'x' + l.qty).sort().join(',');
  const dup = recent.get(sig);
  if (dup && now - dup.t < 120e3) return res.json({ id: dup.id });
  let pr = phoneDay.get(key);
  if (!pr || pr.day !== today) pr = { day: today, n: 0 };
  if (pr.n >= PHONE_DAILY_MAX) return res.status(429).json({ error: 'phone limit' });
  pr.n++; phoneDay.set(key, pr); r.n++; ordRate.set(req.ip, r);
  const order = { name: clean(name, 80), phone: ph, wilaya: clean(wilaya, 40), address: clean(address, 160), car: clean(car, 80), delivery,
    items: lines, subtotal, fee: FEES[delivery], total: subtotal + FEES[delivery], status: 'pending', reviewed: false, createdAt: stamp() };
  const ref = db.collection('orders').doc();
  await ref.set(order);
  recent.set(sig, { t: now, id: ref.id });
  bump(dayOf(order.createdAt), contrib(order));
  res.json({ id: ref.id });
}));

// admin: one line per day (counts only) - served from memory, costs no database reads
app.get('/api/orders/days', auth, wrap(async (_, res) => {
  res.json({ days: Object.keys(mirror).filter(d => mirror[d].orders > 0).sort().reverse()
    .map(d => ({ day: d, orders: mirror[d].orders, unreviewed: Math.max(0, mirror[d].unreviewed), revenue: mirror[d].revenue })) });
}));

// admin: the orders of ONE day, 100 at a time (newest first)
app.get('/api/orders', auth, wrap(async (req, res) => {
  const day = String(req.query.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'invalid' });
  const start = dayStart(day), end = start + 864e5, before = +req.query.before || end, LIM = 100;
  const s = await db.collection('orders').where('createdAt', '>=', start).where('createdAt', '<', Math.min(before, end))
    .orderBy('createdAt', 'desc').limit(LIM + 1).get();
  res.json({ orders: s.docs.slice(0, LIM).map(d => ({ id: d.id, ...d.data() })), more: s.docs.length > LIM });
}));

app.patch('/api/orders/:id', auth, wrap(async (req, res) => {
  const upd = {};
  if (req.body.status !== undefined) {
    if (!['pending', 'shipped', 'delivered', 'cancelled'].includes(req.body.status)) return res.status(400).json({ error: 'invalid' });
    upd.status = req.body.status;
  }
  if (req.body.reviewed !== undefined) upd.reviewed = req.body.reviewed === true;
  if (!Object.keys(upd).length) return res.status(400).json({ error: 'invalid' });
  const ref = db.collection('orders').doc(req.params.id);
  const out = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const old = s.data(), d = emptyD();
    tx.update(ref, upd);
    addD(d, contrib({ ...old, ...upd }), 1); addD(d, contrib(old), -1);
    return { day: dayOf(old.createdAt), d };
  });
  if (!out) return res.status(404).json({ error: 'not found' });
  bump(out.day, out.d);
  res.json({ ok: true });
}));

app.post('/api/rebuild', auth, wrap(async (_, res) => {
  const n = await rebuildDaily();
  res.json({ ok: true, orders: n, days: Object.keys(mirror).length });
}));

app.post('/api/visit', (req, res) => {
  const day = dayOf(Date.now());
  visitsM[day] = (visitsM[day] || 0) + 1; visitBuf[day] = (visitBuf[day] || 0) + 1;
  res.json({ ok: true });
});

app.get('/api/stats', auth, wrap(async (_, res) => {
  const ps = (await getProducts()).list;
  const st = { outofstock: ps.filter(p => p.available === false).length, orders: 0, revenue: 0, pending: 0, delivered: 0, cancelled: 0, shipped: 0,
    unreviewed: 0, products: ps.length, visits: 0 };
  const w = {}, t = {}, byDay = {};
  for (const day of Object.keys(mirror).sort()) {
    const m = mirror[day];
    ['orders', 'revenue', 'pending', 'delivered', 'cancelled', 'shipped'].forEach(k => { st[k] += m[k] || 0; });
    st.unreviewed += Math.max(0, m.unreviewed || 0);
    if (m.revenue > 0) byDay[day] = m.revenue;
    for (const k in m.w) w[k] = (w[k] || 0) + m.w[k];
    for (const k in m.t) t[k] = (t[k] || 0) + m.t[k];
  }
  const vDays = Object.keys(visitsM).sort();
  vDays.forEach(d => { st.visits += visitsM[d]; });
  const top = o => Object.fromEntries(Object.entries(o).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 8));
  const last = (o, keys) => Object.fromEntries(keys.slice(-14).map(k => [k, o[k]]));
  res.json({ ...st, top: top(t), byWilaya: top(w), byDay: last(byDay, Object.keys(byDay).sort()), visitsByDay: last(visitsM, vDays) });
}));

// Upload errors (too many files, file too big...) -> clean JSON instead of a crash page
app.use((err, req, res, next) => { console.error(err.message); res.status(400).json({ error: 'upload' }); });

setInterval(() => {
  const n = Date.now();
  for (const [k, v] of fails) if (n - v.t > 15 * 60e3) fails.delete(k);
  for (const [k, v] of ordRate) if (n - v.t > 3600e3) ordRate.delete(k);
  for (const [k, v] of phoneDay) if (v.day !== dayOf(n)) phoneDay.delete(k);
  for (const [k, v] of recent) if (n - v.t > 120e3) recent.delete(k);
}, 10 * 60e3).unref();
setInterval(flushVisits, 30e3).unref();

// save pending counters when Render restarts / stops the server
process.on('SIGTERM', async () => { try { await flushDaily(); await flushVisits(); } catch {} process.exit(0); });

app.listen(process.env.PORT || 3000, () => console.log('ABDmoteurs running'));

// start-up: load the summaries; on the very first start, build them from the existing orders
(async () => {
  try {
    await Promise.all([loadDaily(), loadVisits()]);
    if (!Object.keys(mirror).length) {
      const any = await db.collection('orders').limit(1).get();
      if (!any.empty) { const n = await rebuildDaily(); console.log('daily summaries built from', n, 'orders'); }
    }
  } catch (e) { console.error('start-up load failed:', e.message); }
})();
