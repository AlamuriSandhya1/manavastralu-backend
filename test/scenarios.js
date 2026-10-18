// Scenario suite shared by the in-memory run (test/run-memory.test.js) and the
// real-MongoDB run (test/run-mongo.test.js). Each scenario gets a fresh fixture.
const assert = require("node:assert/strict");
const crypto = require("crypto");
const createPaymentOrders = require("../services/paymentOrders");
const fakeRazorpay = require("./fakeRazorpay");

const KEY_SECRET = "test_key_secret", WH_SECRET = "test_webhook_secret";
const sign = (s, str) => crypto.createHmac("sha256", s).update(str).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);

function makeService(store, extra = {}) {
  const rzp = fakeRazorpay();
  const emails = [], notified = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const svc = createPaymentOrders({
    store, razorpay: rzp, keySecret: KEY_SECRET, webhookSecret: WH_SECRET,
    onNewOrder: (o) => notified.push(String(o._id)),
    sendAlertEmail: async (a) => { emails.push(a); },
    log: quiet, retry: { baseMs: 1 }, ...extra,
  });
  return { svc, rzp, emails, notified };
}

const address = { fullName: "Lakshmi", phone: "9876543210", houseNo: "1-2", village: "Patancheru", district: "Sangareddy", state: "Telangana", pincode: "502319" };

module.exports = function defineScenarios(test, makeFixture) {
  // helper: a checkout the customer started (draft saved) and paid
  async function paidCheckout(fx, { productId, size = "M", qty = 1, price = 1500, amountRs, draftKey = "products", age = 3600, extraDraft = {} } = {}) {
    const rzpOrderId = `order_${crypto.randomBytes(5).toString("hex")}`;
    const draft = { email: "lakshmi@example.com", address, paymentMethod: "Razorpay", total_amount: qty * price,
      [draftKey]: [{ productId, name: "Kalamkari Saree", price, quantity: qty, selectedSize: size, color: "Red" }], ...extraDraft };
    await fx.store.savePending(rzpOrderId, draft);
    const pay = fx.rzp.addPayment({ order_id: rzpOrderId, amount: Math.round((amountRs ?? qty * price) * 100), status: "captured",
      email: "lakshmi@example.com", contact: "+919876543210", created_at: nowS() - age });
    return { rzpOrderId, pay, draft };
  }
  const webhookCall = (pay, secret = WH_SECRET, event = "payment.captured") => {
    const body = { event, payload: { payment: { entity: pay } } };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: sign(secret, rawBody), body };
  };
  const browserCall = (pay, cart) => ({
    razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id,
    razorpay_signature: sign(KEY_SECRET, `${pay.order_id}|${pay.id}`), ...cart,
  });

  test("browser confirm then webhook → ONE order, stock reduced once, cart marked completed", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Kalamkari Saree", price: 1500, stock: 5, sizes: ["M", "L"], sizeStock: { M: 3, L: 2 } });
    const { pay, draft, rzpOrderId } = await paidCheckout(fx, { productId: pid, qty: 2 });
    const r1 = await fx.svc.confirmFromBrowser(browserCall(pay, draft));
    const w = await fx.svc.handleWebhook(webhookCall(pay));
    assert.equal(w.status, 200);
    const r2 = await fx.svc.confirmFromBrowser(browserCall(pay, draft));       // browser retry
    assert.equal(String(r2.order._id), String(r1.order._id));
    const orders = await fx.orders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].paymentStatus, "Paid");
    assert.equal(orders[0].totalAmount, 3000);
    const p = await fx.product(pid);
    assert.equal(Number(p.sizeStock.M), 1); assert.equal(Number(p.stock), 3);
    assert.equal((await fx.pending(rzpOrderId)).status, "completed");
    assert.equal(fx.notified.length, 1, "admin/customer notified once");
  });

  test("webhook arrives first → browser gets the same order back", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Saree", price: 1500, stock: 4 });
    const { pay, draft } = await paidCheckout(fx, { productId: pid, size: "" });
    assert.equal((await fx.svc.handleWebhook(webhookCall(pay))).status, 200);
    const r = await fx.svc.confirmFromBrowser(browserCall(pay, draft));
    assert.equal(r.duplicate, true);
    assert.equal((await fx.orders()).length, 1);
    assert.equal(Number((await fx.product(pid)).stock), 3);
  });

  test("8 writers racing (webhooks + browser + reconciler) → ONE order, ONE stock deduction", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Saree", price: 1500, stock: 10, sizes: ["M"], sizeStock: { M: 10 } });
    const { pay, draft } = await paidCheckout(fx, { productId: pid, qty: 3, age: 3600 });
    await Promise.all([
      fx.svc.handleWebhook(webhookCall(pay)), fx.svc.handleWebhook(webhookCall(pay)), fx.svc.handleWebhook(webhookCall(pay, WH_SECRET, "order.paid")),
      fx.svc.confirmFromBrowser(browserCall(pay, draft)), fx.svc.confirmFromBrowser(browserCall(pay, draft)),
      fx.svc.reconcile({ apply: true, days: 2 }), fx.svc.reconcile({ apply: true, days: 2 }),
      fx.svc.processCapturedPayment(pay),
    ]);
    assert.equal((await fx.orders()).length, 1);
    const p = await fx.product(pid);
    assert.equal(Number(p.sizeStock.M), 7); assert.equal(Number(p.stock), 7);
  });

  test("webhook with a bad signature is rejected and saves nothing", async () => {
    const fx = await makeFixture(makeService);
    const { pay } = await paidCheckout(fx, { productId: "" });
    assert.equal((await fx.svc.handleWebhook(webhookCall(pay, "wrong-secret"))).status, 400);
    assert.equal((await fx.orders()).length, 0);
  });

  test("missing webhook secret → 500 + CONFIG alert", async () => {
    const fx = await makeFixture((store) => makeService(store, { webhookSecret: "" }));
    const { pay } = await paidCheckout(fx, { productId: "" });
    assert.equal((await fx.svc.handleWebhook(webhookCall(pay))).status, 500);
    assert.ok((await fx.alerts()).some((a) => a.type === "CONFIG"));
  });

  test("COD order (no payment) still saves and reduces stock", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Blouse", price: 500, stock: 2 });
    const r = await fx.svc.createOrder({ email: "a@b.com", address, products: [{ productId: pid, name: "Blouse", price: 500, quantity: 1 }], paymentMethod: "COD", totalAmount: 500 });
    assert.equal(r.created, true);
    assert.equal(Number((await fx.product(pid)).stock), 1);
  });

  test("cart saved under `items` instead of `products` is still recovered", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Saree", price: 1500, stock: 4 });
    await paidCheckout(fx, { productId: pid, size: "", draftKey: "items" });
    const rep = await fx.svc.reconcile({ apply: true, days: 2 });
    assert.equal(rep.summary.RECOVERABLE, 1);
    const o = (await fx.orders())[0];
    assert.equal(o.products[0].name, "Kalamkari Saree");
    assert.equal(o.products[0].quantity, 1);
  });

  test("signature mismatch but Razorpay confirms capture → Paid; authorized-only → NO order until captured", async () => {
    const fx = await makeFixture(makeService);
    const a = await paidCheckout(fx, { productId: "" });
    const r = await fx.svc.confirmFromBrowser({ ...browserCall(a.pay, a.draft), razorpay_signature: "tampered" });
    assert.equal(r.order.paymentStatus, "Paid");
    assert.equal(r.order.paymentVerifiedVia, "razorpay-api");
    const b = await paidCheckout(fx, { productId: "" });
    fx.rzp._payments.get(b.pay.id).status = "authorized";
    const r2 = await fx.svc.confirmFromBrowser(browserCall(b.pay, b.draft));
    assert.equal(r2.pending, true, "not captured → not an order yet");
    assert.ok(!(await fx.orders()).some((o) => o.paymentId === b.pay.id));
    // later webhook says captured → order flips to Paid, still one order
    fx.rzp._payments.get(b.pay.id).status = "captured";
    await fx.svc.handleWebhook(webhookCall(fx.rzp._payments.get(b.pay.id)));
    const os = (await fx.orders()).filter((o) => o.paymentId === b.pay.id);
    assert.equal(os.length, 1); assert.equal(os[0].paymentStatus, "Paid");
  });

  test("page never sent razorpay_order_id → server looks it up, webhook still de-duplicates", async () => {
    const fx = await makeFixture(makeService);
    const { pay, draft } = await paidCheckout(fx, { productId: "" });
    await fx.svc.confirmFromBrowser({ paymentId: pay.id, ...draft });           // old checkout page
    await fx.svc.handleWebhook(webhookCall(pay));
    assert.equal((await fx.orders()).length, 1);
  });

  // ───────────────── recovery / reconciliation ─────────────────
  async function messyHistory(fx) {
    const pid = await fx.seedProduct({ name: "Kalamkari Saree", price: 1500, stock: 6, sizes: ["M", "L"], sizeStock: { M: 4, L: 2 } });
    const A = await paidCheckout(fx, { productId: pid, qty: 2, age: 86400 * 3 });               // lost order
    const Bpay = fx.rzp.addPayment({ order_id: "order_NOCART", amount: 99900, status: "captured", email: "x@y.com", contact: "+919000000001", created_at: nowS() - 86400 * 5 });
    const C = await paidCheckout(fx, { productId: pid, age: 7200 }); fx.rzp._payments.get(C.pay.id).status = "authorized";
    const D = await paidCheckout(fx, { productId: pid, age: 7200 }); fx.rzp._payments.get(D.pay.id).status = "failed";
    const E = await paidCheckout(fx, { productId: pid, age: 7200 }); Object.assign(fx.rzp._payments.get(E.pay.id), { amount_refunded: fx.rzp._payments.get(E.pay.id).amount });
    const F = await paidCheckout(fx, { productId: pid, size: "L", amountRs: 10, age: 86400 });   // paid ₹10 for ₹1500
    const G = await paidCheckout(fx, { productId: pid, age: 86400 });
    await fx.svc.confirmFromBrowser(browserCall(G.pay, G.draft));                                // saved normally
    const H = await paidCheckout(fx, { productId: pid, size: "L", age: 86400 * 2 });
    const H2 = fx.rzp.addPayment({ order_id: H.rzpOrderId, amount: H.pay.amount, status: "captured", created_at: H.pay.created_at + 60 });
    const I = await paidCheckout(fx, { productId: pid, age: 60 });                               // checkout in progress
    const J = await paidCheckout(fx, { productId: pid, age: 86400 });                            // old order saved WITHOUT paymentId
    await fx.insertRawOrder({ email: "lakshmi@example.com", razorpay_id: J.rzpOrderId, paymentId: "", products: [{ name: "Kalamkari Saree", price: 1500, quantity: 1 }], totalAmount: 1500, total_amount: 1500, status: "Shipped" });
    return { pid, A, Bpay, C, D, E, F, G, H, H2, I, J };
  }

  test("DRY-RUN reports everything and changes NOTHING", async () => {
    const fx = await makeFixture(makeService);
    const h = await messyHistory(fx);
    const before = { orders: (await fx.orders()).length, stock: await fx.product(h.pid), alerts: (await fx.alerts()).length };
    const rep = await fx.svc.reconcile({ apply: false, days: 30 });
    assert.equal(rep.mode, "DRY-RUN");
    const cat = Object.fromEntries(rep.rows.map((r) => [r.paymentId, r.category]));
    assert.equal(cat[h.A.pay.id], "RECOVERABLE");
    assert.equal(cat[h.Bpay.id], "MANUAL_NO_CART_DATA");
    assert.equal(cat[h.C.pay.id], "NEEDS_CAPTURE");
    assert.equal(cat[h.D.pay.id], undefined, "failed payments are ignored");
    assert.equal(cat[h.E.pay.id], "SKIP_FULLY_REFUNDED");
    assert.equal(cat[h.F.pay.id], "NEEDS_REVIEW");
    assert.equal(cat[h.G.pay.id], "OK_ORDER_EXISTS");
    assert.equal(cat[h.H.pay.id], "RECOVERABLE");
    assert.equal(cat[h.H2.id], "DUPLICATE_PAYMENT");
    assert.equal(cat[h.I.pay.id], "SKIP_TOO_RECENT");
    assert.equal(cat[h.J.pay.id], "OK_ORDER_EXISTS");
    const rowA = rep.rows.find((r) => r.paymentId === h.A.pay.id);
    assert.equal(rowA.customer, "Lakshmi"); assert.equal(rowA.items[0].qty, 2);
    assert.match(rowA.stockPreview[0], /size M: \d+ → \d+/);
    assert.equal((await fx.orders()).length, before.orders);
    assert.deepEqual(await fx.product(h.pid), before.stock);
    assert.equal((await fx.alerts()).length, before.alerts);
    assert.equal((await fx.pending(h.A.rzpOrderId)).status, "pending");
  });

  test("APPLY recovers only verified orders with correct data; second APPLY changes nothing", async () => {
    const fx = await makeFixture(makeService);
    const h = await messyHistory(fx);
    const stockBefore = await fx.product(h.pid);
    const rep = await fx.svc.reconcile({ apply: true, days: 30 });
    const act = Object.fromEntries(rep.rows.map((r) => [r.paymentId, r.action]));
    assert.equal(act[h.A.pay.id], "created"); assert.equal(act[h.H.pay.id], "created");
    assert.equal(act[h.F.pay.id], "held-for-review");

    const orders = await fx.orders();
    const oA = orders.find((o) => o.paymentId === h.A.pay.id);
    assert.equal(oA.products[0].quantity, 2); assert.equal(oA.products[0].price, 1500);
    assert.equal(oA.products[0].selectedSize, "M"); assert.equal(oA.address.pincode, "502319");
    assert.equal(oA.email, "lakshmi@example.com"); assert.equal(oA.totalAmount, 3000);
    assert.equal(oA.paymentStatus, "Paid"); assert.equal(oA.adminViewedAt, null, "shows as NEW in admin");
    assert.equal(new Date(oA.createdAt).getTime(), h.A.pay.created_at * 1000, "dated when the customer paid");
    assert.ok(oA.recoveredAt);
    assert.ok(!orders.some((o) => o.paymentId === h.F.pay.id), "suspicious one held back");
    assert.ok(!orders.some((o) => o.paymentId === h.Bpay.id), "no placeholder unless asked");
    assert.ok(!orders.some((o) => o.paymentId === h.H2.id), "no second order for a double payment");
    const oJ = orders.find((o) => o.razorpay_id === h.J.rzpOrderId);
    assert.equal(oJ.paymentId, h.J.pay.id, "empty paymentId back-filled"); assert.equal(oJ.status, "Shipped", "nothing else touched");

    const s1 = await fx.product(h.pid);
    assert.equal(Number(s1.sizeStock.M), Number(stockBefore.sizeStock.M) - 2);   // A
    assert.equal(Number(s1.sizeStock.L), Number(stockBefore.sizeStock.L) - 1);   // H
    const types = (await fx.alerts()).map((a) => a.type);
    for (const t of ["NEEDS_CAPTURE", "PAID_NO_CART", "RECOVERY_NEEDS_REVIEW", "DUPLICATE_PAYMENT"]) assert.ok(types.includes(t), t);
    const emailsAfterFirst = fx.emails.length;

    const n = orders.length;
    const rep2 = await fx.svc.reconcile({ apply: true, days: 30 });
    assert.equal((await fx.orders()).length, n, "re-run creates no orders");
    assert.deepEqual(await fx.product(h.pid), s1, "re-run touches no stock");
    assert.equal(rep2.summary.RECOVERABLE || 0, 0);
    assert.equal(fx.emails.length, emailsAfterFirst, "no repeated alert e-mails");
    assert.equal(fx.notified.length, 1, "recovered orders don't e-mail customers (only G's live checkout did)");
  });

  test("APPLY with includeReview / placeholders handles the held cases, once", async () => {
    const fx = await makeFixture(makeService);
    const h = await messyHistory(fx);
    await fx.svc.reconcile({ apply: true, days: 30 });
    await fx.svc.reconcile({ apply: true, days: 30, includeReview: true, placeholders: true });
    await fx.svc.reconcile({ apply: true, days: 30, includeReview: true, placeholders: true });
    const orders = await fx.orders();
    const oF = orders.filter((o) => o.paymentId === h.F.pay.id);
    assert.equal(oF.length, 1); assert.match(oF[0].needsReview, /paid only ₹10/);
    const oB = orders.filter((o) => o.paymentId === h.Bpay.id);
    assert.equal(oB.length, 1); assert.match(oB[0].products[0].name, /items unknown/);
  });

  test("`only` limits APPLY to the payments you approved from the dry-run", async () => {
    const fx = await makeFixture(makeService);
    const h = await messyHistory(fx);
    await fx.svc.reconcile({ apply: true, days: 30, only: [h.H.pay.id] });
    const orders = await fx.orders();
    assert.ok(orders.some((o) => o.paymentId === h.H.pay.id));
    assert.ok(!orders.some((o) => o.paymentId === h.A.pay.id));
  });

  if (makeFixture.canSimulateOutages) {
    test("database outage during webhook → 500 (Razorpay retries) → redelivery saves it once", async () => {
      const fx = await makeFixture(makeService);
      const pid = await fx.seedProduct({ name: "Saree", price: 1500, stock: 3 });
      const { pay } = await paidCheckout(fx, { productId: pid, size: "" });
      fx.store._failures.find = 1; fx.store._failures.pending = 10;
      assert.equal((await fx.svc.handleWebhook(webhookCall(pay))).status, 500);
      assert.equal((await fx.orders()).length, 0);
      fx.store._failures.pending = 0;
      assert.equal((await fx.svc.handleWebhook(webhookCall(pay))).status, 200);
      assert.equal((await fx.orders()).length, 1);
      assert.equal(Number((await fx.product(pid)).stock), 2);
    });

    test("short DB blip on insert is retried internally — no order lost, no duplicate", async () => {
      const fx = await makeFixture(makeService);
      const { pay, draft } = await paidCheckout(fx, { productId: "" });
      fx.store._failures.insert = 2;
      const r = await fx.svc.confirmFromBrowser(browserCall(pay, draft));
      assert.equal(r.created, true);
      assert.equal((await fx.orders()).length, 1);
    });

    test("Razorpay API timeouts during reconcile are retried", async () => {
      const fx = await makeFixture(makeService);
      await paidCheckout(fx, { productId: "" });
      fx.rzp._fail.all = 2;
      const rep = await fx.svc.reconcile({ apply: true, days: 2 });
      assert.equal(rep.summary.RECOVERABLE, 1);
    });

    test("stock update failure never loses the order and raises an alert", async () => {
      const fx = await makeFixture(makeService);
      const pid = await fx.seedProduct({ name: "Saree", price: 1500, stock: 3 });
      const { pay, draft } = await paidCheckout(fx, { productId: pid, size: "" });
      fx.store._failures.stock = 10;
      const r = await fx.svc.confirmFromBrowser(browserCall(pay, draft));
      assert.equal(r.created, true);
      assert.ok((await fx.alerts()).some((a) => a.type === "STOCK_UPDATE_FAILED"));
      fx.store._failures.stock = 0;
      await fx.svc.reconcile({ apply: true, days: 2 });
      assert.equal(Number((await fx.product(pid)).stock), 3, "never deducted twice, even after a failure");
    });
  }
};