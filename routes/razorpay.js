const express   = require("express");
const router    = express.Router();
const Razorpay  = require("razorpay");
const crypto    = require("crypto");
const Order     = require("../models/Order");

// ✅ Init Razorpay with your keys from .env
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ── CREATE ORDER ── */
router.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ success: false, message: "Valid amount is required" });
    }

    // ✅ Check keys are loaded
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error("❌ Razorpay keys missing in .env");
      return res.status(500).json({ success: false, message: "Payment configuration error" });
    }

    const options = {
      amount:   Math.round(Number(amount) * 100), // paise
      currency: "INR",
      receipt:  `rcpt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    // ✅ Frontend expects: key, amount, currency, orderId
    res.json({
      success:  true,
      key:      process.env.RAZORPAY_KEY_ID,
      amount:   order.amount,
      currency: order.currency,
      orderId:  order.id,
    });

  } catch (err) {
    console.error("❌ Razorpay create-order error:", err);
    res.status(500).json({
      success: false,
      message: err.error?.description || err.message || "Could not create payment order",
    });
  }
});

/* ── VERIFY PAYMENT ── */
router.post("/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Missing payment details" });
    }

    // ✅ Verify signature
    const body      = razorpay_order_id + "|" + razorpay_payment_id;
    const expected  = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expected !== razorpay_signature) {
      console.error("❌ Signature mismatch");
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    res.json({ success: true, paymentId: razorpay_payment_id });

  } catch (err) {
    console.error("❌ Razorpay verify error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;