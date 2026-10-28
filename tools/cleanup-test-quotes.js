#!/usr/bin/env node
// Removes quotes created by the TEST bot (Phase 7 pre-launch checklist).
//
// Usage:
//   node tools/cleanup-test-quotes.js            # dry run: lists what WOULD be deleted (number + date only)
//   node tools/cleanup-test-quotes.js --apply    # deletes them, then resets the numbering floor
//
// Scope: ONLY quotes with source = 'telegram' AND telegram_chat_id in TELEGRAM_TEST_ALLOWED_CHATS
// (read from .env). Panel quotes (source = 'panel') and quotes from any other chat are never touched.
// --apply: deletes each quote's PDF (quotes-pdf/<id>.pdf), then the rows, then sets
// quote_counter.floor_next = greatest(max(number) + 1, 14) and prints the next number.
// Reads SUPABASE_SERVICE_ROLE_KEY from .env; never prints it, nor any client name/address.
"use strict";

const fs = require("fs");
const path = require("path");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const MIN_FLOOR = 14; // the last number issued before the bot existed was 13

function loadEnvFile(filePath) {
  var vars = {};
  if (!fs.existsSync(filePath)) return vars;
  fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    var eq = trimmed.indexOf("=");
    if (eq === -1) return;
    var value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    vars[trimmed.slice(0, eq).trim()] = value;
  });
  return vars;
}

async function main() {
  var fileVars = loadEnvFile(path.join(__dirname, "..", ".env"));
  function env(k) { return process.env[k] || fileVars[k]; }
  var apply = process.argv.indexOf("--apply") !== -1;

  var key = env("SUPABASE_SERVICE_ROLE_KEY");
  var chats = String(env("TELEGRAM_TEST_ALLOWED_CHATS") || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!key) { console.error("Missing SUPABASE_SERVICE_ROLE_KEY in .env."); process.exitCode = 1; return; }
  if (!chats.length || !chats.every(function (c) { return /^-?\d+$/.test(c); })) {
    console.error("Set TELEGRAM_TEST_ALLOWED_CHATS in .env to the test chat id(s), e.g. TELEGRAM_TEST_ALLOWED_CHATS=1230764171");
    process.exitCode = 1;
    return;
  }
  var headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };

  var res = await fetch(SUPABASE_URL + "/rest/v1/quotes?select=id,number,quote_date&source=eq.telegram&telegram_chat_id=in.(" + chats.join(",") + ")&order=number.asc", { headers: headers });
  if (!res.ok) { console.error("Query failed: HTTP " + res.status); process.exitCode = 1; return; }
  var rows = await res.json();

  console.log("Test chats: " + chats.join(", ") + " — telegram quotes found: " + rows.length);
  rows.forEach(function (r) { console.log("  מס׳ " + String(r.number).padStart(3, "0") + "  " + r.quote_date); });
  if (!apply) {
    console.log(rows.length ? "\nDry run: nothing deleted. Re-run with --apply to delete these." : "\nDry run: nothing to delete.");
    return; // a dry run never writes (not even the counter)
  }

  if (rows.length) {
    // 1. PDFs (deterministic path <id>.pdf; a missing object is fine).
    var del = await fetch(SUPABASE_URL + "/storage/v1/object/quotes-pdf", {
      method: "DELETE", headers: headers,
      body: JSON.stringify({ prefixes: rows.map(function (r) { return r.id + ".pdf"; }) })
    });
    if (!del.ok) { console.error("PDF delete failed: HTTP " + del.status + " — rows NOT deleted."); process.exitCode = 1; return; }
    var removed = await del.json().catch(function () { return []; });
    console.log("PDFs deleted: " + (Array.isArray(removed) ? removed.length : "?"));

    // 2. Rows — re-filtered by source + chat, so a wrong id can never hit a panel quote.
    var ids = rows.map(function (r) { return r.id; }).join(",");
    var rowDel = await fetch(SUPABASE_URL + "/rest/v1/quotes?id=in.(" + ids + ")&source=eq.telegram&telegram_chat_id=in.(" + chats.join(",") + ")", {
      method: "DELETE", headers: Object.assign({ Prefer: "return=representation" }, headers)
    });
    if (!rowDel.ok) { console.error("Row delete failed: HTTP " + rowDel.status); process.exitCode = 1; return; }
    var gone = await rowDel.json();
    console.log("Quotes deleted: " + gone.length);
  }

  // 3. Numbering floor: greatest(max(number) + 1, 14).
  var maxRes = await fetch(SUPABASE_URL + "/rest/v1/quotes?select=number&order=number.desc&limit=1", { headers: headers });
  if (!maxRes.ok) { console.error("Max query failed: HTTP " + maxRes.status); process.exitCode = 1; return; }
  var top = await maxRes.json();
  var floor = Math.max(top.length ? top[0].number + 1 : 1, MIN_FLOOR);
  var upd = await fetch(SUPABASE_URL + "/rest/v1/quote_counter?id=eq.true", {
    method: "PATCH", headers: Object.assign({ Prefer: "return=representation" }, headers),
    body: JSON.stringify({ floor_next: floor })
  });
  if (!upd.ok) { console.error("Counter update failed: HTTP " + upd.status); process.exitCode = 1; return; }
  var counter = await upd.json();
  console.log("quote_counter.floor_next = " + (counter[0] ? counter[0].floor_next : "?") + " → the next quote will be מס׳ " + String(floor).padStart(3, "0"));
}

main().catch(function (err) {
  console.error("Unexpected error:", err.message);
  process.exitCode = 1;
});
