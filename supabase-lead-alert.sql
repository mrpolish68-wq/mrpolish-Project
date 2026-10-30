-- =============================================================
--  Instant Telegram alert for every new site lead
--  (media-projects plan, Phase 4 / decision D11)
-- =============================================================
-- AFTER INSERT on public.leads → an async pg_net POST {id} to
--   https://mr-polishes.com/api/analytics-agent?task=lead-alert
-- with the header X-Internal-Secret = Vault secret 'db_webhook_secret' (the same value as the
-- Vercel env var DB_WEBHOOK_SECRET). The endpoint loads the lead, sends the Telegram message and
-- sets leads.notified_at (idempotent). A pg_cron sweep re-sends any lead from the last 24 h whose
-- alert didn't go out.
--
-- THE INSERT NEVER FAILS BECAUSE OF THE ALERT: the trigger catches every error (no secret,
-- pg_net missing, …) and only raises a WARNING; pg_net itself is asynchronous (it queues the
-- request and sends it after the insert commits).
--
-- STATUS: APPLY AT MERGE — the endpoint (?task=lead-alert) only exists once the media-projects
-- branch is in production, and DB_WEBHOOK_SECRET must be set in Vercel (Production) first.
-- Order: 1) Vercel env var DB_WEBHOOK_SECRET  2) merge + deploy  3) Vault 'db_webhook_secret'
--        4) this file.
-- =============================================================

create extension if not exists pg_net with schema extensions;

-- 1. leads.notified_at. Existing leads count as already notified (they're never alerted).
alter table public.leads add column if not exists notified_at timestamptz;
update public.leads set notified_at = created_at where notified_at is null and created_at < now() - interval '1 hour';

-- 2. A public (anon) insert can't pre-set notified_at to silence its own alert.
create or replace function public.leads_reset_notified()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.notified_at := null;
  return new;
end;
$$;
drop trigger if exists leads_reset_notified on public.leads;
create trigger leads_reset_notified before insert on public.leads
  for each row execute function public.leads_reset_notified();

-- 3. The alert trigger. SECURITY DEFINER: the inserting role (anon) can't read Vault or call
--    pg_net itself. Every error is swallowed (WARNING only) so the insert always succeeds.
create or replace function public.notify_new_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  begin
    select s.decrypted_secret into v_secret
      from vault.decrypted_secrets s where s.name = 'db_webhook_secret' limit 1;
    if coalesce(v_secret, '') <> '' then
      perform net.http_post(
        url := 'https://mr-polishes.com/api/analytics-agent?task=lead-alert',
        body := jsonb_build_object('id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'X-Internal-Secret', v_secret),
        timeout_milliseconds := 15000
      );
    end if;
  exception when others then
    raise warning 'notify_new_lead: alert not queued for lead % (%)', new.id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.notify_new_lead() from public, anon, authenticated;
revoke all on function public.leads_reset_notified() from public, anon, authenticated;
drop trigger if exists leads_notify on public.leads;
create trigger leads_notify after insert on public.leads
  for each row execute function public.notify_new_lead();

-- 4. Sweep: every 10 minutes, only when a lead from the last 24 h is still un-notified (older
--    than 1 minute, so the trigger's own call goes first). Calls the endpoint without an id.
select cron.schedule(
  'lead-alert-sweep',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://mr-polishes.com/api/analytics-agent?task=lead-alert',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'X-Internal-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'db_webhook_secret' limit 1)),
    timeout_milliseconds := 30000
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'db_webhook_secret' and coalesce(decrypted_secret, '') <> '')
    and exists (select 1 from public.leads where notified_at is null
                 and created_at > now() - interval '24 hours' and created_at < now() - interval '1 minute');
  $job$
);


-- =============================================================
--  VERIFY
-- =============================================================
-- a) select tgname from pg_trigger where tgrelid = 'public.leads'::regclass and not tgisinternal;
--    → leads_notify, leads_reset_notified
-- b) select count(*) filter (where notified_at is null) as pending, count(*) as total from public.leads;
--    → pending 0 right after applying (old leads were marked notified)
-- c) after ONE fake lead from the site ("בדיקה – למחוק"): a Telegram message arrives, and
--    select notified_at is not null from public.leads where name = 'בדיקה – למחוק';  → true
--    select created, status_code from net._http_response order by created desc limit 3;  → 200
--    then: delete from public.leads where name = 'בדיקה – למחוק';
-- d) select jobname, schedule, active from cron.job where jobname = 'lead-alert-sweep';


-- =============================================================
--  ROLLBACK (top to bottom)
-- =============================================================
-- select cron.unschedule('lead-alert-sweep');
-- drop trigger if exists leads_notify on public.leads;
-- drop trigger if exists leads_reset_notified on public.leads;
-- drop function if exists public.notify_new_lead();
-- drop function if exists public.leads_reset_notified();
-- alter table public.leads drop column if exists notified_at;
