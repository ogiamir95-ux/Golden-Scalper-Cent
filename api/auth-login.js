import bcrypt from "bcryptjs";
import {
  getAccount,
  getWebUserByEmail,
  isOnline,
  setCors,
  createSessionToken,
  createWebSessionToken,
} from "../lib/db.js";

// Login web (versi baru): Email + Password (akun web) + Akun ID (Nomor
// Akun MT5). Alurnya dua lapis:
//
//  1) Verifikasi identitas WEB — email/password dicocokkan dengan
//     `web_users` (bcrypt). Akun harus berstatus "approved" oleh admin
//     dan account_login yang diminta harus sama dengan yang dikaitkan
//     admin ke akun tsb.
//
//  2) Validasi LISENSI EA — SAMA PERSIS seperti sebelumnya: dicocokkan
//     ke data real-time terakhir yang dikirim EA lewat /api/ea-update.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const accountLogin = String(body.accountLogin || "").trim();

    if (!email || !password || !accountLogin) {
      return res.status(400).json({ ok: false, error: "Email, password, dan Akun ID wajib diisi" });
    }

    // --- Lapis 1: identitas akun WEB ---
    const webUser = await getWebUserByEmail(email);
    if (!webUser) {
      return res.status(401).json({ ok: false, reason: "BAD_CREDENTIALS", error: "Email atau password salah" });
    }

    const passOk = await bcrypt.compare(password, webUser.password_hash);
    if (!passOk) {
      return res.status(401).json({ ok: false, reason: "BAD_CREDENTIALS", error: "Email atau password salah" });
    }

    if (webUser.status !== "approved") {
      return res.status(403).json({
        ok: false,
        reason: "PENDING_APPROVAL",
        error: "Akun Anda belum diverifikasi admin — hubungi Telegram @DAILLYTRADER24HOURS",
      });
    }

    if (!webUser.account_login) {
      return res.status(403).json({
        ok: false,
        reason: "NOT_LINKED",
        error: "Akun web Anda belum dikaitkan ke Akun ID MT5 — hubungi admin",
      });
    }

    if (String(webUser.account_login) !== String(accountLogin)) {
      return res.status(403).json({
        ok: false,
        reason: "ACCOUNT_MISMATCH",
        error: "Akun ID tidak sesuai dengan akun yang terdaftar pada email ini",
      });
    }

    // --- Lapis 2: validasi lisensi EA real-time (logika ASLI, tidak diubah) ---
    const account = await getAccount(accountLogin);
    const state = account?.state || null;
    const online = isOnline(account?.last_seen_at);

    if (!state || !state.accountLogin) {
      return res.status(403).json({
        ok: false,
        reason: "NO_DATA",
        error: "Akun ini belum pernah terhubung ke server — tidak ada data untuk divalidasi",
      });
    }

    if (!online) {
      return res.status(403).json({
        ok: false,
        reason: "EA_OFFLINE",
        error: "EA sedang offline — login memerlukan EA yang aktif untuk validasi lisensi real-time",
      });
    }

    if (state.licenseStatus !== "VALID") {
      return res.status(403).json({
        ok: false,
        reason: "LICENSE_INVALID",
        error: state.licenseStatus === "EXPIRED"
          ? "Lisensi EA sudah EXPIRED — hubungi Telegram @DAILLYTRADER24HOURS untuk perpanjangan"
          : "Lisensi EA tidak valid — akses dashboard ditolak",
        licenseStatus: state.licenseStatus,
      });
    }

    const sessionToken = createSessionToken(state.accountLogin);
    const webSessionToken = createWebSessionToken({
      email: webUser.email,
      role: webUser.role,
      accountLogin: state.accountLogin,
    });

    return res.status(200).json({
      ok: true,
      accountLogin: state.accountLogin,
      accountServer: state.accountServer,
      licenseStatus: state.licenseStatus,
      sessionToken,
      webSessionToken,
      email: webUser.email,
      role: webUser.role,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
