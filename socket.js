// backend/socket.js
// Sets up a Socket.IO server on the same HTTP server as Express, and
// exposes emitStockUpdate() so any route (product create/update/delete,
// order stock deduction) can broadcast the change to every connected
// browser instantly — no page refresh needed.

const { Server } = require("socket.io"); // npm i socket.io

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => cb(null, true), // mirror your Express CORS policy
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("🔌 Client connected:", socket.id);
    socket.on("disconnect", () => {
      console.log("🔌 Client disconnected:", socket.id);
    });
  });

  console.log("✅ Socket.IO initialized");
  return io;
}

// Call this any time a product's stock/soldOut/sizeStock changes.
// Pass the full updated product document (or at minimum _id, stock,
// soldOut, sizeStock) — the frontend merges it into its product list.
function emitStockUpdate(product) {
  if (!io || !product) return;
  io.emit("stockUpdate", {
    _id:       product._id,
    stock:     product.stock,
    soldOut:   product.soldOut,
    sizeStock: product.sizeStock instanceof Map
      ? Object.fromEntries(product.sizeStock)
      : product.sizeStock,
  });
}

module.exports = { initSocket, emitStockUpdate };