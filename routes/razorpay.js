require("dotenv").config();
const express  = require("express");
const Razorpay = require("razorpay");
const crypto   = require("crypto");
const router   = express.Router();

console.log("🔑 Razorpay KEY_ID:", process.env.RAZORPAY_KEY_ID ? "✅ Loaded" : "❌ MISSING");
console.log("🔑 Razorpay SECRET:", process.env.RAZORPAY_KEY_SECRET ? "✅ Loaded" : "❌ MISSING");

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});

// ── POST /api/payment/create-order ────────────────────
router.post("/create-order", async (req, res) => {
  try {
    console.log("💰 create-order hit! Amount:", req.body.amount);

    const { amount } = req.body;

    if (!amount || isNaN(Number(amount))) {
      return res.status(400).json({ success: false, message: "Valid amount required" });
    }

    if (!process.env.RAZORPAY_KEY_ID) {
      return res.status(500).json({ success: false, message: "Razorpay keys not configured" });
    }

    const order = await razorpay.orders.create({
      amount:   Math.round(Number(amount) * 100),
      currency: "INR",
      receipt:  `mana_${Date.now()}`,
    });

    console.log("✅ Razorpay order created:", order.id);

    res.json({
      success:  true,
      key:      process.env.RAZORPAY_KEY_ID,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
    });

  } catch (err) {
    console.error("❌ Razorpay error:", err);
    res.status(500).json({
      success: false,
      message: err.error?.description || err.message || "Failed to create order",
    });
  }
});

// ── POST /api/payment/verify ──────────────────────────
router.post("/verify", (req, res) => {
  try {
    console.log("🔍 verify hit!");

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing verification fields" });
    }

    const body     = razorpay_order_id + "|" + razorpay_payment_id;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected === razorpay_signature) {
      console.log("✅ Payment verified!");
      res.json({ success: true, message: "Payment verified" });
    } else {
      console.log("❌ Signature mismatch!");
      res.status(400).json({ success: false, message: "Invalid signature" });
    }

  } catch (err) {
    console.error("❌ verify error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;