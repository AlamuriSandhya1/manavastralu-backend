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

  razorpay_id:    { type: String, default: null },
  paymentId:      { type: String, default: "" },
  paymentStatus:  { type: String, default: "Pending" },

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

}, { timestamps: true });   // timestamps adds createdAt + updatedAt automatically

module.exports = mongoose.model("Order", orderSchema);