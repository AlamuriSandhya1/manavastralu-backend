require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

console.log("DNS Servers:", dns.getServers());

require("dotenv").config();
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const bcrypt     = require("bcryptjs");
const mongoose   = require("mongoose");
const fs         = require("fs");
const crypto     = require("crypto");
const axios      = require("axios");
const http       = require("http");
const https      = require("https");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createS3Images, createS3Upload } = require("./services/s3Images");
const Razorpay   = require("razorpay"); // npm i razorpay
const compression = require("compression");  // npm i compression
const { initSocket, emitStockUpdate: _emitStockUpdate } = require("./socket"); // npm i socket.io

// ── Product list cache ────────────────────────────────
// The product list is read by every visitor but changes rarely. It is kept in
// memory (already serialised) and thrown away on ANY product / stock write,
// because every write path below calls emitStockUpdate().
const PRODUCT_CACHE_TTL = 20 * 1000;
const productListCache  = new Map();           // key -> { at, body }

// ── Storefront snapshot: ALL categories + ALL products in ONE response ──────
// The /category pages need no further requests. It is built once, kept as a
// ready-made JSON string, served from memory in a few milliseconds, rebuilt in
// the background when it gets old, and rebuilt straight away after any change.
const STOREFRONT_TTL   = 20 * 1000;
let storefrontCache    = null;      // { at, body }
let storefrontBuilding = null;      // in-flight build shared by everyone who asks meanwhile

const clearProductCache = () => {
  productListCache.clear();
  storefrontCache = null;
  setImmediate(() => { buildStorefront().catch(() => {}); });   // rebuild before the next visitor asks
};
const emitStockUpdate   = (p) => {
  clearProductCache();
  if (!p) return _emitStockUpdate(p);
  // live updates carry displayable (presigned) image URLs, never raw S3 keys
  images.signProduct(p).then(_emitStockUpdate, () => _emitStockUpdate(p));
};

// "in_stock" | "low_stock" | "sold_out" — sent with every product so the
// storefront can show availability without recalculating it
const availabilityOf = (p) => {
  const stock = Number(p.stock) || 0;
  if (p.soldOut || stock <= 0) return "sold_out";
  if (stock <= 3)              return "low_stock";
  return "in_stock";
};

function buildStorefront() {
  if (storefrontBuilding) return storefrontBuilding;
  storefrontBuilding = (async () => {
    await waitForDB();
    const [cats, prods] = await Promise.all([
      Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      Product.find({}).sort({ createdAt: -1 }).select("-description").lean(),
    ]);

    // product counts straight from the products already loaded (works whether
    // categoryId was stored as an ObjectId or as text)
    const counts = new Map();
    prods.forEach((p) => {
      if (p.categoryId) {
        const k = String(p.categoryId);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    });

    const body = JSON.stringify({
      categories: await images.signAll(cats.map((c) => {
        const n = counts.get(String(c._id)) || 0;
        return { ...c, productCount: n, category: c.name, count: n };
      }), images.signCategory),
      products: await images.signAll(prods.map((p) => ({ ...p, availability: availabilityOf(p) })), images.signProduct),
    });
    storefrontCache = { at: Date.now(), body };
    return storefrontCache;
  })().finally(() => { storefrontBuilding = null; });
  return storefrontBuilding;
}

const { notifyAdminWhatsApp } = require("./whatsappNotify");
const app        = express();
const httpServer = require("http").createServer(app);
initSocket(httpServer);

// ── CORS ──────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials:    true,
  methods:        ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-token"],
}));
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin",      req.headers.origin || "*");
    res.header("Access-Control-Allow-Methods",     "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers",     "Content-Type,Authorization,x-admin-token");
    res.header("Access-Control-Allow-Credentials", "true");
    return res.sendStatus(200);
  }
  next();
});
// gzip every JSON response — product lists shrink ~5-10x, so they download far faster
app.use(compression());
// keep the raw body: Razorpay webhook signatures are computed over it
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ── Upload folder ─────────────────────────────────────
const UPLOAD_DIR = "uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR));

// ── Cloudinary ────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const cloudStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          "mana-vastralu",
    allowed_formats: ["jpg","jpeg","png","webp"],
    transformation:  [{ width:800, height:1000, crop:"limit", quality:"auto" }],
  },
});

// ── AWS S3 (private bucket) ───────────────────────────
// Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (read by the SDK
// itself — never logged). MongoDB stores object keys; responses get presigned URLs.
const s3 = new S3Client({ region: process.env.AWS_REGION });
const images = createS3Images({
  s3, PutObjectCommand, GetObjectCommand, getSignedUrl,
  bucket:    process.env.S3_BUCKET_NAME,
  region:    process.env.AWS_REGION,
  prefix:    process.env.S3_KEY_PREFIX || "mana-vastralu",
  expiresIn: Number(process.env.S3_SIGNED_URL_EXPIRES) || 3600,
});
// IMAGE_STORAGE=s3 (default) → new uploads go to S3.  IMAGE_STORAGE=cloudinary → old behaviour.
const IMAGE_STORAGE = (process.env.IMAGE_STORAGE || "s3").toLowerCase();
const upload = IMAGE_STORAGE === "cloudinary"
  ? multer({ storage: cloudStorage })
  : createS3Upload({
      multer, images,
      kindFor: (req) => (String(req.originalUrl).includes("/categories") ? "categories" : "products"),
      // nothing reaches S3 without the admin password (body or query, like other admin routes)
      isAuthorized: (req) => ((req.body && req.body.password) || req.query.password) === ADMIN_PASS,
    });
console.log(`🖼️  Image uploads → ${IMAGE_STORAGE}${IMAGE_STORAGE === "s3" ? (images.configured() ? ` (bucket ${process.env.S3_BUCKET_NAME})` : " ⚠️ S3_BUCKET_NAME / AWS_REGION NOT SET") : ""}`);

// ══════════════════════════════════════════════════════
//  MONGODB — single connection, single reconnect path
// ══════════════════════════════════════════════════════
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS:          45000,
  connectTimeoutMS:         30000,
  heartbeatFrequencyMS:     10000,
  maxPoolSize:              10,
  minPoolSize:              1,
  family:                   4,
  retryWrites:              true,
  retryReads:               true,
};

let mongoConnecting = false;

async function connectMongoose() {
  if (mongoConnecting || mongoose.connection.readyState === 1) return;
  mongoConnecting = true;
  try {
    await mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS);
    console.log("✅ Mongoose connected | DB:", mongoose.connection.name);
  } catch (err) {
    console.error("❌ Mongoose connect failed:", err.message);
  } finally {
    mongoConnecting = false;
  }
}
connectMongoose();

mongoose.connection.on("disconnected", () => {
  console.log("⚠️  Mongoose disconnected — will retry in 8s");
  setTimeout(connectMongoose, 8000);
});
mongoose.connection.on("error", (err) => {
  console.error("❌ Mongoose error:", err.message);
});
mongoose.connection.on("reconnected", () => {
  console.log("✅ Mongoose reconnected");
});

const waitForDB = () => new Promise((resolve, reject) => {
  if (mongoose.connection.readyState === 1) return resolve();
  let tries = 0;
  const check = setInterval(() => {
    if (mongoose.connection.readyState === 1) {
      clearInterval(check); resolve();
    } else if (++tries > 20) {
      clearInterval(check);
      reject(new Error("MongoDB not ready after 10s"));
    }
  }, 500);
});

const usersCol     = () => mongoose.connection.readyState === 1 ? mongoose.connection.db.collection("users") : null;
const addressesCol = () => mongoose.connection.readyState === 1 ? mongoose.connection.db.collection("addresses") : null;

// ── Models ────────────────────────────────────────────
const Product = require("./models/Product");
const Order   = require("./models/Order");
const PendingCheckout = require("./models/PendingCheckout");

// Indexes make the product list / category lookups fast as the catalogue grows.
// Safe to repeat — creating an index that already exists does nothing.
mongoose.connection.on("connected", () => {
  Product.collection.createIndex({ createdAt: -1 }).catch(() => {});
  Product.collection.createIndex({ categoryId: 1 }).catch(() => {});
  Product.collection.createIndex({ category: 1 }).catch(() => {});
  buildStorefront().catch(() => {});      // first visitor already finds it ready
});

// ── Unread-order tracking (adminViewedAt) ─────────────────────────────────
// One-time, safe to repeat: every order that has NO adminViewedAt field yet
// (all historical orders) is marked as already viewed at its creation time,
// so old orders never show up as "new". New orders carry adminViewedAt:null.
mongoose.connection.on("connected", async () => {
  try {
    const r = await Order.collection.updateMany(
      { adminViewedAt: { $exists: false } },
      [{ $set: { adminViewedAt: { $ifNull: ["$createdAt", "$$NOW"] } } }]
    );
    if (r.modifiedCount) console.log(`✅ Migrated ${r.modifiedCount} old orders → adminViewedAt set`);
    Order.collection.createIndex({ adminViewedAt: 1 }).catch(() => {});
    Order.collection.createIndex({ razorpay_id: 1 }).catch(() => {});
    // one order per Razorpay payment, even if browser + webhook both try to save it
    Order.collection.createIndex(
      { paymentId: 1 },
      { unique: true, partialFilterExpression: { paymentId: { $gt: "" } } }
    ).catch((e) => console.warn("paymentId unique index not created (duplicates exist?):", e.message));
    // Orders saved before this fix already had their stock reduced by the old
    // code → mark them, so nothing can ever reduce their stock a second time.
    const s = await Order.collection.updateMany(
      { stockDeductedAt: { $exists: false } },
      [{ $set: { stockDeductedAt: { $ifNull: ["$createdAt", "$$NOW"] } } }]
    );
    if (s.modifiedCount) console.log(`✅ Marked ${s.modifiedCount} old orders as stock-already-deducted`);
    // saved carts must never be auto-deleted; warn until the old TTL index is removed
    const pIdx = await PendingCheckout.collection.indexes().catch(() => []);
    if (pIdx.some(i => i.expireAfterSeconds !== undefined))
      console.warn("⚠️ pendingcheckouts still has an auto-delete (TTL) index — run: node scripts/pending-checkout-ttl.js --apply");
  } catch (e) { console.error("adminViewedAt migration:", e.message); }
});
const User    = require("./models/User");
const Category = require("./models/Category");                        // NEW
const syncProductCategory = require("./middleware/syncProductCategory"); // NEW

// ── Email service ─────────────────────────────────────
let sendCustomerEmail = async () => {};
let sendAdminEmail    = async () => {};
let sendOTPEmail      = async (email, otp) => {
  console.log(`🔐 OTP for ${email}: ${otp}`);
};
let emailSvc = {};
try {
  const svc     = require("./emailService");
  emailSvc          = svc;
  sendCustomerEmail = svc.sendCustomerEmail || sendCustomerEmail;
  sendAdminEmail    = svc.sendAdminEmail    || sendAdminEmail;
  sendOTPEmail      = svc.sendOTPEmail      || sendOTPEmail;
  console.log("✅ emailService loaded");
} catch (e) { console.log("⚠️ emailService not found:", e.message); }

// ── Constants ─────────────────────────────────────────
const otpStore      = {};
const ADMIN_PASS    = process.env.ADMIN_PASS || "admin123";
const getAdminEmail = () => process.env.ADMIN_EMAIL || process.env.GMAIL_USER;

const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:8000";


// ── Razorpay config ───────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.log("⚠️ Razorpay keys NOT SET in .env");
} else {
  console.log(`✅ Razorpay configured | key:${process.env.RAZORPAY_KEY_ID}`);
}
if (!process.env.RAZORPAY_WEBHOOK_SECRET) console.log("⚠️ RAZORPAY_WEBHOOK_SECRET NOT SET — paid orders are not protected if the browser closes");

// ── Paid-order pipeline (browser, webhook, reconciler, recovery script) ────
const PaymentAlert       = require("./models/PaymentAlert");
const PaymentEvent       = require("./models/PaymentEvent");
const mongoStore         = require("./services/mongoStore");
const createPaymentOrders = require("./services/paymentOrders");
const { withRetry }      = createPaymentOrders;
const makeAlertEmail     = require("./services/alertEmail");

const notifyNewOrder = async (order) => {
  // e-mails show product photos for up to 7 days (signed URLs cannot last longer)
  const signed = await images.signOrder(order, { expires: 7 * 24 * 3600 }).catch(() => order);
  const products = signed.products || order.products || [];
  const total    = order.totalAmount || order.total_amount;
  const payMethod = order.paymentMethod || order.payment_method;
  const labelUrl = `${BACKEND_URL}/api/orders/${order._id}/shipping-label`;
  try { notifyAdminWhatsApp(order); } catch (e) { console.error("WhatsApp notify:", e.message); }
  const realEmail = order.email && !/^guest@gmail\.com$/i.test(order.email) ? order.email : "";
  Promise.all([
    realEmail && sendCustomerEmail({ email: realEmail, orderId: order._id, products, totalAmount: total, address: order.address, paymentMethod: payMethod }).catch(e => console.error("Customer email:", e.message)),
    sendAdminEmail({ email: order.email, orderId: order._id, products, totalAmount: total, address: order.address, paymentMethod: payMethod, labelUrl }).catch(e => console.error("Admin email:", e.message)),
  ]);
};

const orderStore = mongoStore({ Order, Product, PendingCheckout, PaymentAlert, PaymentEvent, waitForDB });
const payments = createPaymentOrders({
  store: orderStore, razorpay,
  emitStockUpdate,
  onNewOrder: notifyNewOrder,
  sendAlertEmail: makeAlertEmail(emailSvc),
});

// ── Shipping label ────────────────────────────────────
const STORE = {
  name:    "Reshma",
  address: "H No: 5-94/260, Srujanalaxmi Nagar,\nRoad No-7, Phase-2, Patelguda,\nPatancheru, Hyderabad,\nTelangana — 502319",
  phone:   "9390905464",
  insta:   "mana_vastralu",
};

function generateShippingLabel(order) {
  const addr    = order.address || {};
  const items   = order.products || order.items || [];
  const shortId = String(order._id).slice(-8).toUpperCase();
  const date    = new Date().toLocaleDateString("en-IN",{ day:"2-digit", month:"short", year:"numeric" });
  const toName  = addr.fullName || addr.name || "Customer";
  const toPhone = addr.phone || "";
  const toAddr  = [addr.houseNo, addr.landmark, addr.village, addr.district].filter(Boolean).join(",\n");
  const toState = addr.state || "";
  const toPin   = addr.pincode || "";
  const total   = Number(order.total_amount||order.totalAmount||0).toLocaleString("en-IN");
  const pay     = order.paymentMethod || order.payment_method || "Online";
  const itemRows = items.map(item => `
    <tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f0e0c8;font-size:12px">${item.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f0e0c8;font-size:12px;text-align:center">${item.selectedSize||item.size||"—"}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f0e0c8;font-size:12px;text-align:center">${item.quantity||1}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f0e0c8;font-size:12px;text-align:right">₹${(Number(item.price||0)*(item.quantity||1)).toLocaleString("en-IN")}</td>
    </tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Label #${shortId}</title>
<style>*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:sans-serif;background:#f5e8d8;padding:20px;display:flex;flex-direction:column;align-items:center}.no-print{margin-bottom:14px}.no-print button{background:#3d1a0e;color:#e8d5a3;border:none;padding:11px 28px;font-size:14px;font-weight:700;cursor:pointer;border-radius:4px}.label{width:210mm;background:#fff9f4;border:2px solid #c9853a;border-radius:6px;overflow:hidden}.gold-strip{height:6px;background:linear-gradient(90deg,#c9853a,#e8b97a,#c9853a)}.label-body{display:grid;grid-template-columns:1fr 155px;min-height:130mm}.label-left{padding:16px 18px;border-right:1px dashed #c9853a;display:flex;flex-direction:column;gap:12px}.addr-tag{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c9853a;margin-bottom:6px}.addr-name{font-size:16px;font-weight:700;color:#1a1008;margin-bottom:3px}.addr-text{font-size:12px;color:#5a3a22;line-height:1.65;white-space:pre-line}.addr-phone{font-size:13px;font-weight:600;color:#3d1a0e;margin-top:5px}.divider{border:none;border-top:1px dashed #c9853a;margin:4px 0}.label-right{padding:14px 12px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#fffaf5,#fdf0e0)}.brand-circle{width:126px;min-height:126px;border-radius:8px;border:3px solid #c9853a;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12px}.brand-title{font-size:17px;font-weight:700;color:#3d1a0e;line-height:1.1;margin-bottom:4px}.thank-badge{font-size:11px;font-style:italic;color:#7a5030;text-align:center;padding:6px 8px;border:1px solid rgba(201,133,58,0.3);border-radius:3px;background:#fffaf5;width:100%}.order-meta{display:flex;gap:16px;padding:8px 18px;background:#fdf6ee;border-top:1px solid #f0e0c8;border-bottom:1px solid #f0e0c8;font-size:11px;color:#7a5030}.items-section{padding:8px 18px;border-bottom:1px solid #f0e0c8}.items-title{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9853a;margin-bottom:6px}table{width:100%;border-collapse:collapse}thead th{background:#fdf6ee;font-size:9px;font-weight:700;color:#9a7050;padding:5px 8px;text-align:left}.total-bar{background:#3d1a0e;color:#e8d5a3;padding:8px 14px;margin-top:8px;font-weight:700;font-size:13px;display:flex;justify-content:space-between}.label-footer{background:#fae8d8;padding:8px 18px;border-top:1px solid #e8d0b0;display:flex;justify-content:space-between;align-items:center}@media print{body{background:#fff;padding:0}.no-print{display:none!important}.label{box-shadow:none}@page{size:A5 landscape;margin:5mm}}</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨️ Print Shipping Label</button></div>
<div class="label">
  <div class="gold-strip"></div>
  <div class="label-body">
    <div class="label-left">
      <div><div class="addr-tag">📍 Deliver To</div><div class="addr-name">TO, ${toName}</div><div class="addr-text">${toAddr}</div><div class="addr-text">${toState}${toPin?`,\nPin code: ${toPin}`:""}</div>${toPhone?`<div class="addr-phone">📞 ${toPhone}</div>`:""}</div>
      <hr class="divider"/>
      <div><div class="addr-tag">📦 From</div><div class="addr-name">Name : ${STORE.name}</div><div class="addr-text">${STORE.address}</div><div class="addr-phone">Contact: ${STORE.phone}</div></div>
    </div>
    <div class="label-right">
      <div class="brand-circle"><div class="brand-title">Mana<br/>Vastralu</div><div style="font-size:7px;color:#c9853a;margin-bottom:5px">— Mana Gurthimpu —</div><div style="font-size:9px;color:#3d1a0e;text-align:center"><div style="color:#c9853a">📸 ${STORE.insta}</div><div>📞 ${STORE.phone}</div></div></div>
      <div class="thank-badge">THANK YOU<br/><span style="font-size:9px;font-style:italic">for your purchase</span></div>
    </div>
  </div>
  <div class="order-meta"><div>Payment: <strong>${pay}</strong></div>${order.paymentId?`<div>Pay ID: <strong>${order.paymentId}</strong></div>`:""}<div>Total: <strong>₹${total}</strong></div><div>Status: <strong style="color:#2e7d32">✅ Confirmed</strong></div></div>
  <div class="items-section"><div class="items-title">Items Ordered</div><table><thead><tr><th>Product</th><th>Size</th><th>Qty</th><th>Price</th></tr></thead><tbody>${itemRows}</tbody></table><div class="total-bar"><span>Total Amount</span><span>₹${total}</span></div></div>
  <div class="label-footer"><div><div style="font-size:13px;font-weight:600;color:#3d1a0e">Mana Vastralu</div><div style="font-size:9px;color:#c9853a">@${STORE.insta}</div></div><div style="font-size:10px;color:#7a5030;text-align:right">${STORE.phone}<br/>manavastralu@gmail.com</div></div>
  <div class="gold-strip"></div>
</div></body></html>`;
}

// ══════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════
app.get("/", (req, res) => res.json({
  success: true, message: "✅ Mana Vastralu Backend Running",
  mongo: mongoose.connection.readyState === 1 ? "connected" : "connecting",
}));
app.get("/api/health", (req, res) =>
  res.status(200).json({
    status:"ok", time:new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? "connected" : "not connected",
    razorpayMode: String(process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_live_") ? "live" : (process.env.RAZORPAY_KEY_ID ? "test" : "not set"),
    webhookSecretSet: !!process.env.RAZORPAY_WEBHOOK_SECRET,
    imageStorage: IMAGE_STORAGE, s3Configured: images.configured(),
  })
);
app.get("/api/orders/:id/shipping-label", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error:"Order not found" });
    res.setHeader("Content-Type", "text/html");
    res.send(generateShippingLabel(order));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════
//  RAZORPAY
// ══════════════════════════════════════════════════════
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount, draft } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ message: "Valid amount is required" });
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      return res.status(500).json({ message: "Razorpay keys not configured in .env" });

    const amountInPaise = Math.round(Number(amount) * 100);
    const d = draft && typeof draft === "object" ? images.sanitizeDeep(draft) : null;   // keys, never signed URLs
    const a = d?.address || {};

    const order = await withRetry(() => razorpay.orders.create({
      amount:   amountInPaise,
      currency: "INR",
      receipt:  `rcpt_${Date.now()}`,
      // small backup copy inside Razorpay itself (shown in reconcile reports)
      notes: d ? {
        email:   String(d.email || "").slice(0, 200),
        phone:   String(a.phone || d.phone || "").slice(0, 20),
        name:    String(a.fullName || a.name || "").slice(0, 100),
        pincode: String(a.pincode || "").slice(0, 10),
        items:   (d.products || d.items || d.cart || []).map(i => `${i.name || ""} ${i.selectedSize || i.size || ""} x${i.quantity || 1}`).join(" | ").slice(0, 250),
      } : {},
    }), { label: "razorpay order" });

    console.log("✅ Razorpay order created:", order.id, "| amount:", amountInPaise);

    // Save the cart/address NOW, before the customer pays. If the browser dies
    // after payment, the webhook / reconciler create the order from this copy.
    // If it cannot be saved we refuse to start the payment (the customer has not
    // paid anything yet, so it is safe to ask them to try again).
    if (d) {
      try {
        await withRetry(() => orderStore.savePending(order.id, d, { amountPaise: amountInPaise }), { label: "save cart" });
      } catch (e) {
        console.error("❌ PendingCheckout save failed — payment NOT started:", e.message);
        return res.status(503).json({ message: "Could not start payment, please try again in a moment." });
      }
    } else {
      console.warn("⚠️ create-order called without `draft` — update Checkout to send the cart (see frontend/src/utils/razorpayCheckout.js)");
    }

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("❌ Razorpay create-order error (full):", JSON.stringify(err, null, 2));
    const razorpayMsg = err?.error?.description || err?.message || "Could not create Razorpay order";
    res.status(err?.statusCode || 500).json({ message: razorpayMsg });
  }
});

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ success:false, message:"Missing payment verification fields" });

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const isValid = expectedSignature === razorpay_signature;

    if (isValid) {
      console.log("✅ Razorpay payment verified:", razorpay_payment_id);
      return res.json({ success:true });
    } else {
      console.warn("❌ Razorpay signature mismatch:", razorpay_payment_id);
      return res.status(400).json({ success:false, message:"Signature verification failed" });
    }
  } catch (err) {
    console.error("❌ Razorpay verify error (full):", JSON.stringify(err, null, 2));
    res.status(500).json({ success:false, message: err?.error?.description || err?.message || "Verification failed" });
  }
});

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════
app.post("/api/auth/login", async (req, res) => {
  const { email, name, photo } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { email },
      { name, photo, lastLogin:new Date(), $inc:{ loginCount:1 }, $setOnInsert:{ createdAt:new Date() } },
      { upsert:true, new:true }
    );
    res.json({ success:true, user });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await usersCol()?.findOne({ email });
    if (existing) return res.status(400).json({ message:"User already exists" });
    const hashed = await bcrypt.hash(password, 10);
    await usersCol()?.insertOne({ name, email, password:hashed });
    res.json({ message:"User registered successfully" });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await usersCol()?.findOne({ email });
    if (!user) return res.status(400).json({ message:"User not found" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message:"Incorrect password" });
    await usersCol()?.updateOne({ email },{ $set:{ last_login:new Date() } });
    res.json({ message:"Login successful", user:email });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/users", async (req, res) => {
  try { res.json(await usersCol()?.find({},{ projection:{ password:0 } }).toArray() || []); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/save-address", async (req, res) => {
  try {
    const data = req.body;
    if (!data.email) return res.status(400).json({ message:"Email required" });
    await usersCol()?.updateOne({ email:data.email },{ $set:{ address:data } },{ upsert:true });
    res.json({ message:"Address saved" });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/add-address", async (req, res) => {
  try {
    await addressesCol()?.insertOne(req.body);
    res.json({ message:"Address saved" });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════
//  PRODUCTS
// ══════════════════════════════════════════════════════
app.post("/api/products/check-stock", async (req, res) => {
  try {
    const { productId, color, size, quantity=1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error:"Product not found" });

    let available = Number(product.stock) || 0;

    if (size && product.sizeStock && product.sizeStock.get) {
      const sizeQty = product.sizeStock.get(size);
      if (sizeQty !== undefined) available = Number(sizeQty) || 0;
    } else if (size && product.sizeStock && product.sizeStock[size] !== undefined) {
      available = Number(product.sizeStock[size]) || 0;
    } else if (product.colorVariants?.length > 0 && color) {
      const v = product.colorVariants.find(v => v.name.toLowerCase() === color.toLowerCase());
      if (v) available = Number(v.stock) || 0;
    }

    res.json({ available, soldOut:available===0, canAdd:available>=quantity });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/products", async (req, res) => {
  try {
    const { category, view } = req.query;           // view=card → lighter list (no description)
    const key = `${category || ""}|${view || ""}`;

    // browsers / CDNs may reuse the answer for a few seconds, then refresh in the background
    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");

    const hit = productListCache.get(key);
    if (hit && Date.now() - hit.at < PRODUCT_CACHE_TTL) {
      return res.type("application/json").send(hit.body);   // no DB, no JSON.stringify
    }

    await waitForDB();
    const filter = {};
    if (category && category !== "All") {
      filter.category = { $regex: `^${category}$`, $options: "i" };
    }
    let q = Product.find(filter).sort({ createdAt:-1 }).lean();   // lean = plain objects, much faster
    if (view === "card") q = q.select("-description");
    const list = await images.signAll((await q).map(p => ({ ...p, availability: availabilityOf(p) })), images.signProduct);

    const body = JSON.stringify(list);
    if (productListCache.size > 50) productListCache.clear();    // never let it grow unbounded
    productListCache.set(key, { at: Date.now(), body });
    res.type("application/json").send(body);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// NEW: categories are now real database records (see routes/categories.js).
// This replaces the old /api/categories that grouped products by name.
app.use(require("./routes/categories")({
  upload, adminPass: ADMIN_PASS, waitForDB, Product, images,
  onChange: clearProductCache,            // categories changed → refresh the storefront snapshot
}));

// ✅ ONE request for the whole storefront (categories + products).
//    Served from memory; if it is a little old it is returned instantly and
//    refreshed in the background, so visitors never wait on the database.
app.get("/api/storefront", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=120");
    let hit = storefrontCache;
    if (hit && Date.now() - hit.at < images.maxResponseAgeMs()) {   // never serve expired image links
      if (Date.now() - hit.at > STOREFRONT_TTL) buildStorefront().catch(() => {});
      return res.type("application/json").send(hit.body);
    }
    hit = await buildStorefront();
    res.type("application/json").send(hit.body);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const p = await Product.findById(req.params.id).lean();
    if (!p) return res.status(404).json({ error:"Not found" });
    res.set("Cache-Control", "no-cache");
    res.json(await images.signProduct({ ...p, availability: availabilityOf(p) }));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/api/products", (req, res, next) => {
  upload.fields([{ name:"images", maxCount:4 },{ name:"variantImages", maxCount:20 }])(req, res, err => {
    if (err) return res.status(err.status || 500).json({ error:"Upload failed: " + err.message });
    next();
  });
}, syncProductCategory, async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color,
            stock, category, categoryId, colorVariants, sizeStock } = req.body;
    if (!name || !price) return res.status(400).json({ error:"Name and price required" });

    const getUrl = f => f.path || f.secure_url || ("uploads/" + f.filename);
    const imageKeys = (req.files?.["images"]||[]).map(getUrl).filter(Boolean);   // (not `images`: that name is the S3 helper)

    let parsedVariants = [];
    if (colorVariants) {
      try {
        const vf = req.files?.["variantImages"] || [];
        parsedVariants = JSON.parse(colorVariants).map((v,i) => ({
          name:v.name, stock:Number(v.stock)||10,
          image:vf[i]?getUrl(vf[i]):(imageKeys[0]||""),
        })).filter(v => v.name.trim() !== "");
      } catch(e) { console.warn("colorVariants parse:", e.message); }
    }

    let parsedSizes = [];
    try {
      parsedSizes = sizes
        ? (typeof sizes==="string" && sizes.startsWith("[")
            ? JSON.parse(sizes)
            : sizes.split(",").map(s=>s.trim()).filter(Boolean))
        : [];
    } catch { parsedSizes = []; }

    let parsedSizeStock = {};
    try {
      parsedSizeStock = sizeStock ? JSON.parse(sizeStock) : {};
    } catch { parsedSizeStock = {}; }

    const totalStock = parsedSizes.length > 0 && Object.keys(parsedSizeStock).length > 0
      ? Object.values(parsedSizeStock).reduce((s,v) => s+Number(v||0), 0)
      : Number(stock) || 10;

    const product = await Product.create({
      name:name.trim(), description:description||"",
      price:Number(price), originalPrice:Number(originalPrice)||Number(price),
      sizes:parsedSizes, colorVariants:parsedVariants,
      fabric:fabric||"",
      color:color||parsedVariants.map(v=>v.name).join(", ")||"ALL COLOURS",
      category:category||"",
      categoryId: categoryId || undefined,
      stock:totalStock,
      soldOut:totalStock===0,
      images: imageKeys,
      sizeStock: parsedSizeStock,
    });

    console.log("✅ Product created:", product._id, "| sizeStock:", parsedSizeStock);
    emitStockUpdate(product);
    res.json(await images.signProduct(product));
  } catch (err) {
    console.error("Product create error:", err.message);
    res.status(500).json({ error:err.message });
  }
});

app.put("/api/products/:id", syncProductCategory, async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color,
            stock, category, categoryId, soldOut, colorVariants, sizeStock } = req.body;

    const parsedSizes = typeof sizes === "string"
      ? sizes.split(",").map(s => s.trim()).filter(Boolean)
      : (sizes || []);

    const parsedSizeStock = sizeStock || {};

    const totalStock = parsedSizes.length > 0 && Object.keys(parsedSizeStock).length > 0
      ? Object.values(parsedSizeStock).reduce((s, v) => s + Number(v || 0), 0)
      : Number(stock) || 0;

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    product.name          = name || product.name;
    product.description   = description || "";
    product.price         = Number(price);
    product.originalPrice = Number(originalPrice) || Number(price);
    product.sizes         = parsedSizes;
    product.fabric        = fabric || "";
    product.color         = color  || "";
    // categoryId is the source of truth; `category` is the name mirror set by syncProductCategory.
    // If a request sends neither, the product's category is left unchanged.
    if (categoryId) { product.categoryId = categoryId; product.category = category; }
    else if (category !== undefined) product.category = category || "";
    product.stock         = totalStock;
    product.soldOut       = totalStock === 0;
    product.sizeStock     = parsedSizeStock;
    product.colorVariants = images.sanitizeDeep(typeof colorVariants === "string"
      ? JSON.parse(colorVariants)
      : (colorVariants || []));      // a signed URL sent back by the browser is stored as its S3 key

    product.markModified("sizeStock");

    const updated = await product.save();
    console.log("✅ Product updated:", req.params.id, "| totalStock:", updated.stock);
    emitStockUpdate(updated);
    res.json(await images.signProduct(updated));
  } catch (err) {
    console.error("❌ Product update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    await Product.findByIdAndDelete(req.params.id);
    if (product) emitStockUpdate({ ...product.toObject(), stock: 0, soldOut: true });
    res.json({ success:true });
  }
  catch (err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════
// Every order — COD, Razorpay from the browser, Razorpay from the webhook,
// recovered by the reconciler — is created by services/paymentOrders.js, which
// guarantees one order per checkout and stock reduced at most once.
// HTTP behaviour lives in services/orderRoutes.js (tested in test/routes.test.js).
const routes = require("./services/orderRoutes")({ payments, backendUrl: BACKEND_URL });

// Used by the current Checkout page. COD → saved as Pending (cannot claim "Paid").
// Razorpay → saved ONLY after the payment is verified with Razorpay.
app.post("/add-order", async (req, res) => {
  const r = await routes.addOrder(images.sanitizeDeep(req.body || {}));
  res.status(r.status).json(r.json);
});

// Preferred endpoint after Razorpay checkout succeeds (see frontend/src/utils/razorpayCheckout.js).
// Safe to call many times — always returns the same order. 202 = paid, not captured yet.
app.post("/api/payment/confirm", async (req, res) => {
  const r = await routes.confirm(images.sanitizeDeep(req.body || {}));
  res.status(r.status).json(r.json);
});

// Razorpay calls this by itself when a payment succeeds — even if the customer's
// browser/phone closed. It answers 200 only AFTER the order is stored; on any
// failure it answers 500 so Razorpay retries.
app.post("/api/payment/razorpay/webhook", async (req, res) => {
  const r = await payments.handleWebhook({
    rawBody: req.rawBody, signature: req.headers["x-razorpay-signature"], body: req.body,
  }).catch((e) => ({ status: 500, json: { error: e.message } }));
  res.status(r.status).json(r.json);
});

// ── Reconciliation (Razorpay = source of truth for who paid) ──────────────
// GET  ...?password=&days=30                      → DRY-RUN report, changes nothing
// POST { password, days, apply:true, includeReview, placeholders, only:[payIds] } → recover
app.get("/api/admin/razorpay/reconcile", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    res.json(await payments.reconcile({ apply: false, days: Number(req.query.days) || 30, minAgeMinutes: 10 }));
  } catch (err) { res.status(500).json({ error: err.error?.description || err.message }); }
});
app.post("/api/admin/razorpay/reconcile", async (req, res) => {
  const b = req.body || {};
  if (b.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  if (b.apply !== true) return res.status(400).json({ error: "Send apply:true to change data. Use GET for a dry run." });
  try {
    res.json(await payments.reconcile({
      apply: true, days: Number(b.days) || 30, minAgeMinutes: 10, source: "recovery-admin",
      includeReview: !!b.includeReview, placeholders: !!b.placeholders,
      only: Array.isArray(b.only) && b.only.length ? b.only : null,
    }));
  } catch (err) { res.status(500).json({ error: err.error?.description || err.message }); }
});

// ── Automatic reconciliation every few minutes ────────────────────────────
// Recovers verified paid checkouts that neither the browser nor the webhook
// saved, and raises alerts for anything that needs a human.
const RECONCILE_EVERY_MIN = Number(process.env.RECONCILE_EVERY_MIN) || 5;
let reconcileRunning = false, lastReconcile = null, reconcileFailures = 0;
async function autoReconcile(trigger = "timer") {
  if (reconcileRunning || mongoose.connection.readyState !== 1 || !process.env.RAZORPAY_KEY_SECRET) return lastReconcile;
  reconcileRunning = true;
  try {
    const rep = await payments.reconcile({ apply: true, days: 3, minAgeMinutes: 10, source: "reconcile-auto", silent: false });
    lastReconcile = { at: rep.ranAt, trigger, paymentsChecked: rep.paymentsChecked, summary: rep.summary };
    const fixed = rep.rows.filter(r => r.action === "created").length;
    if (fixed) console.log(`🛟 Auto-reconcile recovered ${fixed} paid order(s)`);
  } catch (e) {
    lastReconcile = { at: new Date().toISOString(), trigger, error: e.message };
    console.error("Auto-reconcile failed:", e.message);
    reconcileFailures = (reconcileFailures || 0) + 1;
    if (reconcileFailures === 3) payments.alert("RECONCILE_FAILING", new Date().toISOString().slice(0, 10), `Automatic payment check failed 3 times in a row: ${e.message}`).catch(() => {});
    return lastReconcile;
  } finally { reconcileRunning = false; }
  reconcileFailures = 0;
  return lastReconcile;
}
setTimeout(() => autoReconcile("startup"), 60 * 1000);
setInterval(() => autoReconcile("timer"), RECONCILE_EVERY_MIN * 60 * 1000);

// Render's free plan sleeps; an external cron (e.g. cron-job.org every 5 min)
// can call this to wake the server AND run the check.
app.post("/api/cron/reconcile", async (req, res) => {
  const key = process.env.CRON_KEY;
  if (!key || (req.query.key || req.headers["x-cron-key"]) !== key) return res.status(401).json({ error: "Unauthorized" });
  res.json(await autoReconcile("cron"));
});

// ── Payment alerts (shown in the Admin Dashboard) ─────────────────────────
app.get("/api/admin/payment-alerts", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    const filter = req.query.all === "1" ? {} : { resolvedAt: null };
    res.set("Cache-Control", "no-store");
    res.json({ alerts: await PaymentAlert.find(filter).sort({ lastSeenAt: -1 }).limit(200).lean(), lastReconcile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Audit trail for one payment / checkout:  ?password=...&paymentId=pay_XXX  (or &razorpayOrderId=order_XXX)
app.get("/api/admin/payment-events", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    const q = {};
    if (req.query.paymentId) q.paymentId = String(req.query.paymentId);
    if (req.query.razorpayOrderId) q.razorpayOrderId = String(req.query.razorpayOrderId);
    res.set("Cache-Control", "no-store");
    res.json(await PaymentEvent.find(q).sort({ at: Object.keys(q).length ? 1 : -1 }).limit(200).lean());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put("/api/admin/payment-alerts/:id/resolve", async (req, res) => {
  if (req.body?.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "bad id" });
    await PaymentAlert.updateOne({ _id: req.params.id }, { $set: { resolvedAt: new Date() } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read-only health check of the orders collection (no customer details returned).
//   GET /api/admin/orders/diagnose?password=...
app.get("/api/admin/orders/diagnose", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    const col = Order.collection;
    const [total, byStatus, byPay, noCreatedAt, noEmail, dupPay, latest, pendingOpen, needsReview] = await Promise.all([
      col.countDocuments({}),
      col.aggregate([{ $group:{ _id:"$status", n:{ $sum:1 } } }]).toArray(),
      col.aggregate([{ $group:{ _id:"$paymentStatus", n:{ $sum:1 } } }]).toArray(),
      col.countDocuments({ createdAt: { $exists:false } }),
      col.countDocuments({ $or:[{ email:{ $exists:false } },{ email:"" }] }),
      col.aggregate([{ $match:{ paymentId:{ $gt:"" } } },{ $group:{ _id:"$paymentId", n:{ $sum:1 } } },{ $match:{ n:{ $gt:1 } } }]).toArray(),
      col.find({}, { projection:{ createdAt:1, status:1, paymentStatus:1, paymentId:1, source:1 } }).sort({ createdAt:-1 }).limit(15).toArray(),
      PendingCheckout.countDocuments({ status: { $ne: "completed" } }),
      col.countDocuments({ needsReview: { $gt: "" } }),
    ]);
    res.json({
      totalOrdersInDatabase: total,
      byStatus, byPaymentStatus: byPay,
      ordersWithoutCreatedAt: noCreatedAt, ordersWithoutEmail: noEmail,
      duplicatePaymentIds: dupPay.map(d => ({ paymentId: d._id, count: d.n })),
      guestOrders: await col.countDocuments({ email: /^guest@gmail\.com$/i }),
      ordersNeedingReview: needsReview,
      openPendingCheckouts: pendingOpen,   // includes carts that were never paid
      lastReconcile,
      latest15: latest.map(o => ({ idSuffix: String(o._id).slice(-6), createdAt: o.createdAt, status: o.status, paymentStatus: o.paymentStatus, source: o.source || "", hasPaymentId: !!o.paymentId })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A customer's orders: their email (any capitalisation) PLUS
//   • orders whose IDs this device remembers (strong match), and
//   • orders that were saved as "guest" with the customer's own phone number.
// That way an order is never "lost" just because the email was missing when it was placed.
const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const myOrders = async (req, res) => {
  try {
    await waitForDB();
    const or = [];
    const email = String(req.params.email || "").trim();
    if (email && !/^guest@gmail\.com$/i.test(email)) or.push({ email: { $regex: `^${escapeRe(email)}$`, $options: "i" } });

    const ids = String(req.query.ids || "").split(",").map(x => x.trim()).filter(x => mongoose.isValidObjectId(x)).slice(0, 100);
    if (ids.length) or.push({ _id: { $in: ids.map(x => new mongoose.Types.ObjectId(x)) } });

    const phones = [...new Set(String(req.query.phones || "").split(",")
      .map(x => x.replace(/\D/g, "").slice(-10)).filter(x => x.length === 10))].slice(0, 5);
    if (phones.length) {
      const variants = phones.flatMap(d => [d, `91${d}`, `+91${d}`, `${d.slice(0,5)} ${d.slice(5)}`]);
      or.push({ email: /^guest@gmail\.com$/i, $or: [{ "address.phone": { $in: variants } }, { phone: { $in: variants } }] });
    }
    if (!or.length) return res.json([]);
    res.json(await images.signAll(await Order.find({ $or: or }).sort({ createdAt: -1 }).lean(), images.signOrder));
  } catch (err) { res.status(500).json({ error: err.message }); }
};
app.get("/my-orders/:email", myOrders);
app.get("/api/orders/:email", myOrders);

// ══════════════════════════════════════════════════════
//  ADMIN
// ══════════════════════════════════════════════════════
app.get("/api/admin/users", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    res.json(await User.find().sort({ lastLogin:-1 }));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/products", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    res.json(await images.signAll(await Product.find().sort({ createdAt:-1 }), images.signProduct));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ── Unread orders badge ─────────────────────────────────────────────────────
// NOTE: these must stay ABOVE `PUT /api/admin/orders/:id`, otherwise
// "mark-viewed" would be read as an order id.
const isAdminReq = (req) => (req.query.password || req.body?.password) === ADMIN_PASS;

app.get("/api/admin/orders/unread-count", async (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    res.set("Cache-Control", "no-store");
    const unreadCount = await Order.collection.countDocuments({
      adminViewedAt: null,                 // null OR missing
      status: { $ne: "Cancelled" },
    });
    res.json({ unreadCount });
  } catch (err) { res.status(500).json({ message:"Failed to get unread order count" }); }
});

// body: { password, ids?: [orderId,...] }
// With `ids` only those orders are marked (so an order that arrives while the
// admin's list is loading is NOT marked by mistake). Without `ids`, all unseen.
app.put("/api/admin/orders/mark-viewed", async (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    const filter = { adminViewedAt: null };
    if (Array.isArray(req.body.ids)) {
      filter._id = { $in: req.body.ids.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id)) };
    }
    const r = await Order.collection.updateMany(filter, { $set: { adminViewedAt: new Date() } });
    res.json({ success:true, marked: r.modifiedCount });
  } catch (err) { res.status(500).json({ message:"Failed to mark orders as viewed" }); }
});

app.get("/api/admin/orders", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    res.json(await images.signAll(await Order.find().sort({ createdAt:-1 }).lean(), images.signOrder));   // lean keeps adminViewedAt
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put("/api/admin/orders/:id", async (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    const updated = await Order.findByIdAndUpdate(
      req.params.id,{ status:req.body.status },{ new:true }
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put("/api/admin/orders/:id/tracking", async (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    const { courierName, trackingNumber, estimatedDelivery, status } = req.body;
    const trackingUrl = courierName === "DTDC"
      ? `https://www.dtdc.in/trace.asp?txtnbr=${trackingNumber}`
      : `https://www.google.com/search?q=${courierName}+tracking+${trackingNumber}`;
    const updated = await Order.findByIdAndUpdate(req.params.id, {
      courierName, trackingNumber, trackingUrl, estimatedDelivery,
      status:status||"Shipped", shippedAt:new Date(),
    },{ new:true });
    res.json({ success:true, order:updated });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/stock-alerts", async (req, res) => {
  try {
    const alerts = [];
    const list   = await Product.find();
    list.forEach(p => {
      if (p.sizes?.length > 0 && p.sizeStock) {
        const sizeStockObj = p.sizeStock instanceof Map
          ? Object.fromEntries(p.sizeStock)
          : p.sizeStock;
        p.sizes.forEach(size => {
          const qty = Number(sizeStockObj[size] || 0);
          if (qty <= 3) alerts.push({
            productId:p._id, productName:p.name,
            size, stock:qty, soldOut:qty===0,
          });
        });
      } else if (p.colorVariants?.length > 0) {
        p.colorVariants.forEach(v => {
          if (v.stock <= 3) alerts.push({
            productId:p._id, productName:p.name,
            color:v.name, stock:v.stock, soldOut:v.stock===0,
          });
        });
      } else if (Number(p.stock) <= 3) {
        alerts.push({
          productId:p._id, productName:p.name,
          color:p.color||"—", stock:Number(p.stock), soldOut:p.soldOut,
        });
      }
    });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════
//  ADMIN OTP
// ══════════════════════════════════════════════════════
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

app.post("/api/admin/request-otp", async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS)
    return res.status(401).json({ success:false, message:"Incorrect password" });

  const otp        = generateOTP();
  const expiresAt  = Date.now() + 5 * 60 * 1000;
  const adminEmail = getAdminEmail();
  if (!adminEmail)
    return res.status(500).json({ success:false, message:"ADMIN_EMAIL not configured" });

  otpStore[adminEmail] = { otp, expiresAt, attempts:0 };
  console.log(`🔐 OTP for ${adminEmail}: ${otp}`);

  try {
    await sendOTPEmail(adminEmail, otp);
    res.json({ success:true, message:`OTP sent to ${adminEmail}` });
  } catch (err) {
    console.error("❌ OTP email failed:", err.message);
    res.json({ success:true, message:"OTP generated (check server logs)" });
  }
});

app.post("/api/admin/verify-otp", (req, res) => {
  const { otp }    = req.body;
  const adminEmail = getAdminEmail();
  const stored     = otpStore[adminEmail];

  if (!stored)
    return res.status(400).json({ success:false, message:"No OTP requested." });
  if (Date.now() > stored.expiresAt) {
    delete otpStore[adminEmail];
    return res.status(400).json({ success:false, message:"OTP expired." });
  }
  stored.attempts = (stored.attempts || 0) + 1;
  if (stored.attempts > 5) {
    delete otpStore[adminEmail];
    return res.status(429).json({ success:false, message:"Too many attempts. Request a new OTP." });
  }
  if (stored.otp !== String(req.body.otp || "").trim())
    return res.status(400).json({ success:false, message:"Incorrect OTP." });

  delete otpStore[adminEmail];
  const sessionToken = crypto.randomBytes(32).toString("hex");
  otpStore[`session_${sessionToken}`] = { expiresAt: Date.now() + 2*60*60*1000 };
  res.json({ success:true, sessionToken });
});

// ══════════════════════════════════════════════════════
//  KEEP-ALIVE PING
// ══════════════════════════════════════════════════════
if (process.env.BACKEND_URL) {
  setInterval(() => {
    try {
      const url = new URL(process.env.BACKEND_URL);
      const mod = url.protocol === "https:" ? https : http;
      mod.get(process.env.BACKEND_URL + "/api/health", (r) => {
        console.log(`💓 Keep-alive: ${r.statusCode}`);
      }).on("error", () => {});
    } catch {}
  }, 14 * 60 * 1000);
}

process.on("unhandledRejection", r => console.error("⚠️ Unhandled rejection:", r?.message || r));
process.on("uncaughtException",  e => console.error("⚠️ Uncaught exception:",  e.message));

const PORT = process.env.PORT || 8000;
httpServer.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`)
);