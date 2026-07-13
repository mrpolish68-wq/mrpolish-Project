// On-demand "did Meta actually publish this yet?" check — called by the dashboard's
// "🔄 בדיקת סטטוס במטא" button, shown only on rows with status='scheduled' (a Facebook post
// natively scheduled with Meta, per publishOne in publish-scheduled-content.js — Meta's own
// servers publish it later, not this app, so it's the one state where "approved" doesn't
// mean "definitely already live"). The daily cron also runs this same check automatically
// for every due 'scheduled' row (see that file's handler) — this endpoint exists purely so
// Ori isn't stuck waiting for the next cron tick if he wants to verify sooner.
//
// Auth: same real-session pattern as publish-now.js (not CRON_SECRET) — see that file's
// header for the full reasoning.
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
  if (enforce(req, res, "check-publish-status", 30, 60 * 1000)) return;

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
  if (!token || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing META_PAGE_ACCESS_TOKEN / SUPABASE_SERVICE_ROLE_KEY configuration." });
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
  if (row.status !== "scheduled") {
    res.status(409).json({ error: "בדיקת סטטוס רלוונטית רק לפריטים 'ממתין לפרסום' (סטטוס נוכחי: " + row.status + ").", status: row.status });
    return;
  }

  console.log("[status-check] user=" + (user.email || user.id) + " row=" + id + " fb_post_id=" + row.fb_post_id);
  var result = await core.checkScheduledStatus(row, { token: token });
  console.log("[status-check] result row=" + id + " " + JSON.stringify(result));

  if (!result.ok) {
    res.status(502).json({ error: result.error, id: id });
    return;
  }
  res.status(200).json(result);
};
