import { redis, keys, setCors, simpleHash, createSessionToken } from "../lib/redis.js";

// Login web: Username = nomor akun MT5 (accountLogin), Password = kode lisensi EA.
// Tidak ada autentikasi "asal isi" — kredensial dicocokkan dengan data ASLI
// yang terakhir dikirim EA lewat /api/ea-update. Jika lisensi EA berstatus
// EXPIRED/INVALID atau EA belum pernah online, login ditolak.
//
// MULTI-TENANT: username = partisi data di Redis (lihat keys() di
// lib/redis.js), jadi setiap customer otomatis hanya bisa login & melihat
// datanya sendiri. Login sukses mengembalikan `sessionToken` (HMAC
// bertanda waktu) yang WAJIB disertakan browser di setiap request
// berikutnya (state/ea-command/ea-config) sebagai bukti bahwa browser
// tsb memang sudah lolos verifikasi untuk akun tersebut.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = req.body || {};
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "Username atau password tidak boleh kosong" });
    }

    const K = keys(username);
    const [stateRaw, heartbeat] = await Promise.all([redis.get(K.state), redis.get(K.heartbeat)]);
    const state = stateRaw ? (typeof stateRaw === "string" ? JSON.parse(stateRaw) : stateRaw) : null;

    const lastSeen = heartbeat ? Number(heartbeat) : 0;
    const online = lastSeen > 0 && (Date.now() - lastSeen) < 20000;

    if (!state || !state.accountLogin) {
      return res.status(403).json({
        ok: false,
        reason: "NO_DATA",
        error: "Akun ini belum pernah terhubung ke server — tidak ada data untuk divalidasi",
      });
    }

    if (String(username) !== String(state.accountLogin)) {
      return res.status(401).json({
        ok: false,
        reason: "BAD_USERNAME",
        error: "Username / Akun ID tidak sesuai dengan akun MT5 yang terhubung",
      });
    }

    if (!online) {
      return res.status(403).json({
        ok: false,
        reason: "EA_OFFLINE",
        error: "EA sedang offline — login memerlukan EA yang aktif untuk validasi lisensi real-time",
      });
    }

    // Cocokkan password (kode lisensi) dengan hash yang dikirim EA
    const passwordHash = simpleHash(password.toUpperCase());
    if (!state.licenseKeyHash || passwordHash !== state.licenseKeyHash) {
      return res.status(401).json({
        ok: false,
        reason: "BAD_LICENSE",
        error: "Kode lisensi (password) tidak sesuai",
      });
    }

    // Status lisensi HARUS valid di sisi EA — bukan hasil cek browser
    if (state.licenseStatus !== "VALID") {
      return res.status(403).json({
        ok: false,
        reason: "LICENSE_INVALID",
        error: state.licenseStatus === "EXPIRED"
          ? "Lisensi EA sudah EXPIRED — hubungi Telegram @daillytrader untuk perpanjangan"
          : "Lisensi EA tidak valid — akses dashboard ditolak",
        licenseStatus: state.licenseStatus,
      });
    }

    const sessionToken = createSessionToken(state.accountLogin);

    return res.status(200).json({
      ok: true,
      accountLogin: state.accountLogin,
      accountServer: state.accountServer,
      licenseStatus: state.licenseStatus,
      sessionToken,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
