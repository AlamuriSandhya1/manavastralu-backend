// node --test test/server-images.test.js
// Loads the REAL server.js and routes/categories.js with stand-ins for Express,
// MongoDB models, AWS and the other services, then calls the real route
// handlers. Checks: uploads store S3 keys, responses carry presigned URLs,
// Cloudinary/local values pass through, signed URLs are never saved.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const KEY1 = "mana-vastralu/products/2026/10/3f6c2b1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f.jpg";
const KEY2 = "mana-vastralu/products/2026/10/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.webp";
const CAT  = "mana-vastralu/categories/2026/10/11111111-2222-4333-8444-555555555555.png";
const CLOUD = "https://res.cloudinary.com/dmanav/image/upload/v1/mana-vastralu/old.jpg";
const SIGNED = /^https:\/\/mana-vastralu-product-images\.s3\.ap-southeast-2\.amazonaws\.com\/mana-vastralu\/.+X-Amz-Signature=/;

const db = { products: [], categories: [], orders: [], created: [], saved: [], emitted: [] };
let app;

// ── stand-ins ──────────────────────────────────────────────────────────────
const mw = () => (req, res, next) => next && next();
function makeRouter() { const r = { __router: true, routes: [] }; for (const m of ["get", "post", "put", "delete"]) r[m] = (p, ...h) => r.routes.push({ m, p, h }); return r; }
function fakeExpress() { const a = makeRouter(); a.use = (...x) => { for (const r of x) if (r && r.__router) a.routes.push(...r.routes); }; a.listen = () => ({}); return a; }
fakeExpress.json = mw; fakeExpress.static = mw; fakeExpress.Router = makeRouter;

// mimics a Mongoose query: chainable, `.lean()` → plain objects, otherwise documents
const chain = (getList) => { let isLean = false; const c = { sort: () => c, select: () => c, limit: () => c, lean: () => { isLean = true; return c; },
  then: (ok, ko) => Promise.resolve(isLean ? JSON.parse(JSON.stringify(getList())) : getList().map(docOf)).then(ok, ko) }; return c; };
const docOf = (o) => ({ ...JSON.parse(JSON.stringify(o)), toObject() { const { toObject, save, markModified, ...rest } = this; return JSON.parse(JSON.stringify(rest)); } });
const Product = {
  find: () => chain(() => db.products),
  findById: (id) => { const p = db.products.find((x) => x._id === id); const d = p ? docOf(p) : null;
    if (d) { d.markModified = () => {}; d.save = async function () { const { toObject, save, markModified, ...rest } = this; db.saved.push(JSON.parse(JSON.stringify(rest))); return docOf(rest); }; }
    return { lean: async () => (p ? JSON.parse(JSON.stringify(p)) : null), then: (ok, ko) => Promise.resolve(d).then(ok, ko) }; },
  create: async (data) => { db.created.push(JSON.parse(JSON.stringify(data))); return docOf({ _id: "new1", ...data }); },
  aggregate: async () => [], updateMany: async () => ({}), countDocuments: async () => 0,
  collection: { createIndex: async () => {} },
};
const Category = {
  find: () => chain(() => db.categories),
  findOne: () => ({ sort: () => ({ lean: async () => null }), lean: async () => JSON.parse(JSON.stringify(db.categories[0] || null)) }),
  findById: async () => null, create: async (d) => docOf({ _id: "c9", ...d }),
};
const Order = { find: () => chain(() => db.orders), collection: { updateMany: async () => ({}), createIndex: async () => {}, countDocuments: async () => 0 } };
const anyModel = { collection: { indexes: async () => [], createIndex: async () => {} } };

class S3Client { async send() { return {}; } }
class PutObjectCommand { constructor(i) { this.input = i; } }
class GetObjectCommand { constructor(i) { this.input = i; } }
const getSignedUrl = async (c, cmd, { expiresIn, signingDate }) =>
  `https://${cmd.input.Bucket}.s3.ap-southeast-2.amazonaws.com/${cmd.input.Key}?X-Amz-Date=${signingDate.toISOString()}&X-Amz-Expires=${expiresIn}&X-Amz-Signature=abc`;
const fakeMulter = () => ({ fields: () => mw(), single: () => mw() }); fakeMulter.memoryStorage = () => ({});

const stubs = {
  dotenv: { config() {} }, express: fakeExpress, cors: () => mw(), compression: () => mw(), multer: fakeMulter,
  bcryptjs: {}, axios: {}, razorpay: class { constructor() { this.orders = {}; this.payments = {}; } },
  http: { createServer: () => ({ listen() {} }), get: () => ({ on() {} }) }, https: { get: () => ({ on() {} }) },
  cloudinary: { v2: { config() {} } }, "multer-storage-cloudinary": { CloudinaryStorage: class {} },
  "@aws-sdk/client-s3": { S3Client, PutObjectCommand, GetObjectCommand }, "@aws-sdk/s3-request-presigner": { getSignedUrl },
  mongoose: { connect: async () => {}, connection: { readyState: 1, name: "test", on() {}, db: { collection: () => ({}) } },
    isValidObjectId: () => true, Types: { ObjectId: function (x) { return x; } } },
  "./socket": { initSocket() {}, emitStockUpdate: (p) => db.emitted.push(p) },
  "./whatsappNotify": { notifyAdminWhatsApp() {} }, "./emailService": {},
  "./models/Product": Product, "./models/Category": Category, "../models/Category": Category, "./models/Order": Order,
  "./models/PendingCheckout": anyModel, "./models/User": anyModel, "./models/PaymentAlert": anyModel, "./models/PaymentEvent": anyModel,
  "./middleware/syncProductCategory": (req, res, next) => next(),
  "./services/paymentOrders": Object.assign(() => ({ reconcile: async () => ({ rows: [] }), alert: async () => {} }), { withRetry: async (fn) => fn() }),
  "./services/mongoStore": () => ({}), "./services/alertEmail": () => async () => {},
  "./services/orderRoutes": () => ({ addOrder: async (b) => ({ status: 201, json: { body: b } }), confirm: async (b) => ({ status: 200, json: { body: b } }) }),
};

before(() => {
  Object.assign(process.env, { S3_BUCKET_NAME: "mana-vastralu-product-images", AWS_REGION: "ap-southeast-2", ADMIN_PASS: "pw", IMAGE_STORAGE: "s3" });
  delete process.env.BACKEND_URL;
  const origLoad = Module._load, st = global.setTimeout, si = global.setInterval, log = console.log, warn = console.warn;
  Module._load = function (req, parent, ...r) { return Object.prototype.hasOwnProperty.call(stubs, req) ? stubs[req] : origLoad.call(this, req, parent, ...r); };
  global.setTimeout = (...a) => { const t = st(...a); t.unref?.(); return t; };
  global.setInterval = (...a) => { const t = si(...a); t.unref?.(); return t; };
  console.log = () => {}; console.warn = () => {};
  let captured;
  const origCreate = fakeExpress; stubs.express = Object.assign(() => (captured = origCreate()), origCreate);
  try {
    for (const f of ["../server.js", "../routes/categories.js"]) delete require.cache[path.join(__dirname, f)];
    require("../server.js");
  } finally { Module._load = origLoad; global.setTimeout = st; global.setInterval = si; console.log = log; console.warn = warn; }
  app = captured;
});

const route = (m, p) => { const r = app.routes.find((x) => x.m === m && x.p === p); assert.ok(r, `${m.toUpperCase()} ${p} exists`); return r; };
async function call(m, p, req = {}, { skipFirst = 0 } = {}) {
  const r = route(m, p);
  const res = { code: 200, body: undefined, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    set() { return this; }, type() { return this; }, send(b) { this.body = typeof b === "string" ? JSON.parse(b) : b; return this; }, setHeader() {} };
  const full = { query: {}, params: {}, body: {}, headers: {}, originalUrl: p, ...req };
  let i = skipFirst;
  const next = async (e) => { if (e) throw e; const h = r.h[i++]; if (h) await h(full, res, next); };
  await next();
  return res;
}

// ── tests ──────────────────────────────────────────────────────────────────
test("POST /api/products (the failing route): no crash; MongoDB gets S3 keys; response gets presigned URLs", async () => {
  db.created.length = 0;
  const res = await call("post", "/api/products", {
    body: { name: "RED blouse", price: "300", stock: "1", colorVariants: JSON.stringify([{ name: "Red", stock: 1 }, { name: "Black", stock: 1 }]) },
    files: { images: [{ path: KEY1 }, { path: KEY2 }], variantImages: [{ path: KEY2 }] },
  }, { skipFirst: 1 });                                            // skip the multer step; files are already "uploaded"
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const saved = db.created[0];
  assert.deepEqual(saved.images, [KEY1, KEY2], "MongoDB stores keys");
  assert.deepEqual(saved.colorVariants.map((v) => v.image), [KEY2, KEY1], "variant images: own file, else first product image");
  assert.ok(!JSON.stringify(saved).includes("X-Amz-Signature"), "no signed URL saved");
  assert.equal(saved.price, 300); assert.equal(saved.stock, 1);
  assert.match(res.body.images[0], SIGNED); assert.match(res.body.colorVariants[0].image, SIGNED);
});

test("GET /api/products, /api/products/:id, /api/admin/products, /api/storefront: S3 → signed; Cloudinary/local unchanged", async () => {
  db.products = [
    { _id: "p1", name: "RED blouse", price: 300, stock: 1, images: [KEY1], colorVariants: [{ name: "Red", stock: 1, image: KEY1 }] },
    { _id: "p2", name: "Kadhi Cotton", price: 650, stock: 0, soldOut: true, images: [CLOUD], colorVariants: [] },
    { _id: "p3", name: "Old", price: 100, stock: 5, images: ["uploads/x.jpg"], colorVariants: [] },
  ];
  db.categories = [{ _id: "c1", name: "Silk", slug: "silk", image: CAT, isActive: true, sortOrder: 1 }];
  const check = (list) => {
    const byId = Object.fromEntries(list.map((p) => [p._id, p]));
    assert.match(byId.p1.images[0], SIGNED); assert.match(byId.p1.colorVariants[0].image, SIGNED);
    assert.equal(byId.p2.images[0], CLOUD); assert.equal(byId.p3.images[0], "uploads/x.jpg");
    assert.equal(byId.p2.availability ?? "sold_out", "sold_out");
  };
  check((await call("get", "/api/products", { query: { view: "card" } })).body);
  check((await call("get", "/api/admin/products", { query: { password: "pw" } })).body);
  const one = await call("get", "/api/products/:id", { params: { id: "p1" } });
  assert.match(one.body.images[0], SIGNED); assert.equal(one.body.availability, "low_stock");
  const sf = await call("get", "/api/storefront");
  check(sf.body.products); assert.match(sf.body.categories[0].image, SIGNED);
});

test("category endpoints (real routes/categories.js through server.js) return signed images", async () => {
  const r = await call("get", "/api/categories");
  assert.match(r.body[0].image, SIGNED); assert.equal(r.body[0].category, "Silk");
});

test("PUT /api/products/:id: a signed URL sent back by the admin is saved as the KEY", async () => {
  db.saved.length = 0;
  const signed = (await call("get", "/api/products/:id", { params: { id: "p1" } })).body.colorVariants[0].image;
  const res = await call("put", "/api/products/:id", { params: { id: "p1" }, body: { name: "RED blouse", price: 300, stock: 1, colorVariants: [{ name: "Red", stock: 1, image: signed }] } }, { skipFirst: 1 });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(db.saved[0].colorVariants[0].image, KEY1);
  assert.match(res.body.colorVariants[0].image, SIGNED);
});

test("orders: signed URLs in the cart are stored as keys", async () => {
  const signed = (await call("get", "/api/products/:id", { params: { id: "p1" } })).body.images[0];
  const r = await call("post", "/add-order", { body: { email: "c@x.in", products: [{ name: "RED blouse", image: signed }] } });
  assert.equal(r.body.body.products[0].image, KEY1);
});

test("live stock updates carry signed URLs", async () => {
  db.emitted.length = 0;
  await call("post", "/api/products", { body: { name: "X", price: "1" }, files: { images: [{ path: KEY1 }] } }, { skipFirst: 1 });
  await new Promise((r) => setTimeout(r, 10));
  assert.match(db.emitted[0].images[0], SIGNED);
});