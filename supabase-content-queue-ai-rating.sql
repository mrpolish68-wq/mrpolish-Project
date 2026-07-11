-- =============================================================
--  Mr. Polish — AI Rating + Optimal Timing for content_queue.
--  Run this after supabase-content-queue-upgrade.sql, once, in the
--  Supabase SQL Editor.
--
--  ai_rating: a 1-10 score authored alongside the existing ai_why_it_works
--  / ai_brand_contribution fields (same "author once" approach, not a
--  live per-view AI call). ai_rating_justification is the short "why
--  this score" note; ai_optimal_timing is a best day/time recommendation
--  for THIS specific piece (e.g. "יום שלישי, 18:00-19:00").
-- =============================================================

alter table public.content_queue
  add column if not exists ai_rating integer check (ai_rating between 1 and 10),
  add column if not exists ai_rating_justification text,
  add column if not exists ai_optimal_timing text;

create index if not exists content_queue_rating_idx on public.content_queue (ai_rating);
