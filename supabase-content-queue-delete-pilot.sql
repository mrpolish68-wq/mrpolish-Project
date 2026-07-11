-- =============================================================
--  Mr. Polish — delete the 1-week pilot batch (all 7 posts), per
--  Ori's explicit decision to remove them regardless of status.
--
--  ⚠️ NOTE (read before running): this only removes the tracking
--  rows in content_queue. If any of these had already reached
--  status = 'published' before you run this, the actual post is
--  still live on Facebook/Instagram — this does NOT delete it from
--  Meta, it only deletes our local record (fb_post_id/ig_post_id)
--  of having published it. If you care about the live post itself,
--  check/remove it directly on Facebook/Instagram first.
--
--  Run once, in the Supabase SQL Editor.
-- =============================================================

delete from public.content_queue
where title in (
  'פיילוט 1/7 — בזלת שחורה',
  'פיילוט 2/7 — אבן ירושלמית',
  'פיילוט 3/7 — מדרגות חלילה',
  'פיילוט 4/7 — טרצו קלאסי',
  'פיילוט 5/7 — קרמה בית חולים מאיר',
  'פיילוט 6/7 — בזלת שחורה, זווית נוספת',
  'פיילוט 7/7 — טיפ שבועי'
);
