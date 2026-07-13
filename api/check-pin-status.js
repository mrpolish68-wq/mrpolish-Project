// On-demand check against the one Meta field this whole feature can actually use: the
// Page's real, current pinned_post — a READ-ONLY field (there is no write endpoint to set
// it; see handoff.md for the full research that led to this design). Called by the
// dashboard's "🔄 בדוק אם ננעץ" button on the pin-reminder shown after a post with
// pin_requested=true is published — lets Ori verify a manual pin he just did in Facebook's
// own UI, or confirm it's still not pinned yet, without eyeballing the live Page himself.
//
// Facebook-only, deliberately — Instagram exposes no equivalent field or endpoint at all.
//
// Auth: same real-session pattern as publish-now.js / check-publish-status.js.
"use strict";

const core = require("./publish-scheduled-content.js");
const { enforce } = require("./_rate-limit.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
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
  if (enforce(req, res, "check-pin-status", 30, 60 * 1000)) return;

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
  if (!token || !pageId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing META_PAGE_ACCESS_TOKEN / META_PAGE_ID / SUPABASE_SERVICE_ROLE_KEY configuration." });
    return;
  }

  var row;
  try {
    row = await core.fetchRowById(id);
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "Content not found." });
    return;
  }
  if (!row.pin_requested || !row.fb_post_id) {
    res.status(409).json({ error: "בדיקת נעיצה רלוונטית רק לפריטים שסומנו לנעיצה ופורסמו בפועל.", status: row.status });
    return;
  }

  console.log("[pin-check] user=" + (user.email || user.id) + " row=" + id + " fb_post_id=" + row.fb_post_id);
  var result = await core.checkPinStatus(row, { token: token, pageId: pageId });
  console.log("[pin-check] result row=" + id + " " + JSON.stringify(result));

  if (!result.ok) {
    res.status(502).json({ error: result.error, id: id });
    return;
  }
  res.status(200).json(result);
};
