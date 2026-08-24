import { supabase, checkEAToken, setCors, verifySessionToken, getSessionFromReq } from "../lib/db.js";

// GET  -> dipanggil EA (per akun, ?account=<accountLogin>) untuk mengambil
//         konfigurasi terbaru yang diset lewat web panel. Diautentikasi
//         dengan X-EA-Token.
// POST -> dipanggil dari web saat operator menekan "Simpan Perubahan" di
//         salah satu grup setting. Diautentikasi dengan sessionToken hasil
//         login supaya hanya pemilik akun yang bisa mengubah konfigurasi
//         akun tersebut.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    if (!checkEAToken(req)) return res.status(401).json({ ok: false, error: "Invalid EA token" });
    const account = String(req.query.account || "").trim();
    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

    const { data, error } = await supabase
      .from("accounts")
      .select("config")
      .eq("account_login", account)
      .maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: String(error) });

    // PENTING: config dikembalikan sebagai OBJEK JSON biasa (bukan
    // string yang di-JSON.stringify lagi). Jika di-stringify di sini,
    // res.json() akan membungkusnya SEKALI LAGI sehingga semua tanda
    // kutip di dalamnya ter-escape (\"key\":value). Parser sederhana
    // di EA (ExtractJsonNumber/ExtractJsonString) mencari pola persis
    // "key": (kutip lurus) dan TIDAK akan pernah menemukan field
    // apa pun kalau konfig di-double-encode seperti itu — akibatnya
    // panel info EA tidak pernah ikut berubah walau sudah disimpan
    // dari web. Dengan config sebagai objek biasa, hasil akhir body
    // JSON tetap hanya di-encode SATU KALI dan pola "key": tetap utuh.
    const cfg = data?.config ?? null;
    return res.status(200).json({ ok: true, config: cfg });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const account = String(body.account || "").trim();
    if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

    const token = getSessionFromReq(req);
    if (!verifySessionToken(token, account)) {
      return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
    }

    // body diharapkan berisi seluruh objek `state` dari web (semua field SCHEMA)
    const { error } = await supabase
      .from("accounts")
      .upsert({ account_login: account, config: body }, { onConflict: "account_login" });
    if (error) return res.status(500).json({ ok: false, error: String(error) });

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
