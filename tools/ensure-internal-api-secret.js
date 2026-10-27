#!/usr/bin/env node
// Ensures .env has an INTERNAL_API_SECRET (the shared secret server-to-server callers send as
// X-Internal-Secret to api/render-quote-pdf.js). If it's missing, generates a strong random
// value (32 random bytes, hex) and APPENDS it to .env; an existing value is never changed and
// nothing else in .env is rewritten. The value is never printed.
//
// Usage: node tools/ensure-internal-api-secret.js
//
// The same value must ALSO be set on the Vercel project (Preview + Production), or every
// internal call is rejected with 401.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEY = "INTERNAL_API_SECRET";
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
