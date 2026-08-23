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
// Menggantikan pola redis.get(K.state) / redis.set(K.state, ...) dkk.
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

// Tambah entri log (menggantikan LPUSH + LTRIM 30) dan otomatis buang
// entri lama supaya tabel tidak membengkak (simpan 30 entri terakhir/akun).
export async function pushLogEntries(accountLogin, entries) {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    account_login: accountLogin,
    text: e.text,
    type: e.type,
  }));
  const { error } = await supabase.from("ea_logs").insert(rows);
  if (error) throw error;

  // Buang entri lama di luar 30 terakhir (best-effort, tidak fatal jika gagal).
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
