#!/usr/bin/env node
// Exchanges the short-lived META_ACCESS_TOKEN (fresh from Graph API
// Explorer, ~1-2 hours) for a long-lived one (~60 days) via Meta's
// token-exchange endpoint, and writes it back into .env.
//
// Run this BEFORE tools/fetch-page-access-token.js — a Page token
// derived from a long-lived User token is itself effectively long-lived,
// which a short-lived one is not. Never prints the token value itself.
//
// Usage: node tools/exchange-long-lived-token.js
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

function upsertEnvVar(envPath, key, value) {
  var raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  var lines = raw.split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });
  var found = false;
  lines = lines.map(function (l) {
    if (l.trim().startsWith(key + "=")) { found = true; return key + "=" + value; }
    return l;
  });
  if (!found) lines.push(key + "=" + value);
  fs.writeFileSync(envPath, lines.join("\n") + "\n");
}

async function main() {
  var envPath = path.join(__dirname, "..", ".env");
  var fileVars = loadEnvFile(envPath);
  function env(key) { return process.env[key] || fileVars[key]; }

  var shortToken = env("META_ACCESS_TOKEN");
  var appId = env("META_APP_ID");
  var appSecret = env("META_APP_SECRET");

  if (!shortToken || !appId || !appSecret) {
    console.error("Need META_ACCESS_TOKEN, META_APP_ID, and META_APP_SECRET set in .env first.");
    process.exitCode = 1;
    return;
  }

  var url = "https://graph.facebook.com/v20.0/oauth/access_token" +
    "?grant_type=fb_exchange_token" +
    "&client_id=" + encodeURIComponent(appId) +
    "&client_secret=" + encodeURIComponent(appSecret) +
    "&fb_exchange_token=" + encodeURIComponent(shortToken);

  var res, data;
  try {
    res = await fetch(url);
    data = await res.json();
  } catch (err) {
    console.error("Network request to the Facebook Graph API failed:", err.message);
    process.exitCode = 1;
    return;
  }

  if (data.error) {
    console.error("Facebook Graph API returned an error:", data.error.message);
    process.exitCode = 1;
    return;
  }

  upsertEnvVar(envPath, "META_ACCESS_TOKEN", data.access_token);

  var days = data.expires_in ? Math.round(data.expires_in / 86400) : null;
  console.log("Success: exchanged for a long-lived User token" + (days ? " (expires in ~" + days + " days)" : "") + ".");
  console.log("Saved to .env as META_ACCESS_TOKEN. (The token value itself was not printed.)");
  console.log("Next: run `node tools/fetch-page-access-token.js` to derive the long-lived Page token, then update META_PAGE_ACCESS_TOKEN in Vercel's env vars.");
}

main();
