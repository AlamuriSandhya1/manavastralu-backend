require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB.");

    const db = mongoose.connection.db;
    const collection = db.collection("products");

    // 1. Remove "sku" field if it is empty string in existing products
    const updateResult = await collection.updateMany(
      { sku: "" },
      { $unset: { sku: "" } }
    );
    console.log(`Cleaned up empty sku fields: updated ${updateResult.modifiedCount} products.`);

    // 2. Drop the existing "sku_1" index
    try {
      await collection.dropIndex("sku_1");
      console.log("Successfully dropped index 'sku_1'.");
    } catch (e) {
      console.log("Index 'sku_1' does not exist or could not be dropped:", e.message);
    }

    console.log("Database index cleanup complete.");
  } catch (err) {
    console.error("Database operation failed:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}
run();
