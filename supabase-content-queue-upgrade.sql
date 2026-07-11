-- =============================================================
--  Mr. Polish — content_queue upgrade: categorization + stored AI
--  analysis fields, for the "ניהול תוכן" / "לוח תוכן" dashboard tabs.
--  Run this AFTER supabase-content-queue.sql (and its pilot seed),
--  once, in the Supabase SQL Editor.
--
--  content_category is a separate dimension from media_type:
--  media_type (image/video/reel/story) drives the technical publish
--  path (which Graph API call gets made); content_category
--  (ad/post/reel/story) is the marketing classification you filter
--  the dashboard by. A video Reel could be category='reel' (organic)
--  or category='ad' (a candidate to boost later) independent of its
--  technical format.
--
--  ai_* columns hold a one-time "authored at content-creation time"
--  analysis (reach/engagement rationale + strategic notes) — NOT a
--  live per-view AI call. Populated when content is queued, read-only
--  in the dashboard's preview modal.
-- =============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'content_category') then
    create type public.content_category as enum ('ad', 'post', 'reel', 'story');
  end if;
end $$;

alter table public.content_queue
  add column if not exists content_category public.content_category not null default 'post',
  add column if not exists ai_reach_forecast text,
  add column if not exists ai_why_it_works text,
  add column if not exists ai_brand_contribution text,
  add column if not exists ai_generated_at timestamptz;
