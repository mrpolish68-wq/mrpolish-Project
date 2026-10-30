// api/panel.js (media-projects Phase 2): the five panel endpoints merged into one function.
// Proves, offline, that every action behaves EXACTLY like its original handler (same status +
// body for: no session, wrong method, invalid session, authenticated read-only paths), that the
// rate limits keep their names/budgets, and that vercel.json routes every old URL to it.
// Every outbound call is mocked (Supabase Auth/REST, Graph API). Fake values only.
"use strict";
const path = require("path");
const fs = require("fs");
const REPO = path.resolve(__dirname, "..");
require.cache[require.resolve(REPO + "/node_modules/@vercel/functions")] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: () => {} } };
// analytics-refresh runs the whole agent; stub runAgent so this stays offline and fast.
require.cache[require.resolve(REPO + "/api/analytics-agent.js")] = { id: "aa", filename: "aa", loaded: true,
  exports: Object.assign(function () {}, { runAgent: async () => ({ ok: true, stub: true, errors: [] }) }) };

Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "svc-fake", META_PAGE_ACCESS_TOKEN: "meta-fake", META_PAGE_ID: "PAGE1", META_IG_USER_ID: "IGU1" });

const ROW = { id: "11111111-1111-4111-8111-111111111111", status: "approved", platform: "both", pin_requested: false, fb_post_id: null, scheduled_for: new Date(Date.now() + 86400000).toISOString() };
function json(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
global.fetch = async function (url, init) {
  url = String(url);
  if (/\/auth\/v1\/user$/.test(url)) {
    const auth = (init && init.headers && init.headers.Authorization) || "";
    return auth === "Bearer good-session" ? json(200, { id: "user-1" }) : json(401, { msg: "invalid" });
  }
  if (/\/rest\/v1\/content_queue\?id=eq\./.test(url)) {
    const id = decodeURIComponent(url.match(/id=eq\.([^&]+)/)[1]);
    return json(200, id === ROW.id ? [ROW] : []);
  }
  if (url.startsWith("https://graph.facebook.com/")) {
    if (/\/posts\?/.test(url)) return json(200, { data: [{ id: "P1", created_time: "2026-10-30T10:00:00+0000", message: "m", likes: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } }] });
    if (/\/media\?/.test(url)) return json(200, { data: [{ id: "M1", timestamp: "2026-10-29T10:00:00+0000", caption: "c", like_count: 2, comments_count: 0 }] });
    return json(200, { followers_count: 306, username: "x" });
  }
  throw new Error("unmocked fetch: " + url);
};
console.log = () => {}; console.error = () => {};
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

const panel = require(REPO + "/api/panel.js");
const DIRECT = {
  "publish-now": require(REPO + "/api/_publish-now.js"),
  "check-publish-status": require(REPO + "/api/_check-publish-status.js"),
  "check-pin-status": require(REPO + "/api/_check-pin-status.js"),
  "social-snapshot": require(REPO + "/api/_social-snapshot.js"),
  "analytics-refresh": require(REPO + "/api/_analytics-refresh.js")
};

let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; out("PASS " + name); } else out("FAIL " + name + (detail ? "  -- " + detail : "")); }
function mkRes() { return { code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } }; }
let ip = 0;
async function call(handler, method, opts) {
  opts = opts || {};
  const res = mkRes();
  const headers = Object.assign({ "x-forwarded-for": opts.ip || ("10.1.0." + (++ip)) }, opts.auth ? { authorization: opts.auth } : {});
  await handler({ method, headers, body: opts.body || {}, query: opts.query || {} }, res);
  return res;
}
const viaPanel = (action) => (req, res) => panel(Object.assign({}, req, { query: Object.assign({}, req.query, { action }) }), res);
const same = (a, b) => a.code === b.code && JSON.stringify(a.body) === JSON.stringify(b.body);

(async function main() {
  const POST_ONLY = ["publish-now", "check-publish-status", "check-pin-status", "analytics-refresh"];
  const METHOD = { "publish-now": "POST", "check-publish-status": "POST", "check-pin-status": "POST", "analytics-refresh": "POST", "social-snapshot": "GET" };

  for (const action of Object.keys(DIRECT)) {
    const d = DIRECT[action], p = viaPanel(action), m = METHOD[action];
    // no session
    let a = await call(d, m), b = await call(p, m);
    check(action + ": no session → identical (" + a.code + ")", a.code === 401 && same(a, b), JSON.stringify([a.body, b.body]));
    // invalid session
    a = await call(d, m, { auth: "Bearer bad" }); b = await call(p, m, { auth: "Bearer bad" });
    check(action + ": invalid session → identical (" + a.code + ")", a.code === 401 && same(a, b), JSON.stringify([a.body, b.body]));
    // wrong method
    if (POST_ONLY.includes(action)) {
      a = await call(d, "GET"); b = await call(p, "GET");
      check(action + ": wrong method (GET) → identical 405", a.code === 405 && same(a, b), JSON.stringify([a.body, b.body]));
    }
  }
  check("social-snapshot: no method check, as before (POST without a session → 401, not 405)", (await call(viaPanel("social-snapshot"), "POST")).code === 401);

  // authenticated, read-only paths (nothing is published or written)
  const G = "Bearer good-session";
  let a = await call(DIRECT["publish-now"], "POST", { auth: G }), b = await call(viaPanel("publish-now"), "POST", { auth: G });
  check("publish-now + session, no id → identical 400 'Missing content id.' (returns before any publish)", a.code === 400 && same(a, b), JSON.stringify(b.body));
  const missing = { id: "22222222-2222-4222-8222-222222222222" };
  for (const action of ["publish-now", "check-publish-status", "check-pin-status"]) {
    a = await call(DIRECT[action], "POST", { auth: G, body: missing }); b = await call(viaPanel(action), "POST", { auth: G, body: missing });
    check(action + " + session, unknown id → identical 404", a.code === 404 && same(a, b), JSON.stringify(b.body));
  }
  a = await call(DIRECT["check-publish-status"], "POST", { auth: G, body: { id: ROW.id } }); b = await call(viaPanel("check-publish-status"), "POST", { auth: G, body: { id: ROW.id } });
  check("check-publish-status + session, an approved row → identical 409", a.code === 409 && same(a, b), JSON.stringify(b.body));
  a = await call(DIRECT["check-pin-status"], "POST", { auth: G, body: { id: ROW.id } }); b = await call(viaPanel("check-pin-status"), "POST", { auth: G, body: { id: ROW.id } });
  check("check-pin-status + session, a row not marked for pinning → identical 409", a.code === 409 && same(a, b), JSON.stringify(b.body));
  a = await call(DIRECT["social-snapshot"], "GET", { auth: G }); b = await call(viaPanel("social-snapshot"), "GET", { auth: G });
  check("social-snapshot + session → identical 200 {facebook, instagram, posts}", a.code === 200 && same(a, b) &&
    JSON.stringify(Object.keys(b.body)) === '["facebook","instagram","posts"]' && b.body.posts.length === 2, JSON.stringify(b.body).slice(0, 120));
  a = await call(DIRECT["analytics-refresh"], "POST", { auth: G }); b = await call(viaPanel("analytics-refresh"), "POST", { auth: G });
  check("analytics-refresh + session → identical 200 (runAgent result)", a.code === 200 && same(a, b), JSON.stringify(b.body));

  // router
  let r = await call(panel, "POST", { query: { action: "nope" } });
  check("unknown action → 404", r.code === 404 && r.body.error === "Not found");
  r = await call(panel, "POST", {});
  check("no action → 404", r.code === 404);
  r = await call(panel, "POST", { query: { action: "__proto__" } });
  check("prototype keys are not actions → 404", r.code === 404);
  check("ACTIONS lists exactly the five old endpoints", JSON.stringify(panel.ACTIONS.slice().sort()) === JSON.stringify(Object.keys(DIRECT).sort()));

  // rate limits: same names + budgets, and each action keeps its own bucket
  const RL = { "publish-now": 20, "check-publish-status": 30, "check-pin-status": 30, "social-snapshot": 20, "analytics-refresh": 5 };
  for (const action of Object.keys(RL)) {
    const who = "10.9.9." + Object.keys(RL).indexOf(action);
    let last;
    for (let i = 0; i < RL[action] + 1; i++) last = await call(viaPanel(action), METHOD[action], { ip: who });
    const before = await call(viaPanel(action === "publish-now" ? "check-pin-status" : "publish-now"), "POST", { ip: who });
    check(action + ": rate limit still " + RL[action] + "/min (call " + (RL[action] + 1) + " → 429), other actions unaffected", last.code === 429 && before.code !== 429, last.code + " / " + before.code);
  }

  // vercel.json + function count
  const vj = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
  const OLD = Object.keys(DIRECT);
  check("vercel.json: a rewrite for every old URL → /api/panel?action=<same name>", OLD.every(n => (vj.rewrites || []).some(rw => rw.source === "/api/" + n && rw.destination === "/api/panel?action=" + n)));
  check("vercel.json: every functions entry matches an existing file (else the build fails)", Object.keys(vj.functions).every(f => fs.existsSync(path.join(REPO, f))), Object.keys(vj.functions).join(", "));
  check("vercel.json: api/panel.js has maxDuration 60", vj.functions["api/panel.js"] && vj.functions["api/panel.js"].maxDuration === 60);
  check("the old function files are gone (no route would shadow the rewrites)", OLD.every(n => !fs.existsSync(path.join(REPO, "api", n + ".js"))));
  const fns = fs.readdirSync(path.join(REPO, "api")).filter(f => f.endsWith(".js") && !f.startsWith("_")).sort();
  check("functions: exactly 8 (≤ 12 on Hobby)", fns.length === 8, fns.join(", "));
  check("functions: the expected 8", JSON.stringify(fns) === JSON.stringify(["analytics-agent.js", "csp-report.js", "media.js", "panel.js", "parse-receipt.js", "publish-scheduled-content.js", "render-quote-pdf.js", "telegram-webhook.js"]), fns.join(", "));

  out("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { out("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
