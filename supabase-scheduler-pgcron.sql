-- =============================================================
--  Durable publish scheduler: pg_cron + pg_net + Vault
--  (media-projects plan, Phase 3 / decision D8)
-- =============================================================
-- WHY: GitHub turns off scheduled workflows after 60 days without repo activity (it happened on
-- 2026-10-14 and the schedule didn't resume after re-enabling on 2026-10-30). pg_cron runs inside
-- the database and never goes inactive. It calls the EXISTING production endpoint
-- /api/publish-scheduled-content with the same `Authorization: Bearer <CRON_SECRET>` that Vercel's
-- daily cron and the GitHub workflow send — no code change, no new endpoint.
--
-- OVERLAP IS SAFE: GitHub (*/10, kept as a backup), this job (minutes 5, 15, 25, …) and Vercel's
-- daily cron may all call the endpoint. Every row is claimed atomically before Meta is touched
-- (claimRow), and each run publishes at most 3 rows (burst guard) — so overlapping calls never
-- double-post; they only shorten the wait between a slot and its publish.
--
-- STATUS: SAFE TO APPLY NOW. It only calls an endpoint that already runs every day.
--
-- BEFORE RUNNING THIS FILE: store CRON_SECRET in Vault under the name  cron_secret
-- (steps in the media-projects plan / the Phase 3 report). Without it the job runs but sends
-- nothing (the WHERE EXISTS below), so applying this file first is harmless too.
--
-- Secrets: the job's text never contains the secret — it reads vault.decrypted_secrets at run
-- time. pg_net keeps request headers only while a request is queued, and responses (status +
-- body, no request headers) for ~6 hours in net._http_response.
-- =============================================================

-- 1. pg_net (async HTTP from SQL). Supabase installs its functions in the `net` schema.
create extension if not exists pg_net with schema extensions;

-- 2. The job. cron.schedule() with an existing job name UPDATES that job, so re-running this
--    file is idempotent. '5-59/10' = minutes 5, 15, 25, … (interleaves with GitHub's 0, 10, 20, …).
--    55 s timeout: one run can take up to ~50 s (the Instagram processing wait); the endpoint's
--    own maxDuration is 60 s.
select cron.schedule(
  'publish-every-10-min',
  '5-59/10 * * * *',
  $job$
  select net.http_get(
    url := 'https://mr-polishes.com/api/publish-scheduled-content',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)
    ),
    timeout_milliseconds := 55000
  )
  where exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and coalesce(decrypted_secret, '') <> '');
  $job$
);


-- =============================================================
--  VERIFY (run after the statements above; wait ~10 minutes for the first runs)
-- =============================================================
-- a) the job exists and is active:
--    select jobid, jobname, schedule, active from cron.job where jobname = 'publish-every-10-min';
-- b) its recent runs (status should be 'succeeded'):
--    select start_time, status, return_message from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'publish-every-10-min')
--     order by start_time desc limit 5;
-- c) the endpoint's answers (expect 200 and a body starting with {"processed": …; 401 = wrong secret):
--    select created, status_code, left(content::text, 120) as body, error_msg
--      from net._http_response order by created desc limit 5;
-- d) the secret is stored (shows the name only, never the value):
--    select name, created_at from vault.secrets where name = 'cron_secret';


-- =============================================================
--  ROLLBACK (only if needed)
-- =============================================================
-- select cron.unschedule('publish-every-10-min');
-- (Keep pg_net: the lead alert, supabase-lead-alert.sql, uses it too. To remove the secret:
--  delete from vault.secrets where name = 'cron_secret';)
