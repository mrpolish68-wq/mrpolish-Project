-- =============================================================
--  Mr. Polish — "content_queue" table for the admin dashboard's
--  "ניהול תוכן" (Content Management) tab + scheduled Meta publishing.
--  Run this once in the Supabase SQL Editor.
--
--  Flow: content gets queued here (manually or by a future generator),
--  Ori reviews + approves/rejects in the dashboard, and a Vercel cron
--  job (api/publish-scheduled-content.js) publishes approved rows to
--  Facebook/Instagram once their scheduled_for time arrives. Nothing
--  publishes without status = 'approved' first.
-- =============================================================

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'content_platform') then
    create type public.content_platform as enum ('facebook', 'instagram', 'both');
  end if;
  if not exists (select 1 from pg_type where typname = 'content_media_type') then
    create type public.content_media_type as enum ('image', 'video', 'reel', 'story');
  end if;
  if not exists (select 1 from pg_type where typname = 'content_status') then
    create type public.content_status as enum (
      'pending_approval', 'approved', 'rejected', 'published', 'failed'
    );
  end if;
end $$;

create table if not exists public.content_queue (
  id             uuid primary key default gen_random_uuid(),
  title          text,                     -- internal label only, never posted
  caption        text not null,            -- the Hebrew copy that gets published
  media_type     public.content_media_type not null,
  media_url      text not null,            -- public URL Meta will fetch the asset from
  thumbnail_url  text,                     -- optional, for video/reel previews in the dashboard
  platform       public.content_platform not null default 'both',
  scheduled_for  timestamptz not null,
  status         public.content_status not null default 'pending_approval',
  approved_at    timestamptz,
  published_at   timestamptz,
  fb_post_id     text,                     -- remote ID once live on Facebook
  ig_post_id     text,                     -- remote ID once live on Instagram
  publish_error  text,                     -- last failure reason, for retry/debugging
  notes          text,                     -- internal brief/source note
  created_at     timestamptz not null default now()
);

-- Fast lookup for the cron job ("approved rows due now") and the dashboard's filters.
create index if not exists content_queue_status_scheduled_idx
  on public.content_queue (status, scheduled_for);

-- -------------------------------------------------------------
--  Row-Level Security
--  Private content-ops data — only the authenticated admin (Ori) can
--  read/write via the dashboard. The publishing cron job runs with no
--  logged-in user, so it uses the Supabase service_role key instead
--  (bypasses RLS entirely) — never the anon key, never client-side.
-- -------------------------------------------------------------
alter table public.content_queue enable row level security;

drop policy if exists "authenticated can manage content queue" on public.content_queue;
create policy "authenticated can manage content queue"
  on public.content_queue
  for all
  to authenticated
  using (true)
  with check (true);

-- -------------------------------------------------------------
--  Storage bucket for future generated/uploaded media (images, video,
--  Reels). Not required for the pilot batch, which reuses existing
--  public files already served from assets/gallery/ on the live site —
--  but needed as soon as new (not-yet-on-the-site) media is queued.
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('content-media', 'content-media', true)
on conflict (id) do nothing;

drop policy if exists "public can read content-media" on storage.objects;
create policy "public can read content-media"
  on storage.objects
  for select
  to public
  using (bucket_id = 'content-media');

drop policy if exists "authenticated can upload content-media" on storage.objects;
create policy "authenticated can upload content-media"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'content-media');
