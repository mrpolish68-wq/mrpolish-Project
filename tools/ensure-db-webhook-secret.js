#!/usr/bin/env node
// Ensures .env has a DB_WEBHOOK_SECRET: the secret the DATABASE sends (X-Internal-Secret, via pg_net)
// to /api/analytics-agent?task=lead-alert (supabase-lead-alert.sql). A dedicated secret on purpose —
// it opens only that task, not the PDF renderer (INTERNAL_API_SECRET) or the publish cron (CRON_SECRET).
// If it's missing, generates 32 random bytes (hex) and APPENDS it to .env; an existing value is never
// changed and nothing else in .env is rewritten. The value is never printed.
//
// Usage: node tools/ensure-db-webhook-secret.js
//
// The same value must ALSO be set (1) on the Vercel project as DB_WEBHOOK_SECRET (Production, and
// Preview if you test the alert on a preview) and (2) in Supabase Vault as 'db_webhook_secret'.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = "DB_WEBHOOK_SECRET";
const envPath = path.join(__dirname, "..", ".env");

const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const present = raw.split(/\r?\n/).some(function (line) {
  var t = line.trim();
  return t.startsWith(KEY + "=") && t.length > KEY.length + 1;
});

if (present) {
  console.log(KEY + " already present in .env; left unchanged.");
} else {
  const sep = raw.length && !raw.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, sep + KEY + "=" + crypto.randomBytes(32).toString("hex") + "\n");
  console.log("Generated " + KEY + " and appended it to .env (value not shown).");
}
