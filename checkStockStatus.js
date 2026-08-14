require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./models/Product");

async function checkStock() {
  try {
    console.log("Connecting to database...");
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      family: 4,
    });
    console.log("Connected successfully!\n");

    const products = await Product.find({});
    console.log(`=== CURRENT PRODUCT STOCK STATUS ===`);
    console.log(`Total Products: ${products.length}`);

    products.forEach((p, idx) => {
      console.log(`\n[${idx + 1}] Product Name: "${p.name}"`);
      console.log(`    Overall Stock: ${p.stock} | Sold Out Status: ${p.soldOut ? "🔴 SOLD OUT" : "🟢 IN STOCK"}`);
      
      // Sizes stock
      if (p.sizes && p.sizes.length > 0) {
        const sizeStockObj = p.sizeStock instanceof Map 
          ? Object.fromEntries(p.sizeStock) 
          : (p.sizeStock || {});
        console.log(`    Size Stock levels:`, JSON.stringify(sizeStockObj));
      }
      
      // Color variants stock
      if (p.colorVariants && p.colorVariants.length > 0) {
        console.log(`    Color Variant Stock levels:`);
        p.colorVariants.forEach(v => {
          console.log(`      - ${v.name}: ${v.stock} pcs ${v.stock === 0 ? "🔴 (Sold out)" : "🟢 (Available)"}`);
        });
      }
    });
    console.log(`\n====================================`);
  } catch (err) {
    console.error("❌ Error querying stock status:", err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

checkStock();
