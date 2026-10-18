// backend/services/orderRoutes.js
// HTTP behaviour of the order endpoints, kept free of Express so it can be
// tested directly. server.js only forwards req.body and sends { status, json }.
module.exports = function orderRoutes({ payments, backendUrl = "", log = console }) {
  const reply = (order) => ({
    success: true, orderId: order._id, paymentStatus: order.paymentStatus,
    labelUrl: `${backendUrl}/api/orders/${order._id}/shipping-label`,
  });
  const fail = (err) => {
    if (!err.status || err.status >= 500) log.error?.("Order error:", err);
    return { status: err.status || 500, json: { success: false, error: err.message } };
  };

  // POST /add-order — used by the existing Checkout page for COD and Razorpay.
  async function addOrder(body = {}) {
    try {
      const isOnline = !!(body.paymentId || body.razorpay_payment_id);
      const r = isOnline ? await payments.confirmFromBrowser(body) : await payments.createCodOrder(body);
      if (r.pending) return { status: 202, json: { success: true, pending: true, message: "Payment received, confirming with the bank. Your order will appear shortly." } };
      return { status: 201, json: reply(r.order) };
    } catch (e) { return fail(e); }
  }

  // POST /api/payment/confirm — idempotent: same payment → same order.
  async function confirm(body = {}) {
    try {
      if (!(body.razorpay_payment_id || body.paymentId)) return { status: 400, json: { success: false, error: "razorpay_payment_id required" } };
      const r = await payments.confirmFromBrowser(body);
      if (r.pending) return { status: 202, json: { success: true, pending: true } };
      return { status: r.created ? 201 : 200, json: reply(r.order) };
    } catch (e) { return fail(e); }
  }

  return { addOrder, confirm };
};