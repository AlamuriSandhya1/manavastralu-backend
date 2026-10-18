// node --test test/run-memory.test.js   (no database needed)
const { test } = require("node:test");
const crypto = require("crypto");
const memoryStore = require("./memoryStore");
const defineScenarios = require("./scenarios");
const defineReviewScenarios = require("./scenarios-review");

async function makeFixture(makeService) {
  const store = memoryStore();
  const { svc, rzp, emails, notified } = makeService(store);
  return {
    store, svc, rzp, emails, notified,
    async seedProduct(p) { const id = crypto.randomBytes(12).toString("hex"); store._products.set(id, { _id: id, ...JSON.parse(JSON.stringify(p)) }); return id; },
    async orders() { return [...store._orders.values()]; },
    async product(id) { return JSON.parse(JSON.stringify(store._products.get(id))); },
    async pending(id) { return store._pending.get(id); },
    async alerts() { return [...store._alerts.values()]; },
    async events() { return store._events; },
    async adminOrders() { return [...store._orders.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); },
    async insertRawOrder(o) { const id = crypto.randomBytes(12).toString("hex"); store._orders.set(id, { _id: id, createdAt: new Date().toISOString(), stockDeductedAt: new Date().toISOString(), ...o }); },
  };
}
makeFixture.canSimulateOutages = true;
defineScenarios(test, makeFixture);
defineReviewScenarios(test, makeFixture);