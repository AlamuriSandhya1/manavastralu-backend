const { Resend } = require("resend");

const getResend = () => {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error("❌ RESEND_API_KEY missing in environment variables");
    return null;
  }
  return new Resend(key);
};

// Verify on startup
setTimeout(async () => {
  const r = getResend();
  if (!r) return;
  try {
    // Simple ping to verify API key works
    const domains = await r.domains.list();
    console.log("✅ Resend API ready");
  } catch (err) {
    if (err.message?.includes("API key")) {
      console.error("❌ Resend API key invalid:", err.message);
    } else {
      // Other errors are fine — key is valid
      console.log("✅ Resend API key loaded");
    }
  }
}, 2000);

const FROM_EMAIL  = process.env.FROM_EMAIL  || "onboarding@resend.dev"; // use this until domain verified
const ADMIN_EMAIL = () => process.env.ADMIN_EMAIL || process.env.GMAIL_USER || "";

const sendMail = async ({ to, subject, html }) => {
  const resend = getResend();
  if (!resend) throw new Error("Resend not configured");

  const from = process.env.RESEND_FROM
    || (process.env.CUSTOM_DOMAIN
        ? `Mana Vastralu <noreply@${process.env.CUSTOM_DOMAIN}>`
        : "Mana Vastralu <onboarding@resend.dev>");

  const { data, error } = await resend.emails.send({ from, to, subject, html });
  if (error) throw new Error(error.message || JSON.stringify(error));
  console.log(`✅ Email sent → ${to} | id: ${data?.id}`);
  return data;
};

const formatAddress = (addr) => {
  if (!addr || typeof addr !== "object") return "Not provided";
  return [addr.fullName||addr.name, addr.phone, addr.houseNo, addr.landmark,
          addr.village, addr.district, addr.state, addr.pincode]
    .filter(Boolean).join(", ");
};

// ══════════════════════════════════════════════════════
//  OTP EMAIL
// ══════════════════════════════════════════════════════
const sendOTPEmail = async (toEmail, otp) => {
  // ✅ Always send to your own verified email (Resend free tier restriction)
  const actualTo = "manavastralu@gmail.com";
  console.log(`📧 Sending OTP to ${actualTo}...`);
  await sendMail({
    to:      actualTo,
    subject: `🔐 Admin OTP: ${otp} — Mana Vastralu`,
    html: `<!DOCTYPE html><html>
<body style="margin:0;padding:20px;background:#0f0a04;font-family:Arial,sans-serif">
<div style="max-width:440px;margin:0 auto;background:#1a1008;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#c8a04a,#8b5e1a);padding:20px 24px;text-align:center">
    <h1 style="color:#1a1008;font-size:20px;margin:0;font-family:Georgia,serif">🥻 Mana Vastralu</h1>
    <p style="color:#5a3a0a;font-size:10px;margin:3px 0 0;letter-spacing:2px;text-transform:uppercase">Admin Security</p>
  </div>
  <div style="padding:28px;text-align:center">
    <p style="color:#9a7050;font-size:14px;margin:0 0 20px">Your one-time admin login code:</p>
    <div style="background:#0f0a04;border:2px solid #c8a04a;border-radius:10px;padding:22px;margin-bottom:16px">
      <div style="font-size:44px;font-weight:900;color:#c8a04a;letter-spacing:14px;font-family:monospace">${otp}</div>
    </div>
    <p style="color:#7a5a30;font-size:12px;margin:0 0 6px">⏱ Valid for <strong style="color:#c8a04a">5 minutes</strong> only</p>
    <p style="color:#5a3a10;font-size:11px;margin:0">Never share this code with anyone.</p>
  </div>
  <div style="background:#0f0a04;padding:12px;text-align:center">
    <p style="color:#3a2a08;font-size:10px;margin:0">If you didn't request this, ignore this email.</p>
  </div>
</div>
</body></html>`,
  });
};

// ══════════════════════════════════════════════════════
//  CUSTOMER ORDER CONFIRMATION
// ══════════════════════════════════════════════════════
const sendCustomerEmail = async ({ email, orderId, products: items, totalAmount, address, paymentMethod }) => {
  if (!email || email === "guest@gmail.com") return;
  console.log(`📧 Sending order confirmation to ${email}...`);

  const shortId  = String(orderId).slice(-6).toUpperCase();
  const total    = Number(totalAmount||0).toLocaleString("en-IN");
  const addrText = formatAddress(address||{});
  const date     = new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});

  const itemRows = (items||[]).map(item => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08;width:70px">
        ${item.image
          ? `<img src="${item.image}" width="56" height="66" style="object-fit:cover;border-radius:4px;border:1px solid #3a2a10;display:block">`
          : `<div style="width:56px;height:66px;background:#2a1a08;border-radius:4px;text-align:center;line-height:66px;font-size:22px">🥻</div>`}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08">
        <div style="color:#e8d5a3;font-weight:700;font-size:13px">${item.name||"—"}</div>
        <div style="color:#7a5a30;font-size:11px;margin-top:3px">
          ${item.selectedSize||item.size ? `Size: ${item.selectedSize||item.size}` : ""}
          ${item.color ? ` · ${item.color}` : ""}
        </div>
        <div style="color:#5a3a10;font-size:11px;margin-top:2px">Qty: ${item.quantity||1}</div>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #2a1a08;text-align:right;vertical-align:top">
        <div style="color:#c8a04a;font-weight:700;font-size:14px">₹${(Number(item.price||0)*(item.quantity||1)).toLocaleString("en-IN")}</div>
      </td>
    </tr>`).join("");

  await sendMail({
    to:      email,
    subject: `✅ Order Confirmed #${shortId} — Mana Vastralu`,
    html: `<!DOCTYPE html><html>
<body style="margin:0;padding:20px;background:#f5f0ea;font-family:Arial,sans-serif">
<div style="max-width:540px;margin:0 auto;background:#1a1008;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#c8a04a,#8b5e1a);padding:24px;text-align:center">
    <h1 style="color:#1a1008;font-family:Georgia,serif;font-size:22px;margin:0 0 3px">🥻 Mana Vastralu</h1>
    <p style="color:#5a3a0a;font-size:10px;margin:0;letter-spacing:2px;text-transform:uppercase">Mana Gurthimpu</p>
  </div>
  <div style="padding:24px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="font-size:44px;margin-bottom:8px">🎉</div>
      <h2 style="color:#e8d5a3;font-family:Georgia,serif;font-size:20px;margin:0 0 6px">Order Confirmed!</h2>
      <p style="color:#9a7050;font-size:12px;margin:0">Thank you for shopping with Mana Vastralu</p>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0a04;border:1px solid rgba(200,160,74,0.2);border-radius:8px;margin-bottom:18px">
      <tr>
        <td style="padding:10px 14px;border-right:1px solid rgba(200,160,74,0.1)">
          <div style="color:#7a5a30;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">Order ID</div>
          <div style="color:#c8a04a;font-weight:700;font-size:13px;font-family:monospace">#${shortId}</div>
        </td>
        <td style="padding:10px 14px;border-right:1px solid rgba(200,160,74,0.1)">
          <div style="color:#7a5a30;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">Date</div>
          <div style="color:#e8d5a3;font-size:12px">${date}</div>
        </td>
        <td style="padding:10px 14px;border-right:1px solid rgba(200,160,74,0.1)">
          <div style="color:#7a5a30;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">Payment</div>
          <div style="color:#e8d5a3;font-size:12px">${paymentMethod||"Online"}</div>
        </td>
        <td style="padding:10px 14px">
          <div style="color:#7a5a30;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">Total</div>
          <div style="color:#c8a04a;font-weight:700;font-size:16px">₹${total}</div>
        </td>
      </tr>
    </table>
    <div style="color:#c8a04a;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700">Items Ordered</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0a04;border:1px solid rgba(200,160,74,0.15);border-radius:8px;border-collapse:collapse;margin-bottom:18px">
      <tbody>${itemRows}</tbody>
      <tr style="background:rgba(200,160,74,0.08)">
        <td colspan="2" style="padding:12px 14px;color:#9a7050;font-size:12px;text-align:right;font-weight:600">Total Amount</td>
        <td style="padding:12px 14px;text-align:right"><div style="color:#c8a04a;font-size:20px;font-weight:700;font-family:Georgia,serif">₹${total}</div></td>
      </tr>
    </table>
    <div style="background:#0f0a04;border:1px solid rgba(200,160,74,0.15);border-radius:8px;padding:14px;margin-bottom:18px">
      <div style="color:#c8a04a;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700">📍 Delivery Address</div>
      <div style="color:#9a7050;font-size:13px;line-height:1.8">${addrText}</div>
    </div>
    <div style="background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:8px;padding:12px;margin-bottom:18px">
      <div style="color:#4ade80;font-size:12px;font-weight:700">🚚 Estimated Delivery: 3–7 Business Days</div>
      <div style="color:#5a8060;font-size:11px;margin-top:3px">Ships via DTDC · Easy 7-day returns</div>
    </div>
    <div style="text-align:center;padding-top:14px;border-top:1px solid rgba(200,160,74,0.08)">
      // <p style="color:#9a7050;font-size:11px;margin:0 0 4px">Questions? WhatsApp: <strong style="color:#c8a04a">7995869469</strong></p>
      <p style="color:#9a7050;font-size:11px;margin:0">manavastralu@gmail.com</p>
    </div>
  </div>
  <div style="background:#0f0a04;padding:12px;text-align:center">
    <p style="color:#3a2a08;font-size:10px;margin:0">© 2026 Mana Vastralu · @mana_vastralu</p>
  </div>
</div>
</body></html>`,
  });
};

// ══════════════════════════════════════════════════════
//  ADMIN ORDER NOTIFICATION
// ══════════════════════════════════════════════════════
const sendAdminEmail = async ({ email, orderId, products: items, totalAmount, address, paymentMethod }) => {
  const adminEmail = ADMIN_EMAIL();
  if (!adminEmail) { console.log("⚠️ ADMIN_EMAIL not set"); return; }
  console.log(`📧 Sending admin notification to ${adminEmail}...`);

  const shortId  = String(orderId).slice(-6).toUpperCase();
  const total    = Number(totalAmount||0).toLocaleString("en-IN");
  const addrText = formatAddress(address||{});
  const date     = new Date().toLocaleString("en-IN");

  const itemsList = (items||[]).map((item,i) =>
    `<tr style="border-bottom:1px solid rgba(200,160,74,0.08)">
      <td style="padding:8px 12px;color:#7a5a30;font-size:11px">${i+1}</td>
      <td style="padding:8px 12px">
        <div style="color:#e8d5a3;font-size:13px;font-weight:600">${item.name}</div>
        <div style="color:#7a5a30;font-size:11px">${item.selectedSize||item.size?`Size: ${item.selectedSize||item.size}`:""}${item.color?` · ${item.color}`:""}</div>
      </td>
      <td style="padding:8px 12px;color:#9a7050;font-size:12px;text-align:center">×${item.quantity||1}</td>
      <td style="padding:8px 12px;color:#c8a04a;font-size:13px;font-weight:700;text-align:right">₹${(Number(item.price||0)*(item.quantity||1)).toLocaleString("en-IN")}</td>
    </tr>`
  ).join("");

  await sendMail({
    to:      adminEmail,
    subject: `🛍️ New Order #${shortId} — ₹${total} | ${email}`,
    html: `<!DOCTYPE html><html>
<body style="margin:0;padding:20px;background:#0f0a04;font-family:Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;background:#1a1008;border-radius:12px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#c8a04a,#8b5e1a);padding:18px 24px;display:flex;align-items:center;gap:12px">
    <span style="font-size:28px">🛍️</span>
    <div>
      <h2 style="color:#1a1008;font-family:Georgia,serif;font-size:17px;margin:0">New Order — #${shortId}</h2>
      <p style="color:#5a3a0a;font-size:11px;margin:2px 0 0">${date}</p>
    </div>
  </div>
  <div style="padding:20px">
    <div style="background:#0f0a04;border:2px solid rgba(200,160,74,0.4);border-radius:10px;padding:18px;text-align:center;margin-bottom:16px">
      <div style="color:#7a5a30;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Total Amount</div>
      <div style="color:#c8a04a;font-size:34px;font-weight:700;font-family:Georgia,serif">₹${total}</div>
      <div style="color:#9a7050;font-size:12px;margin-top:4px">${paymentMethod||"Online"} · ${email}</div>
    </div>
    <div style="color:#c8a04a;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:8px">Items Ordered</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0a04;border:1px solid rgba(200,160,74,0.15);border-radius:8px;border-collapse:collapse;margin-bottom:16px">
      <tbody>${itemsList}</tbody>
      <tr style="background:rgba(200,160,74,0.1)">
        <td colspan="3" style="padding:10px 12px;color:#9a7050;font-size:12px;font-weight:600;text-align:right">Total</td>
        <td style="padding:10px 12px;color:#c8a04a;font-size:16px;font-weight:700;text-align:right">₹${total}</td>
      </tr>
    </table>
    <div style="background:#0f0a04;border:1px solid rgba(200,160,74,0.15);border-radius:8px;padding:14px;margin-bottom:16px">
      <div style="color:#c8a04a;font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:8px">📍 Ship To</div>
      <div style="color:#9a7050;font-size:13px;line-height:1.8">${addrText}</div>
    </div>
    <div style="text-align:center;padding-top:14px;border-top:1px solid rgba(200,160,74,0.08)">
      <p style="color:#5a3a10;font-size:11px;margin:0">Login to admin dashboard to ship this order.</p>
    </div>
  </div>
</div>
</body></html>`,
  });
};

module.exports = { sendCustomerEmail, sendAdminEmail, sendOTPEmail };