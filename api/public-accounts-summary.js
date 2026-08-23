import {
  listWebUsers,
  listAccountsMap,
  isOnline,
  setCors,
} from "../lib/db.js";

// PUBLIK — ringkasan SEMUA akun customer, boleh diakses siapa saja tanpa
// login (dipakai halaman "Ringkasan Akun Customer" di sidebar, yang kini
// terbuka untuk semua orang, bukan cuma admin).
//
// Bedanya dengan /api/admin-accounts-summary (yang tetap admin-only):
//   - Email & Akun ID MT5 DISAMARKAN (mis. "naki***@gmail.com", "12****15")
//   - TIDAK mengirim status lisensi (VALID/INVALID) sama sekali
//   - TIDAK memerlukan/menerima session token
//
// Field yang dikirim sengaja dibatasi hanya yang memang diminta tampil di
// kartu publik: identitas tersamar, equity, posisi terbuka, status
// online/offline, dan sisa masa aktif.

function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return "***";
  const [local, domain] = email.split("@");
  const visible = local.slice(0, 4);
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

function maskAccountLogin(login) {
  if (!login) return null;
  const str = String(login);
  if (str.length <= 4) return "*".repeat(str.length);
  const head = str.slice(0, 2);
  const tail = str.slice(-2);
  return `${head}${"*".repeat(Math.max(4, str.length - 4))}${tail}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const users = await listWebUsers();
    const accountLogins = users.map((u) => u.account_login).filter(Boolean);
    const accountsMap = await listAccountsMap(accountLogins);

    const items = users.map((u) => {
      const acc = u.account_login ? accountsMap.get(String(u.account_login)) : null;
      const state = acc?.state || null;
      const online = isOnline(acc?.last_seen_at);

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
        emailMasked: maskEmail(u.email),
        accountMasked: maskAccountLogin(u.account_login),
        hasAccount: !!u.account_login,
        online,
        hasData: !!state,
        equity: state?.equity ?? null,
        openPositions: state ? Number(state.buyLayers ?? 0) + Number(state.sellLayers ?? 0) : null,
        daysLeft,
      };
    });

    return res.status(200).json({ ok: true, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
