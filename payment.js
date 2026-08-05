import React, { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";

const BASE = process.env.REACT_APP_API_URL || "https://manavastralu-backend.onrender.com";

export default function Payment({ cartItems, setCartItems }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { finalTotal, address: checkoutAddress } = location.state || {};

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  const handlePhonePe = async () => {
    setLoading(true);
    setError("");
    try {
      const userEmail = localStorage.getItem("userEmail") || "guest@gmail.com";
      const userName  = localStorage.getItem("userName")  || "Guest";

      // 1. Save order first (status = Pending)
      const products = (cartItems || []).map(item => ({
        productId:    item._id || item.id,
        name:         item.name,
        price:        Number(item.price),
        quantity:     item.quantity || 1,
        selectedSize: item.selectedSize || "",
        color:        item.color || "",
        image:        item.images?.[0] || item.image || "",
      }));

      const orderRes = await axios.post(`${BASE}/add-order`, {
        user_id: userEmail, email: userEmail, userName,
        phone:          checkoutAddress?.phone || "",
        address:        checkoutAddress || {},
        payment_method: "PhonePe", paymentMethod: "PhonePe",
        total_amount:   Number(finalTotal), totalAmount: Number(finalTotal),
        products, paymentStatus: "Pending",
      });

      const orderId = orderRes.data?.orderId || "";

      // 2. Initiate PhonePe
      const ppRes = await axios.post(`${BASE}/api/phonepe/initiate`, {
        amount: finalTotal, orderId, userEmail, userName,
        userPhone: checkoutAddress?.phone || "9999999999",
      });

      if (ppRes.data.success && ppRes.data.redirectUrl) {
        setCartItems([]);
        localStorage.removeItem("cartItems");
        window.location.href = ppRes.data.redirectUrl; // redirect to PhonePe
      } else {
        setError(ppRes.data.message || "Could not initiate payment.");
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Payment failed. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const getItemImg = (item) => {
    const img = item.images?.[0] || item.image || "";
    if (!img) return "/images/s1.png";
    if (img.startsWith("http")) return img;
    return `${BASE}/uploads/${img}`;
  };

  return (
    <>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}.pp-btn{transition:opacity .2s,transform .15s}.pp-btn:hover:not(:disabled){opacity:.9;transform:translateY(-1px)}.pp-btn:disabled{opacity:.6;cursor:not-allowed}`}</style>
      <div style={s.page}>
        <div style={s.card}>

          <div style={s.header}>
            <div style={{ fontSize:36,marginBottom:6 }}>🔒</div>
            <h2 style={s.title}>Secure Checkout</h2>
            <div style={s.badge}>₹{Number(finalTotal||0).toLocaleString("en-IN")}</div>
            <p style={s.brand}>Mana Vastralu</p>
          </div>

          {/* Order summary */}
          {cartItems?.length > 0 && (
            <div style={s.summary}>
              <div style={s.summaryTitle}>Order Summary ({cartItems.length} item{cartItems.length>1?"s":""})</div>
              {cartItems.map((item,i)=>(
                <div key={i} style={{ display:"flex",gap:10,alignItems:"center",marginBottom:8,paddingBottom:8,borderBottom:i<cartItems.length-1?"1px solid #f0e4d6":"none" }}>
                  <img src={getItemImg(item)} alt={item.name} onError={e=>{e.target.src="/images/s1.png";}}
                    style={{ width:44,height:44,objectFit:"cover",borderRadius:6,border:"1px solid #e8d8c4",flexShrink:0 }}/>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13,fontWeight:600,color:"#5c3317" }}>{item.name}</div>
                    <div style={{ fontSize:11,color:"#9a7050" }}>{item.selectedSize&&`Size: ${item.selectedSize} · `}Qty: {item.quantity||1}</div>
                  </div>
                  <div style={{ fontSize:13,fontWeight:700,color:"#8b4513" }}>₹{(Number(item.price)*(item.quantity||1)).toLocaleString()}</div>
                </div>
              ))}
              {checkoutAddress?.fullName && (
                <div style={{ marginTop:8,paddingTop:8,borderTop:"1px dashed #e8d8c4",fontSize:11,color:"#9a7050" }}>
                  <strong style={{ color:"#5c3317" }}>{checkoutAddress.fullName}</strong>
                  {checkoutAddress.phone&&` · ${checkoutAddress.phone}`}<br/>
                  {[checkoutAddress.houseNo,checkoutAddress.landmark,checkoutAddress.village,checkoutAddress.district,checkoutAddress.state,checkoutAddress.pincode].filter(Boolean).join(", ")}
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={s.errorBox}><span>⚠️</span><span>{error}</span></div>
          )}

          {/* PhonePe button */}
          <button className="pp-btn" onClick={handlePhonePe} disabled={loading} style={s.payBtn}>
            {loading ? (
              <><span style={{ display:"inline-block",width:18,height:18,border:"2.5px solid rgba(255,255,255,.4)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin .7s linear infinite",marginRight:10,verticalAlign:"middle" }}/> Processing…</>
            ) : (
              <>
                <svg width="24" height="24" viewBox="0 0 24 24" style={{ marginRight:10,flexShrink:0 }}>
                  <circle cx="12" cy="12" r="12" fill="#fff"/>
                  <text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#5f259f">Pe</text>
                </svg>
                Pay ₹{Number(finalTotal||0).toLocaleString("en-IN")} with PhonePe
              </>
            )}
          </button>

          {/* How it works */}
          <div style={{ background:"#fdf6ee",border:"1px solid #e8d8c4",borderRadius:10,padding:"14px 16px",marginTop:16 }}>
            <div style={{ fontSize:11,fontWeight:700,color:"#9a7050",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:10 }}>How it works</div>
            {[["1️⃣","Click Pay — you'll be redirected to PhonePe"],["2️⃣","Pay via UPI, Cards, Net Banking or Wallet"],["3️⃣","You'll return here with your order confirmation"]].map(([icon,text])=>(
              <div key={text} style={{ display:"flex",gap:10,alignItems:"center",fontSize:12,color:"#5c3317",padding:"4px 0" }}>
                <span>{icon}</span><span>{text}</span>
              </div>
            ))}
          </div>

          <p style={s.trust}>🔒 256-bit SSL · Powered by PhonePe</p>
        </div>
      </div>
    </>
  );
}

const s = {
  page:        { minHeight:"100vh",background:"linear-gradient(160deg,#1a0a00 0%,#3d1a00 50%,#1a0a00 100%)",display:"flex",alignItems:"center",justifyContent:"center",padding:20,fontFamily:"Georgia,serif" },
  card:        { background:"#fffaf5",borderRadius:24,padding:"36px 32px",width:"100%",maxWidth:500,boxShadow:"0 32px 80px rgba(0,0,0,.45)" },
  header:      { textAlign:"center",marginBottom:20 },
  title:       { margin:"0 0 10px",fontSize:24,fontWeight:700,color:"#1a0a00" },
  badge:       { display:"inline-block",background:"#8B4513",color:"#fff",fontSize:20,fontWeight:700,padding:"4px 20px",borderRadius:100,marginBottom:6 },
  brand:       { margin:0,fontSize:13,color:"#a0522d",letterSpacing:1,textTransform:"uppercase" },
  summary:     { marginBottom:20,background:"#fdf6ee",border:"1px solid #e8d8c4",borderRadius:12,padding:"12px 16px" },
  summaryTitle:{ fontSize:11,fontWeight:700,color:"#9a7050",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:10 },
  errorBox:    { display:"flex",alignItems:"center",gap:8,background:"#fff5f5",border:"1px solid #fca5a5",color:"#b91c1c",padding:"12px 16px",borderRadius:12,fontSize:13,marginBottom:16 },
  payBtn:      { width:"100%",padding:"17px",background:"linear-gradient(90deg,#5f259f,#8a2be2)",color:"#fff",border:"none",borderRadius:14,fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 24px rgba(95,37,159,.35)",marginTop:4 },
  trust:       { textAlign:"center",fontSize:12,color:"#aaa",marginTop:14,fontFamily:"sans-serif" },
};