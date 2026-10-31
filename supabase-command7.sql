-- =============================================================
--  Command 7 — social publishing (carousels / video), weekly summary, comment alerts,
--  job done → photos → review request, video retention (media-projects plan, phases 12–13)
-- =============================================================
-- STATUS: SAFE TO APPLY NOW. Strictly additive:
--   CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   ENABLE ROW LEVEL SECURITY / REVOKE (access hardening on the NEW tables only).
--   No DELETE, DROP, UPDATE or INSERT of any data. Every new column is nullable or has a
--   constant default, so existing rows and the code in production are unaffected.
-- Idempotent: safe to run twice. Run as one script (SQL Editor or the supabase MCP execute_sql).
-- =============================================================


-- -------------------------------------------------------------
-- 1. quotes — "✅ העבודה בוצעה" + "⭐ בקשת ביקורת"
-- -------------------------------------------------------------
-- No phone is stored (the review request is a wa.me link with no recipient).
-- quotes_before_update() only clears pdf_path when a PRINTED field changes, so setting these
-- never invalidates a stored PDF.
alter table public.quotes add column if not exists job_done_at          timestamptz;
alter table public.quotes add column if not exists review_requested_at  timestamptz;   -- the latest request
alter table public.quotes add column if not exists review_request_count integer not null default 0;


-- -------------------------------------------------------------
-- 2. content_queue / content_queue_archive (kept mirrored — the daily archive copies select *)
--    Instagram two-phase video (REELS): the container is created in one scheduler run and
--    polled on later runs; published when FINISHED, failed on ERROR / EXPIRED.
-- -------------------------------------------------------------
alter table public.content_queue add column if not exists ig_container_id         text;
alter table public.content_queue add column if not exists ig_container_status     text;
alter table public.content_queue add column if not exists ig_container_created_at timestamptz;
alter table public.content_queue add column if not exists ig_container_checked_at timestamptz;

alter table public.content_queue_archive add column if not exists ig_container_id         text;
alter table public.content_queue_archive add column if not exists ig_container_status     text;
alter table public.content_queue_archive add column if not exists ig_container_created_at timestamptz;
alter table public.content_queue_archive add column if not exists ig_container_checked_at timestamptz;

-- The poller only looks at rows with an open container.
create index if not exists content_queue_ig_container_idx
  on public.content_queue (ig_container_created_at)
  where ig_container_id is not null;


-- -------------------------------------------------------------
-- 3. project_media — video retention (D5: videos deleted 7 days after a successful publish to
--    every chosen destination; the site never uses project videos). The row stays (its cover
--    and history); only the stored video file is removed, and this records when.
-- -------------------------------------------------------------
alter table public.project_media add column if not exists file_deleted_at timestamptz;


-- -------------------------------------------------------------
-- 4. weekly_reports (exists: week_start PK, sent_at) — make the once-a-week send a claim:
--    insert status 'sending' (on conflict do nothing) → send → 'sent'; a failure → 'failed'
--    and a later run inside the 08:00–08:09 window may retry it. Existing rows (none expected)
--    read as 'sent'.
-- -------------------------------------------------------------
alter table public.weekly_reports add column if not exists status     text not null default 'sent'
  check (status in ('sending', 'sent', 'failed'));
alter table public.weekly_reports add column if not exists claimed_at timestamptz;
alter table public.weekly_reports add column if not exists attempts   integer not null default 0;
alter table public.weekly_reports add column if not exists error      text;          -- a short code, never PII


-- -------------------------------------------------------------
-- 5. Comment alerts — "seen" tracking. IDs only: no author, no comment text is stored
--    (the alert text goes straight from Meta to Telegram).
-- -------------------------------------------------------------
create table if not exists public.social_comment_seen (
  platform     text        not null check (platform in ('facebook', 'instagram')),
  comment_id   text        not null,
  post_id      text,
  commented_at timestamptz,
  seen_at      timestamptz not null default now(),
  notified_at  timestamptz,                        -- null = seen silently (the first baseline run, own comments)
  primary key (platform, comment_id)
);
create index if not exists social_comment_seen_seen_idx on public.social_comment_seen (seen_at);

alter table public.social_comment_seen enable row level security;      -- zero policies
revoke all on table public.social_comment_seen from anon, authenticated; -- service_role only


-- -------------------------------------------------------------
-- 6. Scheduler state — small key/value rows for the scheduler's periodic tasks
--    (e.g. 'comment_alerts': last poll time + the baseline flag; 'meta_token': the last
--    debug_token result). No secrets, no PII.
-- -------------------------------------------------------------
create table if not exists public.scheduler_state (
  key        text        primary key,
  value      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.scheduler_state enable row level security;          -- zero policies
revoke all on table public.scheduler_state from anon, authenticated;     -- service_role only


-- =============================================================
-- VERIFY (read-only, after applying)
-- a) select column_name from information_schema.columns where table_schema='public' and table_name='quotes'
--      and column_name in ('job_done_at','review_requested_at','review_request_count');          → 3 rows
-- b) select table_name, count(*) from information_schema.columns where table_schema='public'
--      and table_name in ('content_queue','content_queue_archive') and column_name like 'ig_container_%'
--      group by 1;                                                                                 → 4 + 4
-- c) select column_name from information_schema.columns where table_schema='public'
--      and table_name='project_media' and column_name='file_deleted_at';                           → 1 row
-- d) select column_name from information_schema.columns where table_schema='public'
--      and table_name='weekly_reports' order by ordinal_position;   → week_start, sent_at, status, claimed_at, attempts, error
-- e) select relname, relrowsecurity from pg_class where relname in ('social_comment_seen','scheduler_state'); → both true
-- f) select count(*) from pg_policies where tablename in ('social_comment_seen','scheduler_state');         → 0
-- g) select grantee, privilege_type from information_schema.role_table_grants
--      where table_name in ('social_comment_seen','scheduler_state') and grantee in ('anon','authenticated'); → 0 rows
-- h) unchanged data: select status, count(*) from public.content_queue group by 1;  (same as before)
--
-- ROLLBACK (NOT part of this script — for the owner only, if ever needed; every object is new):
--   drop table public.scheduler_state; drop table public.social_comment_seen;
--   alter table public.weekly_reports drop column error, drop column attempts, drop column claimed_at, drop column status;
--   alter table public.project_media drop column file_deleted_at;
--   drop index public.content_queue_ig_container_idx;
--   alter table public.content_queue(_archive) drop column ig_container_checked_at, ig_container_created_at,
--     ig_container_status, ig_container_id;
--   alter table public.quotes drop column review_request_count, drop column review_requested_at, drop column job_done_at;
-- =============================================================
