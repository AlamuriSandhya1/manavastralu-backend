require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("./models/Product");

async function runTest() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB.");

    const blouse = await Product.findOne({ name: "Blouse" });
    if (!blouse) {
      console.log("Blouse product not found.");
      return;
    }

    console.log("Current Blouse:", blouse);

    blouse.sizeStock = { XL: 10, S: 0, M: 10 };
    blouse.markModified("sizeStock");
    const saved = await blouse.save();

    console.log("Updated Blouse in DB:", saved);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}
runTest();
