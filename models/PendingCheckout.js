// backend/models/PendingCheckout.js
// A copy of the customer's cart + address, saved the moment a Razorpay payment
// is created. If the browser dies after the customer pays, the webhook (or the
// automatic reconciler) uses this copy to create the order anyway.
//
// Records are KEPT: the app never deletes them, it marks them "completed" with
// the order id. (The old 45-day auto-delete is removed — run
// scripts/pending-checkout-ttl.js once to remove the existing TTL index.)
const mongoose = require("mongoose");

const pendingCheckoutSchema = new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true },
  draft:           { type: mongoose.Schema.Types.Mixed, default: {} },
  amountPaise:     { type: Number, default: 0 },
  status:          { type: String, default: "pending" },   // pending | completed
  orderId:         { type: String, default: "" },
  paymentId:       { type: String, default: "" },
  completedAt:     { type: Date },
  createdAt:       { type: Date, default: Date.now },
});

module.exports = mongoose.model("PendingCheckout", pendingCheckoutSchema);