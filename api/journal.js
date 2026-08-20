import { redis, keys, setCors, verifySessionToken, getSessionFromReq } from "../lib/redis.js";

// Jurnal harian (Kalender Profit/Loss) — satu entri per tanggal per akun,
// disimpan di Redis hash `gsp:journal:{accountLogin}` (field = "YYYY-MM-DD").
//
// GET  ?account=&month=YYYY-MM  -> ambil semua entri jurnal bulan tsb
//   (dipanggil dashboard saat kalender dibuka / pindah bulan)
// POST { account, date, pair, lot, trades, winRate, note } -> simpan/update
//   catatan operator untuk satu tanggal (field pnl TIDAK bisa diisi manual
//   lewat endpoint ini — nilai P/L otomatis diisi server dari data EA di
//   ea-update.js, supaya angka profit/loss selalu berdasar data asli).
//
// Keduanya diautentikasi dengan sessionToken hasil login (sama seperti
// /api/state, /api/ea-command, /api/ea-config) supaya jurnal satu customer
// tidak bisa dibaca/diubah oleh customer lain.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const account = String(req.query.account || "").trim();
    const month = String(req.query.month || "").trim(); // "YYYY-MM"

    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: "Parameter 'month' wajib format YYYY-MM" });
    }

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    try {
      const K = keys(account);
      const all = await redis.hgetall(K.journal);
      const entries = {};
      if (all) {
        for (const [date, raw] of Object.entries(all)) {
          if (!date.startsWith(month)) continue;
          try {
            entries[date] = typeof raw === "string" ? JSON.parse(raw) : raw;
          } catch { /* skip entri korup */ }
        }
      }
      return res.status(200).json({ ok: true, month, entries });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err) });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const account = String(body.account || "").trim();
    const date = String(body.date || "").trim(); // "YYYY-MM-DD"

    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "Parameter 'date' wajib format YYYY-MM-DD" });
    }

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    try {
      const K = keys(account);
      const existingRaw = await redis.hget(K.journal, date);
      const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};

      const merged = {
        pnl: Number(existing.pnl ?? 0), // hanya diisi otomatis dari ea-update.js
        pair: String(body.pair ?? existing.pair ?? ""),
        lot: Number(body.lot ?? existing.lot ?? 0),
        trades: Number(body.trades ?? existing.trades ?? 0),
        winRate: Number(body.winRate ?? existing.winRate ?? 0),
        note: String(body.note ?? existing.note ?? ""),
        updatedAt: Date.now(),
      };

      await redis.hset(K.journal, { [date]: JSON.stringify(merged) });
      return res.status(200).json({ ok: true, date, entry: merged });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err) });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
