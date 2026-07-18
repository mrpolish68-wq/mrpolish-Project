-- =============================================================
--  Mr. Polish — Content Management archive system.
--  Run this once in the Supabase SQL Editor.
--
--  Problem: the Content Management tab's main grid showed every row ever,
--  including old published/rejected posts, making it hard to see what
--  actually still needs attention. Fix, three parts:
--
--  1. rejected_at — content_queue had approved_at/published_at but no
--     equivalent for reject(), so "how long has this been rejected" was
--     unmeasurable. admin.html's reject() now sets it.
--  2. content_queue_archive — a same-shape table. The daily agent
--     (api/analytics-agent.js) moves a published/rejected row here once
--     it's more than 7 days past its published_at/rejected_at, then
--     deletes it from content_queue. Non-destructive: the row's full
--     data survives (so "🔁 שכפול" duplicate and any future reference
--     to old content still works), it's just out of the primary
--     working table — keeps content_queue itself, and the dashboard's
--     default view, lean as the pilot's history accumulates over months.
--  3. The dashboard's main grid now filters out status IN
--     ('published','rejected') client-side (admin.html's currentRows());
--     a new "📜 היסטוריה" toggle shows exactly that filtered-out set.
--     Nothing changed in the shared fetch that both Content Calendar and
--     the Weekly Planner drill-down rely on — both still need to see
--     published/rejected rows that haven't been archived yet.
-- =============================================================

alter table public.content_queue
  add column if not exists rejected_at timestamptz;

comment on column public.content_queue.rejected_at is 'Set by admin.html''s reject() when a row is rejected — used by the daily agent to know when a rejected row is old enough to archive.';

-- Same columns as content_queue (see supabase-content-queue.sql +
-- -upgrade/-ai-rating/-realtime-trigger/-pin-feature for the full history of
-- how it got this wide), plus archived_at recording when this row was moved
-- here. Reuses content_queue's own enum types rather than redeclaring them.
create table if not exists public.content_queue_archive (
  id                       uuid primary key,
  title                    text,
  caption                  text not null,
  media_type               public.content_media_type not null,
  media_url                text not null,
  thumbnail_url            text,
  platform                 public.content_platform not null,
  scheduled_for            timestamptz not null,
  status                   public.content_status not null,
  approved_at              timestamptz,
  published_at             timestamptz,
  rejected_at              timestamptz,
  fb_post_id               text,
  ig_post_id               text,
  publish_error            text,
  notes                    text,
  content_category         public.content_category,
  ai_reach_forecast        text,
  ai_why_it_works          text,
  ai_brand_contribution    text,
  ai_generated_at          timestamptz,
  ai_rating                integer,
  ai_rating_justification  text,
  ai_optimal_timing        text,
  trigger_source           text,
  publish_attempts         integer,
  last_publish_attempt_at  timestamptz,
  pin_requested            boolean,
  pin_confirmed_at         timestamptz,
  link_url                 text,
  created_at               timestamptz not null,
  archived_at              timestamptz not null default now()
);

create index if not exists content_queue_archive_archived_idx
  on public.content_queue_archive (archived_at desc);

-- Same private-admin-only pattern as content_queue itself.
alter table public.content_queue_archive enable row level security;
drop policy if exists "authenticated can manage content queue archive" on public.content_queue_archive;
create policy "authenticated can manage content queue archive"
  on public.content_queue_archive for all to authenticated using (true) with check (true);
