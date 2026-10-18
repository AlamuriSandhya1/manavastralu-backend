// Same scenarios against a REAL MongoDB (throw-away, in memory) using your
// actual Order / PendingCheckout / PaymentAlert models and mongoStore.js.
//   npm i -D mongodb-memory-server
//   node --test test/run-mongo.test.js
const { test, before, after } = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const defineScenarios = require("./scenarios");
const defineReviewScenarios = require("./scenarios-review");
const PaymentEvent = require("../models/PaymentEvent");
const Order = require("../models/Order");
const PendingCheckout = require("../models/PendingCheckout");
const PaymentAlert = require("../models/PaymentAlert");
const mongoStore = require("../services/mongoStore");

// Uses your real Product model when present; otherwise a stand-in with the same fields.
let Product;
try { Product = require("../models/Product"); }
catch {
  Product = mongoose.model("Product", new mongoose.Schema({
    name: String, price: Number, stock: Number, soldOut: Boolean, sizes: [String],
    sizeStock: { type: Map, of: Number, default: {} },
  }, { timestamps: true }));
}

let mongod;
before(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all([Order.init(), PendingCheckout.init(), PaymentAlert.init()]);
  await Order.collection.createIndex({ paymentId: 1 }, { unique: true, partialFilterExpression: { paymentId: { $gt: "" } } });
});
after(async () => { await mongoose.disconnect(); await mongod?.stop(); });

async function makeFixture(makeService) {
  await Promise.all([Order.deleteMany({}), Product.deleteMany({}), PendingCheckout.deleteMany({}), PaymentAlert.deleteMany({}), PaymentEvent.deleteMany({})]);   // throw-away test DB only
  const store = mongoStore({ Order, Product, PendingCheckout, PaymentAlert, PaymentEvent });
  const { svc, rzp, emails, notified } = makeService(store);
  const plain = (x) => JSON.parse(JSON.stringify(x));
  return {
    store, svc, rzp, emails, notified,
    async seedProduct(p) { const r = await Product.collection.insertOne({ ...p, soldOut: false, createdAt: new Date() }); return String(r.insertedId); },   // bypasses your schema's required fields
    async orders() { return plain(await Order.find().lean()); },
    async product(id) { const p = plain(await Product.findById(id).lean()); delete p.updatedAt; return p; },
    async pending(id) { return PendingCheckout.findOne({ razorpayOrderId: id }).lean(); },
    async alerts() { return PaymentAlert.find().lean(); },
    async events() { return PaymentEvent.find().sort({ at: 1 }).lean(); },
    async adminOrders() { return plain(await Order.find().sort({ createdAt: -1 }).lean()); },   // same query as GET /api/admin/orders
    async insertRawOrder(o) { await Order.collection.insertOne({ ...o, createdAt: new Date(), stockDeductedAt: new Date(), adminViewedAt: new Date() }); },
  };
}
makeFixture.canSimulateOutages = false;

defineScenarios(test, makeFixture);
defineReviewScenarios(test, makeFixture);

test("admin dashboard query sees recovered orders as unread", async () => {
  const n = await Order.collection.countDocuments({ adminViewedAt: null, status: { $ne: "Cancelled" } });
  const all = await Order.find().sort({ createdAt: -1 }).lean();   // exactly what /api/admin/orders returns
  if (all.length) {
    const recovered = all.filter((o) => o.recoveredAt);
    if (recovered.length && n < recovered.length) throw new Error("recovered orders not counted as unread");
  }
});