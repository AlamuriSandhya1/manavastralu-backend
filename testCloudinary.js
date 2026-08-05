require("dotenv").config();
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME?.trim(),
  api_key:    process.env.CLOUDINARY_API_KEY?.trim(),
  api_secret: process.env.CLOUDINARY_API_SECRET?.trim(),
});

console.log("Configured Cloudinary with Cloud Name:", process.env.CLOUDINARY_CLOUD_NAME);

async function testUpload() {
  try {
    console.log("Starting test upload to Cloudinary...");
    // upload a dummy base64 1x1 pixel image
    const res = await cloudinary.uploader.upload("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", {
      folder: "test-folder",
    });
    console.log("Upload Success! Result:", res.secure_url);
  } catch (err) {
    console.error("Upload Failed! Error:", err);
  } finally {
    process.exit(0);
  }
}

testUpload();
