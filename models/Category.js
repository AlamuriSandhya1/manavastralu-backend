// backend/models/Category.js
// Every category is an independent MAIN category.
// No parent / child / nested fields on purpose.
const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    name:      { type: String, required: true, trim: true },
    slug:      { type: String, required: true, trim: true, lowercase: true, unique: true },
    image:     { type: String, default: "" },      // "uploads/categories/x.jpg", "/images/..." or full URL
    isActive:  { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// unique name, case-insensitive ("mul cotton" == "Mul Cotton")
categorySchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

module.exports = mongoose.model("Category", categorySchema);