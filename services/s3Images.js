// backend/services/s3Images.js
// Product / category images in a PRIVATE S3 bucket.
//
//   • MongoDB stores only the stable object key, e.g.
//       mana-vastralu/products/2026/10/3f6c…-….jpg
//   • API responses replace those keys with temporary presigned GET URLs.
//   • Existing values (Cloudinary URLs, "uploads/…" paths, "/images/…") are
//     returned exactly as before.
//   • Presigned URLs that come back from the browser (cart, order, admin edits)
//     are turned back into keys before anything is saved, so no expiring URL is
//     ever written to MongoDB.
//   • Only keys created by this app (fixed prefix + products|categories +
//     date + random UUID + image extension) are ever signed — a client cannot
//     make the server sign an arbitrary object.
//
// The S3 client and AWS SDK commands are passed in from server.js.
const crypto = require("crypto");

const EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_EXPIRES = 7 * 24 * 3600;     // SigV4 limit

// Check the real file bytes, not just the browser-supplied type.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function createS3Images({
  s3, bucket, region, PutObjectCommand, GetObjectCommand, getSignedUrl,
  prefix = "mana-vastralu",
  expiresIn = 3600,
  now = () => Date.now(),
  log = console,
}) {
  const exp = Math.min(Math.max(Number(expiresIn) || 3600, 60), MAX_EXPIRES);
  const pfx = String(prefix || "").replace(/^\/+|\/+$/g, "");
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const KEY_RE = new RegExp(`^${pfx ? esc(pfx) + "/" : ""}(products|categories)/\\d{4}/\\d{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`);
  const configured = () => !!(s3 && bucket && region);

  const isOwnKey = (v) => typeof v === "string" && KEY_RE.test(v);

  // "empty" | "s3" | "cloudinary" | "url" | "local" | "other"
  function classify(v) {
    if (v == null || v === "") return "empty";
    if (typeof v !== "string") return "other";
    if (isOwnKey(v)) return "s3";
    if (/^https?:\/\/res\.cloudinary\.com\//i.test(v)) return "cloudinary";
    if (/^https?:\/\//i.test(v)) return "url";
    if (/^\/?(uploads|images)\//i.test(v)) return "local";
    return "other";
  }

  function newKey(kind, mimetype) {
    if (!["products", "categories"].includes(kind)) throw new Error("bad image kind");
    const d = new Date(now());
    const ext = EXT[String(mimetype).toLowerCase()] || "jpg";
    return `${pfx ? pfx + "/" : ""}${kind}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  }

  // Upload one image buffer. Returns the S3 key (what MongoDB stores).
  async function putImage({ buffer, mimetype, kind }) {
    if (!configured()) throw Object.assign(new Error("Image storage is not configured (S3_BUCKET_NAME / AWS_REGION)"), { status: 500 });
    const real = sniffImage(buffer);
    if (!real || !EXT[String(mimetype).toLowerCase()]) throw Object.assign(new Error("Only JPG, JPEG, PNG and WebP images are allowed"), { status: 400 });
    const key = newKey(kind, real);
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: real,
        ServerSideEncryption: "AES256",
        CacheControl: "private, max-age=31536000, immutable",
      }));
    } catch (e) {
      // never include credentials / signed URLs in messages
      log.error?.(`S3 upload failed (${e.name || "error"}): ${e.message}`);
      throw Object.assign(new Error(`Could not store the image (${e.name || "S3 error"})`), { status: 502 });
    }
    return key;
  }

  // Presigned URLs are signed for a fixed time window, so the same image keeps
  // the same URL for a while (browser cache works) and is always valid for at
  // least half of `expiresIn` after it is handed out.
  const windowMs = Math.floor(exp / 2) * 1000;
  const cache = new Map();                   // key -> { start, url }
  async function signKey(key, { expires = exp } = {}) {
    const start = Math.floor(now() / windowMs) * windowMs;
    const useCache = expires === exp;
    const hit = useCache && cache.get(key);
    if (hit && hit.start === start) return hit.url;
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: Math.min(expires, MAX_EXPIRES), signingDate: new Date(start) });
    if (useCache) { if (cache.size > 5000) cache.clear(); cache.set(key, { start, url }); }
    return url;
  }
  // how long an API response holding signed URLs may be reused
  const maxResponseAgeMs = () => windowMs - 60 * 1000;

  // Any stored value → what the browser should get. Non-S3 values unchanged.
  async function toDisplay(v, opts) {
    if (!isOwnKey(v) || !configured()) return v;
    try { return await signKey(v, opts); } catch (e) { log.error?.("Could not sign image URL:", e.message); return v; }
  }

  // A value coming FROM the browser → what may be stored. Turns a presigned (or
  // plain) URL of our own bucket back into its key; everything else unchanged.
  function toStorable(v) {
    if (typeof v !== "string" || !/^https:\/\//i.test(v) || !bucket) return v;
    let u; try { u = new URL(v); } catch { return v; }
    const host = u.hostname.toLowerCase();
    const b = bucket.toLowerCase();
    let key = null;
    const path = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    if (host === `${b}.s3.${region}.amazonaws.com` || host === `${b}.s3.amazonaws.com`) key = path;
    else if (host === `s3.${region}.amazonaws.com` || host === "s3.amazonaws.com") key = path.startsWith(b + "/") ? path.slice(b.length + 1) : null;
    return key && isOwnKey(key) ? key : v;
  }

  // Deep copy of a request body with every own-bucket URL turned back into a key.
  function sanitizeDeep(x) {
    if (typeof x === "string") return toStorable(x);
    if (Array.isArray(x)) return x.map(sanitizeDeep);
    if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
      const o = {}; for (const [k, v] of Object.entries(x)) o[k] = sanitizeDeep(v); return o;
    }
    return x;
  }

  // ── response helpers (keep every field; only image strings change) ──────
  const plain = (d) => (d && typeof d.toObject === "function" ? d.toObject() : d);
  async function signProduct(p, opts) {
    p = plain(p); if (!p) return p;
    const out = { ...p };
    if (Array.isArray(p.images)) out.images = await Promise.all(p.images.map((i) => toDisplay(i, opts)));
    if (Array.isArray(p.colorVariants)) out.colorVariants = await Promise.all(p.colorVariants.map(async (v) => (v && typeof v === "object" ? { ...plain(v), image: await toDisplay(v.image, opts) } : v)));
    if (typeof p.image === "string") out.image = await toDisplay(p.image, opts);
    return out;
  }
  async function signCategory(c, opts) {
    c = plain(c); if (!c) return c;
    return typeof c.image === "string" ? { ...c, image: await toDisplay(c.image, opts) } : { ...c };
  }
  async function signOrder(o, opts) {
    o = plain(o); if (!o) return o;
    const out = { ...o };
    for (const f of ["products", "items"]) if (Array.isArray(o[f])) out[f] = await Promise.all(o[f].map((it) => signProduct(it, opts)));
    return out;
  }
  const signAll = (list, fn, opts) => Promise.all((list || []).map((x) => fn(x, opts)));

  return { configured, classify, isOwnKey, newKey, putImage, signKey, toDisplay, toStorable, sanitizeDeep,
    signProduct, signCategory, signOrder, signAll, maxResponseAgeMs, expiresIn: exp };
}

// ── Multer-compatible upload object ───────────────────────────────────────
// Behaves like `multer({ storage })` for the two methods the app uses:
//   upload.single("image")   upload.fields([{ name, maxCount }, …])
// Files are parsed into memory (never written to disk), checked, and sent to S3
// ONLY if the request carries the admin password. Afterwards each file has
//   file.path === file.key === "<S3 key>"
// so existing route code (`f.path`) keeps working unchanged.
function createS3Upload({ multer, images, kindFor, isAuthorized, maxFileBytes = 10 * 1024 * 1024, maxFiles = 24, log = console }) {
  const mem = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileBytes, files: maxFiles },
    fileFilter: (req, file, cb) => {
      if (EXT[String(file.mimetype).toLowerCase()]) return cb(null, true);
      cb(Object.assign(new Error("Only JPG, JPEG, PNG and WebP images are allowed"), { status: 400 }));
    },
  });
  const status = (e) => (e && e.code === "LIMIT_FILE_SIZE" ? Object.assign(e, { status: 413, message: `Image is larger than ${Math.round(maxFileBytes / 1048576)} MB` })
    : e && /^LIMIT_/.test(e.code || "") ? Object.assign(e, { status: 400 }) : e);

  const after = (req, next) => async (err) => {
    if (err) return next(status(err));
    const files = req.file ? [req.file] : Object.values(req.files || {}).flat();
    if (!files.length) return next();
    if (!isAuthorized(req)) {
      req.file = undefined; req.files = {};
      return next(Object.assign(new Error("Unauthorized: admin password required to upload images"), { status: 401 }));
    }
    try {
      const kind = kindFor(req);
      for (const f of files) {
        const key = await images.putImage({ buffer: f.buffer, mimetype: f.mimetype, kind });
        f.key = key; f.path = key; f.filename = key; f.provider = "s3";
        f.buffer = undefined;                         // free memory
      }
      next();
    } catch (e) { next(e); }
  };
  return {
    single: (name) => (req, res, next) => mem.single(name)(req, res, after(req, next)),
    fields: (spec) => (req, res, next) => mem.fields(spec)(req, res, after(req, next)),
  };
}

module.exports = { createS3Images, createS3Upload, sniffImage };