const nodemailer = require("nodemailer");

// ── Transporter ───────────────────────────────────────
const createTransporter = () => {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_PASS || "").replace(/\s/g, "");

  if (!user || !pass) {
    console.error("❌ Email: GMAIL_USER or GMAIL_PASS not set in environment");
    return null;
  }

  return nodemailer.createTransport({
    host:   "smtp.gmail.com",
    port:   465,
    secure: true,
    auth:   { user, pass },
    tls:    { rejectUnauthorized: false },
  });
};

// ── Test connection on startup ─────────────────────────
const transporter = createTransporter();
if (transporter) {
  transporter.verify((err) => {
    if (err) console.error("❌ Gmail SMTP verify failed:", err.message);
    else     console.log("✅ Gmail SMTP ready — emails will be sent");
  });
}

// ── Helper ────────────────────────────────────────────
const sendMail = async ({ to, subject, html }) => {
  const t = createTransporter();
  if (!t) throw new Error("Email transporter not configured");

  const info = await t.sendMail({
    from:    `"Mana Vastralu" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
  console.log(`✅ Email sent to ${to} — MessageId: ${info.messageId}`);
  return info;
};

// ══════════════════════════════════════════════════════
//  OTP EMAIL
// ══════════════════════════════════════════════════════
const sendOTPEmail = async (toEmail, otp) => {
  await sendMail({
    to:      toEmail,
    subject: `🔐 Your Admin OTP: ${otp} — Mana Vastralu`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0a04;padding:40px;
                  max-width:480px;margin:0 auto;border-radius:12px">
        <div style="text-align:center;margin-bottom:24px">
          <h1 style="color:#c8a04a;font-size:22px;margin:0">🥻 Mana Vastralu</h1>
          <p style="color:#7a5a30;font-size:12px;letter-spacing:2px;
                    text-transform:uppercase;margin:4px 0 0">Admin Security</p>
        </div>
        <div style="background:#1a1008;border:1px solid rgba(200,160,74,0.2);
                    border-radius:10px;padding:28px;text-align:center">
          <p style="color:#9a7050;font-size:14px;margin:0 0 16px">
            Your one-time admin login code:
          </p>
          <div style="font-size:44px;font-weight:700;color:#c8a04a;
                      letter-spacing:14px;font-family:monospace;
                      background:#0f0a04;padding:20px;border-radius:8px;
                      border:2px solid rgba(200,160,74,0.4)">
            ${otp}
          </div>
          <p style="color:#5a3a10;font-size:12px;margin:16px 0 0">
            ⏱ Valid for <strong style="color:#c8a04a">5 minutes</strong> only.<br/>
            Never share this code with anyone.
          </p>
        </div>
        <p style="color:#3a2a08;font-size:11px;text-align:center;margin-top:20px">
          If you didn't request this, ignore this email.
        </p>
      </div>`,
  });
};

// ══════════════════════════════════════════════════════
//  CUSTOMER ORDER CONFIRMATION EMAIL
// ══════════════════════════════════════════════════════
const sendCustomerEmail = async ({
  email, orderId, products: items, totalAmount, address, paymentMethod,
}) => {
  if (!email || email === "guest@gmail.com") return;

  const addr = address || {};
  const addressLine = [
    addr.fullName || addr.name,
    addr.houseNo  || addr.street,
    addr.landmark,
    addr.village  || addr.city,
    addr.district,
    addr.state,
    addr.pincode ? `— ${addr.pincode}` : "",
  ].filter(Boolean).join(", ");

  const itemRows = (items || []).map(item => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08">
        ${item.image
          ? `<img src="${item.image}" width="56" height="64"
               style="object-fit:cover;border-radius:4px;vertical-align:middle"/>`
          : "🥻"}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08;color:#e8d5a3">
        <strong>${item.name || "—"}</strong><br/>
        <span style="font-size:11px;color:#7a5a30">
          ${item.selectedSize || item.size ? `Size: ${item.selectedSize || item.size}` : ""}
          ${item.color ? ` · ${item.color}` : ""}
        </span>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08;
                 color:#c8a04a;text-align:center">
        × ${item.quantity || 1}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08;
                 color:#c8a04a;text-align:right;font-weight:700">
        ₹${(Number(item.price || 0) * (item.quantity || 1)).toLocaleString("en-IN")}
      </td>
    </tr>`).join("");

  await sendMail({
    to:      email,
    subject: `✅ Order Confirmed #${String(orderId).slice(-6).toUpperCase()} — Mana Vastralu`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0a04;
                  max-width:560px;margin:0 auto;border-radius:12px;overflow:hidden">

        <!-- HEADER -->
        <div style="background:linear-gradient(135deg,#1a1008,#2a1508);
                    padding:32px;text-align:center;
                    border-bottom:2px solid rgba(200,160,74,0.3)">
          <h1 style="color:#c8a04a;font-family:Georgia,serif;
                     font-size:24px;margin:0 0 4px">🥻 Mana Vastralu</h1>
          <p style="color:#7a5a30;font-size:11px;letter-spacing:2px;
                    text-transform:uppercase;margin:0">Mana Gurthimpu</p>
        </div>

        <div style="padding:28px">

          <!-- THANK YOU -->
          <div style="text-align:center;margin-bottom:24px">
            <div style="font-size:48px;margin-bottom:8px">🎉</div>
            <h2 style="color:#e8d5a3;font-family:Georgia,serif;
                       font-size:20px;margin:0 0 6px">
              Thank you for your order!
            </h2>
            <p style="color:#9a7050;font-size:13px;margin:0">
              Your order has been confirmed and is being processed.
            </p>
          </div>

          <!-- ORDER INFO STRIP -->
          <div style="background:#1a1008;border:1px solid rgba(200,160,74,0.2);
                      border-radius:8px;padding:16px;margin-bottom:20px;
                      display:flex;justify-content:space-between">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="color:#7a5a30;font-size:11px;
                           text-transform:uppercase;letter-spacing:1px">Order ID</td>
                <td style="color:#7a5a30;font-size:11px;
                           text-transform:uppercase;letter-spacing:1px">Date</td>
                <td style="color:#7a5a30;font-size:11px;
                           text-transform:uppercase;letter-spacing:1px">Payment</td>
                <td style="color:#7a5a30;font-size:11px;
                           text-transform:uppercase;letter-spacing:1px">Status</td>
              </tr>
              <tr>
                <td style="color:#c8a04a;font-weight:700;font-size:13px;padding-top:4px">
                  #${String(orderId).slice(-6).toUpperCase()}
                </td>
                <td style="color:#e8d5a3;font-size:13px;padding-top:4px">
                  ${new Date().toLocaleDateString("en-IN", {
                    day:"2-digit", month:"short", year:"numeric"
                  })}
                </td>
                <td style="color:#e8d5a3;font-size:13px;padding-top:4px">
                  ${paymentMethod || "COD"}
                </td>
                <td style="padding-top:4px">
                  <span style="background:rgba(74,222,128,0.15);color:#4ade80;
                               padding:2px 10px;border-radius:12px;
                               font-size:11px;font-weight:700">
                    ✓ Confirmed
                  </span>
                </td>
              </tr>
            </table>
          </div>

          <!-- ITEMS TABLE -->
          <h3 style="color:#c8a04a;font-size:13px;text-transform:uppercase;
                     letter-spacing:1px;margin:0 0 10px">Items Ordered</h3>
          <table width="100%" cellpadding="0" cellspacing="0"
            style="background:#1a1008;border:1px solid rgba(200,160,74,0.15);
                   border-radius:8px;border-collapse:collapse;margin-bottom:20px">
            <thead>
              <tr style="background:rgba(200,160,74,0.1)">
                <th style="padding:10px 12px;color:#7a5a30;font-size:10px;
                           text-align:left;text-transform:uppercase;
                           letter-spacing:1px;width:70px">Photo</th>
                <th style="padding:10px 12px;color:#7a5a30;font-size:10px;
                           text-align:left;text-transform:uppercase;letter-spacing:1px">
                  Product</th>
                <th style="padding:10px 12px;color:#7a5a30;font-size:10px;
                           text-transform:uppercase;letter-spacing:1px">Qty</th>
                <th style="padding:10px 12px;color:#7a5a30;font-size:10px;
                           text-align:right;text-transform:uppercase;letter-spacing:1px">
                  Price</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
            <tfoot>
              <tr>
                <td colspan="3" style="padding:14px 12px;color:#9a7050;
                                       font-size:13px;text-align:right">
                  Total Amount
                </td>
                <td style="padding:14px 12px;color:#c8a04a;
                           font-size:18px;font-weight:700;
                           text-align:right;font-family:Georgia,serif">
                  ₹${Number(totalAmount || 0).toLocaleString("en-IN")}
                </td>
              </tr>
            </tfoot>
          </table>

          <!-- DELIVERY ADDRESS -->
          ${addressLine ? `
          <div style="background:#1a1008;border:1px solid rgba(200,160,74,0.15);
                      border-radius:8px;padding:16px;margin-bottom:20px">
            <h3 style="color:#c8a04a;font-size:12px;text-transform:uppercase;
                       letter-spacing:1px;margin:0 0 10px">📍 Delivery Address</h3>
            <p style="color:#9a7050;font-size:13px;line-height:1.8;margin:0">
              <strong style="color:#e8d5a3">${addr.fullName || addr.name || ""}</strong><br/>
              ${addr.phone ? `📞 ${addr.phone}<br/>` : ""}
              ${addressLine}
            </p>
          </div>` : ""}

          <!-- WHAT'S NEXT -->
          <div style="background:rgba(200,160,74,0.06);
                      border:1px solid rgba(200,160,74,0.15);
                      border-radius:8px;padding:16px;margin-bottom:20px">
            <h3 style="color:#c8a04a;font-size:12px;text-transform:uppercase;
                       letter-spacing:1px;margin:0 0 12px">📦 What happens next?</h3>
            ${[
              ["1", "Order Processing", "We're preparing your saree with care"],
              ["2", "Quality Check",    "Each saree is inspected before shipping"],
              ["3", "Shipped via DTDC","You'll receive a tracking number by email"],
              ["4", "Delivery",        "Expected in 3–7 business days"],
            ].map(([n, title, desc]) => `
              <div style="display:flex;gap:10px;margin-bottom:10px;align-items:flex-start">
                <span style="background:#c8a04a;color:#1a1008;width:20px;height:20px;
                             border-radius:50%;display:inline-flex;align-items:center;
                             justify-content:center;font-size:11px;font-weight:700;
                             flex-shrink:0">${n}</span>
                <div>
                  <strong style="color:#e8d5a3;font-size:13px">${title}</strong><br/>
                  <span style="color:#7a5a30;font-size:12px">${desc}</span>
                </div>
              </div>`).join("")}
          </div>

          <!-- FOOTER -->
          <div style="text-align:center;padding-top:20px;
                      border-top:1px solid rgba(200,160,74,0.1)">
            <p style="color:#9a7050;font-size:12px;margin:0 0 8px">
              Questions? Reply to this email or contact us on WhatsApp
            </p>
            <p style="color:#5a3a10;font-size:11px;margin:0">
              © 2026 Mana Vastralu · manavastralu@gmail.com
            </p>
          </div>
        </div>
      </div>`,
  });
};

// ══════════════════════════════════════════════════════
//  ADMIN ORDER NOTIFICATION EMAIL
// ══════════════════════════════════════════════════════
const sendAdminEmail = async ({
  email, orderId, products: items, totalAmount, address, paymentMethod,
}) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail) return;

  const addr        = address || {};
  const addressLine = [
    addr.fullName || addr.name,
    addr.houseNo  || addr.street,
    addr.village  || addr.city,
    addr.district,
    addr.state,
    addr.pincode,
    addr.phone ? `📞 ${addr.phone}` : "",
  ].filter(Boolean).join(", ");

  const itemList = (items || []).map(item =>
    `• ${item.name} × ${item.quantity || 1} ${item.selectedSize || item.size ? `(Size: ${item.selectedSize || item.size})` : ""} — ₹${(Number(item.price || 0) * (item.quantity || 1)).toLocaleString("en-IN")}`
  ).join("\n");

  await sendMail({
    to:      adminEmail,
    subject: `🛍️ New Order #${String(orderId).slice(-6).toUpperCase()} — ₹${Number(totalAmount || 0).toLocaleString("en-IN")}`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0f0a04;
                  max-width:520px;margin:0 auto;border-radius:12px;
                  padding:28px;color:#e8d5a3">

        <h2 style="color:#c8a04a;font-family:Georgia,serif;margin:0 0 4px">
          🛍️ New Order Received!
        </h2>
        <p style="color:#7a5a30;font-size:12px;margin:0 0 20px">
          Order #${String(orderId).slice(-6).toUpperCase()} ·
          ${new Date().toLocaleString("en-IN")}
        </p>

        <table width="100%" cellpadding="0" cellspacing="0"
          style="background:#1a1008;border:1px solid rgba(200,160,74,0.2);
                 border-radius:8px;padding:16px;margin-bottom:16px">
          <tr>
            <td style="color:#7a5a30;font-size:11px;padding-bottom:4px">Customer</td>
            <td style="color:#e8d5a3;font-weight:600">${email}</td>
          </tr>
          <tr>
            <td style="color:#7a5a30;font-size:11px;padding-bottom:4px;padding-top:8px">Payment</td>
            <td style="color:#e8d5a3">${paymentMethod || "COD"}</td>
          </tr>
          <tr>
            <td style="color:#7a5a30;font-size:11px;padding-top:8px">Address</td>
            <td style="color:#9a7050;font-size:12px">${addressLine || "Not provided"}</td>
          </tr>
        </table>

        <div style="background:#1a1008;border:1px solid rgba(200,160,74,0.2);
                    border-radius:8px;padding:16px;margin-bottom:16px">
          <h3 style="color:#c8a04a;font-size:12px;text-transform:uppercase;
                     letter-spacing:1px;margin:0 0 10px">Items</h3>
          <pre style="color:#9a7050;font-size:12px;
                      font-family:monospace;white-space:pre-wrap;
                      margin:0;line-height:1.8">${itemList}</pre>
        </div>

        <div style="background:rgba(200,160,74,0.1);border-radius:8px;
                    padding:14px;text-align:center">
          <div style="font-size:11px;color:#7a5a30;text-transform:uppercase;
                      letter-spacing:1px;margin-bottom:4px">Total Amount</div>
          <div style="font-size:28px;color:#c8a04a;font-weight:700;
                      font-family:Georgia,serif">
            ₹${Number(totalAmount || 0).toLocaleString("en-IN")}
          </div>
        </div>

        <p style="color:#5a3a10;font-size:11px;text-align:center;margin-top:16px">
          Login to admin dashboard to update order status and add tracking.
        </p>
      </div>`,
  });
};

module.exports = { sendCustomerEmail, sendAdminEmail, sendOTPEmail };