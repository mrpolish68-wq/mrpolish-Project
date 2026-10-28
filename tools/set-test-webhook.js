#!/usr/bin/env node
// Points the TEST Telegram bot at the feature/telegram-quotes branch preview. It only ever uses
// TELEGRAM_TEST_BOT_TOKEN: Miri's production bot (TELEGRAM_BOT_TOKEN) is never called, and the
// script refuses to run if the two tokens are the same bot.
//
// Usage:
//   node tools/set-test-webhook.js chatid              # recent chat ids + first names (via getUpdates)
//   node tools/set-test-webhook.js register [baseUrl]  # set the webhook on the branch alias (default below)
//   node tools/set-test-webhook.js info                # current webhook status (URL query redacted)
//   node tools/set-test-webhook.js delete              # remove the webhook (getUpdates works again)
//
// register: generates TELEGRAM_TEST_WEBHOOK_SECRET into .env if it's missing (appended, nothing else
// in .env rewritten). Telegram sends it back on every call as X-Telegram-Bot-Api-Secret-Token, so
// the preview's TELEGRAM_WEBHOOK_SECRET must be set to the same value. The preview is behind
// Vercel Authentication, so the URL carries ?x-vercel-protection-bypass=<VERCEL_AUTOMATION_BYPASS_SECRET>.
// No token or secret is ever printed (getWebhookInfo echoes the URL, so its query is redacted).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Stable alias of the latest feature/telegram-quotes deployment (Vercel's "git-<branch>" URL).
const DEFAULT_BASE = "https://mrpolish-project-git-feature-telegram-quotes-polish1.vercel.app";
const SECRET_KEY = "TELEGRAM_TEST_WEBHOOK_SECRET";

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

function appendEnvVar(envPath, key, value) {
  var raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  var sep = raw.length && !raw.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, sep + key + "=" + value + "\n");
}

function redactUrl(u) {
  return u ? String(u).replace(/\?.*$/, "?<redacted>") : u;
}

async function tg(token, method, body) {
  var res = await fetch("https://api.telegram.org/bot" + token + "/" + method, body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  } : undefined);
  return res.json();
}

async function main() {
  var envPath = path.join(__dirname, "..", ".env");
  var fileVars = loadEnvFile(envPath);
  function env(key) { return process.env[key] || fileVars[key]; }

  var token = env("TELEGRAM_TEST_BOT_TOKEN");
  if (!token) {
    console.error("Set TELEGRAM_TEST_BOT_TOKEN in .env first (the TEST bot's token from @BotFather).");
    process.exitCode = 1;
    return;
  }
  // Safety guard: never touch the production bot. Compare the bot id (the part before ":") too,
  // so a regenerated token of the same bot is still refused.
  var prod = env("TELEGRAM_BOT_TOKEN") || "";
  if (token === prod || (prod && token.split(":")[0] === prod.split(":")[0])) {
    console.error("Refusing: TELEGRAM_TEST_BOT_TOKEN is the PRODUCTION bot (same as TELEGRAM_BOT_TOKEN).");
    process.exitCode = 1;
    return;
  }

  var me = await tg(token, "getMe");
  if (!me.ok) { console.error("getMe failed:", me.description); process.exitCode = 1; return; }
  console.log("Test bot: @" + me.result.username + " (id " + me.result.id + ")");

  var arg = process.argv[2];

  if (arg === "chatid") {
    var upd = await tg(token, "getUpdates");
    if (!upd.ok) {
      console.error("getUpdates failed:", upd.description, "(if a webhook is set, run 'delete' first)");
      process.exitCode = 1;
      return;
    }
    var seen = {};
    (upd.result || []).forEach(function (u) {
      var msg = u.message || u.edited_message || (u.callback_query && u.callback_query.message);
      var from = (u.message && u.message.from) || (u.callback_query && u.callback_query.from) || {};
      if (msg && msg.chat && !seen[msg.chat.id]) {
        seen[msg.chat.id] = true;
        console.log("chat id " + msg.chat.id + " — " + (msg.chat.first_name || from.first_name || msg.chat.title || "?") + " (" + msg.chat.type + ")");
      }
    });
    if (!Object.keys(seen).length) console.log("No recent messages. Send the test bot a message (e.g. היי) and run this again.");
    return;
  }

  if (!arg || arg === "info") {
    var info = await tg(token, "getWebhookInfo");
    if (!info.ok) { console.error("getWebhookInfo failed:", info.description); process.exitCode = 1; return; }
    var r = Object.assign({}, info.result, { url: redactUrl(info.result.url) });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (arg === "delete") {
    var del = await tg(token, "deleteWebhook");
    console.log(del.ok ? "Webhook removed." : "Failed to remove webhook: " + del.description);
    return;
  }

  if (arg !== "register") {
    console.error("Usage: node tools/set-test-webhook.js chatid | register [baseUrl] | info | delete");
    process.exitCode = 1;
    return;
  }

  var base = (process.argv[3] || DEFAULT_BASE).replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+\.vercel\.app$/.test(base)) {
    console.error("baseUrl must be an https://<name>.vercel.app preview URL.");
    process.exitCode = 1;
    return;
  }
  var bypass = env("VERCEL_AUTOMATION_BYPASS_SECRET");
  if (!bypass) {
    console.error("Set VERCEL_AUTOMATION_BYPASS_SECRET in .env first (Vercel → Settings → Deployment Protection).");
    process.exitCode = 1;
    return;
  }

  var secret = env(SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(24).toString("hex");
    appendEnvVar(envPath, SECRET_KEY, secret);
    console.log("Generated " + SECRET_KEY + " and appended it to .env (value not shown).");
    console.log("⚠️  The preview's TELEGRAM_WEBHOOK_SECRET must be set to this same value, or every update gets 401.");
  }

  var webhookUrl = base + "/api/telegram-webhook?x-vercel-protection-bypass=" + encodeURIComponent(bypass);
  var set = await tg(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  if (!set.ok) { console.error("setWebhook failed:", set.description); process.exitCode = 1; return; }
  console.log("Webhook registered: " + redactUrl(webhookUrl));
  console.log("(" + set.description + ")");
}

main().catch(function (err) {
  console.error("Unexpected error:", err.message);
  process.exitCode = 1;
});
