// Telegram notifications for the content pipeline: one short Hebrew message per publishOne()
// result (cron, GitHub trigger and the panel's real-time Approve all share publishOne), and one
// when a natively-scheduled Facebook post is confirmed live by checkScheduledStatus().
//
// Rules (owner spec, 2026-10-30):
//   - published            → "✅ פורסם: <title>" + one line per platform (link, or "כבר פורסם קודם")
//   - failed / partial     → "⚠️ <title>: פייסבוק ✔/✖, אינסטגרם ✔/✖ (<reason>)" + retry/final line,
//                            only on the FIRST failure of an approval and on the FINAL one
//                            (auto-retries in between stay silent)
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
  if (result.ok && result.status === "published") {
    return {
      key: row.id + ":published:" + attempt, kind: "published", row: row,
      fb: want.fb ? (row.fb_post_id ? { earlier: true } : (result.fbPostId ? { id: result.fbPostId } : null)) : null,
      ig: want.ig ? (row.ig_post_id ? { earlier: true } : (result.igPostId ? { id: result.igPostId } : null)) : null
    };
  }
  if (result.ok) return null; // 'scheduled' (Facebook will publish it later) or anything else non-final
  var maxAttempts = ctx.maxAttempts || 3;
  var retriesLeft = attempt < maxAttempts;
  if (ctx.autoRetry && retriesLeft) return null; // a middle auto-retry: stay quiet
  var fbDone = !!(result.fbPostId || row.fb_post_id);
  var igDone = !!(result.igPostId || row.ig_post_id);
  return {
    key: row.id + ":failed:" + attempt, kind: retriesLeft ? "failed_retry" : "failed_final", row: row,
    attempt: attempt, want: want, fbDone: fbDone, igDone: igDone, reason: friendlyReason(result.error)
  };
}

function planScheduledLiveNotification(row) {
  if (!row || !row.fb_post_id) return null;
  return { key: row.id + ":published:scheduled", kind: "published", row: row, fb: { id: row.fb_post_id }, ig: null };
}

async function buildText(plan, ctx) {
  var title = cleanTitle(plan.row);
  if (plan.kind === "published") {
    var lines = ["✅ פורסם: " + title];
    if (plan.fb) lines.push("פייסבוק: " + (plan.fb.earlier ? "כבר פורסם קודם" : plan.fb.url || facebookUrl(plan.fb.id, plan.row, ctx.pageId)));
    if (plan.ig) {
      if (plan.ig.earlier) lines.push("אינסטגרם: כבר פורסם קודם");
      else {
        var link = plan.ig.permalink || await instagramPermalink(plan.ig.id, ctx.token);
        lines.push("אינסטגרם: " + (link || "פורסם (הקישור לא זמין כרגע)"));
      }
    }
    return lines.join("\n");
  }
  var parts = [];
  if (plan.want.fb) parts.push("פייסבוק " + (plan.fbDone ? "✔" : "✖"));
  if (plan.want.ig) parts.push("אינסטגרם " + (plan.igDone ? "✔" : "✖"));
  var head = "⚠️ " + title + ": " + parts.join(", ") + " (" + plan.reason + ")";
  var tail = plan.kind === "failed_retry"
    ? "🔄 המערכת תנסה שוב אוטומטית"
    : "❌ לא פורסם אחרי " + plan.attempt + " ניסיונות — כדאי לבדוק בפאנל";
  return head + "\n" + tail;
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
    var text = await buildText(plan, ctx || {});
    var sent = 0;
    for (var i = 0; i < chats.length; i++) {
      try {
        await tgCallTimed("sendMessage", { chat_id: chats[i], text: text, disable_web_page_preview: true }, timeoutMs);
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
  buildText, deliver, cleanTitle, friendlyReason,
  _setTimeoutMs: function (ms) { timeoutMs = ms; },
  _resetDedupe: function () { sentKeys.clear(); }
};
