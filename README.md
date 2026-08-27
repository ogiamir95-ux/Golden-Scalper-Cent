# Panduan Update: Remote License Revocation

## Apa yang berubah
Sekarang saat admin klik **"Hapus Akun & Lisensi"** di panel admin, EA yang
sedang berjalan akan benar-benar dipaksa berhenti/keluar (sesuai pengaturan
`InpLicenseAction` yang sudah ada), bukan cuma menghapus baris di database
tanpa efek ke EA yang sedang jalan.

## Cara kerja singkat
1. Admin klik hapus → server **tidak langsung menghapus** baris akun, tapi
   menandainya `revoked = true` dan menitipkan `pending_command = "REVOKE"`.
2. EA yang sedang polling (`ea-update.js`, tiap ~3 detik, dan `ea-command.js`
   sebagai cadangan) menerima command `REVOKE`.
3. EA menjalankan aksi sesuai `InpLicenseAction` yang sudah kamu set di
   input EA (Finish Cycle+Stop / Finish Cycle+Remove / Close+Stop /
   Close+Remove) — **berlaku walau `InpLicenseCheckEnabled` dimatikan**,
   karena revoke adalah keputusan admin, bukan pengaturan lokal.
4. Setelah aksi selesai (posisi sudah ditutup / bot sudah berhenti), EA
   mengirim konfirmasi (`revokeAck: true`) ke server.
5. Server baru menghapus PERMANEN baris akun tersebut setelah menerima
   konfirmasi itu — supaya sinyal revoke tidak hilang kalau kebetulan EA
   sedang offline saat admin menghapus akun (server akan terus mengirim
   ulang `REVOKE` sampai EA online lagi dan meng-ack).

## File yang perlu di-update
| File | Lokasi di project | Perubahan |
|---|---|---|
| `schema.sql` | `supabase/schema.sql` | Tambah kolom `revoked`, `revoked_at` |
| `db.js` | `lib/db.js` | `deleteAccountData()` jadi revoke dulu (bukan hapus langsung) + fungsi baru `purgeRevokedAccount()` |
| `ea-update.js` | `api/ea-update.js` | Terima `revokeAck` dari EA, kirim ulang command `REVOKE` selama belum di-ack |
| `ea-command.js` | `api/ea-command.js` | Jalur cadangan juga konsisten terus mengirim `REVOKE` |
| `Golden_Scalper_Cent_Pro.mq5` | root project | Tangani command `REVOKE`, integrasi ke `InpLicenseAction`, kirim `revokeAck` |

`api/admin-users.js` **tidak perlu diubah** — endpoint DELETE-nya tetap
memanggil `deleteAccountData()` seperti sebelumnya, hanya perilaku di
dalam fungsi itu yang berubah.

## Langkah deploy
1. **Jalankan migrasi SQL di Supabase** (SQL Editor):
   ```sql
   alter table accounts add column if not exists revoked boolean not null default false;
   alter table accounts add column if not exists revoked_at timestamptz;
   ```
   (Sudah termasuk juga kalau kamu jalankan ulang seluruh `schema.sql` yang baru — aman, semua pakai `if not exists`.)
2. Ganti file `lib/db.js`, `api/ea-update.js`, `api/ea-command.js` dengan versi baru di paket ini.
3. Ganti `Golden_Scalper_Cent_Pro.mq5` dengan versi baru, lalu **compile ulang** di MetaEditor dan install ulang ke chart customer (atau kirim update ke customer untuk update EA mereka).
4. Deploy ulang project Vercel-nya (`vercel --prod` atau lewat git push, sesuai setup kamu).

## Catatan penting
- EA lama (belum update) yang masih terpasang di chart customer **tidak
  akan tahu soal command `REVOKE`** — command itu cuma diabaikan
  (`ExecuteWebCommand()` versi lama tidak mengenalinya), jadi fitur ini
  baru efektif setelah customer update EA-nya ke versi baru.
- Selama EA belum sempat online & meng-ack, baris akun tetap ada di
  database (berstatus `revoked = true`) — ini disengaja, supaya sinyal
  revoke tidak hilang. Kalau kamu ingin cara "paksa hapus langsung tanpa
  menunggu ack" tetap tersedia sebagai opsi darurat, beri tahu saya, nanti
  saya tambahkan tombol terpisah untuk itu.
