// backend/services/mongoStore.js
// The small set of database operations paymentOrders.js needs, done with Mongoose.
const mongoose = require("mongoose");

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v
  : mongoose.isValidObjectId(v) && String(v).length === 24 ? new mongoose.Types.ObjectId(String(v)) : null);

// driver v6 returns the document, older drivers return { value, ok }
const unwrap = (r) => (r && Object.prototype.hasOwnProperty.call(r, "ok") && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : r);

module.exports = function mongoStore({ Order, Product, PendingCheckout, PaymentAlert, PaymentEvent, waitForDB = async () => {} }) {
  return {
    async findOrderByPaymentId(paymentId) {
      if (!paymentId) return null;
      await waitForDB();
      return Order.findOne({ paymentId }).lean();
    },
    async findOrderByRzpOrderId(rzpOrderId) {
      if (!rzpOrderId) return null;
      await waitForDB();
      return Order.findOne({ razorpay_id: rzpOrderId }).lean();
    },
    async findOrderById(id) {
      const _id = oid(id); if (!_id) return null;
      await waitForDB();
      return Order.findById(_id).lean();
    },

    // Insert exactly the document we built (fixed _id, original createdAt for
    // recovered orders). Schema defaults + validation still run.
    async insertOrder(doc) {
      await waitForDB();
      const m = new Order({ ...doc, _id: doc._id ? oid(doc._id) : undefined });
      const err = m.validateSync();
      if (err) { err.noRetry = true; throw err; }
      const obj = m.toObject({ depopulate: true });
      obj.createdAt = doc.createdAt || new Date();
      obj.updatedAt = doc.updatedAt || new Date();
      obj.adminViewedAt = null;
      obj.stockDeductedAt = null;
      await Order.collection.insertOne(obj);           // throws code 11000 on duplicates
      return obj;
    },

    async setOrderFields(id, fields) {
      await waitForDB();
      await Order.collection.updateOne({ _id: oid(id) }, { $set: { ...fields, updatedAt: new Date() } });
    },

    // true exactly once per order — whoever flips the flag deducts the stock
    async claimStockDeduction(id) {
      await waitForDB();
      const r = await Order.collection.updateOne(
        { _id: oid(id), stockDeductedAt: null },
        { $set: { stockDeductedAt: new Date() } }
      );
      return r.modifiedCount === 1;
    },

    // Atomic per product: no read-modify-write race between two orders.
    async decrementStock(productId, size, qty) {
      const _id = oid(productId); if (!_id) return null;
      await waitForDB();
      const n = Math.max(1, Number(qty) || 1);
      const S = String(size || "");
      const num = (x) => ({ $convert: { input: x, to: "double", onError: 0, onNull: 0 } });
      const key = { $literal: S };
      const pipeline = [
        { $set: { __hk: S ? { $ne: [{ $type: { $getField: { field: key, input: { $ifNull: ["$sizeStock", {}] } } } }, "missing"] } : false } },
        { $set: { sizeStock: { $cond: ["$__hk",
            { $setField: { field: key, input: "$sizeStock",
                value: { $max: [0, { $subtract: [num({ $getField: { field: key, input: "$sizeStock" } }), n] }] } } },
            "$sizeStock"] } } },
        { $set: { stock: { $cond: ["$__hk",
            { $sum: { $map: { input: { $objectToArray: { $ifNull: ["$sizeStock", {}] } }, in: num("$$this.v") } } },
            { $max: [0, { $subtract: [num("$stock"), n] }] }] } } },
        { $set: { soldOut: { $lte: ["$stock", 0] } } },
        { $unset: "__hk" },
      ];
      try {
        return unwrap(await Product.collection.findOneAndUpdate({ _id }, pipeline, { returnDocument: "after" }));
      } catch (e) {
        // MongoDB < 5.0 has no $getField/$setField → old (non-atomic) method
        if (!/getField|setField|Unrecognized expression|Invalid \$set/i.test(e.message)) throw e;
        const p = await Product.findById(_id);
        if (!p) return null;
        const ss = p.sizeStock instanceof Map ? Object.fromEntries(p.sizeStock) : (p.sizeStock || {});
        let stock;
        if (S && ss[S] !== undefined) {
          ss[S] = Math.max(0, Number(ss[S]) - n);
          stock = Object.values(ss).reduce((s, v) => s + Number(v || 0), 0);
          return Product.findByIdAndUpdate(_id, { sizeStock: ss, stock, soldOut: stock === 0 }, { new: true }).lean();
        }
        stock = Math.max(0, Number(p.stock) - n);
        return Product.findByIdAndUpdate(_id, { stock, soldOut: stock === 0 }, { new: true }).lean();
      }
    },

    async getProduct(productId) {
      const _id = oid(productId); if (!_id) return null;
      await waitForDB();
      return Product.findById(_id).lean();
    },

    async getPending(rzpOrderId) {
      await waitForDB();
      return PendingCheckout.findOne({ razorpayOrderId: rzpOrderId }).lean();
    },
    async savePending(rzpOrderId, draft, extra = {}) {
      await waitForDB();
      await PendingCheckout.updateOne(
        { razorpayOrderId: rzpOrderId },
        { $set: { draft, status: "pending", ...extra }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
    },
    async updatePending(rzpOrderId, fields) {
      await waitForDB();
      await PendingCheckout.updateOne({ razorpayOrderId: rzpOrderId }, { $set: fields });
    },

    // append-only audit trail (never updated or deleted by the app)
    async logEvent(e) {
      if (!PaymentEvent) return;
      await waitForDB();
      await PaymentEvent.collection.insertOne({ ...e });
    },

    // one alert per key; repeats only bump the counter (no e-mail spam)
    async upsertAlert(key, doc) {
      await waitForDB();
      const r = await PaymentAlert.collection.updateOne(
        { key },
        { $setOnInsert: { key, ...doc, firstSeenAt: new Date(), resolvedAt: null },
          $set: { lastSeenAt: new Date() }, $inc: { count: 1 } },
        { upsert: true }
      );
      return { created: !!r.upsertedCount };
    },
  };
};