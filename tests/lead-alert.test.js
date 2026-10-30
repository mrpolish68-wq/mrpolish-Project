// Lead alert (api/_lead-alert.js via POST /api/analytics-agent?task=lead-alert): auth, the message
// format + buttons, idempotency (claim on notified_at), release on failure, sweep, and that the
// daily agent path is unchanged. Every outbound call is mocked (Supabase REST, Telegram). Fake values.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
require.cache[require.resolve(REPO + "/node_modules/@vercel/functions")] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: () => {} } };

const ENV = { SUPABASE_SERVICE_ROLE_KEY: "svc-fake", DB_WEBHOOK_SECRET: "db-hook-fake", CRON_SECRET: "cron-fake",
  TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_ALLOWED_CHATS: "500, 501", TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_ALLOWED_CHATS: "600" };
function setEnv(extra) {
  ["VERCEL_ENV"].concat(Object.keys(ENV)).forEach(k => delete process.env[k]);
  Object.assign(process.env, ENV, extra || {});
}

let leads, tg, patches, gets, tgMode, agentRuns;
function reset() {
  leads = {}; tg = []; patches = []; gets = []; tgMode = "ok"; agentRuns = 0;
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
    tg.push({ token: m[1], method: m[2], body });
    if (tgMode === "down") throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    return json(200, { ok: true, result: { message_id: 1 } });
  }
  if ((m = url.match(/\/rest\/v1\/leads\?(.*)$/))) {
    const qs = decodeURIComponent(m[1]);
    const idm = qs.match(/(?:^|&)id=eq\.(\d+)/);
    if (method === "GET") {
      gets.push(qs);
      if (idm) return json(200, leads[idm[1]] ? [Object.assign({}, leads[idm[1]])] : []);
      const gte = new Date(qs.match(/created_at=gte\.([^&]+)/)[1]), lte = new Date(qs.match(/created_at=lte\.([^&]+)/)[1]);
      return json(200, Object.values(leads).filter(l => l.notified_at === null && new Date(l.created_at) >= gte && new Date(l.created_at) <= lte)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 10).map(l => ({ id: l.id })));
    }
    if (method === "PATCH") {
      patches.push({ qs, body });
      const l = idm && leads[idm[1]];
      if (!l) return json(200, []);
      if (/notified_at=is\.null/.test(qs) && l.notified_at !== null) return json(200, []);
      const eq = qs.match(/notified_at=eq\.([^&]+)/);
      if (eq && l.notified_at !== eq[1]) return json(200, []);
      Object.assign(l, body);
      return json(200, [Object.assign({}, l)]);
    }
  }
  throw new Error("unmocked fetch: " + method + " " + url);
};
const logs = [];
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

// the real handler (no stubs): ?task=lead-alert, and the no-task daily path for its auth check
const agent = require(REPO + "/api/analytics-agent.js");
const LA = require(REPO + "/api/_lead-alert.js");

let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; out("PASS " + name); } else out("FAIL " + name + (detail ? "  -- " + detail : "")); }
function mkRes() { return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} }; }
async function call(opts) {
  const res = mkRes();
  await agent({ method: opts.method || "POST", headers: opts.headers || { "x-internal-secret": "db-hook-fake" }, body: opts.body || {}, query: { task: opts.task === undefined ? "lead-alert" : opts.task } }, res);
  return res;
}
function addLead(id, extra) {
  leads[id] = Object.assign({ id: id, created_at: new Date(Date.now() - 5 * 60000).toISOString(), name: "דנה כהן", phone: "050-1234567",
    service: "ליטוש שיש ואבן טבעית", location: "בית שמש", notes: "יש לי רצפת שיש בסלון\n[הסכמה לדיוור שיווקי: לא]", notified_at: null }, extra);
}
const btns = (m) => m.body.reply_markup.inline_keyboard.map(r => r.length + ":" + r[0].text + "|" + r[0].url);

(async function main() {
  setEnv({ VERCEL_ENV: "production" });

  // ---- auth / method / input ----
  let r = await call({ method: "GET" });
  check("GET → 405", r.code === 405);
  r = await call({ headers: {} });
  check("no secret → 401", r.code === 401 && r.body.error === "Unauthorized");
  r = await call({ headers: { "x-internal-secret": "wrong" } });
  check("wrong secret → 401", r.code === 401);
  r = await call({ headers: { "x-internal-secret": "cron-fake" } });
  check("the CRON_SECRET is NOT accepted here (dedicated secret)", r.code === 401);
  r = await call({ headers: { authorization: "Bearer cron-fake" } });
  check("…nor as a Bearer header", r.code === 401);
  setEnv({ VERCEL_ENV: "production", DB_WEBHOOK_SECRET: "" });
  r = await call({});
  check("DB_WEBHOOK_SECRET unset → 401 (fails closed)", r.code === 401);
  setEnv({ VERCEL_ENV: "production" });
  r = await call({ body: { id: "1; drop table" } });
  check("a non-numeric id → 400", r.code === 400);
  r = await call({ body: { id: 99 } });
  check("unknown lead → 404, nothing sent", r.code === 404 && tg.length === 0);
  r = await call({ task: "nope" });
  check("an unknown task → 404", r.code === 404);

  // ---- success ----
  reset(); addLead("41");
  r = await call({ body: { id: 41 } });
  check("success → 200 {status: sent, chats: 2}", r.code === 200 && r.body.status === "sent" && r.body.chats === 2, JSON.stringify(r.body));
  check("one message per allowed production chat (500, 501), production bot", tg.length === 2 && tg.every(x => x.token === "111:PRODFAKE") &&
    tg.map(x => String(x.body.chat_id)).join(",") === "500,501");
  const msg = tg[0];
  const lines = msg.body.text.split("\n");
  check("format: header, separator, name, phone, service, location, message (no consent tag), time",
    lines[0] === "🔔 ליד חדש מהאתר" && lines[1] === "━━━━━━━━━━" && lines[2] === "👤 דנה כהן" && lines[3] === "📞 050-1234567" &&
    lines[4] === "🛠️ ליטוש שיש ואבן טבעית" && lines[5] === "📍 בית שמש" && lines[6] === "💬 יש לי רצפת שיש בסלון" && /^🕐 \d\d\.\d\d · \d\d:\d\d$/.test(lines[7]) && lines.length === 8,
    JSON.stringify(lines));
  check("format: plain text (no parse_mode), link previews off, no raw URL in the text", !("parse_mode" in msg.body) && msg.body.disable_web_page_preview === true && !/https?:\/\//.test(msg.body.text));
  const b = btns(msg);
  check("buttons: 💬 וואטסאפ (wa.me/972501234567 + a greeting) and 🗂️ פתח בפאנל", b.length === 2 &&
    /^1:💬 וואטסאפ\|https:\/\/wa\.me\/972501234567\?text=/.test(b[0]) && b[1] === "1:🗂️ פתח בפאנל|https://mr-polishes.com/admin.html", b.join(" | "));
  check("the WhatsApp greeting uses the first name", decodeURIComponent(b[0].split("text=")[1]) === "היי דנה, כאן מיסטר פוליש 👋 קיבלנו את הפנייה שלך מהאתר.");
  check("notified_at set with a conditional claim (only while NULL)", leads["41"].notified_at !== null && patches.length === 1 && /notified_at=is\.null/.test(patches[0].qs));
  check("the time line is the lead's own time (Israel)", lines[7] === "🕐 " + require(REPO + "/api/_publish-notify.js").formatIsraelTime(new Date(leads["41"].created_at)));

  // ---- idempotent ----
  tg = [];
  r = await call({ body: { id: 41 } });
  check("a second call for the same lead → 200 already_notified, nothing sent", r.code === 200 && r.body.status === "already_notified" && tg.length === 0);

  // ---- preview → test bot ----
  reset(); setEnv({ VERCEL_ENV: "preview" }); addLead("42");
  await call({ body: { id: "42" } });
  check("preview → the TEST bot to the test chat", tg.length === 1 && tg[0].token === "222:TESTFAKE" && String(tg[0].body.chat_id) === "600");
  setEnv({ VERCEL_ENV: "production" });

  // ---- optional fields / phones ----
  reset(); addLead("43", { location: null, notes: "[הסכמה לדיוור שיווקי: כן]", phone: "+972 52-953-4540" });
  await call({ body: { id: 43 } });
  const l43 = tg[0].body.text.split("\n");
  check("no location / empty message → those lines are left out", !l43.some(x => x.startsWith("📍")) && !l43.some(x => x.startsWith("💬")) && l43.length === 6, JSON.stringify(l43));
  check("+972 phone → wa.me/972529534540", /wa\.me\/972529534540\?/.test(btns(tg[0])[0]));
  check("waNumber: 050… / 0501234567 / 00972… / landline 02… / junk",
    LA.waNumber("050-123-4567") === "972501234567" && LA.waNumber("00972501234567") === "972501234567" && LA.waNumber("02-5551234") === "97225551234" &&
    LA.waNumber("12345") === null && LA.waNumber("") === null);
  reset(); addLead("44", { phone: "abc" });
  await call({ body: { id: 44 } });
  check("a phone that isn't Israeli → no WhatsApp button, the panel button stays", btns(tg[0]).length === 1 && /פתח בפאנל/.test(btns(tg[0])[0]));
  reset(); addLead("45", { name: "\u202Eשם\u0007 " + "ארוך ".repeat(30), notes: "x".repeat(900) });
  await call({ body: { id: 45 } });
  const l45 = tg[0].body.text.split("\n");
  check("names/messages are cleaned (control + bidi chars removed) and cut (60 / 500 chars)", l45[2].length <= 63 && l45[2].endsWith("…") && !/[\u0000-\u001f\u202e]/.test(l45[2]) && l45.find(x => x.startsWith("💬")).length <= 503, l45[2]);

  // ---- Telegram down → release the claim, 502, a later sweep retries ----
  reset(); addLead("46"); tgMode = "down";
  r = await call({ body: { id: 46 } });
  check("Telegram down → 502 not_delivered", r.code === 502 && r.body.status === "not_delivered");
  check("…and the claim is released (notified_at back to NULL, only our own claim)", leads["46"].notified_at === null && patches.length === 2 && /notified_at=eq\./.test(patches[1].qs));
  tgMode = "ok";
  r = await call({ body: {} });
  check("sweep → re-sends it", r.code === 200 && r.body.swept === 1 && r.body.results[0].status === "sent" && leads["46"].notified_at !== null && tg.length === 4, JSON.stringify(r.body));

  // ---- sweep window ----
  reset();
  addLead("50", { created_at: new Date(Date.now() - 20 * 1000).toISOString() });          // too new (trigger's turn)
  addLead("51", { created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() });   // older than 24 h
  addLead("52", { created_at: new Date(Date.now() - 10 * 60000).toISOString() });         // due
  addLead("53", { created_at: new Date(Date.now() - 9 * 60000).toISOString(), notified_at: "2026-10-30T10:00:00Z" });
  r = await call({ body: {} });
  check("sweep: only the un-notified lead between 1 minute and 24 hours old", r.body.swept === 1 && r.body.results[0].id === "52" && leads["50"].notified_at === null && leads["51"].notified_at === null, JSON.stringify(r.body));

  // ---- no bot configured ----
  reset(); setEnv({ VERCEL_ENV: "production", TELEGRAM_BOT_TOKEN: "" }); addLead("60");
  r = await call({ body: { id: 60 } });
  check("no bot configured → 502, claim released (retried once it is)", r.code === 502 && leads["60"].notified_at === null);
  setEnv({ VERCEL_ENV: "production" });

  // ---- the daily agent path is unchanged ----
  r = await call({ task: "", headers: {} });
  check("no task + no CRON_SECRET → 401 (the daily agent's auth, unchanged)", r.code === 401 && r.body.error === "Unauthorized");
  check("the lead-alert secret does NOT open the daily agent", (await call({ task: "", headers: { "x-internal-secret": "db-hook-fake" } })).code === 401);

  // ---- logs ----
  check("logs: no names, phones, messages or secrets", !logs.some(l => /דנה|כהן|050|1234567|רצפת|PRODFAKE|TESTFAKE|db-hook-fake|svc-fake/.test(l)), logs.filter(l => /דנה|050|fake/i.test(l)).slice(0, 2).join(" | "));

  out("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { out("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
