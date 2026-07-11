#!/usr/bin/env node
// Verifies Meta/Facebook Graph API credentials from .env and prints the
// Mr. Polish Page's name + ID.
//
// Credential modes, checked in this order:
//   1. META_ACCESS_TOKEN + META_PAGE_ID — query the Page node directly by
//      ID (GET /{page-id}?fields=id,name). This is the mode that actually
//      works with a real, granularly-scoped User Access Token that has
//      pages_read_engagement on that specific page (the common case when
//      the token comes from Graph API Explorer's "Page Access Token"
//      picker) — /me returns the wrong identity (the human user) for that
//      kind of token, so we ask for the Page node itself instead.
//   2. META_ACCESS_TOKEN alone — falls back to the /me endpoint. Only
//      correct if the token is a genuine Page-type token (verify with
//      https://developers.facebook.com/tools/debug/accesstoken/ — look
//      for "type": "PAGE", not "type": "USER").
//   3. META_APP_ID + META_APP_SECRET + META_PAGE_USERNAME — App Access
//      Token fallback, reads only PUBLIC page fields, no user login
//      needed, but requires the "Page Public Metadata Access" feature to
//      be enabled for the app.
//
// Usage: node tools/verify-facebook-token.js
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

async function fetchJson(url) {
  var res = await fetch(url);
  return res.json();
}

async function main() {
  var fileVars = loadEnvFile(path.join(__dirname, "..", ".env"));
  function env(key) { return process.env[key] || fileVars[key]; }

  var token = env("META_ACCESS_TOKEN");
  var pageId = env("META_PAGE_ID");
  var appId = env("META_APP_ID");
  var appSecret = env("META_APP_SECRET");
  var pageUsername = env("META_PAGE_USERNAME");

  var data, mode;
  try {
    if (token && pageId) {
      mode = "META_ACCESS_TOKEN (Page node lookup by META_PAGE_ID)";
      var pageUrl = "https://graph.facebook.com/v20.0/" + encodeURIComponent(pageId) +
        "?fields=id,name&access_token=" + encodeURIComponent(token);
      data = await fetchJson(pageUrl);
    } else if (token) {
      mode = "META_ACCESS_TOKEN (/me lookup)";
      var meUrl = "https://graph.facebook.com/v20.0/me?fields=id,name&access_token=" + encodeURIComponent(token);
      data = await fetchJson(meUrl);
    } else if (appId && appSecret && pageUsername) {
      mode = "App Access Token (public page fields)";
      var appToken = appId + "|" + appSecret;
      var appUrl = "https://graph.facebook.com/v20.0/" + encodeURIComponent(pageUsername) +
        "?fields=id,name&access_token=" + encodeURIComponent(appToken);
      data = await fetchJson(appUrl);
    } else {
      console.error("No usable credentials found in .env. Set either:");
      console.error("  META_ACCESS_TOKEN (+ optionally META_PAGE_ID), or");
      console.error("  META_APP_ID + META_APP_SECRET + META_PAGE_USERNAME");
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    console.error("Network request to the Facebook Graph API failed:", err.message);
    process.exitCode = 1;
    return;
  }

  if (data.error) {
    console.error("Facebook Graph API returned an error (" + mode + "):", data.error.message);
    process.exitCode = 1;
    return;
  }

  console.log("Connected via " + mode + ":");
  console.log("  Name:", data.name);
  console.log("  ID:  ", data.id);
}

main();
