// backend/models/PaymentEvent.js
// Append-only audit trail of every payment step: webhook received, browser
// confirmation saved / rejected / pending, order created / duplicate, missing
// cart... Lets you answer "what happened to payment pay_XXX?" from MongoDB:
//   db.paymentevents.find({ paymentId: "pay_XXX" }).sort({ at: 1 })
// No customer address or cart is stored here (only ids, amounts, e-mail).
const mongoose = require("mongoose");

const paymentEventSchema = new mongoose.Schema({
  type:            { type: String, required: true },
  at:              { type: Date, default: Date.now },
  paymentId:       { type: String, default: "" },
  razorpayOrderId: { type: String, default: "" },
  orderId:         { type: String, default: "" },
  source:          { type: String, default: "" },
  detail:          { type: String, default: "" },
}, { versionKey: false });
paymentEventSchema.index({ paymentId: 1, at: 1 });
paymentEventSchema.index({ razorpayOrderId: 1, at: 1 });
paymentEventSchema.index({ at: -1 });

module.exports = mongoose.model("PaymentEvent", paymentEventSchema);