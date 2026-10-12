// backend/scripts/backupOrders.js
// READ-ONLY. Copies the orders (and pending checkouts) to a JSON file before any repair.
//   node scripts/backupOrders.js
// Also take an Atlas snapshot (Atlas → Database → Backup → Take Snapshot Now) — that is the real safety net.
require("dotenv").config();
// same DNS fix your server.js uses (Atlas "mongodb+srv" lookups fail on some networks without it)
require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const dir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const db = mongoose.connection.db;
  for (const name of ["orders", "pendingcheckouts"]) {
    const docs = await db.collection(name).find({}).toArray();
    const file = path.join(dir, `${name}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(docs));
    console.log(`✔ ${name}: ${docs.length} documents → ${file}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("Backup failed:", e.message); process.exit(1); });