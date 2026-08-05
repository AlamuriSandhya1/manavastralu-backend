const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const crypto  = require("crypto");

// ── Config from .env ──────────────────────────────────
const MERCHANT_ID  = process.env.PHONEPE_MERCHANT_ID || "PGTESTPAYUAT86";
const SALT_KEY     = process.env.PHONEPE_SALT_KEY    || "96434309-7796-489d-8924-ab56988a6076";
const SALT_INDEX   = process.env.PHONEPE_SALT_INDEX  || "1";
const ENV          = process.env.PHONEPE_ENV         || "UAT";
const FRONTEND_URL = process.env.FRONTEND_URL        || "http://localhost:3000";
const BACKEND_URL  = process.env.BACKEND_URL         || "http://localhost:8000";

const BASE_URL = ENV === "production"
  ? "https://api.phonepe.com/apis/hermes"
  : "https://api-preprod.phonepe.com/apis/pg-sandbox";

// ── Helper: SHA256 hash ───────────────────────────────
const sha256 = (str) =>
  crypto.createHash("sha256").update(str).digest("hex");

/* ═══════════════════════════════════════════════════════
   POST /api/phonepe/initiate
   Body: { amount, orderId, userEmail, userName, userPhone }
═══════════════════════════════════════════════════════ */
router.post("/initiate", async (req, res) => {
  try {
    const {
      amount,
      orderId,
      userEmail = "guest@gmail.com",
      userName  = "Customer",
      userPhone = "9999999999",
    } = req.body;

    if (!amount || isNaN(amount)) {
      return res.status(400).json({ success: false, message: "Valid amount is required" });
    }

    const merchantTransactionId = `MT_${Date.now()}_${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const amountInPaise         = Math.round(Number(amount) * 100);

    const payload = {
      merchantId:            MERCHANT_ID,
      merchantTransactionId,
      merchantUserId:        `USER_${userEmail.replace(/[^a-zA-Z0-9]/g, "_")}`,
      amount:                amountInPaise,
      redirectUrl:           `${BACKEND_URL}/api/phonepe/callback?orderId=${orderId || ""}&txnId=${merchantTransactionId}`,
      redirectMode:          "REDIRECT",
      callbackUrl:           `${BACKEND_URL}/api/phonepe/callback?orderId=${orderId || ""}&txnId=${merchantTransactionId}`,
      mobileNumber:          userPhone,
      paymentInstrument: {
        type: "PAY_PAGE",
      },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString("base64");
    const checksum      = sha256(`${base64Payload}/pg/v1/pay${SALT_KEY}`) + `###${SALT_INDEX}`;

    console.log("📱 PhonePe initiate:", { merchantTransactionId, amount: amountInPaise });

    const response = await axios.post(
      `${BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          "Content-Type":  "application/json",
          "X-VERIFY":      checksum,
          "X-MERCHANT-ID": MERCHANT_ID,
        },
      }
    );

    const data = response.data;

    if (data.success && data.data?.instrumentResponse?.redirectInfo?.url) {
      return res.json({
        success:              true,
        redirectUrl:          data.data.instrumentResponse.redirectInfo.url,
        merchantTransactionId,
      });
    }

    return res.status(400).json({
      success: false,
      message: data.message || "PhonePe initiation failed",
      code:    data.code,
    });

  } catch (err) {
    console.error("❌ PhonePe initiate error:", err.response?.data || err.message);
    res.status(500).json({
      success: false,
      message: err.response?.data?.message || err.message || "Payment initiation failed",
    });
  }
});

/* ═══════════════════════════════════════════════════════
   GET /api/phonepe/callback
   PhonePe redirects here after payment
═══════════════════════════════════════════════════════ */
router.get("/callback", async (req, res) => {
  try {
    const { orderId, txnId } = req.query;

    if (!txnId) {
      return res.redirect(`${FRONTEND_URL}/payment-failed?reason=missing_txn`);
    }

    // ── Verify payment status ──────────────────────────
    const path     = `/pg/v1/status/${MERCHANT_ID}/${txnId}`;
    const checksum = sha256(`${path}${SALT_KEY}`) + `###${SALT_INDEX}`;

    const response = await axios.get(`${BASE_URL}${path}`, {
      headers: {
        "Content-Type":  "application/json",
        "X-VERIFY":      checksum,
        "X-MERCHANT-ID": MERCHANT_ID,
        "accept":        "application/json",
      },
    });

    const data = response.data;
    console.log("📱 PhonePe callback status:", data.code, data.message);

    if (data.success && data.code === "PAYMENT_SUCCESS") {
      // ✅ Payment successful — redirect to success page
      return res.redirect(
        `${FRONTEND_URL}/order-success?` +
        `orderId=${orderId || ""}&` +
        `paymentId=${txnId}&` +
        `method=PhonePe&` +
        `amount=${data.data?.amount ? data.data.amount / 100 : ""}`
      );
    }

    // ❌ Payment failed or pending
    return res.redirect(
      `${FRONTEND_URL}/payment-failed?` +
      `reason=${data.code || "FAILED"}&` +
      `txnId=${txnId}`
    );

  } catch (err) {
    console.error("❌ PhonePe callback error:", err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/payment-failed?reason=verification_error`);
  }
});

/* ═══════════════════════════════════════════════════════
   POST /api/phonepe/verify
   Frontend can call this to check payment status
═══════════════════════════════════════════════════════ */
router.post("/verify", async (req, res) => {
  try {
    const { merchantTransactionId } = req.body;

    if (!merchantTransactionId) {
      return res.status(400).json({ success: false, message: "Transaction ID required" });
    }

    const path     = `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`;
    const checksum = sha256(`${path}${SALT_KEY}`) + `###${SALT_INDEX}`;

    const response = await axios.get(`${BASE_URL}${path}`, {
      headers: {
        "Content-Type":  "application/json",
        "X-VERIFY":      checksum,
        "X-MERCHANT-ID": MERCHANT_ID,
        "accept":        "application/json",
      },
    });

    const data = response.data;

    res.json({
      success:   data.success && data.code === "PAYMENT_SUCCESS",
      code:      data.code,
      message:   data.message,
      paymentId: merchantTransactionId,
      amount:    data.data?.amount ? data.data.amount / 100 : 0,
    });

  } catch (err) {
    console.error("❌ PhonePe verify error:", err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;