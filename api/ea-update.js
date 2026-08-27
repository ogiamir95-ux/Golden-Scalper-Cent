import {
  supabase,
  getAccount,
  upsertAccountState,
  pushLogEntries,
  checkEAToken,
  setCors,
  todayDateKeyWIB,
  purgeRevokedAccount,
  isLicenseRevoked,
} from "../lib/db.js";

// Dipanggil oleh EA (WebRequest POST) setiap beberapa detik untuk mengirim
// snapshot data terbaru: equity, balance, floating, layers, lot, status, dll.
//
// MULTI-TENANT: setiap EA WAJIB mengirim `accountLogin` (nomor akun MT5) di
// body — ini sudah dilakukan otomatis oleh EA (lihat BuildStateJson() di
// .mq5, tidak perlu diubah). Nomor akun ini dipakai sebagai primary key di
// tabel `accounts` (Supabase) supaya data antar customer terpisah.
//
// TOFU BINDING: pertama kali sebuah accountLogin terlihat, hash lisensinya
// (license_key_hash) "dikunci" ke akun tersebut. Jika ada request berikutnya
// mengaku sebagai accountLogin yang sama tapi hash lisensinya berbeda,
// request ditolak — ini mencegah satu nomor akun MT5 dipakai untuk
// menimpa data milik customer lain (baik sengaja maupun karena nomor akun
// kebetulan sama di broker berbeda).
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  if (!checkEAToken(req)) {
    return res.status(401).json({ ok: false, error: "Invalid EA token" });
  }

  try {
    const body = req.body || {};
    const accountLogin = String(body.accountLogin ?? "").trim();

    if (!accountLogin) {
      return res.status(400).json({ ok: false, error: "accountLogin wajib dikirim EA" });
    }

    const licenseKeyHash = String(body.licenseKeyHash ?? "");

    // BLACKLIST PERMANEN: dicek PALING AWAL, bahkan sebelum tahu apakah
    // akun ini baru (belum pernah ada baris `accounts`) atau lama —
    // supaya kode lisensi yang pernah di-revoke admin TIDAK BISA dipakai
    // lagi walau EA dipasang ulang dari nol (baris accounts lama sudah
    // hilang, jadi tanpa cek ini TOFU akan menganggapnya akun baru & sync
    // diterima begitu saja). Berbeda dari revoke per-akun (field `revoked`
    // di tabel accounts), blacklist ini terikat ke HASH KODE LISENSI itu
    // sendiri, jadi kode lisensi baru untuk akun yang sama tetap normal.
    if (licenseKeyHash) {
      const blacklisted = await isLicenseRevoked(licenseKeyHash);
      if (blacklisted) {
        // Balas command REVOKE (bukan sekadar menolak dgn error) supaya EA
        // yang baru saja restart dgn kode lisensi lama ini tetap dipaksa
        // menjalankan aksi InpLicenseAction (finish cycle/close, stop/remove)
        // — bukan cuma dashboard yang berhenti ter-update sementara EA
        // jalan terus di background.
        return res.status(200).json({
          ok: true,
          command: "REVOKE",
          revoked: true,
          error: "Kode lisensi ini sudah dicabut permanen oleh admin.",
        });
      }
    }

    const existing = await getAccount(accountLogin);
    const boundHash = existing?.license_key_hash;

    // REVOKE ACK: EA mengirim revokeAck=true setelah selesai menjalankan
    // aksi InpLicenseAction akibat command REVOKE (posisi sudah
    // ditutup/EA sudah stop atau keluar dari chart). Ini titik aman utk
    // menghapus PERMANEN baris akun ini dari server — sinyal revoke
    // sudah pasti sampai & dieksekusi, tidak ada risiko hilang di tengah jalan.
    if (existing?.revoked && body.revokeAck === true) {
      await purgeRevokedAccount(accountLogin);
      return res.status(200).json({ ok: true, command: null, revoked: true, purged: true });
    }

    // Akun sudah di-revoke admin tapi EA belum konfirmasi (mis. baru
    // online lagi setelah sempat offline saat di-revoke) — terus
    // titipkan command REVOKE di setiap balasan sampai EA meng-ack-nya,
    // JANGAN proses snapshot state seperti biasa.
    if (existing?.revoked) {
      return res.status(200).json({ ok: true, command: "REVOKE", revoked: true });
    }

    if (boundHash && licenseKeyHash && String(boundHash) !== licenseKeyHash) {
      return res.status(409).json({
        ok: false,
        error:
          "Akun MT5 ini sudah terikat ke lisensi lain di server (TOFU binding). " +
          "Jika ini renewal/ganti lisensi yang sah, hapus/reset baris akun '" +
          accountLogin +
          "' di tabel accounts (Supabase) lalu coba lagi.",
      });
    }

    const snapshot = {
      equity: Number(body.equity ?? 0),
      balance: Number(body.balance ?? 0),
      floating: Number(body.floating ?? 0),
      achievedToday: Number(body.achievedToday ?? 0),
      buyLayers: Number(body.buyLayers ?? 0),
      sellLayers: Number(body.sellLayers ?? 0),
      buyLots: Number(body.buyLots ?? 0),
      sellLots: Number(body.sellLots ?? 0),
      running: Boolean(body.running ?? false),
      symbol: String(body.symbol ?? "XAUUSD"),
      magicNumber: Number(body.magicNumber ?? 0),
      dailyTargetProfit: Number(body.dailyTargetProfit ?? 0),
      dailyTargetLoss: Number(body.dailyTargetLoss ?? 0),
      statusText: String(body.statusText ?? ""),
      licenseStatus: String(body.licenseStatus ?? "UNKNOWN"),
      licenseExpiry: String(body.licenseExpiry ?? ""),
      startHour: Number(body.startHour ?? 0),
      startMinute: Number(body.startMinute ?? 0),
      endHour: Number(body.endHour ?? 0),
      endMinute: Number(body.endMinute ?? 0),
      accountLogin,
      accountServer: String(body.accountServer ?? ""),
      accountType: String(body.accountType ?? "DEMO"),
      newsStatus: String(body.newsStatus ?? "AMAN"),
      licenseKeyHash,
      updatedAt: Date.now(),
    };

    await upsertAccountState(accountLogin, {
      state: snapshot,
      license_key_hash: licenseKeyHash || boundHash || null,
      last_seen_at: new Date().toISOString(),
    });

    // EA mengirim SEMUA event aktivitas yang terjadi sejak sync terakhir
    // lewat array `logQueue` (baru) — supaya beberapa event yang terjadi
    // berdekatan (mis. buka layer baru lalu langsung TP) tidak saling
    // menimpa dan semuanya tercatat di dashboard.
    // `logText`/`logType` (lama, singular) tetap didukung untuk EA versi
    // lama yang belum di-upgrade, supaya tidak breaking change.
    const logEntries = [];
    if (Array.isArray(body.logQueue)) {
      for (const item of body.logQueue) {
        const text = String(item?.text ?? "").trim();
        if (!text) continue;
        logEntries.push({ text, type: String(item?.type || "info") });
      }
    } else if (body.logText) {
      logEntries.push({ text: String(body.logText), type: String(body.logType || "info") });
    }

    if (logEntries.length > 0) {
      await pushLogEntries(accountLogin, logEntries);
    }

    // Auto-catat P/L hari ini ke Kalender Jurnal (tabel journal_entries).
    // Hanya kolom `pnl` & `pair` yang ditimpa otomatis di sini — kolom lain
    // (trades, win_rate, lot, note) tetap milik operator, diisi manual lewat
    // /api/journal.js supaya tidak tertimpa tiap kali EA sync (tiap ~3 detik).
    try {
      const todayKey = todayDateKeyWIB();
      const { data: existingEntry } = await supabase
        .from("journal_entries")
        .select("lot,trades,win_rate,note")
        .eq("account_login", accountLogin)
        .eq("entry_date", todayKey)
        .maybeSingle();

      await supabase.from("journal_entries").upsert(
        {
          account_login: accountLogin,
          entry_date: todayKey,
          pnl: snapshot.achievedToday,
          pair: snapshot.symbol,
          lot: existingEntry?.lot ?? 0,
          trades: existingEntry?.trades ?? 0,
          win_rate: existingEntry?.win_rate ?? 0,
          note: existingEntry?.note ?? "",
        },
        { onConflict: "account_login,entry_date" }
      );
    } catch { /* jurnal bersifat pelengkap — jangan gagalkan sync utama jika ini error */ }

    // Balas dengan perintah tertunda (jika ada), lalu langsung hapus (ack)
    // supaya EA tidak menerima & mengeksekusi perintah yang sama berulang-ulang
    // di setiap sync berikutnya (mis. CLOSEALL yang terus menutup posisi baru).
    const pendingCommand = existing?.pending_command || null;
    if (pendingCommand) {
      await supabase
        .from("accounts")
        .update({ pending_command: null })
        .eq("account_login", accountLogin);
    }

    return res.status(200).json({ ok: true, command: pendingCommand || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
