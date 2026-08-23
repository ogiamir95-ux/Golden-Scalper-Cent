import { Resend } from "resend";

// Kirim kode lisensi yang baru di-generate ke email customer via Resend.
//
// ENV VARIABLE yang wajib diisi di Vercel Project Settings > Environment
// Variables (BUKAN di kode — jangan pernah hardcode API key):
//   RESEND_API_KEY   — API key dari dashboard Resend (resend.com/api-keys)
//   RESEND_FROM      — alamat pengirim, mis. "Golden Cent Scalper <lisensi@domainanda.com>"
//                       Domain-nya harus sudah diverifikasi di Resend dulu.
//                       Kalau belum punya domain sendiri, sementara bisa
//                       pakai "onboarding@resend.dev" (hanya untuk testing,
//                       Resend akan menolak kirim ke email selain milik
//                       akun Resend Anda sendiri sampai domain diverifikasi).
//
// Fungsi ini SENGAJA tidak melempar error ke pemanggil kalau pengiriman
// gagal — endpoint generate-license tetap harus sukses mengembalikan kode
// ke admin walau emailnya gagal terkirim (mis. RESEND_API_KEY belum diisi).
// Pemanggil cukup mengecek field `sent` pada hasil untuk tahu statusnya.

let resendClient = null;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export async function sendLicenseKeyEmail({ to, accountLogin, licenseKey, expiryDateHuman, magicNumber }) {
  const client = getResendClient();
  if (!client) {
    return { sent: false, error: "RESEND_API_KEY belum diatur di Environment Variables" };
  }
  const from = process.env.RESEND_FROM || "onboarding@resend.dev";

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
    const result = await client.emails.send({
      from,
      to,
      subject: `Kode Lisensi Baru — Akun MT5 #${accountLogin}`,
      html,
    });
    if (result.error) {
      return { sent: false, error: result.error.message || String(result.error) };
    }
    return { sent: true, id: result.data?.id || null };
  } catch (err) {
    return { sent: false, error: String(err?.message || err) };
  }
}
