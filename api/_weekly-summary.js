// The weekly summary to Miri — Sunday 08:00 Israel time (media-projects command 7, D11). A helper, not
// a Vercel function: the publish cron (pg_cron every 10 min, GitHub as backup) calls maybeSend() on
// every run; it sends only when Israel local time (Asia/Jerusalem, DST-aware) is Sunday 08:00–08:09
// and weekly_reports shows this week wasn't sent yet.
//
// Once per week: weekly_reports.week_start (the Sunday's date) is the primary key — inserting it with
// status 'sending' is the claim; only the caller whose insert went in sends. Telegram failed →
// 'failed', and a later run in the same window may retry it; a claim stuck in 'sending' > 5 min too.
// Content: COUNTS ONLY (no client names, phones or comment text). The Meta token's data-access expiry
// is read with debug_token every time; ≤ 14 days left → a warning line with what to do.
// To the production bot's allowed chats (Miri, D11); previews use the TEST bot. Plain text, one item per line.
"use strict";

const BS = require("../shared/burst-schedule.js");
const { telegramConfig, allowedChatIds, tgCallTimed } = require("./_telegram.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const GRAPH = "https://graph.facebook.com/v20.0/";
const SEPARATOR = "━━━━━━━━━━";
const PANEL_URL = "https://mr-polishes.com/admin.html";
const TOKEN_WARN_DAYS = 14;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
var timeoutMs = 10000;

function svc(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(pathQs, init) {
  init = Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init || {});
  init.headers = svc(init.headers);
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + pathQs, init);
  var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: body, headers: res.headers };
}
// An exact row count (Content-Range "0-0/N" or "*/N"), selecting nothing personal.
async function count(table, filter) {
  var r = await rest(table + "?select=id&limit=1" + (filter ? "&" + filter : ""), { headers: { Prefer: "count=exact" } });
  if (!r.ok) throw new Error("count " + table + " failed: " + r.status);
  var m = String(r.headers.get("content-range") || "").match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}
function iso(d) { return encodeURIComponent(new Date(d).toISOString()); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }

// Israel wall time → { dow (0 = Sunday), h, min, dateKey 'YYYY-MM-DD', dd.mm }
function israelNow(now) {
  var q = BS.israelParts(now);
  var dow = new Date(Date.UTC(q.y, q.m - 1, q.d)).getUTCDay();
  return { dow: dow, h: q.h, min: q.min, dateKey: q.y + "-" + pad2(q.m) + "-" + pad2(q.d), q: q };
}
function inWindow(now) { var t = israelNow(now); return t.dow === 0 && t.h === 8 && t.min <= 9; }
function ddmm(d) { var q = BS.israelParts(d); return pad2(q.d) + "." + pad2(q.m); }
function ddmmyyyy(d) { var q = BS.israelParts(d); return pad2(q.d) + "." + pad2(q.m) + "." + q.y; }

// ---------------------------------------------------------------------------
// the numbers (counts only)
// ---------------------------------------------------------------------------
async function collect(now) {
  var since = new Date(now.getTime() - 7 * DAY_MS), until = new Date(now.getTime() + 7 * DAY_MS);
  var pubSel = "select=platform,fb_post_id,ig_post_id&published_at=gte." + iso(since);
  var pubRows = [];
  for (var t of ["content_queue", "content_queue_archive"]) {
    var r = await rest(t + "?" + pubSel);
    if (!r.ok) throw new Error(t + " failed: " + r.status);
    pubRows = pubRows.concat(r.body || []);
  }
  return {
    leads: await count("leads", "created_at=gte." + iso(since)),
    quotes: await count("quotes", "created_at=gte." + iso(since)),
    projects: await count("projects", "status=eq.published&published_at=gte." + iso(since)),
    facebook: pubRows.filter(function (r) { return !!r.fb_post_id; }).length,
    instagram: pubRows.filter(function (r) { return !!r.ig_post_id; }).length,
    failed: await count("content_queue", "status=eq.failed&last_publish_attempt_at=gte." + iso(since)),
    upcoming: await count("content_queue", "status=in.(approved,scheduled)&scheduled_for=gt." + iso(now) + "&scheduled_for=lte." + iso(until)),
    comments: await count("social_comment_seen", "commented_at=gte." + iso(since))
  };
}

// debug_token on the Page token → { ok, daysLeft, expiresAt } | { ok: false }
async function tokenCheck(token, now) {
  if (!token) return { ok: false };
  try {
    var res = await fetch(GRAPH + "debug_token?input_token=" + encodeURIComponent(token) + "&access_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(timeoutMs) });
    var j = await res.json();
    var d = j && j.data;
    if (!d || d.is_valid !== true) return { ok: false, invalid: !!d };
    var exp = d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000) : null;
    if (!exp) return { ok: true, daysLeft: null };
    return { ok: true, expiresAt: exp, daysLeft: Math.ceil((exp.getTime() - now.getTime()) / DAY_MS) };
  } catch (_) {
    return { ok: false };
  }
}

// Pure: the message text.
function buildMessage(n, tok, now) {
  var from = new Date(now.getTime() - 7 * DAY_MS);
  var lines = [
    "בוקר טוב! ☀️",
    "📊 הסיכום השבועי · " + ddmm(from) + "–" + ddmm(now),
    SEPARATOR,
    "👥 פניות חדשות מהאתר: " + n.leads,
    "🧾 הצעות מחיר שנוצרו: " + n.quotes,
    "🖼️ פרויקטים חדשים באתר: " + n.projects,
    "📘 פוסטים שפורסמו בפייסבוק: " + n.facebook,
    "📸 פוסטים שפורסמו באינסטגרם: " + n.instagram,
    "❌ פוסטים שלא פורסמו: " + n.failed,
    "🗓️ פוסטים מתוזמנים לשבוע הקרוב: " + n.upcoming,
    "💬 תגובות חדשות ברשתות: " + n.comments,
    SEPARATOR
  ];
  if (!tok || !tok.ok) {
    lines.push(tok && tok.invalid
      ? "⚠️ החיבור למטא לא תקין — הפרסום לרשתות עלול להיעצר. מה לעשות: לחדש את ההרשאה (Graph API Explorer) ולעדכן את META_PAGE_ACCESS_TOKEN ב-Vercel."
      : "⚠️ לא הצלחתי לבדוק השבוע את תוקף ההרשאה של מטא. כדאי לבדוק בפאנל שהפרסום לרשתות תקין.");
  } else if (tok.daysLeft != null && tok.daysLeft <= TOKEN_WARN_DAYS) {
    lines.push("⚠️ הרשאת הגישה של מטא תפוג בעוד " + Math.max(0, tok.daysLeft) + " ימים (" + ddmmyyyy(tok.expiresAt) + ").");
    lines.push("👈 מה לעשות: לחדש את ההרשאה ב-Graph API Explorer ולעדכן את META_PAGE_ACCESS_TOKEN ב-Vercel — אותם צעדים כמו בחידוש הקודם.");
  } else if (tok.expiresAt) {
    lines.push("🔐 הרשאת מטא: בתוקף עד " + ddmmyyyy(tok.expiresAt));
  }
  lines.push("שבוע טוב ומוצלח! 🙂");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// claim + send
// ---------------------------------------------------------------------------
async function claim(weekStart) {
  var nowIso = new Date().toISOString();
  var ins = await rest("weekly_reports?on_conflict=week_start", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ week_start: weekStart, status: "sending", claimed_at: nowIso, attempts: 1, sent_at: nowIso })
  });
  if (!ins.ok) throw new Error("weekly_reports claim failed: " + ins.status);
  if (ins.body && ins.body.length) return { claimed: true, attempts: 1 };
  var cur = await rest("weekly_reports?week_start=eq." + weekStart + "&select=status,claimed_at,attempts");
  var row = cur.body && cur.body[0];
  if (!row) return { claimed: false };
  if (row.status === "sent") return { claimed: false, already: true };
  var stale = row.status === "sending" && Date.now() - new Date(row.claimed_at).getTime() > STALE_CLAIM_MS;
  if (row.status !== "failed" && !stale) return { claimed: false };
  var attempts = (row.attempts || 0) + 1;
  var re = await rest("weekly_reports?week_start=eq." + weekStart + "&status=eq." + row.status + "&claimed_at=eq." + encodeURIComponent(row.claimed_at), {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "sending", claimed_at: nowIso, attempts: attempts, error: null })
  });
  return { claimed: !!(re.ok && re.body && re.body.length), attempts: attempts };
}

async function deliver(text) {
  var cfg = telegramConfig(), chats = allowedChatIds();
  if (!cfg.botToken || !chats.length) return 0;
  var sent = 0;
  for (var i = 0; i < chats.length; i++) {
    try {
      await tgCallTimed("sendMessage", { chat_id: chats[i], text: text, disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[{ text: "🗂️ פתח בפאנל", url: PANEL_URL }]] } }, 8000);
      sent++;
    } catch (err) { console.error("[weekly-summary] send failed: " + err.message); }
  }
  return sent;
}

// opts: { token, now?, force? } — force skips the time window (preview test hook only).
async function maybeSend(opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  if (!opts.force && !inWindow(now)) return { skipped: "window" };
  var weekStart = opts.weekStart || israelNow(now).dateKey;
  var c = await claim(weekStart);
  if (!c.claimed) return { skipped: c.already ? "already_sent" : "claimed_elsewhere" };
  var text, error = null, sent = 0;
  try {
    var numbers = await collect(now);
    var tok = await tokenCheck(opts.token, now);
    text = buildMessage(numbers, tok, now);
    sent = await deliver(text);
    if (!sent) error = "telegram";
  } catch (err) {
    error = "collect";
    console.error("[weekly-summary] failed: " + err.message);
  }
  await rest("weekly_reports?week_start=eq." + weekStart, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(error ? { status: "failed", error: error } : { status: "sent", sent_at: new Date().toISOString(), error: null })
  });
  return error ? { error: error, week: weekStart } : { sent: sent, week: weekStart };
}

module.exports = { maybeSend, inWindow, israelNow, buildMessage, collect, tokenCheck, claim, TOKEN_WARN_DAYS,
  _setTimeoutMs: function (ms) { timeoutMs = ms; } };
