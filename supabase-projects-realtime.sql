-- =============================================================
-- Realtime for the panel's "📸 פרויקטים" tab (media-projects plan, command 4).
-- Adds public.projects + public.project_media to the supabase_realtime publication, so a project
-- created in the Telegram bot (Phase 7) appears live in the panel.
--
-- SAFE TO APPLY NOW (no data change; idempotent — re-running is a no-op).
-- Who sees the events: Realtime applies RLS — the panel (authenticated) sees every project; anon
-- sees only published + consented projects (the same rows it can already SELECT).
-- Until this is applied the tab still works: it refreshes when opened and when the app regains focus.
--
-- VERIFY:  select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
--          → projects, project_media, quotes
-- ROLLBACK: alter publication supabase_realtime drop table public.projects, public.project_media;
-- =============================================================
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects') then
    alter publication supabase_realtime add table public.projects;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_media') then
    alter publication supabase_realtime add table public.project_media;
  end if;
end $$;
