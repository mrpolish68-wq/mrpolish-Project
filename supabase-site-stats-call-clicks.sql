-- =============================================================
--  Mr. Polish — seed a "call_clicks" row in site_stats.
--
--  Found during the 2026-08-15 zero-conversions audit: phone
--  "tel:" links had NO click tracking at all (only wa.me links
--  were tracked), so Uri had zero visibility into call-button
--  engagement. Adding tracking in main.js/admin.html for this
--  requires the row to already exist first: increment_metric()
--  is UPDATE-only (`update site_stats set count = count + 1
--  where metric = metric_name`), not an upsert, so incrementing
--  a metric name with no existing row silently updates zero rows
--  and does nothing — the same silent-failure shape as the leads
--  RLS bug, just avoided here by seeding the row up front instead
--  of discovering it the same way.
-- =============================================================

insert into public.site_stats (metric, count)
values ('call_clicks', 0)
on conflict (metric) do nothing;
