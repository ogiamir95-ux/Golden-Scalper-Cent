import {
  listWebUsers,
  listAccountsMap,
  isOnline,
  setCors,
  verifyWebSessionToken,
  getSessionFromReq,
} from "../lib/db.js";

// Khusus ADMIN — ringkasan SEMUA akun customer sekaligus (satu panggilan),
// untuk ditampilkan sebagai kartu di Admin Panel: status online/offline EA,
// equity, posisi terbuka, status lisensi, dan sisa masa aktif.
//
// Beda dengan /api/state (dipakai dashboard operator): endpoint itu
// mensyaratkan sessionToken MILIK akun yang diminta (satu akun per
// panggilan) — cocok untuk operator melihat akunnya sendiri, TAPI tidak
// bisa dipakai admin untuk melihat semua akun customer sekaligus karena
// admin tidak (dan tidak boleh) memegang sessionToken tiap customer.
// Endpoint ini sebagai gantinya diproteksi oleh webSessionToken + role
// admin (sama seperti admin-users.js), bukan sessionToken per-akun.
//
// Sisa masa aktif dihitung dari (urutan prioritas):
//   1) state.licenseExpiry — dikirim EA real-time tiap sync (paling akurat,
//      otomatis ter-update begitu customer ganti kode lisensi baru)
//   2) accounts.license_expires_at — fallback dari tanggal saat admin
//      generate kode di web, dipakai selama EA belum pernah/belum sempat
//      sync ulang dengan kode barunya
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = getSessionFromReq(req);
  const session = verifyWebSessionToken(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Akses ditolak — khusus admin" });
  }

  try {
    const users = await listWebUsers();
    const accountLogins = users.map((u) => u.account_login).filter(Boolean);
    const accountsMap = await listAccountsMap(accountLogins);

    const items = users.map((u) => {
      const acc = u.account_login ? accountsMap.get(String(u.account_login)) : null;
      const state = acc?.state || null;
      const online = isOnline(acc?.last_seen_at);

      // Prioritas 1: tanggal dari EA (format "YYYY.MM.DD" dari TimeToString).
      // Prioritas 2: fallback dari kolom accounts.license_expires_at ("YYYY-MM-DD").
      let expiresAtISO = null;
      if (state?.licenseExpiry) {
        const norm = String(state.licenseExpiry).replace(/\./g, "-");
        if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) expiresAtISO = norm;
      }
      if (!expiresAtISO && acc?.license_expires_at) {
        expiresAtISO = String(acc.license_expires_at);
      }

      let daysLeft = null;
      if (expiresAtISO) {
        const expiryMs = new Date(expiresAtISO + "T23:59:59Z").getTime();
        daysLeft = Math.ceil((expiryMs - Date.now()) / 86400000);
      }

      return {
        email: u.email,
        accountLogin: u.account_login || null,
        role: u.role,
        status: u.status,
        online,
        hasData: !!state,
        equity: state?.equity ?? null,
        balance: state?.balance ?? null,
        floating: state?.floating ?? null,
        openPositions: state ? Number(state.buyLayers ?? 0) + Number(state.sellLayers ?? 0) : null,
        licenseStatus: state?.licenseStatus ?? null,
        accountType: state?.accountType ?? null,
        symbol: state?.symbol ?? null,
        expiresAt: expiresAtISO,
        daysLeft,
      };
    });

    return res.status(200).json({ ok: true, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
