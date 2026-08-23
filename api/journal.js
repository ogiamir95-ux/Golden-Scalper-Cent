import { supabase, setCors, verifySessionToken, getSessionFromReq } from "../lib/db.js";

// Jurnal harian (Kalender Profit/Loss) — satu baris per tanggal per akun,
// disimpan di tabel Supabase `journal_entries` (primary key: account_login + entry_date).
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
      const startDate = `${month}-01`;
      const [y, m] = month.split("-").map(Number);
      const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // hari pertama bulan berikutnya

      const { data, error } = await supabase
        .from("journal_entries")
        .select("entry_date,pnl,pair,lot,trades,win_rate,note,updated_at")
        .eq("account_login", account)
        .gte("entry_date", startDate)
        .lt("entry_date", nextMonth);
      if (error) throw error;

      const entries = {};
      for (const row of data || []) {
        entries[row.entry_date] = {
          pnl: Number(row.pnl),
          pair: row.pair,
          lot: Number(row.lot),
          trades: Number(row.trades),
          winRate: Number(row.win_rate),
          note: row.note,
          updatedAt: new Date(row.updated_at).getTime(),
        };
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
      const { data: existing } = await supabase
        .from("journal_entries")
        .select("pnl")
        .eq("account_login", account)
        .eq("entry_date", date)
        .maybeSingle();

      const merged = {
        account_login: account,
        entry_date: date,
        pnl: existing?.pnl ?? 0, // hanya diisi otomatis dari ea-update.js
        pair: String(body.pair ?? ""),
        lot: Number(body.lot ?? 0),
        trades: Number(body.trades ?? 0),
        win_rate: Number(body.winRate ?? 0),
        note: String(body.note ?? ""),
      };

      const { error } = await supabase
        .from("journal_entries")
        .upsert(merged, { onConflict: "account_login,entry_date" });
      if (error) throw error;

      return res.status(200).json({
        ok: true,
        date,
        entry: {
          pnl: Number(merged.pnl),
          pair: merged.pair,
          lot: merged.lot,
          trades: merged.trades,
          winRate: merged.win_rate,
          note: merged.note,
          updatedAt: Date.now(),
        },
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err) });
    }
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
