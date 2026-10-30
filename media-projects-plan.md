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
- **Meta token:** valid, never expires, all needed permissions (incl. `instagram_content_publish`, `instagram_manage_contents`, `pages_manage_posts`). Re-authorized 2026-10-30: **`data_access_expires_at` = 2027-01-28** (re-authorize again before then — the same steps as Phase 1).
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
| 1 | Health fixes + this plan | Plan file; leads health check on the live site; Meta re-authorization steps (owner does it) | **Done** (2026-10-30) |
| 2 | Consolidate functions | `api/panel.js` + rewrites, no behavior change (11 → 7) | **Done on branch — merge pending** (merge only after Sunday 1 Nov 10:00 has published OK) |
| 3 | Durable scheduler | `pg_net` + `pg_cron` every 10 min + Vault; GitHub kept as backup (D8) | **Done on branch** — `supabase-scheduler-pgcron.sql` is **safe to apply now** (owner) |
| 4 | Lead alert + review link | `leads` trigger → Telegram with a WhatsApp button (D11); `?review=1` opens the review modal (D10) | **Done on branch** — `supabase-lead-alert.sql` applies **at merge** |
| 5 | DB schema + buckets | The SQL as a file, PGlite tests, applied by the owner; tighten `content-media` | **Done on branch** — `supabase-media-projects.sql` is **safe to apply now** (or at merge) |
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
- **2026-10-30 — Leads health check (owner-approved, live site):** one fake lead submitted with Playwright → Supabase answered **201** and the row **was saved** (then deleted; 6 real leads remain, last one 2026-06-24). No JS errors (only the known report-only CSP notice about `upgrade-insecure-requests`, and an `aria-hidden` focus warning on the preloader's skip button). Supabase edge logs (24 h): only this one POST, no rejected inserts. **Gap in ids:** real leads end at id 7 and the test got id 66 → 58 inserts consumed ids without saving (rejected inserts use up ids) — older than the 24 h log window, most likely the pre-2026-08-15 RLS bug (handoff §26), can't be dated. Counts: `site_stats` page_views 639, whatsapp_clicks 13, call_clicks 5 → visitors mostly reach Ori by WhatsApp / phone, not the form. **Risk to fix in Phase 4:** the form redirects to `thankyou.html` 400 ms after submit, which aborts the in-flight insert (`net::ERR_ABORTED` was logged even though the 201 arrived first) — on a slow phone connection the insert could be cut off before reaching Supabase. Fix: `keepalive: true` on the fetch (+ a test).
- **2026-10-30 — Lead form hotfix shipped separately** (`fix/lead-keepalive`, merge `5f246c5`, handoff §33.8): keepalive + the redirect waits for the insert (400 ms – 3 s); verified with one fake lead on the preview and on production (both saved, both deleted). Removed from Phase 4's scope.
- **2026-10-30 — Meta re-authorized by the owner** (Graph Explorer → both token tools → `META_PAGE_ACCESS_TOKEN` updated in Vercel Production → redeployed). Verified read-only: both tokens valid, `type` PAGE / USER, never expire, **`data_access_expires_at` 2027-01-28** (was 2026-10-09); Page ↔ Instagram link OK (306 / 9 followers, 31 IG posts); IG publishing quota 12 / 100. Latest production deployment (`f53943e`) Ready (final status 16:04 UTC, after the token was issued ~15:56 UTC). **Not machine-verifiable without a panel session:** that production reads the *new* Page token (every server route using it requires a session or `CRON_SECRET`) — confirm in the panel's Social tab, and by Sunday's first scheduled publish (1 Nov 10:00).
- **2026-10-30 — Phase 1 done.**
- **2026-10-30 — Phase 2 done on the branch (not merged).** `publish-now`, `check-publish-status`, `check-pin-status`, `social-snapshot`, `analytics-refresh` moved **byte-for-byte unchanged** (git `rename … (100%)`, same SHA-1) to `api/_<name>.js` and routed by **`api/panel.js`** (`?action=`); `vercel.json` rewrites keep every old URL, so `admin.html` is unchanged. **Functions 11 → 7:** `analytics-agent`, `csp-report`, `panel`, `parse-receipt`, `publish-scheduled-content`, `render-quote-pdf`, `telegram-webhook`. One unavoidable difference: `maxDuration` is per function — `api/panel.js` has 60 s (publish-now and analytics-refresh already had 60 s; check-publish-status, check-pin-status and social-snapshot had no setting, i.e. the plan default, and each finishes in a few seconds). Tests: `tests/api-panel.test.js` (38 offline checks: identical status + body vs. the original handlers, rate limits unchanged per action, vercel.json valid, exactly 7 functions); `npm test` = 570 checks in 14 suites (main merged into the branch). Live: `tools/panel-contract-check.js <preview>` — 16/16, production and preview return the same status + body for no session / invalid session / wrong method on every old URL; `/api/panel?action=nope` and `/api/_publish-now` → 404 on the preview. Authenticated read-only part (`--login`) waits for the owner. Preview: `https://mrpolish-project-lpauo8d02-polish1.vercel.app` (commit `390abdb`).
- **2026-10-30 — Phases 3–5 done on the branch (command 1 of 7).**
  - **Phase 3 (scheduler):** `supabase-scheduler-pgcron.sql` — pg_net + a pg_cron job `publish-every-10-min` at minutes 5, 15, 25 … calling the EXISTING `/api/publish-scheduled-content` with `Bearer <CRON_SECRET>` read from Vault (`cron_secret`) at run time; it sends nothing until the secret exists. **Safe to apply now.** GitHub stays as backup.
  - **Phase 4 (lead alert):** `api/_lead-alert.js`, served by `api/analytics-agent.js?task=lead-alert` (no new function; a dedicated `DB_WEBHOOK_SECRET`, not CRON_SECRET or INTERNAL_API_SECRET). Message: "🔔 ליד חדש מהאתר", separator, 👤 name, 📞 phone, 🛠️ service, 📍 location (if any), 💬 message (consent tag removed), 🕐 time; buttons "💬 וואטסאפ" (wa.me + a greeting) and "🗂️ פתח בפאנל". Idempotent via a conditional claim on `leads.notified_at`, released if nothing was delivered; a pg_cron sweep re-sends leads 1 min – 24 h old. `supabase-lead-alert.sql`: `notified_at` (old leads marked notified), a BEFORE INSERT reset (the public cannot pre-set it), the AFTER INSERT trigger (SECURITY DEFINER, swallows every error, so the insert never fails), the sweep job. **Apply at merge** (after DB_WEBHOOK_SECRET is in Vercel + Vault). `tools/ensure-db-webhook-secret.js` generated the value into `.env` (never printed).
  - **Review link:** `?review=1` / `#write-review` opens the write-a-review modal (no splash; HE + EN).
  - **Phase 5 (schema):** `supabase-media-projects.sql` — content_queue + archive mirrored (`project_id`, `media_items`), enum `carousel`; `projects` (D2 consent check, D7 slug + city checks, D4 watermark default on), `project_media` (D3 flags + ack), `project_publications`, `weekly_reports`; a DB guard refuses publishing / scheduling without consent or with unreviewed flagged media; RLS: anon sees only published + consented; quota kinds + both functions (superset); buckets `project-originals` (private) and `project-media` (public by URL, no listing); `content-media` gets limits and loses its listing policy (no code uses that bucket). **Safe to apply now.**
  - **Tests:** `sql-media-projects.test.mjs` (58, PGlite: all three files, applied twice), `lead-alert.test.js` (32), `site-review-link.test.js` (11). `npm test` = **671 checks in 17 suites**.
  - **For Phase 14:** the privacy policy must say that lead details are sent to the business's Telegram chat.
