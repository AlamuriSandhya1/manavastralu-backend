const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email:      { type: String, required: true, unique: true },
  name:       { type: String },
  photo:      { type: String },
  loginCount: { type: Number, default: 1 },
  lastLogin:  { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
});

module.exports = mongoose.model("User", userSchema);