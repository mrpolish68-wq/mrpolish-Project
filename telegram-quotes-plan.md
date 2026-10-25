# Telegram Quotes — Project Plan

Single source of truth for the "price quotes via Telegram bot" feature, across sessions.
Branch: `feature/telegram-quotes`. Production `main` stays untouched until the final merge.

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

### Privacy (Gemini stays on the FREE tier)
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
| 2 | Shared template module, used by `admin.html` (byte-identical panel output), + VAT line change | ⏳ |
| 3 | DB migration (**owner approval required before applying**) | ⏳ |
| 4 | Production server PDF function (replaces the spike) + Gemini quote-extraction module + quota tracking | ⏳ |
| 5 | Bot flow: routing, menu, drafts, edits, voice corrections, approve → PDF | ⏳ |
| 6 | Panel sync: Realtime + `visibilitychange` refetch, `📱 טלגרם` badge, stored-PDF download | ⏳ |
| 7 | Security/privacy audit, test harness, `privacy.html`, `handoff.md` update, delete the spike (ask the owner first), merge | ⏳ |

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

**Open item**
- Whether quotas count per chat or globally. Default: global per day, matching the Gemini project-level limit.

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
