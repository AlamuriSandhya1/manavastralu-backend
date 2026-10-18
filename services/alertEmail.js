// backend/services/alertEmail.js
// E-mails the admin when a payment problem needs a human. Uses
// emailService.sendAlertEmail if you have one, otherwise nodemailer + Gmail
// (GMAIL_USER + GMAIL_APP_PASSWORD / GMAIL_PASS / EMAIL_PASS). If neither is
// available the alert is still saved and shown in the Admin Dashboard.
let transporter = null;

module.exports = function makeAlertEmail(emailService = {}) {
  return async function sendAlertEmail(a) {
    if (typeof emailService.sendAlertEmail === "function") return emailService.sendAlertEmail(a);
    let nodemailer;
    try { nodemailer = require("nodemailer"); } catch { return; }
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASS || process.env.EMAIL_PASS;
    const to   = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || user;
    if (!user || !pass || !to) return;
    transporter = transporter || nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    const lines = [
      a.message, "",
      a.paymentId ? `Razorpay payment: ${a.paymentId}` : "",
      a.razorpayOrderId ? `Razorpay order: ${a.razorpayOrderId}` : "",
      a.orderId ? `Website order: ${a.orderId}` : "",
      a.amount ? `Amount: ₹${a.amount}` : "",
      "", "Open the Admin Dashboard → Payment alerts to review and mark it resolved.",
    ].filter((l, i, arr) => l !== "" || arr[i - 1] !== "");
    await transporter.sendMail({ from: user, to, subject: `⚠️ Mana Vastralu payment alert: ${a.type}`, text: lines.join("\n") });
  };
};