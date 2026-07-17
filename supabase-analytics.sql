-- =============================================================
--  Mr. Polish — Analytics tab schema: "meta_analytics" (daily Facebook +
--  Instagram performance snapshots), "social_comments" (unanswered
--  comments/questions flagged for Ori), and "ai_recommendations"
--  (daily tips + the monthly content plan).
--  Run this once in the Supabase SQL Editor.
--
--  Flow: a Vercel cron job (api/analytics-agent.js) runs once/day, pulls
--  Meta Insights + recent comments, upserts a snapshot row per platform
--  into meta_analytics, flags new unanswered comments into
--  social_comments, and derives daily_tip / monthly_plan rows into
--  ai_recommendations from that history — all via deterministic
--  heuristics (no external AI API call, no ongoing cost). The dashboard's
--  "אנליטיקה" tab reads all three directly via the authenticated
--  supabase-js session, same as Content Management/Business Expenses.
-- =============================================================

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'analytics_platform') then
    create type public.analytics_platform as enum ('facebook', 'instagram');
  end if;
  if not exists (select 1 from pg_type where typname = 'comment_status') then
    create type public.comment_status as enum ('needs_attention', 'replied', 'dismissed');
  end if;
  if not exists (select 1 from pg_type where typname = 'recommendation_kind') then
    create type public.recommendation_kind as enum ('daily_tip', 'monthly_plan');
  end if;
end $$;

-- -------------------------------------------------------------
--  meta_analytics — one row per (snapshot_date, platform), upserted by
--  the daily agent, never appended twice for the same day. video_views/
--  video_completion_rate are best-effort: Meta's Insights metric names
--  change over time (several were deprecated across 2025-2026), so these
--  stay null when the current Graph API version doesn't expose a usable
--  figure for a given post, rather than the agent failing outright.
-- -------------------------------------------------------------
create table if not exists public.meta_analytics (
  id                     uuid primary key default gen_random_uuid(),
  snapshot_date          date not null,
  platform               public.analytics_platform not null,
  follower_count         integer,
  reach                  integer,
  impressions            integer,
  engagement_count       integer,           -- likes + comments + shares/saves, summed
  engagement_rate        numeric(6,3),      -- engagement_count / reach * 100, null if reach unknown
  video_views            integer,
  video_completion_rate  numeric(6,3),
  posts_published        integer,
  raw_metrics            jsonb,             -- full Graph API response, so a new field later doesn't need a migration
  created_at             timestamptz not null default now(),
  unique (snapshot_date, platform)
);

create index if not exists meta_analytics_date_platform_idx
  on public.meta_analytics (snapshot_date desc, platform);

-- -------------------------------------------------------------
--  social_comments — unanswered comments/questions flagged for Ori.
--  suggested_reply is agent-drafted text for Ori to review and post
--  himself on Facebook/Instagram directly — this table never causes an
--  automatic reply to go out (same "verify/remind, don't auto-act on
--  the public feed" reasoning as the existing Pin Intent workflow).
-- -------------------------------------------------------------
create table if not exists public.social_comments (
  id               uuid primary key default gen_random_uuid(),
  platform         public.analytics_platform not null,
  post_id          text not null,           -- Meta's post/media id
  comment_id       text not null,           -- Meta's comment id
  post_permalink   text,
  author_name      text,
  comment_text     text not null,
  commented_at     timestamptz,
  status           public.comment_status not null default 'needs_attention',
  suggested_reply  text,
  replied_at       timestamptz,             -- set when Ori marks it handled in the dashboard
  dismissed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (platform, comment_id)
);

create index if not exists social_comments_status_idx
  on public.social_comments (status, commented_at desc);

-- -------------------------------------------------------------
--  ai_recommendations — daily tips (kind='daily_tip', 3/day) and the
--  monthly content plan (kind='monthly_plan', 1/month). plan_items is
--  only populated for monthly_plan; based_on records which posts/metrics
--  a recommendation was derived from, for traceability.
-- -------------------------------------------------------------
create table if not exists public.ai_recommendations (
  id           uuid primary key default gen_random_uuid(),
  kind         public.recommendation_kind not null,
  period_date  date not null,               -- the day (daily_tip) or month-start (monthly_plan) this covers
  title        text not null,
  body         text not null,
  plan_items   jsonb,                       -- monthly_plan only: [{week, theme, category, notes}, ...]
  based_on     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists ai_recommendations_kind_period_idx
  on public.ai_recommendations (kind, period_date desc);

-- -------------------------------------------------------------
--  Row-Level Security — same pattern as content_queue/business_expenses:
--  private admin-only data, one policy, no anon access. The daily agent
--  runs with no logged-in user, so it uses the service_role key (bypasses
--  RLS), same as the publish pipeline.
-- -------------------------------------------------------------
alter table public.meta_analytics enable row level security;
drop policy if exists "authenticated can manage meta analytics" on public.meta_analytics;
create policy "authenticated can manage meta analytics"
  on public.meta_analytics for all to authenticated using (true) with check (true);

alter table public.social_comments enable row level security;
drop policy if exists "authenticated can manage social comments" on public.social_comments;
create policy "authenticated can manage social comments"
  on public.social_comments for all to authenticated using (true) with check (true);

alter table public.ai_recommendations enable row level security;
drop policy if exists "authenticated can manage ai recommendations" on public.ai_recommendations;
create policy "authenticated can manage ai recommendations"
  on public.ai_recommendations for all to authenticated using (true) with check (true);
