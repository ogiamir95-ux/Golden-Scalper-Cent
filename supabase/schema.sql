-- ============================================================
-- Golden Scalper Cent — Skema Supabase PostgreSQL
-- Jalankan file ini di Supabase SQL Editor (Project > SQL Editor > New query).
-- ============================================================

-- Tabel utama: satu baris per akun MT5 (accountLogin).
create table if not exists accounts (
  account_login        text primary key,
  state                jsonb,
  config               jsonb,
  pending_command      text,
  license_key_hash     text,
  license_expires_at   date,
  revoked              boolean not null default false,
  revoked_at           timestamptz,
  last_seen_at         timestamptz,
  updated_at           timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

-- Migrasi untuk database yang sudah ada sebelum kolom ini ditambahkan
-- (aman dijalankan berkali-kali — no-op jika kolom sudah ada).
alter table accounts add column if not exists license_expires_at date;
alter table accounts add column if not exists revoked boolean not null default false;
alter table accounts add column if not exists revoked_at timestamptz;

-- ============================================================
-- BLACKLIST LISENSI PERMANEN — terpisah & TIDAK ikut terhapus saat baris
-- `accounts` dihapus (baik lewat alur revoke normal maupun dihapus manual
-- oleh admin di Supabase). Begitu satu kode lisensi (diidentifikasi lewat
-- hash-nya, sama seperti license_key_hash) pernah di-revoke admin, hash
-- itu dicatat di sini SELAMANYA. Kalau EA yang sama dipasang ulang dan
-- mengirim kode lisensi yang SAMA (hash sama), server akan menolaknya
-- lagi walau baris `accounts` sudah tidak ada / sudah dianggap akun baru.
-- Kode lisensi BARU (hash berbeda) untuk akun yang sama tetap boleh dipakai.
-- ============================================================
create table if not exists revoked_licenses (
  license_key_hash text primary key,
  account_login    text,
  revoked_at       timestamptz not null default now(),
  reason           text
);

-- Dipakai oleh isAccountEverRevoked() di lib/db.js saat REGISTRASI akun
-- web baru: cek cepat apakah sebuah Akun ID (account_login) pernah punya
-- lisensi yang dicabut admin sebelumnya, supaya Akun ID bekas-revoke wajib
-- EA sync ulang dulu sebelum boleh daftar ulang akun web.
create index if not exists idx_revoked_licenses_account
  on revoked_licenses (account_login);

-- Log aktivitas EA
create table if not exists ea_logs (
  id            bigint generated always as identity primary key,
  account_login text not null references accounts(account_login) on delete cascade,
  text          text not null,
  type          text not null default 'info',
  created_at    timestamptz not null default now()
);

create index if not exists idx_ea_logs_account_created
  on ea_logs (account_login, created_at desc);

-- Jurnal harian P/L
create table if not exists journal_entries (
  account_login text not null references accounts(account_login) on delete cascade,
  entry_date    date not null,
  pnl           numeric not null default 0,
  pair          text not null default '',
  lot           numeric not null default 0,
  trades        integer not null default 0,
  win_rate      numeric not null default 0,
  note          text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (account_login, entry_date)
);

create index if not exists idx_journal_account_date
  on journal_entries (account_login, entry_date);

-- Fungsi util: auto-update kolom updated_at setiap kali baris diubah.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_accounts_updated_at on accounts;
create trigger trg_accounts_updated_at
  before update on accounts
  for each row execute function set_updated_at();

-- ============================================================
-- Akun login WEB (Gmail + password) — TERPISAH dari data EA/MT5 di
-- tabel `accounts`. Ini hanya lapisan identitas untuk masuk ke panel;
-- validasi lisensi EA (real-time) tetap dilakukan seperti sebelumnya
-- terhadap `accounts.state`.
--
-- account_login SENGAJA TIDAK punya foreign key ke accounts(account_login).
-- Sebelumnya ada constraint `references accounts(account_login)` yang
-- mewajibkan Akun ID MT5 sudah ada baris di `accounts` (artinya EA sudah
-- pernah sync) SEBELUM bisa daftar akun web — ini salah utk Akun ID yang
-- BELUM PERNAH terdaftar sama sekali (harus bebas daftar, tunggu approve
-- admin, EA tidak wajib online dulu). Aturan "wajib EA sync dulu" HANYA
-- berlaku utk Akun ID yang PERNAH di-revoke admin sebelumnya, dan itu
-- sudah divalidasi di level aplikasi lewat isAccountEverRevoked() di
-- api/auth-register.js — bukan lewat constraint database ini.
-- ============================================================
create table if not exists web_users (
  id                bigint generated always as identity primary key,
  email             text not null unique,
  password_hash     text not null,
  account_login     text,
  role              text not null default 'user',
  status            text not null default 'pending',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Migrasi utk database yang sudah ada: hapus foreign key constraint lama
-- di kolom account_login (aman dijalankan berkali-kali, no-op jika sudah
-- tidak ada). INI YANG PERLU DIJALANKAN kalau tabel web_users sudah
-- dibuat sebelumnya dengan constraint tsb.
alter table web_users drop constraint if exists web_users_account_login_fkey;

create index if not exists idx_web_users_email on web_users (lower(email));

drop trigger if exists trg_web_users_updated_at on web_users;
create trigger trg_web_users_updated_at
  before update on web_users
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table accounts enable row level security;
alter table ea_logs enable row level security;
alter table journal_entries enable row level security;
alter table web_users enable row level security;
alter table revoked_licenses enable row level security;

-- ============================================================
-- MIGRASI (jalankan ini SAJA di Supabase SQL Editor jika database
-- sudah pernah dibuat sebelumnya — cukup sekali, aman diulang):
-- ============================================================
-- alter table accounts add column if not exists license_expires_at date;
-- alter table accounts add column if not exists revoked boolean not null default false;
-- alter table accounts add column if not exists revoked_at timestamptz;
-- create table if not exists revoked_licenses (
--   license_key_hash text primary key,
--   account_login    text,
--   revoked_at       timestamptz not null default now(),
--   reason           text
-- );
-- alter table revoked_licenses enable row level security;

-- ============================================================
-- Membuat admin PERTAMA — jalankan manual satu kali di SQL Editor
-- setelah mengganti email & password di bawah (password di-hash pakai
-- bcrypt secara terpisah, lihat README). JANGAN commit kredensial asli ke repo.
-- ============================================================
-- insert into web_users (email, password_hash, role, status)
-- values ('admin@email-anda.com', '<BCRYPT_HASH_DI_SINI>', 'admin', 'approved');
