import { redis, keys, checkEAToken, setCors, verifySessionToken, getSessionFromReq } from "../lib/redis.js";

// GET  -> dipanggil EA (per akun, ?account=<accountLogin>) untuk mengambil
//         konfigurasi terbaru yang diset lewat web panel. Diautentikasi
//         dengan X-EA-Token.
// POST -> dipanggil dari web saat operator menekan "Simpan Perubahan" di
//         salah satu grup setting. Diautentikasi dengan sessionToken hasil
//         login supaya hanya pemilik akun yang bisa mengubah konfigurasi
//         akun tersebut.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    if (!checkEAToken(req)) return res.status(401).json({ ok: false, error: "Invalid EA token" });
    const account = String(req.query.account || "").trim();
    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

    const K = keys(account);
    const cfg = await redis.get(K.config);
    return res.status(200).json({ ok: true, config: cfg || null });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const account = String(body.account || "").trim();
    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    const K = keys(account);
    // body diharapkan berisi seluruh objek `state` dari web (semua field SCHEMA)
    await redis.set(K.config, JSON.stringify(body));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
