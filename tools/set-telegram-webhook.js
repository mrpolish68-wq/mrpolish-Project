#!/usr/bin/env node
// Registers (or inspects) the live Telegram webhook for the Mr. Polish receipt bot.
//
// Usage:
//   node tools/set-telegram-webhook.js https://mr-polishes.com     # register the webhook
//   node tools/set-telegram-webhook.js info                        # show current webhook status
//   node tools/set-telegram-webhook.js delete                      # unregister (e.g. before local testing via getUpdates)
//
// Reads TELEGRAM_BOT_TOKEN from .env (or process.env). If TELEGRAM_WEBHOOK_SECRET isn't
// set yet, generates one and saves it into .env — but note that value must ALSO be set as
// an env var on the deployed Vercel project (api/telegram-webhook.js checks incoming
// requests' X-Telegram-Bot-Api-Secret-Token header against it), or every real Telegram
// call will be rejected with 401 even though registration itself succeeded. The token
// value is never printed to the console.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

  var token = env("TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.error("Set TELEGRAM_BOT_TOKEN in .env first (create a bot via @BotFather on Telegram, it gives you the token).");
    process.exitCode = 1;
    return;
  }

  var arg = process.argv[2];

  if (!arg || arg === "info") {
    var infoRes = await fetch("https://api.telegram.org/bot" + token + "/getWebhookInfo");
    var info = await infoRes.json();
    if (!info.ok) { console.error("getWebhookInfo failed:", info.description); process.exitCode = 1; return; }
    console.log("Current webhook status:");
    console.log(JSON.stringify(info.result, null, 2));
    return;
  }

  if (arg === "delete") {
    var delRes = await fetch("https://api.telegram.org/bot" + token + "/deleteWebhook");
    var del = await delRes.json();
    console.log(del.ok ? "Webhook removed." : "Failed to remove webhook: " + del.description);
    return;
  }

  var domain = arg.replace(/\/+$/, "");
  if (!/^https:\/\//.test(domain)) {
    console.error("Domain must start with https:// (Telegram requires HTTPS for webhooks).");
    console.error("Usage: node tools/set-telegram-webhook.js https://your-domain.com");
    process.exitCode = 1;
    return;
  }

  var secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    secret = crypto.randomBytes(24).toString("hex");
    upsertEnvVar(envPath, "TELEGRAM_WEBHOOK_SECRET", secret);
    console.log("Generated a new TELEGRAM_WEBHOOK_SECRET and saved it to .env.");
    console.log("⚠️  You must also add TELEGRAM_WEBHOOK_SECRET to the Vercel project's environment");
    console.log("    variables with the SAME value (open .env to copy it) — the deployed function");
    console.log("    checks every incoming request against it, and won't work without it set there too.");
  }

  var webhookUrl = domain + "/api/telegram-webhook";
  var setRes = await fetch("https://api.telegram.org/bot" + token + "/setWebhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    })
  });
  var set = await setRes.json();
  if (!set.ok) {
    console.error("setWebhook failed:", set.description);
    process.exitCode = 1;
    return;
  }
  console.log("Webhook registered: " + webhookUrl);
  console.log("(" + set.description + ")");
}

main().catch(function (err) {
  console.error("Unexpected error:", err.message);
  process.exitCode = 1;
});
