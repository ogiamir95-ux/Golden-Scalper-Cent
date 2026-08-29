import bcrypt from "bcryptjs";
import { getWebUserByEmail, createWebUser, setCors, supabase, isAccountEverRevoked } from "../lib/db.js";

// Daftar akun WEB baru (Gmail + password). Ini HANYA identitas login
// panel — bukan lisensi EA. Setelah daftar, status akun = "pending"
// sampai admin mengaitkannya ke satu account_login (nomor akun MT5)
// yang datanya sudah tervalidasi lewat EA. Lihat admin-users.js.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Dideklarasikan di luar try supaya tetap terjangkau di blok catch di
  // bawah (dipakai utk menyusun pesan error yang jelas). Sebelumnya
  // accountLogin dideklarasikan di dalam try — kalau error terjadi
  // sebelum baris itu tereksekusi, catch melempar ReferenceError sendiri
  // (accountLogin is not defined) dan menutupi error aslinya, membuat
  // request selalu gagal dengan 500 generik / tidak ada respons.
  let accountLogin = "";

  try {
    const body = req.body || {};
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    accountLogin = String(body.accountLogin || "").trim();

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

    // WAJIB: Akun ID (Nomor Akun MT5) harus diisi saat registrasi (identitas
    // yang nanti dikaitkan admin ke akun web ini).
    if (!accountLogin) {
      return res.status(400).json({
        ok: false,
        error: "Akun ID (Nomor Akun MT5) wajib diisi saat daftar.",
      });
    }

    const existing = await getWebUserByEmail(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Email sudah terdaftar — silakan masuk" });
    }

    // BEKAS-REVOKE GUARD: kalau Akun ID ini PERNAH punya lisensi yang
    // dihapus/dicabut admin sebelumnya (tercatat permanen di
    // revoked_licenses.account_login), maka SEBELUM boleh daftar ulang,
    // EA wajib sudah sync ULANG ke server dengan Akun ID ini (baris baru
    // muncul lagi di tabel `accounts`) — supaya admin tahu akun ini benar
    // sudah pakai lisensi baru yang sah, bukan sekadar coba-coba pasang
    // nomor akun bekas orang lain yang lisensinya sudah dicabut.
    //
    // Akun ID yang BELUM PERNAH di-revoke sama sekali (baik baru maupun
    // sudah lama dipakai tapi belum pernah dihapus admin) TIDAK kena
    // aturan ini — bebas daftar & tinggal menunggu approve admin, EA
    // tidak wajib online/sync dulu.
    const everRevoked = await isAccountEverRevoked(accountLogin);
    if (everRevoked) {
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
            "Akun ID MT5 '" + accountLogin + "' pernah dicabut lisensinya oleh admin. " +
            "Pasang EA dengan kode lisensi BARU dan pastikan sudah berhasil sync minimal sekali sebelum daftar ulang akun web.",
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
    // Constraint unik di Supabase (mis. email atau account_login dobel akibat
    // race condition submit ganda) sebelumnya lolos sbg "[object Object]"
    // krn error Supabase bukan instance Error biasa. Sekarang diterjemahkan
    // ke pesan yang jelas.
    const rawMsg = err?.message || err?.error_description || err?.hint || String(err);
    let friendly = rawMsg;
    if (/duplicate key|unique constraint/i.test(rawMsg)) {
      friendly = "Email atau Akun ID ini sudah terdaftar sebelumnya.";
    } else if (/foreign key constraint.*account_login/i.test(rawMsg)) {
      // Jaring pengaman kedua: seharusnya sudah ditangkap oleh guard
      // isAccountEverRevoked() di atas SEBELUM sampai insert, tapi kalau
      // race condition atau ada baris lolos, tetap balas pesan manusiawi
      // bukan error Postgres mentah.
      friendly =
        "Akun ID MT5 '" + accountLogin + "' belum terdaftar di server atau pernah dicabut lisensinya oleh admin. " +
        "Pastikan EA sudah pernah online & berhasil sync minimal sekali dengan Akun ID ini sebelum daftar.";
    }
    return res.status(500).json({ ok: false, error: friendly });
  }
}
