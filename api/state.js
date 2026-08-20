import { redis, keys, setCors, verifySessionToken, getSessionFromReq } from "../lib/redis.js";

// Dipanggil oleh browser (polling tiap beberapa detik, setelah login) untuk
// menampilkan data real-time dari EA di dashboard.
//
// MULTI-TENANT: wajib kirim `?account=<accountLogin>` DAN sessionToken hasil
// login (header Authorization: Bearer <token> atau X-Session-Token). Tanpa
// ini, siapa pun yang tahu/menebak nomor akun MT5 customer lain bisa
// mengintip equity/balance/floating mereka tanpa perlu login. sessionToken
// membuktikan browser ini memang baru saja lolos verifikasi lisensi untuk
// akun yang diminta.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const account = String(req.query.account || "").trim();
    if (!account) {
      return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });
    }

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    const K = keys(account);
    const [stateRaw, heartbeat, logsRaw] = await Promise.all([
      redis.get(K.state),
      redis.get(K.heartbeat),
      redis.lrange(K.log, 0, 14),
    ]);

    const state = stateRaw ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw) : null;
    const lastSeen = heartbeat ? Number(heartbeat) : 0;
    const online = lastSeen > 0 && (Date.now() - lastSeen) < 20000; // dianggap online jika update <20 detik terakhir

    const logs = (logsRaw || []).map((raw) => {
      try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
    }).filter(Boolean);

    return res.status(200).json({ ok: true, online, lastSeen, state, logs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
