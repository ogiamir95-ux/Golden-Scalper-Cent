import { redis, keys, checkEAToken, setCors, verifySessionToken, getSessionFromReq } from "../lib/redis.js";

const ALLOWED = ["START", "STOP", "CLOSEALL", "RESET", "NONE"];

// GET  -> dipanggil EA (per akun, ?account=<accountLogin>) untuk mengambil
//         perintah tertunda (lalu otomatis dihapus/di-ack). Diautentikasi
//         dengan X-EA-Token (sama seperti ea-update).
// POST -> dipanggil dari web (tombol Start/Stop/Close All/Reset) untuk
//         menitipkan perintah baru bagi akun tertentu. Diautentikasi dengan
//         sessionToken hasil login (lihat auth-login.js) supaya satu
//         customer tidak bisa mengirim perintah ke akun customer lain.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    if (!checkEAToken(req)) return res.status(401).json({ ok: false, error: "Invalid EA token" });
    const account = String(req.query.account || "").trim();
    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

    const K = keys(account);
    const cmd = await redis.get(K.command);
    if (cmd) await redis.set(K.command, "");
    return res.status(200).json({ ok: true, command: cmd || "" });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const account = String(body.account || "").trim();
    const command = String(body.command || "").toUpperCase();

    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });
    if (!ALLOWED.includes(command)) {
      return res.status(400).json({ ok: false, error: "Perintah tidak dikenal" });
    }

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    const K = keys(account);
    await redis.set(K.command, command);
    return res.status(200).json({ ok: true, command });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
