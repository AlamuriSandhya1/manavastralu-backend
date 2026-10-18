// Local stand-in for a staging deployment, used only to test scripts/staging-e2e.js
// in environments without MongoDB/Razorpay. Plain node:http + the real
// services (paymentOrders, orderRoutes) + in-memory store + fake Razorpay.
//   KEY_ID=rzp_test_local PORT=8787 node test/local-staging-server.js
const http = require("http");
const memoryStore = require("./memoryStore");
const fakeRazorpay = require("./fakeRazorpay");
const createPaymentOrders = require("../services/paymentOrders");
const orderRoutes = require("../services/orderRoutes");

const PASS = "stagepass", WH = "stage_wh_secret", KEY_SECRET = "stage_key_secret";
const KEY_ID = process.env.KEY_ID || "rzp_test_local";
const store = memoryStore(), rzp = fakeRazorpay();
const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const payments = createPaymentOrders({ store, razorpay: rzp, keySecret: KEY_SECRET, webhookSecret: WH, log: quiet });
const routes = orderRoutes({ payments, backendUrl: "http://localhost", log: quiet });

const send = (res, status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  let body = {}; try { body = raw.length ? JSON.parse(raw) : {}; } catch {}
  const u = new URL(req.url, "http://x"); const q = Object.fromEntries(u.searchParams);
  const admin = () => q.password === PASS;
  try {
    const k = `${req.method} ${u.pathname}`;
    if (k === "GET /api/health") return send(res, 200, { status: "ok", mongo: "connected", razorpayMode: KEY_ID.startsWith("rzp_live_") ? "live" : "test", webhookSecretSet: true });
    if (k === "POST /api/payment/create-order") {
      const o = await rzp.orders.create({ amount: Math.round(Number(body.amount) * 100) });
      if (body.draft) await store.savePending(o.id, body.draft, { amountPaise: o.amount });
      return send(res, 200, { orderId: o.id, amount: o.amount, currency: "INR", key: KEY_ID });
    }
    if (k === "POST /api/payment/razorpay/webhook") { const r = await payments.handleWebhook({ rawBody: raw, signature: req.headers["x-razorpay-signature"], body }); return send(res, r.status, r.json); }
    if (k === "POST /api/payment/confirm") { const r = await routes.confirm(body); return send(res, r.status, r.json); }
    if (k === "POST /add-order") { const r = await routes.addOrder(body); return send(res, r.status, r.json); }
    if (!admin() && u.pathname.startsWith("/api/admin")) return send(res, 401, { error: "Unauthorized" });
    if (k === "GET /api/admin/orders") return send(res, 200, [...store._orders.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    if (k === "GET /api/admin/payment-alerts") return send(res, 200, { alerts: [...store._alerts.values()] });
    if (k === "GET /api/admin/payment-events") return send(res, 200, store._events.filter((e) => !q.paymentId || e.paymentId === q.paymentId));
    if (k === "GET /api/admin/razorpay/reconcile") return send(res, 200, await payments.reconcile({ apply: false, days: Number(q.days) || 1 }));
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(Number(process.env.PORT) || 8787, () => console.log("local staging stand-in ready"));