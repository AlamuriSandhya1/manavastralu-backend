// backend/scripts/seedCategories.js
//
//   node scripts/seedCategories.js            → DRY RUN (changes nothing, prints the plan)
//   node scripts/seedCategories.js --apply    → creates categories + sets product.categoryId
//
// Safe to run more than once: existing categories are kept as they are, and
// only products that don't have a categoryId yet are touched.
require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");

const APPLY = process.argv.includes("--apply");

const slugify = (s = "") =>
  String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// lower-case, strip symbols, treat "chollar" as "collar"
const norm = (s) => String(s || "").toLowerCase().replace(/chollar/g, "collar").replace(/[^a-z0-9]+/g, " ").trim();

// All of these are independent MAIN categories. `type: true` just means
// "blouse style", used only to place EXISTING products during migration.
const DEFS = [
  { name: "1 Minute Saree",                         image: "/images/categories/oneminsaree.jpeg",            aliases: ["lehangas", "lehanga"] },
  { name: "Ajrak Sarees",                           image: "/images/categories/ajrak-sarees.jpeg" },
  { name: "Mul Cotton",                             image: "/images/categories/mul-cotton.jpeg" },
  { name: "Kalamkari Stretchable Blouses",          image: "/images/categories/kalamakari-blouses1.jpeg",    aliases: ["kalamakari blouses", "kalamkari blouses", "blouses"] },
  { name: "Full Sleeves – Front Hook",              type: true },
  { name: "Full Sleeves – Without Hook",            type: true },
  { name: "Round Neck – Front Hook",                type: true },
  { name: "Round Neck – Front Hook – Plus Size",    type: true },
  { name: "Round Neck – Without Hook",              type: true },
  { name: "Puff Sleeves – Front Hook",              type: true },
  { name: "Collar Neck – Front Button",             type: true },
  { name: "Plain Collar Neck – Front Button",       type: true },
  { name: "DTF Print – Without Hook",               type: true },
].map((d, i) => ({ ...d, slug: slugify(d.name), sortOrder: i + 1, image: d.image || "" }));

const PARENT = DEFS.find((d) => d.name === "Kalamkari Stretchable Blouses");

// longest label first so "Plain Collar Neck…" wins over "Collar Neck…"
const TYPES = DEFS.filter((d) => d.type)
  .map((d) => ({ ...d, match: norm(d.name) }))
  .sort((a, b) => b.match.length - a.match.length);

const byLegacy = new Map();
DEFS.forEach((d) => {
  byLegacy.set(norm(d.name), d);
  (d.aliases || []).forEach((a) => byLegacy.set(norm(a), d));
});

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  console.log(APPLY ? "== APPLY MODE ==" : "== DRY RUN (nothing will be changed) ==");

  const products = await Product.find({ $or: [{ categoryId: { $exists: false } }, { categoryId: null }] }).lean();
  console.log(`Products without a categoryId: ${products.length}`);

  const plan = new Map(); // slug -> [product ids]
  const unassigned = [];

  for (const p of products) {
    let target = byLegacy.get(norm(p.category)) || null;

    // blouses (or products with no category) get placed into their blouse-style category by name
    if (!target || target === PARENT) {
      const hit = TYPES.find((t) => norm(p.name).includes(t.match));
      if (hit) target = hit;
    }

    if (!target) { unassigned.push(p.name); continue; }
    if (!plan.has(target.slug)) plan.set(target.slug, []);
    plan.get(target.slug).push(p._id);
  }

  console.log("\nPlanned assignment:");
  DEFS.forEach((d) => console.log(`  ${d.name.padEnd(40)} ${(plan.get(d.slug) || []).length}`));
  console.log(`  ${"(no match — left without a category)".padEnd(40)} ${unassigned.length}`);
  if (unassigned.length) console.log("  e.g.", unassigned.slice(0, 5));

  if (!APPLY) {
    console.log("\nRe-run with --apply to make these changes.");
    return mongoose.disconnect();
  }

  // 1) create categories that don't exist yet (existing ones are left alone)
  const idBySlug = new Map();
  for (const d of DEFS) {
    const doc = await Category.findOneAndUpdate(
      { slug: d.slug },
      { $setOnInsert: { name: d.name, slug: d.slug, image: d.image, isActive: true, sortOrder: d.sortOrder } },
      { upsert: true, new: true }
    );
    idBySlug.set(d.slug, doc);
  }

  // 2) point products at their category
  const ops = [];
  for (const [slug, ids] of plan) {
    const cat = idBySlug.get(slug);
    ops.push({ updateMany: { filter: { _id: { $in: ids } }, update: { $set: { categoryId: cat._id, category: cat.name } } } });
  }
  if (ops.length) await Product.bulkWrite(ops);

  console.log("\nDone. Categories and product assignments saved.");
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });