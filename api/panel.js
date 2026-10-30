// One Vercel function for the admin panel's session-authenticated actions (media-projects plan,
// Phase 2: functions 11 → 7, so new features fit under the Hobby plan's 12-function limit).
//
// Each action is the ORIGINAL handler, moved unchanged into an underscore module (Vercel doesn't
// deploy `api/_*.js` as functions): its own method check, rate limit (same name + budget), Supabase
// session check and responses. vercel.json rewrites keep every old URL working, so admin.html is
// unchanged:
//   /api/publish-now           → /api/panel?action=publish-now           (api/_publish-now.js)
//   /api/check-publish-status  → /api/panel?action=check-publish-status  (api/_check-publish-status.js)
//   /api/check-pin-status      → /api/panel?action=check-pin-status      (api/_check-pin-status.js)
//   /api/social-snapshot       → /api/panel?action=social-snapshot       (api/_social-snapshot.js)
//   /api/analytics-refresh     → /api/panel?action=analytics-refresh     (api/_analytics-refresh.js)
// maxDuration is per function: 60 s here (publish-now and analytics-refresh were already 60 s).
"use strict";

// Lazy, so one action's module is only loaded when that action is used.
var ROUTES = {
  "publish-now": function () { return require("./_publish-now.js"); },
  "check-publish-status": function () { return require("./_check-publish-status.js"); },
  "check-pin-status": function () { return require("./_check-pin-status.js"); },
  "social-snapshot": function () { return require("./_social-snapshot.js"); },
  "analytics-refresh": function () { return require("./_analytics-refresh.js"); }
};

module.exports = async function handler(req, res) {
  var action = req.query && typeof req.query.action === "string" ? req.query.action : "";
  if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  return ROUTES[action]()(req, res);
};

module.exports.ACTIONS = Object.keys(ROUTES);
