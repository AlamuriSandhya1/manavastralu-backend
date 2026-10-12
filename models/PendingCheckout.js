// backend/models/PendingCheckout.js
// A copy of the customer's cart + address, saved the moment a Razorpay payment
// is created. If the browser dies after the customer pays, the webhook uses this
// copy to create the order anyway.
const mongoose = require("mongoose");

const pendingCheckoutSchema = new mongoose.Schema({
  razorpayOrderId: { type: String, required: true, unique: true },
  draft:           { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt:       { type: Date, default: Date.now, expires: 60 * 60 * 24 * 45 },  // auto-clean after 45 days
});

module.exports = mongoose.model("PendingCheckout", pendingCheckoutSchema);