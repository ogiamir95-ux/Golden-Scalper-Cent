-- ============================================================
-- Golden Scalper Cent — Skema Supabase PostgreSQL
-- Pengganti struktur Redis (lihat lib/redis.js versi lama).
-- Jalankan file ini di Supabase SQL Editor (Project > SQL Editor > New query).
-- ============================================================

-- Tabel utama: satu baris per akun MT5 (accountLogin).
-- Menggantikan: gsp:state, gsp:heartbeat, gsp:command, gsp:config, gsp:eatoken
create table if not exists accounts (
  account_login     text primary key,
  state             jsonb,                -- snapshot terakhir dari EA (equity, balance, dll)
  config            jsonb,                -- konfigurasi yang diset dari web panel
  pending_command   text,                 -- perintah tertunda: START/STOP/CLOSEALL/RESET/NONE
  license_key_hash  text,                 -- hash lisensi yang dikirim EA (TOFU binding)
  last_seen_at      timestamptz,          -- heartbeat terakhir (dipakai utk cek online/offline)
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

-- Log aktivitas EA (menggantikan Redis list gsp:log:{account}, LPUSH + LTRIM 30).
-- Disimpan sebagai tabel biasa, diambil dengan ORDER BY created_at DESC LIMIT N.
create table if not exists ea_logs (
  id            bigint generated always as identity primary key,
  account_login text not null references accounts(account_login) on delete cascade,
  text          text not null,
  type          text not null default 'info',
  created_at    timestamptz not null default now()
);

create index if not exists idx_ea_logs_account_created
  on ea_logs (account_login, created_at desc);

-- Jurnal harian P/L (menggantikan Redis hash gsp:journal:{account}, field = YYYY-MM-DD).
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

-- Fungsi util: auto-update kolom updated_at setiap kali baris accounts diubah.
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
-- Row Level Security
-- Semua akses dari API dilakukan lewat SERVICE ROLE KEY (server-side di
-- Vercel), yang otomatis bypass RLS. RLS diaktifkan di sini sebagai lapisan
-- pertahanan tambahan supaya anon/public key (jika suatu saat bocor atau
-- dipakai keliru) TIDAK bisa membaca/menulis tabel ini langsung dari
-- browser. Tidak ada policy yang dibuat untuk anon/authenticated, artinya
-- default-nya deny-all bagi siapa pun selain service_role.
-- ============================================================
alter table accounts enable row level security;
alter table ea_logs enable row level security;
alter table journal_entries enable row level security;
