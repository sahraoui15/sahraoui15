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
const SHOP_FEE = Number(env.SHOP_FEE || 5);
const PRODUCT_FEE = Number(env.PRODUCT_FEE || 0.25);
const FREE_SHOPS = Number(env.FREE_SHOPS || 20);
const FREE_PRODUCTS = Number(env.FREE_PRODUCTS || 3);
const REFUND_DEDUCT = Number(env.REFUND_DEDUCT ?? 0.01);
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
    const PiNetwork = require("pi-backend").default;
    _pi = new PiNetwork(PI_KEY, env.PI_WALLET_SECRET);
  }
  return _pi;
}

/* ===== أدوات مساعدة ===== */
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
  catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
};

async function auth(req, res) {
  const { accessToken, userUid } = req.body || {};
  if (!accessToken || !userUid) { res.status(400).json({ error: "Missing data" }); return null; }
  if (limited("a_" + userUid, 60, 60000)) { res.status(429).json({ error: "Too many requests" }); return null; }
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

const pubShop = (id, d) => ({ id, name: d.name, country: d.country, region: d.region, address: d.address, phone: d.phone, hours: d.hours || "", description: d.description || "", image: d.image || "", founder: !!d.free });
const pubProd = (id, d) => ({ id, name: d.name, brand: d.brand || "", size: d.size || "", price: d.price, currency: d.currency || "", description: d.description || "", image: d.image || "" });

const app = express();

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

app.get("/api/config", wrap(async (_, res) => {
  const st = (await db.doc("stats/platform").get()).data() || {};
  res.json({
    shopFee: SHOP_FEE, productFee: PRODUCT_FEE, freeProducts: FREE_PRODUCTS,
    refundDeduct: REFUND_DEDUCT,
    freeLeft: Math.max(0, FREE_SHOPS - (st.freeShopsUsed || 0)),
    sandbox: env.PI_SANDBOX === "true"
  });
}));

app.get("/api/shops", wrap(async (_, res) => {
  const [s, p] = await Promise.all([
    db.collection("shops").where("status", "==", "live").get(),
    db.collection("products").where("status", "==", "live").get()
  ]);
  const prods = {};
  p.forEach(d => { const x = d.data(); (prods[x.shopId] = prods[x.shopId] || []).push(pubProd(d.id, x)); });
  res.json({ shops: s.docs.map(d => ({ ...pubShop(d.id, d.data()), products: prods[d.id] || [] })) });
}));

/* ===== حساب التاجر ===== */
app.post("/api/me", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const [sd, ps] = await Promise.all([
    db.collection("shops").doc(u.uid).get(),
    db.collection("products").where("ownerUid", "==", u.uid).get()
  ]);
  res.json({
    user: { uid: u.uid, username: u.username }, isAdmin: u.isAdmin,
    shop: sd.exists ? { id: sd.id, ...sd.data() } : null,
    products: ps.docs.map(d => ({ id: d.id, ...d.data() }))
  });
}));

app.post("/api/upload", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  if (limited("up_" + u.uid, 20, 3600000)) return res.status(429).json({ error: "Too many uploads" });
  const f = req.body.file || "";
  const m = f.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Invalid image" });
  if (Buffer.byteLength(m[2], "base64") > 3 * 1024 * 1024) return res.status(400).json({ error: "Image over 3MB" });
  const r = await cloudinary.v2.uploader.upload(f, { folder: "parfum/" + u.uid, transformation: [{ width: 1200, crop: "limit" }] });
  res.json({ url: r.secure_url });
}));

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
    // إذا كان المحل مدفوعاً أو مجانياً سابقاً نبقي حالة الدفع، لكن نعيده للمراجعة
    await ref.update({ ...data, status: "pending", reviewMessage: "", updatedAt: Date.now(), feePaid: !!old.feePaid });
  } else {
    await ref.set({
      ...data, ownerUid: u.uid, ownerUsername: u.username, status: "pending",
      feePaid: false, free: false, freeProductsUsed: 0, reviewMessage: "", createdAt: Date.now()
    });
  }
  res.json({ success: true });
}));

app.post("/api/product/save", wrap(async (req, res) => {
  const u = await auth(req, res); if (!u) return;
  const shop = await db.collection("shops").doc(u.uid).get();
  if (!shop.exists || shop.data().status !== "live")
    return res.status(400).json({ error: "Your shop must be live first" });
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
    await ref.update({ ...data, status: "pending", reviewMessage: "", updatedAt: Date.now(), feePaid: !!s.data().feePaid });
  } else {
    const count = (await db.collection("products").where("ownerUid", "==", u.uid).get()).size;
    if (count >= 200) return res.status(400).json({ error: "Product limit reached" });
    await db.collection("products").add({
      ...data, shopId: u.uid, ownerUid: u.uid, status: "pending", feePaid: false, free: false,
      reviewMessage: "", createdAt: Date.now()
    });
  }
  res.json({ success: true });
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
  const r = await fetch(`${PI_API}/payments/${id}`, { headers: { Authorization: `Key ${PI_KEY}` } });
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
  const p = await getPayment(paymentId);
  const c = await checkPayment(p);
  if (c.d.status !== "approved_unpaid") throw new Error("Not awaiting payment");
  const r = await fetch(`${PI_API}/payments/${paymentId}/approve`, { method: "POST", headers: { Authorization: `Key ${PI_KEY}` } });
  if (!r.ok) throw new Error(await r.text());
  res.json({ success: true });
}));

app.post("/api/pay/complete", wrap(async (req, res) => {
  const { paymentId, txid } = req.body || {};
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const done = await db.collection("payments").doc(paymentId).get();
  if (done.exists) return res.json({ success: true });
  const p = await getPayment(paymentId);
  const c = await checkPayment(p);
  if (c.d.status !== "approved_unpaid") throw new Error("Not awaiting payment");
  const tx = (p.transaction && p.transaction.txid) || txid;
  if (!tx) throw new Error("Missing txid");
  if (!(p.status && p.status.developer_completed)) {
    const r = await fetch(`${PI_API}/payments/${paymentId}/complete`, {
      method: "POST", headers: { Authorization: `Key ${PI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid: tx })
    });
    if (!r.ok) throw new Error(await r.text());
  }
  const b = db.batch();
  b.update(c.ref, { status: "live", feePaid: true });
  b.set(db.collection("payments").doc(paymentId), {
    userUid: p.user_uid, type: c.type, targetId: c.targetId, targetName: c.d.name,
    amount: c.fee, txid: tx, paidAt: Date.now(), refundStatus: "none"
  });
  await b.commit();
  res.json({ success: true });
}));

/* ===== الإدارة: المراجعة والاسترجاع ===== */
app.post("/api/admin/pending", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const [s, p] = await Promise.all([
    db.collection("shops").where("status", "==", "pending").get(),
    db.collection("products").where("status", "==", "pending").get()
  ]);
  const ids = [...new Set(p.docs.map(d => d.data().shopId))];
  const names = {};
  await Promise.all(ids.map(async id => { const x = await db.collection("shops").doc(id).get(); names[id] = x.exists ? x.data().name : ""; }));
  res.json({
    shops: s.docs.map(d => ({ id: d.id, ...d.data() })),
    products: p.docs.map(d => ({ id: d.id, ...d.data(), shopName: names[d.data().shopId] }))
  });
}));

app.post("/api/admin/review", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { type, id, action, message } = req.body;
  if (!["shop", "product"].includes(type) || !["approve", "reject"].includes(action) || !id)
    return res.status(400).json({ error: "Bad request" });
  const ref = db.collection(type === "shop" ? "shops" : "products").doc(String(id));
  if (action === "reject") {
    const msg = clean(message, 300);
    if (!msg) return res.status(400).json({ error: "Reason required" });
    await ref.update({ status: "rejected", reviewMessage: msg, reviewedAt: Date.now() });
    return res.json({ success: true, status: "rejected" });
  }
  const stats = db.doc("stats/platform");
  const status = await db.runTransaction(async t => {
    // في Firestore يجب إجراء كل القراءات قبل أي كتابة
    const s = await t.get(ref);
    if (!s.exists) throw new Error("Not found");
    const d = s.data();
    if (d.status !== "pending") throw new Error("Not pending");
    const upd = { reviewMessage: "", reviewedAt: Date.now() };
    if (d.feePaid) {
      upd.status = "live";
    } else if (type === "shop") {
      const st = await t.get(stats);
      const used = (st.data() || {}).freeShopsUsed || 0;
      if (used < FREE_SHOPS) {
        upd.status = "live"; upd.feePaid = true; upd.free = true;
        t.set(stats, { freeShopsUsed: used + 1 }, { merge: true });
      } else upd.status = "approved_unpaid";
    } else {
      const sref = db.collection("shops").doc(d.shopId);
      const sd = await t.get(sref);
      const used = (sd.data() || {}).freeProductsUsed || 0;
      if (used < FREE_PRODUCTS) {
        upd.status = "live"; upd.feePaid = true; upd.free = true;
        t.update(sref, { freeProductsUsed: used + 1 });
      } else upd.status = "approved_unpaid";
    }
    t.update(ref, upd);
    return upd.status;
  });
  res.json({ success: true, status });
}));

app.post("/api/admin/payments", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const s = await db.collection("payments").orderBy("paidAt", "desc").limit(50).get();
  res.json({ payments: s.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.post("/api/admin/refund", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { paymentId, reason } = req.body;
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const pref = db.collection("payments").doc(String(paymentId));
  // قفل لمنع الاسترجاع المزدوج
  const info = await db.runTransaction(async t => {
    const s = await t.get(pref);
    if (!s.exists) throw new Error("Payment not found");
    const d = s.data();
    if (d.refundStatus !== "none" && d.refundStatus !== "failed") throw new Error("Already refunded or processing");
    t.update(pref, { refundStatus: "processing" });
    return d;
  });
  // المبلغ المسترجع = المبلغ المدفوع ناقص الخصم (مثلاً 5 - 0.01 = 4.99)
  const refundAmt = Number((Number(info.amount) - REFUND_DEDUCT).toFixed(7));
  if (!(refundAmt > 0)) {
    await pref.update({ refundStatus: "failed" }).catch(() => {});
    return res.status(400).json({ error: "Refund amount too small" });
  }
  let rid = null, txid = null;
  try {
    rid = await pi().createPayment({
      amount: refundAmt, memo: "Parfum refund",
      metadata: { type: "refund", paymentId: String(paymentId) }, uid: info.userUid
    });
    txid = await pi().submitPayment(rid);
    await pi().completePayment(rid, txid);
  } catch (e) {
    await pref.update({ refundStatus: "failed" }).catch(() => {});
    if (rid) { try { await pi().cancelPayment(rid); } catch {} }
    throw e;
  }
  // الأموال أُرسلت: نسجّل النتيجة ونخفي العنصر
  try {
    await pref.update({
      refundStatus: "refunded", refundTxid: txid, refundedAt: Date.now(),
      refundAmount: refundAmt, refundDeduction: REFUND_DEDUCT,
      refundReason: clean(reason, 200), refundedBy: u.username
    });
    const col = info.type === "shop_fee" ? "shops" : "products";
    await db.collection(col).doc(info.targetId).update({ status: "refunded", feePaid: false, reviewMessage: clean(reason, 200) });
  } catch (e) { console.error("Refund sent but DB update failed:", paymentId, txid, e.message); }
  res.json({ success: true, txid, amount: refundAmt });
}));

/* ===== الواجهة (اختياري: إذا وُجد مجلد public) ===== */
app.use(express.static(path.join(__dirname, "public")));

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log("Parfum running on port", PORT));
