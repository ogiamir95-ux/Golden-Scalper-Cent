# Golden Cent Scalper Pro — Web Panel Real-Time

Integrasi dashboard web (tampilan **tidak diubah sama sekali**) dengan EA MQL5
`GoldenScalperPro_WebIntegrated.mq5` melalui jembatan API di Vercel + database
Upstash Redis.

## Cara kerja singkat

```
EA (MT5 Terminal)  --WebRequest POST tiap 3 detik-->  /api/ea-update  --> Redis
                    <--balasan berisi perintah tertunda--

Browser (dashboard) --polling GET tiap 3 detik-->      /api/state     <-- Redis
Browser (tombol Start/Stop/CloseAll/Reset) --POST-->    /api/ea-command --> Redis
Browser (Simpan Perubahan setting) --POST-->            /api/ea-config  --> Redis
```

EA **tidak menerima koneksi masuk** (MT5 tidak bisa jadi server), jadi arah
komunikasinya: EA yang aktif memanggil keluar (push data + polling perintah),
bukan sebaliknya.

## ⚠️ Update Keamanan: Lisensi Sekarang Terikat ke 1 Akun MT5

Sebelumnya, kode lisensi hanya divalidasi lewat format + checksum + tanggal
expired — **tidak terikat ke akun manapun**, sehingga satu kode bisa dipakai
ulang di banyak akun MT5 / dibagikan ke banyak orang tanpa ditolak oleh EA.
Ini sudah diperbaiki:

- Format kode lisensi berubah dari 5 segmen menjadi **6 segmen**:
  `BLOK1-BLOK2-BLOK3-NOMORAKUN-TANGGALEXPIRE-CHECKSUM`
  (contoh: `A1B2-C3D4-E5F6-12345678-20260915-042`)
- `LicenseKeyGenerator.mq5` (`Licensi_Scalper_Cent.mq5`) sekarang **wajib**
  diisi `InpTargetAccount` = nomor akun MT5 customer tujuan. Kode yang
  dihasilkan hanya mengandung checksum yang valid untuk akun tsb.
- EA (`GoldenScalperPro_WebIntegrated.mq5`) mengecek `AccountInfoInteger(ACCOUNT_LOGIN)`
  saat ini terhadap nomor akun yang tertanam di kode. Jika tidak cocok,
  lisensi otomatis **INVALID** meski checksum & tanggal masih benar.
- Konsekuensi: **satu kode lisensi hanya bisa dipakai di satu akun MT5**.
  Kalau customer ganti akun, mereka butuh kode baru (generate ulang dengan
  `InpTargetAccount` yang baru).
- Ini melengkapi lapisan TOFU-binding yang sudah ada di web (lihat bagian
  "Multi-User" di bawah) — sekarang proteksi anti-pembajakan berlaku dari
  sisi EA itu sendiri, bukan cuma dari sisi dashboard web.

**Catatan:** algoritma checksum tetap checksum ringan (bukan HMAC/SHA), jadi
ini menaikkan level kesulitan pembajakan (harus tahu rumus checksum DAN
nomor akun target), tapi bukan proteksi kriptografis penuh. Untuk produk
komersial serius, upgrade ke `CryptEncode` (SHA-256) tetap disarankan.

## Login Real-Time (Username = Akun MT5, Password = Kode Lisensi)

Halaman login **tidak lagi menerima username/password asal isi**. Alurnya:

1. Operator memasukkan **Username = Nomor Akun MT5** dan **Password = Kode
   Lisensi EA** (kode yang sama yang diisi di `InpLicenseKey` pada EA).
2. Web mengirim POST ke `/api/auth-login`.
3. Server mencocokkan input dengan **data asli terakhir yang dikirim EA**:
   - `accountLogin` harus sama dengan username yang diisi.
   - Hash kode lisensi (`licenseKeyHash`, dihitung EA dengan fungsi
     `LicenseKeyHash()` di MQL5) harus cocok dengan hash password yang diisi.
   - `licenseStatus` yang dikirim EA harus `"VALID"` (bukan hasil cek di
     browser).
   - EA harus **online** (mengirim heartbeat < 20 detik terakhir).
4. Jika lisensi EA berstatus `EXPIRED`/`INVALID`, atau EA offline, atau akun/
   kode tidak cocok — login **ditolak** dengan pesan yang sesuai.
5. Selama sesi berjalan, dashboard terus polling `/api/state`. Begitu status
   lisensi EA berubah menjadi tidak valid (mis. lisensi habis di tengah sesi)
   atau EA terputus, sistem **otomatis logout** operator dari dashboard.

Kode lisensi asli **tidak pernah dikirim/disimpan dalam bentuk plaintext**
ke server — EA hanya mengirim hash-nya (`LicenseKeyHash()` di `.mq5`, harus
identik dengan `simpleHash()` di `lib/redis.js`).

## Multi-User / Multi-Tenant (siap dijual ke banyak customer)

Sistem ini sudah didesain agar **satu deployment Vercel + satu database
Redis** bisa dipakai banyak customer sekaligus (masing-masing dengan EA &
akun MT5 sendiri), tanpa data mereka saling tertimpa atau bisa saling
diintip/dikontrol.

**Partisi data:** setiap key di Redis diberi namespace per akun MT5
(`accountLogin`), contoh: `gsp:state:12345678`, `gsp:heartbeat:12345678`,
dst. (lihat `keys()` di `lib/redis.js`). Karena `accountLogin` sudah otomatis
dikirim EA di setiap update, **file `.mq5` tidak perlu diubah sama sekali** —
setiap customer tinggal pasang EA seperti biasa dengan `InpLicenseKey`
masing-masing.

**Isolasi antar customer dijaga dengan 2 lapis:**

1. **TOFU binding (EA → server).** Pertama kali sebuah `accountLogin`
   terlihat oleh `/api/ea-update`, hash lisensinya dikunci ke akun tsb. Jika
   ada request berikutnya mengaku sebagai akun yang sama tapi hash lisensi
   berbeda, request ditolak (409). Ini mencegah data satu customer ditimpa
   oleh pihak lain yang kebetulan/sengaja memakai nomor akun MT5 yang sama.
   Untuk kasus support yang sah (customer ganti lisensi), admin cukup hapus
   key `gsp:eatoken:<accountLogin>` di Upstash.
2. **Session token (browser → server).** Setelah `/api/auth-login` berhasil
   (akun + kode lisensi cocok, EA online, lisensi VALID), server menerbitkan
   `sessionToken` (HMAC bertanda waktu, expired 12 jam, ditandatangani dengan
   `SESSION_SECRET`). Semua panggilan berikutnya dari dashboard —
   `/api/state`, `/api/ea-command`, `/api/ea-config` — WAJIB menyertakan
   `?account=` yang sesuai dan header `Authorization: Bearer <sessionToken>`.
   Tanpa token yang valid & cocok dengan akun yang diminta, request ditolak
   (401). Ini mencegah satu customer mengintip saldo atau mengirim
   START/STOP/CLOSEALL ke akun customer lain hanya dengan menebak nomor akun.

**`EA_SHARED_TOKEN`** tetap dipakai sebagai gerbang akses tingkat aplikasi —
mencegah pihak luar (bukan EA manapun) menembak endpoint `/api/ea-update`,
`/api/ea-command` (GET), dan `/api/ea-config` (GET) sama sekali. Ini berbeda
fungsi dari isolasi per-customer di atas; token ini sama untuk **semua**
EA/customer yang terhubung ke deployment Anda.

**Yang perlu Anda isi sendiri sebelum menjual produk ini:**
- `EA_SHARED_TOKEN` — satu token rahasia untuk seluruh instalasi.
- `SESSION_SECRET` — secret rahasia terpisah untuk menandatangani session
  login (jangan pakai contoh di `.env.example`, buat string acak panjang).
- Setiap customer membeli/mendapat `InpLicenseKey` masing-masing (unik per
  lisensi, sudah jadi mekanisme lisensi bawaan EA) — itu otomatis menjadi
  "password" mereka di dashboard, tidak perlu sistem akun terpisah.

**Belum termasuk dalam revisi ini (opsional untuk pengembangan lanjutan):**
panel admin untuk melihat daftar semua customer aktif (data mentahnya sudah
tersedia di Redis set `gsp:accounts`), pencabutan lisensi paksa dari sisi
web, dan rate-limiting per akun.

## Jurnal Kalender (Kalender Profit / Loss)

Menu baru **"Jurnal Kalender"** di sidebar (di bawah Download EA) menampilkan
kalender bulanan dengan hasil profit/loss harian, mirip jurnal trading.

- **P/L otomatis**: setiap kali EA sync ke `/api/ea-update`, server otomatis
  mencatat `achievedToday` (P/L hari berjalan) & simbol ke entri jurnal
  tanggal hari itu (zona waktu WIB) — field ini TIDAK bisa diubah manual.
- **Catatan manual**: tap kotak tanggal yang ada datanya untuk membuka form
  Pair / Lot / Jumlah Trades / Win Rate / Catatan — operator mengisi sendiri
  lalu simpan lewat `/api/journal.js` (POST). Field-field ini tidak akan
  tertimpa oleh sync otomatis EA berikutnya.
- Data disimpan per akun di Redis hash `gsp:journal:{accountLogin}`
  (field = tanggal `YYYY-MM-DD`), jadi otomatis ikut ter-isolasi per customer
  sama seperti data lainnya (lihat bagian Multi-User di atas).
- Endpoint `/api/journal` (GET & POST) memakai autentikasi `sessionToken`
  yang sama dengan `/api/state` dkk.

## Struktur folder

```
/api/auth-login.js   -> Web POST login (validasi akun MT5 + kode lisensi real-time ke EA)
/api/ea-update.js    -> EA POST snapshot data (equity, floating, layers, dst)
/api/ea-command.js   -> Web POST perintah (START/STOP/CLOSEALL/RESET); EA GET untuk ambil
/api/ea-config.js    -> Web POST konfigurasi setting; EA GET untuk ambil
/api/state.js        -> Web GET untuk polling data real-time ke dashboard
/lib/redis.js         -> Koneksi Upstash Redis + util bersama
/public/index.html    -> Dashboard (tampilan ASLI, hanya logika data yang diganti)
GoldenScalperPro_WebIntegrated.mq5 -> EA hasil integrasi (compile ulang di MetaEditor)
vercel.json
package.json
```

## Langkah Deploy ke Vercel

### 1. Buat Database Upstash (via Vercel Marketplace)
1. Buka dashboard project di Vercel → tab **Storage** → **Create Database**.
2. Pilih **Upstash** → **Redis** (paket gratis sudah cukup).
3. Setelah dibuat, Vercel otomatis mengisi environment variable
   `KV_REST_API_URL` dan `KV_REST_API_TOKEN` ke project Anda — tidak perlu
   diisi manual.

### 2. Set Environment Variable
Di **Project Settings → Environment Variables**, tambahkan:
| Key | Value |
|---|---|
| `EA_SHARED_TOKEN` | token rahasia bebas, contoh: `gsp_9x8K2m...` (buat sendiri, jangan pakai contoh ini) |

### 3. Deploy
- **Via Vercel CLI:**
  ```bash
  npm i -g vercel
  cd folder-project-ini
  vercel --prod
  ```
- **Via GitHub:** push folder ini ke repo GitHub, lalu **Import Project** di
  Vercel dan hubungkan repo tersebut. Deploy otomatis setiap push.

Setelah deploy, Anda akan mendapat domain seperti:
`https://golden-scalper-pro-panel.vercel.app`

### 4. Setting EA di MetaTrader 5
1. Buka file `GoldenScalperPro_WebIntegrated.mq5` di **MetaEditor**, compile
   (F7) menjadi `.ex5`.
2. Di MT5: **Tools → Options → Expert Advisors** → centang
   **Allow WebRequest for listed URL** → tambahkan domain Vercel Anda persis,
   contoh: `https://golden-scalper-pro-panel.vercel.app` (tanpa slash di akhir,
   harus **https**).
3. Pasang EA di chart, isi parameter:
   - `InpWebEnabled` = true
   - `InpWebBaseUrl` = `https://golden-scalper-pro-panel.vercel.app`
   - `InpWebToken` = token yang sama persis dengan `EA_SHARED_TOKEN` di Vercel
   - `InpWebIntervalSec` = 3 (atau sesuai kebutuhan)

### 5. Cek koneksi
- Buka dashboard web Anda → badge mode di sidebar bawah akan berubah dari
  **"MODE SIMULASI"** menjadi **"TERHUBUNG — DATA LIVE"** dalam beberapa detik
  setelah EA berjalan dan berhasil mengirim data pertamanya.
- Jika muncul **"EA OFFLINE / MENUNGGU KONEKSI"** terus, cek tab **Experts** di
  MT5 untuk pesan error WebRequest (biasanya error 4060 = domain belum
  ditambahkan ke whitelist).

## Catatan penting
- Tampilan (`HTML`/`CSS`) dashboard **sama persis** dengan file asli — hanya
  bagian JavaScript yang tadinya memakai data simulasi (`random-walk`) kini
  diganti membaca data asli dari EA lewat polling `/api/state`.
- Login sekarang **divalidasi real-time ke EA** lewat `/api/auth-login`
  (lihat bagian "Login Real-Time" di atas) — bukan lagi front-end only.
  Pastikan EA sudah aktif dan pernah mengirim minimal satu update sebelum
  operator mencoba login pertama kali.
- Field lisensi di halaman "Lisensi" (`licKeyInput` + tombol Validasi) tetap
  memvalidasi checksum di sisi browser seperti sebelumnya (untuk generate/cek
  format kode) — namun **gerbang login** memakai `licenseStatus` asli dari EA,
  bukan hasil cek browser ini. Status **lisensi** yang tampil di kartu
  ringkasan (`rowLicense`) juga mengikuti status asli dari EA begitu terhubung.
- Karena hash lisensi (`licenseKeyHash`) dihitung dengan algoritma checksum
  ringan (bukan bcrypt/SHA — MQL5 tidak punya library itu secara native),
  keamanannya bertumpu pada kombinasi HTTPS + `EA_SHARED_TOKEN` rahasia di
  endpoint `/api/ea-update`. Untuk kebutuhan keamanan lebih tinggi, algoritma
  hash bisa di-upgrade ke SHA-256 (tersedia di MQL5 lewat `CryptEncode`).
