// backend/whatsappNotify.js
// Sends the ADMIN a WhatsApp message when an order is placed.
// Nothing is hard-coded: configure ONE provider with env vars on Render.
//
//  A) Meta WhatsApp Cloud API (official, free tier):
//       WA_CLOUD_TOKEN, WA_CLOUD_PHONE_ID, ADMIN_WHATSAPP=919390905464
//       (+ optional WA_CLOUD_TEMPLATE / WA_CLOUD_LANG, see note below)
//  B) CallMeBot (simplest, free, personal number):
//       CALLMEBOT_APIKEY, ADMIN_WHATSAPP=919390905464
//       Get the key once: save +34 644 51 95 23 in contacts, WhatsApp it
//       "I allow callmebot to send me messages" -> it replies with your apikey.
//
// If nothing is configured it just logs a hint and never breaks order placing.
const axios = require("axios");

const money = (n) => Number(n || 0).toLocaleString("en-IN");

function buildMessage(order) {
  const items = order.products || order.items || [];
  const a = order.address || {};
  const total = order.total_amount || order.totalAmount || 0;
  const id = String(order._id).slice(-8).toUpperCase();
  const lines = [
    "🛍️ *NEW ORDER – Mana Vastralu*",
    `Order: #${id}`,
    `Customer: ${a.fullName || a.name || order.email || "Customer"}`,
    a.phone || order.phone ? `Phone: ${a.phone || order.phone}` : "",
    "",
    ...items.map((it, i) =>
      `${i + 1}. ${it.name}${it.selectedSize || it.size ? ` (${it.selectedSize || it.size})` : ""}${it.color ? ` ${it.color}` : ""} x${it.quantity || 1} = ₹${money((it.price || 0) * (it.quantity || 1))}`),
    "",
    `💰 Total: ₹${money(total)}  |  ${order.paymentMethod || order.payment_method || "COD"}`,
    `📍 ${[a.houseNo || a.street, a.village || a.city, a.district, a.state, a.pincode].filter(Boolean).join(", ")}`,
  ];
  return lines.filter((l) => l !== undefined && l !== null).join("\n");
}

async function notifyAdminWhatsApp(order) {
  try {
    const to = String(process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "");
    if (!to) return console.log("ℹ️ WhatsApp alert skipped: set ADMIN_WHATSAPP");
    const text = buildMessage(order);

    if (process.env.WA_CLOUD_TOKEN && process.env.WA_CLOUD_PHONE_ID) {
      const url = `https://graph.facebook.com/v20.0/${process.env.WA_CLOUD_PHONE_ID}/messages`;
      const headers = { Authorization: `Bearer ${process.env.WA_CLOUD_TOKEN}` };
      // Free-form text only works inside the 24h window (message the business number
      // from your phone once a day), otherwise use an approved template:
      const body = process.env.WA_CLOUD_TEMPLATE
        ? { messaging_product: "whatsapp", to, type: "template",
            template: { name: process.env.WA_CLOUD_TEMPLATE, language: { code: process.env.WA_CLOUD_LANG || "en" },
              components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\n/g, " | ").slice(0, 900) }] }] } }
        : { messaging_product: "whatsapp", to, type: "text", text: { body: text } };
      await axios.post(url, body, { headers, timeout: 10000 });
      return console.log("✅ WhatsApp (Cloud API) alert sent");
    }

    if (process.env.CALLMEBOT_APIKEY) {
      await axios.get("https://api.callmebot.com/whatsapp.php", {
        params: { phone: to, text, apikey: process.env.CALLMEBOT_APIKEY }, timeout: 10000,
      });
      return console.log("✅ WhatsApp (CallMeBot) alert sent");
    }
    console.log("ℹ️ WhatsApp alert skipped: set WA_CLOUD_TOKEN+WA_CLOUD_PHONE_ID or CALLMEBOT_APIKEY");
  } catch (e) {
    console.error("WhatsApp alert failed:", e.response?.data || e.message);
  }
}

module.exports = { notifyAdminWhatsApp };