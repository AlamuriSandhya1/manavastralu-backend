#!/usr/bin/env node
// backend/scripts/recover-missing-orders.js
// ─────────────────────────────────────────────────────────────────────────────
// Finds Razorpay payments that were captured but have no order, and rebuilds
// the orders from the saved carts (pendingcheckouts).
//
//   DRY-RUN (default — changes nothing, writes a report):
//     node scripts/recover-missing-orders.js --days=60
//
//   APPLY (backs up first, then creates only verified orders):
//     node scripts/recover-missing-orders.js --days=60 --apply
//
//   Options
//     --days=N            how far back to check Razorpay (1-180, default 45)
//     --only=pay_A,pay_B  apply only these payments (copy ids from the dry-run report)
//     --include-review    also create orders flagged NEEDS_REVIEW (marked for checking)
//     --placeholders      create a visible "items unknown" order for paid payments with no saved cart
//     --notify            send the normal customer/admin e-mails for recovered orders (off by default)
//
// Safe to run any number of times: an order that exists is never created again
// and stock is never reduced twice.
// ─────────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Razorpay = require("razorpay");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));
const APPLY = !!args.apply;
const DAYS = Math.min(Math.max(Number(args.days) || 45, 1), 180);
const ONLY = args.only ? String(args.only).split(",").map((s) => s.trim()).filter(Boolean) : null;

const Order = require("../models/Order");
const Product = require("../models/Product");
const PendingCheckout = require("../models/PendingCheckout");
const PaymentAlert = require("../models/PaymentAlert");
const mongoStore = require("../services/mongoStore");
const createPaymentOrders = require("../services/paymentOrders");

const outDir = path.join(__dirname, "..", "recovery-reports");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

async function backup(dir) {
  // full copy of every collection the recovery can touch
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, model] of [["orders", Order], ["products", Product], ["pendingcheckouts", PendingCheckout], ["paymentalerts", PaymentAlert]]) {
    const docs = await model.collection.find({}).toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 1));
    console.log(`   backed up ${docs.length} ${name}`);
  }
}

function printReport(rep) {
  const line = "─".repeat(78);
  console.log(`\n${line}\n ${rep.mode} — Razorpay payments in the last ${rep.days} days: ${rep.paymentsChecked}\n${line}`);
  const order = ["RECOVERABLE", "NEEDS_REVIEW", "MANUAL_NO_CART_DATA", "DUPLICATE_PAYMENT", "NEEDS_CAPTURE", "OK_ORDER_EXISTS", "SKIP_TOO_RECENT", "SKIP_FULLY_REFUNDED"];
  const help = {
    RECOVERABLE:          "paid, cart saved, all checks pass → will be created",
    NEEDS_REVIEW:         "paid, cart saved, but something looks wrong → held (use --include-review)",
    MANUAL_NO_CART_DATA:  "paid, but NO saved cart → contact customer (or --placeholders)",
    DUPLICATE_PAYMENT:    "second payment for the same checkout → refund in Razorpay",
    NEEDS_CAPTURE:        "authorized, not captured → capture in Razorpay or it auto-refunds",
    OK_ORDER_EXISTS:      "already in the dashboard",
    SKIP_TOO_RECENT:      "paid in the last 10 min, checkout still finishing",
    SKIP_FULLY_REFUNDED:  "refunded",
  };
  for (const k of order) if (rep.summary[k]) console.log(` ${String(rep.summary[k]).padStart(4)}  ${k.padEnd(22)} ${help[k]}`);
  for (const cat of ["RECOVERABLE", "NEEDS_REVIEW", "MANUAL_NO_CART_DATA", "DUPLICATE_PAYMENT", "NEEDS_CAPTURE"]) {
    const rows = rep.rows.filter((r) => r.category === cat);
    if (!rows.length) continue;
    console.log(`\n ▸ ${cat}`);
    for (const r of rows) {
      console.log(`   ${r.paymentId}  ₹${r.amountRs}  ${r.paidAt}  ${r.customer || r.razorpayEmail || ""} ${r.phone || r.razorpayPhone || ""}`);
      if (r.address) console.log(`      📍 ${r.address}`);
      for (const i of r.items) console.log(`      • ${i.name}${i.size ? ` [${i.size}]` : ""}${i.color ? ` ${i.color}` : ""} × ${i.qty} @ ₹${i.price}`);
      for (const s of r.stockPreview) console.log(`      📦 ${s}`);
      for (const why of r.reasons) console.log(`      ⚠️  ${why}`);
      if (r.action && r.action !== "none") console.log(`      → ${r.action}${r.orderId ? ` (order ${r.orderId})` : ""}`);
    }
  }
  console.log(line);
}

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  console.log(`✅ Connected to ${mongoose.connection.name} | mode: ${APPLY ? "APPLY" : "DRY-RUN (no changes)"}`);

  const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  let emailSvc = {}; try { emailSvc = require("../emailService"); } catch {}
  const payments = createPaymentOrders({
    store: mongoStore({ Order, Product, PendingCheckout, PaymentAlert }),
    razorpay,
    sendAlertEmail: require("../services/alertEmail")(emailSvc),
    log: { log: () => {}, warn: console.warn, error: console.error },
  });

  fs.mkdirSync(outDir, { recursive: true });
  if (APPLY) {
    const dir = path.join(outDir, `backup-${stamp}`);
    console.log(`💾 Backing up to ${dir}`);
    await backup(dir);
    await Order.collection.createIndex({ paymentId: 1 }, { unique: true, partialFilterExpression: { paymentId: { $gt: "" } } })
      .catch((e) => console.warn("⚠️ paymentId unique index not created:", e.message, "(duplicates are still prevented by the fixed order _id)"));
    // orders saved by the old code already had their stock reduced
    await Order.collection.updateMany({ stockDeductedAt: { $exists: false } }, [{ $set: { stockDeductedAt: { $ifNull: ["$createdAt", "$$NOW"] } } }]);
  }

  const rep = await payments.reconcile({
    apply: APPLY, days: DAYS, minAgeMinutes: 10, only: ONLY,
    includeReview: !!args["include-review"], placeholders: !!args.placeholders,
    silent: !args.notify, source: "recovery-script",
  });

  printReport(rep);
  const base = path.join(outDir, `${APPLY ? "apply" : "dry-run"}-${stamp}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(rep, null, 2));
  const head = ["category", "action", "paymentId", "razorpayOrderId", "orderId", "amountRs", "paidAt", "customer", "phone", "razorpayEmail", "razorpayPhone", "address", "items", "stockPreview", "reasons"];
  const rows = rep.rows.map((r) => head.map((h) => csvCell(
    h === "items" ? r.items.map((i) => `${i.name} ${i.size || ""} x${i.qty} @${i.price}`).join(" | ")
    : Array.isArray(r[h]) ? r[h].join(" | ") : r[h])).join(","));
  fs.writeFileSync(`${base}.csv`, [head.join(","), ...rows].join("\n"));
  console.log(`📄 Report: ${base}.json\n📄 Report: ${base}.csv`);
  if (!APPLY && rep.summary.RECOVERABLE) console.log(`\nNext: review the report, then run again with --apply  (optionally --only=${rep.rows.filter(r => r.category === "RECOVERABLE").map(r => r.paymentId).slice(0, 3).join(",")}...)`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("❌", e.error?.description || e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});