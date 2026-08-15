-- =============================================================
--  Mr. Polish — Telegram bot pre-confirmation editing flow.
--
--  Adds two columns to telegram_pending_receipts (created in
--  supabase-telegram-receipts.sql):
--
--  message_id — the Telegram message_id of the summary message
--  api/telegram-webhook.js sent for this pending receipt. Needed so a
--  later edit (which can arrive as a plain-text reply, not a
--  callback_query — Telegram doesn't hand back message context on a
--  plain message the way it does on a button tap) can still
--  edit that SAME message in place instead of spamming a new one
--  each time a field is changed.
--
--  awaiting_edit_field — set to 'date' or 'amount' right after Ori
--  taps "✏️ שנה תאריך" / "✏️ שנה סכום", cleared back to null once his
--  next text reply is successfully applied. Category has no such
--  state — "🏷️ שנה קטגוריה" cycles synchronously through the fixed
--  6-value list on each tap, no free-text reply needed for an enum.
-- =============================================================

alter table public.telegram_pending_receipts
  add column if not exists message_id         bigint,
  add column if not exists awaiting_edit_field text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'telegram_pending_receipts_awaiting_edit_field_check'
  ) then
    alter table public.telegram_pending_receipts
      add constraint telegram_pending_receipts_awaiting_edit_field_check
      check (awaiting_edit_field is null or awaiting_edit_field in ('date', 'amount'));
  end if;
end $$;
