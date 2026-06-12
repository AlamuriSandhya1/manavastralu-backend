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

// ── CORS ──────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials:    true,
  methods:        ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","x-admin-token"],
}));
app.options("*", cors());
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

// ── Mongoose ──────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS:          45000,
  family:                   4,
})
  .then(() => console.log("✅ Mongoose connected"))
  .catch(err => console.error("Mongoose error:", err.message));

// ── MongoClient ───────────────────────────────────────
const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS:          45000,
  family:                   4,
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
try {
  const svc = require("./emailService");
  sendCustomerEmail = svc.sendCustomerEmail || sendCustomerEmail;
  sendAdminEmail    = svc.sendAdminEmail    || sendAdminEmail;
} catch { console.log("⚠️ emailService not found"); }

// ── Razorpay ──────────────────────────────────────────
const razorpayRoutes = require("./routes/razorpay");
app.use("/api/payment", razorpayRoutes);

// ── OTP store ─────────────────────────────────────────
const otpStore   = {};
const ADMIN_PASS = process.env.ADMIN_PASS || "admin123";

// ═══════════════════════════════════════════════════════
//  HEALTH & HOME  — defined ONCE
// ═══════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "✅ Mana Vastralu Backend Running",
    mongo:   mongoose.connection.readyState === 1 ? "connected" : "connecting",
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════
app.post("/api/auth/login", async (req, res) => {
  const { email, name, photo } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { email },
      { name, photo, lastLogin: new Date(),
        $inc: { loginCount: 1 },
        $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await usersCol()?.findOne({ email });
    if (existing) return res.status(400).json({ message: "User already exists" });
    const hashed = await bcrypt.hash(password, 10);
    await usersCol()?.insertOne({ name, email, password: hashed });
    res.json({ message: "User registered successfully" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await usersCol()?.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: "Incorrect password" });
    await usersCol()?.updateOne({ email }, { $set: { last_login: new Date() } });
    res.json({ message: "Login successful", user: email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  USERS / ADDRESS
// ═══════════════════════════════════════════════════════
app.get("/users", async (req, res) => {
  try {
    const list = await usersCol()?.find({}, { projection: { password: 0 } }).toArray();
    res.json(list || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/save-address", async (req, res) => {
  try {
    const data = req.body;
    if (!data.email) return res.status(400).json({ message: "Email required" });
    await usersCol()?.updateOne(
      { email: data.email }, { $set: { address: data } }, { upsert: true }
    );
    res.json({ message: "Address saved" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/add-address", async (req, res) => {
  try {
    await addressesCol()?.insertOne(req.body);
    res.json({ message: "Address saved" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  PRODUCTS  (specific routes BEFORE /:id)
// ═══════════════════════════════════════════════════════
app.post("/api/products/check-stock", async (req, res) => {
  try {
    const { productId, color, quantity = 1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });
    let available = product.stock;
    if (product.colorVariants?.length > 0 && color) {
      const v = product.colorVariants.find(v => v.name.toLowerCase() === color.toLowerCase());
      available = v?.stock || 0;
    }
    res.json({ available, soldOut: available === 0, canAdd: available >= quantity });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/products", async (req, res) => {
  try { res.json(await Product.find().sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/products", upload.fields([
  { name:"images", maxCount:4 },
  { name:"variantImages", maxCount:20 },
]), async (req, res) => {
  try {
    const { name, description, price, originalPrice,
            sizes, fabric, color, stock, category, colorVariants } = req.body;
    const getUrl = f => f.path || f.secure_url || ("uploads/" + f.filename);
    const images = (req.files?.["images"] || []).map(getUrl).filter(Boolean);
    let parsedVariants = [];
    if (colorVariants) {
      const variantFiles = req.files?.["variantImages"] || [];
      parsedVariants = JSON.parse(colorVariants)
        .map((v, i) => ({
          name: v.name, stock: Number(v.stock) || 10,
          image: variantFiles[i] ? getUrl(variantFiles[i]) : (images[0] || ""),
        }))
        .filter(v => v.name.trim() !== "");
    }
    const product = await Product.create({
      name, description,
      price:         Number(price),
      originalPrice: Number(originalPrice) || Number(price),
      sizes:         sizes ? JSON.parse(sizes) : [],
      colorVariants: parsedVariants,
      fabric,
      color: color || parsedVariants.map(v => v.name).join(", ") || "ALL COLOURS",
      category, stock: Number(stock) || 10, images,
    });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, description, price, originalPrice,
            sizes, fabric, color, stock, category, soldOut, colorVariants } = req.body;
    const updated = await Product.findByIdAndUpdate(req.params.id, {
      name, description,
      price: Number(price), originalPrice: Number(originalPrice),
      sizes: typeof sizes === "string"
        ? sizes.split(",").map(s => s.trim()).filter(Boolean) : (sizes || []),
      colorVariants: typeof colorVariants === "string"
        ? JSON.parse(colorVariants) : (colorVariants || []),
      fabric, color, category,
      stock: Number(stock),
      soldOut: Number(stock) === 0 ? true : Boolean(soldOut),
    }, { new: true });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════
app.post("/add-order", async (req, res) => {
  try {
    const {
      user_id, email, phone, address,
      payment_method, paymentMethod, paymentId, paymentStatus,
      total_amount, totalAmount, products: items,
    } = req.body;

    if (!items || items.length === 0)
      return res.status(400).json({ error: "No items in order" });

    const normalizedItems = items.map(item => ({
      productId:    item.productId || item._id || "",
      name:         item.name || "",
      price:        Number(item.price) || 0,
      quantity:     Number(item.quantity) || 1,
      size:         item.selectedSize || item.size || "",
      selectedSize: item.selectedSize || item.size || "",
      color:        item.color || "",
      image:        item.image || item.images?.[0] || "",
    }));

    const finalPayMethod = payment_method || paymentMethod || "COD";
    const finalTotal     = Number(total_amount || totalAmount || 0);

    const order = await Order.create({
      user_id:        user_id || email,
      email:          email || "guest@gmail.com",
      phone:          phone || address?.phone || "",
      address:        address || {},
      payment_method: finalPayMethod,
      paymentMethod:  finalPayMethod,
      paymentId:      paymentId || "",
      paymentStatus:  paymentStatus || "Pending",
      total_amount:   finalTotal,
      totalAmount:    finalTotal,
      items:          normalizedItems,
      products:       normalizedItems,
      status:         "Confirmed",
    });

    console.log("✅ Order saved:", order._id);

    // Reduce stock
    for (const item of normalizedItems) {
      if (!item.productId) continue;
      const product = await Product.findById(item.productId).catch(() => null);
      if (!product) continue;
      const newStock = Math.max(0, product.stock - item.quantity);
      await Product.findByIdAndUpdate(item.productId, {
        stock: newStock, soldOut: newStock === 0,
      });
    }

    // Send emails (non-blocking)
    Promise.all([
      sendCustomerEmail({ email, orderId: order._id, products: normalizedItems,
        totalAmount: finalTotal, address, paymentMethod: finalPayMethod })
        .catch(e => console.error("Customer email:", e.message)),
      sendAdminEmail({ email, orderId: order._id, products: normalizedItems,
        totalAmount: finalTotal, address, paymentMethod: finalPayMethod })
        .catch(e => console.error("Admin email:", e.message)),
    ]);

    res.status(201).json({ success: true, orderId: order._id });
  } catch (err) {
    console.error("Order error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders", async (req, res) => {
  // alias for /add-order
  req.url = "/add-order";
  app._router.handle(req, res, () => {});
});

app.get("/my-orders/:email", async (req, res) => {
  try {
    res.json(await Order.find({ email: req.params.email }).sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:email", async (req, res) => {
  try {
    res.json(await Order.find({ email: req.params.email }).sort({ createdAt: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════
app.get("/api/admin/users", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await User.find().sort({ lastLogin: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/products", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await Product.find().sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/orders", async (req, res) => {
  if (req.query.password !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await Order.find().sort({ createdAt: -1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/orders/:id", async (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  try {
    const updated = await Order.findByIdAndUpdate(
      req.params.id, { status: req.body.status }, { new: true }
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/orders/:id/tracking", async (req, res) => {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { courierName, trackingNumber, estimatedDelivery, status } = req.body;
    const trackingUrl = `https://www.google.com/search?q=${courierName}+tracking+${trackingNumber}`;
    const updated = await Order.findByIdAndUpdate(req.params.id, {
      courierName, trackingNumber, trackingUrl,
      estimatedDelivery, status: status || "Shipped", shippedAt: new Date(),
    }, { new: true });
    res.json({ success: true, order: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/stock-alerts", async (req, res) => {
  try {
    const alerts = [];
    const list = await Product.find();
    list.forEach(p => {
      if (p.colorVariants?.length > 0) {
        p.colorVariants.forEach(v => {
          if (v.stock <= 3) alerts.push({
            productId: p._id, productName: p.name,
            color: v.name, stock: v.stock, soldOut: v.stock === 0,
          });
        });
      } else if (p.stock <= 3) {
        alerts.push({
          productId: p._id, productName: p.name,
          color: p.color || "—", stock: p.stock, soldOut: p.soldOut,
        });
      }
    });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ADMIN OTP
// ═══════════════════════════════════════════════════════
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

app.post("/api/admin/request-otp", async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS)
    return res.status(401).json({ success: false, message: "Incorrect password" });
  const otp       = generateOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  otpStore[adminEmail] = { otp, expiresAt };
  console.log(`🔐 OTP for ${adminEmail}: ${otp}`);
  try {
    const nodemailer  = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER,
              pass: (process.env.GMAIL_PASS || "").replace(/\s/g, "") },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({
      from: `"Mana Vastralu" <${process.env.GMAIL_USER}>`,
      to: adminEmail,
      subject: `🔐 Admin OTP: ${otp}`,
      html: `<h2>Your OTP: <b style="font-size:32px;letter-spacing:8px">${otp}</b></h2><p>Valid 5 minutes.</p>`,
    });
    res.json({ success: true, message: `OTP sent to ${adminEmail}` });
  } catch {
    res.json({ success: true, message: "OTP in server logs" });
  }
});

app.post("/api/admin/verify-otp", (req, res) => {
  const { otp } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  const stored     = otpStore[adminEmail];
  if (!stored) return res.status(400).json({ success: false, message: "No OTP requested." });
  if (Date.now() > stored.expiresAt) {
    delete otpStore[adminEmail];
    return res.status(400).json({ success: false, message: "OTP expired." });
  }
  if (stored.otp !== otp.trim())
    return res.status(400).json({ success: false, message: "Incorrect OTP." });
  delete otpStore[adminEmail];
  const sessionToken = crypto.randomBytes(32).toString("hex");
  otpStore[`session_${sessionToken}`] = { expiresAt: Date.now() + 2 * 60 * 60 * 1000 };
  res.json({ success: true, sessionToken });
});

// ═══════════════════════════════════════════════════════
//  CHATBOT
// ═══════════════════════════════════════════════════════
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
app.post("/chat", async (req, res) => {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role:"system", content:"You are a helpful assistant for Mana Vastralu saree store." },
        { role:"user",   content: req.body.message },
      ],
    });
    res.json({ reply: response.choices[0].message.content });
  } catch { res.json({ reply: "Sorry, I couldn't answer right now." }); }
});

// ── Error handlers ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught exception:", err.message);
  // Don't exit — keep server running
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
const PORT = process.env.PORT || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});