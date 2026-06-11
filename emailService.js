require("dotenv").config();
const nodemailer = require("nodemailer");
const https      = require("https");
const http       = require("http");

const createTransporter = () => {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS.replace(/\s/g, ""),
    },
    tls: { rejectUnauthorized: false },
  });
};

const verifyEmail = async () => {
  const transporter = createTransporter();

  if (!transporter) {
    console.log("❌ Gmail credentials missing");
    return;
  }

  try {
    await transporter.verify();
    console.log("✅ Email service ready");
  } catch (err) {
    console.error("❌ Email verify failed:", err);
  }
};

const STORE_URL = process.env.STORE_URL || "http://localhost:3000";

// ── Fetch image and convert to base64 (max 80KB to avoid Gmail clipping) ──
const imageToBase64 = (url) => new Promise((resolve) => {
  if (!url) return resolve(null);
  const fetchUrl = url.replace(/https?:\/\/[^\/]+/, "https://manavastralu-backend-production.up.railway.app");
  const protocol = fetchUrl.startsWith("https") ? https : http;
  try {
    protocol.get(fetchUrl, { timeout: 3000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 80000) return resolve(null); // skip if too large
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (size > 80000) return resolve(null);
        const b64      = Buffer.concat(chunks).toString("base64");
        const mimeType = res.headers["content-type"] || "image/jpeg";
        resolve(`data:${mimeType};base64,${b64}`);
      });
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  } catch { resolve(null); }
});

const formatAddress = (addr) => {
  if (!addr || typeof addr !== "object") return "Not provided";
  return [addr.fullName, addr.phone, addr.houseNo, addr.landmark,
          addr.village, addr.district, addr.state, addr.pincode]
    .filter(Boolean).join(", ") || "Not provided";
};

const buildProductRows = async (products = []) => {
  if (!products.length) return `<tr><td colspan="4" style="padding:10px;color:#9a7050;">No items</td></tr>`;

  const rows = await Promise.all(products.map(async (p) => {
    const rawImg = p.image || p.images?.[0] || "";
    const b64    = rawImg ? await imageToBase64(rawImg) : null;

    const imgHtml = b64
      ? `<img src="${b64}" width="56" height="66"
             style="object-fit:cover;border-radius:3px;
                    border:1px solid #e8d8c4;display:block;"/>`
      : `<div style="width:56px;height:66px;background:#3d1a0e;border-radius:3px;
                     text-align:center;line-height:66px;font-size:24px;">🥻</div>`;

    const size  = p.selectedSize || p.size || "";
    const color = p.color || "";
    const meta  = [size ? `Size: ${size}` : "", color].filter(Boolean).join(" · ");

    return `<tr style="border-bottom:1px solid #f0e8d8;">
      <td style="padding:8px;width:72px;">${imgHtml}</td>
      <td style="padding:8px;font-size:13px;color:#1a1008;font-weight:600;vertical-align:top;">
        ${p.name || "—"}
        ${meta ? `<div style="font-size:11px;color:#9a7050;margin-top:3px;">${meta}</div>` : ""}
      </td>
      <td style="padding:8px;color:#9a7050;font-size:12px;vertical-align:top;">Qty: ${p.quantity||1}</td>
      <td style="padding:8px;font-size:13px;font-weight:700;color:#B8860B;
                 vertical-align:top;text-align:right;">
        ₹${(Number(p.price||0)*(p.quantity||1)).toLocaleString("en-IN")}
      </td>
    </tr>`;
  }));

  return rows.join("");
};

// ════════════════════════════════════════════════════
//  CUSTOMER EMAIL — compact, no clipping
// ════════════════════════════════════════════════════
const sendCustomerEmail = async ({ email, orderId, products, totalAmount, address, paymentMethod }) => {
  const transporter = createTransporter();
  if (!transporter) return;

  const shortId  = String(orderId).slice(-8).toUpperCase();
  const addrText = formatAddress(address);
  const rows     = await buildProductRows(products);
  const total    = Number(totalAmount).toLocaleString("en-IN");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5ede0;font-family:Georgia,serif;">
<div style="max-width:560px;margin:0 auto;background:#fffaf5;">

  <div style="background:#3d1a0e;padding:24px 32px;text-align:center;">
    <h1 style="color:#e8d5a3;font-size:22px;margin:0;">Mana Vastralu</h1>
    <p style="color:#c8a04a;font-size:10px;letter-spacing:2px;margin:4px 0 0;text-transform:uppercase;">Mana Vastralu · Mana Gurthimpu</p>
  </div>

  <div style="padding:24px 32px;">
    <div style="text-align:center;margin-bottom:16px;">
      <div style="display:inline-block;width:52px;height:52px;border-radius:50%;
                  background:#e8f5e9;border:2px solid #4caf50;
                  line-height:52px;font-size:24px;color:#4caf50;">✓</div>
    </div>
    <h2 style="font-size:20px;color:#1a1008;text-align:center;margin:0 0 4px;">Order Confirmed! 🎉</h2>
    <p style="text-align:center;color:#9a7050;font-size:13px;margin:0 0 20px;">Thank you for shopping with Mana Vastralu</p>

    <!-- ORDER INFO -->
    <table style="width:100%;border-collapse:collapse;background:#fdf6ee;
                  border:1px solid #e8d8c4;border-radius:6px;margin-bottom:20px;">
      <tr style="border-bottom:1px solid #f0e8d8;">
        <td style="padding:8px 14px;color:#9a7050;font-size:12px;">Order ID</td>
        <td style="padding:8px 14px;color:#1a1008;font-weight:600;font-size:12px;text-align:right;">#${shortId}</td>
      </tr>
      <tr style="border-bottom:1px solid #f0e8d8;">
        <td style="padding:8px 14px;color:#9a7050;font-size:12px;">Payment</td>
        <td style="padding:8px 14px;color:#1a1008;font-weight:600;font-size:12px;text-align:right;">${paymentMethod||"COD"}</td>
      </tr>
      <tr style="border-bottom:1px solid #f0e8d8;">
        <td style="padding:8px 14px;color:#9a7050;font-size:12px;">Total Paid</td>
        <td style="padding:8px 14px;color:#B8860B;font-weight:700;font-size:14px;text-align:right;">₹${total}</td>
      </tr>
      <tr>
        <td style="padding:8px 14px;color:#9a7050;font-size:12px;">Delivery</td>
        <td style="padding:8px 14px;color:#1a1008;font-weight:600;font-size:12px;text-align:right;">3–5 Business Days</td>
      </tr>
    </table>

    <!-- ITEMS -->
    <p style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#B8860B;margin:0 0 8px;">Items Ordered</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e8d8c4;border-radius:4px;">
      <tbody>${rows}</tbody>
      <tr>
        <td colspan="3" style="background:#3d1a0e;color:#c8a04a;font-size:12px;padding:10px 8px;font-weight:600;">Total</td>
        <td style="background:#3d1a0e;color:#e8d5a3;font-size:15px;font-weight:700;padding:10px 8px;text-align:right;">₹${total}</td>
      </tr>
    </table>

    <!-- ADDRESS -->
    <p style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#B8860B;margin:16px 0 8px;">Delivery Address</p>
    <div style="background:#fff;border:1px solid #e8d8c4;border-radius:4px;padding:12px 14px;font-size:12px;color:#5a4a3a;line-height:1.7;">
      📍 ${addrText}
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin:20px 0 16px;">
      <a href="${STORE_URL}/my-orders"
         style="display:inline-block;background:#3d1a0e;color:#e8d5a3;
                padding:10px 28px;font-size:11px;font-weight:700;
                letter-spacing:1.5px;text-transform:uppercase;
                text-decoration:none;border-radius:4px;">View My Orders →</a>
    </div>

    <p style="font-size:11px;color:#9a7050;text-align:center;margin:0;">
      WhatsApp: <a href="https://wa.me/917995869469" style="color:#B8860B;">+91 7995869469</a> &nbsp;|&nbsp;
      <a href="mailto:manavastralu@gmail.com" style="color:#B8860B;">manavastralu@gmail.com</a>
    </p>
  </div>

  <div style="background:#f5ede0;padding:14px 32px;text-align:center;font-size:10px;color:#9a7050;border-top:1px solid #e8d8c4;">
    © 2026 Mana Vastralu · <a href="https://instagram.com/mana_vastralu" style="color:#B8860B;">@mana_vastralu</a> · Easy 7-day returns
  </div>
</div>
</body></html>`;

  await transporter.sendMail({
    from:    `"Mana Vastralu" <${process.env.GMAIL_USER}>`,
    to:      email,
    subject: `✅ Order Confirmed #${shortId} — Mana Vastralu`,
    html,
  });
  console.log(`✅ Customer email sent → ${email}`);
};

// ════════════════════════════════════════════════════
//  ADMIN EMAIL — compact
// ════════════════════════════════════════════════════
const sendAdminEmail = async ({ email, orderId, products, totalAmount, address, paymentMethod }) => {
  const transporter = createTransporter();
  if (!transporter) return;

  const shortId  = String(orderId).slice(-8).toUpperCase();
  const addrText = formatAddress(address);
  const rows     = await buildProductRows(products);
  const total    = Number(totalAmount).toLocaleString("en-IN");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0f0a04;font-family:Arial,sans-serif;">
<div style="max-width:560px;margin:0 auto;background:#1a1008;">

  <div style="background:#2a1208;padding:18px 24px;border-bottom:1px solid rgba(200,160,74,0.2);">
    <h1 style="color:#c8a04a;font-size:16px;margin:0;">🛍️ Mana Vastralu — Admin</h1>
    <p style="color:#7a5a30;font-size:10px;margin:3px 0 0;">New order notification</p>
  </div>

  <div style="margin:16px 20px;padding:10px 14px;border-radius:5px;
              background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);
              color:#4ade80;font-size:13px;font-weight:600;">
    🎉 New order — #${shortId}
  </div>

  <div style="padding:0 20px 20px;">

    <!-- INFO -->
    <table style="width:100%;border-collapse:collapse;background:#0f0a04;
                  border:1px solid rgba(200,160,74,0.15);border-radius:6px;margin-bottom:16px;">
      <tr style="border-bottom:1px solid rgba(200,160,74,0.08);">
        <td style="padding:7px 12px;color:#7a5a30;font-size:12px;">Order ID</td>
        <td style="padding:7px 12px;color:#e8d5a3;font-weight:600;font-size:12px;text-align:right;">#${shortId}</td>
      </tr>
      <tr style="border-bottom:1px solid rgba(200,160,74,0.08);">
        <td style="padding:7px 12px;color:#7a5a30;font-size:12px;">Customer</td>
        <td style="padding:7px 12px;color:#e8d5a3;font-weight:600;font-size:12px;text-align:right;">${email}</td>
      </tr>
      <tr style="border-bottom:1px solid rgba(200,160,74,0.08);">
        <td style="padding:7px 12px;color:#7a5a30;font-size:12px;">Payment</td>
        <td style="padding:7px 12px;color:#e8d5a3;font-weight:600;font-size:12px;text-align:right;">${paymentMethod||"COD"}</td>
      </tr>
      <tr>
        <td style="padding:7px 12px;color:#7a5a30;font-size:12px;">Total</td>
        <td style="padding:7px 12px;color:#c8a04a;font-weight:700;font-size:14px;text-align:right;">₹${total}</td>
      </tr>
    </table>

    <!-- ITEMS -->
    <p style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c8a04a;margin:0 0 8px;">Items Ordered</p>
    <table style="width:100%;border-collapse:collapse;">
      <tbody>${rows}</tbody>
      <tr>
        <td colspan="3" style="background:#c8a04a;color:#1a1008;font-weight:700;font-size:13px;padding:10px 8px;">Total</td>
        <td style="background:#c8a04a;color:#1a1008;font-weight:700;font-size:13px;padding:10px 8px;text-align:right;">₹${total}</td>
      </tr>
    </table>

    <!-- ADDRESS -->
    <p style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#c8a04a;margin:16px 0 8px;">Delivery Address</p>
    <div style="background:#0f0a04;border:1px solid rgba(200,160,74,0.15);border-radius:4px;
                padding:12px;font-size:12px;color:#9a7050;line-height:1.7;margin-bottom:16px;">
      📍 ${addrText}
    </div>

    <div style="text-align:center;">
      <a href="${STORE_URL}/admin"
         style="display:inline-block;background:#c8a04a;color:#1a1008;
                padding:10px 24px;font-size:11px;font-weight:700;
                letter-spacing:1.5px;text-transform:uppercase;
                text-decoration:none;border-radius:4px;">Open Admin Dashboard →</a>
    </div>
  </div>

  <div style="background:#0f0a04;padding:12px 20px;text-align:center;font-size:10px;color:#5a3a10;border-top:1px solid rgba(200,160,74,0.1);">
    Mana Vastralu Admin · Do not reply
  </div>
</div>
</body></html>`;

  await transporter.sendMail({
    from:    `"Mana Vastralu Orders" <${process.env.GMAIL_USER}>`,
    to:      process.env.ADMIN_EMAIL || process.env.GMAIL_USER,
    subject: `🛍️ New Order #${shortId} — ₹${total} (${paymentMethod||"COD"})`,
    html,
  });
  console.log(`✅ Admin email sent → ${process.env.ADMIN_EMAIL}`);
};

module.exports = { sendCustomerEmail, sendAdminEmail };