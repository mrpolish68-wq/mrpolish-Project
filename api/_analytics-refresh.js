// Real-time manual trigger for the Analytics tab's "🔄 רענון אנליטיקה" button — runs the
// exact same agent logic as the daily cron (api/analytics-agent.js's runAgent()), just
// invoked by a logged-in human on demand instead of waiting for the 03:00 UTC schedule.
//
// Auth: a real Supabase session (verified against /auth/v1/user), same pattern as
// publish-now.js / social-snapshot.js — NOT CRON_SECRET. CRON_SECRET identifies Vercel's own
// cron caller and is a server-only secret; it must never be sent from the browser, so this is
// a genuinely separate endpoint rather than the dashboard calling /api/analytics-agent
// directly with some client-embedded version of that secret.
"use strict";

const core = require("./analytics-agent.js");
const { enforce } = require("./_rate-limit.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
// Public anon key (already embedded client-side in admin.html) — used only to validate a
// caller-supplied user access_token against Supabase, never to bypass RLS.
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
  // A run makes ~25+ sequential Graph API calls (profile + insights + posts + per-post
  // comments, both platforms) and genuinely takes several seconds to tens of seconds — a
  // tight per-IP limit is enough to stop abuse without getting in the way of a legitimate
  // re-click.
  if (enforce(req, res, "analytics-refresh", 5, 60 * 1000)) return;

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

  try {
    var summary = await core.runAgent();
    console.log("[analytics-refresh] user=" + user.id + " " + JSON.stringify(summary));
    res.status(200).json(summary);
  } catch (err) {
    console.error("[analytics-refresh] failed: " + err.message);
    res.status(500).json({ error: "הרצת סוכן האנליטיקה נכשלה. נסו שוב מאוחר יותר." });
  }
};
