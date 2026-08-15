-- =============================================================
--  Mr. Polish — Telegram bot: fix a real double-save race on Confirm.
--
--  Found during a security/regression audit: processCallbackQuery's confirm
--  branch used a plain fetch-then-act sequence (read the pending row, THEN
--  insert into business_expenses, THEN delete the pending row) with no
--  atomicity between the read and the insert. Two near-simultaneous taps on
--  "✅ אשר" (a fat-finger double-tap, or Telegram redelivering the same
--  callback_query on a slow response) could both read the row before either
--  deleted it, producing two business_expenses rows for one receipt.
--
--  Same class of bug — and the same fix — as publish-scheduled-content.js's
--  claimRow()/CLAIM_LEASE_MS for content_queue: an atomic conditional UPDATE
--  (claimed_at set only if currently null or past its lease) acts as a claim
--  Postgres itself guarantees only one concurrent request can win. The lease
--  also self-heals a crash mid-processing — after CLAIM_LEASE_MS a stale
--  claim becomes reclaimable again rather than permanently stuck.
-- =============================================================

alter table public.telegram_pending_receipts
  add column if not exists claimed_at timestamptz;
