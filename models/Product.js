const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name:          { type: String, required: true },
  description:   { type: String, default: "" },
  price:         { type: Number, required: true },
  originalPrice: { type: Number, default: 0 },
  sizes:         { type: [String], default: [] },
  fabric:        { type: String, default: "" },
  color:         { type: String, default: "" },
  images:        { type: [String], default: [] },
  stock:         { type: Number, default: 10 },
  soldOut:       { type: Boolean, default: false },
  category:      { type: String, default: "" },
  colorVariants: [
    {
      name:  { type: String, default: "" },
      stock: { type: Number, default: 10 },
      image: { type: String, default: "" },
    }
  ],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Product", productSchema);