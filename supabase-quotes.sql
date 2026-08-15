-- =============================================================
--  Mr. Polish — "quotes" table for the dashboard's "הצעות מחיר"
--  (Price Quotes, formerly "הזמנת עבודה" / Work Order) tab.
--  Run this once in the Supabase SQL Editor.
--
--  Flow: Ori fills out the quote form and generates a PDF; the same
--  data is saved here so it shows up in the on-page quote history
--  (search, edit + re-save, re-download PDF). Private business data,
--  not public like reviews — no anon policy is created.
-- =============================================================

create extension if not exists "pgcrypto";

create table if not exists public.quotes (
  id          uuid primary key default gen_random_uuid(),
  number      integer not null,
  quote_date  text not null,            -- free-text date as shown on the form/PDF (not a picker)
  client_name text not null,
  address     text,
  description text,
  total       numeric(10,2) not null default 0,
  created_at  timestamptz not null default now()
);

-- One row per quote number; the admin panel derives the next number
-- from max(number)+1, so duplicates would silently overwrite history.
create unique index if not exists quotes_number_idx on public.quotes (number);

-- Fast lookup for the newest-first history list.
create index if not exists quotes_created_at_idx on public.quotes (created_at desc);

-- -------------------------------------------------------------
--  Row-Level Security
--  Only the authenticated admin (Ori, via login.html) may read
--  or write. No "anon" policy exists for this table.
-- -------------------------------------------------------------
alter table public.quotes enable row level security;

drop policy if exists "authenticated can manage quotes" on public.quotes;
create policy "authenticated can manage quotes"
  on public.quotes
  for all
  to authenticated
  using (true)
  with check (true);
