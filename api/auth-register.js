import bcrypt from "bcryptjs";
import { getWebUserByEmail, createWebUser, setCors } from "../lib/db.js";

// Daftar akun WEB baru (Gmail + password). Ini HANYA identitas login
// panel — bukan lisensi EA. Setelah daftar, status akun = "pending"
// sampai admin mengaitkannya ke satu account_login (nomor akun MT5)
// yang datanya sudah tervalidasi lewat EA. Lihat admin-users.js.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const accountLogin = String(body.accountLogin || "").trim();

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email dan password wajib diisi" });
    }
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ ok: false, error: "Format email tidak valid" });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Password minimal 8 karakter" });
    }

    const existing = await getWebUserByEmail(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Email sudah terdaftar — silakan masuk" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createWebUser({
      email,
      passwordHash,
      accountLogin: accountLogin || null,
      role: "user",
      status: "pending",
    });

    return res.status(200).json({
      ok: true,
      message: "Pendaftaran berhasil. Akun Anda menunggu verifikasi admin sebelum dapat mengakses dashboard.",
      email: user.email,
      status: user.status,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
