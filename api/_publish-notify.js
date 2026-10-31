// Telegram notifications for the content pipeline: one short Hebrew message per publishOne()
// result (cron, GitHub trigger and the panel's real-time Approve all share publishOne), and one
// when a natively-scheduled Facebook post is confirmed live by checkScheduledStatus().
//
// Rules (owner spec, 2026-10-30): plain text, one item per line — status header, "📝 <title>",
// a separator, one "📘 פייסבוק: …" / "📸 אינסטגרם: …" line per targeted platform (✅ פורסם /
// ✅ כבר פורסם קודם / ❌ לא פורסם [אחרי N ניסיונות]), then the time (success) or the reason + what
// next (failure). No raw URLs: links are inline URL buttons for the live posts, plus "פתח בפאנל"
// on a final failure.
//   - published         → always
//   - failed / partial  → only on the FIRST failure of an approval and on the FINAL one
//                         (auto-retries in between stay silent)
//   - natively scheduled on Facebook, deferred, skipped → nothing (✅ follows once it is live)
//
// Never breaks or delays publishing: notifyPublishResult() starts the work and returns at once
// (waitUntil keeps the function alive after the response); every Telegram/Meta call has an ~8 s
// deadline; nothing here throws to the caller. Plain text (no parse_mode), so titles can't inject
// markup; titles are cleaned and cut to ~80 chars. Logs carry the row id and the kind only.
//
// No duplicate messages, without a new table: a message is only sent by the caller that actually
// produced the result. publishOne() acts only after its atomic claimRow() (one winner per
// attempt; publish_attempts numbers the attempt), and the scheduled→published flip in
// checkScheduledStatus() is a conditional update (only the caller whose PATCH matched notifies).
// So (row id, outcome, attempt) can only ever be produced once. A per-instance key set is kept
// as a second guard against a repeated call inside one warm instance.
"use strict";

const { waitUntil } = require("@vercel/functions");
const { telegramConfig, allowedChatIds, tgCallTimed } = require("./_telegram.js");

const GRAPH_VERSION = "v20.0";
const TITLE_MAX = 80;
var timeoutMs = 8000;

var sentKeys = new Set();
function rememberKey(key) {
  if (sentKeys.has(key)) return false;
  if (sentKeys.size > 500) sentKeys.clear();
  sentKeys.add(key);
  return true;
}

function cleanTitle(row) {
  var raw = (row && (row.title || row.caption)) || "";
  var t = String(raw).replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) t = "פוסט ללא כותרת";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trim() + "…" : t;
}

function targets(row) {
  return {
    fb: row.platform === "facebook" || row.platform === "both",
    ig: row.platform === "instagram" || row.platform === "both"
  };
}

// Short, friendly Hebrew reason. The raw Meta error stays in content_queue.publish_error (panel).
function friendlyReason(error) {
  var e = String(error || "");
  if (/rate limit|request limit|אנו מגבילים|spam/i.test(e)) return "מטא הגבילה זמנית את קצב הפרסום";
  if (/did not finish processing|poll window/i.test(e)) return "אינסטגרם לא סיים לעבד את הסרטון בזמן";
  if (/Media ID is not available/i.test(e)) return "אינסטגרם עוד לא היה מוכן לפרסום";
  if (/media processing failed/i.test(e)) return "אינסטגרם לא הצליח לעבד את הקובץ";
  if (/container expired|EXPIRED/.test(e)) return "אינסטגרם לא סיים לעבד את הסרטון בזמן";
  if (/fewer than 2 usable photos|at least 2 photos/i.test(e)) return "חסרות תמונות לפוסט מרובה תמונות";
  if (/could not sign the video|unsupported media reference/i.test(e)) return "קובץ הסרטון לא נמצא באחסון";
  if (/META_IG_USER_ID/.test(e)) return "חסרה הגדרת אינסטגרם בשרת";
  if (/Story row has media_type/.test(e)) return "סוג המדיה לא מתאים לסטורי";
  if (/Stories cannot be scheduled|video Stories/i.test(e)) return "סטורי בפייסבוק לא נתמך בצורה הזו";
  if (/Supabase/i.test(e)) return "תקלה זמנית במסד הנתונים";
  return "שגיאה מצד מטא";
}

function facebookUrl(fbPostId, row, pageId) {
  var id = String(fbPostId);
  if (id.indexOf("_") === -1 && (row.media_type === "video" || row.media_type === "reel") && pageId) {
    return "https://www.facebook.com/" + pageId + "/videos/" + id;
  }
  return "https://www.facebook.com/" + id;
}

async function instagramPermalink(mediaId, token) {
  if (!token) return null;
  try {
    var res = await fetch("https://graph.facebook.com/" + GRAPH_VERSION + "/" + encodeURIComponent(mediaId) +
      "?fields=permalink&access_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(timeoutMs) });
    var data = await res.json();
    return data && typeof data.permalink === "string" && /^https:\/\/(www\.)?instagram\.com\//.test(data.permalink) ? data.permalink : null;
  } catch (_) {
    return null;
  }
}

// Pure decision: what (if anything) should be said about this result. row = the row as it was
// BEFORE the attempt (publish_attempts not yet incremented); result = publishOne's return value.
function planPublishNotification(row, result, ctx) {
  ctx = ctx || {};
  if (!row || !result || result.deferred || result.skipped) return null;
  var attempt = (row.publish_attempts || 0) + 1;
  var want = targets(row);
  // Per targeted platform: 'earlier' (live before this attempt), 'now' (went live in this
  // attempt) or 'missing' (not live). id = the live post/media id, used only for the buttons.
  function side(want, earlierId, nowId) {
    if (!want) return null;
    if (earlierId) return { state: "earlier", id: earlierId };
    if (nowId) return { state: "now", id: nowId };
    return { state: "missing" };
  }
  var fb = side(want.fb, row.fb_post_id, result.fbPostId);
  var ig = side(want.ig, row.ig_post_id, result.igPostId);
  if (result.ok && result.status === "published") {
    return { key: row.id + ":published:" + attempt, kind: "published", row: row, attempt: attempt, fb: fb, ig: ig };
  }
  if (result.ok) return null; // 'scheduled' (Facebook will publish it later) or anything else non-final
  var maxAttempts = ctx.maxAttempts || 3;
  var retriesLeft = attempt < maxAttempts;
  if (ctx.autoRetry && retriesLeft) return null; // a middle auto-retry: stay quiet
  return {
    key: row.id + ":failed:" + attempt, kind: retriesLeft ? "failed_retry" : "failed_final", row: row,
    attempt: attempt, fb: fb, ig: ig, reason: friendlyReason(result.error)
  };
}

function planScheduledLiveNotification(row) {
  if (!row || !row.fb_post_id) return null;
  return { key: row.id + ":published:scheduled", kind: "published", row: row, fb: { state: "now", id: row.fb_post_id }, ig: null };
}

const PANEL_URL = "https://mr-polishes.com/admin.html";
const SEPARATOR = "━━━━━━━━━━";

// "DD.MM · HH:MM" in Israel time.
function formatIsraelTime(date) {
  var parts = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
  return parts.day + "." + parts.month + " · " + (parts.hour === "24" ? "00" : parts.hour) + ":" + parts.minute;
}

function platformLine(label, p, plan) {
  if (p.state === "earlier") return label + ": ✅ כבר פורסם קודם";
  if (p.state === "now") return label + ": ✅ פורסם";
  return label + ": ❌ לא פורסם" + (plan.kind === "failed_final" ? " אחרי " + plan.attempt + " ניסיונות" : "");
}

// The message: plain text (one item per line, no raw URLs) + inline URL buttons for the live posts
// (and the panel on a final failure). A link that can't be resolved simply gets no button.
async function buildMessage(plan, ctx) {
  ctx = ctx || {};
  var sides = [plan.fb, plan.ig].filter(Boolean);
  var anyLive = sides.some(function (p) { return p.state !== "missing"; });
  var header = plan.kind === "published" ? "✅ הפוסט פורסם בהצלחה"
    : anyLive ? "⚠️ הפוסט פורסם חלקית" : "❌ הפוסט לא פורסם במלואו";
  var lines = [header, "📝 " + cleanTitle(plan.row), SEPARATOR];
  if (plan.fb) lines.push(platformLine("📘 פייסבוק", plan.fb, plan));
  if (plan.ig) lines.push(platformLine("📸 אינסטגרם", plan.ig, plan));
  if (plan.kind === "published") {
    lines.push("🕐 " + formatIsraelTime(ctx.now || new Date()));
  } else {
    lines.push("💬 הסיבה: " + plan.reason);
    lines.push(plan.kind === "failed_retry" ? "🔄 מה הלאה: המערכת תנסה שוב אוטומטית" : "👈 מה לעשות: לבדוק בפאנל");
  }

  var buttons = [];
  if (plan.fb && plan.fb.state !== "missing") {
    var fbLink = plan.fb.url || (plan.fb.id ? facebookUrl(plan.fb.id, plan.row, ctx.pageId) : null);
    if (fbLink) buttons.push({ text: "📘 לפוסט בפייסבוק", url: fbLink });
  }
  if (plan.ig && plan.ig.state !== "missing") {
    var igLink = plan.ig.permalink || (plan.ig.id ? await instagramPermalink(plan.ig.id, ctx.token) : null);
    if (igLink) buttons.push({ text: "📸 לפוסט באינסטגרם", url: igLink });
  }
  if (plan.kind === "failed_final") buttons.push({ text: "🗂️ פתח בפאנל", url: PANEL_URL });

  return {
    text: lines.join("\n"),
    reply_markup: buttons.length ? { inline_keyboard: buttons.map(function (b) { return [b]; }) } : null
  };
}

// Sends one plan to every allowed chat. Resolves to the number of chats reached; never rejects.
async function deliver(plan, ctx) {
  try {
    if (!plan || !rememberKey(plan.key)) return 0;
    var cfg = telegramConfig();
    var chats = allowedChatIds();
    if (!cfg.botToken || !chats.length) {
      console.log("[publish-notify] skipped (bot not configured) row=" + plan.row.id + " kind=" + plan.kind);
      return 0;
    }
    var msg = await buildMessage(plan, ctx || {});
    var sent = 0;
    for (var i = 0; i < chats.length; i++) {
      try {
        var payload = { chat_id: chats[i], text: msg.text, disable_web_page_preview: true };
        if (msg.reply_markup) payload.reply_markup = msg.reply_markup;
        await tgCallTimed("sendMessage", payload, timeoutMs);
        sent++;
      } catch (err) {
        console.error("[publish-notify] send failed row=" + plan.row.id + " kind=" + plan.kind + ": " + err.message);
      }
    }
    if (sent) console.log("[publish-notify] sent row=" + plan.row.id + " kind=" + plan.kind + " chats=" + sent);
    return sent;
  } catch (err) {
    console.error("[publish-notify] failed row=" + (plan && plan.row && plan.row.id) + ": " + err.message);
    return 0;
  }
}

// Fire-and-forget: returns the delivery promise (tests await it; production callers ignore it).
function startDelivery(plan, ctx) {
  if (!plan) return Promise.resolve(0);
  var p = deliver(plan, ctx);
  try { waitUntil(p); } catch (_) { /* outside Vercel: the promise still runs */ }
  return p;
}

function notifyPublishResult(row, result, ctx) {
  try {
    return startDelivery(planPublishNotification(row, result, ctx), ctx);
  } catch (err) {
    console.error("[publish-notify] plan failed: " + err.message);
    return Promise.resolve(0);
  }
}

function notifyScheduledLive(row, ctx) {
  try {
    return startDelivery(planScheduledLiveNotification(row), ctx);
  } catch (err) {
    console.error("[publish-notify] plan failed: " + err.message);
    return Promise.resolve(0);
  }
}

module.exports = {
  notifyPublishResult, notifyScheduledLive, planPublishNotification, planScheduledLiveNotification,
  buildMessage, deliver, cleanTitle, friendlyReason, formatIsraelTime,
  _setTimeoutMs: function (ms) { timeoutMs = ms; },
  _resetDedupe: function () { sentKeys.clear(); }
};
