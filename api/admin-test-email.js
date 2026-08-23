import { setCors, verifyWebSessionToken, getSessionFromReq } from "../lib/db.js";
import { sendLicenseKeyEmail } from "../lib/email.js";

// Khusus ADMIN — kirim satu email PERCOBAAN untuk mengetes apakah
// GMAIL_USER / GMAIL_APP_PASSWORD sudah benar, TANPA generate lisensi
// apa pun dan TANPA menyentuh database sama sekali.
//
// Cara pakai (dari browser, setelah login sebagai admin di panel):
//   fetch("/api/admin-test-email", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "X-Session-Token": localStorage.getItem("gsc_session") // sesuaikan key-nya
//     },
//     body: JSON.stringify({ to: "emailtujuan@gmail.com" })
//   }).then(r => r.json()).then(console.log)
//
// Response { ok:true, emailSent:true }  -> SMTP OK, cek inbox/spam email tujuan.
// Response { ok:true, emailSent:false, emailError:"..." } -> baca pesan error,
//   biasanya salah satu dari:
//   - "GMAIL_USER / GMAIL_APP_PASSWORD belum diatur..." -> env var belum
//     ke-attach di deployment ini (isi lagi lalu REDEPLOY).
//   - "Invalid login" / "535-5.7.8" -> App Password salah, atau
//     2-Step Verification belum aktif di akun Gmail pengirim.
//   - "Missing credentials for PLAIN" -> GMAIL_USER/GMAIL_APP_PASSWORD
//     terisi string kosong, bukan benar-benar unset.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const token = getSessionFromReq(req);
  const session = verifyWebSessionToken(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Akses ditolak — khusus admin" });
  }

  const to = String((req.body || {}).to || "").trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ ok: false, error: "Email tujuan (\"to\") wajib diisi & valid" });
  }

  const emailResult = await sendLicenseKeyEmail({
    to,
    accountLogin: "TEST-000000",
    licenseKey: "TEST-TEST-TEST-000000-20260101-000",
    expiryDateHuman: "01-01-2026",
    magicNumber: 88888,
  });

  return res.status(200).json({
    ok: true,
    emailSent: emailResult.sent,
    emailError: emailResult.sent ? null : emailResult.error,
    envSeen: {
      GMAIL_USER: process.env.GMAIL_USER ? `${process.env.GMAIL_USER.slice(0, 3)}***` : null,
      GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD ? "***(terisi)" : null,
    },
  });
}
