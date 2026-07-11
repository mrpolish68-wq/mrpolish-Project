# Mr. Polish — Project Handoff

_Last updated: 2026-07-11. Read this file first in a new chat session — it has everything needed to keep building without re-discovering the codebase from scratch._

## 1. Project Context

**Mr. Polish (מיסטר פוליש)** is the business site + management dashboard for Uri Margalit (אורי מרגלית), a floor-polishing / stone & marble restoration professional (30 years experience) based in Netanya, serving nationwide. The public site (`index.html`) is a marketing/lead-gen page (Hebrew RTL, English-ready). The **admin dashboard** (`admin.html`) is Uri's private back-office tool: leads, calendar, work-order PDF generation, business expense tracking with accountant Excel export, a live Facebook + Instagram engagement snapshot, and (as of this handoff) **a content approval + scheduled auto-publishing pipeline for Facebook/Instagram**.

**Stack — read this before assuming anything about tooling:**
- Plain static HTML/CSS/vanilla JS. **No build step, no bundler, no `package.json`, no npm** for the main site.
- Every third-party library is loaded via a CDN `<script>` tag directly in each HTML file's `<head>` (supabase-js, html2canvas, jsPDF, ExcelJS).
- All page-specific CSS lives inline in a `<style>` block inside each HTML file. `styles.css` is the one shared stylesheet (design tokens + components used across pages).
- All page-specific JS lives inline in a `<script>` block, wrapped in `(function () { "use strict"; ... })();` IIFEs. No TypeScript.
- Deployed on **Vercel**, mostly as a static site (`.vercel/` project link present, project name `mrpolish-project`), **plus serverless functions** under `api/` — the first departure from pure-static, added specifically because real secrets (Meta access token, Supabase service_role key) can't safely live in client-side JS the way the Supabase anon key does: `api/social-snapshot.js` (read-only Graph API proxy, see §3/§6) and `api/publish-scheduled-content.js` (cron-triggered publisher, see §7). `vercel.json` configures the cron schedule for the latter.
- Backend: **Supabase** (project ref `mmognkxkglkotzkuxzly`, URL `https://mmognkxkglkotzkuxzly.supabase.co`). The anon key is hardcoded inline in `admin.html` / `login.html` / `main.js` (not an env var — that's the established convention here, don't "fix" it by introducing `.env` handling unless asked). This is safe specifically because Supabase Row-Level Security gates every table — there's no equivalent safety net for the Meta token (see §6), so that one genuinely must stay server-side.
- Auth: Supabase Auth (email/password), single admin user (Uri) created manually in the Supabase Dashboard → Authentication → Users. `login.html` signs in; `admin.html` guards every load with a `localStorage` pre-check + a real `sb.auth.getUser()` server-side validation.

## 2. Database Schema

Supabase Postgres, all tables in the `public` schema, RLS enabled on every table. Only one migration file existed before this session (`supabase-reviews.sql`); `leads` and `site_stats` were created directly in the Supabase SQL editor/dashboard with no checked-in migration (so their exact DDL below is reconstructed from how the code queries them — verify against the live dashboard if precision matters).

### `public.reviews` — public testimonials (file: `supabase-reviews.sql`)
| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `created_at` | `timestamptz` | `now()` |
| `first_last_name` | `text` | |
| `job_date` | `text` | free text, e.g. "יוני 2024" |
| `job_type` | `text` | |
| `review_text` | `text` | |
| `approved` | `boolean` | default `false`; Uri approves manually in Supabase dashboard before it shows on the site |

RLS: `anon` can `INSERT` anything; `anon` can `SELECT` only where `approved = true`.

### `public.leads` — contact-form submissions (no migration file — reconstructed from queries)
Columns referenced in code: `id`, `created_at`, `name`, `phone`, `location`, `service`, `notes`. Public site's `main.js` inserts via raw REST `fetch()`. `admin.html` reads via authenticated `supabase-js` (`sb.from("leads")...`) — needs a `SELECT` policy for the `authenticated` role (already exists live, just not captured in a `.sql` file).

### `public.site_stats` — page view / WhatsApp click counters (no migration file)
Columns: `metric` (text, e.g. `"page_views"`, `"whatsapp_clicks"`), `count` (integer). Incremented via an `increment_metric` RPC called from the public site.

### `public.business_expenses` — **NEW**, business expense ledger (file: `supabase-business-expenses.sql`)
```sql
create type public.business_expense_category as enum (
  'סעדון יבוא שיווק והדברה בע"מ',
  'אשלי כלי יהלומים בע"מ',
  'דלק',
  'שונות'
);

create table public.business_expenses (
  id          uuid primary key default gen_random_uuid(),
  date        date not null default current_date,
  category    public.business_expense_category not null,
  amount      numeric(10,2) not null check (amount > 0),
  description text,
  created_at  timestamptz not null default now()
);
```
Index: `business_expenses_date_idx` on `(date desc)`.
RLS: **no `anon` policy at all** — only `authenticated` (Uri's logged-in session) may `SELECT`/`INSERT`/`UPDATE`/`DELETE` (`for all to authenticated using (true) with check (true)`). This is private financial data, unlike `reviews`/`leads` which have public-facing policies.

**⚠️ This migration has not been run yet** — you (or Uri) must execute `supabase-business-expenses.sql` in the Supabase SQL Editor before the new dashboard tab will show real data (it will show a load error until then).

### `public.content_queue` — **NEW**, content approval + publishing pipeline (file: `supabase-content-queue.sql`)
```sql
create type public.content_platform as enum ('facebook', 'instagram', 'both');
create type public.content_media_type as enum ('image', 'video', 'reel', 'story');
create type public.content_status as enum (
  'pending_approval', 'approved', 'rejected', 'published', 'failed'
);

create table public.content_queue (
  id             uuid primary key default gen_random_uuid(),
  title          text,                     -- internal label only, never posted
  caption        text not null,            -- the Hebrew copy that gets published
  media_type     public.content_media_type not null,
  media_url      text not null,            -- public URL Meta fetches the asset from
  thumbnail_url  text,
  platform       public.content_platform not null default 'both',
  scheduled_for  timestamptz not null,
  status         public.content_status not null default 'pending_approval',
  approved_at    timestamptz,
  published_at   timestamptz,
  fb_post_id     text,
  ig_post_id     text,
  publish_error  text,
  notes          text,
  created_at     timestamptz not null default now()
);
```
Index: `content_queue_status_scheduled_idx` on `(status, scheduled_for)`.
RLS: `authenticated`-only for the dashboard (same pattern as `business_expenses`) — **but the publishing cron job is not an authenticated user**, so `api/publish-scheduled-content.js` uses the Supabase **service_role key** (bypasses RLS) instead, via raw REST calls, never via the dashboard's session.

**Upgrade (file: `supabase-content-queue-upgrade.sql`, run after the two files above) — adds categorization + stored AI analysis:**
```sql
create type public.content_category as enum ('ad', 'post', 'reel', 'story');

alter table public.content_queue
  add column if not exists content_category public.content_category not null default 'post',
  add column if not exists ai_reach_forecast text,
  add column if not exists ai_why_it_works text,
  add column if not exists ai_brand_contribution text,
  add column if not exists ai_generated_at timestamptz;
```
`content_category` is a **separate dimension from `media_type`**: `media_type` (image/video/reel/story) drives the *technical* publish path in `api/publish-scheduled-content.js` (which Graph API call gets made); `content_category` (ad/post/reel/story) is the *marketing* classification the dashboard filters by — e.g. a video Reel could be `category='reel'` (organic) or `category='ad'` (a candidate to boost manually later) independent of its technical format. **`content_category='ad'` is currently just an internal planning label — no Meta Marketing API (real paid ads/campaigns/billing) is wired up.** That would be a separate, materially larger integration if ever wanted.

The `ai_*` columns hold a **one-time, authored-at-content-creation-time** analysis (not a live per-view AI call) — populated by hand (same care as the pilot captions: grounded in the real audit numbers, not invented figures) when content is queued, then just displayed read-only in the preview modal.

**Pilot batch analysis (file: `supabase-content-queue-pilot-ai-analysis.sql`, run after this upgrade file):** 7 `UPDATE` statements, one per pilot post matched by exact `title`, each setting `ai_reach_forecast`/`ai_why_it_works`/`ai_brand_contribution` + `ai_generated_at = now()`. Written per-post (not generic copy-paste) referencing the real audit findings — e.g. the tip-style post (#7) is honestly forecast *lower* than the before/after visual posts, since the two similar tip posts in the actual audit got zero likes; the hospital post (#5) is framed around institutional/B2B credibility rather than a follower-count-based estimate, since that content type has no real precedent on the page yet. **When queuing future content beyond this pilot, write this analysis the same way — specific to the piece, grounded in whatever the latest real numbers are, and honest about low-confidence cases** rather than defaulting to optimistic boilerplate.

**✅ `supabase-content-queue-upgrade.sql` and `supabase-content-queue-pilot-ai-analysis.sql` have both been run.**

**Further upgrade (file: `supabase-content-queue-ai-rating.sql`) — adds AI rating + optimal timing:**
```sql
alter table public.content_queue
  add column if not exists ai_rating integer check (ai_rating between 1 and 10),
  add column if not exists ai_rating_justification text,
  add column if not exists ai_optimal_timing text;

create index if not exists content_queue_rating_idx on public.content_queue (ai_rating);
```
Same "author once" philosophy as the other `ai_*` columns. **Pilot batch ratings (file: `supabase-content-queue-pilot-rating-seed.sql`):** 7 `UPDATE`s matched by `title`, same as the analysis file. Written with **deliberately uneven scores, not defaulted-high** — the repeat-angle post (#6, "בזלת שחורה זווית נוספת") scores 4/10 for audience-fatigue risk, the tip post (#7) scores 3/10 matching its historically weak format, while the two strongest before/after visuals (#1, #2) score 7/10. **If you author ratings for future content, keep this honesty principle** — a uniform wall of 8s and 9s defeats the entire point of having a rating to sort/prioritize by.

**⚠️ Not run yet as of this writing** — execute `supabase-content-queue-ai-rating.sql` then `supabase-content-queue-pilot-rating-seed.sql`, in that order, in the Supabase SQL Editor.

The same migration file also creates a public Supabase Storage bucket `content-media` (for future generated/uploaded media) — not needed for the pilot batch, which reuses images already publicly served from `assets/gallery/` on the live site.

**⚠️ Two migrations have not been run yet**: `supabase-content-queue.sql` (schema), then `supabase-content-queue-pilot-seed.sql` (7 real pilot posts, see §7) — run both, in that order, in the Supabase SQL Editor.

## 3. Key Features (active)

Dashboard tabs (`admin.html`, sidebar `data-view` → `#view-*`):
1. **`dash`** (📊 לוח בקרה ופעילות) — live metric cards (visits, leads, form submissions, WhatsApp clicks) + recent activity feed, from `site_stats` + `leads`.
2. **`leads`** (📋 ניהול לידים) — full searchable/sortable leads table (client-side filter/sort over a one-time fetch).
3. **`ai`** (🧾 הזמנות עבודה) — work-order form + price calculator → **PDF** via `html2canvas` + `jsPDF` (off-screen iframe render, hex-only CSS because html2canvas 1.4.1 can't handle `oklch()`).
4. **`expenses`** (💰 הוצאות עסק) — **NEW, this session:**
   - Summary card: total of all expenses dated `>= 2026-03-01` (the `EXPENSES_SINCE` constant in the JS — change this one line if the tracking start date needs to move).
   - Filterable table: category dropdown + from/to date range, client-side filtering over a one-time fetch (same pattern as the leads tab).
   - "➕ הוספת הוצאה" button opens a modal (`#expModal`) — date, category (4-option enum dropdown), amount, optional description → `INSERT` into `business_expenses`.
     - **Continuous-entry UX (updated):** the modal has two submit buttons — **"שמירה"** (primary) saves the expense, shows a green "✅ ההוצאה נשמרה בהצלחה" toast inside the modal (`#expToast`, auto-hides after ~2.5s), and **keeps the modal open** — it clears only the amount + description fields and refocuses the amount field, while **date and category are left untouched**, so Ori can log a run of same-day/same-category historical expenses (backfilling from March 2026) without reopening the modal each time. **"שמירה וסגירה"** (secondary) saves and fully closes the modal (same as the old single-button behavior). The `×` close button, the "ביטול" button, clicking the overlay, or `Escape` all still abandon/close without saving. Implemented via `e.submitter` on the form's `submit` event to tell which button was clicked (both are `type="submit"` inside the same `<form id="expForm">`).
   - 🗑 delete button per row (with a confirm prompt) → `DELETE` from `business_expenses`.
   - **"📊 ייצוא לאקסל" button — multi-sheet, categorized:** generates and downloads a `.xlsx` file client-side via **ExcelJS** (loaded from CDN, `cdnjs.cloudflare.com/.../exceljs/4.4.0/exceljs.min.js`). Exports the **full** expense list (not just the currently-filtered view) so the accountant always gets the complete ledger. Structure:
     - **One worksheet per calendar month** that has expenses, tab-named e.g. `"מרץ 2026"`, `"אפריל 2026"` (Hebrew month name + year), in chronological order. Expenses are grouped into `byMonth[YYYY-MM]` client-side, then one sheet is built per key via the `addMonthSheet(workbook, sheetName, monthRows)` helper (defined just above the `exportBtn` click handler in the `loadExpenses` IIFE).
     - **Every sheet repeats the same header block:** the Mr. Polish logo image (a *fresh* `workbook.addImage()` per sheet — each sheet embeds its own copy, verified 3 separate `image*.jpeg` files in the `.xlsx` zip for a 3-month export), business name, "עוסק פטור 023062185" status line, and a "דו״ח הוצאות עסק — {חודש שנה} — עבור: טל כרמלי, רואה חשבון" line, then the column header row (תאריך / קטגוריה / סכום / תיאור, bold white-on-charcoal) which is **frozen** (`views: [{ state: "frozen", ySplit: 5 }]`) so it stays visible while scrolling.
     - **Grouped by category** in the fixed `CATEGORY_ORDER` array (`'סעדון יבוא שיווק והדברה בע"מ'`, `'אשלי כלי יהלומים בע"מ'`, `"דלק"`, `"שונות"`) — a category only gets a group if it has expenses that month. Each group starts with a merged, gold-tinted label row for the category name, lists that category's rows (still repeating the category in its own column, for filterability), then a **bold sub-total row** (`'סה"כ <קטגוריה>'`) with a top border.
     - Ends with a bold, charcoal-filled **grand-total row** ("סה\"כ הוצאות לחודש") summing the whole month.
     - **Print-friendly:** `sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: {...} }` on every sheet.
     - `HEBREW_MONTHS` and `CATEGORY_ORDER` are declared once near the top of the `loadExpenses` IIFE (next to `EXPENSES_SINCE`) — update `CATEGORY_ORDER` here (and the `<select>` options in the HTML + the Postgres enum in the SQL migration) together if a category is ever added/renamed.
     - **Button styling fix:** the button (`#expExportBtn`) originally used `.btn-shiny` (`class="btn btn-shiny btn-sm"` + a `<span class="shiny-content">` wrapper), which renders unreadable here — `.btn-shiny` is a near-transparent glass button (`background: radial-gradient(... / 0.18 opacity)`, `backdrop-filter: blur`) purpose-built to sit over a **dark hero/video background** (see its CSS comment in `styles.css`: "Subtle gold radial wash + glass blur over the charcoal hero"); on the dashboard's white `.panel` background it produced near-white-on-white, low-contrast text. **Fixed** by switching to `class="btn btn-navy btn-sm"` (same class already used for the modal's "ביטול"/calendar's "מחיקה" buttons) and dropping the now-unnecessary `.shiny-content` span — `.btn-navy` sets `--btn-bg: linear-gradient(135deg, var(--char-700), var(--char-900))` and `--btn-fg: var(--white)`, giving a solid dark charcoal-gradient background with solid white text (no transparency/mask animation), same `.btn`/`.btn-sm` shape and size as every other dashboard button. **Rule of thumb for any future button added to `admin.html`:** only use `.btn-shiny` over a dark/hero surface; on the light `.panel` background, use the plain `.btn` (already charcoal by default), `.btn-navy`, or `.btn-shimmer` (used for "➕ הוספת הוצאה" — also dark-based, safe on light panels).

All the expenses JS lives in one `var loadExpenses = (function () { ... return function loadExpenses() {...}; })();` block near the end of `admin.html`'s `<script>`, mirroring the existing `loadLeads` pattern exactly (lazy-loaded on first tab click, fetch-once, client-side filter/render).

5. **`social`** (📱 רשתות חברתיות) — **NEW, this session:**
   - Two summary cards: live Facebook Page follower count and Instagram follower count.
   - A unified, chronologically-sorted table of the last ~10 posts from **both** platforms (platform badge, date, clickable caption snippet linking to the live post, likes, comments, shares — Instagram has no "shares" concept so that column shows "—" for IG rows).
   - "🔄 רענון נתונים" button re-fetches on demand; the tab also lazy-loads once on first open (same `loadX = (function(){... return function loadX(){ if(loaded) return; ...} })()` pattern as every other tab, except the refresh button bypasses the `loaded` guard deliberately so manual refresh always works).
   - **Unlike every other tab, this one does NOT call Supabase or the Meta Graph API directly from the browser** — it calls `fetch("/api/social-snapshot")`, a new Vercel serverless function. See §6 for exactly why, and for the required production setup step that is **not yet done**.

6. **`content`** (🗂️ ניהול תוכן) — approval workflow only, see §7 for the full pipeline:
   - **Content Health widget** (`#cqHealth`, top of the tab) — **NEW**: two headline numbers (pending-approval count, count scheduled in the next 7 days from `now()`) plus a small CSS-only "bar chart" breaking down *pending* posts by `content_category` (no charting library — proportional-width `<div>` bars, `renderHealth()`). Recomputed on every fetch/insert/update/delete so it never goes stale.
   - Card-grid layout (not a table — content needs visual preview), one card per queued post: a `.cq-card-check` selection checkbox and an `⭐ N/10` rating badge (only if `ai_rating` is set) both float over the thumbnail, then status badge (color-coded), platform badge, scheduled date/time, truncated caption, and status-appropriate actions. All card markup lives in one shared `cardHtml(r)` function, used by both this grid and the calendar's day-detail panel.
   - **Filters + sort — NEW, expanded**: status, platform, **category** (`content_category`: ad/post/reel/story), and a **sort-by** dropdown (`תאריך פרסום` default / `דירוג AI` high→low / low→high, treating `null` ratings as lowest so unrated content sorts to the bottom). All four live in `currentRows()`.
   - **Bulk actions — NEW** (`#cqBulkBar`): a "בחר הכל" checkbox + live "N נבחרו" counter + three buttons (אשר / דחה / מחק נבחרים), disabled when nothing is selected. Selection state is a plain `{id: true}` object (`selectedIds`), synced to the on-screen checkboxes via `syncSelectionUI()` after every render. Bulk approve/reject use one batched `sb.from("content_queue").update(...).in("id", ids)` call each (not a loop of individual updates); **bulk delete is the first real `DELETE` capability in this feature** — confirmed via a native `confirm()` dialog warning it's permanent, since unlike reject (recoverable status change) this actually removes rows.
   - **Duplicate action — NEW**: a "🔁 שכפול" button on every card regardless of status (duplicating a published post to reuse later is a legitimate use case). Copies caption/media/platform/category into a fresh row, schedules it **one day after** the original (avoids an accidental same-instant duplicate publish), resets status to `pending_approval`, and deliberately leaves all `ai_*` fields empty — a duplicate's new schedule/context hasn't actually been analyzed, so it shouldn't inherit the original's rating/forecast.
   - **"👁 תצוגה"** opens a preview/edit modal (`#cqModal`) — FB/Instagram mockup + stored AI analysis, then the editable fields, then actions: **"💾 שמירת שינויים"** (save edits, stay pending), **"✅ אשר ותזמן"** (save edits + approve in one step), **"✋ דחה"** (reject).
     - **Mockup tabs** (`.cq-mock-tab`, default: Facebook): two stylized "phone card" mocks — `.cq-mock-fb` (avatar + page name + timestamp row, caption, image, אהבתי/תגובה/שיתוף action row) and `.cq-mock-ig` (avatar + `mr.polish.floors` username, square image, heart/comment/share/save icon row, `username + caption` line). Pure CSS/HTML populated from the row's own `caption`/`media_url` in `openPreview()` — no new data, no API calls.
     - **Real "…עוד" / "הצג פחות" expand-collapse — FIXED, was previously just static truncated text.** `renderMockCaption(container, fullText, max)` builds a text node + a `<button class="cq-mock-more">` that toggles the text node's content between the truncated slice and the full caption on click (220 chars for the FB mock, 125 for IG, mimicking each platform's real caption-collapsing point). Verified: click grows the rendered text and flips the button label.
     - **AI Analysis panel** (`#cqAiSection`) — shown only when at least one `ai_*` field is set on the row; hidden entirely otherwise (verified both states). Always shows the disclaimer "אומדן כיווני מבוסס על ביצועי העמוד עד כה - לא תחזית מדויקת" — **do not remove this line if editing the section**; these are authored qualitative estimates, not a real forecasting model. **NEW: a rating badge** (gold circle, `N/10`) + its justification text, shown only if `ai_rating` is set; **and an "תזמון אופטימלי" (optimal timing) line**, shown only if `ai_optimal_timing` is set.
   - Card-level quick actions: **"✅ אשר"** / **"✋ דחה"** on `pending_approval`/`failed` cards; **"✋ ביטול אישור"** on `approved` cards (cancel before the cron publishes it); `published`/`rejected` cards only get preview + duplicate.
   - **Approving only sets `status = 'approved'` in Supabase — it never calls Meta.** The actual publish happens later, server-side, when `api/publish-scheduled-content.js` runs on its cron schedule and finds the row's `scheduled_for` has arrived. This is the one hard rule of the whole feature: **nothing publishes without this explicit approval step.**

7. **`content-calendar`** (🗓️ לוח תוכן) — **NEW, this session, replaces the old meetings calendar entirely** (the old `יומן פגישות` tab — month grid + `localStorage` notes, `mrp_cal_notes` — is **gone**, not kept alongside; Ori didn't need it and asked for a full repurpose). Grouped directly after "ניהול תוכן" in the sidebar — both nav buttons sit at the bottom of the list, adjacent, by design.
   - Same month-grid component the old calendar used (`.cal`/`.cal-grid`/`.cal-day` CSS classes kept, rendering logic fully replaced) — prev/next month nav, but each day cell now shows a small colored dot per `content_queue` row scheduled that day (color matches the grid view's status badges; 5+ posts on one day show a `+N` overflow instead of more dots). A legend below the grid spells out what each color means.
   - Clicking a day renders that day's post(s) below the grid (`#ccalDayDetail`), using the **exact same card markup and approve/reject/preview actions** as the grid view.
   - **Shares one Supabase fetch with the `content` tab** — both are driven by the same `allContent` array inside a single enclosing IIFE that exposes two entry points, `loadContentQueue` and `loadContentCalendar` (see the code comment above that IIFE in `admin.html`). Whichever tab opens first fetches; the other reads the same in-memory data. Approving/rejecting from *either* view's UI updates both instantly (verified: approved a post from the calendar's day-detail panel, switched to the grid tab, saw the updated status with no refetch).

## 4. Asset References

- **Logo files (repo root):** `logo.jpg` (100KB), `logo.webp` (59KB, used in the sidebar `<img>`).
- **Inline base64 logo constant:** `admin.html` defines `var MRP_LOGO_DATA_URI = "data:image/jpeg;base64,...";` (~line 795 area, search for `MRP_LOGO_DATA_URI`) specifically so PDF/Excel generation never depends on a network fetch (avoids CORS/path issues with html2canvas, and keeps the export self-contained). **The new Excel export reuses this exact same constant** via `workbook.addImage({ base64: MRP_LOGO_DATA_URI, extension: "jpeg" })` — do not duplicate the base64 string if you build another export feature; reference this constant.
- Business identity strings used in exports (work-order PDF and now the Excel export): brand name **"Mr. Polish" / "מיסטר פוליש"**, address **"רח׳ אהרון אהרונסון 15, נתניה"**, phone **"052-9534540"**, tax status **"עוסק פטור 023062185"** (confirmed — do NOT change to "עוסק מורשה" or add VAT, see `memory.md`).
- Gallery/marketing photos: `assets/gallery/*.jpeg`, `assets/hero-bg.mp4`, `assets/hero-poster.jpg`.

## 5. How to Continue — adding the next dashboard feature

Follow the exact pattern used for every existing tab (leads, work-order, and now expenses) — there is no router, no component framework, just this recipe inside `admin.html`:

1. **Sidebar nav:** add `<button data-view="yourtab"><span class="ic">🔧</span> שם הטאב</button>` inside `#adminNav`.
2. **Titles map:** add `yourtab: "שם הטאב"` to the `titles` object (search for `var titles = {`).
3. **Lazy-load wiring:** add `if (v === "yourtab") loadYourTab();` next to the existing `if (v === "expenses") loadExpenses();` line in the nav click handler.
4. **View section:** add `<section class="admin-view" id="view-yourtab">...</section>` inside `.admin-content`, following the `view-head` → content pattern used by every other tab.
5. **CSS:** add a `/* ===== Tab N: Your Tab ===== */` block to the inline `<style>` in `admin.html`, right before the `@media (max-width: 900px)` responsive block at the end — reuse existing classes where possible (`.metric-grid`/`.metric` for summary cards, `.leads-table`/`.leads-table-wrap` for any list/table, the `.exp-modal*` classes as a template for any new modal).
6. **JS:** add a `var loadYourTab = (function () { ...; return function loadYourTab() { ...}; })();` block near the end of the `<script>`, mirroring `loadLeads` or `loadExpenses` — fetch once from Supabase (`sb.from("your_table")...`), keep the dataset in a closure variable, filter/sort/render client-side into a `tbody.innerHTML` template string, escape all user data with a local `esc()` helper.
7. **New Supabase table:** write a new `supabase-yourtable.sql` file at the repo root, mirroring `supabase-business-expenses.sql` — `uuid` PK via `gen_random_uuid()`, `created_at timestamptz default now()`, enable RLS, and default to an `authenticated`-only policy (`for all to authenticated using (true) with check (true)`) unless the data needs to be public-readable (then split `anon`/`authenticated` policies like `reviews` does). **Run the SQL in the Supabase SQL Editor yourself — nothing in this repo runs migrations automatically.**
8. **Any new CDN library** (PDF/Excel/chart/etc.): add its `<script src="https://cdnjs.cloudflare.com/...">` tag in `<head>` next to the existing html2canvas/jsPDF/ExcelJS tags. Don't introduce npm/a bundler for this — it breaks the zero-build-step deploy model.
9. **Test before calling it done:** there's no test suite. Verify by actually opening `admin.html` in a browser. Since it's gated by real Supabase auth, either log in with Uri's real credentials, or (as done for this feature) intercept the `supabase-js` CDN request with a mock client (Playwright `page.route`) that stubs `auth.getUser()` and `.from(table)` chainable query builders — this validated the expenses tab, modal, delete, and Excel export end-to-end without touching production data.
10. **If the new feature needs a real secret/credential (API key, access token — anything that isn't safe to expose the way the Supabase anon key is)**: do NOT hardcode it into `admin.html`'s client-side JS. Follow the pattern in §6 instead — add a file under `api/` (e.g. `api/your-thing.js`, `module.exports = async function handler(req, res) {...}`), read the secret from `process.env` there, and have the dashboard `fetch("/api/your-thing")` instead of calling the third-party API directly. Vercel auto-detects any `.js` file under `api/` as a serverless function with zero config. The secret itself goes in Vercel's Project Settings → Environment Variables, never in a file that gets committed.

## 6. Meta (Facebook + Instagram) Integration — NEW, this session

Ori asked for a verified connection to the Mr. Polish Facebook Page, followed by a growth-automation capability overview, a real audit of the Page + Instagram, and a first "Social Snapshot" dashboard tab. Getting a working, correctly-scoped token took many iterations — the key lessons below will save a lot of time if this needs to be redone (e.g. after a token expires).

**The business's Meta assets:**
- Facebook Page: **"Mr. Polish - מיסטר פוליש"**, Page ID `634986539915658`, username `margalitlitushim`, ~309 followers.
- Instagram: **`mr.polish.floors`**, IG User ID `17841445998040243`, ~9 followers. Was NOT linked to the Facebook Page for most of this session — linking a Business/Creator IG account to the Page in Meta Business Suite (Settings → Linked accounts, or from the Instagram app's Account Center) is a **separate step** from adding both assets to the same Business Portfolio; the latter does not create the Graph-API-visible connection. It's linked now.
- Meta App: **"MrPolishAutomation"**, App ID `1172411195957907`.

**Hard-won lessons on getting a working token (skip these mistakes next time):**
1. **Graph API Explorer's default token is always a User token**, even after you pick a Page from the dropdown — the dropdown changes *context*, not necessarily the token *type*. The only reliable way to confirm what you actually have is to hit `https://graph.facebook.com/v20.0/debug_token?input_token={token}&access_token={app-id}|{app-secret}` and check `"type"` (`USER` vs `PAGE`) and `"granular_scopes"` (which lists the exact Page ID each permission is scoped to). This is a **safe** diagnostic call — it only describes the one token you pass in, unlike `/me/accounts` which returns *other* tokens in its response and should never have its raw output printed anywhere.
2. **A User token with the right page-scoped permissions still returns your personal profile at `/me`.** Don't rely on `/me` to "verify the Page." Instead, once `debug_token` shows the target Page ID under `granular_scopes`, query that Page ID directly: `GET /{page-id}?fields=id,name`.
3. **Facebook's "New Pages Experience" rejects a User token for content endpoints** (`/posts`, `/insights`) with error code 190 / subcode 2069032, even when that same User token can read the Page's basic profile fields fine. You need the **genuine Page Access Token** for anything beyond basic profile reads.
4. **Getting the genuine Page token:** exchange the User token via `/me/accounts?fields=id,name,access_token` — this returns each managed Page's *own* token. **Never print that response** (it contains live credentials); `tools/fetch-page-access-token.js` does this exchange and writes the result straight into `.env` as `META_PAGE_ACCESS_TOKEN` without ever logging the value.
5. **App Access Token (`{app-id}|{app-secret}`) is a dead end for anything Page-related** unless the app has "Page Public Metadata Access" explicitly enabled (Permissions and Features) — even then it's read-only public data, never posting/management. Not worth pursuing further; the real Page token is the right tool.
6. **New Business Portfolios get a 7-day restriction on creating System Users** — there's no bypass; if this happens again, use the Graph API Explorer path (get the app's "Manage everything on your Page" use case configured first with `pages_show_list` / `pages_read_engagement` / `pages_manage_posts`, *then* generate the Page token from the Explorer's Page dropdown).

**`.env` variables this integration uses** (all local-only, gitignored via the existing `.env*` rule):
- `META_ACCESS_TOKEN` — the raw User token from Graph API Explorer (short/medium-lived; re-generate via Explorer + rerun `tools/fetch-page-access-token.js` if things start failing with auth errors).
- `META_PAGE_ACCESS_TOKEN` — the derived, genuine Page token (written by `tools/fetch-page-access-token.js`, never printed). **This is what `api/social-snapshot.js` needs in production.**
- `META_PAGE_ID` — `634986539915658`.
- `META_IG_USER_ID` — `17841445998040243`.
- `META_APP_ID` / `META_APP_SECRET` / `META_PAGE_USERNAME` — used by the App-Access-Token fallback path in `tools/verify-facebook-token.js`.

**Tools (all in `tools/`, plain Node, no dependencies, run with `node tools/<file>.js`):**
- `verify-facebook-token.js` — quick sanity check, prints the connected Page's name/ID (tries `META_ACCESS_TOKEN` + `META_PAGE_ID` first, falls back to the App-Token public-metadata path).
- `exchange-long-lived-token.js` — **run this first** on a fresh short-lived User token from Graph API Explorer: exchanges it for a ~60-day long-lived one via `/oauth/access_token?grant_type=fb_exchange_token`, writes it back to `.env` as `META_ACCESS_TOKEN`. Never prints the token value.
- `fetch-page-access-token.js` — **run this second**, on the now-long-lived `META_ACCESS_TOKEN`: exchanges it for the real Page token via `/me/accounts`, writes it to `.env` as `META_PAGE_ACCESS_TOKEN`, **never prints the token value itself**. A Page token derived from a long-lived User token can come back non-expiring (`debug_token` shows `expires_at: 0`) — confirmed for the current production token.

**`api/social-snapshot.js`** — the new Vercel serverless function. Reads `META_PAGE_ACCESS_TOKEN` / `META_PAGE_ID` / `META_IG_USER_ID` from `process.env` (Vercel's own env vars, NOT the local `.env` file — see the outstanding follow-up below), fetches the last ~10 Facebook posts + ~10 Instagram posts with engagement counts, merges and sorts them by date, and returns follower counts for both platforms. `admin.html`'s Social tab calls `fetch("/api/social-snapshot")` — it never touches the Meta token directly.

**Audit findings (2026-07-11, worth knowing before recommending content changes):** Facebook has 309 followers but essentially flat engagement — 16 likes, **0 comments**, 1 share across the last 15 posts (2026-06-28 to 07-03, ~2.5 posts/day). Instagram has only 9 followers but punched above its weight — 26 likes + 1 comment across 13 posts, meaning most of that engagement came from non-followers via Explore/Reels discovery, not the tiny follower base itself. Two "blog teaser" screenshot-style posts got 0 likes each vs. native video Reels performing consistently better. `rating_count: 0` on the Facebook Page (no live Facebook recommendations yet, unlike the Google-reviews pipeline already built into the site).

**✅ Resolved:** `META_PAGE_ACCESS_TOKEN` / `META_PAGE_ID` / `META_IG_USER_ID` are confirmed set correctly in Vercel's Project Settings and working in production — verified by curling the live `https://mr-polishes.com/api/social-snapshot` endpoint directly and getting real follower counts back with no errors.

## 7. Content Automation Pipeline — NEW, this session

Ori asked for a full "Content Automation Agent" (generate a month of content, approval workflow, scheduled auto-publish). Scoped down deliberately, by his own call, to: build the infrastructure now, pilot with a 1-week / 7-piece batch using only real existing photos, and hold off on any AI-generated content until the pipeline is proven end-to-end.

**Architecture:**
- `content_queue` table (§2) holds every piece: caption, media_url, platform, scheduled_for, status.
- Dashboard's "ניהול תוכן" tab (§3, item 7) is **approval-only** — Ori reviews/edits/approves/rejects; it never calls Meta directly.
- `api/publish-scheduled-content.js`, triggered by Vercel Cron (`vercel.json`), is the **only** thing that ever calls Meta to publish. It:
  1. Verifies the request via `CRON_SECRET` (Vercel automatically sends `Authorization: Bearer {CRON_SECRET}` for configured cron jobs — anyone else hitting the URL gets 401).
  2. Queries Supabase (via the **service_role key**, raw REST calls — no supabase-js, same no-dependency approach as `main.js`) for rows where `status = 'approved' AND scheduled_for <= now()`.
  3. Publishes each due row to Facebook and/or Instagram per its `platform` field, using the media-type logic below.
  4. Writes back `status = 'published'` + `fb_post_id`/`ig_post_id`/`published_at`, or `status = 'failed'` + `publish_error` — nothing disappears silently; failed rows are retryable from the dashboard.

**Publishing logic by media type** (exact endpoints are commented in the file header of `api/publish-scheduled-content.js`):
- **Image**: Facebook `POST /{page-id}/photos` with `url` + `caption`. Instagram is always a 2-step dance regardless of type: `POST /{ig-id}/media` (create a container) → poll `status_code` → `POST /{ig-id}/media_publish`.
- **Video/Reel**: Facebook `POST /{page-id}/videos` with `file_url` (a *simple* video post — true Reels-placement needs a more complex resumable-upload flow, not implemented). Instagram: same 2-step dance with `media_type=REELS` + `video_url`.
- **Story**: Instagram-only in v1 (`media_type=STORIES`) — Facebook Page Stories via API are unreliably documented for most apps, scoped out for now.
- **⚠️ Known scope limit:** the Instagram polling loop only waits ~10s (5×2s) before giving up — fine for images (this pilot's only media type), but video/Reel processing on Instagram can take much longer than one function invocation should reasonably block for. Before any video/Reel content goes through this pipeline, it needs a two-phase redesign (create the container on one cron tick, check-and-publish on a later tick) instead of the current synchronous poll-and-publish.
- **Instagram has no native "scheduled publish"** — every IG call publishes immediately. So the cron itself is the *only* scheduler for both platforms (checks `scheduled_for <= now()`, publishes right then) rather than relying on Facebook's separate native scheduling mechanism — keeps both platforms' behavior consistent instead of split across two different systems.

**New env vars this feature needs** (add to Vercel Project Settings; `SUPABASE_SERVICE_ROLE_KEY` should also go in the local `.env` if testing the publish function locally):
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Dashboard → Project Settings → API → `service_role` key. **Bypasses every RLS policy in the database** — treat it with at least as much care as the Meta token; Vercel env var only, never client-side, never committed.
- `CRON_SECRET` — any random string (e.g. generate via `openssl rand -hex 32`); set the same value in Vercel. Vercel sends it automatically as a bearer token when triggering the cron job.
- Reuses `META_PAGE_ACCESS_TOKEN` / `META_PAGE_ID` / `META_IG_USER_ID` already configured for `api/social-snapshot.js`.

**Cron schedule (`vercel.json`):** currently `"0 15 * * *"` (15:00 UTC daily = 18:00 Israel time) — chosen to land on the pilot batch's exact posting time. **This is a coarse, Hobby-plan-safe default**; Vercel Hobby cron jobs are limited to once/day and may not fire at the exact minute. If the account is on a Pro plan, tighten this to every 5–15 minutes for real scheduling precision across arbitrary times of day (one-line change in `vercel.json`).

**The 1-week pilot batch** (`supabase-content-queue-pilot-seed.sql`, 7 rows) — real photos only, no video, no graphics, one post/day 2026-07-12 through 07-18. **⚠️ Superseded: deleted per Ori's explicit decision** (`supabase-content-queue-delete-pilot.sql`, matches by `title`) before it ever published or was measured, in favor of proceeding straight to Batch 2 (§8) using only the pre-pilot audit data. The migration/seed files themselves are left in the repo as a record of what was tried and the reasoning behind the original real-photo-only approach — don't re-run `pilot-seed.sql`, the rows it would recreate are gone by design.

## 8. Content Batch 2 — competitor-informed, multi-format (NEW, this session)

Ori asked for a full "Marketing Operation Center" pass: delete the (unpublished, unmeasured) pilot, connect real competitor research, and generate a genuinely new batch covering all 4 categories (Ad/Reel/Post/Story) — proceeding immediately rather than waiting for pilot results (his explicit call, see the conversation for the tradeoff as presented).

**Competitor research (via `WebSearch`, not a specialized SEO skill — see tooling note below):**
- **Flora Litushim (פלורה ליטושים)** — established 1995, the closest positioned competitor: also trades on decades of experience, serves architects/interior designers/property managers (a B2B angle Mr. Polish has touched once, in the deleted pilot's hospital post).
- **Top Polish (טופ פוליש)** — a price-comparison/broker model ("get 3 quotes, save up to 35%"). Commoditized, price-first positioning.
- Market pricing found: general floor polishing ₪20-28/m² (₪35-55/m² for a typical home), marble ₪25-40/m², parquet ₪30-38/m² (wood).
- **Strategic conclusion driving Batch 2:** neither competitor's social presence is personal/story-driven — both read as service-page SEO content, not social content. **Differentiation angle: lean into Uri as a named craftsman with personal accountability, and away from any price-comparison framing** (that's Top Polish's entire model — competing there is a losing game against a broker business).

**Tooling reality-check (do this before assuming a named skill exists — see the conversation where several requested tool names didn't match anything real):**
- Used directly: `WebSearch` (competitor research), Canva MCP tools (`upload-asset-from-url`, `generate-design`, `create-design-from-candidate`, `export-design`, `start-editing-transaction`/`perform-editing-operations`/`commit-editing-transaction`), Higgsfield MCP tools (`media_import_url`, `generate_video`, `job_status`).
- **Not used, and why:** `claude-seo:seo-competitor-pages` (the plain `WebSearch` research was sufficient and faster for this scope); `100-days-content-ideas` (massively oversized for "one new batch" — that skill is built for a 100-day calendar); a skill literally named `impeccable` (it exists in the user's skill list but its actual function was never described anywhere I could see — invoking an unknown tool blind isn't worth the risk).

**⚠️ Real incident worth knowing about — AI-generated ad text came out wrong, not just ugly:** the first Canva `generate-design` pass for the ad graphic produced visually on-brand output (charcoal/gold marble, real logo) but with **garbled Hebrew text** — it rendered "the free chimney" (הארובה בחינם) instead of the requested "free inspection" (בדיקה חינם), plus a broken English sentence that was never requested at all. This is a known failure mode: AI design/image generators frequently mangle non-Latin script because they render it as pixels in a generated background rather than real text. **This was caught by actually reading the exported image, not assumed correct because the generation call succeeded.** Fixed via Canva's `start-editing-transaction` → `perform-editing-operations` (`replace_text`/`position_element`/`resize_element` to fix both the wrong words and the resulting layout overlap) → `commit-editing-transaction`, then re-exported. **If generating any future text-bearing graphic via Canva, always visually verify the actual Hebrew text before use — never trust the generation call succeeding as a proxy for the text being correct.**

**Assets are stored in the repo, not just referenced from Canva/Higgsfield's own hosting:** both `export-design` (Canva) and `generate_video` (Higgsfield) return **temporary, signed URLs** (the Canva export URL had a ~15.5-hour expiry) — unsafe for `content_queue.media_url`, since Meta needs to fetch that URL whenever the post is actually approved and published, potentially days later. Both were downloaded and committed under `assets/generated/` (same public-URL pattern as `assets/gallery/`):
- `assets/generated/ad-free-inspection.png` — the corrected Canva ad graphic (1080×1350).
- `assets/generated/reel-basalt-pan.mp4` — Higgsfield `seedance_2_0` (fast mode, 720p, 9:16, 5s, silent), image-to-video from the real `project1-after3.jpeg` as the start frame — a subtle camera pan/zoom over the actual photo, not a fabricated scene. Cost: 17.5 credits (checked via `get_cost` before submitting). **This is the first AI-generated video ever queued on this page — I could not preview the actual motion myself (no video tooling available in this environment), so Ori should watch it carefully in the preview modal before approving, same scrutiny as the text-correction incident above warrants for any AI-generated asset.**
- **Why a Reel specifically needed real video, not a relabeled photo:** Instagram's Reels publish endpoint (`media_type=REELS`) requires an actual video file — `api/publish-scheduled-content.js` would fail outright trying to submit a static image under that media type. There's no shortcut here; a genuine Reel needs genuine video.

**The 5-piece Batch 2** (`supabase-content-queue-batch2-seed.sql`, all `status = 'pending_approval'`, 2026-07-13 through 07-17): one Ad (the corrected Canva graphic), one Reel (the Higgsfield video), two Posts using real pilot-unused photos (`project2-before1.jpeg` — a deliberate "here's an honest before" transparency post; `project4-after2.jpeg` — first-person Uri-branded post), and one Story (`project1-before1.jpeg`, quick engagement question) — the page's first Story-format content. AI ratings are **deliberately uneven** again: the personal-branding post scores highest (7/10, grounded in the competitor gap), the brand-new Story and video formats score lowest (4 and 6) specifically because there's no track record yet for either format on this page, not because the ideas are weak — same honesty principle as every prior `ai_*` authoring pass in this project.

**✅ Both SQL files have been run.** The pilot is deleted; Batch 2's 5 rows are live in `content_queue` as `pending_approval`.

**🛑 Ori's explicit feedback, read this before touching the ad/reel again: he is NOT satisfied with either generated asset** (`assets/generated/ad-free-inspection.png` and `assets/generated/reel-basalt-pan.mp4`). He did not specify what's wrong with them — **the next session should ask him directly what's off** (composition? the fixed Hebrew copy? the video's motion/pacing? something else entirely?) rather than guessing and regenerating blind. Do not treat these two assets as finalized just because they exist and are wired into the queue — they are **pending both his approval workflow AND a content revision** before they should be trusted as ship-ready. The 3 real-photo posts + story in the same batch were not flagged, so that feedback appears scoped to the two generated assets specifically, not the whole batch.

### Status as of 2026-07-11 (what's actually done vs. still open)
**✅ Done:** `supabase-business-expenses.sql`, `supabase-content-queue.sql`, `supabase-content-queue-upgrade.sql`, `supabase-content-queue-pilot-ai-analysis.sql`, `supabase-content-queue-ai-rating.sql`, and `supabase-content-queue-pilot-rating-seed.sql` have all been run by Ori. `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are set in Vercel. The Meta token saga (see §6) resolved with a genuine long-lived, non-expiring **Page** token (`debug_token` confirmed `"type": "PAGE"`, `"expires_at": 0`) — both `META_ACCESS_TOKEN` and `META_PAGE_ACCESS_TOKEN` are current and verified working in production. The old meetings calendar has been fully replaced by "לוח תוכן" (§3, item 7), deployed and verified live. The preview modal's FB/Instagram mockup (with real expand/collapse captions) and full AI Analysis panel (reach forecast, why-it-works, brand contribution, rating, optimal timing) are built (§3, item 6), as are the Content Health widget, category filter + AI-rating sort, bulk approve/reject/delete, and Duplicate action — all tested with mocked data. The 7-post real-photo pilot was deleted before ever publishing (Ori's explicit call, §7/§8) in favor of Content Batch 2 (§8): real competitor research, one Canva ad graphic (with a caught-and-fixed garbled-Hebrew-text incident), one Higgsfield-generated Reel video, and two posts + one story using previously-unused real photos.

**⚠️ Still outstanding:**
- **Run `supabase-content-queue-delete-pilot.sql`, then `supabase-content-queue-batch2-seed.sql`**, in that order, in the Supabase SQL Editor.
- **Watch the Reel video (`assets/generated/reel-basalt-pan.mp4`) carefully in the preview modal before approving it** — this is the first AI-generated video ever queued on this page, and I had no way to preview the actual motion myself while building it.
- **Go review all 5 Batch 2 posts in "ניהול תוכן" (or "לוח תוכן") and approve/reject each one** — the first is scheduled 2026-07-13; nothing publishes until approved, by design.
- If any Meta-dependent tab starts failing with an auth error again despite the long-lived token: `debug_token` first (see §6, lesson 1) to see what actually changed before assuming the whole token-refresh dance needs repeating.
- Per `CLAUDE.md` rule #5: commit and push this milestone to GitHub to update the live Vercel deployment once verified.
