#!/usr/bin/env node
// Exchanges the User Access Token in META_ACCESS_TOKEN for the genuine
// Page Access Token of META_PAGE_ID (via /me/accounts), and writes it
// straight into .env as META_PAGE_ACCESS_TOKEN.
//
// The token value itself is never printed to the console — only a
// name/ID confirmation. Facebook's "New Pages Experience" requires a
// real Page-type token (not a User token, even one with page-scoped
// permissions) for content endpoints like /posts and /insights.
//
// Usage: node tools/fetch-page-access-token.js
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

  var userToken = env("META_ACCESS_TOKEN");
  var pageId = env("META_PAGE_ID");

  if (!userToken || !pageId) {
    console.error("Need META_ACCESS_TOKEN and META_PAGE_ID set in .env first.");
    process.exitCode = 1;
    return;
  }

  var url = "https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token&access_token=" + encodeURIComponent(userToken);
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

  var pages = data.data || [];
  var match = pages.filter(function (p) { return String(p.id) === String(pageId); })[0];

  if (!match) {
    console.error("Could not find page ID " + pageId + " in this token's managed-pages list.");
    console.error("Pages this token can see: " + pages.map(function (p) { return p.name + " (" + p.id + ")"; }).join(", ") || "(none)");
    process.exitCode = 1;
    return;
  }

  upsertEnvVar(envPath, "META_PAGE_ACCESS_TOKEN", match.access_token);

  console.log("Saved a genuine Page Access Token for \"" + match.name + "\" (ID " + match.id + ") to .env as META_PAGE_ACCESS_TOKEN.");
  console.log("(The token value itself was not printed here — open .env if you need to see it.)");
}

main();
