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
const PRODUCT_FEE = Number(env.PRODUCT_FEE || 0.25); // رسوم إضافة منتج
const REFUND_DEDUCT = Number(env.REFUND_DEDUCT ?? 0.01);
// خصم منفصل لاسترجاع رسوم المنتجات (افتراضياً نفس REFUND_DEDUCT). ضعه 0 لاسترجاع المنتج كاملاً
const PRODUCT_REFUND_DEDUCT = Number(env.PRODUCT_REFUND_DEDUCT ?? REFUND_DEDUCT);
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

/* المحلات المنشورة مع منتجاتها المنشورة */
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

/* ===== المحل: حفظ البيانات (الحالة الأولى unpaid حتى يتم دفع 5 Pi) ===== */
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
  // إذا كان العنصر منشوراً مسبقاً (دفعة مكررة) نسجّلها فقط ليتمكن الأدمن من استرجاعها
  const fresh = c.d.status === "unpaid";
  const b = db.batch();
  if (fresh) b.update(c.ref, { status: "live", feePaid: true, publishedAt: Date.now() });
  b.set(db.collection("payments").doc(pid), {
    userUid: p.user_uid, type: c.type, targetId: c.targetId, targetName: c.d.name,
    amount: c.fee, txid: tx, paidAt: Date.now(), refundStatus: "none", duplicate: !fresh
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
    return { id: d.id, name: x.name, country: x.country, region: x.region, ownerUsername: x.ownerUsername, status: x.status, image: x.image || "", createdAt: x.createdAt || 0 };
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

/* ===== الاسترجاع (التطبيق إلى المستخدم - A2U) ===== */

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

/* استرجاع دفعة واحدة. لا يُستدعى إلا بعد حذف المحل/المنتج من قبل المطور */
async function refundPayment(paymentId, reason, by) {
  const pref = db.collection("payments").doc(String(paymentId));
  // قفل لمنع الاسترجاع المزدوج
  const info = await db.runTransaction(async t => {
    const s = await t.get(pref);
    if (!s.exists) throw new Error("Payment not found");
    const d = s.data();
    if (!["none", "failed", "stuck"].includes(d.refundStatus)) throw new Error("Already refunded or processing");
    t.update(pref, { refundStatus: "processing" });
    return d;
  });
  // المبلغ المسترجع = المبلغ المدفوع ناقص الخصم (مثلاً 5 - 0.01 = 4.99)
  const deduct = info.type === "product_fee" ? PRODUCT_REFUND_DEDUCT : REFUND_DEDUCT;
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

/* ===== الحذف النهائي (Firestore + Cloudinary) بعد نجاح الاسترجاع ===== */

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

/* هل استُرجعت كل دفعات هذا العنصر؟ (أو لا توجد دفعات أصلاً) */
async function canPurge(feeType, id) {
  const ps = await db.collection("payments").where("targetId", "==", String(id)).get();
  return ps.docs.every(d => { const x = d.data(); return x.type !== feeType || x.refundStatus === "refunded"; });
}

/* استرجاع كل دفعات عنصر معيّن (للمنتجات التابعة لمحل يُحذف) */
async function refundTarget(feeType, id, msg, by, acc) {
  const ps = await db.collection("payments").where("targetId", "==", String(id)).get();
  for (const d of ps.docs) {
    const x = d.data();
    if (x.type !== feeType || !["none", "failed", "stuck"].includes(x.refundStatus)) continue;
    try { const r = await refundPayment(d.id, msg, by); acc.refunded++; acc.total += r.amount; }
    catch (e) { acc.failed++; acc.lastErr = e.message; console.error("Refund failed:", d.id, e.message); }
  }
}

/* يحذف العنصر نهائياً فقط إذا استُرجعت رسومه بالكامل. المحل يحذف معه منتجاته (بعد استرجاع رسومها) */
async function finalizeRemoval(type, id, ref, data, msg, by, acc) {
  const feeType = type === "shop" ? "shop_fee" : "product_fee";
  if (!(await canPurge(feeType, id))) return false;
  if (type === "shop") {
    const pq = await db.collection("products").where("shopId", "==", String(id)).get();
    for (const pd of pq.docs) {
      await refundTarget("product_fee", pd.id, msg, by, acc);
      if (await canPurge("product_fee", pd.id)) await purgeDoc(pd.ref, pd.data());
      else await pd.ref.update({ status: "removed", reviewMessage: msg, reviewedAt: Date.now() }).catch(() => {});
    }
  }
  await purgeDoc(ref, data);
  return true;
}

/* حذف محل/منتج (يسترجع رسومه تلقائياً ثم يُمحى نهائياً) أو استعادته */
app.post("/api/admin/moderate", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { type, id, action, message } = req.body;
  if (!["shop", "product"].includes(type) || !["remove", "restore"].includes(action) || !id)
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

  const msg = clean(message, 300);
  if (!msg) return res.status(400).json({ error: "Reason required" });
  await ref.update({ status: "removed", reviewMessage: msg, reviewedAt: Date.now() });

  // استرجاع رسوم هذا العنصر فقط (المحل: رسوم المحل، المنتج: رسوم المنتج)
  const feeType = type === "shop" ? "shop_fee" : "product_fee";
  const ps = await db.collection("payments").where("targetId", "==", String(id)).get();
  let refunded = 0, failed = 0, total = 0, lastErr = "";
  for (const d of ps.docs) {
    const x = d.data();
    if (x.type !== feeType || !["none", "failed", "stuck"].includes(x.refundStatus)) continue;
    try { const r = await refundPayment(d.id, msg, u.username); refunded++; total += r.amount; }
    catch (e) { failed++; lastErr = e.message; console.error("Refund failed:", d.id, e.message); }
  }
  const acc = { refunded, failed, total, lastErr };
  const deleted = await finalizeRemoval(type, String(id), ref, s.data(), msg, u.username, acc);
  if (!deleted && refunded) await ref.update({ feePaid: false });
  res.json({ success: true, refunded: acc.refunded, failed: acc.failed, amount: Number(acc.total.toFixed(7)), error: acc.lastErr, deleted });
}));

/* إعادة محاولة استرجاع فاشل: مسموح فقط إذا كان المحل/المنتج محذوفاً */
app.post("/api/admin/refund", wrap(async (req, res) => {
  const u = await adminOnly(req, res); if (!u) return;
  const { paymentId, reason } = req.body;
  if (!paymentId) return res.status(400).json({ error: "Missing data" });
  const ps = await db.collection("payments").doc(String(paymentId)).get();
  if (!ps.exists) return res.status(404).json({ error: "Payment not found" });
  const x = ps.data();
  const col = x.type === "shop_fee" ? "shops" : "products";
  const tg = await db.collection(col).doc(String(x.targetId)).get();
  if (!tg.exists || tg.data().status !== "removed")
    return res.status(400).json({ error: "Remove the shop/product first. Refunds happen only after removal." });
  const r = await refundPayment(paymentId, reason || tg.data().reviewMessage, u.username);
  const acc = { refunded: 1, failed: 0, total: r.amount, lastErr: "" };
  const deleted = await finalizeRemoval(x.type === "shop_fee" ? "shop" : "product", String(x.targetId), tg.ref, tg.data(),
    clean(reason || tg.data().reviewMessage || "", 300), u.username, acc);
  if (!deleted) await tg.ref.update({ feePaid: false });
  res.json({ success: true, txid: r.txid, amount: r.amount, deleted });
}));

/* ===== الواجهة (اختياري: إذا وُجد مجلد public) ===== */
app.use(express.static(path.join(__dirname, "public")));

const PORT = env.PORT || 3000;
app.listen(PORT, () => console.log("Parfum running on port", PORT));
