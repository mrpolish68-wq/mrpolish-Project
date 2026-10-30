// Shared Telegram bot config + a minimal sender, for code outside the bot itself (the publish
// notifications in _publish-notify.js) that must not load the whole webhook module.
// api/telegram-webhook.js imports telegramConfig from here, so both always pick the same bot.
"use strict";

const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";

// Production serves Miri's bot from TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET /
// TELEGRAM_ALLOWED_CHATS and ignores the TEST_ vars entirely. Every other environment
// (branch previews, local runs) serves the separate TEST bot from TELEGRAM_TEST_BOT_TOKEN /
// TELEGRAM_TEST_WEBHOOK_SECRET / TELEGRAM_TEST_ALLOWED_CHATS (Preview-only vars, see
// tools/set-test-webhook.js) and NEVER falls back to the production values: a preview with a
// missing TEST_ var processes nothing (see the webhook handler). Values are never logged.
function telegramConfig() {
  var env = process.env;
  if (env.VERCEL_ENV === "production") {
    return {
      test: false,
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
      allowedChats: env.TELEGRAM_ALLOWED_CHATS || ""
    };
  }
  return {
    test: true,
    botToken: env.TELEGRAM_TEST_BOT_TOKEN || "",
    webhookSecret: env.TELEGRAM_TEST_WEBHOOK_SECRET || "",
    allowedChats: env.TELEGRAM_TEST_ALLOWED_CHATS || ""
  };
}

function allowedChatIds() {
  return telegramConfig().allowedChats.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

// One Bot API call with a hard deadline. Rejects on timeout, network error or ok:false; the error
// text never includes the token (the URL is not part of it).
async function tgCallTimed(method, payload, ms) {
  var res = await fetch(TELEGRAM_API_ROOT + telegramConfig().botToken + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms)
  });
  var data = await res.json().catch(function () { return null; });
  if (!data || !data.ok) throw new Error("Telegram API " + method + " failed: " + ((data && data.description) || res.status));
  return data.result;
}

module.exports = { TELEGRAM_API_ROOT, telegramConfig, allowedChatIds, tgCallTimed };
