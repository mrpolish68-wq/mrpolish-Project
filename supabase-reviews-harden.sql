-- =============================================================
--  Mr. Polish — reviews INSERT policy hardening (security audit #6).
--  Run this once in the Supabase SQL Editor, AFTER supabase-reviews.sql.
--
--  Problem it fixes (moderation bypass / mass assignment):
--  the original anon INSERT policy was `with check (true)`, which does
--  NOT constrain which columns an inserter may set. The public site's
--  form never sends `approved`, but the anon key is embedded in the
--  page source, so anyone could POST directly to /rest/v1/reviews with
--  {"approved": true, ...} and have their review appear on the live
--  site immediately — bypassing Uri's manual approval gate entirely.
--  (No XSS: the site renders reviews via textContent, so the impact is
--  spam / unwanted content, not script injection — but the moderation
--  gate must still hold.)
--
--  Fix: require `approved = false` on every anon insert. A submission
--  can now only ever enter the queue unapproved; only an authenticated
--  session (Uri, in the Supabase dashboard) can flip it to approved.
--  The public read policy already exposes ONLY approved = true rows, so
--  nothing unapproved is visible in the meantime.
-- =============================================================

drop policy if exists "public can submit reviews" on public.reviews;
create policy "public can submit reviews"
  on public.reviews
  for insert
  to anon
  with check (approved = false);
