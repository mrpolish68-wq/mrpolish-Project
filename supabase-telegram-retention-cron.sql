-- =============================================================
--  Telegram bot — scheduled retention (Phase 7a)
-- =============================================================
--  privacy.html says unapproved quote drafts are deleted automatically within 24 hours. The
--  webhook already sweeps opportunistically (sweepRetention) and never USES a draft older than
--  24 h, but that sweep only runs when someone messages the bot. This hourly pg_cron job makes the
--  deletion happen even when the bot is idle: rows older than 23 h, checked every hour, so nothing
--  outlives 24 h.
--
--  Same retention as the webhook (supabase-quotes-telegram.sql §8):
--    telegram_pending_quotes     drafts + transcripts        23 h (privacy promise: < 24 h)
--    telegram_chat_state         parked messages / states    23 h
--    telegram_processed_updates  update ids only (no PII)    7 days
--    telegram_daily_usage        counters only (no PII)      30 days
--  (telegram_pending_receipts keeps its 48 h + Storage cleanup in the webhook; unchanged.)
--
--  Run once in the Supabase SQL Editor (project mmognkxkglkotzkuxzly). Idempotent: re-running
--  replaces the job (cron.schedule with an existing job name updates it). Additive: no table or
--  data change besides the deletes the job performs.
-- =============================================================

create extension if not exists pg_cron;

select cron.schedule(
  'telegram-retention-hourly',
  '17 * * * *',
  $job$
    delete from public.telegram_pending_quotes    where created_at  < now() - interval '23 hours';
    delete from public.telegram_chat_state        where state_since < now() - interval '23 hours';
    delete from public.telegram_processed_updates where created_at  < now() - interval '7 days';
    delete from public.telegram_daily_usage       where day < ((now() at time zone 'Asia/Jerusalem')::date - 30);
  $job$
);

-- Verify (expected: one row, active = true, schedule '17 * * * *'):
--   select jobid, jobname, schedule, active from cron.job where jobname = 'telegram-retention-hourly';
-- Last runs:
--   select status, start_time, end_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'telegram-retention-hourly')
--    order by start_time desc limit 5;

-- ROLLBACK (only if needed; the webhook keeps sweeping opportunistically):
--   select cron.unschedule('telegram-retention-hourly');
