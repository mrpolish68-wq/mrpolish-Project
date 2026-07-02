-- =============================================================
--  Mr. Polish — "reviews" table for the dynamic testimonials
--  Run this once in the Supabase SQL Editor.
--
--  Flow: visitors submit reviews from the site (approved = false).
--  Uri approves them manually in the Supabase dashboard
--  (set approved = true) and only then do they appear on the site.
-- =============================================================

create extension if not exists "pgcrypto";

create table if not exists public.reviews (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  first_last_name  text not null,   -- שם פרטי ושם משפחה
  job_date         text,            -- תאריך עבודה (free text, e.g. "יוני 2024")
  job_type         text,            -- סוג עבודה
  review_text      text not null,   -- כתיבת ביקורת
  approved         boolean not null default false  -- gate: false until Uri approves
);

-- Fast lookup of the approved, newest-first list the site fetches.
create index if not exists reviews_approved_created_idx
  on public.reviews (approved, created_at desc);

-- -------------------------------------------------------------
--  Row-Level Security
--  The site uses the public "anon" key, so we must explicitly
--  allow: (1) anyone to INSERT a new review, and
--         (2) anyone to SELECT only rows where approved = true.
--  Unapproved reviews stay invisible to the public.
-- -------------------------------------------------------------
alter table public.reviews enable row level security;

drop policy if exists "public can submit reviews" on public.reviews;
create policy "public can submit reviews"
  on public.reviews
  for insert
  to anon
  with check (true);

drop policy if exists "public can read approved reviews" on public.reviews;
create policy "public can read approved reviews"
  on public.reviews
  for select
  to anon
  using (approved = true);
