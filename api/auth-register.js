import bcrypt from "bcryptjs";
import { getWebUserByEmail, createWebUser, setCors, supabase } from "../lib/db.js";

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

    // Kolom web_users.account_login punya foreign key ke accounts(account_login)
    // (ON DELETE SET NULL). Kalau Akun ID MT5 yang diisi belum pernah sync
    // sama sekali ke server (belum ada baris di `accounts`) — misalnya
    // karena baru saja dihapus admin atau EA belum pernah online — insert
    // akan gagal dgn error constraint mentah dari Postgres yang membingungkan.
    // Cek dulu di sini supaya pesan errornya jelas & bisa ditindaklanjuti.
    if (accountLogin) {
      const { data: accRow, error: accErr } = await supabase
        .from("accounts")
        .select("account_login")
        .eq("account_login", accountLogin)
        .maybeSingle();
      if (accErr) throw accErr;
      if (!accRow) {
        return res.status(400).json({
          ok: false,
          error:
            "Akun ID MT5 '" + accountLogin + "' belum terdaftar di server. " +
            "Pastikan EA sudah pernah online & berhasil sync minimal sekali sebelum daftar akun web.",
        });
      }
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
