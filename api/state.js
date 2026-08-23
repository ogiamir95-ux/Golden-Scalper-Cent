import { getAccount, getRecentLogs, isOnline, setCors, verifySessionToken, getSessionFromReq } from "../lib/db.js";

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

    const [accountRow, logs] = await Promise.all([
      getAccount(account),
      getRecentLogs(account, 15),
    ]);

    const state = accountRow?.state || null;
    const lastSeen = accountRow?.last_seen_at ? new Date(accountRow.last_seen_at).getTime() : 0;
    const online = isOnline(accountRow?.last_seen_at);

    return res.status(200).json({ ok: true, online, lastSeen, state, logs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
