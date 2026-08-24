import { supabase, setCors, verifySessionToken, getSessionFromReq } from "../lib/db.js";

// GET -> dipanggil dari WEB (browser operator) setelah login untuk memuat
//        konfigurasi terakhir yang tersimpan ke dalam form Settings.
//        Diautentikasi dengan sessionToken hasil login (BUKAN X-EA-Token
//        — itu dipakai khusus oleh EA di /api/ea-config, token rahasia
//        itu tidak boleh dikirim dari browser).
//
// Endpoint ini sengaja dipisah dari /api/ea-config supaya kedua konsumen
// (EA vs browser) tidak berbagi satu mekanisme auth yang salah sasaran.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const account = String(req.query.account || "").trim();
  if (!account) return res.status(400).json({ ok: false, error: "Parameter 'account' wajib diisi" });

  const token = getSessionFromReq(req);
  if (!verifySessionToken(token, account)) {
    return res.status(401).json({ ok: false, error: "Sesi tidak valid / sudah kedaluwarsa — silakan login ulang" });
  }

  const { data, error } = await supabase
    .from("accounts")
    .select("config")
    .eq("account_login", account)
    .maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: String(error) });

  const cfg = data?.config ?? null;
  return res.status(200).json({ ok: true, config: cfg });
}
