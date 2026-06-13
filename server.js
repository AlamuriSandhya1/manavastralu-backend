require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const bcrypt     = require("bcryptjs");
const mongoose   = require("mongoose");
const { MongoClient } = require("mongodb");
const fs         = require("fs");
const crypto     = require("crypto");
const OpenAI     = require("openai");
const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");

const app = express();

app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-token"],
}));
app.options("*", cors());
app.use(express.json());

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
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4,
})
  .then(() => console.log("✅ Mongoose connected"))
  .catch(err => console.error("Mongoose error:", err.message));

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  family: 4,
});
let db;
async function connectDB() {
  try {
    await mongoClient.connect();
    db = mongoClient.db("silks_db");
    console.log("✅ MongoDB native connected");
  } catch (err) {
    console.error("❌ MongoDB failed:", err.message);
    setTimeout(connectDB, 15000);
  }
}
connectDB();

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
  // Inline fallback OTP sender if emailService fails
  console.log(`🔐 OTP for ${email}: ${otp}`);
};
try {
  const svc = require("./emailService");
  sendCustomerEmail = svc.sendCustomerEmail || sendCustomerEmail;
  sendAdminEmail    = svc.sendAdminEmail    || sendAdminEmail;
  sendOTPEmail      = svc.sendOTPEmail      || sendOTPEmail;
  console.log("✅ emailService loaded");
} catch (e) { console.log("⚠️ emailService not found:", e.message); }

// ── Razorpay ──────────────────────────────────────────
const razorpayRoutes = require("./routes/razorpay");
app.use("/api/payment", razorpayRoutes);

// ── Constants ─────────────────────────────────────────
const otpStore   = {};
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";
// ✅ Admin email — uses ADMIN_EMAIL if set, otherwise GMAIL_USER
const getAdminEmail = () => process.env.ADMIN_EMAIL || process.env.GMAIL_USER;

// ── Shipping label helper ─────────────────────────────
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

  return `<!DOCTYPE html><html>
<head><meta charset="utf-8"/>
<title>Label #${shortId}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Lato:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Lato',sans-serif;background:#f5e8d8;padding:20px;display:flex;flex-direction:column;align-items:center}
  .no-print{margin-bottom:14px;display:flex;gap:10px;align-items:center}
  .no-print button{background:#3d1a0e;color:#e8d5a3;border:none;padding:11px 28px;font-size:14px;font-weight:700;cursor:pointer;border-radius:4px;font-family:'Lato',sans-serif;letter-spacing:1px}
  .label{width:210mm;background:#fff9f4;border:2px solid #c9853a;border-radius:6px;overflow:hidden;box-shadow:0 8px 32px rgba(61,26,14,0.2)}
  .gold-strip{height:6px;background:linear-gradient(90deg,#c9853a,#e8b97a,#c9853a,#e8b97a,#c9853a)}
  .label-body{display:grid;grid-template-columns:1fr 155px;min-height:130mm}
  .label-left{padding:16px 18px;border-right:1px dashed #c9853a;display:flex;flex-direction:column;gap:12px}
  .addr-tag{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c9853a;margin-bottom:6px;display:flex;align-items:center;gap:6px}
  .addr-tag::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,#c9853a,transparent)}
  .addr-name{font-size:16px;font-weight:700;color:#1a1008;margin-bottom:3px;font-family:'Playfair Display',serif}
  .addr-text{font-size:12px;color:#5a3a22;line-height:1.65;white-space:pre-line}
  .addr-phone{font-size:13px;font-weight:600;color:#3d1a0e;margin-top:5px}
  .divider{border:none;border-top:1px dashed #c9853a;margin:4px 0}
  .label-right{padding:14px 12px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#fffaf5,#fdf0e0)}
  .brand-circle{width:126px;height:126px;border-radius:50%;background:radial-gradient(circle,#fff9f4 60%,#fae8d0 100%);border:3px solid #c9853a;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:12px;box-shadow:0 4px 12px rgba(201,133,58,0.2)}
  .brand-title{font-family:'Playfair Display',serif;font-size:17px;font-weight:700;color:#3d1a0e;line-height:1.1;margin-bottom:4px}
  .brand-sub{font-size:7px;color:#c9853a;letter-spacing:0.5px;margin-bottom:5px}
  .brand-contact{font-size:9px;color:#3d1a0e;line-height:1.8;text-align:center}
  .thank-badge{font-family:'Playfair Display',serif;font-size:11px;font-style:italic;color:#7a5030;text-align:center;padding:6px 8px;border:1px solid rgba(201,133,58,0.3);border-radius:3px;background:#fffaf5;width:100%}
  .order-meta{display:flex;gap:16px;padding:8px 18px;background:#fdf6ee;border-top:1px solid #f0e0c8;border-bottom:1px solid #f0e0c8;font-size:11px;color:#7a5030}
  .order-meta strong{color:#3d1a0e}
  .items-section{padding:8px 18px;border-bottom:1px solid #f0e0c8}
  .items-title{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c9853a;margin-bottom:6px}
  table{width:100%;border-collapse:collapse}
  thead th{background:#fdf6ee;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#9a7050;padding:5px 8px;text-align:left}
  thead th:last-child{text-align:right} thead th:nth-child(2),thead th:nth-child(3){text-align:center}
  .total-bar{background:#3d1a0e;color:#e8d5a3;padding:8px 14px;margin-top:8px;font-weight:700;font-size:13px;border-radius:2px;display:flex;justify-content:space-between}
  .order-badge{position:absolute;top:10px;right:162px;background:#3d1a0e;color:#e8d5a3;font-size:10px;font-weight:700;padding:4px 10px;border-radius:2px;letter-spacing:0.5px}
  .label-footer{background:#fae8d8;padding:8px 18px;border-top:1px solid #e8d0b0;display:flex;justify-content:space-between;align-items:center}
  .footer-brand{font-family:'Playfair Display',serif;font-size:13px;color:#3d1a0e;font-weight:600}
  .footer-contact{font-size:10px;color:#7a5030;text-align:right;line-height:1.6}
  @media print{body{background:#fff;padding:0}.no-print{display:none!important}.label{box-shadow:none}@page{size:A5 landscape;margin:5mm}}
</style>
</head>
<body>
<div class="no-print">
  <button onclick="window.print()">🖨️ Print Shipping Label</button>
  <span style="font-size:12px;color:#7a5030;font-family:Lato,sans-serif">A5 Landscape · Fits standard courier label</span>
</div>
<div class="label" style="position:relative">
  <div class="gold-strip"></div>
  <div class="order-badge">ORDER #${shortId} · ${date}</div>
  <div class="label-body">
    <div class="label-left">
      <div>
        <div class="addr-tag">📍 Deliver To</div>
        <div class="addr-name">TO, ${toName}</div>
        <div class="addr-text">${toAddr}</div>
        <div class="addr-text">${toState}${toPin ? `,\nPin code: ${toPin}` : ""}</div>
        ${toPhone ? `<div class="addr-phone">📞 ${toPhone}</div>` : ""}
      </div>
      <hr class="divider"/>
      <div>
        <div class="addr-tag">📦 From</div>
        <div class="addr-name">Name : ${STORE.name}</div>
        <div class="addr-text">${STORE.address}</div>
        <div class="addr-phone">Contact: ${STORE.phone}</div>
      </div>
    </div>
    <div class="label-right">
      <div class="brand-circle">
        <div class="brand-title">Mana<br/>Vastralu</div>
        <div class="brand-sub">— Mana Gurthimpu —</div>
        <div class="brand-contact"><div style="color:#c9853a">📸 ${STORE.insta}</div><div style="color:#2e7d32">📞 ${STORE.phone}</div></div>
      </div>
      <div class="thank-badge">THANK YOU<br/><span style="font-size:9px;font-style:italic">for your purchase</span></div>
    </div>
  </div>
  <div class="order-meta">
    <div>Payment: <strong>${pay}</strong></div>
    ${order.paymentId ? `<div>Pay ID: <strong>${order.paymentId}</strong></div>` : ""}
    <div>Total: <strong>₹${total}</strong></div>
    <div>Status: <strong style="color:#2e7d32">✅ Confirmed</strong></div>
  </div>
  <div class="items-section">
    <div class="items-title">Items Ordered</div>
    <table><thead><tr><th>Product</th><th>Size</th><th>Qty</th><th>Price</th></tr></thead><tbody>${itemRows}</tbody></table>
    <div class="total-bar"><span>Total Amount</span><span>₹${total}</span></div>
  </div>
  <div class="label-footer">
    <div>
      <div class="footer-brand">Mana Vastralu</div>
      <div style="font-size:9px;color:#c9853a">@${STORE.insta}</div>
    </div>
    <div class="footer-contact">${STORE.phone}<br/>manavastralu@gmail.com</div>
  </div>
  <div class="gold-strip"></div>
</div>
</body></html>`;
}

// ═══════════════════════════════════════════════════════
//  HOME / HEALTH
// ═══════════════════════════════════════════════════════
app.get("/", (req, res) => res.json({
  success: true, message: "✅ Mana Vastralu Backend Running",
  mongo: mongoose.connection.readyState === 1 ? "connected" : "connecting",
}));
app.get("/api/health", (req, res) => res.status(200).json({ status:"ok", time:new Date().toISOString() }));

// ── Shipping label ────────────────────────────────────
app.get("/api/orders/:id/shipping-label", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error:"Order not found" });
    res.setHeader("Content-Type","text/html");
    res.send(generateShippingLabel(order));
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════
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
    await usersCol()?.updateOne({ email }, { $set:{ last_login:new Date() } });
    res.json({ message:"Login successful", user:email });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/users", async (req, res) => {
  try {
    res.json(await usersCol()?.find({},{ projection:{ password:0 } }).toArray() || []);
  } catch (err) { res.status(500).json({ error:err.message }); }
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

// ═══════════════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════════════
app.post("/api/products/check-stock", async (req, res) => {
  try {
    const { productId, color, quantity=1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error:"Product not found" });
    let available = product.stock;
    if (product.colorVariants?.length>0 && color) {
      const v = product.colorVariants.find(v=>v.name.toLowerCase()===color.toLowerCase());
      available = v?.stock||0;
    }
    res.json({ available, soldOut:available===0, canAdd:available>=quantity });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/products", async (req, res) => {
  try { res.json(await Product.find().sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error:"Not found" });
    res.json(p);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.post("/api/products", (req, res, next) => {
  upload.fields([{ name:"images",maxCount:4 },{ name:"variantImages",maxCount:20 }])(req, res, err => {
    if (err) return res.status(500).json({ error:"Upload failed: "+err.message });
    next();
  });
}, async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color, stock, category, colorVariants } = req.body;
    if (!name||!price) return res.status(400).json({ error:"Name and price required" });
    const getUrl = f => f.path||f.secure_url||("uploads/"+f.filename);
    const images = (req.files?.["images"]||[]).map(getUrl).filter(Boolean);
    let parsedVariants=[];
    if (colorVariants) {
      try {
        const vf=req.files?.["variantImages"]||[];
        parsedVariants=JSON.parse(colorVariants).map((v,i)=>({ name:v.name, stock:Number(v.stock)||10, image:vf[i]?getUrl(vf[i]):(images[0]||"") })).filter(v=>v.name.trim()!=="");
      } catch(e) { console.warn("colorVariants parse failed:",e.message); }
    }
    let parsedSizes=[];
    try { parsedSizes=sizes?(typeof sizes==="string"&&sizes.startsWith("[")?JSON.parse(sizes):sizes.split(",").map(s=>s.trim()).filter(Boolean)):[]; } catch { parsedSizes=[]; }
    const product = await Product.create({
      name:name.trim(), description:description||"", price:Number(price), originalPrice:Number(originalPrice)||Number(price),
      sizes:parsedSizes, colorVariants:parsedVariants, fabric:fabric||"",
      color:color||parsedVariants.map(v=>v.name).join(", ")||"ALL COLOURS",
      category:category||"", stock:Number(stock)||10, images,
    });
    console.log("✅ Product created:",product._id);
    res.json(product);
  } catch (err) { console.error("Product error:",err.message); res.status(500).json({ error:err.message }); }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, description, price, originalPrice, sizes, fabric, color, stock, category, soldOut, colorVariants } = req.body;
    const updated = await Product.findByIdAndUpdate(req.params.id, {
      name, description, price:Number(price), originalPrice:Number(originalPrice),
      sizes:typeof sizes==="string"?sizes.split(",").map(s=>s.trim()).filter(Boolean):(sizes||[]),
      colorVariants:typeof colorVariants==="string"?JSON.parse(colorVariants):(colorVariants||[]),
      fabric, color, category, stock:Number(stock), soldOut:Number(stock)===0?true:Boolean(soldOut),
    },{ new:true });
    res.json(updated);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.delete("/api/products/:id", async (req, res) => {
  try { await Product.findByIdAndDelete(req.params.id); res.json({ success:true }); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════
app.post("/add-order", async (req, res) => {
  try {
    const { user_id, email, phone, address, payment_method, paymentMethod,
            paymentId, paymentStatus, total_amount, totalAmount, products:items } = req.body;
    if (!items||items.length===0) return res.status(400).json({ error:"No items in order" });

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

    const finalPayMethod = payment_method||paymentMethod||"COD";
    const finalTotal     = Number(total_amount||totalAmount||0);

    const order = await Order.create({
      user_id:user_id||email, email:email||"guest@gmail.com",
      phone:phone||address?.phone||"", address:address||{},
      payment_method:finalPayMethod, paymentMethod:finalPayMethod,
      paymentId:paymentId||"", paymentStatus:paymentStatus||"Pending",
      total_amount:finalTotal, totalAmount:finalTotal,
      items:normalizedItems, products:normalizedItems, status:"Confirmed",
    });
    console.log("✅ Order saved:",order._id,"| items:",order.products.length);

    // Stock reduction
    for (const item of normalizedItems) {
      if (!item.productId) continue;
      const product = await Product.findById(item.productId).catch(()=>null);
      if (!product) continue;
      const newStock = Math.max(0, product.stock-item.quantity);
      await Product.findByIdAndUpdate(item.productId,{ stock:newStock, soldOut:newStock===0 });
    }

    const baseUrl  = process.env.STORE_URL || "https://manavastralu-backend.onrender.com";
    const labelUrl = `${baseUrl}/api/orders/${order._id}/shipping-label`;

    // Send emails non-blocking
    Promise.all([
      sendCustomerEmail({ email, orderId:order._id, products:normalizedItems,
        totalAmount:finalTotal, address, paymentMethod:finalPayMethod })
        .catch(e=>console.error("Customer email:",e.message)),
      sendAdminEmail({ email, orderId:order._id, products:normalizedItems,
        totalAmount:finalTotal, address, paymentMethod:finalPayMethod, labelUrl })
        .catch(e=>console.error("Admin email:",e.message)),
    ]);

    res.status(201).json({ success:true, orderId:order._id, labelUrl });
  } catch (err) { console.error("Order error:",err); res.status(500).json({ error:err.message }); }
});

app.get("/my-orders/:email", async (req, res) => {
  try { res.json(await Order.find({ email:req.params.email }).sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/orders/:email", async (req, res) => {
  try { res.json(await Order.find({ email:req.params.email }).sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════
app.get("/api/admin/users", async (req, res) => {
  if (req.query.password!==ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try { res.json(await User.find().sort({ lastLogin:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/products", async (req, res) => {
  if (req.query.password!==ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try { res.json(await Product.find().sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/orders", async (req, res) => {
  if (req.query.password!==ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try { res.json(await Order.find().sort({ createdAt:-1 })); }
  catch (err) { res.status(500).json({ error:err.message }); }
});

app.put("/api/admin/orders/:id", async (req, res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    const updated = await Order.findByIdAndUpdate(req.params.id,{ status:req.body.status },{ new:true });
    res.json(updated);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.put("/api/admin/orders/:id/tracking", async (req, res) => {
  if (req.body.password!==ADMIN_PASS) return res.status(401).json({ error:"Unauthorized" });
  try {
    const { courierName, trackingNumber, estimatedDelivery, status } = req.body;
    const trackingUrl = `https://www.google.com/search?q=${courierName}+tracking+${trackingNumber}`;
    const updated = await Order.findByIdAndUpdate(req.params.id,{
      courierName, trackingNumber, trackingUrl,
      estimatedDelivery, status:status||"Shipped", shippedAt:new Date(),
    },{ new:true });
    res.json({ success:true, order:updated });
  } catch (err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/admin/stock-alerts", async (req, res) => {
  try {
    const alerts=[];
    const list = await Product.find();
    list.forEach(p => {
      if (p.colorVariants?.length>0) {
        p.colorVariants.forEach(v => {
          if (v.stock<=3) alerts.push({ productId:p._id,productName:p.name,color:v.name,stock:v.stock,soldOut:v.stock===0 });
        });
      } else if (p.stock<=3) {
        alerts.push({ productId:p._id,productName:p.name,color:p.color||"—",stock:p.stock,soldOut:p.soldOut });
      }
    });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error:err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ADMIN OTP — uses sendOTPEmail from emailService
// ═══════════════════════════════════════════════════════
const generateOTP = () => Math.floor(100000+Math.random()*900000).toString();

app.post("/api/admin/request-otp", async (req, res) => {
  const { password } = req.body;
  if (password!==ADMIN_PASS)
    return res.status(401).json({ success:false, message:"Incorrect password" });

  const otp        = generateOTP();
  const expiresAt  = Date.now()+5*60*1000;
  const adminEmail = getAdminEmail();

  if (!adminEmail) return res.status(500).json({ success:false, message:"ADMIN_EMAIL not configured in environment" });

  otpStore[adminEmail] = { otp, expiresAt };
  console.log(`🔐 OTP for ${adminEmail}: ${otp}`); // backup — always visible in logs

  try {
    await sendOTPEmail(adminEmail, otp);
    res.json({ success:true, message:`OTP sent to ${adminEmail}` });
  } catch (err) {
    console.error("❌ OTP email failed:", err.message);
    // Still allow login — OTP is in logs
    res.json({ success:true, message:"OTP sent (check server logs if not received)" });
  }
});

app.post("/api/admin/verify-otp", (req, res) => {
  const { otp }    = req.body;
  const adminEmail = getAdminEmail();
  const stored     = otpStore[adminEmail];
  if (!stored)              return res.status(400).json({ success:false, message:"No OTP requested." });
  if (Date.now()>stored.expiresAt) { delete otpStore[adminEmail]; return res.status(400).json({ success:false, message:"OTP expired." }); }
  if (stored.otp!==otp.trim())     return res.status(400).json({ success:false, message:"Incorrect OTP." });
  delete otpStore[adminEmail];
  const sessionToken = crypto.randomBytes(32).toString("hex");
  otpStore[`session_${sessionToken}`] = { expiresAt:Date.now()+2*60*60*1000 };
  res.json({ success:true, sessionToken });
});

// ═══════════════════════════════════════════════════════
//  CHATBOT
// ═══════════════════════════════════════════════════════
const openai = new OpenAI({ apiKey:process.env.OPENAI_API_KEY||"" });
app.post("/chat", async (req, res) => {
  try {
    const r = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      messages:[
        { role:"system", content:"You are a helpful assistant for Mana Vastralu saree store." },
        { role:"user",   content:req.body.message },
      ],
    });
    res.json({ reply:r.choices[0].message.content });
  } catch { res.json({ reply:"Sorry, I couldn't answer right now." }); }
});

process.on("unhandledRejection", r => console.error("⚠️ Unhandled rejection:", r?.message||r));
process.on("uncaughtException",  e => console.error("⚠️ Uncaught exception:",  e.message));

const PORT = process.env.PORT||8000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));