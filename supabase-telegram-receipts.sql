-- =============================================================
--  Mr. Polish — Phase 2: Telegram Bot Integration for Business
--  Expense Receipts.
--
--  Telegram's inline-keyboard callback_data has a hard 64-byte limit,
--  far too small to carry a full extracted-receipt payload (vendor
--  name, amounts, category, etc). So the extraction result is parked
--  here right after AI analysis, keyed by a short uuid that DOES fit
--  in callback_data ("c:<uuid>" / "x:<uuid>") — when Ori taps
--  Confirm/Cancel in Telegram, that's the only lookup needed to
--  resume the flow, even though the tap arrives as a completely
--  separate, stateless webhook invocation from the one that sent it.
--
--  Only api/telegram-webhook.js ever touches this table, always via
--  the service_role key (there's no Supabase Auth session in a
--  Telegram webhook) — same posture as content_queue's cron writes.
--  RLS is enabled with zero policies: service_role bypasses RLS
--  regardless, so this is a deliberate "nothing else can touch it"
--  stance, not a gap.
-- =============================================================

create table if not exists public.telegram_pending_receipts (
  id            uuid primary key default gen_random_uuid(),
  chat_id       bigint not null,
  receipt_path  text not null,   -- Storage OBJECT PATH in the "receipts" bucket (same bucket Phase 1 created)
  extracted     jsonb not null,  -- normalizeExtraction()'s output: vendor_name/date/total_amount/vat_amount/amount_before_vat/invoice_number/category/confidence_notes
  created_at    timestamptz not null default now()
);

-- Rows are looked up by id (the callback_data lookup) and swept by age
-- (api/telegram-webhook.js opportunistically deletes anything older than
-- 48h on every new incoming message — no separate cron needed for this).
create index if not exists telegram_pending_receipts_created_idx
  on public.telegram_pending_receipts (created_at);

alter table public.telegram_pending_receipts enable row level security;
-- No policies: only service_role (which bypasses RLS) may ever read/write this table.
