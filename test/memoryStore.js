// In-memory store with the SAME guarantees MongoDB gives the real store:
// unique _id, unique non-empty paymentId, atomic conditional updates.
// Every operation awaits a tick so concurrent callers really interleave.
const tick = () => new Promise((r) => setImmediate(r));
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

module.exports = function memoryStore() {
  const orders = new Map();           // _id -> order
  const products = new Map();
  const pending = new Map();
  const alerts = new Map();
  const events = [];
  const failures = {};                // name -> number of times to throw
  const maybeFail = (name) => {
    if (failures[name] > 0) { failures[name]--; const e = new Error(`simulated ${name} outage`); throw e; }
  };
  const dupErr = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

  return {
    _orders: orders, _products: products, _pending: pending, _alerts: alerts, _events: events, _failures: failures,
    async findOrderByPaymentId(pid) { await tick(); maybeFail("find"); if (!pid) return null; return clone([...orders.values()].find((o) => o.paymentId === pid)) || null; },
    async findOrderByRzpOrderId(id) { await tick(); maybeFail("find"); if (!id) return null; return clone([...orders.values()].find((o) => o.razorpay_id === id)) || null; },
    async findOrderById(id) { await tick(); return clone(orders.get(String(id))) || null; },
    async insertOrder(doc) {
      await tick(); maybeFail("insert");
      const _id = doc._id || Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24);
      if (orders.has(_id)) throw dupErr();
      if (doc.paymentId && [...orders.values()].some((o) => o.paymentId === doc.paymentId)) throw dupErr();
      const o = clone({ ...doc, _id, adminViewedAt: null, stockDeductedAt: null });
      orders.set(_id, o);
      return clone(o);
    },
    async setOrderFields(id, f) { await tick(); const o = orders.get(String(id)); if (o) Object.assign(o, clone(f)); },
    async claimStockDeduction(id) {
      await tick(); maybeFail("claim");
      const o = orders.get(String(id));
      if (!o || o.stockDeductedAt != null) return false;
      o.stockDeductedAt = new Date().toISOString(); return true;
    },
    async decrementStock(pid, size, qty) {
      await tick(); maybeFail("stock");
      const p = products.get(String(pid)); if (!p) return null;
      if (size && p.sizeStock && p.sizeStock[size] !== undefined) {
        p.sizeStock[size] = Math.max(0, Number(p.sizeStock[size]) - qty);
        p.stock = Object.values(p.sizeStock).reduce((s, v) => s + Number(v || 0), 0);
      } else p.stock = Math.max(0, Number(p.stock) - qty);
      p.soldOut = p.stock <= 0;
      return clone(p);
    },
    async getProduct(pid) { await tick(); return clone(products.get(String(pid))) || null; },
    async getPending(id) { await tick(); maybeFail("pending"); return clone(pending.get(id)) || null; },
    async savePending(id, draft, extra = {}) { await tick(); maybeFail("savePending"); pending.set(id, { razorpayOrderId: id, draft: clone(draft), status: "pending", createdAt: new Date().toISOString(), ...extra }); },
    async updatePending(id, f) { await tick(); const p = pending.get(id); if (p) Object.assign(p, clone(f)); },
    async logEvent(e) { await tick(); events.push(clone(e)); },
    async upsertAlert(key, doc) {
      await tick();
      if (alerts.has(key)) { alerts.get(key).count++; return { created: false }; }
      alerts.set(key, { key, ...clone(doc), count: 1 }); return { created: true };
    },
  };
};