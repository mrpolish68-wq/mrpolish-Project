-- =============================================================
--  Mr. Polish — fix for the "leads" table's anonymous-insert RLS
--  policy silently rejecting real customer submissions.
--
--  ROOT CAUSE (found during the 2026-08-15 zero-conversions audit):
--  The lead form's optional fields ("עיר / יישוב" / location, and
--  the free-text message that gets folded into "notes") are NOT
--  marked `required` in the HTML, so a visitor who leaves them
--  blank has the client send an empty string (""), not `null`
--  (`form.location.value.trim()` on an empty input is `""`).
--  The RLS `with_check` policy only allowed NULL or >=2/>=5 chars
--  for these fields — an empty string satisfied neither, so
--  PostgREST rejected the INSERT with 401 "new row violates
--  row-level security policy". The client's `fetch(...).catch()`
--  only catches network-level failures, not HTTP error responses,
--  so this rejection was completely invisible: the visitor saw
--  "Thanks!" and landed on thankyou.html while nothing was saved.
--  Confirmed live via a real REST call through the anon role.
--
--  This migration is defense-in-depth alongside the main.js fix
--  (which now sends `null` instead of "" for blank optional
--  fields) — even if a future code path sends an empty string
--  again, the database no longer silently drops the lead.
--
--  UPDATE (2026-08-15 QA regression pass): the original phone regex
--  (`^[+]?[(]?[0-9]{2,4}[)]?[-\s.]*[0-9]{3,4}[-\s.]*[0-9]{3,4}$`)
--  required its middle digit group to be 3-4 digits, which rejects
--  a realistic international format like "+972-52-953-4540" (the
--  "52" area code segment is only 2 digits once the leading 0 is
--  dropped for international dialing). Found via a systematic
--  payload matrix run through the real anon REST endpoint, not just
--  by inspection. Replaced with a digit-count check (9-15 actual
--  digits, ignoring separator characters) instead of a rigid
--  positional-group pattern, so it uniformly accepts local
--  (052-953-4540), international with or without dashes
--  (+972-52-953-4540 / +972529534540), and spaced formats without
--  needing to enumerate every valid grouping. The matching HTML
--  `pattern` attribute on the phone input was widened at the same
--  time (see index.html) so both layers agree on what's valid.
--
--  Run this once in the Supabase SQL Editor if not already applied
--  via the MCP migration in this session.
-- =============================================================

drop policy if exists "Allow anonymous inserts" on public.leads;

create policy "Allow anonymous inserts"
  on public.leads
  for insert
  to anon
  with check (
    name is not null and length(trim(both from name)) >= 2
    and phone is not null and length(trim(both from phone)) >= 7
    and service is not null and length(trim(both from service)) >= 2
    and (notes is null or trim(both from notes) = '' or length(trim(both from notes)) >= 5)
    and (location is null or trim(both from location) = '' or length(trim(both from location)) >= 2)
    and phone ~ '^[+0-9()\-\s.]+$'
    and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 9 and 15
    and length(name) <= 120
    and length(phone) <= 40
    and length(service) <= 80
    and (notes is null or length(notes) <= 2000)
    and (location is null or length(location) <= 200)
  );
