const STORE = {
  name:    "Reshma",
  address: "H No: 5-94/260, Srujanalaxmi Nagar,\nRoad No-7, Phase-2, Patelguda,\nPatancheru, Hyderabad,\nTelangana, Pin Code: 502319",
  phone:   "7995869469",
  insta:   "mana_vastralu",
  whatsapp:"7995869469",
  email:   "manavastralu@gmail.com",
  website: "manavastralu.com",
};

function generateShippingLabel(order) {
  const addr    = order.address || {};
  const items   = order.products || order.items || [];
  const shortId = String(order._id).slice(-8).toUpperCase();
  const date    = new Date().toLocaleDateString("en-IN", {
    day:"2-digit", month:"short", year:"numeric"
  });

  const toName  = addr.fullName || addr.name || "Customer";
  const toPhone = addr.phone || "";
  const toAddr  = [addr.houseNo, addr.landmark, addr.village, addr.district]
    .filter(Boolean).join(",\n");
  const toState = addr.state  || "";
  const toPin   = addr.pincode || "";

  const itemLines = items.map(item =>
    `${item.name}${item.selectedSize||item.size ? ` (Size: ${item.selectedSize||item.size})` : ""}${item.color ? ` - ${item.color}` : ""} × ${item.quantity||1} = ₹${(Number(item.price||0)*(item.quantity||1)).toLocaleString("en-IN")}`
  ).join("<br/>");

  const total = Number(order.total_amount || order.totalAmount || 0).toLocaleString("en-IN");
  const payMethod = order.paymentMethod || order.payment_method || "Online";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Shipping Label #${shortId}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Lato:wght@300;400;600;700&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; }
  body {
    background: #f5e8d8;
    display: flex; flex-direction: column;
    align-items: center;
    padding: 20px;
    font-family: 'Lato', sans-serif;
  }

  .print-btn {
    margin-bottom: 16px;
    display: flex; gap: 10px; align-items: center;
  }
  .print-btn button {
    background: #3d1a0e; color: #e8d5a3;
    border: none; padding: 12px 28px;
    font-size: 14px; font-weight: 700;
    cursor: pointer; border-radius: 4px;
    font-family: 'Lato', sans-serif;
    letter-spacing: 1px;
  }
  .print-btn button:hover { background: #5c2b18; }

  /* THE LABEL — A5 landscape */
  .label {
    width: 210mm;
    min-height: 148mm;
    background: #fff9f4;
    border: 2px solid #c9853a;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    box-shadow: 0 8px 32px rgba(61,26,14,0.2);
  }

  /* Gold corner decorations */
  .label::before, .label::after {
    content: '✦';
    position: absolute;
    font-size: 22px;
    color: #c9853a;
    opacity: 0.5;
  }
  .label::before { top: 8px; left: 8px; }
  .label::after  { bottom: 8px; right: 8px; }

  /* Top gold strip */
  .gold-strip-top {
    height: 6px;
    background: linear-gradient(90deg, #c9853a, #e8b97a, #c9853a, #e8b97a, #c9853a);
  }

  /* Main content grid */
  .label-body {
    display: grid;
    grid-template-columns: 1fr 160px;
    min-height: 130mm;
  }

  /* LEFT — addresses */
  .label-left {
    padding: 16px 18px;
    border-right: 1px dashed #c9853a;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .addr-block { }
  .addr-tag {
    font-size: 9px; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase;
    color: #c9853a; margin-bottom: 6px;
    display: flex; align-items: center; gap: 5px;
  }
  .addr-tag::after {
    content: ''; flex: 1; height: 1px;
    background: linear-gradient(90deg, #c9853a, transparent);
  }
  .addr-name {
    font-size: 16px; font-weight: 700;
    color: #1a1008; margin-bottom: 3px;
    font-family: 'Playfair Display', serif;
  }
  .addr-text {
    font-size: 12px; color: #5a3a22;
    line-height: 1.65; white-space: pre-line;
  }
  .addr-phone {
    font-size: 13px; font-weight: 600;
    color: #3d1a0e; margin-top: 5px;
  }

  .divider {
    border: none;
    border-top: 1px dashed #c9853a;
    margin: 4px 0;
  }

  /* ORDER INFO below addresses */
  .order-meta {
    display: flex; gap: 20px;
    padding: 8px 18px;
    background: #fdf6ee;
    border-top: 1px solid #f0e0c8;
    border-bottom: 1px solid #f0e0c8;
    font-size: 11px; color: #7a5030;
  }
  .order-meta strong { color: #3d1a0e; }

  /* Items */
  .items-section {
    padding: 8px 18px;
    border-bottom: 1px solid #f0e0c8;
  }
  .items-title {
    font-size: 9px; font-weight: 700;
    letter-spacing: 1.5px; text-transform: uppercase;
    color: #c9853a; margin-bottom: 6px;
  }
  .items-text { font-size: 11px; color: #5a3a22; line-height: 1.8; }
  .total-row {
    font-size: 13px; font-weight: 700;
    color: #3d1a0e; margin-top: 5px;
    padding-top: 5px; border-top: 1px solid #e8d0b0;
  }

  /* RIGHT — brand circle */
  .label-right {
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    background: linear-gradient(135deg, #fffaf5, #fdf0e0);
  }

  .brand-circle {
    width: 130px; height: 130px;
    border-radius: 50%;
    background: radial-gradient(circle, #fff9f4 60%, #fae8d0 100%);
    border: 3px solid #c9853a;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    text-align: center;
    padding: 12px;
    position: relative;
    box-shadow: 0 4px 12px rgba(201,133,58,0.2);
  }
  .brand-circle::before {
    content: '';
    position: absolute; inset: 4px;
    border-radius: 50%;
    border: 1px solid rgba(201,133,58,0.3);
  }
  .brand-title {
    font-family: 'Playfair Display', serif;
    font-size: 17px; font-weight: 700;
    color: #3d1a0e; line-height: 1.1;
    margin-bottom: 4px;
  }
  .brand-sub {
    font-size: 7px; color: #c9853a;
    letter-spacing: 0.5px; margin-bottom: 6px;
  }
  .brand-contact {
    font-size: 9px; color: #3d1a0e;
    line-height: 1.7; text-align: center;
  }
  .brand-contact .ig { color: #c9853a; font-weight: 600; }
  .brand-contact .wa { color: #2e7d32; font-weight: 600; }

  .thank-you-badge {
    font-family: 'Playfair Display', serif;
    font-size: 11px; font-style: italic;
    color: #7a5030; text-align: center;
    padding: 6px 8px;
    border: 1px solid rgba(201,133,58,0.3);
    border-radius: 3px;
    background: #fffaf5;
    width: 100%;
  }

  /* Bottom gold strip */
  .gold-strip-bottom {
    height: 6px;
    background: linear-gradient(90deg, #c9853a, #e8b97a, #c9853a, #e8b97a, #c9853a);
  }

  /* Order ID badge */
  .order-id-badge {
    position: absolute;
    top: 10px; right: 170px;
    background: #3d1a0e; color: #e8d5a3;
    font-size: 10px; font-weight: 700;
    padding: 4px 10px; border-radius: 2px;
    letter-spacing: 0.5px;
  }

  @media print {
    body { background:#fff; padding:0; }
    .print-btn { display:none !important; }
    .label { box-shadow:none; border:2px solid #c9853a; }
    @page { size: A5 landscape; margin: 5mm; }
  }
</style>
</head>
<body>

<div class="print-btn">
  <button onclick="window.print()">🖨️ Print Shipping Label</button>
  <span style="font-size:12px;color:#7a5030;font-family:Lato,sans-serif;">A5 Landscape · Connects to any printer</span>
</div>

<div class="label">
  <div class="gold-strip-top"></div>

  <div class="order-id-badge">ORDER #${shortId} · ${date}</div>

  <div class="label-body">

    <!-- LEFT: Addresses + Items -->
    <div class="label-left">

      <!-- TO -->
      <div class="addr-block">
        <div class="addr-tag">📍 Deliver To</div>
        <div class="addr-name">TO, ${toName}</div>
        <div class="addr-text">${toAddr}</div>
        <div class="addr-text">${toState}${toPin ? `,\nPin code: ${toPin}` : ""}</div>
        ${toPhone ? `<div class="addr-phone">📞 ${toPhone}</div>` : ""}
      </div>

      <hr class="divider"/>

      <!-- FROM -->
      <div class="addr-block">
        <div class="addr-tag">📦 From</div>
        <div class="addr-name">Name : ${STORE.name}</div>
        <div class="addr-text">${STORE.address}</div>
        <div class="addr-phone">Contact number: ${STORE.phone}</div>
      </div>

    </div>

    <!-- RIGHT: Brand Circle -->
    <div class="label-right">
      <div class="brand-circle">
        <div class="brand-title">Mana<br/>Vastralu</div>
        <div class="brand-sub">— Mana Vastralu · Mana Gurthimpu —</div>
        <div class="brand-contact">
          <div class="ig">📸 mana_vastralu</div>
          <div class="wa">📞 ${STORE.phone}</div>
        </div>
      </div>
      <div class="thank-you-badge">THANK YOU<br/><span style="font-size:9px;font-style:italic;">for your purchase</span></div>
    </div>

  </div>

  <!-- ORDER META -->
  <div class="order-meta">
    <div>Payment: <strong>${payMethod}</strong></div>
    ${order.paymentId ? `<div>Payment ID: <strong>${order.paymentId}</strong></div>` : ""}
    <div>Total: <strong>₹${total}</strong></div>
    <div>Status: <strong style="color:#2e7d32">✅ Confirmed</strong></div>
  </div>

  <!-- ITEMS -->
  <div class="items-section">
    <div class="items-title">Items Ordered</div>
    <div class="items-text">${itemLines}</div>
    <div class="total-row">Total Amount: ₹${total}</div>
  </div>

  <div class="gold-strip-bottom"></div>
</div>

</body>
</html>`;
}

// ── WhatsApp message builder ──────────────────────────
function buildWhatsAppLink(order, labelUrl) {
  const addr    = order.address || {};
  const items   = order.products || order.items || [];
  const shortId = String(order._id).slice(-8).toUpperCase();
  const date    = new Date().toLocaleDateString("en-IN", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });

  const toName  = addr.fullName || addr.name || "Customer";
  const toPhone = addr.phone || "";
  const toAddr  = [addr.houseNo, addr.landmark, addr.village,
                   addr.district, addr.state, addr.pincode]
    .filter(Boolean).join(", ");

  const total      = Number(order.total_amount||order.totalAmount||0).toLocaleString("en-IN");
  const payMethod  = order.paymentMethod || order.payment_method || "Online";

  const itemLines = items.map((item, i) =>
    `  ${i+1}. ${item.name}` +
    (item.selectedSize||item.size ? ` | Size: ${item.selectedSize||item.size}` : "") +
    (item.color ? ` | ${item.color}` : "") +
    ` | Qty: ${item.quantity||1}` +
    ` | ₹${(Number(item.price||0)*(item.quantity||1)).toLocaleString("en-IN")}`
  ).join("\n");

  const message = `
🛍️ *NEW ORDER CONFIRMED — Mana Vastralu*
━━━━━━━━━━━━━━━━━━━━━━
📋 *Order ID:* #${shortId}
📅 *Date:* ${date}
━━━━━━━━━━━━━━━━━━━━━━
👤 *Customer:* ${order.email || "Guest"}
💳 *Payment:* ${payMethod}${order.paymentId ? `\n🆔 *Pay ID:* ${order.paymentId}` : ""}
━━━━━━━━━━━━━━━━━━━━━━
📦 *ITEMS:*
${itemLines}
━━━━━━━━━━━━━━━━━━━━━━
💰 *TOTAL: ₹${total}*
━━━━━━━━━━━━━━━━━━━━━━
📍 *SHIP TO:*
${toName}
${toAddr}
${toPhone ? `📞 ${toPhone}` : ""}
━━━━━━━━━━━━━━━━━━━━━━
🖨️ *Print Label:*
${labelUrl}
━━━━━━━━━━━━━━━━━━━━━━
✅ Please pack & ship soon!
`.trim();

  const encoded    = encodeURIComponent(message);
  const adminPhone = STORE.whatsapp;
  return `https://wa.me/${adminPhone}?text=${encoded}`;
}

module.exports = { generateShippingLabel, buildWhatsAppLink, STORE }