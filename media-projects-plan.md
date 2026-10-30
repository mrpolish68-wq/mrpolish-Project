# Media Projects — plan (single source of truth)

_Branch: `feature/media-projects` · Created 2026-10-30 · Based on the Phase 0 recon (read-only) of 2026-10-30._
_Update the **Status** column and the **Log** at the end of every phase. `handoff.md` gets a summary section only when the feature ships._

## 1. Goal
Miri manages Ori's project photos and short videos from her phone — in the Telegram bot (@mrpolish_expenses_bot) and in the admin panel (installed PWA):
- **Upload:** photos (+ short videos ≤ 20 MB via the bot; up to the 50 MB Supabase Free per-file cap via the panel).
- **AI (Gemini, suggests only):** pairs before/after, writes the caption + hashtags + per-image alt text in **Hebrew and English**, and flags faces, licence plates and house numbers.
- **Consent:** the bot asks "הלקוח אישר פרסום?" per project. No → stored privately only (enforced in the DB).
- **Destinations + timing:** Miri picks site / Facebook / Instagram / story and when; she approves in the bot (no extra approval).
- **Processing:** strip EXIF/GPS, resize, web formats, Instagram-safe JPEG crops (4:5 – 1.91:1), a subtle logo watermark (on by default, toggleable), keep a ≤ 2560px original copy privately.
- **Site:** a DB-driven project gallery (cards + service filter + the before/after slider + "load more"), a page per project at `/projects/<slug>` with its own Open Graph preview, excellent on mobile and desktop, Hebrew + English.
- **Publishing:** carousels (Facebook multi-photo + Instagram carousel) and videos through the existing `content_queue` pipeline (burst guard + Telegram notifications already live, handoff §33).
- **Panel:** a "📸 פרויקטים" tab with uploads.
- **Extras:** an instant Telegram alert for every new site lead (with a WhatsApp button); "the job is done → upload photos" from a quote; a WhatsApp review request; a weekly summary on Sunday 08:00; alerts for comments the analytics agent flags.
- **No conflicts** with posts made manually in the Meta apps (we only ever touch posts whose ids we stored).

## 2. Owner decisions (2026-10-30)
| # | Decision |
|---|---|
| D1 | **Miri approves in the bot.** Choosing destinations + timing and tapping approve is the approval; no second approval in the panel. |
| D2 | **Consent per project.** "הלקוח אישר פרסום?" — no → private only. Enforced in the DB (a published project must have `consent = 'yes'`; the public can read only published + consented projects). |
| D3 | **Privacy flags block publishing** (faces / plates / house numbers) until Miri taps **"בדקתי, אפשר לפרסם"** or removes the photo. **No auto-blur.** |
| D4 | **Watermark ON by default everywhere** (site, Facebook, Instagram), toggleable per project. |
| D5 | **Originals:** keep only a ≤ 2560px copy (private). **Videos are deleted from storage 7 days after a successful publish** unless the project uses them on the site. |
| D6 | **AI writes Hebrew + English** (caption, hashtags, alt text, page text). |
| D7 | **Slugs:** `/projects/<transliterated-service-city>` (e.g. `/projects/litush-basalt-beit-shemesh`); **city only, never the street or house number**. Collisions get `-2`, `-3`… |
| D8 | **Scheduler:** `pg_cron` + `pg_net` + Supabase Vault calls `/api/publish-scheduled-content` every 10 min; **GitHub Actions kept as backup** (claimRow + the 3-per-run cap make overlap safe). |
| D9 | **Migrate the 5 static gallery projects** into the DB as the first published projects. **Their before/after order is CORRECT** (owner checked). |
| D10 | **Google review link:** `https://g.page/r/CRSEpD2_CFoDEBI/review` (verified working). The WhatsApp review request uses it, plus `https://mr-polishes.com/?review=1` (opens the site's review form) as a secondary option. No client phone is stored anywhere: the request is a `wa.me/?text=…` link with no recipient; Miri picks the contact. |
| D11 | **All alerts** (new leads, weekly summary Sunday 08:00 Israel time, flagged comments, publish notifications) go to the **production bot's allowed chats (Miri)** for now. |
| D12 | **The site must look excellent on mobile AND desktop:** screenshot QA at 375 / 768 / 1280 / 1920, Hebrew + English, for every site-facing phase. |

## 3. Constraints (from the recon)
- **Vercel Hobby:** max **12 functions** (we use 11), 2 GB / 300 s per function, **4.5 MB request/response body** → every upload goes **directly to Supabase Storage** (signed or TUS), never through a function.
- **Supabase Free:** 1 GB storage, 5 GB egress / month, **50 MB per file** (global cap), 500 MB DB. Resumable (TUS) uploads: `/storage/v1/upload/resumable`.
- **Meta:** Instagram carousel ≤ **10** items via the API; every slide is cropped to the first slide's aspect ratio; images JPEG, 4:5 – 1.91:1; Instagram has no scheduling API; video containers need a **two-phase** publish (create now, publish on a later run). Facebook supports `DELETE /{post-id}`; Instagram media deletion is **unverified** (only third-party sources) — verify before relying on it. The account's Instagram publishing quota: 100 / 24 h (12 used on 2026-10-30).
- **Meta token:** valid, never expires, all needed permissions (incl. `instagram_content_publish`, `instagram_manage_contents`, `pages_manage_posts`) — but **`data_access_expires_at` = 2026-10-09 (past)** → re-authorize (Phase 1, part C).
- **sharp:** the prebuilt build **cannot decode HEIC** → bot: ask for photos sent as *photos* (Telegram delivers JPEG ≤ 2560px without EXIF); panel: resize + strip EXIF + crop **in the browser**; a HEIC sent as a file is refused with a Hebrew hint (or decoded via WASM later if needed).
- **Telegram:** albums = separate updates with one `media_group_id` (≤ 10); bots can download ≤ 20 MB; **today every photo/document goes to the receipt scanner** → a dedicated project mode is required.
- **Quota kinds** are fixed in the DB (`'quote','receipt'`) → add `'media_ai'`, `'media_file'`.
- **`content_queue_archive` must mirror every new `content_queue` column** (the daily archive copies `select=*`).

## 4. Architecture

### 4.1 Functions: 11 → 9 (of 12)
Old URLs keep working through `vercel.json` rewrites.

| Function | Change | Count |
|---|---|---|
| `api/panel.js` | **Merges** `publish-now`, `check-publish-status`, `check-pin-status`, `social-snapshot`, `analytics-refresh` (session-authenticated, `?action=`); rewrites keep the old paths | 5 → 1 |
| `api/media.js` | **New:** signed/TUS upload URLs, processing (sharp: strip, sizes, IG crops, watermark), AI analysis, project create/update/publish | +1 |
| `api/site.js` | **New:** server-rendered `/projects/<slug>`, `/sitemap-projects.xml`, public gallery JSON (CDN-cached) | +1 |
| `api/analytics-agent.js` | **Adds** `?task=lead-alert`, `weekly-summary`, `comment-alerts` (cron secret / internal secret) | 0 |
| `api/telegram-webhook.js` | **Adds** project mode, albums, consent question, destinations + timing, "job done → photos", review-request link | 0 |
| Unchanged | `analytics-agent`, `csp-report`, `parse-receipt`, `publish-scheduled-content`, `render-quote-pdf`, `telegram-webhook` | 6 |
| **Total** | | **9 / 12** (3 free) |

### 4.2 New pieces (one line each)
- **Table `projects`:** a draft → published project with consent, service, city (never a street), Hebrew + English text, watermark flag, `quote_id`.
- **Table `project_media`:** one file each: role (before / after / detail / video), pair number, private original path, public variants, IG crop, alt text, AI flags + acknowledgement.
- **Table `project_publications`:** which destination got which `content_queue` row, and when.
- **Table `weekly_reports`:** guarantees one weekly summary per week.
- **Columns:** `content_queue.project_id` + `media_items jsonb` (carousel list) + enum value `carousel` — **mirrored on `content_queue_archive`**; `leads.notified_at`; `social_comments.notified_at`.
- **Bucket `project-originals`:** private, 50 MB, images + video (≤ 2560px copies only, D5).
- **Bucket `project-media`:** public by URL, **no listing policy**, processed derivatives only.
- **Tighten `content-media`:** size + type limits; remove the public listing policy.
- **DB jobs:** `pg_net`; `publish-every-10-min`; `weekly-summary` (hourly on Sundays, gated in code to 08:00 Israel); `leads` AFTER INSERT trigger → `?task=lead-alert`; `video-cleanup` (D5).
- **Shared code (not functions):** `api/_meta-media.js` (carousel + two-phase video), `api/_media-process.js` (sharp + MP4 metadata), `api/_media-ai.js` (Gemini vision), `shared/media-client.js` (browser resize / EXIF strip / TUS).
- **Panel:** "📸 פרויקטים" tab. **Site:** DB-driven gallery with the static gallery as fallback; `/projects/<slug>` pages.

## 5. Draft SQL (reference only — the real migration is written and tested in Phase 5, then applied by the owner)
```sql
-- 1) enum + content_queue/archive (must stay mirrored)
alter type public.content_media_type add value if not exists 'carousel';
alter table public.content_queue          add column if not exists project_id uuid, add column if not exists media_items jsonb;
alter table public.content_queue_archive  add column if not exists project_id uuid, add column if not exists media_items jsonb;

-- 2) projects
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  status text not null default 'collecting' check (status in ('collecting','draft','ready','published','archived')),
  consent text not null default 'unknown' check (consent in ('unknown','yes','no')),
  consent_at timestamptz, consent_by text,
  service text check (service in ('floor_polish','crystal','marble_stone','sealer','concrete','bomanite','stairs','other')),
  city text,                                  -- never a street/house number (D7)
  title_he text, title_en text, summary_he text, summary_en text,
  completed_on date, watermark boolean not null default true,   -- D4
  cover_media_id uuid, quote_id uuid references public.quotes(id) on delete set null,
  source text not null default 'panel' check (source in ('panel','telegram','migrated')),
  telegram_chat_id bigint, ai_meta jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), published_at timestamptz,
  constraint projects_publish_needs_consent check (status <> 'published' or consent = 'yes')   -- D2
);
create table if not exists public.project_media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null check (kind in ('image','video')),
  role text check (role in ('before','after','detail','video')),
  pair_no int, sort int not null default 0,
  original_path text not null,
  variants jsonb,
  width int, height int, bytes bigint, duration_s numeric, codec text,
  alt_he text, alt_en text,
  ai_flags jsonb, flags_ack_at timestamptz,   -- D3
  telegram_file_unique_id text, created_at timestamptz not null default now(),
  unique (project_id, telegram_file_unique_id)
);
create table if not exists public.project_publications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  destination text not null check (destination in ('site','facebook','instagram','ig_story')),
  content_queue_id uuid, scheduled_for timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.weekly_reports (week_start date primary key, sent_at timestamptz not null default now());
alter table public.leads           add column if not exists notified_at timestamptz;
alter table public.social_comments add column if not exists notified_at timestamptz;

-- 3) RLS: the public sees only published + consented projects
alter table public.projects enable row level security;
alter table public.project_media enable row level security;
alter table public.project_publications enable row level security;
alter table public.weekly_reports enable row level security;
create policy "public reads published projects" on public.projects for select to anon
  using (status = 'published' and consent = 'yes');
create policy "public reads media of published projects" on public.project_media for select to anon
  using (exists (select 1 from public.projects p where p.id = project_id and p.status = 'published' and p.consent = 'yes'));
create policy "panel manages projects" on public.projects for all to authenticated using (true) with check (true);
create policy "panel manages media"    on public.project_media for all to authenticated using (true) with check (true);
create policy "panel manages pubs"     on public.project_publications for all to authenticated using (true) with check (true);
-- weekly_reports: service_role only (no policies)
-- D3 (privacy flags block publishing) is enforced in code at publish time AND by a check in the
-- publish RPC/function (no unacknowledged flagged media in a project being scheduled).

-- 4) quota kinds
alter table public.telegram_daily_usage drop constraint if exists telegram_daily_usage_kind_check;
alter table public.telegram_daily_usage add constraint telegram_daily_usage_kind_check
  check (kind in ('quote','receipt','media_ai','media_file'));
-- + update consume_daily_quota / get_daily_quota_remaining kind lists to match

-- 5) buckets
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
 ('project-originals','project-originals', false, 52428800, array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']),
 ('project-media','project-media', true, 52428800, array['image/jpeg','image/webp','video/mp4'])
on conflict (id) do nothing;
create policy "auth uploads originals" on storage.objects for insert to authenticated with check (bucket_id = 'project-originals');
create policy "auth reads originals"   on storage.objects for select to authenticated using (bucket_id = 'project-originals');
-- project-media: public by URL; NO public select policy (prevents listing). Writes by service_role only.

-- 6) durable scheduler + alerts (needs: create extension pg_net; Vault secrets 'cron_secret', 'internal_secret')
-- select cron.schedule('publish-every-10-min', '*/10 * * * *', $$ select net.http_get(
--   url := 'https://mr-polishes.com/api/publish-scheduled-content',
--   headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='cron_secret'))) $$);
-- select cron.schedule('weekly-summary', '0 4-6 * * 0', $$ ... ?task=weekly-summary (code sends only at 08:00 Israel, once per week_start) $$);
-- create function public.notify_new_lead() returns trigger language plpgsql security definer set search_path = '' as $$
--   begin perform net.http_post(url := 'https://mr-polishes.com/api/analytics-agent?task=lead-alert',
--     body := jsonb_build_object('id', new.id),
--     headers := jsonb_build_object('Content-Type','application/json','X-Internal-Secret',(select decrypted_secret from vault.decrypted_secrets where name='internal_secret')));
--   return new; end $$;
-- create trigger leads_notify after insert on public.leads for each row execute function public.notify_new_lead();
```

## 6. Phases
One phase per command; each ends with tests (`npm test` fully green), a preview check, a report, and a stop. Nothing merges without the owner's approval.

| # | Phase | Scope | Status |
|---|---|---|---|
| 1 | Health fixes + this plan | Plan file; leads health check on the live site; Meta re-authorization steps (owner does it) | **In progress** |
| 2 | Consolidate functions | `api/panel.js` + rewrites, no behavior change (11 → 7) | Not started |
| 3 | Durable scheduler | `pg_net` + `pg_cron` every 10 min + Vault; GitHub kept as backup (D8) | Not started |
| 4 | Lead alert + review link | `leads` trigger → Telegram with a WhatsApp button (D11); `?review=1` opens the review modal (D10) | Not started |
| 5 | DB schema + buckets | The SQL as a file, PGlite tests, applied by the owner; tighten `content-media` | Not started |
| 6 | Panel "📸 פרויקטים" tab | Browser resize + EXIF strip, TUS video upload, project list + edit | Not started |
| 7 | Bot project mode | Albums + "✅ סיימתי", consent question (D2), album vs receipt split | Not started |
| 8 | Server processing | sharp: sizes, IG crops, watermark (D4); MP4 metadata; HEIC refusal; ≤ 2560px originals (D5) | Not started |
| 9 | AI | Pairing, HE + EN captions/hashtags/alt (D6), privacy flags blocking publish (D3), quota kinds | Not started |
| 10 | Site gallery | DB-driven cards + service filter + slider + load more; HE + EN; responsive images; migrate the 5 static projects (D9); screenshot QA (D12) | Not started |
| 11 | Project pages | `/projects/<slug>` (D7) with server-rendered OG + JSON-LD; `sitemap-projects.xml`; screenshot QA (D12) | Not started |
| 12 | Publishing | FB multi-photo, IG carousel, two-phase IG video; destinations + timing + approve in the bot (D1); burst guard + notifications | Not started |
| 13 | Extras | Weekly summary (Sun 08:00), comment alerts, "job done → photos" from a quote, WhatsApp review request (D10), video cleanup (D5) | Not started |
| 14 | Audit + handoff | Security, privacy (Amendment 13, consent records, lead data in Telegram → privacy policy), accessibility, `handoff.md` section | Not started |

## 7. Risks
- Storage (1 GB) and egress (5 GB/month) on Supabase Free; the 50 MB per-file cap limits video.
- Meta: the lapsed data-access window (until re-authorized); IG carousel ≤ 10 + first-slide crop; IG deletion unverified; IG video processing slower than one run; partial "both" failures (the per-platform id guard covers them).
- Privacy: faces / plates / addresses in photos; consent records; lead data sent to Telegram (privacy policy update).
- HEIC / files sent as documents (EXIF/GPS) unless converted or refused.
- Scheduler: GitHub's schedule did not resume after re-enabling on 2026-10-30 (reset again at 15:42 UTC); pg_net adds a dependency on the DB being up.
- `content_queue_archive` must mirror new columns; the burst guard counts a carousel as one post (intended).

## 8. Log
- **2026-10-30 — Phase 0 (recon) done.** Findings in the conversation report; architecture above.
- **2026-10-30 — Phase 1 started:** this plan file; leads health check; Meta re-authorization steps.
