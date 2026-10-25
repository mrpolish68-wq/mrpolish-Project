-- =============================================================
--  Mr. Polish — Telegram price quotes (Phase 3): DB migration
--
--  Adds what the Telegram bot needs to create price quotes (הצעות מחיר) and the admin panel
--  needs to show them live:
--    1. new columns on public.quotes (source, vat_mode, pdf_path, telegram_chat_id, updated_at)
--    2. a BEFORE UPDATE trigger (updated_at + invalidate a stale stored PDF)
--    3. race-safe numbering: public.quote_counter + public.create_quote(jsonb)
--    4. bot state tables (RLS on, zero policies → service_role only)
--    5. daily quota functions (service_role only)
--    6. storage: private "quotes-pdf" bucket + limits on the "receipts" bucket
--    7. realtime: public.quotes joins the supabase_realtime publication
--    8. retention notes (sweeps run in code)
--
--  IDEMPOTENT: every statement is guarded (if not exists / create or replace / on conflict /
--  do $$ … $$ checks), so re-running it is a no-op. Safe for existing quotes: new columns get
--  defaults (source='panel', vat_mode='exempt'), and every new check passes for panel rows.
--  The panel's current direct insert/update on public.quotes keeps working unchanged.
--
--  Apply with Supabase MCP apply_migration (runs as one transaction) or the SQL Editor.
--  A commented ROLLBACK section is at the bottom.
--
--  TEST-DATA RULE: any test that calls create_quote() or consume_daily_quota() against the
--  LIVE project MUST run inside a single transaction that is ROLLED BACK (begin … rollback),
--  so no quote number is consumed and quote_counter.floor_next stays at 14. Before launch
--  (Phase 7): delete any test quotes/rows, then set
--  quote_counter.floor_next = greatest(max(number)+1, 14) and verify.
-- =============================================================


-- -------------------------------------------------------------
-- 1. public.quotes — new columns + checks
-- -------------------------------------------------------------
-- source:           who created the row. Existing rows and the panel get 'panel'.
-- vat_mode:         drives the VAT line in shared/quote-template.js. Only 'exempt' is rendered
--                   today; 'licensed' is reserved.
-- pdf_path:         object path of the server-rendered PDF in the private "quotes-pdf" bucket.
--                   NULL = no stored PDF (panel quotes, or invalidated by an edit — see trigger).
-- telegram_chat_id: the chat that created a bot quote (where the PDF is sent back). Panel: NULL.
-- updated_at:       last change, maintained by the trigger below.
-- There is deliberately NO client phone column (owner decision: no client phone anywhere).
alter table public.quotes add column if not exists source           text        not null default 'panel';
alter table public.quotes add column if not exists vat_mode         text        not null default 'exempt';
alter table public.quotes add column if not exists pdf_path         text;
alter table public.quotes add column if not exists telegram_chat_id bigint;
alter table public.quotes add column if not exists updated_at       timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_source_check') then
    alter table public.quotes add constraint quotes_source_check check (source in ('panel', 'telegram'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_vat_mode_check') then
    alter table public.quotes add constraint quotes_vat_mode_check check (vat_mode in ('exempt', 'licensed'));
  end if;
  -- Price rule: the AI never invents a price, so a bot quote must carry a real total.
  -- (total defaults to 0, so "not null" alone is not enough.) Panel rows are unaffected —
  -- one existing panel quote has total = 0 and stays valid.
  if not exists (select 1 from pg_constraint where conrelid = 'public.quotes'::regclass and conname = 'quotes_telegram_total_check') then
    alter table public.quotes add constraint quotes_telegram_total_check check (source <> 'telegram' or total > 0);
  end if;
end $$;


-- -------------------------------------------------------------
-- 2. Trigger: keep updated_at fresh, and drop a stale stored PDF
-- -------------------------------------------------------------
-- When any field printed on the PDF changes (number, date, client, address, description,
-- total, VAT mode), the stored PDF no longer matches the row, so pdf_path is cleared and the
-- PDF is regenerated on demand. Exception: an update that sets pdf_path itself (the server
-- storing a freshly rendered PDF) is left alone.
create or replace function public.quotes_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  if new.pdf_path is not distinct from old.pdf_path
     and (   new.number      is distinct from old.number
          or new.quote_date  is distinct from old.quote_date
          or new.client_name is distinct from old.client_name
          or new.address     is distinct from old.address
          or new.description is distinct from old.description
          or new.total       is distinct from old.total
          or new.vat_mode    is distinct from old.vat_mode) then
    new.pdf_path := null;
  end if;
  return new;
end;
$$;

revoke all on function public.quotes_before_update() from public, anon, authenticated;

drop trigger if exists quotes_before_update on public.quotes;
create trigger quotes_before_update
  before update on public.quotes
  for each row execute function public.quotes_before_update();


-- -------------------------------------------------------------
-- 3. Numbering: one source of truth in the DB
-- -------------------------------------------------------------
-- quote_counter is a single-row table holding the lowest number the next quote may get.
-- Seeded to 14 (owner-confirmed: the last issued number is 13). create_quote() raises it
-- after every insert, so a number is never reused even if the newest quote is deleted.
-- RLS on with zero policies + no grants: only SECURITY DEFINER functions touch it.
create table if not exists public.quote_counter (
  id         boolean primary key default true check (id),   -- singleton: the only allowed key is true
  floor_next integer not null check (floor_next >= 1)
);
alter table public.quote_counter enable row level security;
revoke all on table public.quote_counter from anon, authenticated;

-- "do nothing" on re-run: never lowers a floor that create_quote() has already raised.
insert into public.quote_counter (id, floor_next) values (true, 14)
on conflict (id) do nothing;

-- create_quote(p jsonb) → public.quotes
-- Used by BOTH the bot (service_role) and, from Phase 6, the panel (authenticated).
-- Keys read from p: client_name, address, description, total, quote_date, vat_mode,
-- and — honored ONLY for service_role — source, telegram_chat_id.
-- Numbering is serialized with a transaction-scoped advisory lock, so two concurrent callers
-- can never compute the same number: next = greatest(max(number)+1, floor_next).
-- Caller detection: SECURITY DEFINER switches current_user to the owner, so current_user can't
-- tell us who called. The caller counts as the bot (service_role) if ANY of these says so:
--   1. request.jwt.claims ->> 'role'   — PostgREST's JWT claims (legacy JWT service key);
--   2. current_setting('role')         — the role PostgREST switched to with SET LOCAL ROLE.
--                                        This also covers Supabase's newer secret API keys,
--                                        whose requests may not carry a JWT 'role' claim;
--                                        SECURITY DEFINER does not change this setting;
--   3. request.jwt.claim.role          — the pre-v9 PostgREST per-claim setting (legacy).
-- None of these can be set by an API client: PostgREST derives them from the verified key.
create or replace function public.create_quote(p jsonb)
returns public.quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims     text    := nullif(pg_catalog.current_setting('request.jwt.claims', true), '');
  v_is_service boolean := coalesce((v_claims::jsonb ->> 'role') = 'service_role', false)
                          or coalesce(pg_catalog.current_setting('role', true) = 'service_role', false)
                          or coalesce(pg_catalog.current_setting('request.jwt.claim.role', true) = 'service_role', false);
  v_client     text    := btrim(coalesce(p ->> 'client_name', ''));
  v_date       text    := btrim(coalesce(p ->> 'quote_date', ''));
  v_vat        text    := coalesce(nullif(btrim(p ->> 'vat_mode'), ''), 'exempt');
  v_source     text    := 'panel';
  v_chat       bigint  := null;
  v_total      numeric(10,2);
  v_next       integer;
  v_row        public.quotes;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'create_quote: payload must be a JSON object' using errcode = '22023';
  end if;
  if v_client = '' then
    raise exception 'create_quote: client_name is required' using errcode = '22023';
  end if;
  if v_date = '' then
    raise exception 'create_quote: quote_date is required' using errcode = '22023';
  end if;
  if v_vat not in ('exempt', 'licensed') then
    raise exception 'create_quote: invalid vat_mode' using errcode = '22023';
  end if;

  begin
    v_total := coalesce(nullif(btrim(p ->> 'total'), ''), '0')::numeric(10,2);
  exception when others then
    raise exception 'create_quote: total must be a number' using errcode = '22023';
  end;
  if v_total < 0 then
    raise exception 'create_quote: total cannot be negative' using errcode = '22023';
  end if;

  if v_is_service then
    -- The bot: the final total is always stated by Ori/Miri, never invented.
    if v_total <= 0 then
      raise exception 'create_quote: total must be greater than 0' using errcode = '22023';
    end if;
    v_source := coalesce(nullif(btrim(p ->> 'source'), ''), 'panel');
    if v_source not in ('panel', 'telegram') then
      raise exception 'create_quote: invalid source' using errcode = '22023';
    end if;
    if v_source = 'telegram' then
      begin
        v_chat := (p ->> 'telegram_chat_id')::bigint;
      exception when others then
        raise exception 'create_quote: telegram_chat_id must be an integer' using errcode = '22023';
      end;
      if v_chat is null then
        raise exception 'create_quote: telegram_chat_id is required for telegram quotes' using errcode = '22023';
      end if;
    end if;
  end if;
  -- authenticated callers (the panel) always get source = 'panel', telegram_chat_id = NULL.

  -- Fixed app-wide lock key for quote numbering (released at commit/rollback).
  perform pg_catalog.pg_advisory_xact_lock(7243100001);

  select greatest(coalesce(max(q.number), 0) + 1,
                  (select c.floor_next from public.quote_counter c where c.id))
    into v_next
    from public.quotes q;

  insert into public.quotes (number, quote_date, client_name, address, description, total,
                             source, vat_mode, telegram_chat_id)
  values (v_next, v_date, v_client,
          nullif(btrim(p ->> 'address'), ''),
          nullif(p ->> 'description', ''),
          v_total, v_source, v_vat, v_chat)
  returning * into v_row;

  update public.quote_counter set floor_next = greatest(floor_next, v_next + 1) where id;

  return v_row;
end;
$$;

revoke all on function public.create_quote(jsonb) from public, anon;
grant execute on function public.create_quote(jsonb) to authenticated, service_role;


-- -------------------------------------------------------------
-- 4. Bot state tables — RLS on, ZERO policies → service_role only
-- -------------------------------------------------------------
-- The webhook uses the service_role key (bypasses RLS). anon/authenticated get no grants
-- either, as defense in depth on top of "RLS with no policies".

-- Keeps updated_at current on bot tables.
create or replace function public.telegram_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function public.telegram_set_updated_at() from public, anon, authenticated;

-- A quote draft being reviewed/edited in a chat, before approval.
-- draft: { client_name, address, description, total, quote_date, transcript }.
-- The transcript lives ONLY here and is deleted with the row on approve/cancel (privacy).
-- awaiting_edit_field + awaiting_since: which field the next message edits, and since when
-- (freshness is measured from the edit tap, not from created_at).
-- claimed_at: claim/lease before create_quote(), so a double-tapped ✅ can't create two quotes.
create table if not exists public.telegram_pending_quotes (
  id                  uuid primary key default gen_random_uuid(),
  chat_id             bigint not null,
  draft               jsonb not null default '{}'::jsonb,
  message_id          bigint,
  awaiting_edit_field text check (awaiting_edit_field in ('client_name', 'address', 'description', 'total', 'quote_date', 'voice')),
  awaiting_since      timestamptz,
  voice_corrections   integer not null default 0 check (voice_corrections between 0 and 3),
  claimed_at          timestamptz,
  quote_id            uuid references public.quotes (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
-- Latest draft per chat (routing, edits) and the 24h sweep.
create index if not exists telegram_pending_quotes_chat_idx    on public.telegram_pending_quotes (chat_id, created_at desc);
create index if not exists telegram_pending_quotes_created_idx on public.telegram_pending_quotes (created_at);
create index if not exists telegram_pending_quotes_quote_idx   on public.telegram_pending_quotes (quote_id) where quote_id is not null;
alter table public.telegram_pending_quotes enable row level security;
revoke all on table public.telegram_pending_quotes from anon, authenticated;
drop trigger if exists telegram_pending_quotes_set_updated_at on public.telegram_pending_quotes;
create trigger telegram_pending_quotes_set_updated_at
  before update on public.telegram_pending_quotes
  for each row execute function public.telegram_set_updated_at();

-- Menu-level state not tied to a draft (e.g. 'idle', 'collecting_quote', 'awaiting_search').
-- Lower-case snake_case names, so new states need no migration.
create table if not exists public.telegram_chat_state (
  chat_id     bigint primary key,
  state       text not null default 'idle' check (state ~ '^[a-z_]{1,40}$'),
  state_since timestamptz not null default now(),
  context     jsonb not null default '{}'::jsonb
);
create index if not exists telegram_chat_state_since_idx on public.telegram_chat_state (state_since);
alter table public.telegram_chat_state enable row level security;
revoke all on table public.telegram_chat_state from anon, authenticated;

-- Telegram update_ids already handled: dedupes webhook redeliveries.
create table if not exists public.telegram_processed_updates (
  update_id  bigint primary key,
  created_at timestamptz not null default now()
);
create index if not exists telegram_processed_updates_created_idx on public.telegram_processed_updates (created_at);
alter table public.telegram_processed_updates enable row level security;
revoke all on table public.telegram_processed_updates from anon, authenticated;

-- Daily usage counters, GLOBAL across all chats (owner decision), per Israel calendar day.
create table if not exists public.telegram_daily_usage (
  day   date not null,                                   -- (now() at time zone 'Asia/Jerusalem')::date
  kind  text not null check (kind in ('quote', 'receipt')),
  count integer not null default 0 check (count >= 0),
  primary key (day, kind)
);
alter table public.telegram_daily_usage enable row level security;
revoke all on table public.telegram_daily_usage from anon, authenticated;


-- -------------------------------------------------------------
-- 5. Daily quota functions — service_role only
-- -------------------------------------------------------------
-- consume_daily_quota: atomically uses one unit of today's quota in ONE statement. The
-- conditional upsert only increments while count < limit, so concurrent requests can never
-- push the count past the limit. Returns the remaining count AFTER consuming, or -1 when the
-- limit was already reached (nothing consumed). "Today" = the Asia/Jerusalem calendar date,
-- so quotas reset at midnight Israel time.
create or replace function public.consume_daily_quota(p_kind text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_kind is null or p_kind not in ('quote', 'receipt') then
    raise exception 'consume_daily_quota: invalid kind' using errcode = '22023';
  end if;
  if p_limit is null or p_limit <= 0 then
    return -1;
  end if;

  insert into public.telegram_daily_usage as u (day, kind, count)
  values ((pg_catalog.now() at time zone 'Asia/Jerusalem')::date, p_kind, 1)
  on conflict (day, kind) do update
    set count = u.count + 1
    where u.count < p_limit
  returning u.count into v_count;

  if v_count is null then
    return -1;          -- the conflict row was already at the limit: nothing consumed
  end if;
  return p_limit - v_count;
end;
$$;

-- get_daily_quota_remaining: read-only, for "📊 נותרו היום: N הצעות מחיר" in the menu.
create or replace function public.get_daily_quota_remaining(p_kind text, p_limit integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(coalesce(p_limit, 0) - coalesce((
           select u.count from public.telegram_daily_usage u
            where u.day = (pg_catalog.now() at time zone 'Asia/Jerusalem')::date
              and u.kind = p_kind), 0), 0);
$$;

revoke all on function public.consume_daily_quota(text, integer)       from public, anon, authenticated;
revoke all on function public.get_daily_quota_remaining(text, integer) from public, anon, authenticated;
grant execute on function public.consume_daily_quota(text, integer)       to service_role;
grant execute on function public.get_daily_quota_remaining(text, integer) to service_role;


-- -------------------------------------------------------------
-- 6. Storage
-- -------------------------------------------------------------
-- 6a. Private bucket for server-rendered quote PDFs. The server writes with service_role
--     (no insert/update/delete policies for anyone else). The panel downloads through
--     signed URLs, which need SELECT for authenticated.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quotes-pdf', 'quotes-pdf', false, 5242880, array['application/pdf'])   -- 5 MB
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'storage' and tablename = 'objects'
                    and policyname = 'authenticated can read quotes-pdf') then
    create policy "authenticated can read quotes-pdf" on storage.objects
      for select to authenticated
      using (bucket_id = 'quotes-pdf');
  end if;
end $$;

-- 6b. Limits on the existing private "receipts" bucket (it had none). The list matches every
--     current writer exactly, so no existing flow can break:
--       - api/parse-receipt.js ALLOWED_MIME_TYPES = image/jpeg, image/png, image/webp, application/pdf
--       - api/telegram-webhook.js: photos → image/jpeg; documents → the same 4 types only
--       - admin.html ALLOWED_RECEIPT_TYPES = the same 4 types (rejected before upload otherwise)
--       - existing objects (2026-10-25): 3 × image/jpeg, largest ~4.5 MB
--     15 MB = the original-file cap already enforced by admin.html and the webhook.
update storage.buckets
   set file_size_limit    = 15728640,                                            -- 15 MB
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
 where id = 'receipts';


-- -------------------------------------------------------------
-- 7. Realtime: live sync of quotes to the panel (PWA on 3 phones)
-- -------------------------------------------------------------
-- Postgres-changes events are filtered by the subscriber's RLS SELECT access. public.quotes
-- has a single policy for authenticated ("authenticated can manage quotes"), so only
-- logged-in panel users receive INSERT/UPDATE rows; anon receives nothing. (DELETE events
-- bypass RLS but, with the default replica identity, carry only the primary key — no PII.
-- Do NOT set REPLICA IDENTITY FULL on this table.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quotes') then
    alter publication supabase_realtime add table public.quotes;
  end if;
end $$;


-- -------------------------------------------------------------
-- 8. Retention (no DB jobs — sweeps run in the webhook code, opportunistically, like the
--    existing cleanupStalePending() for telegram_pending_receipts)
-- -------------------------------------------------------------
--   telegram_pending_quotes     delete rows older than 24h (abandoned drafts + their transcripts)
--   telegram_processed_updates  delete rows older than 7 days
--   telegram_chat_state         delete rows whose state_since is older than 24h
--   telegram_daily_usage        delete days older than 30 days (tiny; kept briefly for support)


-- =============================================================
--  ROLLBACK (commented out — run manually, top to bottom, only if needed)
-- =============================================================
-- Undo 7 — stop realtime for quotes:
--   alter publication supabase_realtime drop table public.quotes;
--
-- Undo 6b — remove the receipts limits (back to "no limit", as before):
--   update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'receipts';
--
-- Undo 6a — quotes-pdf bucket. Empty it FIRST through the Storage API/dashboard (direct
-- deletes from storage.objects are blocked), then:
--   drop policy if exists "authenticated can read quotes-pdf" on storage.objects;
--   delete from storage.buckets where id = 'quotes-pdf';
--
-- Undo 5 — quota functions:
--   drop function if exists public.get_daily_quota_remaining(text, integer);
--   drop function if exists public.consume_daily_quota(text, integer);
--
-- Undo 4 — bot tables (drafts/state/usage are disposable):
--   drop table if exists public.telegram_daily_usage;
--   drop table if exists public.telegram_processed_updates;
--   drop table if exists public.telegram_chat_state;
--   drop table if exists public.telegram_pending_quotes;
--   drop function if exists public.telegram_set_updated_at();
--
-- Undo 3 — numbering (the panel keeps numbering itself from max(number)+1, as before):
--   drop function if exists public.create_quote(jsonb);
--   drop table if exists public.quote_counter;
--
-- Undo 2 — trigger:
--   drop trigger if exists quotes_before_update on public.quotes;
--   drop function if exists public.quotes_before_update();
--
-- Undo 1 — columns + checks. Quotes created by the bot stay as ordinary rows; only their
-- source/vat_mode/pdf_path/chat id/updated_at values are lost:
--   alter table public.quotes drop constraint if exists quotes_telegram_total_check;
--   alter table public.quotes drop constraint if exists quotes_vat_mode_check;
--   alter table public.quotes drop constraint if exists quotes_source_check;
--   alter table public.quotes drop column if exists updated_at;
--   alter table public.quotes drop column if exists telegram_chat_id;
--   alter table public.quotes drop column if exists pdf_path;
--   alter table public.quotes drop column if exists vat_mode;
--   alter table public.quotes drop column if exists source;
