// backend/middleware/syncProductCategory.js
//
// Put this on your product CREATE and UPDATE routes (after multer on the
// create route). It:
//   • validates that body.categoryId is a real category
//   • sets body.category = that category's name, a read-only mirror so older
//     pages that still read product.category keep working
//
// categoryId is the single source of truth. Counts are always computed from it.
const mongoose = require("mongoose");
const Category = require("../models/Category");

module.exports = async function syncProductCategory(req, res, next) {
  try {
    const id = req.body && req.body.categoryId;

    if (id === undefined) return next(); // this request doesn't touch the category
    if (id === "" || id === null) {
      delete req.body.categoryId;        // ignore empty value
      return next();
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid categoryId" });
    }
    const cat = await Category.findById(id).lean();
    if (!cat) return res.status(400).json({ error: "Category does not exist" });

    req.body.category = cat.name;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};