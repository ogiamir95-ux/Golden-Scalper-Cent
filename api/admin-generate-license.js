import {
  setCors,
  verifyWebSessionToken,
  getSessionFromReq,
  generateLicenseKey,
  saveLicenseExpiryFallback,
  getWebUserByAccountLogin,
} from "../lib/db.js";
import { sendLicenseKeyEmail } from "../lib/email.js";

// Khusus ADMIN — generate kode lisensi EA dari web, pengganti script
// LicenseKeyGenerator.mq5 (drag & drop ke chart). Algoritma checksum
// identik dengan versi MQL5, jadi kode yang dibuat di sini akan
// diterima oleh EA (ValidateLicense() di file Expert Advisor).
//
// PENTING: endpoint ini TIDAK menyimpan kode ke database — kode hanya
// ditampilkan sekali ke admin untuk disalin & dikirim ke customer.
// Validasi lisensi tetap sepenuhnya terjadi di sisi EA (lokal, offline),
// server hanya menerima LAPORAN status VALID/INVALID dari EA seperti
// sebelumnya (lihat ea-update.js) — perilaku ini TIDAK diubah.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = getSessionFromReq(req);
  const session = verifyWebSessionToken(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Akses ditolak — khusus admin" });
  }

  try {
    const body = req.body || {};
    const accountLogin = String(body.accountLogin || "").trim();
    const validDays = Number(body.validDays);
    const magicNumber = body.magicNumber ? Number(body.magicNumber) : 88888;

    if (!accountLogin || !/^\d+$/.test(accountLogin)) {
      return res.status(400).json({ ok: false, error: "Akun ID MT5 wajib diisi (hanya angka)" });
    }
    if (!Number.isFinite(validDays) || validDays <= 0 || validDays > 3650) {
      return res.status(400).json({ ok: false, error: "Masa berlaku (hari) tidak valid" });
    }
    if (!Number.isFinite(magicNumber) || magicNumber <= 0) {
      return res.status(400).json({ ok: false, error: "Magic Number tidak valid" });
    }

    const result = generateLicenseKey(accountLogin, validDays, magicNumber);

    // Simpan tanggal expiry sebagai fallback tampilan Admin Panel (bukan
    // kode lisensinya sendiri — itu tetap tidak pernah disimpan). Jangan
    // sampai kegagalan simpan fallback ini menggagalkan response kode ke
    // admin — kode sudah jadi & valid meski baris ini gagal.
    try {
      await saveLicenseExpiryFallback(accountLogin, result.expiryDate.replace(
        /^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"
      ));
    } catch (fallbackErr) {
      console.error("Gagal menyimpan fallback license_expires_at:", fallbackErr);
    }

    // Kirim kode ke email customer (dicari dari Akun ID MT5 yang sudah
    // dikaitkan saat registrasi) — kegagalan pencarian user atau kirim
    // email TIDAK menggagalkan response ke admin; kode tetap valid dan
    // tetap ditampilkan di panel untuk disalin manual sebagai fallback.
    let emailResult = { sent: false, error: "Tidak ada akun web yang terkait dengan Akun ID MT5 ini" };
    try {
      const webUser = await getWebUserByAccountLogin(accountLogin);
      if (webUser?.email) {
        const expiryDateHuman = result.expiryDate.replace(
          /^(\d{4})(\d{2})(\d{2})$/, "$3-$2-$1"
        );
        emailResult = await sendLicenseKeyEmail({
          to: webUser.email,
          accountLogin,
          licenseKey: result.key,
          expiryDateHuman,
          magicNumber,
        });
      }
    } catch (emailErr) {
      emailResult = { sent: false, error: String(emailErr) };
    }
    if (!emailResult.sent) {
      console.error("Gagal mengirim email kode lisensi:", emailResult.error);
    }

    return res.status(200).json({
      ok: true,
      key: result.key,
      accountLogin,
      magicNumber,
      validDays,
      expiryDate: result.expiryDate,
      expiresAt: result.expiresAt,
      emailSent: emailResult.sent,
      emailError: emailResult.sent ? null : emailResult.error,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
