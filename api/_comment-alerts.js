// Comment alerts to Miri — Facebook + Instagram (media-projects command 7, D11). A helper, not a Vercel
// function: the publish cron calls maybeRun() every run; it polls Meta at most every 30 minutes.
//
// What it reads: the Page's posts and the Instagram media of the last 14 days, and their comments
// (replies included). The Page's / account's own comments are skipped. New comment ids are recorded
// in social_comment_seen (ids only — no author, no text); the insert is the dedupe: only comments
// THIS run inserted are alerted, so two overlapping runs never alert twice. The very first run only
// records what already exists (no flood of old comments).
// The alert: platform, a short post title, the first 120 characters of the comment, and an inline URL
// button "פתיחת התגובה". More than 5 new comments in one run → ONE grouped message.
// Comment text goes from Meta straight to Telegram: never stored, never logged (logs: counts only).
"use strict";

const { telegramConfig, allowedChatIds, tgCallTimed } = require("./_telegram.js");
const notify = require("./_publish-notify.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const GRAPH = "https://graph.facebook.com/v20.0/";
const STATE_KEY = "comment_alerts";
const EVERY_MS = 30 * 60 * 1000;
const WINDOW_DAYS = 14;
const GROUP_OVER = 5;
const GROUP_MAX_LISTED = 8;
const TEXT_MAX = 120, TITLE_MAX = 60;
const SEPARATOR = "━━━━━━━━━━";
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
  if (!res.ok) throw new Error("Supabase " + (init.method || "GET") + " " + pathQs.split("?")[0] + " failed: " + res.status);
  return body;
}
async function graph(path, query, token) {
  var res = await fetch(GRAPH + path + "?" + query + "&access_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(timeoutMs) });
  var j = await res.json().catch(function () { return null; });
  if (!j || j.error) throw new Error("Meta read failed (" + path.split("/").pop() + "): " + ((j && j.error && j.error.code) || res.status));
  return j;
}

function clean(s, max) {
  var t = String(s || "").replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}
function firstLine(s) { return String(s || "").split(/\n/)[0]; }

// ---------------------------------------------------------------------------
// Meta reads
// ---------------------------------------------------------------------------
async function facebookComments(ctx, sinceSec) {
  var out = [];
  var posts = await graph(ctx.pageId + "/posts", "fields=id,message,created_time&since=" + sinceSec + "&limit=50", ctx.token);
  for (var i = 0; i < (posts.data || []).length; i++) {
    var p = posts.data[i];
    var c = await graph(p.id + "/comments", "fields=" + encodeURIComponent("id,message,from{id},created_time,permalink_url") + "&filter=stream&limit=100", ctx.token);
    (c.data || []).forEach(function (x) {
      if (!x.message || (x.from && x.from.id === ctx.pageId)) return;   // the Page's own replies
      out.push({ platform: "facebook", comment_id: x.id, post_id: p.id, commented_at: x.created_time, text: x.message,
        post_text: p.message, url: /^https:\/\//.test(x.permalink_url || "") ? x.permalink_url : "https://www.facebook.com/" + p.id });
    });
  }
  return out;
}

async function instagramComments(ctx, sinceSec) {
  var out = [];
  var me = await graph(ctx.igUserId, "fields=username", ctx.token);
  var media = await graph(ctx.igUserId + "/media", "fields=" + encodeURIComponent("id,caption,timestamp,permalink,comments_count") + "&limit=50", ctx.token);
  var list = (media.data || []).filter(function (m) { return new Date(m.timestamp).getTime() / 1000 >= sinceSec && m.comments_count > 0; });
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    var c = await graph(m.id + "/comments", "fields=" + encodeURIComponent("id,text,username,timestamp,replies{id,text,username,timestamp}") + "&limit=50", ctx.token);
    var all = [];
    (c.data || []).forEach(function (x) { all.push(x); ((x.replies && x.replies.data) || []).forEach(function (r) { all.push(r); }); });
    all.forEach(function (x) {
      if (!x.text || (me.username && x.username === me.username)) return;   // the account's own comments
      out.push({ platform: "instagram", comment_id: x.id, post_id: m.id, commented_at: x.timestamp, text: x.text,
        post_text: m.caption, url: /^https:\/\/(www\.)?instagram\.com\//.test(m.permalink || "") ? m.permalink : "https://www.instagram.com/" });
    });
  }
  return out;
}

// Our own post titles (content_queue / archive) for the alert; the post's first line otherwise.
async function titlesFor(comments) {
  var fb = {}, ig = {};
  comments.forEach(function (c) { (c.platform === "facebook" ? fb : ig)[c.post_id] = true; });
  var map = {};
  async function look(col, ids) {
    if (!ids.length) return;
    var q = col + "=in.(" + ids.map(function (x) { return '"' + String(x).replace(/"/g, "") + '"'; }).join(",") + ")&select=title," + col;
    for (var t of ["content_queue", "content_queue_archive"]) {
      var rows = await rest(t + "?" + q).catch(function () { return []; });
      (rows || []).forEach(function (r) { if (r.title) map[r[col]] = r.title; });
    }
  }
  await look("fb_post_id", Object.keys(fb));
  await look("ig_post_id", Object.keys(ig));
  return map;
}

// ---------------------------------------------------------------------------
// messages (pure)
// ---------------------------------------------------------------------------
var PLATFORM_HE = { facebook: "📘 פייסבוק", instagram: "📸 אינסטגרם" };
function postTitle(c, titles) { return clean(titles[c.post_id] || firstLine(c.post_text) || "פוסט", TITLE_MAX); }

function buildMessages(comments, titles) {
  if (!comments.length) return [];
  if (comments.length <= GROUP_OVER) {
    return comments.map(function (c) {
      return {
        text: ["💬 תגובה חדשה · " + PLATFORM_HE[c.platform], "📝 " + postTitle(c, titles), SEPARATOR, "„" + clean(c.text, TEXT_MAX) + "”",
          "🕐 " + notify.formatIsraelTime(new Date(c.commented_at || Date.now()))].join("\n"),
        reply_markup: { inline_keyboard: [[{ text: "פתיחת התגובה", url: c.url }]] }
      };
    });
  }
  var listed = comments.slice(0, GROUP_MAX_LISTED);
  var lines = ["💬 " + comments.length + " תגובות חדשות ברשתות", SEPARATOR];
  listed.forEach(function (c, i) {
    lines.push((i + 1) + ". " + PLATFORM_HE[c.platform] + " · " + postTitle(c, titles));
    lines.push("„" + clean(c.text, TEXT_MAX) + "”");
  });
  if (comments.length > listed.length) lines.push("ועוד " + (comments.length - listed.length) + " תגובות — אפשר לראות את כולן באפליקציות.");
  return [{
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: listed.map(function (c, i) { return [{ text: "פתיחת התגובה " + (i + 1), url: c.url }]; }) }
  }];
}

async function deliver(messages) {
  var cfg = telegramConfig(), chats = allowedChatIds();
  if (!cfg.botToken || !chats.length) return 0;
  var sent = 0;
  for (var m = 0; m < messages.length; m++) {
    for (var i = 0; i < chats.length; i++) {
      try {
        await tgCallTimed("sendMessage", Object.assign({ chat_id: chats[i], disable_web_page_preview: true }, messages[m]), 8000);
        sent++;
      } catch (err) { console.error("[comment-alerts] send failed: " + err.message); }
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
// One run at a time, at most every 30 min: a conditional bump of scheduler_state.updated_at.
async function claimRun(now) {
  var rows = await rest("scheduler_state?key=eq." + STATE_KEY + "&select=value,updated_at");
  var st = rows && rows[0];
  if (!st) {
    var ins = await rest("scheduler_state?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ key: STATE_KEY, value: { baseline_done: false }, updated_at: now.toISOString() }) });
    return ins && ins.length ? { value: { baseline_done: false } } : null;
  }
  if (now.getTime() - new Date(st.updated_at).getTime() < EVERY_MS) return null;
  var up = await rest("scheduler_state?key=eq." + STATE_KEY + "&updated_at=eq." + encodeURIComponent(st.updated_at), {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ updated_at: now.toISOString() }) });
  return up && up.length ? { value: st.value || {} } : null;
}

// opts: { token, pageId, igUserId, now?, force? } — force skips the 30-minute gate (preview test hook).
async function maybeRun(opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  if (!opts.token || !opts.pageId) return { skipped: "config" };
  var run = opts.force ? { value: opts.state || { baseline_done: true } } : await claimRun(now);
  if (!run) return { skipped: "recent" };
  var sinceSec = Math.floor((now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000) / 1000);
  var found = [], errors = 0;
  try { found = found.concat(await facebookComments(opts, sinceSec)); } catch (err) { errors++; console.log("[comment-alerts] facebook: " + err.message); }
  if (opts.igUserId) { try { found = found.concat(await instagramComments(opts, sinceSec)); } catch (err) { errors++; console.log("[comment-alerts] instagram: " + err.message); } }
  found = found.filter(function (c) { return !c.commented_at || new Date(c.commented_at).getTime() / 1000 >= sinceSec; });

  // Record them; the rows that actually went in are the new ones (ignore-duplicates = dedupe).
  var fresh = [];
  for (var i = 0; i < found.length; i += 100) {
    var chunk = found.slice(i, i + 100).map(function (c) { return { platform: c.platform, comment_id: c.comment_id, post_id: c.post_id, commented_at: c.commented_at || null }; });
    var ins = await rest("social_comment_seen?on_conflict=platform,comment_id", { method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(chunk) });
    (ins || []).forEach(function (r) { fresh.push(r.platform + ":" + r.comment_id); });
  }
  var isNew = {}; fresh.forEach(function (k) { isNew[k] = true; });
  var newOnes = found.filter(function (c) { return isNew[c.platform + ":" + c.comment_id]; })
    .sort(function (a, b) { return new Date(a.commented_at) - new Date(b.commented_at); });

  if (!run.value.baseline_done) {   // the first run: remember what exists, alert nothing
    await rest("scheduler_state?key=eq." + STATE_KEY, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ value: { baseline_done: true, baseline_at: now.toISOString(), baseline_count: newOnes.length } }) });
    return { baseline: newOnes.length, errors: errors };
  }
  if (!newOnes.length) return { found: found.length, alerted: 0, errors: errors };
  var titles = await titlesFor(newOnes).catch(function () { return {}; });
  var msgs = buildMessages(newOnes, titles);
  var sent = await deliver(msgs);
  if (sent) {
    var byPlatform = {};
    newOnes.forEach(function (c) { (byPlatform[c.platform] = byPlatform[c.platform] || []).push(c.comment_id); });
    for (var p in byPlatform) {
      await rest("social_comment_seen?platform=eq." + p + "&comment_id=in.(" + byPlatform[p].map(function (x) { return '"' + String(x).replace(/"/g, "") + '"'; }).join(",") + ")", {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ notified_at: now.toISOString() }) }).catch(function () {});
    }
  }
  console.log("[comment-alerts] new=" + newOnes.length + " messages=" + msgs.length + " delivered=" + sent);
  return { found: found.length, alerted: newOnes.length, messages: msgs.length, delivered: sent, errors: errors };
}

module.exports = { maybeRun, buildMessages, facebookComments, instagramComments, claimRun, GROUP_OVER, TEXT_MAX,
  _setTimeoutMs: function (ms) { timeoutMs = ms; } };
