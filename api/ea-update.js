import { redis, keys, ACCOUNTS_SET, checkEAToken, setCors, todayDateKeyWIB } from "../lib/redis.js";

// Dipanggil oleh EA (WebRequest POST) setiap beberapa detik untuk mengirim
// snapshot data terbaru: equity, balance, floating, layers, lot, status, dll.
//
// MULTI-TENANT: setiap EA WAJIB mengirim `accountLogin` (nomor akun MT5) di
// body — ini sudah dilakukan otomatis oleh EA (lihat BuildStateJson() di
// .mq5, tidak perlu diubah). Nomor akun ini dipakai sebagai partisi data di
// Redis (lihat keys() di lib/redis.js) supaya data antar customer terpisah.
//
// TOFU BINDING: pertama kali sebuah accountLogin terlihat, hash lisensinya
// (licenseKeyHash) "dikunci" ke akun tersebut. Jika ada request berikutnya
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

    const K = keys(accountLogin);
    const licenseKeyHash = String(body.licenseKeyHash ?? "");

    const boundHash = await redis.get(K.eaToken);
    if (!boundHash) {
      if (licenseKeyHash) await redis.set(K.eaToken, licenseKeyHash);
    } else if (licenseKeyHash && String(boundHash) !== licenseKeyHash) {
      return res.status(409).json({
        ok: false,
        error:
          "Akun MT5 ini sudah terikat ke lisensi lain di server (TOFU binding). " +
          "Jika ini renewal/ganti lisensi yang sah, hapus key 'gsp:eatoken:" +
          accountLogin +
          "' di Upstash lalu coba lagi.",
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
      licenseKeyHash,
      updatedAt: Date.now(),
    };

    await redis.set(K.state, JSON.stringify(snapshot));
    await redis.set(K.heartbeat, Date.now());
    await redis.sadd(ACCOUNTS_SET, accountLogin);

    // Opsional: EA bisa mengirim satu baris log aktivitas baru sekaligus
    if (body.logText) {
      const entry = JSON.stringify({
        text: String(body.logText),
        type: String(body.logType || "info"),
        time: Date.now(),
      });
      await redis.lpush(K.log, entry);
      await redis.ltrim(K.log, 0, 29); // simpan 30 entri terakhir
    }

    // Auto-catat P/L hari ini ke Kalender Jurnal (gsp:journal:{account}).
    // Hanya field `pnl` & `pair` yang ditimpa otomatis di sini — field lain
    // (trades, winRate, lot, note) tetap milik operator, diisi manual lewat
    // /api/journal.js supaya tidak tertimpa tiap kali EA sync (tiap ~3 detik).
    try {
      const todayKey = todayDateKeyWIB();
      const existingRaw = await redis.hget(K.journal, todayKey);
      const existing = existingRaw ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw) : {};
      const journalEntry = {
        pnl: snapshot.achievedToday,
        pair: snapshot.symbol,
        lot: Number(existing.lot ?? 0),
        trades: Number(existing.trades ?? 0),
        winRate: Number(existing.winRate ?? 0),
        note: String(existing.note ?? ""),
        updatedAt: Date.now(),
      };
      await redis.hset(K.journal, { [todayKey]: JSON.stringify(journalEntry) });
    } catch { /* jurnal bersifat pelengkap — jangan gagalkan sync utama jika ini error */ }

    // Balas dengan perintah tertunda (jika ada), lalu langsung hapus (ack)
    // supaya EA tidak menerima & mengeksekusi perintah yang sama berulang-ulang
    // di setiap sync berikutnya (mis. CLOSEALL yang terus menutup posisi baru).
    const pendingCommand = await redis.get(K.command);
    if (pendingCommand) {
      await redis.set(K.command, "");
    }

    return res.status(200).json({ ok: true, command: pendingCommand || null });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
