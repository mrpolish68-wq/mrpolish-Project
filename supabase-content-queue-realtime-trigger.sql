-- =============================================================
--  Mr. Polish — Real-time publish trigger support.
--
--  Ori asked to move from "Approve just sets a status and waits for
--  the once-daily cron" to "Approve immediately attempts to publish
--  to Meta". This adds what that needs:
--
--  1. A new 'scheduled' status. Facebook's Graph API genuinely
--     supports scheduling a Page post for a future time
--     (`published:false` + `scheduled_publish_time`) - Instagram's
--     API does NOT (every IG call publishes immediately, already
--     documented in handoff.md §7). So a row can end up "scheduled"
--     on Facebook's own servers before its scheduled_for time - a
--     genuinely different state from 'approved' (queued, nothing
--     done yet) or 'published' (already live). Rows in this state
--     must never be picked up by the cron's `status=eq.approved`
--     query again, or Facebook would receive a duplicate.
--
--  2. Debug/audit columns so Ori can see, per row, whether the cron
--     or a manual Approve-click triggered the last publish attempt,
--     how many attempts have happened, and when - directly in
--     Supabase/the dashboard, not just in Vercel's function log
--     retention window.
--
--  Run this before deploying the updated api/publish-scheduled-
--  content.js, api/publish-now.js, and admin.html.
-- =============================================================

alter type public.content_status add value if not exists 'scheduled';

alter table public.content_queue
  add column if not exists trigger_source text,
  add column if not exists publish_attempts integer not null default 0,
  add column if not exists last_publish_attempt_at timestamptz;

comment on column public.content_queue.trigger_source is 'What caused the most recent publish attempt: ''cron'' (daily fallback) or ''manual'' (Approve button real-time trigger).';
comment on column public.content_queue.publish_attempts is 'Incremented on every publish attempt (cron or manual), success or failure - not reset on retry.';
