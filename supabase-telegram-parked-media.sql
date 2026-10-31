-- =============================================================
-- Parked album photos for the Telegram bot (media-projects plan, command 5).
-- An album arrives as up to 10 separate webhook calls (one per photo, the same media_group_id),
-- possibly on different serverless instances. When Miri sends an album outside a mode, the bot
-- parks each photo's Telegram file reference here and asks once: "📷 קבלות או 📸 פרויקט חדש?".
-- Her answer processes every parked photo of that album as receipts or as a new project, and the
-- rows are deleted. Only Telegram file ids are stored (no image, no text); rows older than 24 h
-- are swept by the webhook (and by the retention job below).
--
-- SAFE TO APPLY NOW (a new table, nothing else changes; idempotent — re-running is a no-op).
-- Until this is applied, an album outside a mode is handled as today (each photo = a receipt).
--
-- STATUS: SAFE TO APPLY NOW.
-- VERIFY:  select count(*) from public.telegram_parked_media;                         → 0
--          select schedule from cron.job where jobname = 'telegram-parked-media-retention'; → 17 3 * * *
--          select relrowsecurity from pg_class where oid = 'public.telegram_parked_media'::regclass;  → true
--          select has_table_privilege('anon', 'public.telegram_parked_media', 'select'); → false
-- ROLLBACK: select cron.unschedule('telegram-parked-media-retention'); drop table if exists public.telegram_parked_media;
-- =============================================================
create table if not exists public.telegram_parked_media (
  id              uuid primary key default gen_random_uuid(),
  chat_id         bigint not null,
  media_group_id  text not null check (media_group_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  message_id      bigint not null,
  kind            text not null check (kind in ('photo', 'video', 'document')),
  file_id         text not null check (length(file_id) <= 300),
  file_unique_id  text not null check (file_unique_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  thumb_file_id   text check (thumb_file_id is null or length(thumb_file_id) <= 300),
  mime_type       text check (mime_type is null or length(mime_type) <= 100),
  file_size       bigint,
  created_at      timestamptz not null default now(),
  unique (chat_id, media_group_id, file_unique_id)
);
create index if not exists telegram_parked_media_group_idx on public.telegram_parked_media (chat_id, media_group_id);
create index if not exists telegram_parked_media_created_idx on public.telegram_parked_media (created_at);

-- service_role only (the webhook): RLS on, no policies, no grants.
alter table public.telegram_parked_media enable row level security;
revoke all on table public.telegram_parked_media from anon, authenticated;

-- Retention: the webhook sweeps rows ≥ 24 h old; a nightly pg_cron job does the same as a backstop.
-- (cron.schedule upserts by job name, so re-running keeps ONE job.)
do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.schedule('telegram-parked-media-retention', '17 3 * * *',
      $job$ delete from public.telegram_parked_media where created_at < now() - interval '24 hours' $job$);
  end if;
end $$;
