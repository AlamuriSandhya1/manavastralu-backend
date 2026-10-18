// backend/models/PaymentAlert.js
// Problems the system could not fix on its own (paid but no cart, double
// payment, uncaptured payment, stock not reduced...). Shown in the Admin
// Dashboard until marked resolved. One row per problem (`key`), repeats only
// increase `count`, so the admin is e-mailed once per problem.
const mongoose = require("mongoose");

const paymentAlertSchema = new mongoose.Schema({
  key:             { type: String, required: true, unique: true },
  type:            { type: String, required: true },
  message:         { type: String, default: "" },
  paymentId:       { type: String, default: "" },
  razorpayOrderId: { type: String, default: "" },
  orderId:         { type: String, default: "" },
  amount:          { type: Number, default: 0 },
  count:           { type: Number, default: 1 },
  firstSeenAt:     { type: Date, default: Date.now },
  lastSeenAt:      { type: Date, default: Date.now },
  resolvedAt:      { type: Date, default: null },
});
paymentAlertSchema.index({ resolvedAt: 1, lastSeenAt: -1 });

module.exports = mongoose.model("PaymentAlert", paymentAlertSchema);