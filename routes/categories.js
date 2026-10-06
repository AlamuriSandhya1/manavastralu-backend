// backend/routes/categories.js
//
// Mounted from server.js like this (already done in the patched server.js):
//   app.use(require("./routes/categories")({ upload, adminPass: ADMIN_PASS, waitForDB, Product }));
//
// Category images go to Cloudinary through the SAME `upload` your products use,
// so they survive Render restarts (local disk files do not).
const express = require("express");
const Category = require("../models/Category");

module.exports = function categoryRoutes({ upload, adminPass, waitForDB, Product, onChange }) {
  const router = express.Router();

  /* ───────── helpers ───────── */
  const slugify = (s = "") =>
    String(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const toBool = (v, fallback) =>
    v === undefined ? fallback : v === true || v === "true" || v === "1" || v === "on";

  // multer-storage-cloudinary puts the full https URL in file.path
  const fileUrl = (f) => (f ? f.path || f.secure_url || "" : "");

  // same pattern as your other admin routes: password in query OR body
  const requireAdmin = (req, res, next) => {
    const pw = (req.body && req.body.password) || req.query.password;
    if (pw !== adminPass) return res.status(401).json({ error: "Unauthorized" });
    next();
  };

  // wraps multer so an upload error becomes a clean JSON message
  const uploadImage = (req, res, next) =>
    upload.single("image")(req, res, (err) => {
      if (err) return res.status(500).json({ error: "Image upload failed: " + err.message });
      next();
    });

  const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const findActive = (param) =>
    Category.findOne({
      isActive: true,
      $or: [
        { slug: String(param).toLowerCase() },
        { name: { $regex: `^${escapeRe(param)}$`, $options: "i" } },
      ],
    }).lean();

  // A product's categoryId may be stored as an ObjectId OR as a plain string
  // (depends on how the Product schema declares the field). Match both.
  const idMatch = (id) => ({ $in: [id, String(id)] });

  // product counts are calculated live from the products collection
  const withCounts = async (cats) => {
    if (cats.length === 0) return [];
    const ids = cats.flatMap((c) => [c._id, String(c._id)]);
    const rows = await Product.aggregate([
      { $match: { categoryId: { $in: ids } } },
      { $group: { _id: { $toString: "$categoryId" }, count: { $sum: 1 } } },
    ]);
    const map = new Map(rows.map((r) => [String(r._id), r.count]));
    return cats.map((c) => ({ ...c, productCount: map.get(String(c._id)) || 0 }));
  };

  /* ═════════════════════════ PUBLIC ═════════════════════════ */

  // Shop by Category
  router.get("/api/categories", async (req, res) => {
    try {
      await waitForDB();
      const cats = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
      const out = (await withCounts(cats)).map((c) => ({
        ...c,
        category: c.name,        // legacy aliases, so older pages reading
        count: c.productCount,   // {category, count} keep working
      }));
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/categories/:slug", async (req, res) => {
    try {
      await waitForDB();
      const cat = await findActive(req.params.slug);
      if (!cat) return res.status(404).json({ error: "Category not found" });
      const [withCount] = await withCounts([cat]);
      res.json(withCount);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/api/categories/:slug/products", async (req, res) => {
    try {
      await waitForDB();
      const cat = await findActive(req.params.slug);
      if (!cat) return res.status(404).json({ error: "Category not found" });
      res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
      const list = await Product.find({ categoryId: idMatch(cat._id) })
        .sort({ createdAt: -1 })
        .select("-description")
        .lean();
      res.json(list.map((p) => {
        const stock = Number(p.stock) || 0;
        const availability = p.soldOut || stock <= 0 ? "sold_out" : stock <= 3 ? "low_stock" : "in_stock";
        return { ...p, availability };
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ═════════════════════════ ADMIN ═════════════════════════ */

  // all categories, active + inactive
  router.get("/api/admin/categories", requireAdmin, async (req, res) => {
    try {
      await waitForDB();
      const cats = await Category.find().sort({ sortOrder: 1, name: 1 }).lean();
      res.json(await withCounts(cats));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // create
  router.post("/api/admin/categories", uploadImage, requireAdmin, async (req, res) => {
    try {
      await waitForDB();
      const name = (req.body.name || "").trim();
      if (!name) return res.status(400).json({ error: "Category name is required" });

      const slug = slugify(req.body.slug || name);
      if (!slug) return res.status(400).json({ error: "Invalid slug" });

      let sortOrder = Number(req.body.sortOrder);
      if (req.body.sortOrder === undefined || req.body.sortOrder === "" || Number.isNaN(sortOrder)) {
        const last = await Category.findOne().sort({ sortOrder: -1 }).lean();
        sortOrder = last ? last.sortOrder + 1 : 1;
      }

      const doc = await Category.create({
        name,
        slug,
        image: fileUrl(req.file),
        isActive: toBool(req.body.isActive, true),
        sortOrder,
      });
      onChange && onChange();
      res.status(201).json({ ...doc.toObject(), productCount: 0 });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: "A category with this name or slug already exists" });
      res.status(500).json({ error: err.message });
    }
  });

  // update (any subset of fields)
  router.put("/api/admin/categories/:id", uploadImage, requireAdmin, async (req, res) => {
    try {
      await waitForDB();
      const cat = await Category.findById(req.params.id);
      if (!cat) return res.status(404).json({ error: "Category not found" });

      const oldName = cat.name;

      if (req.body.name !== undefined) {
        const n = req.body.name.trim();
        if (!n) return res.status(400).json({ error: "Category name cannot be empty" });
        cat.name = n;
      }
      if (req.body.slug !== undefined && req.body.slug !== "") {
        const s = slugify(req.body.slug);
        if (!s) return res.status(400).json({ error: "Invalid slug" });
        cat.slug = s;
      }
      if (req.body.sortOrder !== undefined && req.body.sortOrder !== "" && !Number.isNaN(Number(req.body.sortOrder))) {
        cat.sortOrder = Number(req.body.sortOrder);
      }
      if (req.body.isActive !== undefined) cat.isActive = toBool(req.body.isActive, cat.isActive);
      if (req.file) cat.image = fileUrl(req.file);

      await cat.save();

      // keep the read-only name mirror on products in sync after a rename
      if (cat.name !== oldName) {
        await Product.updateMany({ categoryId: idMatch(cat._id) }, { $set: { category: cat.name } });
      }

      onChange && onChange();
      const [withCount] = await withCounts([cat.toObject()]);
      res.json(withCount);
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: "A category with this name or slug already exists" });
      res.status(500).json({ error: err.message });
    }
  });

  // delete — blocked while products still use it
  router.delete("/api/admin/categories/:id", requireAdmin, async (req, res) => {
    try {
      await waitForDB();
      const cat = await Category.findById(req.params.id);
      if (!cat) return res.status(404).json({ error: "Category not found" });

      const inUse = await Product.countDocuments({ categoryId: idMatch(cat._id) });
      if (inUse > 0) {
        return res.status(409).json({
          error: `This category still has ${inUse} product${inUse !== 1 ? "s" : ""}. Move or delete them first, or deactivate the category instead.`,
        });
      }

      await cat.deleteOne();
      onChange && onChange();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};