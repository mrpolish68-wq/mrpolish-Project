-- =============================================================
--  Telegram receipts — edit freshness from the edit TAP (Phase 5b)
-- =============================================================
--  Fixes the known findAwaitingEdit bug: the 30-minute window for a "✏️ שנה תאריך / סכום"
--  reply was measured from when the receipt ARRIVED (created_at), so tapping an edit button
--  on a receipt sent 25+ minutes earlier left almost no time to answer. The webhook now
--  records the moment of the tap in awaiting_since and measures the window from it.
--
--  Until this file is applied, api/telegram-webhook.js detects the missing column
--  (PostgREST PGRST204 / 42703) and falls back to the old created_at behavior, so it is
--  safe to apply before or after deploying the code.
--
--  Run once in the Supabase SQL Editor (project mmognkxkglkotzkuxzly). Idempotent, additive,
--  no data change: existing rows get awaiting_since = NULL (no edit in progress).
-- =============================================================

alter table public.telegram_pending_receipts
  add column if not exists awaiting_since timestamptz;

-- PostgREST caches the schema; make it see the new column right away.
notify pgrst, 'reload schema';

-- Verify (expected: one row, data_type = "timestamp with time zone"):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'telegram_pending_receipts' and column_name = 'awaiting_since';

-- ROLLBACK (only if needed; the webhook falls back to created_at automatically):
--   alter table public.telegram_pending_receipts drop column if exists awaiting_since;
