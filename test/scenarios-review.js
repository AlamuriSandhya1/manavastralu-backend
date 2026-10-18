// Review scenarios: verification rules, customer isolation, failure modes.
// Shared by test/run-memory.test.js and test/run-mongo.test.js.
const assert = require("node:assert/strict");
const crypto = require("crypto");
const createPaymentOrders = require("../services/paymentOrders");
const fakeRazorpay = require("./fakeRazorpay");

const KEY_SECRET = "test_key_secret", WH_SECRET = "test_webhook_secret";
const sign = (s, str) => crypto.createHmac("sha256", s).update(str).digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const quiet = { log() {}, warn() {}, error() {} };

function makeService(store, extra = {}) {
  const rzp = fakeRazorpay();
  const emails = [], notified = [];
  const svc = createPaymentOrders({
    store, razorpay: rzp, keySecret: KEY_SECRET, webhookSecret: WH_SECRET,
    onNewOrder: (o) => notified.push(String(o._id)), sendAlertEmail: async (a) => { emails.push(a); },
    log: quiet, retry: { baseMs: 1 }, ...extra,
  });
  return { svc, rzp, emails, notified };
}

const customer = (n) => ({
  email: `customer${n}@example.com`,
  address: { fullName: `Customer ${n}`, phone: `90000${String(n).padStart(5, "0")}`, houseNo: `${n}-1`, village: "Patancheru", district: "Sangareddy", state: "Telangana", pincode: "502319" },
});

module.exports = function defineReviewScenarios(test, makeFixture) {
  // a checkout the way the real site does it: draft saved at create-order, then a payment
  async function checkout(fx, n, { productId = "", qty = 1, price = 1000, status = "captured", age = 3600, saveDraft = true } = {}) {
    const c = customer(n);
    const rzpOrderId = `order_${crypto.randomBytes(6).toString("hex")}`;
    const draft = { ...c, paymentMethod: "Razorpay", total_amount: qty * price,
      products: [{ productId, name: `Saree for ${n}`, price, quantity: qty, selectedSize: "", color: "" }] };
    if (saveDraft) await fx.store.savePending(rzpOrderId, draft, { amountPaise: qty * price * 100 });
    const pay = fx.rzp.addPayment({ order_id: rzpOrderId, amount: qty * price * 100, status,
      email: c.email, contact: `+91${c.address.phone}`, created_at: nowS() - age });
    return { c, rzpOrderId, draft, pay };
  }
  const browserBody = (pay, cart, sigOrderId = pay.order_id) => ({
    razorpay_order_id: sigOrderId, razorpay_payment_id: pay.id,
    razorpay_signature: sign(KEY_SECRET, `${sigOrderId}|${pay.id}`), ...cart,
  });
  const webhook = (pay, event = "payment.captured", secret = WH_SECRET) => {
    const body = { event, payload: { payment: { entity: { ...pay } } } };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, signature: sign(secret, rawBody), body };
  };
  const expectReject = async (p, status) => {
    await assert.rejects(p, (e) => { assert.equal(e.status, status, `expected HTTP ${status}, got ${e.status}: ${e.message}`); return true; });
  };

  // ── failed / unverified payments ─────────────────────────────────────────
  test("[review] failed payment: browser confirm is rejected, no order, no stock change", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Saree", price: 1000, stock: 5 });
    const { pay, draft } = await checkout(fx, 1, { productId: pid, status: "failed" });
    await expectReject(fx.svc.confirmFromBrowser(browserBody(pay, draft)), 402);
    const w = await fx.svc.handleWebhook(webhook(pay, "payment.failed"));
    assert.equal(w.status, 200);
    assert.equal((await fx.orders()).length, 0);
    assert.equal(Number((await fx.product(pid)).stock), 5);
  });

  test("[review] forged signature + Razorpay unreachable → NO order (unverified), retryable 503", async () => {
    const fx = await makeFixture(makeService);
    const { pay, draft } = await checkout(fx, 2);
    fx.rzp._fail.fetch = 99;
    await expectReject(fx.svc.confirmFromBrowser({ ...browserBody(pay, draft), razorpay_signature: "forged" }), 503);
    assert.equal((await fx.orders()).length, 0);
  });

  test("[review] made-up payment id → rejected, NO order", async () => {
    const fx = await makeFixture(makeService);
    const { draft, rzpOrderId } = await checkout(fx, 3);
    await expectReject(fx.svc.confirmFromBrowser({ razorpay_order_id: rzpOrderId, razorpay_payment_id: "pay_DOESNOTEXIST", razorpay_signature: "x", ...draft }), 400);
    assert.equal((await fx.orders()).length, 0);
  });

  test("[review] valid signature + Razorpay unreachable → order saved (signature-verified)", async () => {
    const fx = await makeFixture(makeService);
    const { pay, draft } = await checkout(fx, 4);
    fx.rzp._fail.fetch = 99;
    const r = await fx.svc.confirmFromBrowser(browserBody(pay, draft));
    assert.equal(r.created, true);
    assert.equal(r.order.paymentVerifiedVia, "signature");
    assert.equal(r.order.email, "customer4@example.com");
  });

  test("[review] authorized-but-not-captured → no order yet (pending); created once webhook says captured", async () => {
    const fx = await makeFixture(makeService);
    const { pay, draft } = await checkout(fx, 5, { status: "authorized" });
    const r = await fx.svc.confirmFromBrowser(browserBody(pay, draft));
    assert.equal(r.pending, true);
    assert.equal((await fx.orders()).length, 0);
    fx.rzp._payments.get(pay.id).status = "captured";
    await fx.svc.handleWebhook(webhook(fx.rzp._payments.get(pay.id)));
    const orders = await fx.orders();
    assert.equal(orders.length, 1); assert.equal(orders[0].paymentStatus, "Paid");
  });

  test("[review] COD request cannot mark itself Paid; online method without payment id is refused", async () => {
    const fx = await makeFixture(makeService);
    const cod = await fx.svc.createCodOrder({ ...customer(6), products: [{ name: "Blouse", price: 500, quantity: 1 }], payment_method: "COD", paymentStatus: "Paid" });
    assert.equal(cod.order.paymentStatus, "Pending");
    await expectReject(fx.svc.createCodOrder({ ...customer(6), products: [{ name: "Blouse", price: 500, quantity: 1 }], paymentMethod: "Razorpay", paymentStatus: "Paid" }), 400);
    assert.equal((await fx.orders()).length, 1);
  });

  // ── customer isolation ───────────────────────────────────────────────────
  test("[review] customer B cannot claim customer A's checkout with B's payment", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 10, { status: "authorized" });   // A has not paid yet
    const B = await checkout(fx, 11);
    // B sends A's checkout id with B's payment id (signature can't be computed without the secret)
    await expectReject(fx.svc.confirmFromBrowser({ ...browserBody(B.pay, A.draft), razorpay_order_id: A.rzpOrderId, razorpay_signature: "guess" }), 400);
    // even with a signature made for the wrong pair, Razorpay's own record decides
    await expectReject(fx.svc.confirmFromBrowser(browserBody(B.pay, A.draft, A.rzpOrderId)), 400);
    assert.equal((await fx.orders()).filter((o) => o.email === A.c.email).length, 0, "nothing assigned to A");
    assert.equal((await fx.pending(A.rzpOrderId)).status, "pending", "A's checkout untouched");
  });

  test("[review] cart/email/address sent by the browser cannot override the server-saved cart", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 12);
    const evil = { email: "someone-else@example.com", address: customer(99).address,
      products: [{ name: "Expensive Pattu", price: 1, quantity: 9 }], total_amount: 9 };
    const r = await fx.svc.confirmFromBrowser(browserBody(A.pay, evil));
    assert.equal(r.order.email, A.c.email);
    assert.equal(r.order.address.fullName, A.c.address.fullName);
    assert.equal(r.order.products[0].name, "Saree for 12");
    assert.equal(r.order.totalAmount, 1000);
  });

  test("[review] 40 customers checking out at once (browser + duplicate webhooks + reconciler interleaved) → 40 orders, each with its own customer", async () => {
    const fx = await makeFixture(makeService);
    const pid = await fx.seedProduct({ name: "Saree", price: 1000, stock: 500 });
    const N = 40;
    const cs = await Promise.all(Array.from({ length: N }, (_, i) => checkout(fx, 100 + i, { productId: pid, qty: 1 + (i % 3) })));
    const jobs = [];
    cs.forEach((x, i) => {
      if (i % 4 !== 0) jobs.push(fx.svc.confirmFromBrowser(browserBody(x.pay, x.draft)));       // 1 in 4: browser closed
      jobs.push(fx.svc.handleWebhook(webhook(x.pay)));
      if (i % 2 === 0) jobs.push(fx.svc.handleWebhook(webhook(x.pay, "order.paid")));          // duplicate delivery
    });
    jobs.push(fx.svc.reconcile({ apply: true, days: 2 }), fx.svc.reconcile({ apply: true, days: 2 }));
    jobs.sort(() => Math.random() - 0.5);
    await Promise.all(jobs);

    const orders = await fx.orders();
    assert.equal(orders.length, N);
    for (const x of cs) {
      const mine = orders.filter((o) => o.paymentId === x.pay.id);
      assert.equal(mine.length, 1);
      const o = mine[0];
      assert.equal(o.email, x.c.email, "email belongs to the payer");
      assert.equal(o.address.fullName, x.c.address.fullName);
      assert.equal(o.address.phone, x.c.address.phone);
      assert.equal(o.razorpay_id, x.rzpOrderId);
      assert.equal(o.products[0].name, x.draft.products[0].name);
      assert.equal(o.products[0].quantity, x.draft.products[0].quantity);
      assert.equal(o.totalAmount, x.draft.total_amount);
    }
    const sold = cs.reduce((s, x) => s + x.draft.products[0].quantity, 0);
    assert.equal(Number((await fx.product(pid)).stock), 500 - sold, "stock reduced exactly once per order");
  });

  // ── browser closure / frontend failure / webhook behaviour ───────────────
  test("[review] browser closed AND webhook never delivered → reconciler creates the order from the saved cart", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 20, { age: 30 * 60 });
    const rep = await fx.svc.reconcile({ apply: true, days: 2, minAgeMinutes: 10 });
    assert.equal(rep.rows.find((r) => r.paymentId === A.pay.id).action, "created");
    const o = (await fx.orders())[0];
    assert.equal(o.email, A.c.email); assert.equal(o.paymentVerifiedVia, "razorpay-api");
  });

  test("[review] frontend confirm request fails mid-way and is retried → still one order", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 21);
    fx.store._failures && (fx.store._failures.insert = 1);
    await Promise.allSettled([fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft))]);
    await fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft));
    await fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft));
    assert.equal((await fx.orders()).length, 1);
  });

  test("[review] webhook with tampered body (signature mismatch) is rejected", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 22);
    const w = webhook(A.pay);
    w.body.payload.payment.entity.amount = 1;                                  // body changed after signing
    w.rawBody = Buffer.from(JSON.stringify(w.body));
    assert.equal((await fx.svc.handleWebhook(w)).status, 400);
    assert.equal((await fx.orders()).length, 0);
  });

  test("[review] webhook replayed 10 times concurrently → one order", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 23);
    const rs = await Promise.all(Array.from({ length: 10 }, () => fx.svc.handleWebhook(webhook(A.pay))));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal((await fx.orders()).length, 1);
  });

  // ── missing pending checkout drafts ──────────────────────────────────────
  test("[review] paid but NO draft: webhook creates nothing and raises PAID_NO_CART alert immediately", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 30, { saveDraft: false });
    const w = await fx.svc.handleWebhook(webhook(A.pay));
    assert.equal(w.status, 200);
    assert.equal((await fx.orders()).length, 0);
    assert.ok((await fx.alerts()).some((a) => a.type === "PAID_NO_CART" && a.paymentId === A.pay.id));
  });

  test("[review] paid but NO draft: verified browser confirm saves the order from the browser cart, flagged for review", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 31, { saveDraft: false });
    const r = await fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft));
    assert.equal(r.created, true);
    assert.equal(r.order.email, A.c.email);
    assert.match(r.order.needsReview, /not saved before payment/);
  });

  // ── records are kept, and everything is logged ───────────────────────────
  test("[review] pending checkouts are never deleted; every step is in the payment event log", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 40); const B = await checkout(fx, 41, { status: "failed" });
    await fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft));
    await fx.svc.handleWebhook(webhook(A.pay));
    await fx.svc.confirmFromBrowser(browserBody(B.pay, B.draft)).catch(() => {});
    await fx.svc.reconcile({ apply: true, days: 2 });
    assert.ok(await fx.pending(A.rzpOrderId), "A's pending record kept");
    assert.equal((await fx.pending(A.rzpOrderId)).status, "completed");
    assert.ok(await fx.pending(B.rzpOrderId), "B's pending record kept");
    const ev = (await fx.events()).map((e) => `${e.type}:${e.paymentId || ""}`);
    assert.ok(ev.includes(`order.created:${A.pay.id}`), "creation logged");
    assert.ok(ev.some((e) => e.startsWith("webhook.received") && e.endsWith(A.pay.id)), "webhook logged");
    assert.ok(ev.some((e) => e.startsWith("order.duplicate") && e.endsWith(A.pay.id)), "duplicate logged");
    assert.ok(ev.some((e) => e.startsWith("confirm.rejected") && e.endsWith(B.pay.id)), "rejection logged");
  });

  test("[review] recovered and live orders are visible to the admin query and marked unread", async () => {
    const fx = await makeFixture(makeService);
    const A = await checkout(fx, 50); const B = await checkout(fx, 51);
    await fx.svc.confirmFromBrowser(browserBody(A.pay, A.draft));
    await fx.svc.reconcile({ apply: true, days: 2 });
    const all = await fx.adminOrders();
    for (const x of [A, B]) {
      const o = all.find((y) => y.paymentId === x.pay.id);
      assert.ok(o, "in admin list"); assert.equal(o.adminViewedAt, null); assert.ok(o.createdAt);
      assert.ok(Array.isArray(o.products) && o.products.length);
    }
  });
};