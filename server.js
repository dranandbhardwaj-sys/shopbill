"use strict";
/*
  ShopBill backend: zero dependencies, Node 18+.
  Run:  node server.js   (or: npm start)

  Env (all optional):
    PORT                      default 3000
    SECRET                    token signing secret (auto-generated and stored if not set)
    DATA_DIR                  folder for db.json (default ./data)
    UPSTASH_REDIS_REST_URL    } if both set, data is stored in Upstash Redis
    UPSTASH_REDIS_REST_TOKEN  } (needed on Render free plan, where disk is wiped)
    SIGNUP_COINS (10), BILL_COINS (1), REMINDER_COST (1)
*/
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const envNum = (k, d) => (process.env[k] !== undefined && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const PORT = envNum("PORT", 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = "shopbill:db";
const SIGNUP_COINS = envNum("SIGNUP_COINS", 10);
const BILL_COINS = envNum("BILL_COINS", 1);
const REMINDER_COST = envNum("REMINDER_COST", 1);
const TOKEN_DAYS = 30;

/* ---------- storage ---------- */
let db = { secret: "", seq: 0, users: [] };
let saveTimer = null;
let saving = Promise.resolve();

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || "Redis request failed (" + r.status + ")");
  return j.result;
}
async function persist() {
  const json = JSON.stringify(db);
  if (USE_REDIS) return void (await redis(["SET", REDIS_KEY, json]));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_FILE);
}
async function loadDb() {
  let raw = null;
  if (USE_REDIS) raw = await redis(["GET", REDIS_KEY]);
  else { try { raw = fs.readFileSync(DB_FILE, "utf8"); } catch {} }
  if (raw) db = Object.assign(db, JSON.parse(raw));
  if (!db.secret) { db.secret = crypto.randomBytes(32).toString("hex"); await persist(); }
}
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(persist).catch((e) => console.error("Save failed:", e.message));
  return saving;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

/* ---------- auth helpers ---------- */
const secret = () => process.env.SECRET || db.secret;
const sign = (d) => crypto.createHmac("sha256", secret()).update(d).digest("base64url");
function makeToken(uid) {
  const p = Buffer.from(JSON.stringify({ uid, exp: Date.now() + TOKEN_DAYS * 864e5 })).toString("base64url");
  return p + "." + sign(p);
}
function readToken(t) {
  const [p, s] = String(t || "").split(".");
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, "base64url").toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
const hashPw = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
};
function checkPw(pw, rec) {
  const h = crypto.scryptSync(pw, rec.salt, 64), e = Buffer.from(rec.hash, "hex");
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) { a = { n: 0, reset: now + 15 * 60e3 }; attempts.set(ip, a); }
  return ++a.n > 20;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) if (v.reset < n) attempts.delete(k); }, 60e3).unref();

/* ---------- small utils ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10); // IST date
function text(v, max, label, required = false) {
  const s = String(v ?? "").trim();
  if (required && !s) throw bad(label + " is required");
  if (s.length > max) throw bad(label + " is too long");
  return s;
}
function amount(v, label, { min = 0, max = 1e9, positive = false } = {}) {
  const n = typeof v === "number" || typeof v === "string" ? Number(v) : NaN;
  if (v === "" || !Number.isFinite(n) || n < min || n > max || (positive && n <= 0)) throw bad(label + " is not valid");
  return n;
}
function phoneDigits(p) {
  let d = String(p || "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 15 ? d : "";
}
const coinBalance = (u) => u.coins.reduce((s, c) => s + c.coins, 0);
const meOf = (u) => ({ email: u.email, shop: { ...u.shop } });
const dataOf = (u) => ({
  products: u.products, customers: u.customers, bills: u.bills,
  payments: u.payments, coins: u.coins, coinBalance: coinBalance(u),
});

/* ---------- http helpers ---------- */
function send(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => { size += c.length; if (size > 1e6) tooBig = true; else chunks.push(c); });
    req.on("error", reject);
    req.on("end", () => {
      if (tooBig) return reject(new HttpError(413, "Request too large"));
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString());
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch { reject(bad("Invalid JSON")); }
    });
  });
}
function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const d = m && readToken(m[1]);
  const u = d && db.users.find((x) => x.id === d.uid);
  if (!u) throw new HttpError(401, "Session expired. Please login again.");
  return u;
}
const findCustomer = (u, id) => {
  const c = u.customers.find((x) => x.id === Number(id));
  if (!c) throw new HttpError(404, "Customer not found");
  return c;
};

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const key = req.method + " " + p;

  if (key === "GET /api/health") return send(res, 200, { ok: true });

  if (key === "POST /api/auth/register" || key === "POST /api/auth/login") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (tooMany(ip)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    const b = await readJson(req);
    const email = text(b.email, 120, "Email", true).toLowerCase();
    const pw = String(b.password || "");

    if (key.endsWith("login")) {
      const u = db.users.find((x) => x.email === email);
      if (!u || !checkPw(pw, u.pass)) throw new HttpError(401, "Invalid email or password");
      return send(res, 200, { token: makeToken(u.id) });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid email");
    if (pw.length < 8 || pw.length > 200) throw bad("Password must be 8 to 200 characters");
    const shopName = text(b.shopName, 80, "Shop name", true);
    const owner = text(b.ownerName, 80, "Your name");
    if (db.users.some((x) => x.email === email)) throw new HttpError(409, "This email is already registered. Please login.");
    const u = {
      id: ++db.seq, email, pass: hashPw(pw), createdAt: new Date().toISOString(),
      shop: { name: shopName, owner, phone: "", address: "", gstin: "" },
      products: [], customers: [], bills: [], payments: [], billSeq: 0,
      coins: SIGNUP_COINS > 0 ? [{ date: today(), action: "Welcome bonus", coins: SIGNUP_COINS, note: "Signup" }] : [],
    };
    db.users.push(u);
    save();
    return send(res, 201, { token: makeToken(u.id) });
  }

  const user = authUser(req);

  switch (key) {
    case "GET /api/me":
      return send(res, 200, meOf(user));

    case "GET /api/data":
      return send(res, 200, dataOf(user));

    case "PUT /api/profile": {
      const b = await readJson(req);
      const gstin = text(b.gstin, 15, "GSTIN").toUpperCase();
      if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw bad("GSTIN format is not valid");
      user.shop = {
        name: text(b.name, 80, "Shop name", true),
        owner: text(b.owner, 80, "Owner"),
        phone: text(b.phone, 20, "Phone"),
        address: text(b.address, 300, "Address"),
        gstin,
      };
      save();
      return send(res, 200, meOf(user));
    }

    case "POST /api/products": {
      const b = await readJson(req);
      const name = text(b.name, 100, "Product name", true);
      const price = amount(b.price, "Price", { max: 1e8 });
      const gst = amount(b.gst ?? 0, "GST %", { max: 100 });
      const stock = amount(b.stock ?? 0, "Stock", { max: 1e9 });
      // same name = update price/GST and add to stock (restock)
      const old = user.products.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (old) {
        Object.assign(old, { price, gst, stock: round2(old.stock + stock) });
        save();
        return send(res, 200, old);
      }
      const pr = { name, price, gst, stock, id: ++db.seq };
      user.products.push(pr);
      save();
      return send(res, 201, pr);
    }

    case "POST /api/customers": {
      const b = await readJson(req);
      const c = { id: ++db.seq, name: text(b.name, 80, "Customer name", true), phone: text(b.phone, 20, "Phone"), balance: 0 };
      user.customers.push(c);
      save();
      return send(res, 201, c);
    }

    case "POST /api/bills": {
      const b = await readJson(req);
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100)
        throw bad("Add at least one item (name,qty,price,gst%)");
      const items = b.items.map((it) => {
        const o = it || {};
        const name = text(o.name, 100, "Item name", true);
        return {
          name,
          qty: amount(o.qty, "Quantity for " + name, { positive: true, max: 1e6 }),
          price: amount(o.price, "Price for " + name, { max: 1e8 }),
          gst: amount(o.gst ?? 0, "GST % for " + name, { max: 100 }),
        };
      });
      const total = round2(items.reduce((s, i) => s + i.qty * i.price * (1 + i.gst / 100), 0));
      let paid = amount(b.paid ?? 0, "Paid amount");
      if (paid > total) paid = total;
      paid = round2(paid);
      const due = round2(total - paid);
      const cid = Number(b.customerId);
      const cust = cid ? findCustomer(user, cid) : null; // no customer = walk-in
      const bill = {
        number: "SB-" + String(++user.billSeq).padStart(4, "0"),
        customer: cust ? cust.name : "Walk-in",
        total, due, id: ++db.seq, date: today(),
        customerId: cust ? cust.id : 0, items, paid,
      };
      user.bills.push(bill);
      if (cust) cust.balance = round2(cust.balance + due);
      for (const i of items) {
        const pr = user.products.find((x) => x.name.toLowerCase() === i.name.toLowerCase());
        if (pr) pr.stock = round2(Math.max(0, pr.stock - i.qty));
      }
      if (BILL_COINS > 0) user.coins.push({ date: today(), action: "Bill saved", coins: BILL_COINS, note: bill.number });
      save();
      return send(res, 201, { number: bill.number, id: bill.id, total, due });
    }

    case "POST /api/payments": {
      const b = await readJson(req);
      const c = findCustomer(user, b.customerId);
      const amt = round2(amount(b.amount, "Amount", { positive: true }));
      if (amt > c.balance) throw bad("Amount is more than the due balance (" + c.balance.toFixed(2) + ")");
      c.balance = round2(c.balance - amt);
      user.payments.push({ id: ++db.seq, date: today(), customerId: c.id, amount: amt });
      save();
      return send(res, 201, { ok: true, balance: c.balance });
    }

    case "POST /api/reminders": {
      const b = await readJson(req);
      const c = findCustomer(user, b.customerId);
      const channel = String(b.channel || "");
      if (!["whatsapp", "call", "share"].includes(channel)) throw bad("Unknown reminder type");
      if (!(c.balance > 0)) throw bad("This customer has no due balance");
      const digits = phoneDigits(c.phone);
      if (channel !== "share" && !digits) throw bad("Add a valid phone number for this customer first");
      if (REMINDER_COST > 0 && coinBalance(user) < REMINDER_COST) throw new HttpError(402, "Not enough coins for a reminder");
      const message = `Namaste ${c.name}, ${user.shop.name} se aapka Rs ${c.balance.toFixed(2)} baaki hai. Kripya jald bhugtan karein. Dhanyavad!`;
      if (REMINDER_COST > 0)
        user.coins.push({ date: today(), action: "Reminder (" + channel + ")", coins: -REMINDER_COST, note: c.name });
      save();
      const out = { message };
      if (channel === "whatsapp") out.url = "https://wa.me/" + digits + "?text=" + encodeURIComponent(message);
      if (channel === "call") out.url = "tel:+" + digits;
      return send(res, 200, out);
    }

    case "POST /api/payments/checkout":
      throw new HttpError(501, "Payment is not enabled yet. No money was charged.");
  }

  throw new HttpError(404, "Not found");
}

/* ---------- static files ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
function notFound(res) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); }
function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
}
function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === "/" || rel === "/index.html") return sendFile(req, res, path.join(ROOT, "index.html"));
  rel = rel.replace(/^\/public(?=\/)/, "");
  const file = path.resolve(PUBLIC_DIR, "." + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  sendFile(req, res, file);
}

/* ---------- server ---------- */
async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return await api(req, res, url);
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: "Server error. Please try again." });
  }
}
async function main() {
  await loadDb();
  const server = http.createServer(handler);
  server.listen(PORT, "0.0.0.0", () =>
    console.log(`ShopBill running on port ${PORT} (storage: ${USE_REDIS ? "Upstash Redis" : "file " + DB_FILE})`));
  const stop = async () => { server.close(); await flush(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch((e) => { console.error("Startup failed:", e.message); process.exit(1); });
