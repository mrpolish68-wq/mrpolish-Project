// Collects Content-Security-Policy-Report-Only violation reports (see vercel.json's headers
// block for the policy itself) so the report-only rollout can actually be evaluated — without
// somewhere to land, browser-side CSP violations are only visible one-by-one in each visitor's
// own devtools console, invisible to us. No auth: browsers send these anonymously by design,
// same as every other unauthenticated report/beacon endpoint. Logged via console.log only,
// matching this project's existing observability approach (no dedicated log store exists here —
// see the cron/publish-now handlers) — read via Vercel's function log viewer.
"use strict";

const { enforce } = require("./_rate-limit.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }
  // Public and unauthenticated by necessity (see header comment) — rate-limited per IP so a
  // broken page loop or deliberate abuse can't flood the function logs indefinitely. Generous
  // limit: a single real page load can legitimately fire several violation reports at once
  // during the report-only rollout (one per still-unlisted source).
  if (enforce(req, res, "csp-report", 40, 60 * 1000)) return;

  var chunks = [];
  for await (var chunk of req) chunks.push(chunk);
  var raw = Buffer.concat(chunks).toString("utf8");
  if (raw) console.log("[csp-report] " + raw);
  res.status(204).end();
};

// Report bodies arrive as application/csp-report or application/reports+json — neither is a
// content-type Vercel's default parser recognizes, so req.body would be undefined for both.
// Disabling the parser and reading the raw stream above works for either format uniformly.
module.exports.config = { api: { bodyParser: false } };
