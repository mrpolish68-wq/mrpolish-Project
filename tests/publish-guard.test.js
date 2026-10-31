// Burst guard on the server (handoff §33): the cron publishes at most 3 rows per run, and
// publish-now refuses (leaves the row approved) when 3+ posts went live in the last 10 minutes.
// EVERY outbound call is mocked (Graph API, Supabase REST + Auth, Telegram). Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
let bg = [];
require.cache[require.resolve(REPO + "/node_modules/@vercel/functions")] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } } };

Object.assign(process.env, {
  SUPABASE_SERVICE_ROLE_KEY: "svc-fake", CRON_SECRET: "cron-fake", META_PAGE_ACCESS_TOKEN: "meta-token-fake", META_PAGE_ID: "PAGE1", META_IG_USER_ID: "IGU1",
  TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_ALLOWED_CHATS: "600"
});
delete process.env.VERCEL_ENV;

let calls, db, recentCount, recentFails, authOk;
function reset() { calls = []; db = { approved: [], failed: [], containers: [], byId: {} }; recentCount = 0; recentFails = false; authOk = true; }
reset();
function json(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

global.fetch = async function (url, init) {
  init = init || {};
  url = String(url);
  const method = init.method || "GET";
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (/^https:\/\/api\.telegram\.org\/bot/.test(url)) { calls.push({ kind: "tg", body }); return json(200, { ok: true, result: {} }); }
  if (/\/auth\/v1\/user$/.test(url)) { calls.push({ kind: "auth" }); return authOk ? json(200, { id: "user-1" }) : json(401, {}); }
  if (url.startsWith("https://graph.facebook.com/")) {
    const p = url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, "").split("?")[0];
    calls.push({ kind: "graph", method, path: p, body });
    if (method === "POST" && p === "PAGE1/photos") return json(200, { id: "PH" + calls.length, post_id: "PAGE1_" + calls.length });
    if (method === "POST" && p === "PAGE1/feed") return json(200, { id: "PAGE1_F" + calls.length });
    if (method === "POST" && p === "IGU1/media") return json(200, { id: "C" + calls.length });
    if (method === "POST" && p === "IGU1/media_publish") return json(200, { id: "IG" + calls.length });
    if (/fields=status_code/.test(url)) return json(200, { status_code: "FINISHED" });
    if (/fields=permalink/.test(url)) return json(200, { permalink: "https://www.instagram.com/p/X/" });
    throw new Error("unmocked graph " + p);
  }
  const m = url.match(/\/rest\/v1\/content_queue\?(.*)$/);
  if (m) {
    const qs = decodeURIComponent(m[1]);
    calls.push({ kind: "rest", method, qs, body });
    if (method === "PATCH") {
      if (/status=eq\.approved/.test(qs) && /last_publish_attempt_at/.test(qs)) return json(200, [{ id: "x" }]);
      if (/status=eq\.failed/.test(qs)) return json(200, [{ id: "x" }]);
      return json(204, null);
    }
    if (/published_at=gte\./.test(qs)) {
      if (recentFails) return json(500, {});
      return json(200, Array.from({ length: recentCount }, (_, i) => ({ id: "p" + i })));
    }
    if (/ig_container_id=not\.is\.null/.test(qs)) return json(200, db.containers);   // open Instagram video containers (command 7)
    if (/status=eq\.approved/.test(qs)) return json(200, db.approved);
    if (/status=eq\.failed/.test(qs)) return json(200, db.failed);
    if (/status=eq\.scheduled/.test(qs)) return json(200, []);
    const idm = qs.match(/id=eq\.([^&]+)/);
    if (idm) return json(200, db.byId[idm[1]] ? [db.byId[idm[1]]] : []);
    return json(200, []);
  }
  throw new Error("unmocked fetch: " + url);
};
const origLog = console.log;
console.log = () => {}; console.error = () => {};

const cron = require(REPO + "/api/publish-scheduled-content.js");
// the scheduler's command-7 housekeeping is tested in its own suite (tests/command7.test.js)
const noop = { maybeSend: async () => ({ skipped: "test" }), maybeRun: async () => ({ skipped: "test" }), queuePending: async () => ({ checked: 0 }) };
cron._setTasks({ weeklySummary: noop, commentAlerts: noop, videoRetention: noop, socialQueue: noop });
const publishNow = require(REPO + "/api/_publish-now.js");

let passed = 0, total = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; origLog("PASS " + name); } else origLog("FAIL " + name + (detail ? "  -- " + detail : ""));
}
const past = (min) => new Date(Date.now() - min * 60000).toISOString();
let n = 0;
const row = (extra) => Object.assign({ id: "row-" + (++n), title: "פוסט " + n, caption: "c", platform: "both", media_type: "image", content_category: "post",
  status: "approved", scheduled_for: past(60), publish_attempts: 0, fb_post_id: null, ig_post_id: null }, extra);
function mkRes() { return { code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } }; }
const publishedIds = () => calls.filter(c => c.kind === "rest" && c.method === "PATCH" && c.body && c.body.status === "published").length;
const metaPosts = () => calls.filter(c => c.kind === "graph" && c.method === "POST" && /\/photos$|media_publish$/.test(c.path));
async function drain() { const p = bg; bg = []; await Promise.all(p); }

(async function main() {
  // ---- cron: at most 3 per run ----
  reset();
  db.approved = [1, 2, 3, 4, 5].map(i => row({ scheduled_for: past(100 - i) }));
  let res = mkRes();
  await cron({ headers: { authorization: "Bearer cron-fake" }, query: {} }, res);
  await drain();
  check("cron: 5 due → exactly 3 published this run", res.code === 200 && res.body.processed === 3 && publishedIds() === 3, JSON.stringify(res.body && { p: res.body.processed, w: res.body.waiting }));
  check("cron: the 3 oldest (fetch order) are the ones published", JSON.stringify(res.body.results.map(r => r.id)) === JSON.stringify(db.approved.slice(0, 3).map(r => r.id)));
  check("cron: reports 2 waiting for the next run", res.body.waiting === 2, String(res.body.waiting));
  check("cron: notifications still sent (one ✅ per published row)", calls.filter(c => c.kind === "tg").length === 3);

  reset();
  db.approved = [row()];
  db.failed = [1, 2, 3].map(() => row({ status: "failed", fb_post_id: "PAGE1_9", publish_attempts: 1 }));
  db.failed.forEach(r => { db.byId[r.id] = Object.assign({}, r, { status: "approved" }); });
  res = mkRes();
  await cron({ headers: { authorization: "Bearer cron-fake" }, query: {} }, res);
  await drain();
  check("cron: 1 due + 3 failed → 1 published + 2 auto-retries (budget of 3)", res.body.processed === 1 && res.body.retried === 2 && res.body.waiting === 1, JSON.stringify({ p: res.body.processed, r: res.body.retried, w: res.body.waiting }));

  reset();
  db.approved = [1, 2, 3].map(() => row());
  db.failed = [row({ status: "failed", publish_attempts: 1 })];
  res = mkRes();
  await cron({ headers: { authorization: "Bearer cron-fake" }, query: {} }, res);
  check("cron: 3 due → no auto-retry this run (budget used)", res.body.processed === 3 && res.body.retried === 0 && res.body.waiting === 1 &&
    !calls.some(c => c.kind === "rest" && c.method === "PATCH" && /status=eq\.failed/.test(c.qs)));

  // ---- carousels (command 7): 2+ photos publish (FB multi-photo + IG carousel); anything else fails closed ----
  reset();
  db.approved = [row({ media_type: "carousel", media_url: "https://x.test/1.jpg", media_items: [{ url: "https://x.test/1.jpg", type: "image" }, { url: "https://x.test/2.jpg", type: "image" }] })];
  res = mkRes();
  await cron({ headers: { authorization: "Bearer cron-fake" }, query: {} }, res);
  await drain();
  check("carousel (2 photos): published in one run, counted once by the burst guard", res.body.processed === 1 && publishedIds() === 1, JSON.stringify(res.body.results));
  for (const bad of [
    { name: "1 photo", items: [{ url: "https://x.test/1.jpg", type: "image" }] },
    { name: "a video inside", items: [{ url: "https://x.test/1.jpg", type: "image" }, { url: "https://x.test/2.mp4", type: "video" }] }
  ]) {
    reset();
    db.approved = [row({ media_type: "carousel", media_url: "https://x.test/1.jpg", media_items: bad.items })];
    res = mkRes();
    await cron({ headers: { authorization: "Bearer cron-fake" }, query: {} }, res);
    await drain();
    const carPatch = calls.find(c => c.kind === "rest" && c.method === "PATCH" && c.body && c.body.status === "failed");
    check("carousel (" + bad.name + "): never sent to Meta, marked failed with a clear reason",
      !calls.some(c => c.kind === "graph") && !!carPatch && /fewer than 2 usable photos, or contains a video/.test(carPatch.body.publish_error), JSON.stringify(carPatch && carPatch.body));
  }

  // ---- publish-now: refuse when 3+ went live in the last 10 minutes ----
  async function callNow(r) {
    db.byId[r.id] = r;
    const out = mkRes();
    await publishNow({ method: "POST", headers: { authorization: "Bearer user-token", "x-forwarded-for": "10.0.0." + (++n) }, body: { id: r.id } }, out);
    await drain();
    return out;
  }
  reset(); recentCount = 3;
  let out = await callNow(row());
  check("publish-now: 3 published in the last 10 min → 200 deferred + throttled", out.code === 200 && out.body.deferred === true && out.body.throttled === true && out.body.ok === true, JSON.stringify(out.body));
  check("publish-now (throttled): no Meta call, no row update (stays approved), no notification",
    !calls.some(c => c.kind === "graph") && !calls.some(c => c.kind === "rest" && c.method === "PATCH") && !calls.some(c => c.kind === "tg"));
  check("publish-now (throttled): the count looks at published_at in the last 10 minutes", calls.some(c => c.kind === "rest" && /select=id&published_at=gte\./.test(c.qs) &&
    Math.abs(new Date(c.qs.match(/published_at=gte\.([^&]+)/)[1]).getTime() - (Date.now() - 600000)) < 5000));
  check("publish-now (throttled): Hebrew reason for the panel", /בסבב הבא/.test(out.body.reason || ""));

  reset(); recentCount = 2;
  out = await callNow(row());
  check("publish-now: 2 recent → publishes normally", out.code === 200 && out.body.status === "published" && metaPosts().length === 2, JSON.stringify(out.body));
  check("publish-now: notification still sent", calls.filter(c => c.kind === "tg").length === 1);

  reset(); recentFails = true;
  out = await callNow(row());
  check("publish-now: count unavailable → fails safe (deferred, nothing posted)", out.body.deferred === true && metaPosts().length === 0);

  reset(); recentCount = 5;
  out = await callNow(row({ platform: "facebook", scheduled_for: new Date(Date.now() + 3 * 3600000).toISOString() }));
  check("publish-now: a future Facebook-only row isn't throttled (native schedule, not going live now)", out.body.status === "scheduled" &&
    !calls.some(c => c.kind === "rest" && /published_at=gte/.test(c.qs)), JSON.stringify(out.body));

  reset(); recentCount = 3; authOk = false;
  out = await callNow(row());
  check("publish-now: auth still checked first (401, no count query)", out.code === 401 && !calls.some(c => c.kind === "rest"));

  check("isDueNow: past / within 11 min / future", cron.isDueNow({ scheduled_for: past(1) }) && cron.isDueNow({ scheduled_for: new Date(Date.now() + 5 * 60000).toISOString() }) &&
    !cron.isDueNow({ scheduled_for: new Date(Date.now() + 60 * 60000).toISOString() }));

  origLog("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { origLog("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
