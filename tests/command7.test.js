// Command 7 (media projects): Facebook multi-photo + Instagram carousel, the two-phase Instagram video,
// the project → content_queue social queue, video retention (D5), the weekly summary, comment alerts,
// and "✅ העבודה בוצעה" → "⭐ בקשת ביקורת" in the bot. ALL offline: every Graph / Supabase / Telegram call
// hits the in-memory mocks below. Fake values only; no real post, no real quote number.
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

// ---------------------------------------------------------------------------
// an in-memory PostgREST (just the query shapes the code uses)
// ---------------------------------------------------------------------------
const PK = { scheduler_state: ["key"], weekly_reports: ["week_start"], social_comment_seen: ["platform", "comment_id"] };
let T, calls, graph, tgSent, removed, nextId;
function reset() {
  T = { content_queue: [], content_queue_archive: [], projects: [], project_media: [], project_publications: [], scheduler_state: [], weekly_reports: [],
    social_comment_seen: [], leads: [], quotes: [] };
  calls = []; tgSent = []; removed = []; nextId = 0;
  graph = { posts: [], fbComments: {}, igMedia: [], igComments: {}, containerStatus: {}, debug: { is_valid: true, data_access_expires_at: Math.floor(Date.parse("2027-01-28T15:56:22Z") / 1000) }, fail: {} };
}
reset();
const uuid = () => "00000000-0000-4000-8000-" + String(++nextId).padStart(12, "0");
function field(row, k) {
  const m = k.match(/^(\w+)->>(\w+)$/);
  if (m) { const v = row[m[1]] && row[m[1]][m[2]]; return v == null ? null : String(v); }
  return row[k];
}
function cmp(a, b) { const x = Date.parse(a), y = Date.parse(b); return !isNaN(x) && !isNaN(y) && /\d{4}-/.test(String(a)) ? x - y : (a > b ? 1 : a < b ? -1 : 0); }
function test1(row, k, opv) {
  const v = field(row, k);
  let m;
  if (opv === "is.null") return v == null;
  if (opv === "not.is.null") return v != null;
  if ((m = opv.match(/^in\.\((.*)\)$/))) return m[1].split(",").map(s => s.replace(/^"|"$/g, "")).includes(String(v));
  if ((m = opv.match(/^like\.(.*)$/))) return new RegExp("^" + m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(String(v));
  if ((m = opv.match(/^(eq|neq|gte|lte|gt|lt)\.(.*)$/))) {
    const [, op, val] = m;
    if (op === "eq") return String(v) === val;
    if (op === "neq") return String(v) !== val;
    if (v == null) return false;
    const c = cmp(v, val);
    return op === "gte" ? c >= 0 : op === "lte" ? c <= 0 : op === "gt" ? c > 0 : c < 0;
  }
  throw new Error("mock: unsupported filter " + k + "=" + opv);
}
function filterRows(rows, qs) {
  const params = qs ? qs.split("&").map(p => { const i = p.indexOf("="); return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))]; }) : [];
  let out = rows.filter(row => params.every(([k, v]) => {
    if (["select", "order", "limit", "on_conflict"].includes(k)) return true;
    if (k === "or") return v.replace(/^\(|\)$/g, "").split(",").some(it => { const m = it.match(/^(.+?)\.((?:eq|neq|gte|lte|gt|lt)\..*|is\.null)$/); return test1(row, m[1], m[2]); });
    return test1(row, k, v);
  }));
  const lim = params.find(p => p[0] === "limit");
  return lim ? out.slice(0, +lim[1]) : out;
}
function keyOf(table, row) { return (PK[table] || ["id"]).map(k => String(row[k])).join("|"); }
function rest(table, method, qs, body, prefer) {
  const rows = T[table];
  if (!rows) throw new Error("mock: no table " + table);
  if (method === "GET") return filterRows(rows, qs);
  if (method === "POST") {
    const list = Array.isArray(body) ? body : [body];
    // like PostgREST: a multi-row insert must use the same keys in every object (found live on the preview)
    if (list.length > 1 && list.some(r => Object.keys(r).sort().join() !== Object.keys(list[0]).sort().join())) return { status: 400, body: { message: "All object keys must match" } };
    if (table === "project_publications") {
      for (const r of list) { const p = T.projects.find(x => x.id === r.project_id); if (!p || p.consent !== "yes") return { status: 400, body: { message: "project has no publishing consent" } }; }
    }
    const inserted = [];
    for (const r0 of list) {
      const r = Object.assign({}, r0);
      if (!(PK[table]) && !r.id) r.id = uuid();
      if (table === "scheduler_state" && !r.updated_at) r.updated_at = new Date().toISOString();
      const dup = rows.find(x => keyOf(table, x) === keyOf(table, r));
      if (dup) {
        if (/ignore-duplicates/.test(prefer)) continue;
        if (/merge-duplicates/.test(prefer)) { Object.assign(dup, r); continue; }
        return { status: 409, body: { message: "duplicate key" } };
      }
      rows.push(r); inserted.push(r);
    }
    return { status: 201, body: inserted };
  }
  if (method === "PATCH") { const hit = filterRows(rows, qs); hit.forEach(r => Object.assign(r, body)); return { status: 200, body: hit }; }
  if (method === "DELETE") { const hit = filterRows(rows, qs); T[table] = rows.filter(r => !hit.includes(r)); return { status: 200, body: hit }; }
}
function res(status, body, headers) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (headers || {})[k.toLowerCase()] || null }, json: async () => body };
}
global.fetch = async function (url, init) {
  init = init || {};
  url = String(url);
  const method = init.method || "GET";
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  const headers = init.headers || {};
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/))) { tgSent.push({ method: m[1], body }); return res(200, { ok: true, result: { message_id: 900 + tgSent.length } }); }
  if (url.startsWith("https://graph.facebook.com/")) {
    const u = new URL(url), p = u.pathname.replace(/^\/v[\d.]+\//, "");
    calls.push({ kind: "graph", method, path: p, body, query: u.search });
    if (graph.fail[p]) return res(200, { error: { message: graph.fail[p], code: 1 } });
    if (p === "debug_token") return graph.debug === "error" ? res(500, { error: { message: "x" } }) : res(200, { data: graph.debug });
    if (method === "POST" && p === "PAGE1/photos") return res(200, { id: "PH" + calls.length });
    if (method === "POST" && p === "PAGE1/feed") return res(200, { id: "PAGE1_F" + calls.length });
    if (method === "POST" && p === "PAGE1/videos") return res(200, { id: "V" + calls.length });
    if (method === "POST" && p === "IGU1/media") return res(200, { id: "C" + calls.length });
    if (method === "POST" && p === "IGU1/media_publish") return res(200, { id: "IG" + calls.length });
    if (p === "PAGE1/posts") return res(200, { data: graph.posts });
    if (p === "IGU1" && /username/.test(u.search)) return res(200, { username: "mr.polish.floors" });
    if (p === "IGU1/media") return res(200, { data: graph.igMedia });
    if ((m = p.match(/^(.+)\/comments$/))) return res(200, { data: graph.fbComments[m[1]] || graph.igComments[m[1]] || [] });
    if (/fields=status_code/.test(u.search)) return res(200, { status_code: graph.containerStatus[p] || "FINISHED", status: graph.containerStatus[p] === "ERROR" ? "Error: unsupported codec" : undefined });
    if (/fields=permalink/.test(u.search)) return res(200, { permalink: "https://www.instagram.com/p/X/" });
    throw new Error("mock: unmocked graph " + method + " " + p);
  }
  if ((m = url.match(/\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/))) { calls.push({ kind: "sign", bucket: m[1], path: decodeURIComponent(m[2]), body }); return res(200, { signedURL: "/object/sign/" + m[1] + "/" + m[2] + "?token=signed" }); }
  if ((m = url.match(/\/storage\/v1\/object\/([^/?]+)$/)) && method === "DELETE") { removed.push({ bucket: m[1], paths: body.prefixes }); return res(200, []); }
  if ((m = url.match(/\/rest\/v1\/(\w+)\??(.*)$/))) {
    const table = m[1], qs = m[2];
    const prefer = headers.Prefer || headers.prefer || "";
    calls.push({ kind: "rest", table, method, qs: decodeURIComponent(qs), body });
    const r = rest(table, method, qs, body, prefer);
    if (method === "GET") {
      if (/count=exact/.test(prefer)) return res(200, r.slice(0, 1), { "content-range": "0-0/" + r.length });
      return res(200, r);
    }
    if (r.status >= 300) return res(r.status, r.body);
    return res(/return=representation/.test(prefer) ? 200 : 204, /return=representation/.test(prefer) ? r.body : null);
  }
  throw new Error("mock: unmocked fetch " + method + " " + url);
};
const origLog = console.log;
console.log = () => {}; console.error = () => {};

const MM = require(REPO + "/api/_meta-media.js");
MM._set({ pollDelayMs: 0 });
const cron = require(REPO + "/api/publish-scheduled-content.js");
const SQ = require(REPO + "/api/_social-queue.js");
const VR = require(REPO + "/api/_video-retention.js");
const WS = require(REPO + "/api/_weekly-summary.js");
const CA = require(REPO + "/api/_comment-alerts.js");
const RR = require(REPO + "/shared/review-request.js");
const BP = require(REPO + "/api/_bot-projects.js");
const noop = { maybeSend: async () => ({}), maybeRun: async () => ({}), queuePending: async () => ({}) };

let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; origLog("PASS " + name); } else origLog("FAIL " + name + (detail ? "  -- " + String(detail).slice(0, 400) : "")); }
const graphPosts = (re) => calls.filter(c => c.kind === "graph" && c.method === "POST" && re.test(c.path));
async function drain() { const p = bg; bg = []; await Promise.all(p); }
function mkRes() { return { code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } }; }
const cronReq = { headers: { authorization: "Bearer cron-fake" }, query: {} };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const VIDEO_PATH = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp4";
const VIDEO_REF = "storage://project-originals/" + VIDEO_PATH;

(async function main() {
  cron._setTasks({ weeklySummary: noop, commentAlerts: noop, videoRetention: noop, socialQueue: noop });

  // =========================================================================
  // 1. Facebook multi-photo + Instagram carousel
  // =========================================================================
  reset();
  const items = [1, 2, 3].map(i => ({ type: "image", url: "https://cdn.test/fb" + i + ".jpg", ig_url: "https://cdn.test/ig" + i + ".jpg" }));
  const fbId = await MM.publishFacebookMulti({ caption: "כיתוב", media_items: items }, "tok", "PAGE1", null);
  const ph = graphPosts(/^PAGE1\/photos$/), feed = graphPosts(/^PAGE1\/feed$/);
  check("FB multi-photo: every photo uploaded UNPUBLISHED (published:false), the Facebook copy", ph.length === 3 && ph.every((c, i) => c.body.published === false && c.body.url === items[i].url && !c.body.temporary));
  check("FB multi-photo: ONE feed post with attached_media (all ids, in order) + the caption", feed.length === 1 && feed[0].body.attached_media.length === 3 &&
    feed[0].body.attached_media.every((a, i) => a.media_fbid === "PH" + (i + 1)) && feed[0].body.message === "כיתוב" && fbId.startsWith("PAGE1_F"));
  reset();
  const when = new Date(Date.now() + 3 * 864e5);
  await MM.publishFacebookMulti({ caption: "c", media_items: items.slice(0, 2) }, "tok", "PAGE1", when);
  const ph2 = graphPosts(/^PAGE1\/photos$/), feed2 = graphPosts(/^PAGE1\/feed$/)[0];
  check("FB multi-photo scheduled: photos temporary:true, the post published:false + scheduled_publish_time", ph2.every(c => c.body.temporary === true) &&
    feed2.body.published === false && feed2.body.scheduled_publish_time === Math.floor(when.getTime() / 1000));
  reset();
  const many = Array.from({ length: 12 }, (_, i) => ({ type: "image", url: "https://cdn.test/f" + i + ".jpg", ig_url: "https://cdn.test/i" + i + ".jpg" }));
  await MM.publishInstagramCarousel({ caption: "כיתוב IG", media_items: many }, "tok", "IGU1");
  const kids = graphPosts(/^IGU1\/media$/).filter(c => c.body.is_carousel_item), parent = graphPosts(/^IGU1\/media$/).find(c => c.body.media_type === "CAROUSEL");
  check("IG carousel: at most 10 child containers, the 1080×1350 ig_url copies", kids.length === 10 && kids.every((c, i) => c.body.image_url === many[i].ig_url));
  check("IG carousel: one CAROUSEL container with the children ids + caption → media_publish", parent && parent.body.children.split(",").length === 10 &&
    parent.body.caption === "כיתוב IG" && graphPosts(/media_publish$/).length === 1);
  let threw = null;
  try { await MM.publishInstagramCarousel({ caption: "c", media_items: items.slice(0, 1) }, "tok", "IGU1"); } catch (e) { threw = e.message; }
  check("IG carousel with 1 photo → refused before Meta", /at least 2 photos/.test(threw || ""));
  check("storage ref: only project-originals <uuid>/<uuid>.mp4|mov parses", !!MM.parseStorageRef(VIDEO_REF) && !MM.parseStorageRef("storage://project-originals/../x.mp4") &&
    !MM.parseStorageRef("storage://project-media/" + VIDEO_PATH) && !MM.parseStorageRef("https://x/y.mp4"));
  reset();
  const signed = await MM.resolveMediaUrl(VIDEO_REF);
  check("storage ref → a signed URL (24 h) for Meta; a normal URL is unchanged", /\/storage\/v1\/object\/sign\/project-originals\/.+token=signed$/.test(signed) &&
    calls.find(c => c.kind === "sign").body.expiresIn === 86400 && (await MM.resolveMediaUrl("https://cdn.test/a.jpg")) === "https://cdn.test/a.jpg");

  // a project single-photo row: Facebook gets the full-ratio copy, Instagram the 4:5 copy
  reset();
  T.content_queue.push({ id: "row-img", title: "t", caption: "c", platform: "both", media_type: "image", content_category: "post", status: "approved",
    scheduled_for: ago(5), publish_attempts: 0, media_url: "https://cdn.test/fb1.jpg", media_items: [items[0]] });
  let r = mkRes(); await cron(cronReq, r); await drain();
  const igImg = graphPosts(/^IGU1\/media$/)[0];
  check("project photo row: FB /photos gets the full copy, IG gets ig_url (4:5)", graphPosts(/^PAGE1\/photos$/)[0].body.url === "https://cdn.test/fb1.jpg" && igImg.body.image_url === items[0].ig_url &&
    T.content_queue[0].status === "published");

  // =========================================================================
  // 2. Instagram video — two-phase
  // =========================================================================
  reset();
  T.content_queue.push({ id: "row-v", title: "סרטון: [בדיקה]", caption: "c", platform: "both", media_type: "reel", content_category: "reel", status: "approved",
    scheduled_for: ago(5), publish_attempts: 0, media_url: VIDEO_REF, thumbnail_url: "https://cdn.test/cover.jpg" });
  r = mkRes(); await cron(cronReq, r); await drain();
  let v = T.content_queue[0];
  const reelC = graphPosts(/^IGU1\/media$/)[0];
  check("video phase 1: Facebook /videos with the SIGNED url (never the storage ref)", graphPosts(/^PAGE1\/videos$/).length === 1 && /token=signed/.test(graphPosts(/^PAGE1\/videos$/)[0].body.file_url));
  check("video phase 1: IG REELS container created with the signed url + cover; NO media_publish, NO waiting", reelC.body.media_type === "REELS" && /token=signed/.test(reelC.body.video_url) &&
    reelC.body.cover_url === "https://cdn.test/cover.jpg" && graphPosts(/media_publish$/).length === 0 && !calls.some(c => c.kind === "graph" && /status_code/.test(c.query)));
  check("video phase 1: row stays 'approved' with fb_post_id + ig_container_id/IN_PROGRESS; attempts not counted yet",
    v.status === "approved" && !!v.fb_post_id && !!v.ig_container_id && v.ig_container_status === "IN_PROGRESS" && v.publish_attempts === 0, JSON.stringify(v));
  check("video phase 1: no Telegram message yet (sent when it is live)", tgSent.length === 0);
  // the next run: the due query must not pick it again
  const cid = v.ig_container_id;
  r = mkRes(); await cron(cronReq, r); await drain();
  check("open container: the due query skips it (no second upload), the poll ignores it inside the 5-min lease", graphPosts(/^IGU1\/media$/).length === 1 && graphPosts(/^PAGE1\/videos$/).length === 1);
  // phase 2: IN_PROGRESS
  v.last_publish_attempt_at = ago(11); graph.containerStatus[cid] = "IN_PROGRESS";
  r = mkRes(); await cron(cronReq, r); await drain();
  check("phase 2: IN_PROGRESS → only the status + check time recorded, still approved", v.status === "approved" && v.ig_container_status === "IN_PROGRESS" && !!v.ig_container_checked_at && graphPosts(/media_publish$/).length === 0);
  // FINISHED
  v.last_publish_attempt_at = ago(11); graph.containerStatus[cid] = "FINISHED";
  r = mkRes(); await cron(cronReq, r); await drain();
  check("phase 2: FINISHED → media_publish → 'published' + ig_post_id, container cleared, attempts 1", v.status === "published" && /^IG/.test(v.ig_post_id) && v.ig_container_id === null &&
    v.ig_container_status === "PUBLISHED" && v.publish_attempts === 1 && r.body.igContainers.published === 1);
  const msg = tgSent.find(t => t.method === "sendMessage");
  check("phase 2: the tidy ✅ notification — Facebook 'פורסם' (this approval), Instagram 'פורסם'", msg && /^✅ הפוסט פורסם בהצלחה/.test(msg.body.text) && /📘 פייסבוק: ✅ פורסם\n/.test(msg.body.text) && /📸 אינסטגרם: ✅ פורסם/.test(msg.body.text), msg && msg.body.text);
  // ERROR
  reset();
  T.content_queue.push({ id: "row-e", title: "t", caption: "c", platform: "instagram", media_type: "reel", status: "approved", scheduled_for: ago(30), publish_attempts: 0,
    media_url: VIDEO_REF, ig_container_id: "C9", ig_container_status: "IN_PROGRESS", ig_container_created_at: ago(20), last_publish_attempt_at: ago(11) });
  graph.containerStatus.C9 = "ERROR";
  r = mkRes(); await cron(cronReq, r); await drain();
  v = T.content_queue[0];
  // (the run's existing auto-retry pass may flip the failed row back to 'approved' at once; the claim lease
  // then keeps it for the NEXT run, which uploads a fresh container — so assert on the failure write itself)
  const failWrite = (id) => calls.find(c => c.kind === "rest" && c.method === "PATCH" && c.table === "content_queue" && c.qs.includes("id=eq." + id) && c.body && c.body.status === "failed");
  let fw = failWrite("row-e");
  check("phase 2: ERROR → 'failed' with a clear reason, container cleared (so a retry re-uploads), attempts +1",
    fw && /media processing failed \(ERROR: Error: unsupported codec\)/.test(fw.body.publish_error) && fw.body.ig_container_id === null && fw.body.ig_container_status === "ERROR" &&
    fw.body.publish_attempts === 1 && v.ig_container_id === null && graphPosts(/^IGU1\/media$/).length === 0, JSON.stringify(fw && fw.body));
  check("phase 2: ERROR → the first-failure ❌ notification, friendly reason", tgSent.some(t => /אינסטגרם לא הצליח לעבד את הקובץ/.test(t.body.text || "")));
  // EXPIRED by age (no Meta answer for 24 h)
  reset();
  T.content_queue.push({ id: "row-x", title: "t", caption: "c", platform: "instagram", media_type: "reel", status: "approved", scheduled_for: ago(2000), publish_attempts: 0,
    media_url: VIDEO_REF, ig_container_id: "C7", ig_container_status: "IN_PROGRESS", ig_container_created_at: ago(25 * 60), last_publish_attempt_at: ago(11) });
  graph.containerStatus.C7 = "IN_PROGRESS";
  r = mkRes(); await cron(cronReq, r); await drain();
  fw = failWrite("row-x");
  check("phase 2: still IN_PROGRESS after 24 h → EXPIRED → failed with a clear reason", fw && /expired/.test(fw.body.publish_error) && fw.body.ig_container_status === "EXPIRED" && T.content_queue[0].ig_container_id === null);
  // PUBLISHED (an earlier run crashed after publishing) → recorded, never re-uploaded
  reset();
  T.content_queue.push({ id: "row-p", title: "t", caption: "c", platform: "instagram", media_type: "reel", status: "approved", scheduled_for: ago(60), publish_attempts: 0,
    media_url: VIDEO_REF, ig_container_id: "C5", ig_container_created_at: ago(30), last_publish_attempt_at: ago(11) });
  graph.containerStatus.C5 = "PUBLISHED";
  r = mkRes(); await cron(cronReq, r); await drain();
  check("phase 2: Meta says PUBLISHED → marked published, no media_publish, no failure (no double post)", T.content_queue[0].status === "published" && graphPosts(/media_publish$/).length === 0);
  // budget: a FINISHED video counts against the 3 per run
  reset();
  T.content_queue.push({ id: "row-f", title: "t", caption: "c", platform: "instagram", media_type: "reel", status: "approved", scheduled_for: ago(60), publish_attempts: 0,
    media_url: VIDEO_REF, ig_container_id: "C3", ig_container_created_at: ago(30), last_publish_attempt_at: ago(11) });
  for (let i = 0; i < 4; i++) T.content_queue.push({ id: "due-" + i, title: "t", caption: "c", platform: "facebook", media_type: "image", status: "approved", scheduled_for: ago(50 - i), publish_attempts: 0, media_url: "https://cdn.test/x.jpg" });
  graph.containerStatus.C3 = "FINISHED";
  r = mkRes(); await cron(cronReq, r); await drain();
  check("burst guard: the finished video + 2 due rows = 3 this run, 2 waiting", r.body.igContainers.published === 1 && r.body.processed === 2 && r.body.waiting === 2, JSON.stringify({ c: r.body.igContainers, p: r.body.processed, w: r.body.waiting }));

  // =========================================================================
  // 3. the social queue (project → content_queue)
  // =========================================================================
  function seedProject(extra, mediaExtra) {
    const pid = uuid();
    const p = Object.assign({ id: pid, status: "ready", consent: "yes", title_he: "[בדיקה] שיש ברעננה", city: "רעננה",
      ai_meta: { caption_he: "השיש חזר לברק.\n\n📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com\n\n#ליטוש_שיש",
        publish_plan: { destinations: ["site", "facebook", "instagram", "ig_story"], timing: "now", at: null } } }, extra || {});
    T.projects.push(p);
    const img = (n, role, pair) => ({ id: uuid(), project_id: pid, kind: "image", role, pair_no: pair, sort: n,
      variants: { jpg: { path: pid + "/j" + n + ".jpg" }, w1600: { path: pid + "/w" + n + ".webp" }, ig: { path: pid + "/ig" + n + ".jpg" } }, ai_flags: {}, flags_ack_at: null });
    T.project_media.push(img(3, "after", 1), img(1, "before", 1), img(4, "after", 2), img(2, "before", 2), img(5, "detail", null));
    if (!mediaExtra || mediaExtra.video !== false) T.project_media.push({ id: uuid(), project_id: pid, kind: "video", role: "video", sort: 9, original_path: VIDEO_PATH,
      variants: { cover: { jpg: { path: pid + "/cover.jpg" } } }, ai_flags: {}, file_deleted_at: null });
    return p;
  }
  reset();
  let P = seedProject();
  const q1 = await SQ.approveAndQueue(P.id, "telegram");
  const feedRow = T.content_queue.find(x => x.media_type === "carousel"), reelRow = T.content_queue.find(x => x.media_type === "reel"), storyRow = T.content_queue.find(x => x.media_type === "story");
  check("queue: one carousel (FB+IG), one reel, one story — all 'approved' (D1), linked by project_id", q1.ok && q1.queued === 3 && feedRow && reelRow && storyRow &&
    T.content_queue.every(x => x.status === "approved" && x.project_id === P.id && !!x.approved_at) && feedRow.platform === "both" && storyRow.platform === "instagram", JSON.stringify(q1));
  check("queue: carousel order = pair 1 before→after, pair 2 before→after, then the detail; FB copy + IG 4:5 copy per item",
    feedRow.media_items.map(i => i.url.split("/").pop()).join() === "j1.jpg,j3.jpg,j2.jpg,j4.jpg,j5.jpg" && feedRow.media_items.every(i => /\/ig\d\.jpg$/.test(i.ig_url)) && /\/j1\.jpg$/.test(feedRow.media_url));
  check("queue: the video stays private — a storage reference + the public cover, never a public video URL",
    reelRow.media_url === VIDEO_REF && /\/project-media\/.+\/cover\.jpg$/.test(reelRow.thumbnail_url) && !T.content_queue.some(x => /project-originals/.test(x.thumbnail_url || "")));
  check("queue: timing 'now' → the feed + story now; the reel at the next free burst-guard slot after it (never two posts in one slot)",
    Math.abs(Date.parse(feedRow.scheduled_for) - Date.now()) < 60000 && Date.parse(reelRow.scheduled_for) > Date.parse(feedRow.scheduled_for) &&
    (() => { const q = require(REPO + "/shared/burst-schedule.js").israelParts(reelRow.scheduled_for); return q.min === 0 && [10, 14, 19].includes(q.h); })());
  check("queue: the story uses the first AFTER photo (IG copy)", /\/ig3\.jpg$/.test(storyRow.media_url));
  check("queue: project_publications — facebook + instagram for the feed AND the reel, ig_story for the story (each with its content_queue_id)",
    T.project_publications.length === 5 && T.project_publications.every(x => T.content_queue.some(c => c.id === x.content_queue_id)) &&
    T.project_publications.filter(x => x.destination === "ig_story").length === 1);
  check("queue: the lock says queued (+ the row ids)", T.scheduler_state.find(s => s.key === "social:" + P.id).value.status === "queued");
  const q2 = await SQ.approveAndQueue(P.id, "panel");
  check("queue: approving again → 'already', no second copy", q2.already === true && T.content_queue.length === 3);
  const q3 = await SQ.queuePending();
  check("queue: the cron safety net finds nothing to do", q3.queued === 0 && T.content_queue.length === 3);
  // a scheduled slot in the future
  reset();
  const slot = new Date(Date.now() + 5 * 864e5);
  P = seedProject({ ai_meta: Object.assign({}, seedProject().ai_meta, { publish_plan: { destinations: ["instagram"], timing: "at", at: slot.toISOString() } }) }, { video: false });
  await SQ.approveAndQueue(P.id, "telegram");
  const only = T.content_queue.filter(x => x.project_id === P.id);
  check("queue: a chosen future slot is kept; Instagram only → platform 'instagram', no story / reel", only.length === 1 && only[0].platform === "instagram" && only[0].scheduled_for === slot.toISOString());
  // blocked cases
  reset();
  P = seedProject({ ai_meta: { publish_plan: { destinations: ["facebook"] } } });
  let qb = await SQ.approveAndQueue(P.id, "telegram");
  check("queue: no caption → blocked 'no_caption', nothing queued", qb.ok === false && qb.reason === "no_caption" && T.content_queue.length === 0);
  P.ai_meta.caption_he = "כיתוב";
  qb = await SQ.approveAndQueue(P.id, "telegram");
  check("queue: fixed + approved again → the block reopens and it is queued", qb.ok && qb.queued >= 1);
  reset();
  P = seedProject();
  T.project_media[0].ai_flags = { faces: true };
  qb = await SQ.approveAndQueue(P.id, "telegram");
  check("queue: an unreviewed privacy flag → blocked 'flags' (D3), nothing queued", qb.reason === "flags" && T.content_queue.length === 0);
  reset();
  P = seedProject({ consent: "no" });
  qb = await SQ.approveAndQueue(P.id, "telegram");
  check("queue: no consent → blocked (D2), nothing queued", qb.reason === "no_consent" && T.content_queue.length === 0);
  reset();
  P = seedProject({ status: "draft" });
  qb = await SQ.approveAndQueue(P.id, "telegram");
  check("queue: not ready yet → stays 'approved' for the cron (not blocked)", qb.reason === "not_ready" && T.scheduler_state[0].value.status === "approved");
  P.status = "ready";
  const qp = await SQ.queuePending();
  check("queue: the cron safety net queues it once it is ready", qp.queued === 3 && T.content_queue.length === 3);
  // the DB guard refuses after the rows were created → they are cancelled
  reset();
  P = seedProject();
  const guardOnce = { on: true };
  const f0 = global.fetch;
  global.fetch = async function (url, init) {
    if (guardOnce.on && /\/rest\/v1\/project_publications/.test(String(url)) && init && init.method === "POST") { guardOnce.on = false; return res(400, { message: "flagged media" }); }
    return f0(url, init);
  };
  qb = await SQ.approveAndQueue(P.id, "telegram");
  global.fetch = f0;
  check("queue: the DB guard refuses → the new rows are cancelled ('rejected'), lock 'blocked'", qb.reason === "guard" && T.content_queue.length === 3 && T.content_queue.every(x => x.status === "rejected") &&
    T.scheduler_state[0].value.status === "blocked");
  // a crash after the insert → the retry only records the rows
  reset();
  P = seedProject();
  await SQ.approve(P.id, "telegram");
  T.content_queue.push({ id: "pre-1", project_id: P.id, status: "approved", media_type: "carousel", scheduled_for: ago(1) });
  T.scheduler_state[0].value.status = "queuing"; T.scheduler_state[0].updated_at = ago(6);
  qb = await SQ.queuePending();
  check("queue: a stuck 'queuing' (> 5 min) whose rows exist → recorded, never a second copy", T.content_queue.length === 1 && T.scheduler_state[0].value.status === "queued" && T.scheduler_state[0].value.recovered === true);

  // =========================================================================
  // 4. video retention (D5)
  // =========================================================================
  reset();
  const vm = { id: uuid(), kind: "video", original_path: VIDEO_PATH, file_deleted_at: null };
  T.project_media.push(vm);
  T.content_queue.push({ id: "a", media_url: VIDEO_REF, status: "published", published_at: ago(6 * 1440) });
  T.content_queue_archive.push({ id: "b", media_url: VIDEO_REF, status: "published", published_at: ago(9 * 1440) });
  let vr = await VR.run();
  check("retention: one row published < 7 days ago → kept", vr.deleted === 0 && removed.length === 0 && vm.file_deleted_at === null);
  T.content_queue[0].published_at = ago(8 * 1440);
  T.content_queue.push({ id: "c", media_url: VIDEO_REF, status: "failed", published_at: null });
  vr = await VR.run();
  check("retention: any destination not published (failed) → kept", vr.deleted === 0 && removed.length === 0);
  T.content_queue.pop();
  vr = await VR.run();
  check("retention: every row published ≥ 7 days ago (queue + archive) → the file deleted from project-originals, file_deleted_at set",
    vr.deleted === 1 && removed.length === 1 && removed[0].bucket === "project-originals" && removed[0].paths[0] === VIDEO_PATH && !!vm.file_deleted_at);
  vr = await VR.run();
  check("retention: idempotent (already deleted → skipped)", vr.deleted === 0 && vr.skipped === 1 && removed.length === 1);
  check("retention: only storage refs of THIS flow — a normal https video URL is never a candidate",
    VR.deletableRefs([{ media_url: "https://cdn.test/a.mp4", status: "published", published_at: ago(30 * 1440) }]).length === 0);

  // =========================================================================
  // 5. the weekly summary
  // =========================================================================
  check("window: Sunday 08:05 Israel (winter, UTC+2) → yes", WS.inWindow(new Date("2026-11-01T06:05:00Z")));
  check("window: Sunday 08:05 Israel (summer, UTC+3) → yes; 08:10 → no; Monday 08:05 → no; 07:59 → no",
    WS.inWindow(new Date("2026-06-07T05:05:00Z")) && !WS.inWindow(new Date("2026-11-01T06:10:00Z")) && !WS.inWindow(new Date("2026-11-02T06:05:00Z")) && !WS.inWindow(new Date("2026-11-01T05:59:00Z")));
  reset();
  const now = new Date("2026-11-01T06:05:00Z");
  T.leads.push({ id: 1, created_at: "2026-10-30T10:00:00Z" }, { id: 2, created_at: "2026-10-01T10:00:00Z" });
  T.quotes.push({ id: "q1", created_at: "2026-10-29T10:00:00Z" });
  T.projects.push({ id: "p1", status: "published", published_at: "2026-10-31T10:00:00Z" });
  T.content_queue.push({ id: "c1", platform: "both", fb_post_id: "F1", ig_post_id: "I1", published_at: "2026-10-30T10:00:00Z", status: "published" },
    { id: "c2", platform: "instagram", ig_post_id: "I2", published_at: "2026-10-31T10:00:00Z", status: "published" },
    { id: "c3", status: "failed", last_publish_attempt_at: "2026-10-30T10:00:00Z" },
    { id: "c4", status: "approved", scheduled_for: "2026-11-03T08:00:00Z" }, { id: "c5", status: "approved", scheduled_for: "2026-11-20T08:00:00Z" });
  T.social_comment_seen.push({ platform: "facebook", comment_id: "x1", commented_at: "2026-10-31T10:00:00Z" });
  const w1 = await WS.maybeSend({ token: "tok", now });
  const ws = tgSent.find(t => t.method === "sendMessage");
  const wt = ws && ws.body.text || "";
  check("weekly: sent in the window, weekly_reports 'sent' for the Sunday", w1.sent === 1 && T.weekly_reports[0].week_start === "2026-11-01" && T.weekly_reports[0].status === "sent", JSON.stringify(w1));
  check("weekly: counts — leads 1, quotes 1, projects 1, FB 1, IG 2, failed 1, next week 1, comments 1",
    /פניות חדשות מהאתר: 1\n/.test(wt) && /הצעות מחיר שנוצרו: 1\n/.test(wt) && /פרויקטים חדשים באתר: 1\n/.test(wt) && /בפייסבוק: 1\n/.test(wt) && /באינסטגרם: 2\n/.test(wt) &&
    /שלא פורסמו: 1\n/.test(wt) && /לשבוע הקרוב: 1\n/.test(wt) && /תגובות חדשות ברשתות: 1\n/.test(wt), wt);
  check("weekly: one item per line, the publish-notification separator, a warm close; no 'חינם' / 'ללא עלות'", wt.split("\n").length >= 13 && (wt.match(/━━━━━━━━━━/g) || []).length === 2 &&
    /שבוע טוב ומוצלח!/.test(wt) && !/חינם|ללא עלות/.test(wt));
  check("weekly: counts only — no names, phones or comment text are read (count queries select id only)",
    calls.filter(c => c.kind === "rest" && ["leads", "quotes"].includes(c.table)).every(c => /select=id&limit=1/.test(c.qs)));
  check("weekly: token far from expiry (2027-01-28) → a calm 'בתוקף עד 28.01.2027' line, no warning", /🔐 הרשאת מטא: בתוקף עד 28\.01\.2027/.test(wt) && !/⚠️/.test(wt));
  const w2 = await WS.maybeSend({ token: "tok", now: new Date("2026-11-01T06:08:00Z") });
  check("weekly: a second run the same Sunday → not sent again", w2.skipped === "already_sent" && tgSent.filter(t => t.method === "sendMessage").length === 1);
  check("weekly: outside the window → nothing", (await WS.maybeSend({ token: "tok", now: new Date("2026-11-02T06:05:00Z") })).skipped === "window");
  const soon = { ok: true, daysLeft: 10, expiresAt: new Date("2027-01-28T15:56:22Z") };
  const warn = WS.buildMessage({ leads: 0, quotes: 0, projects: 0, facebook: 0, instagram: 0, failed: 0, upcoming: 0, comments: 0 }, soon, new Date("2027-01-18T06:05:00Z"));
  check("weekly: ≤ 14 days left → a clear warning + what to do", /⚠️ הרשאת הגישה של מטא תפוג בעוד 10 ימים \(28\.01\.2027\)/.test(warn) && /👈 מה לעשות: לחדש את ההרשאה/.test(warn));
  check("weekly: the token check failed → it says so", /לא הצלחתי לבדוק השבוע את תוקף ההרשאה/.test(WS.buildMessage({ leads: 0, quotes: 0, projects: 0, facebook: 0, instagram: 0, failed: 0, upcoming: 0, comments: 0 }, { ok: false }, now)));
  reset(); graph.debug = "error";
  T.weekly_reports.push({ week_start: "2026-11-01", status: "failed", claimed_at: "2026-11-01T06:05:00Z", attempts: 1 });
  const w3 = await WS.maybeSend({ token: "tok", now: new Date("2026-11-01T06:08:00Z") });
  check("weekly: a 'failed' week is retried inside the window (attempts 2); debug_token down → the summary still goes, with the warning",
    w3.sent === 1 && T.weekly_reports[0].attempts === 2 && T.weekly_reports[0].status === "sent" && /לא הצלחתי לבדוק/.test(tgSent[0].body.text));

  // =========================================================================
  // 6. comment alerts
  // =========================================================================
  reset();
  const tNow = new Date();
  graph.posts = [{ id: "PAGE1_1", message: "רצפת שיש בכפר סבא\nעוד טקסט", created_time: ago(60) }];
  graph.fbComments.PAGE1_1 = [
    { id: "c-own", message: "תודה!", from: { id: "PAGE1" }, created_time: ago(30), permalink_url: "https://www.facebook.com/c-own" },
    { id: "c-1", message: "כמה עולה?", from: { id: "U9" }, created_time: ago(20), permalink_url: "https://www.facebook.com/PAGE1_1?comment_id=c-1" }];
  graph.igMedia = [{ id: "M1", caption: "בזלת", timestamp: ago(90), permalink: "https://www.instagram.com/p/AAA/", comments_count: 1 }];
  graph.igComments.M1 = [{ id: "i-1", text: "מהמם", username: "someone", timestamp: ago(10), replies: { data: [{ id: "i-own", text: "תודה", username: "mr.polish.floors", timestamp: ago(5) }] } }];
  const ctx = { token: "tok", pageId: "PAGE1", igUserId: "IGU1" };
  let ca = await CA.maybeRun(Object.assign({ now: tNow }, ctx));
  check("comments: the first run only records what exists (baseline), alerts nothing", ca.baseline === 2 && tgSent.length === 0 && T.social_comment_seen.length === 2);
  check("comments: own comments / replies are skipped (Page id, IG username)", !T.social_comment_seen.some(s => /own/.test(s.comment_id)));
  check("comments: ids only — no author, no text stored", T.social_comment_seen.every(s => !("text" in s) && !("message" in s) && !("author_name" in s)));
  ca = await CA.maybeRun(Object.assign({ now: new Date(tNow.getTime() + 10 * 60000) }, ctx));
  check("comments: polled at most every 30 minutes", ca.skipped === "recent");
  graph.fbComments.PAGE1_1.push({ id: "c-2", message: "א".repeat(200), from: { id: "U8" }, created_time: ago(1), permalink_url: "https://www.facebook.com/PAGE1_1?comment_id=c-2" });
  T.content_queue_archive.push({ id: "z", fb_post_id: "PAGE1_1", title: "[בדיקה] פוסט שיש" });
  ca = await CA.maybeRun(Object.assign({ now: new Date(tNow.getTime() + 31 * 60000) }, ctx));
  const am = tgSent.find(t => t.method === "sendMessage");
  check("comments: a new comment → one alert: platform, our post title, the first 120 chars, the time", ca.alerted === 1 && am && /^💬 תגובה חדשה · 📘 פייסבוק\n📝 \[בדיקה\] פוסט שיש\n━━━━━━━━━━\n„א{119}…”\n🕐 /.test(am.body.text), am && am.body.text);
  check("comments: inline URL button 'פתיחת התגובה' → the comment's link", am.body.reply_markup.inline_keyboard[0][0].text === "פתיחת התגובה" && /comment_id=c-2/.test(am.body.reply_markup.inline_keyboard[0][0].url));
  check("comments: marked notified; the same comment is never alerted twice", !!T.social_comment_seen.find(s => s.comment_id === "c-2").notified_at &&
    (await CA.maybeRun(Object.assign({ now: new Date(tNow.getTime() + 62 * 60000) }, ctx))).alerted === 0);
  const six = Array.from({ length: 7 }, (_, i) => ({ platform: i % 2 ? "instagram" : "facebook", comment_id: "k" + i, post_id: "P", commented_at: ago(i), text: "תגובה " + i, post_text: "פוסט", url: "https://www.instagram.com/p/AAA/" }));
  const grouped = CA.buildMessages(six, {});
  check("comments: more than 5 in one run → ONE grouped message (a button per listed comment)", grouped.length === 1 && /^💬 7 תגובות חדשות ברשתות/.test(grouped[0].text) && grouped[0].reply_markup.inline_keyboard.length === 7);
  check("comments: exactly 5 → five separate messages", CA.buildMessages(six.slice(0, 5), {}).length === 5);

  // =========================================================================
  // 7. the review request (shared/review-request.js)
  // =========================================================================
  const EXACT = "היי משה, כאן אורי ממיסטר פוליש 😊\nתודה שבחרתם בנו, היה לי כיף לעבוד אצלכם!\nאם אתם מרוצים מהתוצאה, אשמח מאוד אם תקדישו דקה לכתוב לנו ביקורת בגוגל. זה עוזר לנו המון.\n👈 לחיצה על הקישור פותחת ישר את חלון הביקורת:\nhttps://g.page/r/CRSEpD2_CFoDEBI/review\nתודה רבה! 🙏";
  check("review: the exact owner wording, line breaks + emojis, with the first name", RR.reviewMessage("משה כהן") === EXACT);
  check("review: no client name → 'היי,' without a name", RR.reviewMessage("").startsWith("היי, כאן אורי ממיסטר פוליש 😊\n") && RR.reviewMessage(null).split("\n").length === 6);
  check("review: first name — titles dropped, 'משפחת X' kept whole", RR.firstName("גב' רינה לוי") === "רינה" && RR.firstName("משפחת לוי") === "משפחת לוי" && RR.firstName("  דני  ") === "דני");
  check("review: wa.me link WITHOUT a phone number (Miri picks the contact)", /^https:\/\/wa\.me\/\?text=/.test(RR.waUrl(EXACT)) && decodeURIComponent(RR.waUrl(EXACT).split("text=")[1]) === EXACT);
  check("quote → project: the city is the part after the last comma (never the street); service from the description",
    RR.cityFromAddress("הרצל 12, רעננה") === "רעננה" && RR.cityFromAddress("הרצל 12") === null && RR.cityFromAddress("רחוב הגפן 3, קומה 2") === null &&
    RR.serviceFromText("ליטוש והברקה לשיש בסלון") === "marble_stone" && RR.serviceFromText("חידוש בומנייט בחצר") === "bomanite" && RR.serviceFromText("עבודה") === null);

  // =========================================================================
  // 8. the bot: ✅ העבודה בוצעה → the project flow → ⭐ בקשת ביקורת
  // =========================================================================
  reset();
  const states = {};
  BP.init({
    fetchT: (u, i) => global.fetch(u, i),
    supabaseHeaders: () => ({ apikey: "svc-fake", Authorization: "Bearer svc-fake", "Content-Type": "application/json" }),
    supabaseInsert: async (t, row) => { const r = rest(t, "POST", "", row, "return=representation"); return r.body[0]; },
    supabasePatch: async (t, f, b) => rest(t, "PATCH", f, b, ""),
    tgCallSafe: async (method, body) => { tgSent.push({ method, body }); return { message_id: 900 + tgSent.length }; },
    setChatState: async (chat, state, ctx2) => { states[chat] = { state, context: ctx2 }; },
    clearChatState: async (chat) => { delete states[chat]; },
    getChatState: async (chat) => states[chat] || null,
    cbNotice: async (chat, text) => { tgSent.push({ method: "notice", body: { text } }); }
  });
  const Q = { id: uuid(), number: 14, client_name: "דני לוי", address: "הרצל 12, רעננה", description: "ליטוש והברקה לשיש בסלון", job_done_at: null, review_requested_at: null, review_request_count: 0 };
  T.quotes.push(Q);
  const urlBtn = (t) => t.body && t.body.reply_markup && ((t.body.reply_markup.inline_keyboard[0] || [])[0] || {}).url;
  const tap = (data) => ({ data, message: { message_id: 77 } });
  await BP.processJobCallback(tap("j:rev:" + Q.id), 600);
  check("bot: ⭐ before ✅ → 'קודם מסמנים ✅ העבודה בוצעה', nothing recorded", tgSent.some(t => /קודם מסמנים/.test(t.body.text || "")) && !Q.review_requested_at);
  tgSent = [];
  await BP.processJobCallback(tap("j:done:" + Q.id), 600);
  const proj = T.projects.find(p => p.quote_id === Q.id);
  check("bot: ✅ העבודה בוצעה → job_done_at set + '⭐ בקשת ביקורת' offered", !!Q.job_done_at && tgSent.some(t => /סומן: העבודה בוצעה · הצעה מס׳ 014/.test(t.body.text || "") &&
    t.body.reply_markup.inline_keyboard[0][0].callback_data === "j:rev:" + Q.id));
  check("bot: …then the '📸 פרויקט חדש' flow, pre-filled (service + city, never the street) and linked to the quote",
    proj && proj.service === "marble_stone" && proj.city === "רעננה" && proj.source === "telegram" && proj.status === "collecting" && !JSON.stringify(proj).includes("הרצל") &&
    states[600] && states[600].state === "collecting_project" && states[600].context.project_id === proj.id && tgSent.some(t => /פרויקט חדש להצעה מס׳ 014 \(שיש ואבן · רעננה\)/.test(t.body.text || "")));
  tgSent = [];
  await BP.processJobCallback(tap("j:done:" + Q.id), 600);
  check("bot: ✅ again → 'already marked', no second project (offers to continue the open one)", T.projects.filter(p => p.quote_id === Q.id).length === 1 &&
    tgSent.some(t => /כבר סומנה כבוצעה/.test(t.body.text || "")) && tgSent.some(t => /p:cont:/.test(JSON.stringify(t.body.reply_markup || ""))));
  tgSent = [];
  await BP.processJobCallback(tap("j:rev:" + Q.id), 600);
  const rv = tgSent.find(t => urlBtn(t));
  check("bot: ⭐ → the message with the first name + a 'פתיחה בוואטסאפ' URL button (wa.me, no phone)", rv && rv.body.text.includes(RR.reviewMessage("דני לוי")) &&
    rv.body.reply_markup.inline_keyboard[0][0].url === RR.waUrl(RR.reviewMessage("דני לוי")) && !/wa\.me\/\d/.test(rv.body.reply_markup.inline_keyboard[0][0].url));
  check("bot: review_requested_at recorded (+ count); no phone stored", !!Q.review_requested_at && Q.review_request_count === 1 && !Object.keys(Q).some(k => /phone/.test(k)));
  check("bot: the URL button stays well under Telegram's limits", Buffer.byteLength(rv.body.reply_markup.inline_keyboard[0][0].url) < 2048);
  tgSent = [];
  await BP.processJobCallback(tap("j:rev:" + Q.id), 600);
  check("bot: ⭐ again → warns ('כבר נשלחה … לשלוח שוב?') and records nothing yet", tgSent.some(t => /כבר נשלחה בקשת ביקורת/.test(t.body.text || "")) && Q.review_request_count === 1);
  tgSent = [];
  await BP.processJobCallback(tap("j:revok:" + Q.id), 600);
  check("bot: 'כן, לשלוח שוב' → sent again, count 2", Q.review_request_count === 2 && tgSent.some(t => urlBtn(t)));
  check("bot: callback ids are validated (a non-uuid is ignored)", await (async () => { tgSent = []; await BP.processJobCallback(tap("j:done:../x"), 600); return tgSent.length === 0; })());

  // =========================================================================
  // 9. the entry point: POST /api/site?action=publish {project_id, social: true}
  // =========================================================================
  process.env.INTERNAL_API_SECRET = "int-secret-fake";
  const site = require(REPO + "/api/site.js");
  reset();
  P = seedProject({ ai_meta: Object.assign({}, seedProject().ai_meta, { publish_plan: { destinations: ["facebook", "instagram"], timing: "now", at: null } }) }, { video: false });
  T.projects = T.projects.filter(p => p.id === P.id);
  let sr = mkRes();
  await site({ method: "POST", query: { action: "publish" }, headers: { "x-internal-secret": "int-secret-fake", "x-forwarded-for": "10.9.0.1" }, body: { project_id: P.id, social: true } }, sr);
  check("api/site social: no 'site' destination is fine — 200 with the queued posts", sr.code === 200 && sr.body.reason === "no_site" && sr.body.social.queued === 1 && T.content_queue.length === 1, JSON.stringify(sr.body));
  sr = mkRes();
  await site({ method: "POST", query: { action: "publish" }, headers: { "x-forwarded-for": "10.9.0.2" }, body: { project_id: P.id, social: true } }, sr);
  check("api/site social: no session / secret → 401, nothing queued", sr.code === 401 && T.content_queue.length === 1);
  sr = mkRes();
  await site({ method: "POST", query: { action: "publish" }, headers: { "x-internal-secret": "int-secret-fake", "x-forwarded-for": "10.9.0.3" }, body: { project_id: P.id } }, sr);
  check("api/site without social → the site only (the networks are never approved implicitly)", !sr.body.social && T.content_queue.length === 1);

  origLog("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { origLog("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
