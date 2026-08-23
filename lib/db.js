import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ============================================================
// Koneksi Supabase — pakai SERVICE ROLE KEY karena ini dipanggil dari
// serverless function (server-side di Vercel), BUKAN dari browser.
// Service role key bypass Row Level Security, jadi jangan pernah
// dikirim/dipakai di public/index.html.
//
// Env var yang wajib diisi di Vercel:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ============================================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di environment variables.");
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// Verifikasi token rahasia yang dikirim EA di header X-EA-Token.
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

// Hash sederhana (harus identik dengan LicenseKeyHash() di EA MQL5).
export function simpleHash(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) % 999999937;
  }
  return String(hash);
}

// ============================================================
// GENERATE KODE LISENSI EA — versi web dari script MQL5
// LicenseKeyGenerator.mq5. Algoritma checksum HARUS IDENTIK
// dengan LicenseChecksum() di file EA (Expert_Advisor_Golden_
// Scalper_Cent.mq5), atau kode yang dibuat di sini akan
// DITOLAK oleh EA (checksum mismatch).
//
// Format key: BLOK1-BLOK2-BLOK3-AKUN-YYYYMMDD-CHK
//   BLOK1/2/3 : 4 karakter acak [A-Z0-9]
//   AKUN      : nomor akun MT5 tujuan (terikat, tidak bisa dipakai di akun lain)
//   YYYYMMDD  : tanggal kedaluwarsa
//   CHK       : checksum 3 digit, dihitung dari semua bagian di atas + magic number
// ============================================================

// Checksum — replika PERSIS dari LicenseChecksum() di MQL5.
// Aman pakai Number JS biasa: MQL5 `int` di sini selalu di-mod 9973
// tiap iterasi, jadi nilai maksimum jauh di bawah batas presisi float64.
export function licenseChecksum(block1, block2, block3, accountStr, dateStr, magicNumber) {
  const raw = String(block1) + String(block2) + String(block3) + String(accountStr) + String(dateStr) + String(magicNumber);
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    sum = (sum * 31 + raw.charCodeAt(i)) % 9973;
  }
  return sum % 1000;
}

function randomBlock(len = 4) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

// Generate satu kode lisensi baru terikat ke satu Akun ID MT5.
// magicNumber HARUS sama dengan InpMagicNumberDefault / g_cfgMagicNumber
// yang dipakai di EA target, atau EA akan menolak kode ini.
export function generateLicenseKey(accountLogin, validDays, magicNumber = 88888) {
  const accountStr = String(accountLogin).trim();
  const block1 = randomBlock(4);
  const block2 = randomBlock(4);
  const block3 = randomBlock(4);

  const expiryMs = Date.now() + Number(validDays) * 86400000;
  const expiry = new Date(expiryMs);
  const yyyy = expiry.getUTCFullYear();
  const mm = String(expiry.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(expiry.getUTCDate()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}`;

  const chk = licenseChecksum(block1, block2, block3, accountStr, dateStr, magicNumber);
  const chkStr = String(chk).padStart(3, "0");

  const key = `${block1}-${block2}-${block3}-${accountStr}-${dateStr}-${chkStr}`;
  return { key, expiryDate: dateStr, expiresAt: expiry.toISOString() };
}

// ============================================================
// SESSION TOKEN (browser) — sama persis logikanya seperti versi Redis,
// tidak tergantung database sama sekali (HMAC stateless).
// ============================================================
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 jam

function sessionSecret() {
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

// ============================================================
// SESSION TOKEN untuk AKUN WEB (Gmail+password) — mirip
// createSessionToken di atas, tapi payload-nya email+role+accountLogin
// supaya endpoint admin (admin-users.js) bisa memverifikasi role tanpa
// query DB tambahan tiap request.
// ============================================================
export function createWebSessionToken({ email, role, accountLogin }) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = JSON.stringify({ email, role, accountLogin: accountLogin || null, exp });
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
  return Buffer.from(`${payload}::${sig}`).toString("base64url");
}

export function verifyWebSessionToken(token) {
  try {
    const decoded = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const idx = decoded.lastIndexOf("::");
    if (idx === -1) return null;
    const payloadStr = decoded.slice(0, idx);
    const sig = decoded.slice(idx + 2);
    const expectedSig = crypto.createHmac("sha256", sessionSecret()).update(payloadStr).digest("hex");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(payloadStr);
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload; // { email, role, accountLogin, exp }
  } catch {
    return null;
  }
}

export function getSessionFromReq(req) {
  const header = req.headers["authorization"] || req.headers["Authorization"] || "";
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7).trim();
  return req.headers["x-session-token"] || req.headers["X-Session-Token"] || "";
}

// Tanggal hari ini dalam zona waktu WIB (Asia/Jakarta), format "YYYY-MM-DD".
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

// ============================================================
// Helper query akun — dipakai berulang-ulang di berbagai endpoint.
// ============================================================

// Ambil satu baris akun (atau null jika belum pernah terhubung).
export async function getAccount(accountLogin) {
  const { data, error } = await supabase
    .from("accounts")
    .select("*")
    .eq("account_login", accountLogin)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Upsert snapshot state dari EA (dipakai di ea-update.js).
export async function upsertAccountState(accountLogin, patch) {
  const { error } = await supabase
    .from("accounts")
    .upsert(
      { account_login: accountLogin, ...patch },
      { onConflict: "account_login" }
    );
  if (error) throw error;
}

// Cek online: last_seen_at < 20 detik yang lalu.
export function isOnline(lastSeenAt) {
  if (!lastSeenAt) return false;
  const lastSeenMs = new Date(lastSeenAt).getTime();
  return lastSeenMs > 0 && (Date.now() - lastSeenMs) < 20000;
}

// Tambah entri log dan otomatis buang entri lama (simpan 30 terakhir/akun).
export async function pushLogEntries(accountLogin, entries) {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    account_login: accountLogin,
    text: e.text,
    type: e.type,
  }));
  const { error } = await supabase.from("ea_logs").insert(rows);
  if (error) throw error;

  try {
    const { data: keep } = await supabase
      .from("ea_logs")
      .select("id")
      .eq("account_login", accountLogin)
      .order("created_at", { ascending: false })
      .limit(30);
    if (keep && keep.length === 30) {
      const minId = keep[keep.length - 1].id;
      await supabase
        .from("ea_logs")
        .delete()
        .eq("account_login", accountLogin)
        .lt("id", minId);
    }
  } catch { /* pembersihan log bersifat pelengkap, jangan gagalkan request utama */ }
}

// ============================================================
// Helper query akun WEB (Gmail + password) — tabel `web_users`.
// Terpisah dari `accounts` (data EA/MT5). Dipakai oleh
// auth-register.js, auth-login.js, dan admin-users.js.
// ============================================================

export async function getWebUserByEmail(email) {
  const { data, error } = await supabase
    .from("web_users")
    .select("*")
    .eq("email", String(email).toLowerCase().trim())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createWebUser({ email, passwordHash, accountLogin, role = "user", status = "pending" }) {
  const { data, error } = await supabase
    .from("web_users")
    .insert({
      email: String(email).toLowerCase().trim(),
      password_hash: passwordHash,
      account_login: accountLogin || null,
      role,
      status,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listWebUsers() {
  const { data, error } = await supabase
    .from("web_users")
    .select("id,email,account_login,role,status,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function updateWebUser(id, patch) {
  const { data, error } = await supabase
    .from("web_users")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getWebUserById(id) {
  const { data, error } = await supabase
    .from("web_users")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Ambil N log terbaru untuk satu akun (menggantikan LRANGE 0..14).
export async function getRecentLogs(accountLogin, limit = 15) {
  const { data, error } = await supabase
    .from("ea_logs")
    .select("text,type,created_at")
    .eq("account_login", accountLogin)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((r) => ({
    text: r.text,
    type: r.type,
    time: new Date(r.created_at).getTime(),
  }));
}
