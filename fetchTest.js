const axios = require("axios");

async function test() {
  const url = "https://manavastralu-backend.onrender.com/api/admin/products?password=admin123";
  console.log("Fetching from:", url);
  try {
    const res = await axios.get(url);
    console.log("Status:", res.status);
    console.log("Body type:", typeof res.data);
    console.log("Is array:", Array.isArray(res.data));
    console.log("Body keys (if object):", typeof res.data === 'object' ? Object.keys(res.data) : 'N/A');
    console.log("Body:", res.data);
  } catch (err) {
    if (err.response) {
      console.log("Error status:", err.response.status);
      console.log("Error body:", err.response.data);
    } else {
      console.error(err);
    }
  }
}
test();
