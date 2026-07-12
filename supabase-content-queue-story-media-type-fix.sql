-- =============================================================
--  Mr. Polish — Story media_type correction.
--
--  Bug: two rows were drafted with content_category = 'story' but
--  media_type = 'image' instead of 'story'. media_type (not
--  content_category) is what api/publish-scheduled-content.js uses to
--  pick the Graph API endpoint, so as originally drafted these two
--  rows would have published as normal Instagram FEED photo posts
--  (no Story container, no link sticker) if ever approved - not as
--  Stories, contradicting their own title/category.
--
--  No live harm occurred: both rows are already status = 'rejected'
--  (verified against the live DB 2026-07-12), so neither ever reached
--  Meta. This is a data-correctness fix, not an incident response.
--  The publish pipeline itself now also fails closed on this exact
--  mismatch (content_category='story' + media_type!='story' refuses
--  to publish rather than risk a feed post) - see
--  api/publish-scheduled-content.js, publishOne().
--
--  Run this in the Supabase SQL Editor. Matches rows by exact `title`.
--  Does not change `status` - if Ori wants either of these live as an
--  actual Story, he still needs to review/re-approve it himself.
-- =============================================================

update public.content_queue set
  media_type = 'story'
where title = 'באטש 2 — סטורי: שאלה מהירה'
  and content_category = 'story';

update public.content_queue set
  media_type = 'story'
where title = 'באטש 3 — סטורי: פינה נוספת השבוע'
  and content_category = 'story';
