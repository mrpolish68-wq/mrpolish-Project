#!/usr/bin/env node
// Bulk-inserts draft rows into Supabase content_queue as status='pending_approval',
// so a batch of content shows up in the dashboard for Ori to review/approve — the
// first automated inserter for this table (every prior batch was hand-run SQL in the
// Supabase SQL Editor, see supabase-content-queue-batch*-seed.sql).
//
// Same credential/no-dependency convention as the rest of tools/ and
// api/publish-scheduled-content.js: reads SUPABASE_SERVICE_ROLE_KEY from .env (falls
// back to a real env var), raw fetch against the REST API, no supabase-js.
//
// Usage: node tools/insert-content-queue.js path/to/batch.json
// The JSON file must be an array of row objects (see REQUIRED_FIELDS below for the
// minimum shape). status defaults to 'pending_approval' if omitted.
"use strict";

const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  var vars = {};
  if (!fs.existsSync(filePath)) return vars;
  fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    var eq = trimmed.indexOf("=");
    if (eq === -1) return;
    var key = trimmed.slice(0, eq).trim();
    var value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  });
  return vars;
}

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const REQUIRED_FIELDS = ["title", "caption", "media_type", "media_url", "platform", "content_category", "scheduled_for"];

// Mirrors the fail-closed guard in api/publish-scheduled-content.js's publishOne(): a
// 'story' row whose media_type isn't literally 'story' would silently publish to the
// feed instead (see that file + supabase-content-queue-story-media-type-fix.sql for
// the incident this guards against). Catching it here means a bad row never even
// reaches the dashboard as 'pending_approval'.
function validateRow(row, index) {
  var errors = [];
  REQUIRED_FIELDS.forEach(function (field) {
    if (row[field] === undefined || row[field] === null || row[field] === "") {
      errors.push("missing '" + field + "'");
    }
  });
  if (row.content_category === "story" && row.media_type !== "story") {
    errors.push("content_category='story' requires media_type='story' (got '" + row.media_type + "')");
  }
  if (errors.length) {
    throw new Error("Row " + index + " (\"" + (row.title || "untitled") + "\"): " + errors.join("; "));
  }
}

async function main() {
  var fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: node tools/insert-content-queue.js path/to/batch.json");
    process.exit(1);
  }
  var envVars = loadEnvFile(path.join(__dirname, "..", ".env"));
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY || envVars.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error("No SUPABASE_SERVICE_ROLE_KEY found (checked process.env and .env).");
    process.exit(1);
  }

  var rows = JSON.parse(fs.readFileSync(path.resolve(fileArg), "utf8"));
  if (!Array.isArray(rows) || !rows.length) {
    console.error("Input file must be a non-empty JSON array of row objects.");
    process.exit(1);
  }

  rows.forEach(function (row, i) {
    validateRow(row, i);
    if (!row.status) row.status = "pending_approval";
  });

  console.log("Inserting " + rows.length + " row(s) into content_queue...");
  var res = await fetch(SUPABASE_URL + "/rest/v1/content_queue", {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    console.error("Insert failed:", res.status, await res.text());
    process.exit(1);
  }
  var inserted = await res.json();
  inserted.forEach(function (r) {
    console.log("  + " + r.id + "  [" + r.content_category + "/" + r.media_type + "]  " + r.title);
  });
  console.log("Done — " + inserted.length + " row(s) inserted as pending_approval.");
}

main().catch(function (err) {
  console.error("Error:", err.message);
  process.exit(1);
});
