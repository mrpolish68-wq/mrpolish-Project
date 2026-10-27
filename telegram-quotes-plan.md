# Telegram Quotes — Project Plan

Single source of truth for the "price quotes via Telegram bot" feature, across sessions.
Branch: `feature/telegram-quotes`. Production `main` stays untouched until the final merge.
Session handoff (status, commits, live DB state, tooling lessons): **`handoff.md` §32**. As of 2026-10-27: Phases 0–5b ✅ (test bot live on the branch preview), `awaiting_since` column applied (SQL Editor, not in migration history). Phase 5c ✅ (quote drafts in the bot). **Next:** Phase 5d (✅ → `create_quote` + PDF).

---

## 1. Goal

Ori and Miri create price quotes (הצעות מחיר) through the existing Telegram bot
(`api/telegram-webhook.js`, @mrpolish_expenses_bot) using **Hebrew voice**, **free text** or a **menu button**.

1. The bot builds a **draft**, which is reviewed and edited in-chat, then approved.
2. On approval:
   - a race-safe quote number is allocated;
   - the quote is saved to `public.quotes`;
   - a server-side PDF is rendered with the **same template as `admin.html`**;
   - the PDF is stored in a **private** Storage bucket and sent back to the requesting chat.
3. The new quote syncs live to `admin.html`, which is installed as a home-screen PWA on 3 phones.

---

## 2. Approved decisions

### PDF
- Vector `page.pdf()` via `puppeteer-core` + `@sparticuz/chromium` (approved in Phase 1).
- Always **one A4 page**. If content overflows, first shrink the description font and ruled lines, then apply a uniform zoom.
- The bot warns when a description is very long.

### Shared template
- One shared module (`buildDoc` + `WO_CSS` + `esc` + logo) is used by both `admin.html` and the server, so the two outputs cannot drift apart.

### VAT
- The PDF line becomes: `עוסק פטור – המחיר סופי, לא יתווסף מע"מ`.
- New column `quotes.vat_mode`: default `'exempt'`, `check (vat_mode in ('exempt','licensed'))`. The template reads it.
- `'licensed'` rendering (before VAT / VAT 18% / total incl. VAT) is **not built now**. The hook is only reserved.

### Client phone
- **None anywhere.** No DB column, nothing in the PDF, and the bot never asks for it.

### Price
- The AI **never invents a price**. Ori/Miri always state the final total, and the bot asks for it if it's missing.
- A quote with no total cannot be approved. This is enforced in code **and** by a DB check for `source='telegram'`.
- All arithmetic is done in code only.

### Date
- The quote date is today in `Asia/Jerusalem`, unless a date is stated explicitly.

### Panel edits
- Editing a bot quote in the panel invalidates its stored PDF: a trigger sets `pdf_path = null`.
- The PDF is regenerated on demand.

### Access
- Every allowlisted chat (`TELEGRAM_ALLOWED_CHATS`) may create quotes.

### Intent detection
- Keyword / exact-label matching **only**, e.g. `הצעת מחיר` / `הצעה` / `מטר` / `מ"ר`.
- **No Gemini classification.**
- If the intent is unclear, show the menu with a `🧾 להכין הצעת מחיר?` button.

### Menu
- `setMyCommands`: `/start`, `/quote`, `/help`.
- Persistent reply keyboard:
  - `🧾 הצעת מחיר חדשה`
  - `📷 סריקת קבלה`
  - `📜 הצעות אחרונות`: last 5 quotes, with resend PDF.
  - `🔍 חיפוש הצעה`: search by client name.
  - `💰 סיכום הוצאות החודש`: calendar month, total + per category, from the DB only.
  - `❓ עזרה`

### Draft buttons
- `✅` approve
- `✏️` edit: client / address / description / total / date
- `🎤` voice correction
- `❌` cancel
- Text edits are applied in code, with no AI.

### Daily quotas
- Stored in the DB, not in memory. They reset at midnight `Asia/Jerusalem`.

| Quota | Limit |
|---|---|
| New quotes | 15 per day |
| Receipt scans | 20 per day |
| Voice corrections | 3 per quote (not counted toward the daily quote quota) |

- After each new quote, and in the menu, the bot shows `📊 נותרו היום: N הצעות מחיר`.
- At the limit, a friendly message says to try tomorrow or to create the quote manually in the panel.
- If the Gemini free-tier daily limit for our model turns out to be lower, our quotas are lowered below it, with a margin.

### Privacy (Gemini: paid Tier 1 project with a spend cap, see "Phase 4b notes"; minimization stays)
- Audio is never persisted; it stays in memory only.
- The transcript lives only in the pending draft and is deleted on approve or cancel.
- Abandoned drafts are swept after 24h.
- Gemini receives only the current message, with no history.
- Search, recent quotes and the monthly summary use the DB only.
- Logs are PII-free.
- `privacy.html` gets a sentence about AI processing of inquiries.

### Telegram reliability
- ACK `200` immediately and continue the work in `waitUntil` (`@vercel/functions`).
- Dedupe by `update_id` in `telegram_processed_updates`, which is swept periodically.
- Claim/lease before insert.
- Answer callbacks immediately with a status message.

### Numbering
- A Postgres `create_quote(jsonb)` RPC: advisory lock, number = `greatest(max+1, floor)`.
- Used by **both** the bot and the panel.
- The panel inserts **before** rendering the PDF.

### Regression
- The receipt flow must not regress. Re-run the existing harnesses.

### Out of scope (Project 2)
- Ori's signature.
- Client e-signature.

---

## 3. Existing bugs to fix along the way

| Bug | Location / fix |
|---|---|
| `findAwaitingEdit` measures freshness from `created_at` instead of the edit tap | telegram webhook |
| `supabaseInsert` logs PostgREST response bodies (PII) | telegram webhook |
| One shared 10/10min rate limit for all flows | split per flow |
| Panel renders the PDF **before** inserting (number race) | `admin.html` → use `create_quote` RPC, insert first |
| `saveQuoteToDb` has no `.catch` | `admin.html` |

---

## 4. Phases

| # | Phase | Status |
|---|---|---|
| 0 | Read-only recon | ✅ done |
| 1 | Chromium PDF spike (`be7fd85`) | ✅ done, approved |
| 1b | Supabase live check + this plan file | ✅ done (live check 2026-10-25, see "Live DB state") |
| 2 | Shared template module, used by `admin.html` (byte-identical panel output), + VAT line change | ✅ done (see "Phase 2 notes") |
| 2b | Aligned ruled lines under every description line + 13px font floor, both PDF paths | ✅ done (see "Phase 2b notes") |
| 3a | DB migration file `supabase-quotes-telegram.sql` (written + tested locally, **not applied**) | ✅ done (see "Phase 3a notes") |
| 3b | Apply the migration (owner-approved) + live verification | ✅ done (see "Phase 3b notes") |
| 4 | Production server PDF function (replaces the spike) + Gemini quote-extraction module + quota tracking | ✅ (4a + 4b) |
| 4a | `api/render-quote-pdf.js`: production quote PDF function (auth, storage upsert, `pdf_path`) | ✅ done (see "Phase 4a notes") |
| 4b | `api/_quote-extract.js` (Gemini extraction + corrections) + `api/_quota.js` (daily quota helpers) | ✅ done (see "Phase 4b notes") |
| 5a | Test-bot tooling (`tools/set-test-webhook.js`) + quotas restored to 15 / 20 / 3 | ✅ done (see "Phase 5a notes"); test webhook registered (5a-2) |
| 5b | Bot reliability (dedupe, ACK + `waitUntil`, sweeps), routing, menu, receipt quota, known bug fixes | ✅ done (see "Phase 5b notes"); `awaiting_since` column applied 2026-10-27 |
| 5c | Quote draft flow in the bot (start, extract, draft message, ✏️ edits, 🎤 corrections, ✂️, ❌; ✅ = claim only) | ✅ done (see "Phase 5c notes") |
| 5d | ✅ approve → `create_quote` + PDF (`api/render-quote-pdf.js`) + send it in the chat | ⏳ next |
| 5 | Bot flow: routing, menu, drafts, edits, voice corrections, approve → PDF | ⏳ |
| 6 | Panel sync: Realtime + `visibilitychange` refetch, `📱 טלגרם` badge, stored-PDF download | ⏳ |
| 7 | Security/privacy audit, test harness, `privacy.html`, `handoff.md` update, delete the spike (ask the owner first), merge | ⏳ |

**Phase 7 pre-launch checklist (must do before merge):**
- [ ] Delete any test quotes/rows (quotes, `telegram_*` tables), then set `quote_counter.floor_next = greatest(max(number)+1, 14)` and verify it.

### Phase 3 migration: working notes

Based on the repo's `supabase-quotes.sql`, verified against the live DB in Phase 1b (see "Live DB state" below).

Current schema of `public.quotes` (repo and live match):
- `id uuid`
- `number int not null`, with unique index `quotes_number_idx`
- `quote_date text`
- `client_name text not null`
- `address`, `description`
- `total numeric(10,2) not null default 0`
- `created_at`
- RLS: one `authenticated` "for all" policy.

Planned changes:

**`quotes` columns**
- `vat_mode text not null default 'exempt' check (vat_mode in ('exempt','licensed'))`
- `source text not null default 'panel' check (source in ('panel','telegram'))`
- `pdf_path text`: object path in a new **private** bucket, e.g. `quotes-pdf`.
- `created_by_chat bigint`: nullable, telegram only.
- `updated_at timestamptz`

**Price rule**
- `check (source <> 'telegram' or total > 0)`.
- `total` defaults to 0, so a "not null" check alone is not enough.

**Client phone**
- Never add a `client_phone` column. Live DB confirmed it does not exist; remove it from the Phase 0 draft.

**Trigger**
- On update of content columns of a `source='telegram'` row: set `pdf_path = null` and bump `updated_at`.

**`create_quote(jsonb)` RPC**
- `security definer`, `set search_path = ''`.
- Runs `pg_advisory_xact_lock`, then `number = greatest(max(number)+1, floor)`, then inserts and returns the row.
- `execute` is granted only to `authenticated` and `service_role`. Revoke from `anon`/`public`.

**New tables** (RLS on, no anon policies, service-role access from the webhook)
- `telegram_pending_quotes`: draft, transcript, voice-correction count, `awaiting_field`, `edit_requested_at`, lease columns. Swept after 24h.
- `telegram_processed_updates (update_id bigint primary key, created_at)`: swept periodically.
- `telegram_daily_usage (day date, chat_id bigint, kind text, count int, primary key (day, chat_id, kind))`: atomic upsert-increment.

**Storage**
- Private bucket `quotes-pdf`: `application/pdf` only, small size limit.
- `authenticated` read for panel download. Writes via service role.

**Realtime**
- Add `public.quotes` to the `supabase_realtime` publication, if not already there.

**Owner answers (after Phase 1b)**
- Daily quotas are **GLOBAL** across all chats (store `chat_id = 0` in `telegram_daily_usage`).
- Starting number for `create_quote`: **14** (owner-confirmed: last issued = 13). From now on the DB is the only source of numbering; the panel's per-phone localStorage counter is retired in **Phase 6**.
- `receipts` bucket gets limits in Phase 3: `allowed_mime_types = {image/*, application/pdf}`, `file_size_limit` 15 MB.
- Leaked-password protection: skipped for now.

### Live DB state (Phase 1b, 2026-10-25)

Read-only check via the `supabase` MCP server (project `mmognkxkglkotzkuxzly`). Aggregates and structure only.

| Item | Live state |
|---|---|
| Migrations | 14 applied; latest `telegram_pending_receipts_claim_column` |
| `quotes` rows | 8; numbers 6–13 (contiguous), max **13**; created 2026-08-26 → 2026-10-25 |
| `quotes` columns | `id uuid`, `number int`, `quote_date text not null`, `client_name text not null`, `address`, `description`, `total numeric not null default 0`, `created_at` |
| `quotes` indexes | `quotes_pkey`, unique `quotes_number_idx`, `quotes_created_at_idx` (desc) |
| `quotes` RLS / triggers | RLS on; one `authenticated` ALL policy; **no triggers** |
| `client_phone` | does not exist |
| Public functions | only `increment_metric` (security definer); no name clash with `create_quote` |
| Storage buckets | `content-media` (public), `receipts` (private); **neither has a size or MIME limit** |
| Storage policies | `receipts`: authenticated read + insert; `content-media`: public read, authenticated insert |
| Realtime publication | **empty**: `quotes` is not published |
| `telegram_pending_receipts` | RLS on, no policies (service role only), 0 rows |

Advisors relevant to this feature:
- INFO `rls_enabled_no_policy` on `telegram_pending_receipts`. This is intended (service-role only). The new `telegram_*` tables will raise the same INFO.
- WARN `anon_security_definer_function_executable` on `increment_metric`. Not part of this feature, but `create_quote` and the usage RPC must **not** repeat it.
- WARN leaked-password protection is disabled (Auth dashboard toggle, owner decision).
- INFO `quotes_created_at_idx` unused. Keep it; "📜 הצעות אחרונות" will use it.

Migration adjustments from the live state:
1. **`client_phone`**: not present. Drop the "drop if exists" step, and simply never add the column.
2. **New columns backfill safely**: existing 8 rows get `vat_mode='exempt'`, `source='panel'`. The `source <> 'telegram' or total > 0` check passes for all of them.
3. **`updated_at`**: does not exist; add it as `timestamptz not null default now()`. The trigger is new; `quotes` has none today.
4. **Numbering floor**: the panel computes `max(dbMax+1, getSeq())`, where `getSeq()` is a **per-device localStorage** counter, so the DB has no floor today. `create_quote` uses a constant floor in SQL (current next number = 14). The panel's local counter is retired in Phase 2/3.
5. **`quote_date` is text** (panel writes `he-IL` format). The bot must write the same format (today in `Asia/Jerusalem`).
6. **Realtime**: add `alter publication supabase_realtime add table public.quotes`. RLS already limits events to `authenticated`.
7. **Storage**: create private `quotes-pdf` with `file_size_limit` (e.g. 2 MB) and `allowed_mime_types = {application/pdf}`; add one `authenticated` SELECT policy scoped to `bucket_id = 'quotes-pdf'`. No insert policy (service role writes).
8. **RPC grants**: `create_quote` and the usage RPC are `security definer`, `set search_path = ''`. Revoke `execute` from `public` and `anon`. Grant `create_quote` to `authenticated` + `service_role`; grant the usage RPC to `service_role` only.
9. **Daily quota table**: `telegram_daily_usage (day date, chat_id bigint, kind text check (kind in ('quote','receipt')), count int, primary key (day, chat_id, kind))`. Increment through one RPC, `consume_daily_quota(kind, chat_id, limit) → remaining`, as an atomic `insert … on conflict do update … where count < limit`. `day = (now() at time zone 'Asia/Jerusalem')::date`. If quotas end up global, store `chat_id = 0`.
10. **Voice-correction cap** (3 per quote) lives on `telegram_pending_quotes.voice_corrections`, not in the daily table.
11. **No in-flight receipt drafts** (0 rows), so the migration can be applied at any time without disrupting the receipt flow.
12. **`receipts` bucket limits** (owner-approved): `image/*` + `application/pdf`, 15 MB.

### Phase 2 notes

- `shared/quote-template.js` (UMD, no deps): `window.MrpQuoteTemplate` in the browser, `module.exports` in Node. Exports `LOGO_DATA_URI`, `A4_HEIGHT_PX`, `WO_CSS`, `esc`, `buildDoc(data, logoSrc)`, `fitToOnePage(doc, maxH)`.
- `WO_CSS` and `buildDoc` were moved verbatim from `admin.html`. The only output change is the VAT line. `buildDoc` reads `data.vat_mode`: `'exempt'`/missing renders the exempt line; anything else renders the same line plus a `console.warn` (TODO marks where `'licensed'` goes).
- `admin.html` loads the module in `<head>` (same origin, covered by CSP `script-src 'self'`). Its own `esc` is kept (quote history uses it). The Excel export now reads `MrpQuoteTemplate.LOGO_DATA_URI`.
- `fitToOnePage` is **not** applied on the panel's html2canvas path. It is self-contained, so the server runs its source in the page via `page.evaluate`.
- `shared/quote-logo.js` deleted (owner-approved); the logo lives only in the module.
- `api/spike-quote-pdf.js` renders through the module; `?long=1` renders a 20-line description (fits at 11px + zoom 0.912, one page).
- Verified: string equality vs `admin.html@7791b29` for 6 inputs + `WO_CSS` + logo; pixel diff old vs new confined to the VAT row (2 stray pixels elsewhere at 1/255 intensity, i.e. invisible); `admin.html` loads the module with no console errors.
- ~~For Phase 4: `buildDoc` always draws 7 ruled lines~~. Resolved in Phase 2b.

### Phase 3a notes

- File: `supabase-quotes-telegram.sql` (repo root). Idempotent, commented, with a commented ROLLBACK section. **Not applied.**
- Contents: quotes columns (`source`, `vat_mode`, `pdf_path`, `telegram_chat_id`, `updated_at`) + checks (incl. `source <> 'telegram' or total > 0`); trigger `quotes_before_update` (updated_at + clears `pdf_path` when a printed field changes); `quote_counter` (floor 14) + `create_quote(jsonb)`; bot tables `telegram_pending_quotes`, `telegram_chat_state`, `telegram_processed_updates`, `telegram_daily_usage` (global, per Israel day); `consume_daily_quota` / `get_daily_quota_remaining` (service_role only); private `quotes-pdf` bucket (5 MB, PDF) + authenticated SELECT policy; `receipts` bucket limits (15 MB; jpeg/png/webp/pdf); `quotes` added to `supabase_realtime`.
- `create_quote` also **raises `floor_next` after each insert**, so a number is never reused even if the newest quote is deleted.
- Bot tables additionally `revoke all` from anon/authenticated (defense in depth on top of RLS with zero policies).
- Until Phase 6 the panel still inserts directly with a locally computed number. If the bot takes a number at the same moment, the unique index rejects the panel's insert and the panel shows its existing "PDF generated but save failed" alert; nothing is overwritten. Phase 6 moves the panel to `create_quote` (insert before rendering).
- Tested locally in PGlite (Postgres 17.5) with stubs mimicking the live schema and fake data: 53/53 checks passed (apply ×3, numbering, validation, trigger, checks, quotas, grants/RLS, storage, realtime, rollback).

### Phase 3b notes

- **Applied** 2026-10-25 by the owner in the Supabase SQL Editor (the full `supabase-quotes-telegram.sql`), after `apply_migration` (`quotes_telegram_phase3`) was declined by the tool layer three times. Because it ran in the SQL Editor, it is **not** recorded in `supabase_migrations` history (latest listed: `telegram_pending_receipts_claim_column`). Live verification ran 2026-10-25 ~19:50 UTC.
- **Change before applying:** `create_quote` detects the bot if ANY of `request.jwt.claims->>'role'`, `current_setting('role')` (PostgREST's SET LOCAL ROLE, also covers newer secret API keys; SECURITY DEFINER doesn't change it) or the legacy `request.jwt.claim.role` equals `service_role`. Local PGlite suite: 57/57.
- **Live verification:** 8 quotes, numbers 6–13, all defaulted panel/exempt; no phone column; 3 checks + trigger present; `quote_counter` = (true, 14); all 5 functions pin `search_path=''` (3 SECURITY DEFINER); execute grants exactly as designed (create_quote: authenticated + service_role; quota functions: service_role only; anon: none); 5 bot tables with RLS on, 0 policies, no anon/authenticated grants; `quotes-pdf` (private, 5 MB, PDF) + its authenticated SELECT policy; `receipts` 15 MB + 4 types; `public.quotes` in `supabase_realtime`.
- **Rolled-back live tests** (each a single DO-block transaction ending in a raised exception, so it can never commit; `execute_sql` only returns the last statement's result, which rules out a plain `begin … rollback`):
  - a. bot with JWT claims → `source=telegram`, number 14 ✅
  - b. bot with role only, no claims → `source=telegram`, number 14 ✅ (fallback works)
  - c. panel (authenticated) sending source telegram → `source=panel`, chat NULL ✅
  - d. bot with total 0 → error 22023 "total must be greater than 0" ✅
  - e. consume ×2 + remaining (limit 15) → 14, 13, 13 ✅
  - f. anon → 42501 permission denied for create_quote, consume_daily_quota, get_daily_quota_remaining and `telegram_pending_quotes` ✅
  - panel non-regression: authenticated plain insert (panel payload shape) → panel/exempt; update setting pdf_path keeps it; no-op update keeps it; description change → pdf_path NULL; updated_at set ✅
  - After all tests: 8 quotes / max 13, counter 14, 0 usage rows, 0 pending rows ✅
- **Advisors — new items:** INFO `rls_enabled_no_policy` on the 5 new tables (intended); INFO `unused_index` on the new bot-table indexes (tables empty); **WARN `authenticated_security_definer_function_executable` on `create_quote`** — intended (the panel calls it from Phase 6; authenticated callers can't set source/chat and are validated). No new anon-facing warnings.
- **Test-data rule:** any test that calls `create_quote` or `consume_daily_quota` against the LIVE project must run in a single transaction that is rolled back, so no number is consumed and `quote_counter` stays at 14 (also in the SQL header). See the Phase 7 checklist.
- **For Phase 4 — stored PDF path:** ONE deterministic object path per quote, `quotes-pdf/<quote id>.pdf`, overwritten with upsert on regeneration, so an invalidated PDF never leaves an orphan file. The server sets `pdf_path` in the same update that stores it (the trigger keeps it).

### Phase 4a notes

- **File:** `api/render-quote-pdf.js` (CommonJS), reusing the spike's render path: puppeteer-core + @sparticuz/chromium, `shared/quote-template.js` (`buildDoc` + `WO_CSS`, then the module injected with `addScriptTag` and `fitToOnePage(document)` before `page.pdf()`), Heebo embedded from `shared/fonts/`. One A4 page, never zoomed. `vercel.json`: `maxDuration 60` + the same `includeFiles` as the spike.
- **API:** `POST { quote_id }`.
  - Auth: `X-Internal-Secret` == `INTERNAL_API_SECRET` (constant-time `safeEqual`; a secret shorter than 32 chars disables this path) **or** `Authorization: Bearer <Supabase access token>` verified via `/auth/v1/user`. Otherwise 401. If `X-Internal-Secret` is sent, it must match (no fallback to the bearer path).
  - Rate limit: `_rate-limit.js`, 30 per 5 min per IP, applied before auth.
  - Loads only `id, number, quote_date, client_name, address, description, total, vat_mode, updated_at` with the service-role key. Malformed id → 400, missing → 404.
  - Row → template mapping is the panel's (`num` = 3-digit padded number, blank address/description → `—`).
  - Too long (`fits:false`) → **422 `{ error:"too_long", lines, maxLines }`**, nothing stored.
  - Upload to `quotes-pdf/<id>.pdf` (`x-upsert: true`), then `PATCH quotes set pdf_path = '<id>.pdf'` (nothing else) **conditioned on `updated_at` as loaded**: if the quote was edited while rendering, `pdf_path` is not linked and the caller gets **409 `quote_changed`** (re-render). The stale object is overwritten by the next render.
  - 200: PDF bytes (`application/pdf`) + `X-Pdf-Path: <id>.pdf` (+ `X-Desc-Lines`, `X-Desc-Font-Px`).
- **Test-only modes** (`VERCEL_ENV !== "production"`, which includes local): `{ test_data: {num,date,client,address,desc,total,vat_mode} }` and `{ quote_id, dry_run: true }`. Both render and return the PDF without touching Storage or writing to the DB. Production rejects both with 400.
- **Local runs:** outside Vercel, `LOCAL_CHROME_PATH` (the installed Chrome) is used instead of @sparticuz/chromium.
- **Logs:** one line per request: `status, mode, cold, launchMs, renderMs, storeMs, totalMs, lines`. No ids, no content, no response bodies.
- **Secret:** `tools/ensure-internal-api-secret.js` appends `INTERNAL_API_SECRET` (32 random bytes, hex) to `.env` only if missing, never prints it. It must also be set on Vercel (Preview + Production).
- **Local tests (13/13):** test_data short → 1-page PDF (3 lines, 16px); mid → 1-page PDF (12 lines, 16px); long → 422 (20 lines, max 15); no secret / wrong secret / invalid session → 401; GET → 405; malformed id → 400; unknown id → 404; one real quote, dry run → rendered OK, 1 page, 8 lines (no PII printed); quotes with `pdf_path` before/after = 0/0 (no DB write); production rejects test_data and dry_run → 400. Timings locally: cold ~1.9s, warm ~1.0s.
- **Not done yet (rest of Phase 4):** a real store-and-link run against the live bucket (first one happens on the preview, or from the bot in Phase 5); the Gemini quote-extraction module; quota tracking. The spike stays until Phase 7.

### Phase 4b notes

**`api/_quote-extract.js`** (helper, not a route; own Gemini call, same model/endpoint style as `parse-receipt.js`, which is unchanged)
- `extractQuote({ text } | { audio, mimeType }, { todayIL })` and `applyCorrection(draft, { text } | { audio, mimeType })` return a draft: `client_name, address, items[{service, area_m2, quantity, unit, unit_price, notes, line_total}], items_sum, total, total_source, quote_date, quote_date_stated, description_lines, description, transcript, missing[], warnings[], fit`.
- Gemini's structured output (`responseSchema`): `client_name, address, items[], stated_total, stated_total_evidence, quote_date, description_lines, transcript, missing[]`.
- **Code rules:**
  - Item math (`line_total` = unit price × area or quantity, `items_sum`) is computed in code.
  - `total` comes ONLY from `stated_total`, and only when its evidence (a) appears verbatim in the user's text or transcript (letters and digits compared, punctuation and spacing ignored) and (b) encodes the same number: digits, "4.5 אלף", or Hebrew number words (`parseAmount`: "ארבעת אלפים וחמש מאות", "שלושת אלפים ומאתיים", "אלף וחצי"…). A stated total equal to an item's unit price is rejected unless the evidence has a total cue word (סה"כ / סופי / כולל…). Never filled from items. No total → `missing` includes `"total"`.
  - Items fully priced and sum ≠ stated total → keep the stated total + warning `sum_mismatch {items_sum, total}`.
  - `missing` is computed in code (`client_name`, `address`, `description`, `total`); nothing at all → warning `no_quote_content`.
  - Description lines with a total (סה"כ / סך הכל) are dropped (the total is printed once, in its box). The prompt forbids computed results in the description.
  - Date: only when said (`D.M.YYYY`), otherwise `todayIL` (Asia/Jerusalem, he-IL format).
  - Corrections: the full draft is updated, but the total changes only with evidence in the CORRECTION message; otherwise the previous total stays.
- **Fit:** `estimateDescriptionFits`; if it won't fit (> 15 lines), exactly one `shorten()` call, then a re-check; still too long → warning `too_long`.
- **Privacy:** phones are stripped from text before sending (Israeli local / +972 formats, and any run of 9+ digits) and from every output string (`[מספר הוסר]`). Gemini gets only the current message (plus the current draft for a correction). Audio stays in memory. Logs: `op, ms, outcome` only (a 429 also logs Google's quota id + value, which carries no user data).
- **Errors:** `QuoteExtractError.code` = `empty_input` (no Gemini call) | `invalid_input` | `ai_busy` (429/503/timeout; `retryAfter` + `quota` when Google sends them) | `ai_failed`.

**`api/_quota.js`**
- `consumeQuota(kind) → { ok, remaining }` and `getRemaining(kind)` via `consume_daily_quota` / `get_daily_quota_remaining` with the service key. `kind`: `quote` | `receipt`. `voiceCorrections` is a per-quote cap (on `telegram_pending_quotes`), not an RPC kind. DB/network errors throw `QuotaError("quota_unavailable")`; callers fail closed.
- **`LIMITS = { quote: 15, receipt: 20, voiceCorrections: 3 }`** (the planned values; briefly lowered to 5 / 8 / 2 in 4b, restored in 5a, see below).

**Gemini tier (corrected 2026-10-27, Phase 5a)**
- ~~Free tier, ~20 requests/day~~: wrong for us. The 4b note relied on public measurements of the FREE tier. **The owner confirmed the key is on a PAID Tier 1 project**: AI Studio shows ~10K requests/day per model. There is a **monthly spend cap (~40 ILS) shared with another project**; that cap is the real bound, not Google's request quota.
- Decision (owner): **keep `gemini-3.5-flash` for quotes** (no flash-lite), and restore the limits to **15 quotes / 20 receipts per day, 3 voice corrections per quote**. They exist to protect the spend cap from a runaway loop or abuse.
- Spend cap reached or a 429 → `ai_busy` → the bot shows its friendly "busy" message. `isBusyResponse` maps 429, 503, `RESOURCE_EXHAUSTED`, and 400/403 refusals mentioning billing / quota / spend / budget to `ai_busy`; other 4xx stay `ai_failed`.
- Privacy note: on a paid tier Google doesn't use prompts/responses to improve its products. The minimization rules below (phones stripped, no history, audio not stored, PII-free logs) stay anyway.

**Tests (fake data only)**
- Offline (mocks, 0 calls, no network): 60/60. Covers `parseAmount` (17 phrasings), phone stripping (7 formats stripped, 5 non-phones kept), the total-evidence rule, item math, mismatch, "never from items", empty input makes no call, phone not in the request, 429/500/bad JSON/network/bad MIME typing, the shorten flow (once, re-check, `too_long`), correction keeping the old total, and quota with a mocked RPC (consume, at limit, remaining, invalid kind, HTTP error, bad response).
- Live (gemini-3.5-flash, 13 calls, spaced for 5 RPM): 14/14. 10 text cases (full, missing price, hesitations, number words, 3 items, mismatch, phone, correction, garbage, empty) + 4 TTS voice clips (`gemini-3.8-flash-tts`, saved to `test-audio/`, gitignored + vercelignored): full quote, no price, hesitant, voice correction.
- Latency: 5–9 s per call (text and audio).

### Phase 5a notes

- **Test bot:** `@Mrpolish_test_quotes_bot` (id 9206562607), token in `.env` as `TELEGRAM_TEST_BOT_TOKEN`. **Miri's production bot is not touched until the final merge.**
- **`tools/set-test-webhook.js`** (`chatid` | `register [baseUrl]` | `info` | `delete`): uses `TELEGRAM_TEST_BOT_TOKEN` only; **refuses to run** if it equals `TELEGRAM_BOT_TOKEN` or has the same bot id (checked before any Telegram call). `register` appends `TELEGRAM_TEST_WEBHOOK_SECRET` to `.env` if missing, then sets the webhook to the branch alias `https://mrpolish-project-git-feature-telegram-quotes-polish1.vercel.app/api/telegram-webhook?x-vercel-protection-bypass=<VERCEL_AUTOMATION_BYPASS_SECRET>` with `secret_token`. `info` redacts the URL's query (it carries the bypass secret). Nothing secret is printed.
- **Branch alias verified:** it serves the latest branch deployment, and the bypass query param gets through Vercel Authentication (GET `/api/telegram-webhook` → our 405; POST `/api/render-quote-pdf` without auth → our 401).
- **Preview-only env vars** (owner sets them in Vercel; Production unchanged): `TELEGRAM_BOT_TOKEN` = test token, `TELEGRAM_WEBHOOK_SECRET` = `TELEGRAM_TEST_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_CHATS` = the owner's chat id with the test bot.
- `chatid` on 2026-10-27 returned no updates (Telegram keeps undelivered updates for 24h only); after a re-send: owner chat id **1230764171**.
- **5a-2: separate env names.** Vercel refused a branch-scoped override of `TELEGRAM_BOT_TOKEN` (its row targets Preview + Production), so the preview uses NEW Preview-only vars (branch `feature/telegram-quotes`): `TELEGRAM_TEST_BOT_TOKEN`, `TELEGRAM_TEST_WEBHOOK_SECRET`, `TELEGRAM_TEST_ALLOWED_CHATS`. The existing vars are untouched.
  - `telegramConfig()` in `api/telegram-webhook.js` is the only place those values are read (`tgCall`, `tgDownloadFile`, `isAllowedChat`, the handler). `VERCEL_ENV === "production"` → the three production vars only, TEST_ ignored. Anything else (preview, local) → the three TEST_ vars only; if any is missing, 200 + nothing processed, **never** a fallback to production. Values are never logged. Receipt flow otherwise unchanged.
  - No other runtime code reads the bot token (`tools/set-telegram-webhook.js` is the production CLI, `tools/set-test-webhook.js` the test one).
  - Tests (all outbound calls mocked, fake values): 27/27. Resolver: production / preview / local / each TEST_ var missing (no fallback, 0 calls) / no values in logs. Receipt regression: photo → Gemini + upload + pending + summary; category cycle; cancel (row + file deleted); confirm (one insert); double confirm (no 2nd insert); missing amount refused; wrong secret 401. The original 5 receipt harnesses from §31 are no longer on disk (they lived in an old session scratchpad and wrote to live Supabase), so the regression was rebuilt fully mocked.
- **Next:** after the preview vars are set and the preview redeployed → `register`, then the receipt sanity test (photo → existing receipt flow end to end on the preview).

### Phase 5b notes

- **Reliability** (`api/telegram-webhook.js`):
  - Order: secret → allowlist → **dedupe** (`claimUpdate`: insert `update_id` into `telegram_processed_updates` first; 409 = duplicate → 200, nothing done; any other DB error fails OPEN) → **ACK 200** → the work in `waitUntil` (`@vercel/functions` **3.10.1**, pinned exact).
  - Callbacks are answered immediately (`⏳`). A callback can only be answered once, so the former toasts were dropped (the edited summary shows the outcome) and the former alerts are sent as short chat messages (`cbNotice`).
  - Opportunistic retention sweep (`sweepRetention`, at most once per 10 min per warm instance, inside `waitUntil`): pending receipts 48h, pending quotes 24h, chat state 24h, processed updates 7 days, daily usage 30 days.
- **Known bugs fixed:**
  - Edit freshness from the edit TAP: `awaiting_since` on `telegram_pending_receipts` (`supabase-telegram-receipts-awaiting-since.sql`). **Applied 2026-10-27 by the owner in the Supabase SQL Editor** (the file's two statements; the `supabase` MCP server was unavailable in that session, its OAuth login not done). The verify query returned one row, `awaiting_since` / `timestamp with time zone`. Like Phase 3b, it is **NOT in the migration history**. The code's missing-column fallback (PGRST204/42703 → `created_at`) stays as a safety net; a warm instance that hit the error before the column existed keeps the fallback until it's recycled.
  - No PostgREST bodies in logs: `supabaseInsert` logs status + error code only; the storage upload logs the status only.
  - Rate limits split per chat and flow: receipt 10/10 min, quote 10/10 min, menu 30/10 min (callbacks stay 20/min).
- **Routing** (`routeMessage`): menu label or command (`/start`, `/help`, `/quote`, also `/cmd@botname`) → pending edit (receipt or quote draft, newest `awaiting_since` wins; a quote waiting for a voice correction takes voice only) → photo/document = receipt (unchanged) → voice, or text matching `הצעת מחיר|הצעה|מטר|מ"ר` = quote (**stub: "בקרוב"** until 5c) → otherwise "לא בטוח שהבנתי" + inline `🧾 להכין הצעת מחיר?` (stub). A menu tap clears pending edit state (receipts + quote drafts) and the chat state.
- **Menu:** persistent reply keyboard with the 6 approved buttons; `/start` (welcome + help), `/help` / `❓ עזרה` (help), both with `📊 נותרו היום: N הצעות מחיר` (omitted if the lookup fails). `📷 סריקת קבלה` → photo instructions. `💰 סיכום הוצאות החודש` → **implemented** (this Israel calendar month from `business_expenses`, total + per category, math in code). `🧾`, `📜`, `🔍` → stub "בקרוב".
- **Receipt quota:** `consumeQuota("receipt")` before the file download and Gemini. At the limit: a friendly message (try tomorrow or add it in the panel). Quota unavailable → fails closed ("שגיאה זמנית").
- **`tools/set-bot-commands.js`** (`test` | `production` [`show`]): ran for the TEST bot only (`/start`, `/quote`, `/help`). Same production-token guard as `set-test-webhook.js`.
- **Tests (all mocked, fake values):** 5b harness 58/58 (menu, routing, dedupe incl. fail-open, ACK before work, callback answered once and first, receipt quota before Gemini / at limit / unavailable, edit freshness from the tap + > 30 min + no-column fallback, menu clears edit state, newest edit wins, per-flow limits, no PII/bodies/tokens in logs, sweep targets + throttle, receipt regression); 5a-2 resolver harness 27/27 (updated for `waitUntil`, and "חסר סכום" is now a message); 4b offline 64/64.
- `npm audit`: 6 high findings, all **zod** (memory exhaustion on oversized validated collections) pulled in by `@vercel/oidc` (via `@vercel/functions`) and, already before 5b, by puppeteer's `chromium-bidi`. Neither validates untrusted input with zod here; not force-fixed (the suggested fix downgrades `@vercel/functions`). Re-check at Phase 7.

### Phase 5c notes

All in `api/telegram-webhook.js` ("Quote drafts" section), using `api/_quote-extract.js`, `api/_quota.js` and `estimateDescriptionFits`.
- **Start** (🧾, `/quote`, inline `🧾 להכין הצעת מחיר?`, or voice / keyword text):
  - A bare trigger ("תכין לי הצעת מחיר": no digits and < 6 letters left after removing trigger words) sets `telegram_chat_state = collecting_quote` and asks for client, address, work and final price (simple Hebrew). The next text/voice within 30 min is the details.
  - A message with details is extracted right away.
  - "Nothing found" → "לא מצאתי בהודעה פרטים…" and collecting again.
- **One draft per chat:** a new quote while a draft exists → `↩️ להמשיך בטיוטה` / `🆕 להתחיל הצעה חדשה`. The new message is parked in `telegram_chat_state` (`quote_conflict`, `context.input` = the text, or the voice's Telegram `file_id`, never audio). "New" deletes the old draft (its message → "בוטלה") and processes the parked message.
- **Quota:** `consumeQuota("quote")` once per NEW draft, before Gemini (corrections, edits and ✂️ are free). At the limit → a friendly message (tomorrow, or the panel). The new draft shows `📊 נותרו היום: N הצעות מחיר`.
- **Voice:** `voice` / `audio`, ≤ 3 min and ≤ 15 MB (checked before quota and download; `getFile` size re-checked). Downloaded into memory, passed to Gemini inline, never stored or logged. `"⏳ מעבד…"` is sent first and then edited into the draft (for text too).
- **Draft message** (edited in place via `message_id`; if the edit fails it's re-sent and `message_id` updated):
  - date (`DD.MM.YYYY`, default today in Israel; `todayIL` now zero-pads), client, address, description lines, `💰 סה״כ לתשלום: ₪…` or `❗ חסר מחיר — מה המחיר הסופי?`;
  - warnings: sum mismatch, too long;
  - for voice drafts, `📝 מה הבנתי:` + the transcript cut at 300 chars;
  - "(מספר ההצעה ייקבע באישור)".
- **Buttons** (`q:<action>:<uuid>`, ≤ 64 bytes):
  - `✅ אשר והפק PDF` only when ready: a total > 0, the description fits, **and a client name** (added because `quotes.client_name` is NOT NULL);
  - `✏️ לקוח / כתובת / תיאור / סכום / תאריך`;
  - `🎤 תיקון בהקלטה`, hidden after 3;
  - `✂️ לקצר אוטומטית`, only when too long;
  - `❌ ביטול`.
- **Edits, code only:**
  - total via `parseAmount` (digits or Hebrew words, 0 < total < 1,000,000);
  - date → `DD.MM.YYYY` (D/M/YYYY, D.M.YY, YYYY-MM-DD, "היום"; real dates only);
  - description = the reply split into lines (empty lines dropped), re-checked for fit;
  - client / address trimmed, phones removed;
  - invalid → a retry prompt, still waiting.
  - A missing total automatically sets `awaiting_edit_field = total`.
- **🎤 correction:** the next voice OR text → `applyCorrection` (the total changes only with evidence in the correction). The corrected draft goes into a new message at the bottom, and the old one loses its buttons. `voice_corrections` +1 (optimistic `voice_corrections=eq.n`; DB cap 3).
- **✂️:** one shorten call (`shortenIfTooLong`), then a re-check.
- **❌:** deletes the draft row (transcript included) and clears the chat state; the message → "טיוטת הצעת המחיר בוטלה."
- **✅:** re-checks readiness, claims the row (2-min lease), replies "✅ ההפקה תתווסף בשלב הבא." Nothing is created yet (5d).
- A stale, cancelled or other chat's draft tap → "ההצעה הזו כבר טופלה או בוטלה." + buttons removed. A menu tap clears the quote's waiting field.
- **Help text** updated for quotes. `📜` / `🔍` stay a "בקרוב" stub.
- **Tests:**
  - 5c mocked harness: 64/64 (every path above, plus: no `public.quotes` / `create_quote` calls, audio never in the DB or Storage, PII-free logs, receipt regression).
  - LIVE Gemini text (fake data, 3 calls): 4/4. Full quote → total 4500 + ✅; no price → awaiting total; "3,800" → 3800 in code; 🎤 text correction → 50 m², 5200, 1/3.
  - 5b harness updated (quote paths now reach the flow instead of the stub): 58/58. 5a-2: 27/27. 4b offline: 64/64.

### Phase 2b notes (owner decisions)

- **Always-aligned rules:** one ruled line under EVERY description text line (wrapped lines included), at the same offset below the baseline for every line, in BOTH the panel PDF and the server PDF. **At least 7 rules** (empty rules continue below a short description, like the paper form).
- **Font floor 13px, no zoom.** To fit, line spacing is tightened first (16px text, 32px → 26px lines), then the font shrinks in 0.5px steps to 13px (lines = 1.6× font). Nothing is ever zoomed.
- **≤ 12 lines** fit at the default 16px font (`DESC.TARGET_LINES`). **15 lines** is the absolute max at 13px (`DESC.MAX_LINES`, matches the measured `maxLines`).
- **Refusal when too long:** `fitToOnePage()` returns `{ fits:false, lines, maxLines }` and never shrinks further. Panel: alert `התיאור ארוך מדי לעמוד אחד — נא לקצר את התיאור`, no PDF, no save. Server (Phase 4/5): refuse and ask for a shorter text. The spike shows this as an HTTP 422 notice page for `?long=1`.
- Module API added: `DESC` constants, `layoutDescription(doc, {fontPx, lineHeightPx})`, `fitToOnePage(doc)` (now runs the layout), `estimateDescriptionFits(text)` (layout-free estimate for warnings; 80 chars/line at 16px). `buildDoc` and `WO_CSS` are unchanged; the layout step rebuilds the rules after render.
- The server injects the module into the page (`page.addScriptTag`) and calls `MrpQuoteTemplate.fitToOnePage(document)` before `page.pdf()`.
- Verified on both paths (Chromium print + html2canvas 1.4.1 @2x) for 6 / 12 / 20 lines: rule−baseline distance identical on every line (spread 0px, DOM and pixels), every line has a rule, short + mid at 16px with no zoom, 20 lines → `fits:false`.
- The panel's html2canvas output relies on Heebo already being loaded by `admin.html` itself (its head loads Google Fonts). If that ever changes, the quote PDF falls back to a system font. The server path embeds the font and is not affected.

---

## 5. Working rules

- One phase per session/command. Report and **stop** after each phase.
- Never delete files without the owner's approval.
- Never touch `main` until the final merge.
- No global kill commands; only kill PIDs started by the session.
- Supabase: read-only, except in Phase 3 after explicit owner approval.
- Never select quote PII (`client_name`, `address`, `description`) when inspecting data; use aggregates only.
- Never open or print `.env*` or secrets.
- Use only the MCP server named `supabase` (project `mmognkxkglkotzkuxzly`). Never use "claude.ai Supabase", and never touch the personal-dashboard project.
