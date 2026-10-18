// HTTP-level behaviour of /add-order and /api/payment/confirm (status codes +
// response shape the frontend relies on), using the in-memory store.
//   node --test test/routes.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const memoryStore = require("./memoryStore");
const fakeRazorpay = require("./fakeRazorpay");
const createPaymentOrders = require("../services/paymentOrders");
const orderRoutes = require("../services/orderRoutes");

const KEY = "k_secret";
const sign = (s) => crypto.createHmac("sha256", KEY).update(s).digest("hex");
const quiet = { log() {}, warn() {}, error() {} };

function setup() {
  const store = memoryStore(), rzp = fakeRazorpay();
  const payments = createPaymentOrders({ store, razorpay: rzp, keySecret: KEY, webhookSecret: "w", log: quiet, retry: { baseMs: 1 } });
  return { store, rzp, routes: orderRoutes({ payments, backendUrl: "https://api.test", log: quiet }) };
}
async function paid(fx, status = "captured") {
  const id = `order_${crypto.randomBytes(4).toString("hex")}`;
  const draft = { email: "c@example.com", address: { fullName: "C", phone: "9000000000", pincode: "500001" }, products: [{ name: "Saree", price: 800, quantity: 1 }], total_amount: 800 };
  await fx.store.savePending(id, draft, { amountPaise: 80000 });
  const pay = fx.rzp.addPayment({ order_id: id, amount: 80000, status });
  return { body: { razorpay_order_id: id, paymentId: pay.id, razorpay_signature: sign(`${id}|${pay.id}`), ...draft }, pay };
}

test("old checkout payload to /add-order → 201 with orderId + labelUrl (unchanged contract)", async () => {
  const fx = setup(); const { body } = await paid(fx);
  const r = await fx.routes.addOrder(body);
  assert.equal(r.status, 201); assert.equal(r.json.success, true);
  assert.ok(r.json.orderId); assert.match(r.json.labelUrl, /\/api\/orders\/.+\/shipping-label$/);
  const again = await fx.routes.addOrder(body);
  assert.equal(String(again.json.orderId), String(r.json.orderId), "retry returns the same order");
});

test("COD to /add-order → 201, saved as Pending even if the browser says Paid", async () => {
  const fx = setup();
  const r = await fx.routes.addOrder({ email: "c@example.com", address: {}, products: [{ name: "B", price: 1, quantity: 1 }], payment_method: "COD", paymentStatus: "Paid" });
  assert.equal(r.status, 201); assert.equal(r.json.paymentStatus, "Pending");
});

test("failed payment → 402, forged/unknown payment → 400, Razorpay down + bad signature → 503; no orders", async () => {
  const fx = setup();
  const f = await paid(fx, "failed");
  assert.equal((await fx.routes.confirm(f.body)).status, 402);
  const u = await paid(fx);
  assert.equal((await fx.routes.confirm({ ...u.body, paymentId: "pay_FAKE" })).status, 400);
  fx.rzp._fail.fetch = 99;
  assert.equal((await fx.routes.confirm({ ...u.body, razorpay_signature: "x" })).status, 503);
  assert.equal(fx.store._orders.size, 0);
});

test("authorized-not-captured → 202 pending, no order", async () => {
  const fx = setup(); const { body } = await paid(fx, "authorized");
  const r = await fx.routes.confirm(body);
  assert.equal(r.status, 202); assert.equal(r.json.pending, true);
  assert.equal(fx.store._orders.size, 0);
});

test("missing payment id → 400; online method without payment id → 400", async () => {
  const fx = setup();
  assert.equal((await fx.routes.confirm({})).status, 400);
  assert.equal((await fx.routes.addOrder({ email: "a@b", products: [{ name: "x", price: 1 }], paymentMethod: "Razorpay" })).status, 400);
});