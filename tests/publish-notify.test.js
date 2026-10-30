// Publish notifications (api/_publish-notify.js wired into publish-scheduled-content.js): success,
// partial, retry, final failure, Telegram down/hanging, dedupe, the cron path and the preview
// sample hook. EVERY outbound call is mocked (Graph API, Supabase REST, Telegram). Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
let bg = [];
require.cache[require.resolve(REPO + "/node_modules/@vercel/functions")] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } } };

const PROD = { TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_WEBHOOK_SECRET: "prod-secret-fake", TELEGRAM_ALLOWED_CHATS: "500, 501" };
const TEST = { TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake", TELEGRAM_TEST_ALLOWED_CHATS: "600" };
const ALL_KEYS = Object.keys(PROD).concat(Object.keys(TEST), ["VERCEL_ENV", "SUPABASE_SERVICE_ROLE_KEY", "INTERNAL_API_SECRET", "CRON_SECRET",
  "META_PAGE_ACCESS_TOKEN", "META_PAGE_ID", "META_IG_USER_ID"]);
const CTX = { token: "meta-token-fake", pageId: "PAGE1", igUserId: "IGU1", triggerSource: "cron" };

let calls, patches, tgMode, igCreateError, fbError, claimWins, scheduledFlipWins, restRows;
function reset() {
  calls = []; patches = []; tgMode = "ok"; igCreateError = null; fbError = null; claimWins = true; scheduledFlipWins = true; restRows = {};
}
reset();

function json(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

global.fetch = async function (url, init) {
  init = init || {};
  url = String(url);
  const method = init.method || "GET";
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (tgMode === "down") throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    if (tgMode === "hang") {
      return new Promise((_, reject) => {
        if (init.signal) init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      });
    }
    if (tgMode === "error") return json(400, { ok: false, description: "Bad Request: chat not found" });
    return json(200, { ok: true, result: { message_id: 1 } });
  }
  if (url.startsWith("https://graph.facebook.com/")) {
    const p = url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "").split("?")[0];
    calls.push({ kind: "graph", method, path: p, qs: url.split("?")[1] || "" });
    if (method === "POST" && p === "PAGE1/photos") return json(200, fbError ? { error: fbError } : { id: "PH1", post_id: "PAGE1_111" });
    if (method === "POST" && p === "PAGE1/videos") return json(200, fbError ? { error: fbError } : { id: "999" });
    if (method === "POST" && p === "IGU1/media") return json(200, igCreateError ? { error: igCreateError } : { id: "CONT1" });
    if (method === "POST" && p === "IGU1/media_publish") return json(200, { id: "IGMEDIA1" });
    if (method === "GET" && /fields=status_code/.test(url)) return json(200, { status_code: "FINISHED" });
    if (method === "GET" && /fields=permalink/.test(url)) return json(200, { permalink: "https://www.instagram.com/p/FAKE123/" });
    if (method === "GET" && /fields=is_published/.test(url)) return json(200, { is_published: true });
    throw new Error("unmocked graph: " + method + " " + p);
  }
  if ((m = url.match(/\/rest\/v1\/content_queue(?:\?(.*))?$/))) {
    const qs = decodeURIComponent(m[1] || "");
    calls.push({ kind: "rest", method, qs });
    if (method === "PATCH") {
      patches.push({ qs, body });
      if (/status=eq\.approved/.test(qs) && /last_publish_attempt_at/.test(qs)) return json(200, claimWins ? [{ id: "x" }] : []);
      if (/status=eq\.failed/.test(qs)) return json(200, [{ id: "x" }]);
      if (/status=eq\.scheduled/.test(qs)) { const w = scheduledFlipWins; scheduledFlipWins = false; return json(200, w ? [{ id: "x" }] : []); }
      return json(204, null);
    }
    if (method === "GET") {
      if (/status=eq\.approved/.test(qs)) return json(200, restRows.approved || []);
      if (/status=eq\.failed/.test(qs)) return json(200, restRows.failed || []);
      if (/status=eq\.scheduled/.test(qs)) return json(200, restRows.scheduled || []);
      const idm = qs.match(/id=eq\.([^&]+)/);
      if (idm) return json(200, (restRows.byId && restRows.byId[idm[1]]) ? [restRows.byId[idm[1]]] : []);
      return json(200, []);
    }
  }
  throw new Error("unmocked fetch: " + url);
};

function setEnv(vars) {
  ALL_KEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "svc-fake" }, vars);
}

let logs = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));

const core = require(REPO + "/api/publish-scheduled-content.js");
const notify = require(REPO + "/api/_publish-notify.js");

let passed = 0, total = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; origLog("PASS " + name); } else origLog("FAIL " + name + (detail ? "  -- " + detail : ""));
}
async function drain() { const p = bg; bg = []; await Promise.all(p); }
const tgSends = () => calls.filter(c => c.kind === "tg" && c.method === "sendMessage");
const past = new Date(Date.now() - 60000).toISOString();
const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
let rid = 0;
function row(extra) {
  return Object.assign({ id: "row-" + (++rid), title: "רילס: פרויקט בזלת שחורה", caption: "c", platform: "both", media_type: "image",
    content_category: "post", scheduled_for: past, publish_attempts: 0, fb_post_id: null, ig_post_id: null }, extra);
}

(async function main() {
  // 1. Full success, both platforms, production bot → every allowed chat
  setEnv(PROD); Object.assign(process.env, { VERCEL_ENV: "production" }); reset(); notify._resetDedupe();
  let r = row();
  let res = await core.publishOne(r, CTX);
  await drain();
  let s = tgSends();
  check("success: publishOne ok + status published", res.ok && res.status === "published");
  check("success: one message per allowed production chat (500, 501), production token", s.length === 2 && s.every(x => x.token === "111:PRODFAKE") &&
    s.map(x => String(x.body.chat_id)).join(",") === "500,501", JSON.stringify(s.map(x => [x.token, x.body.chat_id])));
  check("success: exact text with FB post URL + IG permalink", s[0] && s[0].body.text ===
    "✅ פורסם: רילס: פרויקט בזלת שחורה\nפייסבוק: https://www.facebook.com/PAGE1_111\nאינסטגרם: https://www.instagram.com/p/FAKE123/", s[0] && s[0].body.text);
  check("success: plain text (no parse_mode), link previews off", s[0] && !("parse_mode" in s[0].body) && s[0].body.disable_web_page_preview === true);
  check("success: permalink fetched by GET on the IG media id", calls.some(c => c.kind === "graph" && c.method === "GET" && c.path === "IGMEDIA1" && /fields=permalink/.test(c.qs)));

  // 2. Facebook already posted earlier → only Instagram runs, message says "כבר פורסם קודם"
  setEnv(TEST); reset(); notify._resetDedupe();
  r = row({ fb_post_id: "PAGE1_777", publish_attempts: 1 });
  res = await core.publishOne(r, CTX);
  await drain(); s = tgSends();
  check("IG-only rerun: no Facebook publish call at all", !calls.some(c => c.kind === "graph" && c.method === "POST" && /^PAGE1\//.test(c.path)));
  check("IG-only rerun: test bot (preview/local) to the test chat", s.length === 1 && s[0].token === "222:TESTFAKE" && String(s[0].body.chat_id) === "600");
  check("IG-only rerun: FB line 'כבר פורסם קודם' + IG link", s[0] && s[0].body.text ===
    "✅ פורסם: רילס: פרויקט בזלת שחורה\nפייסבוק: כבר פורסם קודם\nאינסטגרם: https://www.instagram.com/p/FAKE123/", s[0] && s[0].body.text);

  // 3. Reel (video id without "_") → /videos URL
  reset(); notify._resetDedupe();
  r = row({ media_type: "reel", content_category: "reel", platform: "facebook" });
  await core.publishOne(r, CTX); await drain(); s = tgSends();
  check("reel on Facebook: video URL under the Page", s[0] && s[0].body.text.endsWith("פייסבוק: https://www.facebook.com/PAGE1/videos/999") && !/אינסטגרם/.test(s[0].body.text), s[0] && s[0].body.text);

  // 4. Partial, first failure → ⚠️ + retry line
  reset(); notify._resetDedupe();
  igCreateError = { code: 4, message: "Application request limit reached" };
  r = row();
  res = await core.publishOne(r, CTX); await drain(); s = tgSends();
  check("partial: publishOne reports failure and keeps the FB id", !res.ok && res.fbPostId === "PAGE1_111");
  check("partial (first failure): ⚠️ FB ✔ IG ✖ + friendly reason + retry line", s.length === 1 && s[0].body.text ===
    "⚠️ רילס: פרויקט בזלת שחורה: פייסבוק ✔, אינסטגרם ✖ (מטא הגבילה זמנית את קצב הפרסום)\n🔄 המערכת תנסה שוב אוטומטית", s[0] && s[0].body.text);
  check("partial: raw Meta error not in the message", s[0] && !/Application request limit/.test(s[0].body.text));

  // 5. Middle auto-retry failure → silent
  reset(); notify._resetDedupe();
  igCreateError = { code: 4, message: "Application request limit reached" };
  r = row({ fb_post_id: "PAGE1_777", publish_attempts: 1 });
  await core.publishOne(r, Object.assign({}, CTX, { autoRetry: true })); await drain();
  check("auto-retry attempt 2 fails: no message", tgSends().length === 0);

  // 6. Final failure (attempt 3 via auto-retry) → ❌ line
  reset(); notify._resetDedupe();
  igCreateError = { code: 4, message: "Application request limit reached" };
  r = row({ fb_post_id: "PAGE1_777", publish_attempts: 2 });
  await core.publishOne(r, Object.assign({}, CTX, { autoRetry: true })); await drain(); s = tgSends();
  check("final failure: ❌ after 3 attempts, FB ✔ (earlier), IG ✖", s.length === 1 && s[0].body.text ===
    "⚠️ רילס: פרויקט בזלת שחורה: פייסבוק ✔, אינסטגרם ✖ (מטא הגבילה זמנית את קצב הפרסום)\n❌ לא פורסם אחרי 3 ניסיונות — כדאי לבדוק בפאנל", s[0] && s[0].body.text);

  // 7. Scheduled approval of one of the 19 rows (publish_attempts already 1) failing on its slot → first failure of this approval
  reset(); notify._resetDedupe();
  fbError = { code: 368, message: "אנו מגבילים את התדירות שבה אפשר לפרסם" };
  r = row({ media_type: "reel", content_category: "reel", publish_attempts: 1 });
  await core.publishOne(r, CTX); await drain(); s = tgSends();
  check("scheduled run fails (attempt 2, not an auto-retry): notified, both ✖, retry line", s.length === 1 &&
    s[0].body.text === "⚠️ רילס: פרויקט בזלת שחורה: פייסבוק ✖, אינסטגרם ✖ (מטא הגבילה זמנית את קצב הפרסום)\n🔄 המערכת תנסה שוב אוטומטית", s[0] && s[0].body.text);

  // 8. Deferred (future + Instagram), natively scheduled (future, Facebook only), skipped (claim lost) → silent
  reset(); notify._resetDedupe();
  res = await core.publishOne(row({ scheduled_for: future }), CTX); await drain();
  check("deferred (future IG): no message, no Meta call", res.deferred && tgSends().length === 0 && !calls.some(c => c.kind === "graph"));
  reset(); notify._resetDedupe();
  res = await core.publishOne(row({ scheduled_for: future, platform: "facebook" }), CTX); await drain();
  check("natively scheduled on Facebook: no message yet", res.ok && res.status === "scheduled" && tgSends().length === 0);
  reset(); notify._resetDedupe(); claimWins = false;
  res = await core.publishOne(row(), CTX); await drain();
  check("claim lost (another publisher has it): no message, no Meta call", res.skipped && tgSends().length === 0 && !calls.some(c => c.kind === "graph"));

  // 9. Scheduled post confirmed live → ✅ once, even when two checkers race
  reset(); notify._resetDedupe();
  r = row({ status: "scheduled", platform: "facebook", fb_post_id: "PAGE1_555" });
  const c1 = await core.checkScheduledStatus(r, CTX);
  const c2 = await core.checkScheduledStatus(r, CTX);
  await drain(); s = tgSends();
  check("scheduled → live: both checks report nowPublished", c1.nowPublished && c2.nowPublished);
  check("scheduled → live: flip is conditional on status=scheduled", patches.filter(p => /status=eq\.scheduled/.test(p.qs)).length === 2);
  check("scheduled → live: exactly one ✅ (only the matching PATCH notifies)", s.length === 1 &&
    s[0].body.text === "✅ פורסם: רילס: פרויקט בזלת שחורה\nפייסבוק: https://www.facebook.com/PAGE1_555", s[0] && s[0].body.text);

  // 10. Dedupe of the same (row, outcome, attempt)
  reset(); notify._resetDedupe();
  r = row();
  const result = { id: r.id, ok: true, status: "published", fbPostId: "PAGE1_1", igPostId: "IGMEDIA1" };
  await notify.notifyPublishResult(r, result, CTX);
  await notify.notifyPublishResult(r, result, CTX);
  await drain();
  check("dedupe: same row + outcome + attempt → one message", tgSends().length === 1);
  await notify.notifyPublishResult(Object.assign({}, r, { publish_attempts: 1 }), result, CTX); await drain();
  check("dedupe: a different attempt number is a new message", tgSends().length === 2);

  // 11. Telegram down / erroring / hanging never affects publishing
  reset(); notify._resetDedupe(); tgMode = "down";
  res = await core.publishOne(row(), CTX);
  const n = await Promise.all(bg).then(v => v); bg = [];
  check("Telegram down: publish still ok and recorded as published", res.ok && res.status === "published" &&
    patches.some(p => p.body && p.body.status === "published"));
  check("Telegram down: notification resolves 0, nothing thrown", n.length === 1 && n[0] === 0);
  check("Telegram down: logged without the token", logs.some(l => /\[publish-notify\] send failed/.test(l)) && !logs.some(l => /TESTFAKE|PRODFAKE|meta-token-fake/.test(l)));
  reset(); notify._resetDedupe(); tgMode = "error";
  res = await core.publishOne(row(), CTX); await drain();
  check("Telegram API error (ok:false): publish still ok", res.ok && res.status === "published");
  reset(); notify._resetDedupe(); tgMode = "hang"; notify._setTimeoutMs(60);
  // AbortSignal.timeout's timer is unref'd; keep this process alive while the send hangs (on
  // Vercel, waitUntil is what keeps the function alive).
  const keepAlive = setInterval(() => {}, 20);
  const t0 = Date.now();
  res = await core.publishOne(row(), CTX);
  const tPublish = Date.now() - t0;
  await drain();
  const tAll = Date.now() - t0;
  clearInterval(keepAlive);
  check("Telegram hanging: publishOne returns without waiting for it", res.ok && tPublish < 50, tPublish + "ms");
  check("Telegram hanging: the send is abandoned at the timeout", tAll >= 55 && tAll < 2000, tAll + "ms");
  notify._setTimeoutMs(8000);

  // 12. Title cleaning
  reset(); notify._resetDedupe();
  const long = "‫כותרת\u0007 ארוכה " + "מאוד ".repeat(40);
  await notify.notifyPublishResult(row({ title: long, platform: "facebook" }), { ok: true, status: "published", fbPostId: "PAGE1_2" }, CTX); await drain();
  s = tgSends();
  const firstLine = s[0] ? s[0].body.text.split("\n")[0].replace("✅ פורסם: ", "") : "";
  check("title: control/bidi chars removed, cut to 80 with …", firstLine.length === 80 && firstLine.endsWith("…") && !/[\u0000-\u001f‫]/.test(firstLine), firstLine.length + "");
  check("title: falls back to the caption, then a placeholder", notify.cleanTitle({ title: "", caption: "כיתוב" }) === "כיתוב" && notify.cleanTitle({}) === "פוסט ללא כותרת");

  // 13. Bot not configured → skipped quietly
  setEnv({}); reset(); notify._resetDedupe();
  res = await core.publishOne(row(), CTX); await drain();
  check("no bot token: publish ok, no Telegram call", res.ok && tgSends().length === 0 && logs.some(l => /skipped \(bot not configured\)/.test(l)));

  // 14. Story/media_type guard failure → first-failure message
  setEnv(TEST); reset(); notify._resetDedupe();
  await core.publishOne(row({ content_category: "story", media_type: "image", platform: "instagram" }), CTX); await drain(); s = tgSends();
  check("story guard failure: ⚠️ IG ✖ with its reason", s.length === 1 && s[0].body.text ===
    "⚠️ רילס: פרויקט בזלת שחורה: אינסטגרם ✖ (סוג המדיה לא מתאים לסטורי)\n🔄 המערכת תנסה שוב אוטומטית", s[0] && s[0].body.text);

  // 15. Cron handler end to end: a due row succeeds, a failed row's middle auto-retry stays silent
  setEnv(Object.assign({}, TEST, { CRON_SECRET: "cron-fake", META_PAGE_ACCESS_TOKEN: "meta-token-fake", META_PAGE_ID: "PAGE1", META_IG_USER_ID: "IGU1" }));
  reset(); notify._resetDedupe();
  const due = row({ title: "פוסט תקין" });
  const failedRow = row({ title: "פוסט שנכשל", status: "failed", fb_post_id: "PAGE1_9", publish_attempts: 1 });
  restRows = { approved: [due], failed: [failedRow], scheduled: [], byId: { [failedRow.id]: Object.assign({}, failedRow, { status: "approved" }) } };
  let ig = 0;
  const origFetch = global.fetch;
  global.fetch = async function (url, init) {
    if (/IGU1\/media$/.test(String(url)) && (init || {}).method === "POST" && ++ig === 2) {
      return json(200, { error: { code: 4, message: "Application request limit reached" } });
    }
    return origFetch(url, init);
  };
  let out;
  const resObj = { status(c) { this.code = c; return this; }, json(b) { out = b; return this; } };
  await core({ headers: { authorization: "Bearer cron-fake" }, query: {} }, resObj);
  global.fetch = origFetch;
  await drain(); s = tgSends();
  check("cron: processed 1 + retried 1", resObj.code === 200 && out.processed === 1 && out.retried === 1, JSON.stringify(out));
  check("cron: one ✅ for the due row, nothing for the middle auto-retry", s.length === 1 && s[0].body.text.startsWith("✅ פורסם: פוסט תקין"), s.map(x => x.body.text).join(" | "));

  // 16. Preview-only sample hook
  setEnv(Object.assign({}, PROD, { VERCEL_ENV: "production", INTERNAL_API_SECRET: "internal-fake" })); reset(); notify._resetDedupe();
  await core({ headers: { "x-internal-secret": "internal-fake" }, query: { notify_sample: "1" } }, resObj);
  check("sample hook: 404 in production, nothing sent", resObj.code === 404 && tgSends().length === 0);
  setEnv(Object.assign({}, TEST, { VERCEL_ENV: "preview", INTERNAL_API_SECRET: "internal-fake" })); reset();
  await core({ headers: { "x-internal-secret": "wrong" }, query: { notify_sample: "1" } }, resObj);
  check("sample hook: 401 without the internal secret", resObj.code === 401 && tgSends().length === 0);
  await core({ headers: { "x-internal-secret": "internal-fake" }, query: { notify_sample: "1" } }, resObj);
  s = tgSends();
  check("sample hook (preview): 4 messages to the test bot, no Meta / DB calls", resObj.code === 200 && out.delivered === 4 &&
    s.length === 4 && s.every(x => x.token === "222:TESTFAKE") && !calls.some(c => c.kind === "graph" || c.kind === "rest"), JSON.stringify(out));
  check("sample hook: covers ✅, ✅ with 'כבר פורסם קודם', 🔄 and ❌", /^✅/.test(s[0].body.text) && /כבר פורסם קודם/.test(s[1].body.text) &&
    /🔄/.test(s[2].body.text) && /❌/.test(s[3].body.text));

  // 17. Logs never carry titles, tokens or secrets
  check("logs: no titles, tokens or secrets", !logs.some(l => /בזלת|פוסט תקין|פוסט שנכשל|כותרת|TESTFAKE|PRODFAKE|meta-token-fake|internal-fake|svc-fake|cron-fake/.test(l)),
    logs.filter(l => /בזלת|FAKE|fake/.test(l)).slice(0, 2).join(" | "));

  origLog("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { origLog("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
