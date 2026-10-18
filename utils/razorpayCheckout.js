// frontend/src/utils/razorpayCheckout.js
// Drop-in Razorpay flow that never loses a paid order:
//   1. sends the cart to the server BEFORE payment (saved as a pendingcheckout)
//   2. after payment, confirms with retries (the server is idempotent)
//   3. if the tab closes / network dies, the confirmation is retried on the next
//      page load — and the server's webhook + reconciler create the order anyway.
//
// Usage in your Checkout page:
//   import { payWithRazorpay } from "../utils/razorpayCheckout";
//   payWithRazorpay({
//     API,
//     cart: { email, user_id, address, products: cartItems, total_amount: total, paymentMethod: "Razorpay" },
//     prefill: { name: address.fullName, email, contact: address.phone },
//     onSuccess: ({ orderId }) => navigate(`/order-success?orderId=${orderId}`),
//     onPending: () => navigate("/my-orders"),          // paid, confirmation still in progress
//     onError:   (msg) => alert(msg),
//   });
//
// And once at app start (e.g. in App.jsx useEffect):
//   import { retryPendingConfirmations } from "./utils/razorpayCheckout";
//   retryPendingConfirmations(API);

const KEY = "mv_pending_confirmations";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v.slice(-20))); } catch {} };

function rememberOrderId(id) {
  try {
    const ids = JSON.parse(localStorage.getItem("myOrderIds") || "[]");
    if (!ids.includes(String(id))) localStorage.setItem("myOrderIds", JSON.stringify([...ids, String(id)].slice(-100)));
  } catch {}
}

async function postJSON(url, body, timeoutMs = 45000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  } finally { clearTimeout(t); }
}

// Retries with backoff; 4xx (except 408/429) are not retried.
async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (e.status && e.status < 500 && ![408, 429].includes(e.status)) throw e;
      await sleep(1500 * 2 ** i);            // 1.5s, 3s, 6s, 12s (Render cold starts)
    }
  }
  throw last;
}

const forget = (entry) => write(read().filter((x) => x.response.razorpay_payment_id !== entry.response.razorpay_payment_id));

// Server answers: 201/200 = order saved, 202 = paid but bank still confirming,
// 402 = payment failed, 400 = payment does not match this checkout.
export async function confirmPayment(API, entry) {
  try {
    const data = await withRetry(() => postJSON(`${API}/api/payment/confirm`, { ...entry.cart, ...entry.response }));
    if (data.pending) return data;                 // keep the entry; retried on next page load
    forget(entry);
    rememberOrderId(data.orderId);
    return data;
  } catch (e) {
    if (e.status === 400 || e.status === 402) forget(entry);   // definitive: never becomes an order
    throw e;
  }
}

export async function retryPendingConfirmations(API) {
  const DAY = 24 * 60 * 60 * 1000;
  for (const entry of read()) {
    if (Date.now() - (entry.at || 0) > 7 * DAY) { forget(entry); continue; }
    try { await confirmPayment(API, entry); } catch { /* server webhook / reconciler still saves verified payments */ }
  }
}

function loadScript() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = ok; s.onerror = () => fail(new Error("Could not load Razorpay. Check your connection."));
    document.body.appendChild(s);
  });
}

export async function payWithRazorpay({ API, cart, prefill = {}, onSuccess, onPending, onError, onDismiss }) {
  try {
    await loadScript();
    const amount = Number(cart.total_amount || cart.totalAmount);
    // the cart is saved on the server here, BEFORE the customer pays
    const rz = await withRetry(() => postJSON(`${API}/api/payment/create-order`, { amount, draft: cart }), 3);

    const rzp = new window.Razorpay({
      key: rz.key, amount: rz.amount, currency: rz.currency, order_id: rz.orderId,
      name: "Mana Vastralu", description: "Order payment", prefill,
      notes: { email: cart.email || "" },
      theme: { color: "#7c2d12" },
      handler: async (response) => {
        // write it down first, so a closed tab can finish it later
        const entry = { response, cart, at: Date.now() };
        write([...read(), entry]);
        try {
          const data = await confirmPayment(API, entry);
          if (data.pending) onPending?.();             // bank still confirming; order appears shortly
          else onSuccess?.(data);
        } catch (e) {
          if (e.status === 402) onError?.("Payment was not successful. If money was debited, it will be refunded by your bank.");
          // Otherwise the payment may be done: the server webhook / reconciler will create the order.
          else onPending?.();
        }
      },
      modal: { ondismiss: () => onDismiss?.() },
    });
    rzp.on("payment.failed", (r) => onError?.(r.error?.description || "Payment failed"));
    rzp.open();
  } catch (e) {
    onError?.(e.message || "Could not start payment");
  }
}