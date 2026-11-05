import express from "express";
import admin from "firebase-admin";
import cloudinary from "cloudinary";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

/* ===== الإعدادات (يمكن تغييرها من Render بدون تعديل الكود) ===== */
const SHOP_FEE = Number(env.SHOP_FEE || 5);          // رسوم فتح المحل
const PRODUCT_FEE = Number(env.PRODUCT_FEE || 0.25); // رسوم إضافة منتج (غير قابلة للاسترجاع أبداً)
const REFUND_DEDUCT = Number(env.REFUND_DEDUCT ?? 0.01); // خصم رسوم الشبكة من استرجاع رسوم فتح المحل
const ADMINS = (env.ADMIN_USERNAMES || "").split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const PI_API = "https://api.minepi.com/v2";
const PI_KEY = env.PI_API_KEY;

/* العناوين المسموح لها باستدعاء السيرفر (واجهة GitHub Pages) */
const ORIGINS = (env.ALLOWED_ORIGIN || "https://veoabdo.github.io")
  .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);

/* ===== Firebase ===== */
let serviceAccount;
try {
  serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
} catch (e) {
  console.error("FIREBASE_SERVICE_ACCOUNT غير صالح: تأكد أنه JSON كامل");
  throw e;
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

cloudinary.v2.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET
});

let _pi = null;
function pi() {
  if (!_pi) {
    const m = require("pi-backend");
    const PiNetwork = m.default || m;
    _pi = new PiNetwork(PI_KEY, env.PI_WALLET_SECRET);
  }
  return _pi;
}

/* ===== أدوات مساعدة ===== */

/* استخراج رسالة خطأ آمنة (بدون طباعة كائن axios الذي يحتوي مفاتيح سرية) */
function errInfo(e) {
  const d = e && e.response && e.response.data;
  if (d) return typeof d === "string" ? d : JSON.stringify(d);
  return (e && e.message) || String(e);
}
function friendlyRefundError(msg) {
  if (msg.includes("missing_scope") || msg.includes("wallet_address"))
    return "المستخدم لم يمنح صلاحية wallet_address. يجب أن يفتح التطبيق ويسجّل الدخول من جديد ويوافق على الصلاحية، ثم أعد الاسترجاع.";
  if (msg.includes("insufficient") || msg.includes("balance"))
    return "رصيد محفظة التطبيق غير كافٍ (تذكّر احتياطي الحساب ~1 Pi). اشحن المحفظة ثم أعد المحاولة.";
  if (msg.includes("ongoing_payment"))
    return "توجد دفعة معلّقة لهذا المستخدم. أعد المحاولة بعد قليل.";
  return "فشل الاسترجاع: " + msg.slice(0, 300);
}

const rl = new Map();
function limited(key, max, ms) {
  const now = Date.now();
  const e = rl.get(key) || { c: 0, s: now };
  if (now - e.s > ms) { e.c = 0; e.s = now; }
  e.c++; rl.set(key, e);
  return e.c > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of rl) if (n - v.s > 3600000) rl.delete(k); }, 600000).unref();

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max);
const isImg = u => typeof u === "string" && u.startsWith("https://res.cloudinary.com/");
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error("ERROR", req.method, req.path, errInfo(e)); // لا نطبع e كاملاً أبداً
    if (!res.headersSent) res.status(500).json({ error: errInfo(e).slice(0, 400) });
  }
};

async function auth(req, res) {
  const { accessToken, userUid } = req.body || {};
  if (!accessToken || !userUid) { res.status(400).json({ error: "Missing data" }); return null; }
  if (limited("a_" + userUid, 90, 60000)) { res.status(429).json({ error: "Too many requests" }); return null; }
  const r = await fetch(PI_API + "/me", { headers: { Authorization: "Bearer " + accessToken } });
  if (!r.ok) { res.status(401).json({ error: "Invalid token" }); return null; }
  const u = await r.json();
  if (u.uid !== userUid) { res.status(403).json({ error: "User mismatch" }); return null; }
  u.isAdmin = ADMINS.includes((u.username || "").toLowerCase());
  return u;
}
async function adminOnly(req, res) {
  const u = await auth(req, res);
  if (!u) return null;
  if (!u.isAdmin) { res.status(403).json({ error: "Admins only" }); return null; }
  return u;
}

const pubShop = (id, d) => ({ id, name: d.name, country: d.country, region: d.region, address: d.address, phone: d.phone, hours: d.hours || "", description: d.description || "", image: d.image || "" });
const pubProd = (id, d) => ({ id, name: d.name, brand: d.brand || "", size: d.size || "", price: d.price, currency: d.currency || "", description: d.description || "", image: d.image || "", createdAt: d.createdAt || 0 });

const app = express();
app.disable("x-powered-by");

/* ===== رؤوس أمان أساسية ===== */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ===== CORS: يسمح لواجهة GitHub Pages بالاتصال بهذا السيرفر ===== */
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "6mb" }));

/* ===== عام ===== */
app.get("/", (_, res) => res.send("Parfum API is running"));
app.get("/health", (_, res) => res.json({ ok: true, app: "Parfum" }));

app.get("/api/config", (_, res) => {
  res.json({
    shopFee: SHOP_FEE, productFee: PRODUCT_FEE,
    refundDeduct: REFUND_DEDUCT,
    sandbox: env.PI_SANDBOX === "true"
  });
});

/* المحلات المنشورة مع منتجاتها المنشورة (المحلات قيد المراجعة لا تظهر) */
app.get("/api/shops", wrap(async (_, res) => {
  const [s, p] = await Promise.all([
    db.collection("shops").where("status", "==", "live").get(),
    db.collection("products").where("status", "==", "live").get()
  ]);
  const prods = {};
  p.forEach(d => { const x = d.data(); (prods[x.shopId] = prods[x.shopId] || []).push(pubProd(d.id, x)); });
  const shops = s.docs.map(d => {
    const list = (prods[d.id] || []).sort((a, b) => b.createdAt - a.createdAt);
    return { ...pubShop(d.id, d.data()), products: list };
  });
  res.json({ shops });
}));

/* ===== حساب المستخدم ===== */
app.post("/api/me", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const [sd, ps] = await Promise.all([
    db.collection("shops").doc(u.uid).get(),
    db.collection("products").where("ownerUid", "==", u.uid).get()
  ]);
  const products = ps.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({
    user: { uid: u.uid, username: u.username }, isAdmin: u.isAdmin,
    hasWallet: !!u.wallet_address,
    shop: sd.exists ? { id: sd.id, ...sd.data() } : null,
    products
  });
}));

app.post("/api/upload", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  if (limited("up_" + u.uid, 30, 3600000)) return res.status(429).json({ error: "Too many uploads" });
  const f = req.body.file || "";
  const m = f.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Invalid image" });
  if (Buffer.byteLength(m[2], "base64") > 3 * 1024 * 1024) return res.status(400).json({ error: "Image over 3MB" });
  const r = await cloudinary.v2.uploader.upload(f, { folder: "parfum/" + u.uid, transformation: [{ width: 1200, crop: "limit" }] });
  res.json({ url: r.secure_url });
}));

/* ===== المحل: حفظ البيانات =====
   دورة حياة المحل:
   unpaid  → (دفع 5 Pi) → pending (قيد المراجعة) → live (قبول الأدمن)
   pending → (رفض الأدمن + استرجاع الرسوم) → refunded (مع سبب الرفض، ويمكن للمالك التعديل والدفع من جديد) */
app.post("/api/shop/save", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const b = req.body;
  const data = {
    name: clean(b.name, 80), country: clean(b.country, 2).toUpperCase(), region: clean(b.region, 60),
    address: clean(b.address, 160), phone: clean(b.phone, 30), hours: clean(b.hours, 60),
    description: clean(b.description, 500), image: isImg(b.image) ? b.image : ""
  };
  if (!data.name || !/^[A-Z]{2}$/.test(data.country) || !data.region || !data.address || !data.phone || !data.image)
    return res.status(400).json({ error: "Please complete all required fields (including the shop photo)" });
  const ref = db.collection("shops").doc(u.uid);
  const snap = await ref.get();
  if (snap.exists) {
    const old = snap.data();
    if (old.status === "removed") return res.status(403).json({ error: "This shop was removed by the administrator" });
    const upd = { ...data, ownerUsername: u.username, updatedAt: Date.now() };
    if (old.status === "refunded") { upd.status = "unpaid"; upd.reviewMessage = ""; }
    await ref.update(upd);
  } else {
    await ref.set({
      ...data, ownerUid: u.uid, ownerUsername: u.username, status: "unpaid",
      feePaid: false, reviewMessage: "", createdAt: Date.now()
    });
  }
  res.json({ success: true, id: u.uid });
}));

/* ===== المنتجات: حفظ (جديد = unpaid حتى يتم دفع 0.25 Pi) ===== */
app.post("/api/product/save", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const shop = await db.collection("shops").doc(u.uid).get();
  if (!shop.exists || shop.data().status !== "live")
    return res.status(400).json({ error: "Your shop must be open first" });
  const b = req.body;
  const price = Number(b.price);
  const data = {
    name: clean(b.name, 80), brand: clean(b.brand, 60), size: clean(b.size, 30),
    price, currency: clean(b.currency, 6).toUpperCase(), description: clean(b.description, 400),
    image: isImg(b.image) ? b.image : ""
  };
  if (!data.name || !(price > 0 && price < 1e9) || !data.currency || !data.image)
    return res.status(400).json({ error: "Please complete all required fields (including the product photo)" });
  if (b.id) {
    const ref = db.collection("products").doc(String(b.id));
    const s = await ref.get();
    if (!s.exists || s.data().ownerUid !== u.uid) return res.status(403).json({ error: "Not your product" });
    const old = s.data();
    if (old.status === "removed") return res.status(403).json({ error: "This product was removed by the administrator" });
    const upd = { ...data, updatedAt: Date.now() };
    if (old.status === "refunded") { upd.status = "unpaid"; upd.reviewMessage = ""; }
    await ref.update(upd);
    return res.json({ success: true, id: ref.id });
  }
  const count = (await db.collection("products").where("ownerUid", "==", u.uid).get()).size;
  if (count >= 200) return res.status(400).json({ error: "Product limit reached" });
  const added = await db.collection("products").add({
    ...data, shopId: u.uid, ownerUid: u.uid, status: "unpaid", feePaid: false,
    reviewMessage: "", createdAt: Date.now()
  });
  res.json({ success: true, id: added.id });
}));

app.post("/api/product/delete", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const ref = db.collection("products").doc(String(req.body.id || ""));
  const s = await ref.get();
  if (!s.exists || s.data().ownerUid !== u.uid) return res.status(403).json({ error: "Not your product" });
  await ref.delete();
  res.json({ success: true });
}));

/* ===== الدفع (المستخدم إلى التطبيق) ===== */
async function getPayment(id) {
  const r = await fetch(`${PI_API}/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Key ${PI_KEY}` } });
  if (!r.ok) throw new Error("Payment not found");
  return r.json();
}
async function checkPayment(p) {
  const { type, targetId } = p.metadata || {};
  const col = type === "shop_fee" ? "shops" : type === "product_fee" ? "products" : null;
  if (!col || !targetId) throw new Error("Bad payment data");
  const ref = db.collection(col).doc(String(targetId));
  const s = await ref.get();
  if (!s.exists) throw new Error("Target not found");
  const d = s.data();
  if (d.ownerUid !== p.user_uid) throw new Error("Owner mismatch");
  const fee = type === "shop_fee" ? SHOP_FEE : PRODUCT_FEE;
  if (Math.abs(Number(p.amount) - fee) > 1e-7) throw new Error("Amount mismatch");
  return { ref, d, type, targetId, fee };
}

app.post("/api/pay/approve", wrap(async (req, res) => {
  const { paymentId } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const pid = String(paymentId);
  const p = await getPayment(pid);
  const c = await checkPayment(p);
  if (c.d.status !== "unpaid") throw new Error("Not awaiting payment");
  const r = await fetch(`${PI_API}/payments/${encodeURIComponent(pid)}/approve`, { method: "POST", headers: { Authorization: `Key ${PI_KEY}` } });
  if (!r.ok) throw new Error(await r.text());
  res.json({ success: true });
}));

app.post("/api/pay/complete", wrap(async (req, res) => {
  const { paymentId, txid } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const pid = String(paymentId);
  const done = await db.collection("payments").doc(pid).get();
  if (done.exists) return res.json({ success: true });
  const p = await getPayment(pid);
  const c = await checkPayment(p);
  const tx = (p.transaction && p.transaction.txid) || txid;
  if (!tx) throw new Error("Missing txid");
  if (!(p.status && p.status.developer_completed)) {
    const r = await fetch(`${PI_API}/payments/${encodeURIComponent(pid)}/complete`, {
      method: "POST", headers: { Authorization: `Key ${PI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid: tx })
    });
    if (!r.ok) throw new Error(await r.text());
  }
  // إذا كان العنصر مدفوعاً مسبقاً (دفعة مكررة) نسجّلها فقط
  const fresh = c.d.status === "unpaid";
  const b = db.batch();
  if (fresh) {
    // المحل بعد الدفع يذهب إلى المراجعة (pending) ولا يُنشر مباشرة. أما المنتج فيُنشر مباشرة.
    b.update(c.ref, c.type === "shop_fee"
      ? { status: "pending", feePaid: true, reviewMessage: "", submittedAt: Date.now() }
      : { status: "live", feePaid: true, publishedAt: Date.now() });
  }
  b.set(db.collection("payments").doc(pid), {
    userUid: p.user_uid, type: c.type, targetId: c.targetId, targetName: c.d.name,
    amount: c.fee, txid: tx, paidAt: Date.now(),
    // رسوم المنتجات غير قابلة للاسترجاع أبداً، أما رسوم المحل فتبدأ بـ none
    refundStatus: c.type === "product_fee" ? "nonrefundable" : "none",
    duplicate: !fresh
  });
  await b.commit();
  res.json({ success: true });
}));

/* ===== الإدارة ===== */
app.post("/api/admin/list", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const [s, p, y] = await Promise.all([
    db.collection("shops").limit(300).get(),
    db.collection("products").limit(500).get(),
    db.collection("payments").orderBy("paidAt", "desc").limit(50).get()
  ]);
  const names = {};
  const shops = s.docs.map(d => {
    const x = d.data(); names[d.id] = x.name;
    return {
      id: d.id, name: x.name, country: x.country, region: x.region, ownerUsername: x.ownerUsername, status: x.status,
      image: x.image || "", address: x.address || "", phone: x.phone || "", hours: x.hours || "", description: x.description || "",
      createdAt: x.createdAt || 0, submittedAt: x.submittedAt || 0
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
  const products = p.docs.map(d => {
    const x = d.data();
    return { id: d.id, name: x.name, shopId: x.shopId, shopName: names[x.shopId] || "", price: x.price, currency: x.currency, status: x.status, image: x.image || "", createdAt: x.createdAt || 0 };
  }).sort((a, b) => b.createdAt - a.createdAt);
  const st = {};
  shops.forEach(x => { st["shop_fee:" + x.id] = x.status; });
  products.forEach(x => { st["product_fee:" + x.id] = x.status; });
  res.json({
    shops, products,
    payments: y.docs.map(d => { const x = d.data(); return { id: d.id, ...x, targetStatus: st[x.type + ":" + x.targetId] || "missing" }; })
  });
}));

/* ===== إحصائيات الأدمن ===== */
let statsCache = { k: "", t: 0, d: null };
app.post("/api/admin/stats", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const tz = Math.max(-840, Math.min(840, Math.round(Number(req.body.tz)) || 0)); // فرق التوقيت بالدقائق (من المتصفح)
  const now = Date.now();
  if (!req.body.force && statsCache.d && statsCache.k === String(tz) && now - statsCache.t < 15000) return res.json(statsCache.d);

  const [s, p, y] = await Promise.all([
    db.collection("shops").select("name", "status", "country", "createdAt", "ownerUid").get(),
    db.collection("products").select("status", "shopId", "createdAt").get(),
    db.collection("payments").select("type", "amount", "paidAt", "refundStatus", "refundAmount", "refundDeduction", "duplicate", "targetName").get()
  ]);

  const r = n => Number(Number(n || 0).toFixed(7));
  const dk = ts => { const n = Number(ts); return n > 0 ? new Date(n - tz * 60000).toISOString().slice(0, 10) : ""; };
  const today = dk(now);
  const DAY = 86400000;

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dk(now - i * DAY));
  const rev = {}, ns = {}, np = {};
  days.forEach(d => { rev[d] = 0; ns[d] = 0; np[d] = 0; });

  const z = () => ({ revenue: 0, shops: 0, products: 0 });
  const per = { today: z(), d7: z(), d30: z(), all: z() };
  const addTo = (ts, field, val) => {
    const n = Number(ts) || 0;
    per.all[field] += val;
    if (n && now - n < 30 * DAY) per.d30[field] += val;
    if (n && now - n < 7 * DAY) per.d7[field] += val;
    if (n && dk(n) === today) per.today[field] += val;
  };

  const cnt = () => ({ total: 0, live: 0, pending: 0, unpaid: 0, removed: 0, refunded: 0 });
  const sc = cnt(), pc = cnt();
  const owners = new Set(), info = {}, byCountry = {}, perShop = {};
  const STATES = ["live", "pending", "unpaid", "removed", "refunded"];

  s.forEach(d => {
    const x = d.data();
    const st = STATES.includes(x.status) ? x.status : "unpaid";
    sc.total++; sc[st]++;
    if (x.ownerUid) owners.add(x.ownerUid);
    info[d.id] = { name: x.name || "", country: x.country || "", live: x.status === "live" };
    addTo(x.createdAt, "shops", 1);
    const k = dk(x.createdAt); if (k in ns) ns[k]++;
    if (x.status === "live") {
      const c = x.country || "--";
      (byCountry[c] = byCountry[c] || { shops: 0, products: 0 }).shops++;
    }
  });

  p.forEach(d => {
    const x = d.data();
    const st = STATES.includes(x.status) ? x.status : "unpaid";
    pc.total++; pc[st]++;
    addTo(x.createdAt, "products", 1);
    const k = dk(x.createdAt); if (k in np) np[k]++;
    const sh = info[x.shopId];
    if (x.status === "live" && sh && sh.live) {
      perShop[x.shopId] = (perShop[x.shopId] || 0) + 1;
      const c = sh.country || "--";
      (byCountry[c] = byCountry[c] || { shops: 0, products: 0 }).products++;
    }
  });

  const m = { shopFees: 0, productFees: 0, refunded: 0, kept: 0 };
  const rs = { refunded: 0, failed: 0, stuck: 0, processing: 0 };
  let dups = 0;
  const recent = [];
  y.forEach(d => {
    const x = d.data();
    const a = Number(x.amount) || 0;
    if (x.type === "shop_fee") m.shopFees += a; else m.productFees += a;
    if (x.duplicate) dups++;
    addTo(x.paidAt, "revenue", a);
    const k = dk(x.paidAt); if (k in rev) rev[k] += a;
    if (x.type === "shop_fee") {
      if (x.refundStatus === "refunded") { m.refunded += Number(x.refundAmount) || 0; m.kept += Number(x.refundDeduction) || 0; rs.refunded++; }
      else if (["failed", "stuck", "processing"].includes(x.refundStatus)) rs[x.refundStatus]++;
    }
    recent.push({ name: x.targetName || "", type: x.type, amount: a, paidAt: Number(x.paidAt) || 0, refundStatus: x.refundStatus || "none" });
  });
  recent.sort((a, b) => b.paidAt - a.paidAt);

  const countries = Object.entries(byCountry)
    .map(([code, v]) => ({ code, shops: v.shops, products: v.products }))
    .sort((a, b) => b.shops - a.shops || b.products - a.products).slice(0, 8);
  const topShops = Object.entries(perShop)
    .map(([id, n]) => ({ name: (info[id] && info[id].name) || "", country: (info[id] && info[id].country) || "", products: n }))
    .sort((a, b) => b.products - a.products).slice(0, 5);

  const collected = m.shopFees + m.productFees;
  const fixPer = o => ({ revenue: r(o.revenue), shops: o.shops, products: o.products });
  const out = {
    at: now, days,
    revDay: days.map(d => r(rev[d])), shopsDay: days.map(d => ns[d]), prodsDay: days.map(d => np[d]),
    shops: sc, products: pc, owners: owners.size,
    /* الصافي = المحصّل − المسترجع للمالكين − رسوم الشبكة المدفوعة (رسوم الشبكة ليست ربحاً) */
    money: { shopFees: r(m.shopFees), productFees: r(m.productFees), collected: r(collected), refunded: r(m.refunded), kept: r(m.kept), net: r(collected - m.refunded - m.kept) },
    payments: { total: y.size, duplicates: dups, refunds: rs },
    periods: { today: fixPer(per.today), d7: fixPer(per.d7), d30: fixPer(per.d30), all: fixPer(per.all) },
    countries, topShops, recent: recent.slice(0, 8),
    alerts: { pendingShops: sc.pending, failedRefunds: rs.failed, stuckRefunds: rs.stuck, processing: rs.processing, duplicates: dups, unpaidShops: sc.unpaid, unpaidProducts: pc.unpaid }
  };
  statsCache = { k: String(tz), t: now, d: out };
  res.json(out);
}));

/* ===== الاسترجاع (التطبيق إلى المستخدم - A2U) =====
   القاعدة: الاسترجاع متاح فقط لرسوم فتح المحل (shop_fee).
   رسوم المنتجات (product_fee) غير قابلة للاسترجاع أبداً. */

/* ينظّف دفعات A2U العالقة. إن وجد دفعة استرجاع لنفس الدفعة لها txid يُكملها ويعيدها (لمنع الاسترجاع المزدوج) */
async function clearStuck(paymentId) {
  let resumed = null;
  let list = [];
  try {
    const raw = await pi().getIncompleteServerPayments();
    // قد ترجع المكتبة مصفوفة أو كائناً يحتوي المصفوفة
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.incomplete_server_payments)) list = raw.incomplete_server_payments;
    else if (raw && Array.isArray(raw.data)) list = raw.data;
    else list = [];
  } catch (e) { console.error("getIncomplete:", errInfo(e)); return null; }
  for (const p of list) {
    const tx = p.transaction && p.transaction.txid;
    const mine = p.metadata && String(p.metadata.paymentId) === String(paymentId);
    try {
      if (tx) {
        await pi().completePayment(p.identifier, tx);
        if (mine) resumed = { rid: p.identifier, txid: tx };
      } else {
        await pi().cancelPayment(p.identifier);
      }
    } catch (e) { console.error("clearStuck:", p.identifier, errInfo(e)); }
  }
  return resumed;
}

/* استرجاع دفعة رسوم محل. لا يُستدعى إلا بعد حذف المحل أو رفضه من قبل المطور */
async function refundPayment(paymentId, reason, by) {
  const pref = db.collection("payments").doc(String(paymentId));
  // قفل لمنع الاسترجاع المزدوج
  const info = await db.runTransaction(async t => {
    const s = await t.get(pref);
    if (!s.exists) throw new Error("Payment not found");
    const d = s.data();
    if (d.type !== "shop_fee") throw new Error("Product fees are non-refundable");
    if (!["none", "failed", "stuck"].includes(d.refundStatus)) throw new Error("Already refunded or processing");
    t.update(pref, { refundStatus: "processing" });
    return d;
  });
  // المبلغ المسترجع = رسوم المحل المدفوعة ناقص خصم الشبكة (مثلاً 5 - 0.01 = 4.99)
  const deduct = REFUND_DEDUCT;
  const refundAmt = Number((Number(info.amount) - deduct).toFixed(7));
  if (!(refundAmt > 0)) {
    await pref.update({ refundStatus: "failed" }).catch(() => {});
    throw new Error("Refund amount too small");
  }
  let rid = info.refundRid || null, txid = info.refundTxid || null;
  try {
    if (!rid) {
      const resumed = await clearStuck(paymentId);
      if (resumed) { rid = resumed.rid; txid = resumed.txid; }
    }
    if (!rid) {
      rid = await pi().createPayment({
        amount: refundAmt, memo: "Parfum refund",
        metadata: { type: "refund", paymentId: String(paymentId) }, uid: info.userUid
      });
      await pref.update({ refundRid: rid });
    }
    if (!txid) {
      txid = await pi().submitPayment(rid);
      await pref.update({ refundTxid: txid });
    }
    await pi().completePayment(rid, txid);
  } catch (e) {
    const raw = errInfo(e);
    console.error("REFUND ERROR:", paymentId, raw);
    if (txid) {
      // المال أُرسل لكن لم يكتمل التسجيل: لا ننشئ دفعة جديدة، نُكمل نفس الدفعة لاحقاً
      await pref.update({ refundStatus: "stuck", refundRid: rid, refundTxid: txid, lastError: raw.slice(0, 500) }).catch(() => {});
    } else {
      if (rid) { try { await pi().cancelPayment(rid); } catch {} }
      await pref.update({ refundStatus: "failed", refundRid: null, lastError: raw.slice(0, 500) }).catch(() => {});
    }
    throw new Error(friendlyRefundError(raw));
  }
  try {
    await pref.update({
      refundStatus: "refunded", refundTxid: txid, refundedAt: Date.now(),
      refundAmount: refundAmt, refundDeduction: deduct,
      refundReason: clean(reason, 200), refundedBy: by
    });
  } catch (e) { console.error("Refund sent but DB update failed:", paymentId, txid, errInfo(e)); }
  return { txid, amount: refundAmt };
}

/* ===== الحذف النهائي (Firestore + Cloudinary) ===== */

/* استخراج public_id من رابط Cloudinary، ولا نحذف إلا صور مجلد هذا المستخدم */
function cloudId(url, ownerUid) {
  try {
    const u = String(url || "");
    if (!u.startsWith("https://res.cloudinary.com/")) return null;
    if (env.CLOUDINARY_CLOUD_NAME && !u.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`)) return null;
    const i = u.indexOf("/upload/");
    if (i < 0) return null;
    let p = decodeURIComponent(u.slice(i + 8).split("?")[0]);
    const j = p.indexOf("parfum/");
    if (j < 0) return null;
    p = p.slice(j).replace(/\.[a-z0-9]+$/i, "");
    if (!ownerUid || !p.startsWith("parfum/" + ownerUid + "/")) return null;
    return p;
  } catch { return null; }
}
async function destroyImage(url, ownerUid) {
  const id = cloudId(url, ownerUid);
  if (!id) return;
  try { await cloudinary.v2.uploader.destroy(id, { invalidate: true }); }
  catch (e) { console.error("cloudinary destroy:", id, errInfo(e)); }
}
async function purgeDoc(ref, data) {
  await destroyImage(data && data.image, data && data.ownerUid);
  await ref.delete();
}

/* هل استُرجعت كل دفعات رسوم هذا العنصر؟ (أو لا توجد دفعات أصلاً) */
async function canPurge(feeType, id) {
  const ps = await db.collection("payments").where("targetId", "==", String(id)).get();
  return ps.docs.every(d => { const x = d.data(); return x.type !== feeType || x.refundStatus === "refunded"; });
}

/* يحذف العنصر نهائياً.
   - المنتج: يُحذف مباشرة (رسومه غير قابلة للاسترجاع).
   - المحل: يُحذف فقط بعد استرجاع رسوم فتحه بالكامل، ويُحذف معه كل منتجاته بدون أي استرجاع لرسومها. */
async function finalizeRemoval(type, id, ref, data) {
  if (type === "shop") {
    if (!(await canPurge("shop_fee", id))) return false;
    const pq = await db.collection("products").where("shopId", "==", String(id)).get();
    for (const pd of pq.docs) await purgeDoc(pd.ref, pd.data());
  }
  await purgeDoc(ref, data);
  return true;
}

/* يسترجع كل دفعات رسوم فتح المحل القابلة للاسترجاع. يرجع ملخصاً بالنتيجة */
async function refundShopFees(shopId, reason, by) {
  let refunded = 0, failed = 0, total = 0, lastErr = "";
  const ps = await db.collection("payments").where("targetId", "==", String(shopId)).get();
  for (const d of ps.docs) {
    const x = d.data();
    if (x.type !== "shop_fee" || !["none", "failed", "stuck"].includes(x.refundStatus)) continue;
    try { const r = await refundPayment(d.id, reason, by); refunded++; total += r.amount; }
    catch (e) { failed++; lastErr = e.message; console.error("Refund failed:", d.id, e.message); }
  }
  return { refunded, failed, amount: Number(total.toFixed(7)), error: lastErr };
}

/* مراجعة وحذف محل/منتج أو استعادته.
   - approve: قبول محل قيد المراجعة ونشره.
   - reject : رفض محل قيد المراجعة + استرجاع رسوم فتحه (ناقص خصم الشبكة). إذا نجح الاسترجاع يصبح المحل refunded مع سبب الرفض
              ويستطيع المالك تعديل بياناته والدفع من جديد. إذا فشل الاسترجاع يبقى المحل قيد المراجعة لإعادة المحاولة.
   - remove : حذف المحل يسترجع رسوم فتح المحل فقط ثم يمحى نهائياً مع منتجاته. حذف المنتج: بدون أي استرجاع. */
app.post("/api/admin/moderate", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { type, id, action, message } = req.body;
  if (!["shop", "product"].includes(type) || !["remove", "restore", "approve", "reject"].includes(action) || !id)
    return res.status(400).json({ error: "Bad request" });
  const ref = db.collection(type === "shop" ? "shops" : "products").doc(String(id));
  const s = await ref.get();
  if (!s.exists) return res.status(404).json({ error: "Not found" });

  if (action === "restore") {
    const d = s.data();
    if (d.status !== "removed") return res.status(400).json({ error: "Not removed" });
    await ref.update({ status: d.feePaid ? "live" : "unpaid", reviewMessage: "", reviewedAt: Date.now() });
    return res.json({ success: true });
  }

  if (action === "approve" || action === "reject") {
    const d = s.data();
    if (type !== "shop") return res.status(400).json({ error: "Only shops need review" });
    if (d.status !== "pending") return res.status(400).json({ error: "Shop is not awaiting review" });
    if (action === "approve") {
      await ref.update({ status: "live", reviewMessage: "", reviewedAt: Date.now(), publishedAt: Date.now() });
      return res.json({ success: true });
    }
    const why = clean(message, 300);
    if (!why) return res.status(400).json({ error: "Reason required" });
    const r = await refundShopFees(id, why, u.username);
    if (r.failed) {
      // فشل الاسترجاع: يبقى المحل قيد المراجعة ليعيد الأدمن المحاولة
      return res.json({ success: true, rejected: false, refunded: r.refunded, failed: r.failed, amount: r.amount, error: r.error });
    }
    await ref.update({ status: "refunded", feePaid: false, reviewMessage: why, reviewedAt: Date.now() });
    return res.json({ success: true, rejected: true, refunded: r.refunded, failed: 0, amount: r.amount, error: "" });
  }

  const msg = clean(message, 300);
  if (!msg) return res.status(400).json({ error: "Reason required" });
  await ref.update({ status: "removed", reviewMessage: msg, reviewedAt: Date.now() });

  let refunded = 0, failed = 0, total = 0, lastErr = "";
  if (type === "shop") {
    // استرجاع رسوم فتح المحل فقط
    const r = await refundShopFees(id, msg, u.username);
    refunded = r.refunded; failed = r.failed; total = r.amount; lastErr = r.error;
  }
  const deleted = await finalizeRemoval(type, String(id), ref, s.data());
  if (!deleted && refunded) await ref.update({ feePaid: false });
  res.json({ success: true, refunded, failed, amount: Number(total.toFixed(7)), error: lastErr, deleted });
}));

/* إعادة محاولة استرجاع فاشل: مسموح فقط لرسوم المحل، وفقط إذا كان المحل محذوفاً */
app.post("/api/admin/refund", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { paymentId, reason } = req.body;
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const ps = await db.collection("payments").doc(String(paymentId)).get();
  if (!ps.exists) return res.status(404).json({ error: "Payment not found" });
  const x = ps.data();
  if (x.type !== "shop_fee") return res.status(400).json({ error: "Product fees are non-refundable" });
  const tg = await db.collection("shops").doc(String(x.targetId)).get();
  if (!tg.exists || tg.data().status !== "removed")
    return res.status(400).json({ error: "Remove the shop first. Refunds happen only after removal." });
  const r = await refundPayment(paymentId, reason || tg.data().reviewMessage, u.username);
  const deleted = await finalizeRemoval("shop", String(x.targetId), tg.ref, tg.data());
  if (!deleted) await tg.ref.update({ feePaid: false });
  res.json({ success: true, txid: r.txid, amount: r.amount, deleted });
}));

/* ===== الواجهة (اختياري: إذا وُجد مجلد public) ===== */
app.use(express.static(path.join(__dirname, "public")));

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log("Parfum running on port", PORT));
