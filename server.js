require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const bcrypt     = require("bcryptjs");
const mongoose   = require("mongoose");
const { MongoClient } = require("mongodb");
const fs         = require("fs");
const OpenAI     = require("openai");
const { sendCustomerEmail, sendAdminEmail } = require("./emailService");
const cloudinary        = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
// const multer            = require("multer");
const app = express();
app.use(cors());
app.use(express.json());

// ── Upload folder ─────────────────────────────────────
const UPLOAD_DIR = "uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR));

// ── Multer ────────────────────────────────────────────
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => cb(null, UPLOAD_DIR),
//   filename:    (req, file, cb) => cb(null, Date.now() + "_" + file.originalname),
// });
// const upload = multer({ storage });
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
 
// ✅ Cloudinary storage — images uploaded directly to cloud
const cloudStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         "mana-vastralu",
    allowed_formats: ["jpg", "jpeg", "png", "webp"],
    transformation: [{ width: 800, height: 1000, crop: "limit", quality: "auto" }],
  },
});
 
const upload = multer({ storage: cloudStorage });

// ── MongoDB Native (users) ────────────────────────────
const client = new MongoClient("mongodb://localhost:27017");
let db;
async function connectDB() {
  await client.connect();
  db = client.db("silks_db");
  console.log("MongoDB connected");
}
connectDB();

const usersCol     = () => db.collection("users");
const addressesCol = () => db.collection("addresses");

// ── Mongoose ──────────────────────────────────────────
mongoose.connect("mongodb://localhost:27017/silks_db")
  .then(() => console.log("Mongoose connected"))
  .catch(err => console.log("Mongoose error:", err));

const Product = require("./models/Product");
const Order   = require("./models/Order");
const User    = require("./models/User");

// ── Razorpay routes ───────────────────────────────────
const razorpayRoutes = require("./routes/razorpay");
app.use("/api/payment", razorpayRoutes);

// ═══════════════════════════════════════════════════════
//  HOME
// ═══════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({ message: "Backend running successfully" });
});

// ═══════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════

// Google login tracking
app.post("/api/auth/login", async (req, res) => {
  const { email, name, photo } = req.body;
  try {
    const user = await User.findOneAndUpdate(
      { email },
      { name, photo, lastLogin: new Date(),
        $inc: { loginCount: 1 },
        $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true, returnDocument: "after" }
    );
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Register
app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await usersCol().findOne({ email });
  if (existing) return res.status(400).json({ message: "User already exists" });
  const hashed = await bcrypt.hash(password, 10);
  await usersCol().insertOne({ name, email, password: hashed });
  res.json({ message: "User registered successfully" });
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await usersCol().findOne({ email });
  if (!user) return res.status(400).json({ message: "User not found" });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ message: "Incorrect password" });
  await usersCol().updateOne({ email }, { $set: { last_login: new Date() } });
  res.json({ message: "Login successful", user: email });
});

// ═══════════════════════════════════════════════════════
//  USERS
// ═══════════════════════════════════════════════════════
app.get("/users", async (req, res) => {
  const list = await usersCol()
    .find({}, { projection: { password: 0 } }).toArray();
  res.json(list);
});

// ═══════════════════════════════════════════════════════
//  ADDRESS
// ═══════════════════════════════════════════════════════
app.post("/save-address", async (req, res) => {
  const data = req.body;
  if (!data.email) return res.status(400).json({ message: "Email required" });
  await usersCol().updateOne(
    { email: data.email },
    { $set: { address: data } },
    { upsert: true }
  );
  res.json({ message: "Address saved successfully" });
});

app.post("/add-address", async (req, res) => {
  await addressesCol().insertOne(req.body);
  res.json({ message: "Address saved successfully" });
});

// ═══════════════════════════════════════════════════════
//  PRODUCTS
//  IMPORTANT: specific routes MUST come before /:id
// ═══════════════════════════════════════════════════════

// GET all products — public
app.get("/api/products", async (req, res) => {
  try {
    const list = await Product.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST check-stock — MUST be before /:id route
app.post("/api/products/check-stock", async (req, res) => {
  try {
    const { productId, color, quantity = 1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: "Product not found" });

    let available = 0;
    if (product.colorVariants?.length > 0 && color) {
      const variant = product.colorVariants.find(
        v => v.name.toLowerCase() === color.toLowerCase()
      );
      available = variant?.stock || 0;
    } else {
      available = product.stock;
    }

    res.json({
      available,
      soldOut:  available === 0,
      canAdd:   available >= quantity,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single product
app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST add product (admin) — with images + variantImages
app.post("/api/products", upload.fields([
  { name: "images",        maxCount: 4  },
  { name: "variantImages", maxCount: 20 },
]), async (req, res) => {
  try {
    const {
      name, description, price, originalPrice,
      sizes, fabric, color, stock, category, colorVariants,
    } = req.body;

    // Main product images
    const images = (req.files["images"] || [])
      .map(f => "uploads/" + f.filename);

    // Parse colour variants and attach uploaded images
    let parsedVariants = [];
    if (colorVariants) {
      parsedVariants = JSON.parse(colorVariants);
      const variantFiles = req.files["variantImages"] || [];
      parsedVariants = parsedVariants
        .map((v, i) => ({
          name:  v.name,
          stock: Number(v.stock) || 10,
          image: variantFiles[i]
            ? "uploads/" + variantFiles[i].filename
            : (images[0] || ""),
        }))
        .filter(v => v.name.trim() !== "");
    }

    const product = await Product.create({
      name,
      description,
      price:         Number(price),
      originalPrice: Number(originalPrice) || Number(price),
      sizes:         sizes ? JSON.parse(sizes) : [],
      colorVariants: parsedVariants,
      fabric,
      color: color || parsedVariants.map(v => v.name).join(", ") || "ALL COLOURS",
      category,
      stock:  Number(stock) || 10,
      images,
    });

    res.json(product);
  } catch (err) {
    console.error("Add product error:", err);
    res.status(500).json({ error: err.message });
  }
});

// PUT update product (admin)
app.put("/api/products/:id", async (req, res) => {
  try {
    const { name, description, price, originalPrice,
            sizes, fabric, color, stock, category,
            soldOut, colorVariants } = req.body;
    const updated = await Product.findByIdAndUpdate(
      req.params.id,
      {
        name, description,
        price:         Number(price),
        originalPrice: Number(originalPrice),
        sizes:         typeof sizes === "string" ? JSON.parse(sizes) : sizes,
        colorVariants: typeof colorVariants === "string"
                         ? JSON.parse(colorVariants) : (colorVariants || []),
        fabric, color, category,
        stock:   Number(stock),
        soldOut: Number(stock) === 0 ? true : Boolean(soldOut),
      },
      { new: true }
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE product (admin)
app.delete("/api/products/:id", async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════════════

// Place order
// ── Replace your existing app.post("/add-order") in server.js with this ──
app.post("/add-order", async (req, res) => {
  try {
    const {
      user_id, email, phone, address,
      payment_method, paymentMethod,
      paymentId, paymentStatus,
      total_amount, totalAmount,
      products: items,
    } = req.body;
 
    if (!items || items.length === 0)
      return res.status(400).json({ error: "No items in order" });
 
    // 1. Stock check
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product)
        return res.status(404).json({ error: `Product not found: ${item.name}` });
      if (product.stock < (item.quantity || 1))
        return res.status(400).json({ error: `Only ${product.stock} left for ${item.name}` });
    }
 
    // 2. Normalize products
    const normalizedProducts = items.map(item => ({
      productId:    item.productId || item._id || "",
      name:         item.name      || "",
      price:        Number(item.price)    || 0,
      quantity:     Number(item.quantity) || 1,
      size:         item.selectedSize || item.size || "",
      selectedSize: item.selectedSize || item.size || "",
      color:        item.color  || "",
      image:        item.image  || item.images?.[0] || "",
      images:       item.images || (item.image ? [item.image] : []),
    }));
 
    const finalPayMethod = payment_method || paymentMethod || "COD";
    const finalTotal     = Number(total_amount || totalAmount || 0);
 
    // 3. Save order
    const order = new Order({
      user_id:        user_id || email,
      email:          email   || "guest@gmail.com",
      phone:          phone   || address?.phone || "Not Provided",
      address:        address || {},
      payment_method: finalPayMethod,
      paymentMethod:  finalPayMethod,
      paymentId:      paymentId  || "",
      paymentStatus:  paymentStatus || "Pending",
      total_amount:   finalTotal,
      totalAmount:    finalTotal,
      products:       normalizedProducts,
      status:         "Confirmed",
    });
    await order.save();
 
    // 4. Reduce stock
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product) continue;
      const newStock = Math.max(0, product.stock - (item.quantity || 1));
      await Product.findByIdAndUpdate(item.productId, {
        stock:   newStock,
        soldOut: newStock === 0,
      });
    }
 
    // 5. Send emails (non-blocking — don't fail order if email fails)
    const emailData = {
      email:         email || "guest@gmail.com",
      orderId:       order._id,
      products:      normalizedProducts,
      totalAmount:   finalTotal,
      address:       address || {},
      paymentMethod: finalPayMethod,
    };
 
    Promise.all([
      sendCustomerEmail(emailData).catch(e => console.error("Customer email failed:", e.message)),
      sendAdminEmail(emailData).catch(e =>    console.error("Admin email failed:",    e.message)),
    ]);
 
    res.status(201).json({ success: true, orderId: order._id });
 
  } catch (err) {
    console.error("Order error:", err);
    res.status(500).json({ error: err.message });
  }
});
 

// Get orders by email (MyOrders page)
app.get("/my-orders/:email", async (req, res) => {
  try {
    const list = await Order.find({ email: req.params.email })
                            .sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
//  ADMIN
// ═══════════════════════════════════════════════════════
const ADMIN_PASS = "admin123";

app.get("/api/admin/users", async (req, res) => {
  if (req.query.password !== ADMIN_PASS)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const list = await User.find().sort({ lastLogin: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/orders", async (req, res) => {
  if (req.query.password !== ADMIN_PASS)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const list = await Order.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/admin/orders/:id", async (req, res) => {
  if (req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const updated = await Order.findByIdAndUpdate(
      req.params.id, { status: req.body.status }, { new: true }
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/products", async (req, res) => {
  if (req.query.password !== ADMIN_PASS)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const list = await Product.find().sort({ createdAt: -1 });
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/admin/stock-alerts", async (req, res) => {
  try {
    const list   = await Product.find();
    const alerts = [];
    list.forEach(p => {
      if (p.colorVariants?.length > 0) {
        p.colorVariants.forEach(v => {
          if (v.stock <= 3) alerts.push({
            productId:   p._id,
            productName: p.name,
            color:       v.name,
            stock:       v.stock,
            soldOut:     v.stock === 0,
          });
        });
      } else if (p.stock <= 3) {
        alerts.push({
          productId:   p._id,
          productName: p.name,
          color:       p.color || "—",
          stock:       p.stock,
          soldOut:     p.soldOut,
        });
      }
    });
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        { role: "system", content: "You are a helpful assistant for an online saree shopping store." },
        { role: "user",   content: req.body.message },
      ],
    });
    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    res.json({ reply: "Sorry, I couldn't answer right now." });
  }
});
// ── Add these routes to server.js ──────────────────────────────
// Place BEFORE app.listen(8000)

const crypto = require("crypto");

// In-memory OTP store { email: { otp, expiresAt } }
const otpStore = {};

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ── Step 1: Verify password → send OTP ──────────────
app.post("/api/admin/request-otp", async (req, res) => {
  const { password } = req.body;

  if (password !== process.env.ADMIN_PASS && password !== "admin123") {
    return res.status(401).json({ success: false, message: "Incorrect password" });
  }

  const otp       = generateOTP();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;

  otpStore[adminEmail] = { otp, expiresAt };

  // Send OTP email
  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: (process.env.GMAIL_PASS || "").replace(/\s/g, ""),
      },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from:    `"Mana Vastralu Security" <${process.env.GMAIL_USER}>`,
      to:      adminEmail,
      subject: `🔐 Admin Login OTP: ${otp} — Mana Vastralu`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f0a04;font-family:Arial,sans-serif;">
<div style="max-width:480px;margin:0 auto;background:#1a1008;padding:32px;">
  <h2 style="color:#c8a04a;font-size:18px;margin:0 0 8px;">🔐 Mana Vastralu — Admin Login</h2>
  <p style="color:#7a5a30;font-size:13px;margin:0 0 24px;">Someone is trying to log in to the admin dashboard.</p>
  <div style="background:#0f0a04;border:2px solid #c8a04a;border-radius:8px;
              padding:24px;text-align:center;margin-bottom:20px;">
    <p style="color:#7a5a30;font-size:12px;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase;">Your One-Time Password</p>
    <div style="font-size:42px;font-weight:700;color:#c8a04a;letter-spacing:10px;font-family:monospace;">
      ${otp}
    </div>
    <p style="color:#5a3a10;font-size:11px;margin:10px 0 0;">Valid for 5 minutes only</p>
  </div>
  <p style="color:#c62828;font-size:12px;margin:0;">
    ⚠️ If you didn't request this, someone may be trying to access your admin panel. Change your password immediately.
  </p>
</div>
</body></html>`,
    });

    console.log(`✅ OTP sent to ${adminEmail}: ${otp}`);
    res.json({ success: true, message: `OTP sent to ${adminEmail}` });

  } catch (err) {
    console.error("OTP email failed:", err.message);
    // Still return OTP in console for local dev if email fails
    console.log(`🔐 DEV OTP (email failed): ${otp}`);
    res.json({ success: true, message: "OTP sent (check server console if email fails)" });
  }
});

// ── Step 2: Verify OTP → grant access ───────────────
app.post("/api/admin/verify-otp", (req, res) => {
  const { otp } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  const stored     = otpStore[adminEmail];

  if (!stored) {
    return res.status(400).json({ success: false, message: "No OTP requested. Please start over." });
  }

  if (Date.now() > stored.expiresAt) {
    delete otpStore[adminEmail];
    return res.status(400).json({ success: false, message: "OTP expired. Please request a new one." });
  }

  if (stored.otp !== otp.trim()) {
    return res.status(400).json({ success: false, message: "Incorrect OTP. Please try again." });
  }

  // OTP correct — clear it (one-time use)
  delete otpStore[adminEmail];

  // Generate a session token valid for 2 hours
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt    = Date.now() + 2 * 60 * 60 * 1000;
  otpStore[`session_${sessionToken}`] = { expiresAt };

  res.json({ success: true, sessionToken });
});

// ── Middleware to verify admin session token ─────────
const verifyAdminSession = (req, res, next) => {
  const token   = req.headers["x-admin-token"] || req.query.adminToken;
  const session = token ? otpStore[`session_${token}`] : null;

  if (!session || Date.now() > session.expiresAt) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
  next();
};

// ── Optional: protect admin routes with session token ──
// Uncomment these if you want API-level protection too:
// app.use("/api/admin", verifyAdminSession);



// Admin — add/update tracking number for an order
app.put("/api/admin/orders/:id/tracking", async (req, res) => {
  const { password, courierName, trackingNumber,
          estimatedDelivery, status } = req.body;

  if (password !== "admin123")
    return res.status(401).json({ error: "Unauthorized" });

  try {
    // Auto-build DTDC tracking URL
    const trackingUrl = courierName === "DTDC"
      ? `https://www.dtdc.in/trace.asp?txndetails=${trackingNumber}`
      : trackingNumber
        ? `https://www.google.com/search?q=${courierName}+tracking+${trackingNumber}`
        : "";

    const updated = await Order.findByIdAndUpdate(
      req.params.id,
      {
        courierName,
        trackingNumber,
        trackingUrl,
        estimatedDelivery,
        status: status || "Shipped",
        shippedAt: new Date(),
      },
      { new: true }
    );
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ═══════════════════════════════════════════════════════
//  START — always last
// ═══════════════════════════════════════════════════════
app.listen(8000, () => {
  console.log("Server running on http://localhost:8000");
});