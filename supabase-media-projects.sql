-- =============================================================
--  Media projects — schema, storage, quota kinds
--  (media-projects plan, Phase 5; decisions D2 consent, D3 privacy flags, D4 watermark,
--   D5 originals ≤ 2560px, D7 slugs/city)
-- =============================================================
-- STATUS: SAFE TO APPLY NOW, every part. All of it is additive or a superset, and nothing in
-- production uses it yet:
--   §1 new nullable columns on content_queue + content_queue_archive (mirrored — the daily
--      archive copies `select *`) and a new enum value nobody produces yet;
--   §2–§4 new tables (+ RLS) that no code reads yet;
--   §5 social_comments.notified_at (nullable);
--   §6 quota kinds: the constraint + both functions accept a SUPERSET ('quote','receipt' behave
--      exactly as before);
--   §7 two new buckets nobody writes to yet; content-media gets limits and loses its public
--      LISTING policy — no code uses that bucket at all (grep: no reference in admin.html,
--      main.js, api/ or tools/; its public URLs keep working, public buckets don't need a policy
--      for that).
-- Idempotent: safe to run twice. Run in the Supabase SQL Editor as one script.
-- =============================================================


-- -------------------------------------------------------------
-- 1. content_queue / content_queue_archive (kept mirrored) + the 'carousel' media type
-- -------------------------------------------------------------
-- ADD VALUE inside the editor's transaction is fine on Postgres ≥ 12 as long as nothing in the
-- same transaction uses it (nothing here does).
alter type public.content_media_type add value if not exists 'carousel';

alter table public.content_queue         add column if not exists project_id uuid;
alter table public.content_queue         add column if not exists media_items jsonb;   -- carousel: [{url, type}]
alter table public.content_queue_archive add column if not exists project_id uuid;
alter table public.content_queue_archive add column if not exists media_items jsonb;
create index if not exists content_queue_project_idx on public.content_queue (project_id) where project_id is not null;


-- -------------------------------------------------------------
-- 2. projects
-- -------------------------------------------------------------
create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique,
  status           text not null default 'collecting',
  consent          text not null default 'unknown',
  consent_at       timestamptz,
  consent_by       text,
  service          text,
  city             text,
  title_he         text,
  title_en         text,
  summary_he       text,
  summary_en       text,
  completed_on     date,
  watermark        boolean not null default true,                 -- D4: on by default
  cover_media_id   uuid,
  quote_id         uuid references public.quotes(id) on delete set null,
  source           text not null default 'panel',
  telegram_chat_id bigint,
  ai_meta          jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  published_at     timestamptz,
  constraint projects_status_check  check (status in ('collecting','draft','ready','published','archived')),
  constraint projects_consent_check check (consent in ('unknown','yes','no')),
  constraint projects_source_check  check (source in ('panel','telegram','migrated')),
  constraint projects_service_check check (service is null or service in
    ('floor_polish','crystal','marble_stone','sealer','concrete','bomanite','stairs','other')),
  -- D7: lowercase transliteration, words joined by "-"
  constraint projects_slug_check    check (slug is null or (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80)),
  -- D7: a city, never a street address (no digits = no house numbers)
  constraint projects_city_check    check (city is null or (length(city) <= 40 and city !~ '[0-9]')),
  -- D2: only a consented project can be published
  constraint projects_publish_needs_consent check (status <> 'published' or consent = 'yes'),
  constraint projects_consent_time  check (consent = 'unknown' or consent_at is not null)
);
create index if not exists projects_status_published_idx on public.projects (status, published_at desc);
create index if not exists projects_service_idx on public.projects (service) where status = 'published';

create or replace function public.projects_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at before update on public.projects
  for each row execute function public.projects_touch_updated_at();


-- -------------------------------------------------------------
-- 3. project_media (one file each) + project_publications
-- -------------------------------------------------------------
create table if not exists public.project_media (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects(id) on delete cascade,
  kind                    text not null,
  role                    text,
  pair_no                 integer,
  sort                    integer not null default 0,
  original_path           text not null,       -- project-originals/<project>/<file>  (≤ 2560px copy, D5)
  variants                jsonb,               -- {"w480": "...", "w960": "...", "w1600": "...", "ig": "..."}
  width                   integer,
  height                  integer,
  bytes                   bigint,
  duration_s              numeric,
  codec                   text,
  alt_he                  text,
  alt_en                  text,
  ai_flags                jsonb,               -- {"faces": bool, "plates": bool, "house_numbers": bool, ...}
  flags_ack_at            timestamptz,         -- D3: "בדקתי, אפשר לפרסם"
  telegram_file_unique_id text,
  created_at              timestamptz not null default now(),
  constraint project_media_kind_check check (kind in ('image','video')),
  constraint project_media_role_check check (role is null or role in ('before','after','detail','video')),
  constraint project_media_tg_unique unique (project_id, telegram_file_unique_id)
);
create index if not exists project_media_project_idx on public.project_media (project_id, sort);

alter table public.projects drop constraint if exists projects_cover_media_fk;
alter table public.projects add constraint projects_cover_media_fk
  foreign key (cover_media_id) references public.project_media(id) on delete set null;

create table if not exists public.project_publications (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  destination      text not null,
  content_queue_id uuid,
  scheduled_for    timestamptz,
  created_at       timestamptz not null default now(),
  constraint project_publications_destination_check check (destination in ('site','facebook','instagram','ig_story'))
);
create index if not exists project_publications_project_idx on public.project_publications (project_id);

alter table public.content_queue drop constraint if exists content_queue_project_fk;
alter table public.content_queue add constraint content_queue_project_fk
  foreign key (project_id) references public.projects(id) on delete set null;

-- weekly summary: one row per week (Sunday 08:00 Israel), so a retry never sends twice
create table if not exists public.weekly_reports (
  week_start date primary key,
  sent_at    timestamptz not null default now()
);


-- -------------------------------------------------------------
-- 4. Publishing guards in the DB (D2 + D3) and RLS
-- -------------------------------------------------------------
-- A media row "needs review" when the AI flagged a face / plate / house number and nobody tapped
-- "בדקתי, אפשר לפרסם" yet (D3: no auto-blur — review or remove the photo).
create or replace function public.project_media_needs_review(p_flags jsonb, p_ack timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_ack is null and coalesce(
    (p_flags ->> 'faces')::boolean or (p_flags ->> 'plates')::boolean or (p_flags ->> 'house_numbers')::boolean,
    false);
$$;

-- Blocks publishing a project (site) or scheduling it anywhere while it lacks consent or has
-- unreviewed flagged media. Raised as 23514 (check_violation) with a clear message.
create or replace function public.projects_guard_publish()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project uuid;
  v_consent text;
begin
  if tg_table_name = 'projects' then
    if new.status <> 'published' then return new; end if;
    v_project := new.id;
    v_consent := new.consent;
  else
    v_project := new.project_id;
    select p.consent into v_consent from public.projects p where p.id = v_project;
  end if;
  if coalesce(v_consent, 'unknown') <> 'yes' then
    raise exception 'project % has no publishing consent', v_project using errcode = '23514';
  end if;
  if exists (select 1 from public.project_media m
              where m.project_id = v_project and public.project_media_needs_review(m.ai_flags, m.flags_ack_at)) then
    raise exception 'project % has flagged media that was not reviewed', v_project using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists projects_guard_publish on public.projects;
create trigger projects_guard_publish before insert or update of status, consent on public.projects
  for each row execute function public.projects_guard_publish();
drop trigger if exists project_publications_guard on public.project_publications;
create trigger project_publications_guard before insert on public.project_publications
  for each row execute function public.projects_guard_publish();

-- RLS: the public (anon) sees only published + consented projects and their media.
alter table public.projects             enable row level security;
alter table public.project_media        enable row level security;
alter table public.project_publications enable row level security;
alter table public.weekly_reports       enable row level security;

revoke all on table public.projects, public.project_media, public.project_publications, public.weekly_reports from anon;
grant select on table public.projects, public.project_media to anon;
revoke all on table public.weekly_reports from authenticated;      -- service_role only

drop policy if exists "public reads published projects" on public.projects;
create policy "public reads published projects" on public.projects for select to anon
  using (status = 'published' and consent = 'yes');
drop policy if exists "public reads media of published projects" on public.project_media;
create policy "public reads media of published projects" on public.project_media for select to anon
  using (exists (select 1 from public.projects p
                  where p.id = project_media.project_id and p.status = 'published' and p.consent = 'yes'));
drop policy if exists "panel manages projects" on public.projects;
create policy "panel manages projects" on public.projects for all to authenticated using (true) with check (true);
drop policy if exists "panel manages media" on public.project_media;
create policy "panel manages media" on public.project_media for all to authenticated using (true) with check (true);
drop policy if exists "panel manages publications" on public.project_publications;
create policy "panel manages publications" on public.project_publications for all to authenticated using (true) with check (true);


-- -------------------------------------------------------------
-- 5. social_comments.notified_at (comment alerts, Phase 13)
-- -------------------------------------------------------------
alter table public.social_comments add column if not exists notified_at timestamptz;


-- -------------------------------------------------------------
-- 6. Daily quota kinds: + media_ai (Gemini vision calls), media_file (files ingested)
-- -------------------------------------------------------------
alter table public.telegram_daily_usage drop constraint if exists telegram_daily_usage_kind_check;
alter table public.telegram_daily_usage add constraint telegram_daily_usage_kind_check
  check (kind in ('quote', 'receipt', 'media_ai', 'media_file'));

-- Same bodies as supabase-quotes-telegram.sql §5, only the kind list is wider.
create or replace function public.consume_daily_quota(p_kind text, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_kind is null or p_kind not in ('quote', 'receipt', 'media_ai', 'media_file') then
    raise exception 'consume_daily_quota: invalid kind' using errcode = '22023';
  end if;
  if p_limit is null or p_limit <= 0 then
    return -1;
  end if;

  insert into public.telegram_daily_usage as u (day, kind, count)
  values ((pg_catalog.now() at time zone 'Asia/Jerusalem')::date, p_kind, 1)
  on conflict (day, kind) do update
    set count = u.count + 1
    where u.count < p_limit
  returning u.count into v_count;

  if v_count is null then
    return -1;
  end if;
  return p_limit - v_count;
end;
$$;

create or replace function public.get_daily_quota_remaining(p_kind text, p_limit integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(coalesce(p_limit, 0) - coalesce((
           select u.count from public.telegram_daily_usage u
            where u.day = (pg_catalog.now() at time zone 'Asia/Jerusalem')::date
              and u.kind = p_kind), 0), 0);
$$;

revoke all on function public.consume_daily_quota(text, integer)       from public, anon, authenticated;
revoke all on function public.get_daily_quota_remaining(text, integer) from public, anon, authenticated;
grant execute on function public.consume_daily_quota(text, integer)       to service_role;
grant execute on function public.get_daily_quota_remaining(text, integer) to service_role;


-- -------------------------------------------------------------
-- 7. Storage
-- -------------------------------------------------------------
-- 7a. project-originals: PRIVATE. ≤ 2560px copies (D5) + short videos. The panel (authenticated)
--     uploads, previews and removes; the bot / server use service_role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-originals', 'project-originals', false, 52428800,
        array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 7b. project-media: PUBLIC BY URL (the site + Meta fetch the processed files), but NO select
--     policy, so nobody can LIST the bucket. Written by service_role only (the server's processing).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-media', 'project-media', true, 52428800, array['image/jpeg','image/webp','video/mp4'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "auth uploads project originals" on storage.objects;
create policy "auth uploads project originals" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-originals');
drop policy if exists "auth reads project originals" on storage.objects;
create policy "auth reads project originals" on storage.objects for select to authenticated
  using (bucket_id = 'project-originals');
drop policy if exists "auth deletes project originals" on storage.objects;
create policy "auth deletes project originals" on storage.objects for delete to authenticated
  using (bucket_id = 'project-originals');

-- 7c. Tighten content-media (unused by any code today): size + type limits, no public listing.
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']
 where id = 'content-media';
drop policy if exists "public can read content-media" on storage.objects;


-- =============================================================
--  VERIFY (run after the statements above)
-- =============================================================
-- a) select enum_range(null::public.content_media_type);                         → includes carousel
-- b) select table_name, column_name from information_schema.columns
--     where table_schema = 'public' and table_name in ('content_queue','content_queue_archive')
--       and column_name in ('project_id','media_items') order by 1, 2;          → 4 rows
-- c) select tablename, rowsecurity from pg_tables
--     where schemaname = 'public' and tablename in ('projects','project_media','project_publications','weekly_reports');
--                                                                               → 4 rows, all true
-- d) select pg_get_constraintdef(oid) from pg_constraint where conname = 'telegram_daily_usage_kind_check';
--                                                                               → quote, receipt, media_ai, media_file
-- e) select id, public, file_size_limit, allowed_mime_types from storage.buckets
--     where id in ('project-originals','project-media','content-media');
-- f) select policyname, cmd from pg_policies where schemaname = 'storage' order by 1;
--                                                    → no "public can read content-media"; 3 project-originals policies
-- g) select public.consume_daily_quota('quote', 15);  -- NOT needed; quotas already work. Don't run on production.


-- =============================================================
--  ROLLBACK (only if needed; top to bottom). Enum values can't be dropped — 'carousel' stays (harmless).
-- =============================================================
-- 1. create policy "public can read content-media" on storage.objects for select to public using (bucket_id = 'content-media');
--    update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'content-media';
-- 2. drop policy if exists "auth uploads project originals" on storage.objects;
--    drop policy if exists "auth reads project originals" on storage.objects;
--    drop policy if exists "auth deletes project originals" on storage.objects;
--    delete from storage.buckets where id in ('project-originals','project-media');   -- only if empty
-- 3. re-run §5 of supabase-quotes-telegram.sql (the two quota functions), then:
--    alter table public.telegram_daily_usage drop constraint telegram_daily_usage_kind_check;
--    alter table public.telegram_daily_usage add constraint telegram_daily_usage_kind_check check (kind in ('quote','receipt'));
-- 4. alter table public.social_comments drop column if exists notified_at;
-- 5. alter table public.content_queue drop constraint if exists content_queue_project_fk;
--    drop table if exists public.project_publications, public.weekly_reports;
--    alter table public.projects drop constraint if exists projects_cover_media_fk;
--    drop table if exists public.project_media, public.projects;
--    drop function if exists public.projects_guard_publish(), public.project_media_needs_review(jsonb, timestamptz),
--                            public.projects_touch_updated_at();
-- 6. drop index if exists public.content_queue_project_idx;
--    alter table public.content_queue drop column if exists project_id, drop column if exists media_items;
--    alter table public.content_queue_archive drop column if exists project_id, drop column if exists media_items;
