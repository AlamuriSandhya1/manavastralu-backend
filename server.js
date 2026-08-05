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
const { MongoClient } = require("mongodb");
const fs         = require("fs");
const crypto     = require("crypto");
const axios      = require("axios");
const http       = require("http");
const https      = require("https");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const Razorpay   = require("razorpay"); // ✅ ADDED — npm i razorpay
const { initSocket, emitStockUpdate } = require("./socket"); // ✅ ADDED — npm i socket.io

const app        = express();
const httpServer = require("http").createServer(app);
initSocket(httpServer); // ✅ ADDED — sets up Socket.IO on the same HTTP server

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
app.use(express.json());

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
const upload = multer({ storage: cloudStorage });

// ── MongoDB ───────────────────────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 60000,
  socketTimeoutMS:          60000,
  connectTimeoutMS:         60000,
  heartbeatFrequencyMS:     30000, // ← increase from 10000 to 30000
  maxPoolSize:              5,     // ← reduce from 10 to 5
  minPoolSize:              1,     // ← reduce from 2 to 1
  family:                   4,
  retryWrites:              true,
  retryReads:               true,
  // ✅ Add these for unstable networks:
  waitQueueTimeoutMS:       30000,
  maxIdleTimeMS:            270000,
};
// ── Mongoose connect with auto-retry ─────────────────
async function connectMongoose() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, MONGO_OPTS);
    console.log("✅ Mongoose connected");
  } catch (err) {
    console.error("❌ Mongoose connect failed:", err.message);
    console.log("🔄 Retrying in 10s...");
    setTimeout(connectMongoose, 10000);
  }
}
connectMongoose();

// ── Auto-reconnect on disconnect ─────────────────────
mongoose.connection.on("disconnected", () => {
  console.log("⚠️  Mongoose disconnected — reconnecting in 5s...");
  setTimeout(connectMongoose, 5000);
});
mongoose.connection.on("error", (err) => {
  console.error("❌ Mongoose error:", err.message);
});
mongoose.connection.on("reconnected", () => {
  console.log("✅ Mongoose reconnected");
});

// ── Native MongoClient with auto-retry ───────────────
const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  ...MONGO_OPTS,
  monitorCommands: false,
});
let db;
async function connectDB() {
  try {
    await mongoClient.connect();
    // Use silks_db or whatever DB is in the URI
    const dbName = (process.env.MONGODB_URI || "").split("/").pop()?.split("?")[0] || "silks_db";
    db = mongoClient.db(dbName);
    console.log("✅ MongoDB native connected | DB:", dbName);
  } catch (err) {
    console.error("❌ MongoDB native failed:", err.message);
    console.log("🔄 Retrying native connection in 10s...");
    setTimeout(connectDB, 10000);
  }
}
connectDB();

// ── DB readiness check helper ─────────────────────────
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

const usersCol     = () => db?.collection("users");
const addressesCol = () => db?.collection("addresses");

// ── Models ────────────────────────────────────────────
const Product = require("./models/Product");
const Order   = require("./models/Order");
const User    = require("./models/User");

// ── Email service ─────────────────────────────────────
let sendCustomerEmail = async () => {};
let sendAdminEmail    = async () => {};
let sendOTPEmail      = async (email, otp) => {
  console.log(`🔐 OTP for ${email}: ${otp}`);
};
try {
  const svc     = require("./emailService");
  sendCustomerEmail = svc.sendCustomerEmail || sendCustomerEmail;
  sendAdminEmail    = svc.sendAdminEmail    || sendAdminEmail;
  sendOTPEmail      = svc.sendOTPEmail      || sendOTPEmail;
  console.log("✅ emailService loaded");
} catch (e) { console.log("⚠️ emailService not found:", e.message); }

// ── Constants ─────────────────────────────────────────
const otpStore      = {};
const ADMIN_PASS    = process.env.ADMIN_PASS || "admin123";
const getAdminEmail = () => process.env.ADMIN_EMAIL || process.env.GMAIL_USER;

// ── PhonePe config ────────────────────────────────────
const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || "";
const PHONEPE_SALT_KEY    = process.env.PHONEPE_SALT_KEY    || "";
const PHONEPE_SALT_INDEX  = process.env.PHONEPE_SALT_INDEX  || "1";
const PHONEPE_HOST        = process.env.PHONEPE_ENV === "production"
  ? "https://api.phonepe.com/apis/hermes"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:8000";

console.log(`✅ PhonePe | ENV:${process.env.PHONEPE_ENV} | Merchant:${PHONEPE_MERCHANT_ID||"NOT SET"}`);

// ── Razorpay config ───────────────────────────────────
// ✅ ADDED — this was missing entirely. Payment.js calls
// /api/payment/create-order and /api/payment/verify, but neither
// route existed anywhere in this file, which is exactly the 404
// you were seeing on the Pay button.
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.log("⚠️ Razorpay keys NOT SET in .env");
} else {
  console.log(`✅ Razorpay configured | key:${process.env.RAZORPAY_KEY_ID}`);
}

// ── Shipping label ────────────────────────────────────
const STORE = {
  name:    "Reshma",
  address: "H No: 5-94/260, Srujanalaxmi Nagar,\nRoad No-7, Phase-2, Patelguda,\nPatancheru, Hyderabad,\nTelangana — 502319",
  phone:   "7995869469",
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
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif;background:#f5e8d8;padding:20px;display:flex;flex-direction:column;align-items:center}.no-print{margin-bottom:14px}.no-print button{background:#3d1a0e;color:#e8d5a3;border:none;padding:11px 28px;font-size:14px;font-weight:700;cursor:pointer;border-radius:4px}.label{width:210mm;background:#fff9f4;border:2px solid #c9853a;border-radius:6px;overflow:hidden}.gold-strip{height:6px;background:linear-gradient(90deg,#c9853a,#e8b97a,#c9853a)}.label-body{display:grid;grid-template-columns:1fr 155px;min-height:130mm}.label-left{padding:16px 18px;border-right:1px dashed #c9853a;display:flex;flex-direction:column;gap:12px}.addr-tag{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c9853a;margin-bottom:6px}.addr-name{font-size:16px;font-weight:700;color:#1a1008;margin-bottom:3px}.addr-text{font-size:12px;color:#5a3a22;line-height:1.65;white-space:pre-line}.addr-phone{font-size:13px;font-weight:600;color:#3d1a0e;margin-top:5px}.divider{border:none;border-top:1px dashed #c9853a;margin:4px 0}.label-right{padding:14px 12px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#fffaf5,#fdf0e0)}.brand-circle{width:126px;height:126px;border-radius:50%;border:3px solid #c9853a;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12px}.brand-title{font-size:17px;font-weight:700;color:#3d1a0e;line-height:1.1;margin-bottom:4px}.thank-badge{font-size:11px;font-style:italic;color:#7a5030;text-align:center;padding:6px 8px;border:1px solid rgba(201,133,58,0.3);border-radius:3px;background:#fffaf5;width:100%}.order-meta{display:flex;gap:16px;padding:8px 18px;background:#fdf6ee;border-top:1px solid #f0e0c8;border-bottom:1px solid #f0e0c8;font-size:11px;color:#7a5030}.items-section{padding:8px 18px;border-bottom:1px solid #f0e0c8}.items-title{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9853a;margin-bottom:6px}table{width:100%;border-collapse:collapse}thead th{background:#fdf6ee;font-size:9px;font-weight:700;color:#9a7050;padding:5px 8px;text-align:left}.total-bar{background:#3d1a0e;color:#e8d5a3;padding:8px 14px;margin-top:8px;font-weight:700;font-size:13px;display:flex;justify-content:space-between}.label-footer{background:#fae8d8;padding:8px 18px;border-top:1px solid #e8d0b0;display:flex;justify-content:space-between;align-items:center}@media print{body{background:#fff;padding:0}.no-print{display:none!important}.label{box-shadow:none}@page{size:A5 landscape;margin:5mm}}</style></head><body>
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
  res.status(200).json({ status:"ok", time:new Date().toISOString() })
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
//  RAZORPAY  ✅ ADDED — this whole section is new
// ══════════════════════════════════════════════════════
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ message: "Valid amount is required" });
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
      return res.status(500).json({ message: "Razorpay keys not configured in .env" });

    const amountInPaise = Math.round(Number(amount) * 100);

    const order = await razorpay.orders.create({
      amount:   amountInPaise,
      currency: "INR",
      receipt:  `rcpt_${Date.now()}`,
    });

    console.log("✅ Razorpay order created:", order.id, "| amount:", amountInPaise);

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID, // public key, safe to send to frontend
    });
  } catch (err) {
    // ✅ FIX — the Razorpay SDK rejects with a plain object shaped like
    // { statusCode, error: { code, description, ... } }, NOT a real
    // Error instance. err.message was always undefined, which is why
    // nothing useful ever printed. Log the full object and extract
    // the real description Razorpay actually sent.
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
//  PHONEPE
// ══════════════════════════════════════════════════════
app.post("/api/payment/phonepe/initiate", async (req, res) => {
  try {
    const { amount, orderId, userEmail, phone } = req.body;
    if (!amount || !orderId)
      return res.status(400).json({ error:"amount and orderId are required" });
    if (!PHONEPE_MERCHANT_ID || !PHONEPE_SALT_KEY)
      return res.status(500).json({ error:"PhonePe keys not configured in .env" });

    const merchantTransactionId =
      `MV${String(orderId).slice(-8).toUpperCase()}${Date.now().toString().slice(-5)}`;
    const amountInPaise = Math.round(Number(amount) * 100);

    const payload = {
      merchantId:            PHONEPE_MERCHANT_ID,
      merchantTransactionId: merchantTransactionId,
      merchantUserId:        `MU${(userEmail||"guest").replace(/[^a-zA-Z0-9]/g,"").slice(0,10)}`,
      amount:                amountInPaise,
      redirectUrl:           `${FRONTEND_URL}/order-success?orderId=${orderId}`,
      redirectMode:          "REDIRECT",
      callbackUrl:           `${BACKEND_URL}/api/payment/phonepe/callback`,
      mobileNumber:          (phone||"9999999999").replace(/\D/g,"").slice(-10),
      paymentInstrument:     { type:"PAY_PAGE" },
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    const checksum = crypto.createHash("sha256")
      .update(payloadBase64 + "/pg/v1/pay" + PHONEPE_SALT_KEY)
      .digest("hex") + "###" + PHONEPE_SALT_INDEX;

    console.log("📱 PhonePe initiate | order:", orderId, "| paise:", amountInPaise);

    const response = await axios.post(
      `${PHONEPE_HOST}/pg/v1/pay`,
      { request: payloadBase64 },
      { headers: {
          "Content-Type":  "application/json",
          "X-VERIFY":      checksum,
          "X-MERCHANT-ID": PHONEPE_MERCHANT_ID,
        }
      }
    );

    const paymentUrl = response.data?.data?.instrumentResponse?.redirectInfo?.url;
    if (paymentUrl) {
      await Order.findByIdAndUpdate(orderId, {
        phonePeTransactionId: merchantTransactionId, paymentStatus:"Initiated",
      }).catch(() => {});
      console.log("✅ PhonePe URL:", paymentUrl);
      return res.json({ success:true, paymentUrl, merchantTransactionId });
    } else {
      return res.status(400).json({ error:"PhonePe did not return a payment URL", detail:response.data });
    }
  } catch (err) {
    console.error("❌ PhonePe error:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post("/api/payment/phonepe/callback", async (req, res) => {
  try {
    const { response: responseBase64 } = req.body;
    if (!responseBase64) return res.json({ success:true });
    const decoded = JSON.parse(Buffer.from(responseBase64,"base64").toString("utf8"));
    const txnId   = decoded.data?.merchantTransactionId;
    if (decoded.code === "PAYMENT_SUCCESS") {
      const order = await Order.findOneAndUpdate(
        { phonePeTransactionId: txnId },
        { paymentStatus:"Paid", status:"Confirmed", paymentId:decoded.data?.transactionId||"" },
        { new:true }
      ).catch(() => null);
      if (order) {
        Promise.all([
          sendCustomerEmail({ email:order.email, orderId:order._id, products:order.products||order.items||[], totalAmount:order.totalAmount||order.total_amount, address:order.address, paymentMethod:order.paymentMethod }).catch(()=>{}),
          sendAdminEmail({    email:order.email, orderId:order._id, products:order.products||order.items||[], totalAmount:order.totalAmount||order.total_amount, address:order.address, paymentMethod:order.paymentMethod }).catch(()=>{}),
        ]);
      }
    } else {
      await Order.findOneAndUpdate({ phonePeTransactionId:txnId },{ paymentStatus:"Failed", status:"Cancelled" }).catch(()=>{});
    }
    res.json({ success:true });
  } catch (err) {
    console.error("PhonePe callback error:", err.message);
    res.status(500).json({ error:err.message });
  }
});

app.get("/api/payment/phonepe/status/:merchantTransactionId", async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;
    const path     = `/pg/v1/status/${PHONEPE_MERCHANT_ID}/${merchantTransactionId}`;
    const checksum = crypto.createHash("sha256")
      .update(path + PHONEPE_SALT_KEY).digest("hex") + "###" + PHONEPE_SALT_INDEX;
    const response = await axios.get(`${PHONEPE_HOST}${path}`, {
      headers: { "Content-Type":"application/json", "X-VERIFY":checksum, "X-MERCHANT-ID":PHONEPE_MERCHANT_ID }
    });
    const data = response.data?.data;
    res.json({ success:response.data?.success, code:response.data?.code, paymentStatus:data?.state, transactionId:data?.transactionId, amount:data?.amount?data.amount/100:0 });
  } catch (err) {
    res.status(500).json({ error:err.response?.data?.message || err.message });
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

    // ✅ Check per-size stock first
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
    await waitForDB();
    res.json(await Product.find().sort({ createdAt:-1 }));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error:"Not found" });
    res.json(p);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/api/products", (req, res, next) => {
  upload.fields([{ name:"images", maxCount:4 },{ name:"variantImages", maxCount:20 }])(req, res, err => {
    if (err) return res.status(500).json({ error:"Upload failed: " + err.message });
    next();
  });
}, async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color,
            stock, category, colorVariants, sizeStock } = req.body;
    if (!name || !price) return res.status(400).json({ error:"Name and price required" });

    const getUrl = f => f.path || f.secure_url || ("uploads/" + f.filename);
    const images = (req.files?.["images"]||[]).map(getUrl).filter(Boolean);

    let parsedVariants = [];
    if (colorVariants) {
      try {
        const vf = req.files?.["variantImages"] || [];
        parsedVariants = JSON.parse(colorVariants).map((v,i) => ({
          name:v.name, stock:Number(v.stock)||10,
          image:vf[i]?getUrl(vf[i]):(images[0]||""),
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

    // ✅ Parse sizeStock — calculate total stock from sizes
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
      stock:totalStock,
      soldOut:totalStock===0,
      images,
      sizeStock: parsedSizeStock,  // ✅ Save per-size stock
    });

    console.log("✅ Product created:", product._id, "| sizeStock:", parsedSizeStock);
    emitStockUpdate(product); // ✅ ADDED — tell every connected browser about the new product
    res.json(product);
  } catch (err) {
    console.error("Product create error:", err.message);
    res.status(500).json({ error:err.message });
  }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color,
            stock, category, soldOut, colorVariants, sizeStock } = req.body;

    const parsedSizes = typeof sizes === "string"
      ? sizes.split(",").map(s => s.trim()).filter(Boolean)
      : (sizes || []);

    const parsedSizeStock = sizeStock || {};

    // ✅ Total stock = sum of all size stocks
    const totalStock = parsedSizes.length > 0 && Object.keys(parsedSizeStock).length > 0
      ? Object.values(parsedSizeStock).reduce((s, v) => s + Number(v || 0), 0)
      : Number(stock) || 0;

    // ✅ Use findById + save + markModified so Mixed field is detected by Mongoose
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });

    product.name          = name || product.name;
    product.description   = description || "";
    product.price         = Number(price);
    product.originalPrice = Number(originalPrice) || Number(price);
    product.sizes         = parsedSizes;
    product.fabric        = fabric || "";
    product.color         = color  || "";
    product.category      = category || "";
    product.stock         = totalStock;
    product.soldOut       = totalStock === 0;
    product.sizeStock     = parsedSizeStock;
    product.colorVariants = typeof colorVariants === "string"
      ? JSON.parse(colorVariants)
      : (colorVariants || []);

    // ✅ CRITICAL: tell Mongoose the Mixed field changed — without this sizeStock won't save
    product.markModified("sizeStock");

    const updated = await product.save();
    console.log("✅ Product updated:", req.params.id);
    console.log("   sizeStock:", JSON.stringify(Object.fromEntries
      ? (updated.sizeStock instanceof Map
          ? Object.fromEntries(updated.sizeStock)
          : updated.sizeStock)
      : updated.sizeStock));
    console.log("   totalStock:", updated.stock);
    emitStockUpdate(updated); // ✅ ADDED — this is what pushes "sold out" to the frontend live
    res.json(updated);
  } catch (err) {
    console.error("❌ Product update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    await Product.findByIdAndDelete(req.params.id);
    // ✅ ADDED — broadcast the removal as stock:0 so any open product card updates live
    if (product) emitStockUpdate({ ...product.toObject(), stock: 0, soldOut: true });
    res.json({ success:true });
  }
  catch (err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════
app.post("/add-order", async (req, res) => {
  try {
    const { user_id, email, phone, address, payment_method, paymentMethod,
            paymentId, paymentStatus, total_amount, totalAmount, products:items } = req.body;
    if (!items || items.length === 0)
      return res.status(400).json({ error:"No items in order" });

    const normalizedItems = items.map(item => ({
      productId:    item.productId||item._id||"",
      name:         item.name||"",
      price:        Number(item.price)||0,
      quantity:     Number(item.quantity)||1,
      size:         item.selectedSize||item.size||"",
      selectedSize: item.selectedSize||item.size||"",
      color:        item.color||"",
      image:        item.image||item.images?.[0]||"",
    }));

    const finalPayMethod = payment_method || paymentMethod || "COD";
    const finalTotal     = Number(total_amount || totalAmount || 0);

    const order = await Order.create({
      user_id:user_id||email, email:email||"guest@gmail.com",
      phone:phone||address?.phone||"", address:address||{},
      payment_method:finalPayMethod, paymentMethod:finalPayMethod,
      paymentId:paymentId||"", paymentStatus:paymentStatus||"Pending",
      total_amount:finalTotal, totalAmount:finalTotal,
      items:normalizedItems, products:normalizedItems, status:"Confirmed",
    });

    console.log("✅ Order saved:", order._id, "| items:", order.products.length);

    // ✅ Reduce per-size stock
    for (const item of normalizedItems) {
      if (!item.productId) continue;
      const product = await Product.findById(item.productId).catch(() => null);
      if (!product) continue;

      const size = item.selectedSize || item.size;
      let newStock = Math.max(0, Number(product.stock) - item.quantity);

      // ✅ Reduce per-size stock if available
      if (size && product.sizeStock) {
        const sizeStockObj = product.sizeStock instanceof Map
          ? Object.fromEntries(product.sizeStock)
          : (product.sizeStock || {});

        if (sizeStockObj[size] !== undefined) {
          sizeStockObj[size] = Math.max(0, Number(sizeStockObj[size]) - item.quantity);
          // Recalculate total from all sizes
          newStock = Object.values(sizeStockObj).reduce((s,v) => s+Number(v||0), 0);
          const updatedProduct = await Product.findByIdAndUpdate(item.productId, {
            sizeStock: sizeStockObj,
            stock:     newStock,
            soldOut:   newStock === 0,
          }, { new: true });
          emitStockUpdate(updatedProduct); // ✅ ADDED — live update after purchase
          console.log(`✅ Stock reduced | ${product.name} | size:${size} → ${sizeStockObj[size]} | total:${newStock}`);
          continue;
        }
      }

      // Fallback: reduce total stock only
      const updatedProduct = await Product.findByIdAndUpdate(item.productId, {
        stock: newStock, soldOut: newStock === 0,
      }, { new: true });
      emitStockUpdate(updatedProduct); // ✅ ADDED — live update after purchase (fallback path)
    }

    const labelUrl = `${BACKEND_URL}/api/orders/${order._id}/shipping-label`;
    Promise.all([
      sendCustomerEmail({ email, orderId:order._id, products:normalizedItems, totalAmount:finalTotal, address, paymentMethod:finalPayMethod }).catch(e=>console.error("Customer email:",e.message)),
      sendAdminEmail({    email, orderId:order._id, products:normalizedItems, totalAmount:finalTotal, address, paymentMethod:finalPayMethod, labelUrl }).catch(e=>console.error("Admin email:",e.message)),
    ]);

    res.status(201).json({ success:true, orderId:order._id, labelUrl });
  } catch (err) {
    console.error("Order error:", err);
    res.status(500).json({ error:err.message });
  }
});

app.get("/my-orders/:email", async (req, res) => {
  try { res.json(await Order.find({ email:req.params.email }).sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/orders/:email", async (req, res) => {
  try { res.json(await Order.find({ email:req.params.email }).sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

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
    res.json(await Product.find().sort({ createdAt:-1 }));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/orders", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    await waitForDB();
    res.json(await Order.find().sort({ createdAt:-1 }));
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