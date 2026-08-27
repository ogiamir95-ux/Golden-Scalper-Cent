# Update: Blacklist Lisensi Permanen (Anti Pasang-Ulang)

## Masalah yang diperbaiki
Sebelumnya, kalau kamu hapus baris `accounts` (baik lewat alur revoke
normal, maupun dihapus manual di Supabase), lalu EA yang sama dipasang
ulang dengan **kode lisensi yang sama**, EA akan dianggap "akun baru"
oleh server (TOFU) dan lisensinya jadi VALID lagi — padahal sudah pernah
di-revoke admin.

## Solusi
Kode lisensi (diidentifikasi lewat hash-nya) yang pernah di-revoke
sekarang dicatat di tabel baru **`revoked_licenses`** yang PERMANEN —
tidak ikut terhapus meski baris `accounts`-nya dihapus. Setiap EA sync,
server cek hash kode lisensi yang dikirim EA terhadap tabel ini **sebelum**
logika lain — kalau cocok, server langsung membalas command `REVOKE` lagi,
walau baris `accounts`-nya sudah tidak ada / dianggap baru.

**Kode lisensi baru** (hash beda) untuk akun yang sama **tetap boleh
dipakai normal** — blacklist ini spesifik ke kode lama yang di-revoke,
bukan ke nomor akun MT5-nya.

## File yang perlu di-update
| File | Lokasi | Perubahan |
|---|---|---|
| `schema.sql` | `supabase/schema.sql` | Tabel baru `revoked_licenses` |
| `db.js` | `lib/db.js` | `deleteAccountData()` sekarang juga menulis hash ke blacklist; fungsi baru `isLicenseRevoked()` |
| `ea-update.js` | `api/ea-update.js` | Cek blacklist di awal, sebelum TOFU — balas `REVOKE` kalau hash cocok |

File `.mq5` dan `ea-command.js` **tidak berubah** di update ini (masih pakai versi sebelumnya).

## Langkah deploy
1. **Jalankan SQL ini di Supabase SQL Editor:**
   ```sql
   create table if not exists revoked_licenses (
     license_key_hash text primary key,
     account_login    text,
     revoked_at       timestamptz not null default now(),
     reason           text
   );
   alter table revoked_licenses enable row level security;
   ```
2. Ganti `lib/db.js` dan `api/ea-update.js` dengan versi baru di paket ini.
3. Deploy ulang ke Vercel.

## Cara kerja setelah update
- Admin klik "Hapus Akun & Lisensi" → hash kode lisensi yang sedang aktif
  di akun itu langsung dicatat permanen ke `revoked_licenses`, baris
  `accounts` ditandai revoked seperti sebelumnya.
- EA yang online → menerima command `REVOKE`, jalankan aksi sesuai
  `InpLicenseAction`, kirim `revokeAck` → baris `accounts` terhapus.
- **Kalau EA yang sama dipasang ulang dengan kode lisensi lama** (walau
  baris `accounts` sudah tidak ada lagi): sync pertama EA akan langsung
  dibalas `REVOKE` oleh server, karena hash-nya sudah ada di blacklist.
- Kalau kamu generate **kode lisensi baru** untuk akun itu, kode baru ini
  hash-nya beda → tidak kena blacklist → EA jalan normal seperti biasa.

## Catatan
- Blacklist ini **tidak ada cara hapus dari UI** (memang sengaja permanen).
  Kalau suatu saat kamu perlu "un-blacklist" satu kode lisensi tertentu
  (misal salah revoke), itu perlu dihapus manual lewat SQL:
  ```sql
  delete from revoked_licenses where license_key_hash = 'HASH_DI_SINI';
  ```
  Beri tahu saya kalau mau saya buatkan tombol khusus untuk ini di admin panel.
