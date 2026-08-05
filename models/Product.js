const mongoose = require("mongoose");

const colorVariantSchema = new mongoose.Schema({
  name:  { type: String, required: true },
  stock: { type: Number, default: 0 },
  image: { type: String, default: "" },
}, { _id: false });

const productSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  description:   { type: String, default: "" },
  price:         { type: Number, required: true },
  originalPrice: { type: Number, default: 0 },
  fabric:        { type: String, default: "" },
  color:         { type: String, default: "" },
  category:      { type: String, default: "" },
  brand:         { type: String, default: "" },
  sku:           { type: String, unique: true, sparse: true },
  stock:         { type: Number, default: 10 },
  soldOut:       { type: Boolean, default: false },
  sizes:         [{ type: String }],

  // ✅ Use Mixed type — stores any plain object { xs:15, xl:5, xxl:5 }
  // Map type causes issues with plain object assignment
  sizeStock: {
    type:    mongoose.Schema.Types.Mixed,
    default: {},
  },

  colorVariants: [colorVariantSchema],
  images:        [{ type: String }],
}, {
  timestamps: true,
  // ✅ This ensures Mixed fields are detected when changed
  strict: false,
});

module.exports = mongoose.models.Product
  || mongoose.model("Product", productSchema);