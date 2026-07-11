# Mr. Polish — Project Handoff

_Last updated: 2026-07-10. Read this file first in a new chat session — it has everything needed to keep building without re-discovering the codebase from scratch._

## 1. Project Context

**Mr. Polish (מיסטר פוליש)** is the business site + management dashboard for Uri Margalit (אורי מרגלית), a floor-polishing / stone & marble restoration professional (30 years experience) based in Netanya, serving nationwide. The public site (`index.html`) is a marketing/lead-gen page (Hebrew RTL, English-ready). The **admin dashboard** (`admin.html`) is Uri's private back-office tool: leads, calendar, work-order PDF generation, and (as of this handoff) **business expense tracking with accountant Excel export**.

**Stack — read this before assuming anything about tooling:**
- Plain static HTML/CSS/vanilla JS. **No build step, no bundler, no `package.json`, no npm** for the main site.
- Every third-party library is loaded via a CDN `<script>` tag directly in each HTML file's `<head>` (supabase-js, html2canvas, jsPDF, ExcelJS).
- All page-specific CSS lives inline in a `<style>` block inside each HTML file. `styles.css` is the one shared stylesheet (design tokens + components used across pages).
- All page-specific JS lives inline in a `<script>` block, wrapped in `(function () { "use strict"; ... })();` IIFEs. No TypeScript.
- Deployed on **Vercel** as a static site (`.vercel/` project link present). No server/API routes exist — everything talks directly to Supabase from the browser using the public **anon key** (safe because Row-Level Security gates every table).
- Backend: **Supabase** (project ref `mmognkxkglkotzkuxzly`, URL `https://mmognkxkglkotzkuxzly.supabase.co`). The anon key is hardcoded inline in `admin.html` / `login.html` / `main.js` (not an env var — that's the established convention here, don't "fix" it by introducing `.env` handling unless asked).
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

## 3. Key Features (active)

Dashboard tabs (`admin.html`, sidebar `data-view` → `#view-*`):
1. **`dash`** (📊 לוח בקרה ופעילות) — live metric cards (visits, leads, form submissions, WhatsApp clicks) + recent activity feed, from `site_stats` + `leads`.
2. **`leads`** (📋 ניהול לידים) — full searchable/sortable leads table (client-side filter/sort over a one-time fetch).
3. **`calendar`** (📅 יומן פגישות) — month calendar, notes in **`localStorage`** (`mrp_cal_notes`), not Supabase.
4. **`ai`** (🧾 הזמנות עבודה) — work-order form + price calculator → **PDF** via `html2canvas` + `jsPDF` (off-screen iframe render, hex-only CSS because html2canvas 1.4.1 can't handle `oklch()`).
5. **`expenses`** (💰 הוצאות עסק) — **NEW, this session:**
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

### Outstanding follow-ups
- **Run `supabase-business-expenses.sql`** in the Supabase SQL Editor — the expenses tab UI is complete but the table doesn't exist in the live database yet.
- Per `CLAUDE.md` rule #5: commit and push this milestone to GitHub to update the live Vercel deployment once verified.
