// Minimal stand-in for the `razorpay` SDK methods the backend uses.
module.exports = function fakeRazorpay() {
  const payments = new Map();
  let seq = 0;
  const fail = { fetch: 0, all: 0 };
  return {
    _payments: payments, _fail: fail,
    addPayment(p) {
      const id = p.id || `pay_T${++seq}`;
      const full = { entity: "payment", amount_refunded: 0, method: "upi", email: "", contact: "",
        created_at: Math.floor(Date.now() / 1000) - 3600, notes: {}, ...p, id };
      payments.set(id, full); return full;
    },
    payments: {
      async fetch(id) {
        if (fail.fetch > 0) { fail.fetch--; throw new Error("razorpay timeout"); }
        const p = payments.get(id); if (!p) { const e = new Error("The id provided does not exist"); e.statusCode = 400; throw e; }
        return { ...p };
      },
      async all({ from, to, count = 10, skip = 0 }) {
        if (fail.all > 0) { fail.all--; throw new Error("razorpay timeout"); }
        const list = [...payments.values()].filter((p) => p.created_at >= from && p.created_at <= to)
          .sort((a, b) => b.created_at - a.created_at);
        return { entity: "collection", count: list.slice(skip, skip + count).length, items: list.slice(skip, skip + count).map((p) => ({ ...p })) };
      },
    },
    orders: {
      async create({ amount }) { return { id: `order_T${++seq}`, amount, currency: "INR" }; },
      async fetchPayments(orderId) { const items = [...payments.values()].filter((p) => p.order_id === orderId); return { count: items.length, items }; },
    },
  };
};