const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  productId:    String,
  name:         String,
  price:        Number,
  quantity:     { type: Number, default: 1 },
  size:         { type: String, default: "" },
  selectedSize: { type: String, default: "" },
  color:        { type: String, default: "" },
  image:        { type: String, default: "" },
  images:       { type: [String], default: [] },
}, { _id: false });


const orderSchema = new mongoose.Schema({
  user_id:        String,
  email:          { type: String, required: true },
  phone:          { type: String, default: "Not Provided" },
  address:        { type: mongoose.Schema.Types.Mixed, default: {} },

  // both field names — old code uses payment_method, new uses paymentMethod
  payment_method: { type: String, default: "COD" },
  paymentMethod:  { type: String, default: "" },

  razorpay_id:    { type: String, default: null },   // Razorpay order id (order_xxx)
  paymentId:      { type: String, default: "" },     // Razorpay payment id (pay_xxx)
  paymentStatus:  { type: String, default: "Pending" },
  paymentVerifiedVia: { type: String, default: "" }, // "razorpay-api" | "signature" | ""

  total_amount:   { type: Number, default: 0 },
  totalAmount:    { type: Number, default: 0 },

  status:         { type: String, default: "Confirmed" },
  products:       [productSchema],

  // ✅ Courier tracking fields — now INSIDE the schema
  courierName:       { type: String, default: "" },
  trackingNumber:    { type: String, default: "" },
  trackingUrl:       { type: String, default: "" },
  estimatedDelivery: { type: String, default: "" },
  shippedAt:         { type: Date },

  // null = admin has not seen this order yet (drives the red badge on Orders)
  adminViewedAt:     { type: Date, default: null },

  // ✅ NEW — reliability fields
  source:          { type: String, default: "checkout" }, // checkout | webhook | reconcile-auto | recovery-script | ...
  needsReview:     { type: String, default: "" },         // non-empty = something to check before shipping
  recoveredAt:     { type: Date, default: null },         // set when the order was rebuilt after a lost save
  stockDeductedAt: { type: Date, default: null },         // set exactly once → stock never reduced twice
  stockDeduction:  { type: mongoose.Schema.Types.Mixed, default: undefined },

}, { timestamps: true });   // timestamps adds createdAt + updatedAt automatically

orderSchema.index({ razorpay_id: 1 });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);