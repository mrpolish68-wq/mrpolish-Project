-- =============================================================
--  Mr. Polish — "Pin to Top" intent tracking.
--
--  Ori asked for automated post-pinning. Researched first (see
--  handoff.md for the full writeup): Meta's Graph API has no write
--  endpoint to pin a Facebook Page post or an Instagram post/reel —
--  confirmed via Meta's own developer community ("Can not pin a page
--  post via graph API") and the absence of any pin/unpin endpoint
--  anywhere in the Instagram Content Publishing docs. Facebook does
--  expose a READ-ONLY `pinned_post` field on the Page object, which
--  is what the verification side of this feature uses — there is
--  nothing equivalent for Instagram at all, so this whole feature is
--  Facebook-only by necessity, not by choice.
--
--  These two columns replace "automatically pin it" with "remember
--  that Ori wanted it pinned, and make the one-click manual follow-up
--  impossible to miss or forget" — see the approval modal's new
--  checkbox and the card's pin-reminder block in admin.html.
--
--  Run this in the Supabase SQL Editor before deploying the updated
--  admin.html / api/publish-scheduled-content.js / api/check-pin-status.js.
-- =============================================================

alter table public.content_queue
  add column if not exists pin_requested boolean not null default false,
  add column if not exists pin_confirmed_at timestamptz;

comment on column public.content_queue.pin_requested is 'Set when Ori checks "Pin after publishing" in the approval modal. Facebook-only — there is no equivalent API for Instagram.';
comment on column public.content_queue.pin_confirmed_at is 'Set either manually (Ori clicks "I''ve pinned it") or automatically once api/check-pin-status.js confirms the Page''s real pinned_post matches this row''s fb_post_id.';
