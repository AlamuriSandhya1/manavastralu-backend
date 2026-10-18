// backend/services/paymentOrders.js
// ─────────────────────────────────────────────────────────────────────────────
// Everything that turns a Razorpay payment into an order lives here, so the
// browser, the webhook, the automatic reconciler and the recovery script all
// go through ONE code path with the same safety rules:
//
//   • One order per checkout. The order _id is derived from the Razorpay order
//     id (or payment id), so two writers racing each other collide on _id —
//     the second one gets the first one's order back. This works even if the
//     paymentId unique index could not be created.
//   • Stock is deducted at most once per order (atomic "claim" flag).
//   • A payment is only turned into an order after Razorpay confirms it is
//     captured (or the webhook, signed by Razorpay, says so).
//   • Nothing is ever deleted: pending checkouts are marked "completed".
//   • Anything that cannot be fixed automatically becomes a PaymentAlert,
//     shown in the Admin Dashboard and e-mailed to the admin.
//
// It has no direct dependency on Mongoose: it talks to a small "store"
// (see mongoStore.js) so the same logic can be tested without a database.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");

const MAX_RECONCILE_DAYS = 180;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 4, baseMs = 400, label = "op", log = console } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (e && e.noRetry) throw e;
      if (i < tries - 1) {
        const wait = baseMs * 2 ** i;
        log.warn?.(`↻ ${label} failed (${e.message}) — retry ${i + 1}/${tries - 1} in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw last;
}

// 24-hex id (a valid ObjectId) derived from a stable key.
const stableId = (key) => crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 24);
const orderIdFor = ({ razorpayOrderId, paymentId }) =>
  razorpayOrderId ? stableId(`rzp_order:${razorpayOrderId}`)
  : paymentId     ? stableId(`rzp_payment:${paymentId}`)
  : null;

const rupees = (paise) => Math.round(Number(paise || 0)) / 100;
const isCaptured = (p) => !!p && p.status === "captured" && Number(p.amount_refunded || 0) < Number(p.amount || 0);
const isDupKey = (e) => e && (e.code === 11000 || e.code === 11001);

function timingSafeEqualHex(a, b) {
  const A = Buffer.from(String(a || ""), "utf8"), B = Buffer.from(String(b || ""), "utf8");
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

// The checkout page may have used any of these names for the cart.
const draftItems = (d = {}) => {
  for (const k of ["products", "items", "cart", "cartItems"]) if (Array.isArray(d[k]) && d[k].length) return d[k];
  return [];
};
const draftTotal = (d = {}) => Number(d.total_amount ?? d.totalAmount ?? d.amount ?? d.total ?? 0) || 0;

const normalizeItems = (items) => items.map((item) => ({
  productId:    String(item.productId || item._id || item.id || ""),
  name:         String(item.name || item.title || ""),
  price:        Number(item.price) || 0,
  quantity:     Math.max(1, Number(item.quantity || item.qty) || 1),
  size:         item.selectedSize || item.size || "",
  selectedSize: item.selectedSize || item.size || "",
  color:        item.color || item.selectedColor || "",
  image:        item.image || item.images?.[0] || "",
}));

module.exports = function createPaymentOrders(deps) {
  const {
    store, razorpay,
    keySecret     = () => process.env.RAZORPAY_KEY_SECRET,
    webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET,
    emitStockUpdate = () => {},
    onNewOrder      = () => {},          // admin WhatsApp + customer/admin e-mail
    sendAlertEmail  = async () => {},
    log  = console,
    now  = () => new Date(),
    retry = {},                          // tests pass { baseMs: 1 }
  } = deps;

  const R = (fn, label) => withRetry(fn, { log, label, ...retry });
  const secretOf = (v) => (typeof v === "function" ? v() : v);

  // ── audit log: one JSON line in the server log + a row in `paymentevents` ──
  // Never throws: logging must not break order saving.
  async function logEvent(type, d = {}) {
    const e = { type, at: now(), paymentId: d.paymentId || "", razorpayOrderId: d.razorpayOrderId || "",
      orderId: d.orderId ? String(d.orderId) : "", source: d.source || "", detail: d.detail || "" };
    try { log.log?.(`[payment] ${JSON.stringify(e)}`); } catch {}
    try { if (store.logEvent) await store.logEvent(e); } catch (err) { log.error?.("Could not save payment event:", err.message); }
  }
  const httpError = (status, message) => Object.assign(new Error(message), { status, noRetry: true });

  // ── alerts ───────────────────────────────────────────────────────────────
  async function alert(type, key, message, extra = {}) {
    log.error?.(`🚨 [${type}] ${message}`);
    try {
      const { created } = await store.upsertAlert(`${type}:${key}`, { type, message, ...extra });
      if (created) sendAlertEmail({ type, message, ...extra }).catch((e) => log.error?.("Alert e-mail failed:", e.message));
    } catch (e) { log.error?.("Could not save alert:", e.message); }
  }

  // ── stock: at most once per order, atomic per product ────────────────────
  async function deductStockOnce(order) {
    const claimed = await R(() => store.claimStockDeduction(order._id), "claim stock");
    if (!claimed) return { skipped: true };
    const results = [];
    for (const item of order.products || []) {
      if (!item.productId) continue;
      const size = item.selectedSize || item.size || "";
      try {
        const p = await R(() => store.decrementStock(item.productId, size, item.quantity), "stock update");
        if (!p) { results.push({ productId: item.productId, size, qty: item.quantity, result: "product-not-found" }); continue; }
        results.push({ productId: item.productId, size, qty: item.quantity, result: "ok", stockAfter: p.stock });
        try { emitStockUpdate(p); } catch {}
      } catch (e) {
        results.push({ productId: item.productId, size, qty: item.quantity, result: "error", error: e.message });
        await alert("STOCK_UPDATE_FAILED", `${order._id}:${item.productId}:${size}`,
          `Order #${String(order._id).slice(-8).toUpperCase()} saved, but stock for "${item.name}" ${size} was NOT reduced — adjust it by hand.`,
          { orderId: String(order._id) });
      }
    }
    await store.setOrderFields(order._id, { stockDeduction: results }).catch(() => {});
    return { results };
  }

  // ── the ONE place an order is created ────────────────────────────────────
  // returns { order, created, duplicate }
  async function createOrder(input, { silent = false } = {}) {
    const items = normalizeItems(input.products || []);
    if (!items.length) { const e = new Error("No items in order"); e.status = 400; e.noRetry = true; throw e; }
    const { paymentId = "", razorpayOrderId = "" } = input;

    if (paymentId) {
      const ex = await R(() => store.findOrderByPaymentId(paymentId), "find order");
      if (ex) {
        await logEvent("order.duplicate", { paymentId, razorpayOrderId, orderId: ex._id, source: input.source, detail: "already saved" });
        return { order: ex, duplicate: true };
      }
    }
    if (razorpayOrderId) {
      const ex = await R(() => store.findOrderByRzpOrderId(razorpayOrderId), "find order");
      if (ex) return sameCheckout(ex, paymentId);
    }

    const email  = String(input.email || "").trim() || "guest@gmail.com";
    const total  = Number(input.totalAmount) || items.reduce((s, i) => s + i.price * i.quantity, 0);
    const method = input.paymentMethod || "COD";
    const at     = input.createdAt ? new Date(input.createdAt) : now();
    const doc = {
      _id: orderIdFor({ razorpayOrderId, paymentId }) || undefined,
      user_id: input.user_id || email, email,
      phone: String(input.phone || input.address?.phone || "") || "Not Provided",
      address: input.address || {},
      payment_method: method, paymentMethod: method,
      razorpay_id: razorpayOrderId || null,
      paymentId, paymentStatus: input.paymentStatus || "Pending",
      paymentVerifiedVia: input.paymentVerifiedVia || "",
      total_amount: total, totalAmount: total,
      products: items,
      status: "Confirmed",
      source: input.source || "checkout",
      needsReview: input.needsReview || "",
      recoveredAt: input.recovered ? now() : null,
      adminViewedAt: null,                 // shows as NEW + red badge in the dashboard
      stockDeductedAt: null,
      createdAt: at, updatedAt: now(),
    };

    let order;
    try {
      order = await R(async () => {
        try { return await store.insertOrder(doc); }
        catch (e) { if (isDupKey(e)) e.noRetry = true; throw e; }
      }, "insert order");
    } catch (e) {
      if (!isDupKey(e)) throw e;
      // another writer (browser / webhook / reconciler) saved it first
      const ex = (paymentId && await store.findOrderByPaymentId(paymentId))
              || (razorpayOrderId && await store.findOrderByRzpOrderId(razorpayOrderId))
              || (doc._id && await store.findOrderById(doc._id));
      if (!ex) throw e;
      return sameCheckout(ex, paymentId);
    }

    log.log?.(`✅ Order saved: ${order._id} | ${order.source} | items:${items.length} | ${order.paymentStatus}`);
    await logEvent("order.created", { paymentId, razorpayOrderId, orderId: order._id, source: order.source,
      detail: `${order.email} | ₹${total} | ${items.length} item(s) | ${order.paymentStatus}${order.needsReview ? " | review: " + order.needsReview : ""}` });
    await deductStockOnce(order).catch((e) => log.error?.("Stock step failed (order is saved):", e.message));
    if (order.needsReview) {
      await alert("ORDER_NEEDS_REVIEW", String(order._id),
        `Order #${String(order._id).slice(-8).toUpperCase()} needs a check: ${order.needsReview}`,
        { orderId: String(order._id), paymentId, razorpayOrderId, amount: total });
    }
    if (!silent) { try { onNewOrder(order); } catch (e) { log.error?.("notify failed:", e.message); } }
    return { order, created: true };
  }

  async function sameCheckout(existing, paymentId) {
    await logEvent("order.duplicate", { paymentId, razorpayOrderId: existing.razorpay_id || "", orderId: existing._id,
      detail: existing.paymentId && paymentId && existing.paymentId !== paymentId ? "different payment for same checkout" : "already saved" });
    if (paymentId && existing.paymentId && existing.paymentId !== paymentId) {
      await alert("DUPLICATE_PAYMENT", paymentId,
        `Customer paid twice for the same checkout (order #${String(existing._id).slice(-8).toUpperCase()}). ` +
        `Extra payment ${paymentId} has NO separate order — refund it in Razorpay.`,
        { orderId: String(existing._id), paymentId, razorpayOrderId: existing.razorpay_id });
      return { order: existing, duplicate: true, duplicatePayment: true };
    }
    if (paymentId && !existing.paymentId) {
      await store.setOrderFields(existing._id, { paymentId, paymentStatus: "Paid" }).catch(() => {});
    }
    return { order: existing, duplicate: true };
  }

  // ── build an order input from a cart + a VERIFIED payment ────────────────
  // `pay` must be a payment Razorpay itself vouched for (API fetch or signed
  // webhook) or one proven by a valid checkout signature.
  function orderFromDraft(draft, pay, { source, recovered = false, via = "razorpay-api", pending = null, extraReasons = [] }) {
    const items   = draftItems(draft);
    const paidRs  = rupees(pay.amount);
    const reasons = [...extraReasons];
    const dTotal  = draftTotal(draft);
    const itemsRs = normalizeItems(items).reduce((s, i) => s + i.price * i.quantity, 0);
    if (pending?.amountPaise && pay.amount != null && Number(pending.amountPaise) !== Number(pay.amount))
      reasons.push(`checkout was created for ₹${rupees(pending.amountPaise)} but payment is ₹${paidRs}`);
    if (dTotal && Math.abs(dTotal - paidRs) > 1) reasons.push(`cart total ₹${dTotal} but customer paid ₹${paidRs}`);
    if (itemsRs && paidRs + 1 < itemsRs)         reasons.push(`items cost ₹${itemsRs} but customer paid only ₹${paidRs}`);
    if (Number(pay.amount_refunded) > 0)          reasons.push(`₹${rupees(pay.amount_refunded)} already refunded`);
    const addr = draft.address || {};
    if (!addr || !Object.keys(addr).length)       reasons.push("no delivery address saved");
    else if (!(addr.pincode || addr.pinCode))     reasons.push("address has no pincode");
    normalizeItems(items).forEach((i, n) => {
      if (!i.name)  reasons.push(`item ${n + 1} has no name`);
      if (!i.price) reasons.push(`item ${n + 1} has no price`);
    });
    return {
      input: {
        user_id: draft.user_id, email: draft.email || pay.email || "",
        phone: draft.phone || addr.phone || String(pay.contact || "").replace(/^\+?91/, ""),
        address: addr, products: items,
        paymentMethod: draft.paymentMethod || draft.payment_method || `Razorpay${pay.method ? " " + pay.method : ""}`,
        paymentId: pay.id, razorpayOrderId: pay.order_id,
        paymentStatus: "Paid", paymentVerifiedVia: via,
        totalAmount: paidRs,                       // what the customer actually paid
        createdAt: recovered ? new Date(Number(pay.created_at) * 1000) : undefined,
        needsReview: reasons.join("; "), source, recovered,
      },
      reasons, itemsCount: items.length,
    };
  }

  // ── a captured payment → order (webhook + reconciler) ────────────────────
  // The cart ALWAYS comes from the draft saved for this exact Razorpay order,
  // so a payment can only ever become the order of the customer who started it.
  async function processCapturedPayment(pay, { source = "webhook", silent = false, recovered = false } = {}) {
    if (!isCaptured(pay)) return { status: "not-captured" };
    const ex = (await store.findOrderByPaymentId(pay.id)) || (pay.order_id && await store.findOrderByRzpOrderId(pay.order_id));
    if (ex) {
      const r = await sameCheckout(ex, pay.id);
      if (!r.duplicatePayment && ex.paymentId === pay.id && ex.paymentStatus !== "Paid")
        await store.setOrderFields(ex._id, { paymentStatus: "Paid", paymentVerifiedVia: "razorpay-api" }).catch(() => {});
      return { status: r.duplicatePayment ? "duplicate-payment" : "exists", orderId: ex._id };
    }
    const pending = pay.order_id && await R(() => store.getPending(pay.order_id), "load cart");
    if (!pending || !draftItems(pending.draft).length) {
      await logEvent("payment.no_cart", { paymentId: pay.id, razorpayOrderId: pay.order_id, source, detail: pending ? "draft has no items" : "no draft saved" });
      await alert("PAID_NO_CART", pay.id,
        `₹${rupees(pay.amount)} paid (${pay.id}, ${pay.email || "-"}, ${pay.contact || "-"}) but no saved cart, so no order was created. Contact the customer.`,
        { paymentId: pay.id, razorpayOrderId: pay.order_id || "", amount: rupees(pay.amount) });
      return { status: "no-cart-saved" };
    }

    const { input } = orderFromDraft(pending.draft, pay, { source, recovered, pending });
    const r = await createOrder(input, { silent });
    await store.updatePending(pay.order_id, { status: "completed", orderId: String(r.order._id), paymentId: pay.id, completedAt: now() }).catch(() => {});
    return { status: r.created ? "created" : (r.duplicatePayment ? "duplicate-payment" : "exists"), orderId: r.order._id, needsReview: input.needsReview };
  }

  // ── Razorpay webhook ─────────────────────────────────────────────────────
  // Answers 2xx ONLY after the order is safely stored; any failure answers 500
  // so Razorpay retries (it keeps retrying for ~24h).
  async function handleWebhook({ rawBody, signature, body }) {
    const secret = secretOf(webhookSecret);
    if (!secret) {
      await alert("CONFIG", "webhook-secret", "RAZORPAY_WEBHOOK_SECRET is not set — paid orders are NOT protected if the browser closes.");
      return { status: 500, json: { error: "RAZORPAY_WEBHOOK_SECRET not set" } };
    }
    const expected = crypto.createHmac("sha256", secret).update(rawBody || "").digest("hex");
    if (!timingSafeEqualHex(signature, expected)) {
      await logEvent("webhook.bad_signature", { detail: "rejected (body not trusted)" });
      return { status: 400, json: { error: "Bad signature" } };
    }

    const ev  = body?.event;
    const pay = body?.payload?.payment?.entity;
    await logEvent("webhook.received", { paymentId: pay?.id, razorpayOrderId: pay?.order_id, source: "webhook", detail: `${ev} | status=${pay?.status || "-"}` });
    if (!pay || !["payment.captured", "order.paid"].includes(ev)) return { status: 200, json: { received: true, ignored: ev } };
    try {
      const r = await processCapturedPayment(pay, { source: "webhook" });
      log.log?.(`🔔 Razorpay webhook ${ev} | ${pay.id} | ${r.status}`);
      return { status: 200, json: { received: true, result: r.status } };
    } catch (e) {
      await logEvent("webhook.failed", { paymentId: pay.id, razorpayOrderId: pay.order_id, source: "webhook", detail: e.message });
      log.error?.(`❌ Webhook ${pay.id} failed, Razorpay will retry:`, e.message);
      return { status: 500, json: { error: "processing failed, please retry" } };
    }
  }

  // ── Browser confirmation (after Razorpay checkout says "success") ────────
  // body: { razorpay_order_id, razorpay_payment_id | paymentId, razorpay_signature, ...cart fields }
  //
  // Rules:
  //   • An order is created ONLY for a verified payment:
  //       – Razorpay's API says this payment is captured, or
  //       – the API is unreachable but the checkout signature is valid.
  //   • Failed / unknown / mismatched payments are refused (no order).
  //   • Authorized-not-captured → { pending:true }, no order (webhook/reconciler finish it).
  //   • The checkout is taken from Razorpay's record of the payment, never from
  //     the request, and the cart from the draft saved for that checkout.
  //     Browser-sent cart is used only if no draft exists, and is flagged.
  async function confirmFromBrowser(body = {}) {
    const paymentId = String(body.razorpay_payment_id || body.paymentId || "").trim();
    const claimedOrderId = String(body.razorpay_order_id || "").trim();
    const sig = String(body.razorpay_signature || "");
    if (!paymentId) throw httpError(400, "razorpay_payment_id required");

    const secret = secretOf(keySecret);
    const sigValid = !!(claimedOrderId && sig && secret) && timingSafeEqualHex(sig,
      crypto.createHmac("sha256", secret).update(`${claimedOrderId}|${paymentId}`).digest("hex"));

    let pay = null, apiError = null;
    try { pay = await R(async () => {
      try { return await razorpay.payments.fetch(paymentId); }
      catch (e) { if (e.statusCode && e.statusCode < 500) e.noRetry = true; throw e; }
    }, "fetch payment"); }
    catch (e) { apiError = e; }

    const ev = (type, detail) => logEvent(type, { paymentId, razorpayOrderId: pay?.order_id || claimedOrderId, source: "checkout", detail });
    let verified;                 // { pay, via }
    if (pay) {
      if (claimedOrderId && pay.order_id !== claimedOrderId) {
        await ev("confirm.rejected", `payment belongs to ${pay.order_id}, browser claimed ${claimedOrderId}`);
        await alert("CONFIRM_MISMATCH", paymentId, `Checkout confirmation for ${claimedOrderId} used payment ${paymentId}, which belongs to ${pay.order_id}. Request refused — no order created.`,
          { paymentId, razorpayOrderId: claimedOrderId });
        throw httpError(400, "This payment does not belong to this checkout");
      }
      if (pay.status === "authorized") {
        await ev("confirm.pending", "authorized, waiting for capture");
        return { pending: true, paymentStatus: "Authorized" };
      }
      if (!isCaptured(pay)) {
        await ev("confirm.rejected", `Razorpay status: ${pay.status}${Number(pay.amount_refunded) ? " (refunded)" : ""}`);
        throw httpError(402, `Payment is not successful (status: ${pay.status})`);
      }
      verified = { pay, via: "razorpay-api" };
    } else if (sigValid) {
      // Razorpay's API is down, but only Razorpay could have produced this signature
      const pending0 = await R(() => store.getPending(claimedOrderId), "load cart").catch(() => null);
      verified = { via: "signature", pay: {
        id: paymentId, order_id: claimedOrderId, status: "captured", amount_refunded: 0,
        amount: pending0?.amountPaise || Math.round(draftTotal(pending0?.draft || body) * 100),
      } };
    } else {
      const notFound = apiError?.statusCode && apiError.statusCode < 500;
      await ev("confirm.unverified", `${sig ? "invalid signature" : "no signature"}; Razorpay: ${apiError?.message || "-"}`);
      throw httpError(notFound ? 400 : 503, notFound ? "Unknown payment" : "Could not verify the payment yet, please retry");
    }

    const p = verified.pay;
    const rzpOrderId = p.order_id || "";
    const pending = rzpOrderId ? await R(() => store.getPending(rzpOrderId), "load cart") : null;
    let draft, extra = [];
    if (pending && draftItems(pending.draft).length) draft = pending.draft;
    else {
      draft = body;
      extra.push("cart was not saved before payment — items/address taken from the browser, please verify");
    }
    if (!draftItems(draft).length) {
      await ev("payment.no_cart", "verified payment but no items anywhere");
      await alert("PAID_NO_CART", paymentId, `₹${rupees(p.amount)} paid (${paymentId}) but no cart was saved or sent. Contact the customer.`,
        { paymentId, razorpayOrderId: rzpOrderId, amount: rupees(p.amount) });
      throw httpError(422, "Payment received but the cart is missing — our team will contact you");
    }

    const { input } = orderFromDraft(draft, p, { source: "checkout", via: verified.via, pending, extraReasons: extra });
    const r = await createOrder(input);
    if (rzpOrderId) await store.updatePending(rzpOrderId, { status: "completed", orderId: String(r.order._id), paymentId, completedAt: now() }).catch(() => {});
    await ev(r.created ? "confirm.saved" : "confirm.duplicate", `order ${r.order._id} via ${verified.via}`);
    return r;
  }

  // ── Cash on delivery: never "Paid", never an online method ───────────────
  async function createCodOrder(b = {}) {
    const method = b.payment_method || b.paymentMethod || "COD";
    if (/razorpay|upi|card|online|netbank|wallet|phonepe/i.test(method)) {
      await logEvent("cod.rejected", { source: "checkout", detail: `online method "${method}" without a payment id` });
      throw httpError(400, "Online payments must be confirmed with their payment id");
    }
    return createOrder({
      user_id: b.user_id, email: b.email, phone: b.phone, address: b.address,
      products: b.products || b.items || b.cart || [],
      paymentMethod: method, paymentStatus: "Pending",
      totalAmount: b.total_amount || b.totalAmount, source: "checkout",
    });
  }

  // ── Reconciliation: Razorpay is the source of truth for "who paid" ───────
  // opts: { apply, days, minAgeMinutes, includeReview, placeholders, source, silent, only:[paymentIds] }
  async function reconcile(opts = {}) {
    const {
      apply = false, days = 30, minAgeMinutes = 10, includeReview = false,
      placeholders = false, source = "reconcile", silent = true, only = null,
      getProduct = store.getProduct,
    } = opts;
    const d = Math.min(Math.max(Number(days) || 30, 1), MAX_RECONCILE_DAYS);
    const toS = Math.floor(now().getTime() / 1000), fromS = toS - d * 86400;
    const report = { mode: apply ? "APPLY" : "DRY-RUN", ranAt: now().toISOString(), days: d, paymentsChecked: 0, summary: {}, rows: [] };

    const payments = [];
    for (let skip = 0; ; skip += 100) {
      const page  = await R(() => razorpay.payments.all({ from: fromS, to: toS, count: 100, skip }), "list payments");
      const items = page.items || [];
      payments.push(...items);
      if (items.length < 100) break;
    }
    report.paymentsChecked = payments.length;

    // group captured payments by checkout so double payments are spotted
    const byCheckout = new Map();
    for (const p of payments) if (isCaptured(p) && p.order_id) {
      if (!byCheckout.has(p.order_id)) byCheckout.set(p.order_id, []);
      byCheckout.get(p.order_id).push(p);
    }
    for (const list of byCheckout.values()) list.sort((a, b) => a.created_at - b.created_at);

    const sorted = [...payments].sort((a, b) => a.created_at - b.created_at);
    for (const p of sorted) {
      if (only && !only.includes(p.id)) continue;
      const ageMin = (now().getTime() / 1000 - Number(p.created_at)) / 60;
      const row = {
        category: "", paymentId: p.id, razorpayOrderId: p.order_id || "", amountRs: rupees(p.amount),
        paidAt: new Date(Number(p.created_at) * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        method: p.method || "", razorpayEmail: p.email || "", razorpayPhone: p.contact || "",
        customer: "", phone: "", address: "", items: [], reasons: [], stockPreview: [], action: "none",
      };
      const push = (cat) => { row.category = cat; report.rows.push(row); report.summary[cat] = (report.summary[cat] || 0) + 1; };

      if (p.status === "authorized") {
        if (ageMin < minAgeMinutes) continue;
        const ex = (await store.findOrderByPaymentId(p.id)) || (p.order_id && await store.findOrderByRzpOrderId(p.order_id));
        row.reasons.push("payment authorized but NOT captured — Razorpay will auto-refund it unless you capture it");
        if (ex) row.reasons.push(`order #${String(ex._id).slice(-8).toUpperCase()} exists`);
        if (apply) await alert("NEEDS_CAPTURE", p.id, `Payment ${p.id} (₹${row.amountRs}) is authorized but not captured. Capture it in Razorpay or it will be refunded.`, { paymentId: p.id, razorpayOrderId: p.order_id, amount: row.amountRs });
        push("NEEDS_CAPTURE"); continue;
      }
      if (p.status !== "captured") continue;                       // failed / created: nothing was paid
      if (!isCaptured(p)) { push("SKIP_FULLY_REFUNDED"); continue; }
      if (ageMin < minAgeMinutes) { push("SKIP_TOO_RECENT"); continue; } // browser/webhook still working on it

      const byPay = await store.findOrderByPaymentId(p.id);
      if (byPay) {
        row.orderId = String(byPay._id);
        if (apply && byPay.paymentStatus !== "Paid") await store.setOrderFields(byPay._id, { paymentStatus: "Paid", paymentVerifiedVia: "razorpay-api" }).catch(() => {});
        push("OK_ORDER_EXISTS"); continue;
      }
      const byChk = p.order_id && await store.findOrderByRzpOrderId(p.order_id);
      if (byChk) {
        row.orderId = String(byChk._id);
        if (byChk.paymentId && byChk.paymentId !== p.id) {
          row.reasons.push(`checkout already paid by ${byChk.paymentId} — this is a SECOND payment, refund it`);
          if (apply) await sameCheckout(byChk, p.id);
          push("DUPLICATE_PAYMENT"); continue;
        }
        if (apply) await sameCheckout(byChk, p.id);                 // fills the empty paymentId only
        push("OK_ORDER_EXISTS"); continue;
      }
      const group = byCheckout.get(p.order_id) || [];
      if (group.length > 1 && group[0].id !== p.id) {
        row.reasons.push(`second payment for checkout ${p.order_id} (first: ${group[0].id}) — refund it`);
        if (apply) await alert("DUPLICATE_PAYMENT", p.id, `Payment ${p.id} (₹${row.amountRs}) is a second payment for the same checkout as ${group[0].id}. Refund it in Razorpay.`, { paymentId: p.id, razorpayOrderId: p.order_id, amount: row.amountRs });
        push("DUPLICATE_PAYMENT"); continue;
      }

      const pending = p.order_id && await store.getPending(p.order_id);
      if (!pending || !draftItems(pending.draft).length) {
        row.reasons.push(pending ? "saved cart has no items" : "no saved cart for this payment (paid before the cart-saving code, or cart save failed)");
        if (p.notes && Object.keys(p.notes).length) row.reasons.push(`Razorpay notes: ${JSON.stringify(p.notes)}`);
        if (apply && placeholders) {
          const r = await createOrder({
            email: p.email || "", phone: String(p.contact || "").replace(/^\+?91/, ""),
            address: { fullName: "(address unknown — call customer)", phone: String(p.contact || "").replace(/^\+?91/, "") },
            products: [{ name: `⚠️ PAID ₹${row.amountRs} — items unknown, check Razorpay ${p.id}`, price: row.amountRs, quantity: 1 }],
            paymentMethod: `Razorpay ${p.method || ""}`.trim(), paymentId: p.id, razorpayOrderId: p.order_id,
            paymentStatus: "Paid", paymentVerifiedVia: "razorpay-api", totalAmount: row.amountRs,
            createdAt: new Date(Number(p.created_at) * 1000), recovered: true, source: `${source}-placeholder`,
            needsReview: "items and address unknown — contact the customer",
          }, { silent: true });
          row.action = r.created ? "placeholder-created" : "already-existed"; row.orderId = String(r.order._id);
        } else if (apply) {
          await alert("PAID_NO_CART", p.id, `₹${row.amountRs} paid (${p.id}, ${p.email || "-"}, ${p.contact || "-"}) but no order and no saved cart. Contact the customer.`, { paymentId: p.id, razorpayOrderId: p.order_id, amount: row.amountRs });
        }
        push("MANUAL_NO_CART_DATA"); continue;
      }

      const built = orderFromDraft(pending.draft, p, { source, recovered: true });
      const inp = built.input;
      row.customer = inp.address.fullName || inp.address.name || inp.email || "";
      row.phone    = inp.address.phone || inp.phone || "";
      row.address  = [inp.address.houseNo || inp.address.street, inp.address.village || inp.address.city, inp.address.district, inp.address.state, inp.address.pincode].filter(Boolean).join(", ");
      row.items    = normalizeItems(inp.products).map((i) => ({ name: i.name, size: i.selectedSize, color: i.color, qty: i.quantity, price: i.price, productId: i.productId }));
      row.reasons  = built.reasons;
      for (const i of row.items) {
        if (!i.productId) { row.stockPreview.push(`${i.name}: no productId — stock not touched`); continue; }
        const prod = await getProduct(i.productId).catch(() => null);
        if (!prod) { row.stockPreview.push(`${i.name}: product deleted — stock not touched`); continue; }
        const ss = prod.sizeStock instanceof Map ? Object.fromEntries(prod.sizeStock) : (prod.sizeStock || {});
        if (i.size && ss[i.size] !== undefined) {
          const before = Number(ss[i.size]) || 0;
          row.stockPreview.push(`${prod.name} size ${i.size}: ${before} → ${Math.max(0, before - i.qty)}${before < i.qty ? " (OVERSOLD — check stock)" : ""}`);
        } else {
          const before = Number(prod.stock) || 0;
          row.stockPreview.push(`${prod.name}: ${before} → ${Math.max(0, before - i.qty)}${before < i.qty ? " (OVERSOLD — check stock)" : ""}`);
        }
      }
      const cat = built.reasons.length ? "NEEDS_REVIEW" : "RECOVERABLE";
      if (apply && (cat === "RECOVERABLE" || includeReview)) {
        const r = await processCapturedPayment(p, { source, silent, recovered: true });
        row.action = r.status; row.orderId = r.orderId ? String(r.orderId) : "";
      } else if (apply && cat === "NEEDS_REVIEW") {
        await alert("RECOVERY_NEEDS_REVIEW", p.id, `Paid order ${p.id} (₹${row.amountRs}) was NOT recovered automatically: ${built.reasons.join("; ")}`, { paymentId: p.id, razorpayOrderId: p.order_id, amount: row.amountRs });
        row.action = "held-for-review";
      }
      push(cat);
    }
    return report;
  }

  return {
    createOrder, createCodOrder, confirmFromBrowser, handleWebhook, processCapturedPayment,
    reconcile, deductStockOnce, alert, logEvent,
    _internals: { orderIdFor, normalizeItems, draftItems, isCaptured, withRetry },
  };
};

module.exports.withRetry = withRetry;
module.exports.orderIdFor = orderIdFor;