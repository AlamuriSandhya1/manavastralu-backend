// ═══════════════════════════════════════════════════════════════
//  orderRoutes.js  (or wherever you handle POST /api/orders)
//  KEY CHANGE: after saving the order, deduct stock from each
//  product and call emitStockUpdate() so every connected browser
//  gets notified instantly — including User B's cart.
// ═══════════════════════════════════════════════════════════════
const express             = require("express");
const router              = express.Router();
const Order               = require("../models/Order");     // your existing model
const Product             = require("../models/Product");   // your existing model
const { emitStockUpdate } = require("../socket");           // ← only new import

// ── POST /api/orders  ─────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      cartItems,   // [{ productId, quantity, selectedSize, price, name }]
      address,
      paymentMethod,
      finalTotal,
      userId,
    } = req.body;

    // 1. Validate stock is still available BEFORE saving
    const stockErrors = [];
    for (const item of cartItems) {
      const product = await Product.findById(item.productId || item._id || item.id);
      if (!product) {
        stockErrors.push(`"${item.name}" no longer exists`);
        continue;
      }
      if (product.stock < (item.quantity || 1)) {
        stockErrors.push(
          product.stock === 0
            ? `"${product.name}" is sold out`
            : `Only ${product.stock} left for "${product.name}"`
        );
      }
    }

    if (stockErrors.length > 0) {
      return res.status(409).json({
        error     : "Stock issue",
        outOfStock: true,
        messages  : stockErrors,
      });
    }

    // 2. Save the order
    const orderId = "AAFE" + Math.random().toString(16).slice(2,8).toUpperCase();
    const order = await Order.create({
      orderId,
      userId,
      items  : cartItems,
      address,
      paymentMethod,
      total  : finalTotal,
      status : "Confirmed",
    });

    // 3. Deduct stock from each product & broadcast immediately
    for (const item of cartItems) {
      const pid = item.productId || item._id || item.id;
      const qty = item.quantity || 1;

      // Atomic decrement — prevents race conditions between simultaneous orders
      const updated = await Product.findByIdAndUpdate(
        pid,
        { $inc: { stock: -qty } },  // decrement by qty bought
        { new: true }               // return the NEW document
      );

      if (updated) {
        // ── KEY: broadcast new stock to ALL browsers right now ──
        emitStockUpdate(updated);
      }
    }

    res.status(201).json({ success: true, order });

  } catch (err) {
    console.error("[Order] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/products/:id  (admin updates stock) ──────────────
// Also wire this up in your productRoutes.js
router.put("/admin/products/:id", async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!product) return res.status(404).json({ error: "Not found" });

    emitStockUpdate(product); // broadcast admin change too
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;