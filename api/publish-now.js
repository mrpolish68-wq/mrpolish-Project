// Real-time publish trigger — called directly by admin.html the instant Ori clicks
// "אשר" (Approve), instead of only setting a status and waiting for the once-daily cron
// (api/publish-scheduled-content.js, which stays wired up as the fallback — see below).
//
// Why this is a separate file rather than the dashboard calling Meta directly: the
// browser never holds META_PAGE_ACCESS_TOKEN or SUPABASE_SERVICE_ROLE_KEY (same rule as
// every other secret in this project, see handoff.md §6/§10) — those only exist server-
// side. This endpoint runs server-side with them, does the actual Meta call, and returns
// just a result summary to the browser.
//
// Auth: NOT the CRON_SECRET (that identifies Vercel's own cron caller, not a person).
// This is called by a logged-in human, so it verifies their real Supabase session instead
// — the same access_token supabase-js already holds after login, sent as a normal Bearer
// header, validated against Supabase's own /auth/v1/user endpoint. A request with no
// valid session (e.g. someone hitting this URL directly, logged out) is rejected before
// touching Meta or the database.
//
// Fallback behavior (the actual safety net, not just a comment): if this call fails for
// any reason — network error, Vercel function timeout on a slow Instagram video/Reel
// upload (see publish-scheduled-content.js's header for why that can happen), Meta API
// error — the row's status is whatever publishOne left it as (see that function): either
// 'failed' with a specific error message (a real, surfaced Meta error), or still
// 'approved' (the attempt never completed, e.g. a network drop before Meta responded).
// Either way, nothing is silently lost: 'failed' rows are retryable from the dashboard
// (re-approve retries), and 'approved' rows are exactly what the daily cron's own query
// (status=eq.approved AND scheduled_for<=now) already picks up on its own schedule. This
// endpoint deliberately never needs its own retry logic — the existing cron already is one.
"use strict";

const core = require("./publish-scheduled-content.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
// Public key, already embedded client-side in admin.html — safe to duplicate here. Used
// only to validate a caller-supplied user access_token against Supabase, never to bypass RLS.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";

async function verifySupabaseUser(accessToken) {
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken }
  });
  if (!res.ok) return null;
  var data = await res.json();
  return data && data.id ? data : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  var authHeader = req.headers.authorization || "";
  var accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    res.status(401).json({ error: "Missing session token." });
    return;
  }
  var user = await verifySupabaseUser(accessToken);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired session — please log in again." });
    return;
  }

  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: "Missing content id." });
    return;
  }

  var token = process.env.META_PAGE_ACCESS_TOKEN;
  var pageId = process.env.META_PAGE_ID;
  var igUserId = process.env.META_IG_USER_ID;
  if (!token || !pageId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing META_PAGE_ACCESS_TOKEN / META_PAGE_ID / SUPABASE_SERVICE_ROLE_KEY configuration." });
    return;
  }

  var row;
  try {
    row = await core.fetchRowById(id);
  } catch (err) {
    console.log("[manual-trigger] fetch failed id=" + id + " error=" + err.message);
    res.status(500).json({ error: err.message });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "Content not found." });
    return;
  }
  if (row.status !== "approved") {
    // Most likely: it was already published/scheduled by a previous click or the cron,
    // and this is a stale/duplicate request racing behind it. Not an error worth alarming
    // over — just tell the dashboard what's actually true right now.
    res.status(409).json({ error: "פריט זה כבר אינו 'מאושר' (סטטוס נוכחי: " + row.status + ").", status: row.status });
    return;
  }

  console.log("[manual-trigger] user=" + (user.email || user.id) + " row=" + id + " platform=" + row.platform + " category=" + row.content_category + " scheduled_for=" + row.scheduled_for);
  var result = await core.publishOne(row, { token: token, pageId: pageId, igUserId: igUserId, triggerSource: "manual" });
  console.log("[manual-trigger] result row=" + id + " " + JSON.stringify(result));

  if (!result.ok) {
    // publishOne's own catch block already wrote status='failed' to the row before
    // returning here — included explicitly so the dashboard doesn't have to guess.
    res.status(502).json({ error: result.error, id: id, status: "failed" });
    return;
  }
  res.status(200).json(result);
};
