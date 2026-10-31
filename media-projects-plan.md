# Media Projects — plan (single source of truth)

_Branch: `feature/media-projects` · Created 2026-10-30 · Based on the Phase 0 recon (read-only) of 2026-10-30._
_Update the **Status** column and the **Log** at the end of every phase. `handoff.md` §34 has the progress summary (feature not shipped yet)._
_**Status (2026-10-31):** commands 1–6 of 7 done on the branch (not merged). Next: command 7 (social publishing: FB multi-photo, IG carousel, video; the weekly summary, comment alerts, the review request). Live: pg_cron scheduler, media-projects schema, projects realtime, telegram_parked_media, the 5 migrated projects (published in the DB). At merge: `supabase-lead-alert.sql`. Functions: 9 / 12._

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
| 3 | Durable scheduler | `pg_net` + `pg_cron` every 10 min + Vault; GitHub kept as backup (D8) | **Done + LIVE** — `supabase-scheduler-pgcron.sql` applied 2026-10-30 (CRON_SECRET rotated; Vault `cron_secret`); first run 17:25 UTC → 200 `{"processed":0…}` |
| 4 | Lead alert + review link | `leads` trigger → Telegram with a WhatsApp button (D11); `?review=1` opens the review modal (D10) | **Done on branch** — `supabase-lead-alert.sql` applies **at merge** |
| 5 | DB schema + buckets | The SQL as a file, PGlite tests, applied by the owner; tighten `content-media` | **Done + APPLIED** — `supabase-media-projects.sql` applied by the owner 2026-10-30, VERIFY a–f passed |
| 6 | Panel "📸 פרויקטים" tab | Browser resize + EXIF strip, TUS video upload, project list + edit | **Done on branch** (command 4) — + "➕ פוסט חדש" in ניהול תוכן; publishing shows "בקרוב" until phases 10–12; `supabase-projects-realtime.sql` **APPLIED** 2026-10-31; owner phone test pending |
| 7 | Bot project mode | Albums + "✅ סיימתי", consent question (D2), album vs receipt split | **Done on branch** (command 5, `24a5f1f`) — + automatic AI, only the open questions, destinations + timing (`publish_plan`), ✅ = ready; live run 20/20; `supabase-telegram-parked-media.sql` (albums outside a mode) SAFE NOW, not applied |
| 8 | Server processing | sharp: sizes, IG crops, watermark (D4); MP4 metadata; HEIC refusal; ≤ 2560px originals (D5) | **Done on branch** (command 2) — watermark: BADGE, 9.6% width, 85% opacity (owner, command 3) |
| 9 | AI | Pairing, HE + EN captions/hashtags/alt (D6), privacy flags blocking publish (D3), quota kinds | **Done on branch** (command 3) — live eval: roles 16/18, pairs ≥ 7/9, privacy 2/2 |
| 10 | Site gallery | DB-driven cards + service filter + slider + load more; HE + EN; responsive images; migrate the 5 static projects (D9); screenshot QA (D12) | **Done on branch** (command 6, `d111854`) — inline stage on desktop, full-screen dialog on phones; static fallback; the 5 projects migrated + published |
| 11 | Project pages | `/projects/<slug>` (D7) with server-rendered OG + JSON-LD; `sitemap-projects.xml`; screenshot QA (D12) | **Done on branch** (command 6) — `api/site.js` (9th function), HE + EN, canonical + hreflang, the mobile action bar |
| 12 | Publishing | FB multi-photo, IG carousel, two-phase IG video; destinations + timing + approve in the bot (D1); burst guard + notifications | **Site part done** (command 6: ready + site → published at its slot; bot, panel, cron). Social (FB / IG) = command 7 |
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
- **2026-10-30 — CRON_SECRET rotated + scheduler LIVE.** New 64-hex `CRON_SECRET` in `.env`, GitHub Actions secret (stdin, no trailing newline), Vercel Production (owner, redeployed) and Vault `cron_secret` (owner). GitHub run `41099296518` → 200 `{"processed":0…}`; pg_cron `publish-every-10-min` active, first run 17:25 UTC succeeded, `net._http_response` 200 `{"processed":0…}`. The 19 posts still `approved` for 1–9 Nov, 0 due, nothing published early.
- **2026-10-30 — `supabase-media-projects.sql` applied by the owner; VERIFY passed (read-only, `supabase` MCP):** (a) enum = image, video, reel, story, **carousel**; (b) `project_id` + `media_items` on content_queue AND content_queue_archive; (c) RLS on projects / project_media / project_publications / weekly_reports; (d) quota check + `consume_daily_quota` accept quote, receipt, media_ai, media_file; (e) buckets project-originals (private, 50 MB), project-media (public, 50 MB, jpeg/webp/mp4), content-media now 50 MB + 5 types; (f) storage policies: the 3 project-originals ones added, "public can read content-media" gone, the others unchanged. Guards present (`projects_guard_publish`, `project_publications_guard`, `projects_touch_updated_at`; 8 check constraints). RLS as designed: anon SELECT only on projects + project_media (published + consented), nothing on publications / weekly_reports; authenticated has no grant on weekly_reports. **Unchanged:** the existing policies on content_queue / archive / quotes / leads / business_expenses / reviews; quotes 10 (8 panel + 2 Telegram, max 015, counter floor 16); content_queue 19 approved (1–9 Nov, attempts 19) + 12 published + 5 rejected, archive 14; new tables empty.
- **2026-10-30 — Command 2 of 7: media processing (Phase 8, + the panel's upload helper for Phase 6).**
  - **sharp 0.35.5** pinned (`--save-exact`); the lockfile carries `@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64` (≈ 19 MB unpacked, far under the 250 MB function limit). Only `api/media.js` bundles it.
  - **`api/_media-process.js`:** type by magic bytes (JPEG / PNG / WebP; HEIC/HEIF/AVIF refused as `heic_unsupported` + Hebrew); auto-rotate, flatten onto white, sRGB, ≤ 2560 px; outputs: original JPEG q85 (private, never watermarked), w480 / w960 / w1600 WebP + w1600 JPEG fallback, Instagram 1080×1350 (4:5, attention crop). No EXIF / GPS / XMP / IPTC / ICC in any output (no profile = sRGB). Watermark bottom-right, 12% of the width, 3% margin, only when `projects.watermark` (D4).
  - **Watermarks:** 3 transparent PNGs in `assets/watermark/` (`wordmark` gold "MR. POLISH" in Playfair Display; `badge` the logo in a rounded gold-rimmed badge; `url` "mr-polishes.com" in Heebo), drawn once in Chrome by `tools/render-watermarks.js` (Vercel has no fonts, so the server only composites). **Default `wordmark` until the owner picks one.**
  - **`api/_video-meta.js`:** MP4/MOV box reader (brand, duration, display size, rotation, video/audio codec) over a Buffer or HTTP Range reads (moov anywhere, only a few KB fetched); `validateVideo`: ≤ 50 MB, H.264 / HEVC, 3 s – 15 min, MP4/MOV, Hebrew errors. (A test caught a bug before shipping: iPhone MOV brand "qt  " was compared untrimmed.)
  - **`api/media.js` — the 8th function** (8 / 12): `create-upload` (path in project-originals + signed upload URL + TUS endpoint), `process` (image → original + variants + IG + a `project_media` row, raw upload deleted; video → metadata via Range reads + optional cover → row), `delete` (files in both buckets + the row). Auth: panel session or `INTERNAL_API_SECRET` (the bot). Rate limits 60 / 30 / 30 per min; `process` uses the daily `media_file` quota (80/day; `media_ai` 30/day added to `_quota.js` for Phase 9).
  - **`shared/media-client.js`:** `prepareImage` (orientation, ≤ 2560, canvas re-encode = no metadata, HEIC where the browser decodes it, else a Hebrew hint), `captureVideoFrame`, `readVideoInfo`, `tusUpload` (6 MB chunks, progress, retry via HEAD from the server's offset, resume after reload).
  - **Bot path (Phase 7):** the Telegram video thumb becomes the cover via `process` + `cover_path`.
  - **Tests:** `media-process` (37), `api-media` (41), `panel-media-client` (19, Chrome). GPS checks parse the EXIF GPS directory (fixtures provably carry it; outputs carry no EXIF at all). `npm test` = **768 checks in 20 suites**.
  - **Samples** (gitignored): `.playwright-mcp/media-samples/` — every output for one gallery photo, the 3 watermark styles on a dark and a light floor, close-ups, a contact sheet.
- **2026-10-30 — Command 3 of 7: media AI + the watermark decision (Phase 9).**
  - **D4 decided:** watermark = the **badge**, 9.6% of the output width (20% smaller than 12%), **85% opacity**, the default everywhere (`api/_media-process.js` `WATERMARKS`; the other two stay available). Tests measure the size and the opacity (black vs white background).
  - **`api/_media-ai.js`** (no new function): `analyzeProject` + `applyMediaCorrection` via the quote bot's `callGemini` (`gemini-3.5-flash`, same key / busy detection; now with `logTag`, `temperature`, `timeoutMs` options — vision gets 55 s). Images re-encoded ≤ 1024 px without metadata; file names never sent; phones stripped from the user's text. Gemini suggests; CODE enforces: sentences with prices / phones / client names (משפחת / אצל / הלקוח + names the caller knows) / streets + house numbers are removed and every field re-checked (null if anything survives); the city only if the user said it (in the text or the transcript), never with a digit or a street word; enums + lengths; privacy flags → `ai_flags` (digits masked in notes); the CTA (052-9534540 + WhatsApp + site) is appended by code; hashtags 6–10, `_`-insensitive dedupe, the city tag added. Brand voice distilled (read-only) from the published captions. Quota: one `media_ai` unit per call (30/day); 429 / spend cap → `ai_busy`.
  - **Pairing:** AI pairs if valid and confident → else the AI's confident roles re-paired within roles (`ai-roles`; a 'detail' fills a missing before/after) → else file names → else upload order. `needs_review` whenever it isn't the AI's own pairs (the bot will show the pairs and ask Miri). `ai_role` / `ai_pair` kept for review.
  - **Live eval (`tools/media-ai-live-eval.js`, real Gemini; report in `.playwright-mcp/media-ai-eval/`):** **16 live calls — one over the agreed 15** (a re-run meant to be filtered ran unfiltered because a failed patch didn't stop it; the tool now has ONLY / SKIP_PRIVACY / SKIP_CORRECTIONS switches). Results on the 5 gallery projects (shuffled, neutral names), re-scored offline with the final code: **roles 16/18, pairs ≥ 7/9** (P1 6/6 + 3/3, P2 4/4 + ≥ 0/2, P3 0/2 + 1/1, P4 4/4 + 2/2, P5 2/2 + 1/1); service 5/5; city 5/5 (said → kept, not said → null); the P4 message with a client name, a street + number and a price → none of them in any output; privacy: the synthetic car plate → `license_plate`, the door number → `house_number`. Corrections: a role flip worked (partner fixed in code); the city change worked; **"shorter caption" was NOT applied by Gemini** (twice) → code now reports `caption_not_changed` so the bot can say so. P1's first attempt timed out at 25 s (6 images) → fixed with the 55 s vision timeout.
  - **Tests:** `media-ai` (58, offline), `media-process` (38). `npm test` = **827 checks in 21 suites**.
- **2026-10-31 — Command 4 of 7: caption rules + the panel tab (Phase 6).**
  - **Caption rules (owner), prompt AND code (`api/_media-ai.js`):** never "free" (חינם / ללא עלות / בלי עלות / free …; "free of" allowed) — sentences and tags dropped; new CTA "📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com"; only stated or visible work — sealer/protection, grout, crystal, anti-slip and crack repair are gated on the user's own words (sentences + hashtags + padding tags dropped; an unstated sealer/crystal service → other); `stated_claims` carried into corrections; slang words (מטורף …) and the stock opening "פרויקט אמיתי מהשטח, לא הדמיה" removed; captions capped at 3 sentences / 480 chars; the last 8 caption openings are sent as "open differently" (+ an `opening_repeated` warning); **"shorter" is verified** (≤ 80% of the old length) → one focused retry with a length budget → else the old caption stays + `caption_not_changed`.
  - **Live re-run: 3 calls (cap 4, enforced by the tool):** P1 basalt + P4 stairs + "תקצר" on P1. Both captions: 3 sentences, no slang, no stock phrase, no "free", no sealer (P1 keeps grout — it was stated). Shorter: 209 → 111 chars on the first try. Roles 6/6 + 4/4; P4 pairs 2/2; **P1 pairs 0/3 at confidence 0.9** (look-alike basalt photos) → `needs_review` is now also set for every project with 2+ pairs. Both openings shared a "…מעניקה מראה טבעי…" pattern; in production the recent-openings list counters this (the eval doesn't pass it).
  - **`api/media.js` (still 8 functions; maxDuration 60 → 120):** `analyze` (private originals ≤ 10; saves roles / pairs / alts / flags + quality, titles, caption in `ai_meta`; keeps an existing "בדקתי"; never erases a typed city), `correct` (on the current saved state), `delete-project` (all files incl. unprocessed uploads; cancels unpublished posts; reports Instagram posts to delete by hand). AI errors → 400 / 429 / 503 / 502 with Hebrew.
  - **Panel (`shared/projects-panel.js` + `admin.html`):** list (cover, title, city, service, status, destination chips, privacy warning, "מהבוט"), search + service filter, realtime (projects + project_media; refresh on focus as the fallback); editor: uploads (browser re-encode = no EXIF/GPS; TUS resumable with `upsert:false` for the insert-only buckets; per-file progress; resume after a reload; video cover frame), ✨ AI + corrections + ✂️ shorter, editable pairs (role, pair, ⇄ swap), texts HE + EN, caption, alt texts, privacy block ("בדקתי, אפשר לפרסם" / remove), quality chips, consent (who + when), watermark, hide from the site, destinations + timing (burst-guard slots, no past dates), status draft → ready when every gate passes, reorder / cover / delete a file / delete the project. **Publishing itself shows "בקרוב"; the choices are saved in `ai_meta.publish_plan`.** Phones: the side menu is now one scrollable row (it was a full screen of buttons in every tab).
  - **ניהול תוכן → "➕ פוסט חדש":** image / video / carousel (2–10) → content-media (EXIF stripped) → one `pending_approval` row at the next free slot. Carousels can't be approved yet (panel), and the publisher **fails closed** on `media_type='carousel'` until Phase 12.
  - **SQL:** `supabase-projects-realtime.sql` — **safe to apply NOW** (adds projects + project_media to supabase_realtime; idempotent).
  - **Tests:** `panel-projects` (75, Chrome, desktop 1280 + mobile 390; screenshots in `.playwright-mcp/panel-projects/`), `media-ai` 77, `api-media` 63, `publish-guard` 18, `sql-media-projects` 59. `npm test` = **946 checks in 22 suites**.
  - **Preview e2e** (`94f04ce`, `https://mrpolish-project-nyfyrdfzc-polish1.vercel.app`; via the internal secret — no panel login available; no AI, no publishing): a "[בדיקה]" project → 2 fake images via signed URLs → processed (all variants; public JPEG 1600×1200 without EXIF; IG 1080×1350) → one deleted → the project deleted → verified: 0 project rows, 0 media rows, 0 storage objects; the 19 approved posts untouched.
  - **Open (privacy, owner decision):** public variants are uploaded with `cache-control` 1 year; after a delete the **Supabase CDN kept serving the cached copy** (storage itself was empty). Proposal: 1 day for new variants — the URLs are unguessable, but a removed face photo should not stay reachable for a year.
- **2026-10-31 — Close-out.** `supabase-projects-realtime.sql` **APPLIED** (owner-approved, via the supabase MCP `execute_sql`); verified read-only: `supabase_realtime` = project_media, projects, quotes. **Cache decided (owner): public project-media copies get `Cache-Control: max-age=86400`** (`api/media.js` `PUBLIC_CACHE_SECONDS`, test updated; `4f4c65d`). `npm test` 946 / 22 (one unexplained intermittent suite failure in one run; not reproduced in 2 full runs + 15 suite repeats). `handoff.md` §34 written. Pending: the owner's phone test of the 📸 tab; the Phase 2 logged-in contract check.
- **2026-10-31 — Phone test run by Claude (owner skipped it).** UI on the preview (390 + 1280, stubbed session): 7/7 steps pass at both widths. Backend on the preview API (internal secret, real storage, 2 Gemini calls): 29/30 — the miss is a real bug: `cache-control` is sent as a bare number → served as `public, 86400` (invalid; fix = `max-age=`). Everything deleted and verified (0 rows / 0 files; the 19 approved posts byte-identical). A logged-in run stays for Phase 14. Details: `handoff.md` §34.7.
- **2026-10-31 — Fixes from the phone test (`e0d11e4`).** Cache-Control `public, max-age=86400` (originals `private, max-age=3600`), verified live on the preview by the new `tools/media-cache-check.js` (11/11, cleaned up). The caption editor shows a non-breaking hyphen in phone numbers + the domain (saved as "-"), so the number no longer wraps on phones. `npm test` = **950 checks in 22 suites**. One project no test created (`f2c63992…`, empty, made by a logged-in Edge browser on a preview at 01:55 on 31 Oct) — deleted by the owner.
- **2026-10-31 — Command 5 of 7: the bot's "📸 פרויקט חדש" (Phase 7, `24a5f1f`).** Details: `handoff.md` §34.10.
  - **Owner decisions:** a 7th menu button (TEST bot now, production at the merge); one status message "📥 התקבלו N קבצים"; text / voice = the description (voice in memory only, transcript shown once, never saved); ✅ סיימתי runs the AI **automatically**; then ONLY what's missing / risky, one question at a time (city, pairs when needs_review, each flagged photo, consent → no = private only); destinations + timing saved in `ai_meta.publish_plan` (the panel's structure; burst-guard slots); ✅ אשר = `ready` ("נשמר ✔ – הפרסום יופעל בשלב הבא"); edits ✏️ / 🎤 / ✂️; a photo that isn't a receipt → "להתחיל פרויקט חדש?" (no 2nd quota unit); an album outside a mode → "📷 קבלות או 📸 פרויקט חדש?"; stale empty projects swept.
  - **Code:** `api/_bot-projects.js` (helper; still 8 functions), webhook routing / menu / receipt hook, `api/media.js` (`telegram_file_unique_id` + 409 duplicate with cleanup; voice for analyze / correct), `_media-ai.js` (voice AND text), webhook `maxDuration` 60 → 180.
  - **SQL:** `supabase-telegram-parked-media.sql` — SAFE NOW, **not applied** (owner); without it albums outside a mode stay receipts, as today.
  - **Tests:** `bot-projects` 89, `api-media` 73, `sql-media-projects` 64, `bot-routing` 66 (7 buttons). `npm test` = **1054 checks in 23 suites**.
  - **Live run** (preview `lcin41a5r`, TEST bot, simulated updates, 2 real seeded photos): **20/20**, 1 Gemini unit, everything deleted through the bot and verified (0 rows / 0 files / 0 chat state; seed photos removed; the 19 approved posts byte-identical). The test bot's webhook now points at this branch's alias.
- **2026-10-31 — Command 6 of 7: the site (Phases 10, 11 + the site part of 12, `d111854`).** Details: `handoff.md` §34.11.
  - **Applied:** `supabase-telegram-parked-media.sql` (owner-approved, MCP; verified). **Migrated + published:** the 5 static projects (18 photos through the real pipeline, badge watermark, texts written from the photos — 0 AI calls; idempotent tool, re-run = "texts refreshed").
  - **Built:** `api/site.js` (gallery JSON, `/projects/<slug>`, sitemap, publish action), `api/_site-publish.js` (rules + D7 slugs; used by the bot's ✅, the panel's 💾 and a new cron pass), the homepage gallery (chips, cards with a "before" sliver, load more, the shared slider; inline on desktop, a full-screen dialog on phones), `shared/compare.js`. Panel bugs fixed on the way: the save toast was wiped; "מה עשינו?" text was lost on a realtime refresh.
  - **Tests:** `npm test` = **1138 checks in 25 suites** (new: api-site 47, site-gallery 34).
  - **QA (preview, real data, HE + EN × 375 / 768 / 1280 / 1920):** no horizontal scroll, 0 console errors, CLS ≤ 0.013, gallery images on a phone 2,750 KB (production today) → 1,100 KB. Screenshots: `.playwright-mcp/site-gallery/`.
