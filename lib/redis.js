import { Redis } from "@upstash/redis";
import crypto from "crypto";

// Otomatis membaca KV_REST_API_URL / KV_REST_API_TOKEN (Vercel Marketplace: Upstash)
// atau UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN jika disambungkan manual.
export const redis = Redis.fromEnv();

// ============================================================
// MULTI-TENANT: setiap akun MT5 (accountLogin) punya namespace
// key Redis sendiri, supaya satu deployment bisa dipakai banyak
// customer/EA sekaligus tanpa data-nya saling tertimpa/bocor.
// ============================================================
export function keys(accountLogin) {
  const acc = String(accountLogin || "").trim();
  return {
    state: `gsp:state:${acc}`,
    command: `gsp:command:${acc}`,
    config: `gsp:config:${acc}`,
    log: `gsp:log:${acc}`,
    heartbeat: `gsp:heartbeat:${acc}`,
    eaToken: `gsp:eatoken:${acc}`, // binding accountLogin -> hash lisensi (TOFU)
    journal: `gsp:journal:${acc}`, // hash: field "YYYY-MM-DD" -> JSON entri jurnal harian
  };
}

// Set berisi semua accountLogin yang pernah terhubung — berguna untuk
// admin/monitoring (mis. menghitung jumlah customer aktif) di masa depan.
export const ACCOUNTS_SET = "gsp:accounts";

// Verifikasi token rahasia yang dikirim EA di header X-EA-Token.
// Ini adalah gerbang akses tingkat "aplikasi" (anti-abuse) yang sama untuk
// semua EA yang terhubung ke deployment ini — BUKAN pengganti isolasi
// per-customer (lihat eaToken/TOFU binding di ea-update.js untuk itu).
export function checkEAToken(req) {
  const expected = process.env.EA_SHARED_TOKEN;
  if (!expected) return true; // jika belum di-set, lewati (mode dev)
  const got = req.headers["x-ea-token"] || req.headers["X-EA-Token"];
  return got === expected;
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-EA-Token,Authorization,X-Session-Token");
}

// Hash sederhana (harus identik dengan LicenseKeyHash() di EA MQL5) —
// dipakai supaya kode lisensi asli tidak perlu disimpan plaintext di Redis,
// cukup hash-nya untuk dicocokkan saat login.
export function simpleHash(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) % 999999937;
  }
  return String(hash);
}

// ============================================================
// SESSION TOKEN (browser) — supaya setelah login, browser hanya bisa
// membaca/mengirim perintah untuk AKUN MILIKNYA SENDIRI. Tanpa ini,
// siapa pun yang tahu nomor akun MT5 customer lain bisa memoll data
// atau mengirim CLOSEALL ke akun tersebut tanpa perlu tahu password.
// ============================================================
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam

function sessionSecret() {
  // Idealnya SESSION_SECRET diisi terpisah dari EA_SHARED_TOKEN di Vercel.
  return process.env.SESSION_SECRET || process.env.EA_SHARED_TOKEN || "gsp-dev-secret-GANTI-INI";
}

export function createSessionToken(accountLogin) {
  const acc = String(accountLogin);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${acc}.${exp}`;
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifySessionToken(token, accountLogin) {
  try {
    const decoded = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 3) return false;
    const [acc, expStr, sig] = parts;
    if (!acc || !expStr || !sig) return false;
    if (String(accountLogin) !== acc) return false;
    const exp = Number(expStr);
    if (!exp || Date.now() > exp) return false;

    const expectedSig = crypto.createHmac("sha256", sessionSecret()).update(`${acc}.${exp}`).digest("hex");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function getSessionFromReq(req) {
  const header = req.headers["authorization"] || req.headers["Authorization"] || "";
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return req.headers["x-session-token"] || req.headers["X-Session-Token"] || "";
}

// Tanggal hari ini dalam zona waktu WIB (Asia/Jakarta), format "YYYY-MM-DD".
// Dipakai sebagai key harian jurnal supaya konsisten dengan jam WIB yang
// ditampilkan di dashboard, terlepas dari timezone server Vercel.
export function todayDateKeyWIB() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}
