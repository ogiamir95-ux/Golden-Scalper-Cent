import nodemailer from "nodemailer";

// Kirim kode lisensi yang baru di-generate ke email customer, lewat Gmail
// SMTP (gratis, tidak perlu domain sendiri) menggunakan App Password.
//
// ENV VARIABLE yang wajib diisi di Vercel Project Settings > Environment
// Variables (BUKAN di kode — jangan pernah hardcode password/App Password):
//   GMAIL_USER         — alamat Gmail pengirim, mis. "akunanda@gmail.com"
//   GMAIL_APP_PASSWORD — App Password 16 digit dari Google Account
//                         (myaccount.google.com/security -> 2-Step
//                         Verification harus aktif dulu -> App passwords).
//                         BUKAN password login Gmail biasa.
//
// Batas kirim akun Gmail biasa: +-500 email/hari. Cukup untuk kebanyakan
// kebutuhan penjualan lisensi, tapi kalau volume sudah besar pertimbangkan
// pindah ke provider transactional email (Resend, dst).
//
// Fungsi ini SENGAJA tidak melempar error ke pemanggil kalau pengiriman
// gagal -- endpoint generate-license tetap harus sukses mengembalikan kode
// ke admin walau emailnya gagal terkirim (mis. App Password belum diisi).
// Pemanggil cukup mengecek field `sent` pada hasil untuk tahu statusnya.

let transporter = null;
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
  }
  return transporter;
}

export async function sendLicenseKeyEmail({ to, accountLogin, licenseKey, expiryDateHuman, magicNumber }) {
  const tx = getTransporter();
  if (!tx) {
    return { sent: false, error: "GMAIL_USER / GMAIL_APP_PASSWORD belum diatur di Environment Variables" };
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
      <h2 style="margin-bottom:4px;">Kode Lisensi Golden Cent Scalper</h2>
      <p style="color:#555;margin-top:0;">Berikut kode lisensi untuk Akun ID MT5 <b>${accountLogin}</b>:</p>
      <div style="background:#f4f4f4;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">
        <code style="font-size:18px;font-weight:700;letter-spacing:.5px;">${licenseKey}</code>
      </div>
      <p style="color:#555;">Berlaku sampai: <b>${expiryDateHuman}</b><br>Magic Number: <b>${magicNumber}</b></p>
      <p style="color:#555;">Paste kode ini ke input <b>InpLicenseKey</b> pada EA yang dipasang di akun MT5 #${accountLogin}. Pastikan <b>InpMagicNumberDefault</b> pada EA sama dengan Magic Number di atas.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">
      <p style="color:#999;font-size:12px;">Pertanyaan? Hubungi Telegram @daillytrader.</p>
    </div>
  `;

  try {
    const info = await tx.sendMail({
      from: `"Golden Cent Scalper" <${process.env.GMAIL_USER}>`,
      to,
      subject: `Kode Lisensi Baru — Akun MT5 #${accountLogin}`,
      html,
    });
    return { sent: true, id: info.messageId || null };
  } catch (err) {
    return { sent: false, error: String(err?.message || err) };
  }
}
