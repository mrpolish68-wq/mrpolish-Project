// Shared best-effort rate limiter for the API routes (security audit #8).
//
// IMPORTANT scope note: Vercel serverless functions are stateless across cold starts and may
// run on several concurrent instances, so this in-memory limiter is DEFENSE-IN-DEPTH — it
// blunts a burst that hits one warm instance (an accidental client retry loop, casual abuse),
// not a hard global guarantee. A hard guarantee would need a shared store (Upstash/Redis, or a
// Supabase counter table). That's deliberately out of scope here: every route that uses this is
// already gated by a real Supabase session (or CRON_SECRET), so the residual risk this covers is
// small and a per-instance throttle is proportional. The file name is underscore-prefixed so
// Vercel treats it as a helper, not a public route.
//
// Note: the two highest-volume anonymous write paths in this project — the public review and
// lead inserts in main.js — go BROWSER -> SUPABASE directly (PostgREST), never through these
// functions, so they cannot be throttled here. Spam control for those belongs at the Supabase
// layer (a per-window insert cap / captcha); the review form already carries a honeypot field.
"use strict";

var buckets = new Map(); // key -> ascending array of request timestamps (ms) inside the window

function rateLimit(key, max, windowMs) {
  var now = Date.now();
  var arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift(); // evict timestamps outside the window
  if (arr.length >= max) {
    var retryMs = arr[0] + windowMs - now;
    return { ok: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  arr.push(now);
  if (buckets.size > 5000) { // bound memory on a long-lived warm instance
    buckets.forEach(function (v, k) { if (!v.length) buckets.delete(k); });
  }
  return { ok: true };
}

// Best-effort client identity. On Vercel the real client IP is the first entry of
// x-forwarded-for; fall back through the other proxy headers and finally the socket address.
function clientKey(req) {
  var xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

// Applies a limit and, if exceeded, writes a 429 with Retry-After and returns true (caller should
// stop). Returns false when the request is within budget (caller proceeds).
function enforce(req, res, name, max, windowMs) {
  var verdict = rateLimit(name + ":" + clientKey(req), max, windowMs);
  if (!verdict.ok) {
    res.setHeader("Retry-After", String(verdict.retryAfter));
    res.status(429).json({ error: "Too many requests — please wait a moment and try again." });
    return true;
  }
  return false;
}

module.exports = { rateLimit: rateLimit, clientKey: clientKey, enforce: enforce };
