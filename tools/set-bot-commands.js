#!/usr/bin/env node
// Sets the bot's command menu (setMyCommands): /start, /quote, /project, /help, in Hebrew.
//
// Usage:
//   node tools/set-bot-commands.js test          # the TEST bot (TELEGRAM_TEST_BOT_TOKEN)
//   node tools/set-bot-commands.js production    # Miri's bot (TELEGRAM_BOT_TOKEN) — only at the final merge
//   node tools/set-bot-commands.js test show     # print the current commands
//
// Tokens are read from .env (or process.env) and never printed. "test" refuses to run if the
// test token is the production bot (same guard as tools/set-test-webhook.js).
"use strict";

const fs = require("fs");
const path = require("path");

const COMMANDS = [
  { command: "start", description: "תפריט ראשי" },
  { command: "quote", description: "הצעת מחיר חדשה" },
  { command: "project", description: "פרויקט חדש" },
  { command: "help", description: "עזרה" }
];

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

async function tg(token, method, body) {
  var res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

async function main() {
  var fileVars = loadEnvFile(path.join(__dirname, "..", ".env"));
  function env(key) { return process.env[key] || fileVars[key]; }

  var target = process.argv[2];
  if (target !== "test" && target !== "production") {
    console.error("Usage: node tools/set-bot-commands.js test|production [show]");
    process.exitCode = 1;
    return;
  }
  var prod = env("TELEGRAM_BOT_TOKEN") || "";
  var token = target === "test" ? env("TELEGRAM_TEST_BOT_TOKEN") : prod;
  if (!token) {
    console.error("Missing " + (target === "test" ? "TELEGRAM_TEST_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN") + " in .env.");
    process.exitCode = 1;
    return;
  }
  if (target === "test" && prod && (token === prod || token.split(":")[0] === prod.split(":")[0])) {
    console.error("Refusing: TELEGRAM_TEST_BOT_TOKEN is the PRODUCTION bot.");
    process.exitCode = 1;
    return;
  }

  var me = await tg(token, "getMe");
  if (!me.ok) { console.error("getMe failed:", me.description); process.exitCode = 1; return; }
  console.log((target === "test" ? "Test" : "PRODUCTION") + " bot: @" + me.result.username);

  if (process.argv[3] !== "show") {
    var set = await tg(token, "setMyCommands", { commands: COMMANDS });
    if (!set.ok) { console.error("setMyCommands failed:", set.description); process.exitCode = 1; return; }
    console.log("Commands set.");
  }
  var got = await tg(token, "getMyCommands");
  (got.result || []).forEach(function (c) { console.log("  /" + c.command + " — " + c.description); });
}

main().catch(function (err) {
  console.error("Unexpected error:", err.message);
  process.exitCode = 1;
});
