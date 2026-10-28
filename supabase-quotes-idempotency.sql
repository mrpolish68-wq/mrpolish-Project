-- =============================================================
--  Quotes — idempotent create_quote (audit batch A: M1, L10, L7)
-- =============================================================
--  Problem (audit M1/L10): if create_quote() commits but the caller never learns it (the
--  bot's quote_id patch fails, or the response is lost on the network), the caller's retry
--  calls create_quote() again and a SECOND quote with a new number is created for one job.
--
--  Fix: an optional caller-chosen key, p->>'client_ref' (the bot sends the draft id; the panel
--  sends a random UUID per new-quote form). If a quote with that client_ref already exists,
--  create_quote() returns THAT row: no new number, no counter change. The lookup runs after
--  the advisory lock, so two concurrent first attempts can't both insert. A unique index is
--  the final guard.
--
--  Everything else in create_quote() is IDENTICAL to supabase-quotes-telegram.sql §3 (the
--  lock, the role detection, the validation, the insert, the counter bump). Calls without
--  client_ref behave exactly as before.
--
--  Also (audit L7): telegram_pending_receipts (created before the quotes feature) still has the
--  default anon/authenticated table grants. RLS with zero policies already blocks them; this
--  revokes them as defense in depth, like the newer bot tables. Only api/telegram-webhook.js
--  uses the table, via the service_role key, so nothing loses access.
--
--  Run once in the Supabase SQL Editor (project mmognkxkglkotzkuxzly). Idempotent and additive:
--  safe to re-run. The code already sends client_ref and works before AND after this file
--  (the current function ignores unknown keys).
-- =============================================================


-- -------------------------------------------------------------
-- 1. quotes.client_ref + a unique index (NULLs allowed: old rows and calls without a key)
-- -------------------------------------------------------------
alter table public.quotes add column if not exists client_ref text;

create unique index if not exists quotes_client_ref_key
  on public.quotes (client_ref)
  where client_ref is not null;


-- -------------------------------------------------------------
-- 2. create_quote(p jsonb): same as before + client_ref
-- -------------------------------------------------------------
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
  v_ref        text    := nullif(btrim(coalesce(p ->> 'client_ref', '')), '');
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
  if v_ref is not null and pg_catalog.length(v_ref) > 100 then
    raise exception 'create_quote: client_ref is too long' using errcode = '22023';
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

  -- Idempotency: a retry with the same client_ref gets the quote that was already created
  -- (no new number, no counter change). Checked under the lock.
  if v_ref is not null then
    select q.* into v_row from public.quotes q where q.client_ref = v_ref;
    if found then
      return v_row;
    end if;
  end if;

  select greatest(coalesce(max(q.number), 0) + 1,
                  (select c.floor_next from public.quote_counter c where c.id))
    into v_next
    from public.quotes q;

  insert into public.quotes (number, quote_date, client_name, address, description, total,
                             source, vat_mode, telegram_chat_id, client_ref)
  values (v_next, v_date, v_client,
          nullif(btrim(p ->> 'address'), ''),
          nullif(p ->> 'description', ''),
          v_total, v_source, v_vat, v_chat, v_ref)
  returning * into v_row;

  update public.quote_counter set floor_next = greatest(floor_next, v_next + 1) where id;

  return v_row;
end;
$$;

-- Same grants as before (CREATE OR REPLACE keeps them; restated so a re-run is self-contained).
revoke all on function public.create_quote(jsonb) from public, anon;
grant execute on function public.create_quote(jsonb) to authenticated, service_role;


-- -------------------------------------------------------------
-- 3. L7: telegram_pending_receipts — service_role only (RLS on, zero policies already)
-- -------------------------------------------------------------
revoke all on table public.telegram_pending_receipts from anon, authenticated;


-- =============================================================
--  VERIFY (run after the statements above)
-- =============================================================
-- a) column + index (expected: 1 row each)
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'quotes' and column_name = 'client_ref';
--   select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = 'quotes_client_ref_key';
--
-- b) idempotency, rolled back (the final RAISE undoes everything, so no number is used).
--    Expected message: RESULT same_id=t same_number=t counter_moved_on_retry=0 second_ref_new_number=t
--   do $$
--   declare r text := 'verify-' || gen_random_uuid(); a public.quotes; b public.quotes; c public.quotes; f1 int; f2 int;
--   begin
--     a := public.create_quote(jsonb_build_object('client_name','בדיקה','quote_date','01.01.2026','total',1,'client_ref',r));
--     select floor_next into f1 from public.quote_counter;
--     b := public.create_quote(jsonb_build_object('client_name','בדיקה אחרת','quote_date','02.02.2026','total',2,'client_ref',r));
--     select floor_next into f2 from public.quote_counter;
--     c := public.create_quote(jsonb_build_object('client_name','בדיקה','quote_date','01.01.2026','total',1,'client_ref',r || '-2'));
--     raise exception 'RESULT same_id=% same_number=% counter_moved_on_retry=% second_ref_new_number=%',
--       a.id = b.id, a.number = b.number, f2 - f1, c.number = a.number + 1;
--   end $$;
--
-- c) L7 grants (expected: 0 rows)
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'telegram_pending_receipts' and grantee in ('anon', 'authenticated');
--
-- d) function settings unchanged (expected: prosecdef = t, proconfig = {search_path=""})
--   select prosecdef, proconfig from pg_proc where oid = 'public.create_quote(jsonb)'::regprocedure;


-- =============================================================
--  ROLLBACK (only if needed, top to bottom)
-- =============================================================
-- 1. Restore the previous create_quote: re-run the "create or replace function public.create_quote"
--    block + its revoke/grant from supabase-quotes-telegram.sql §3 (it doesn't know client_ref).
-- 2. drop index if exists public.quotes_client_ref_key;
-- 3. alter table public.quotes drop column if exists client_ref;
--    (any client_ref values are lost; the quotes themselves are untouched)
-- 4. L7, restore the old default grants (RLS still blocks them):
--    grant all on table public.telegram_pending_receipts to anon, authenticated;
