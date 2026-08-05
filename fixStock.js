// ══════════════════════════════════════════════════════
//  fixStock.js — Run once to fix sizeStock in MongoDB
//  Usage: node fixStock.js
//  Place in: backend/ folder
// ══════════════════════════════════════════════════════
require("dotenv").config();
const mongoose = require("mongoose");

// Use Mixed type to avoid Map issues
const productSchema = new mongoose.Schema({}, {
  strict: false,
  timestamps: true,
});
const Product = mongoose.models.Product || mongoose.model("Product", productSchema);

async function fixAllProducts() {
  try {
    console.log("🔗 Connecting...");
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      family: 4,
    });
    console.log("✅ Connected");

    const products = await Product.find({});
    console.log(`📦 Found ${products.length} products`);

    for (const p of products) {
      const sizes  = p.sizes || [];
      const stock  = Number(p.stock) || 0;

      console.log(`\n📌 ${p.name}`);
      console.log(`   sizes: ${JSON.stringify(sizes)}`);
      console.log(`   stock: ${stock}`);
      console.log(`   current sizeStock: ${JSON.stringify(p.sizeStock)}`);

      // If sizeStock is already correct (has keys matching sizes), skip
      const existingSS = p.sizeStock || {};
      const hasCorrectSS = sizes.length > 0 &&
        sizes.every(s => existingSS[s] !== undefined) &&
        Object.keys(existingSS).length === sizes.length;

      if (hasCorrectSS) {
        console.log(`   ✅ Already has correct sizeStock — skipping`);
        continue;
      }

      // Build sizeStock by distributing stock equally across sizes
      const newSizeStock = {};
      if (sizes.length > 0 && stock > 0) {
        const base  = Math.floor(stock / sizes.length);
        const extra = stock % sizes.length;
        sizes.forEach((s, i) => {
          newSizeStock[s] = base + (i < extra ? 1 : 0);
        });
      }

      console.log(`   🔧 Setting sizeStock to: ${JSON.stringify(newSizeStock)}`);

      // Use updateOne with $set — most reliable way to update Mixed fields
      await Product.collection.updateOne(
        { _id: p._id },
        { $set: { sizeStock: newSizeStock } }
      );

      // Verify
      const updated = await Product.findById(p._id).lean();
      console.log(`   ✅ Saved: ${JSON.stringify(updated.sizeStock)}`);
    }

    console.log("\n✅ All products fixed! Restart your backend now.");
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixAllProducts();