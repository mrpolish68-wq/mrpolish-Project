// Phase 5a-2: resolver unit tests (black-box through the handler) + mocked receipt-flow regression.
// EVERY outbound call is mocked (Telegram, Gemini, Supabase REST + Storage). Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
let bg = [];
require.cache[require.resolve(REPO + "/node_modules/@vercel/functions")] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } } };

const PROD = { TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_WEBHOOK_SECRET: "prod-secret-fake", TELEGRAM_ALLOWED_CHATS: "500" };
const TEST = { TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake", TELEGRAM_TEST_ALLOWED_CHATS: "600" };
const ALL_KEYS = Object.keys(PROD).concat(Object.keys(TEST), ["VERCEL_ENV", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_AI_API_KEY"]);

let calls = [];           // { kind, token, method, url, body }
let pending = {};         // id -> row
let expenses = [];
let geminiExtraction = { vendor_name: "סופר דוגמה", date: "2026-10-20", total_amount: 123.45, vat_amount: null, amount_before_vat: null, invoice_number: "A-1", category: "שונות", confidence_notes: "" };
let nextMsgId = 900;

function json(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }

global.fetch = async function (url, init) {
  init = init || {};
  url = String(url);
  const method = init.method || "GET";
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\/(.*)$/))) {
    calls.push({ kind: "tgfile", token: m[1] });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]).buffer };
  }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (m[2] === "getFile") return json(200, { ok: true, result: { file_path: "photos/fake.jpg", file_size: 6 } });
    if (m[2] === "sendMessage") return json(200, { ok: true, result: { message_id: ++nextMsgId } });
    return json(200, { ok: true, result: true });
  }
  if (url.indexOf("generativelanguage.googleapis.com") !== -1) {
    calls.push({ kind: "gemini" });
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(geminiExtraction) }] } }] });
  }
  if (url.indexOf("/storage/v1/object/receipts/") !== -1) {
    calls.push({ kind: "storage", method });
    return json(200, { Key: "receipts/x" });
  }
  if ((m = url.match(/\/rest\/v1\/rpc\/(\w+)$/))) { calls.push({ kind: "rpc", name: m[1] }); return json(200, 10); }
  if ((m = url.match(/\/rest\/v1\/(\w+)(?:\?(.*))?$/))) {
    const table = m[1], qs = m[2] || "";
    calls.push({ kind: "rest", table, method, qs });
    const idm = qs.match(/id=eq\.([^&]+)/);
    const id = idm && decodeURIComponent(idm[1]);
    if (table === "telegram_pending_receipts") {
      if (method === "POST") { const row = Object.assign({ id: "00000000-0000-4000-9000-" + String(++global.__pid || (global.__pid = 1)).padStart(12, "0"), created_at: new Date().toISOString(), claimed_at: null }, body); pending[row.id] = row; return json(201, [row]); }
      if (method === "DELETE") { if (id) delete pending[id]; return json(204, null); }
      if (method === "PATCH") {
        if (!id || !pending[id]) return json(200, []);
        if (/claimed_at\.is\.null/.test(qs) && pending[id].claimed_at) return json(200, []);
        Object.assign(pending[id], body); return json(200, [pending[id]]);
      }
      if (method === "GET") {
        if (id) return json(200, pending[id] ? [pending[id]] : []);
        return json(200, Object.values(pending).filter(r => r.awaiting_edit_field));
      }
    }
    if (table === "business_expenses") {
      if (method === "POST") { expenses.push(body); return json(201, [body]); }
      return json(200, []);
    }
    return json(200, []);
  }
  throw new Error("unmocked fetch: " + url);
};

function setEnv(vars) {
  ALL_KEYS.forEach(k => delete process.env[k]);
  Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "svc-fake", GOOGLE_AI_API_KEY: "g-fake" }, vars);
}

const handler = require(REPO + "/api/telegram-webhook.js");
let updateId = 1;
async function post(secret, update) {
  const out0 = await new Promise(resolve => {
    const out = { status: 0 };
    const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; resolve(out); return res; }, setHeader() {} };
    handler({ method: "POST", headers: secret == null ? {} : { "x-telegram-bot-api-secret-token": secret }, body: Object.assign({ update_id: updateId++ }, update) }, res);
  });
  const p = bg; bg = []; await Promise.all(p);
  return out0;
}
const photo = (chat) => ({ message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat }, photo: [{ file_id: "small" }, { file_id: "big" }] } });
const tap = (chat, data, msgId) => ({ callback_query: { id: "cb" + updateId, data, from: { id: chat }, message: { message_id: msgId, chat: { id: chat } } } });

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); }
const tokensUsed = () => Array.from(new Set(calls.filter(c => c.token).map(c => c.token)));
function reset() { calls = []; pending = {}; expenses = []; }

(async function () {
  const origLog = console.log, origErr = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(" "));

  // ---- resolver: production ----
  reset(); setEnv(Object.assign({ VERCEL_ENV: "production" }, PROD, TEST));
  let r = await post(PROD.TELEGRAM_WEBHOOK_SECRET, photo(500));
  check("production: prod secret accepted + photo processed", r.status === 200 && calls.some(c => c.method === "sendMessage"));
  check("production: only the PROD token is used", JSON.stringify(tokensUsed()) === JSON.stringify([PROD.TELEGRAM_BOT_TOKEN]), tokensUsed().join(","));
  reset(); r = await post(TEST.TELEGRAM_TEST_WEBHOOK_SECRET, photo(500));
  check("production: TEST secret rejected (401)", r.status === 401 && calls.length === 0);
  reset(); r = await post(PROD.TELEGRAM_WEBHOOK_SECRET, photo(600));
  check("production: TEST allowlist ignored (chat 600 silent)", r.status === 200 && calls.filter(c => c.kind === "tg").length === 0);
  reset(); setEnv(Object.assign({ VERCEL_ENV: "production" }, TEST));
  r = await post(TEST.TELEGRAM_TEST_WEBHOOK_SECRET, photo(600));
  check("production with only TEST vars: nothing processed, 200", r.status === 200 && calls.length === 0);

  // ---- resolver: preview with TEST vars ----
  for (const envName of ["preview", undefined]) {
    reset(); setEnv(Object.assign(envName ? { VERCEL_ENV: envName } : {}, PROD, TEST));
    r = await post(TEST.TELEGRAM_TEST_WEBHOOK_SECRET, photo(600));
    const label = envName || "local (no VERCEL_ENV)";
    check(label + ": test secret accepted + photo processed", r.status === 200 && calls.some(c => c.method === "sendMessage"));
    check(label + ": only the TEST token is used", JSON.stringify(tokensUsed()) === JSON.stringify([TEST.TELEGRAM_TEST_BOT_TOKEN]), tokensUsed().join(","));
    reset(); r = await post(PROD.TELEGRAM_WEBHOOK_SECRET, photo(600));
    check(label + ": PROD secret rejected (401)", r.status === 401 && calls.length === 0);
    reset(); r = await post(TEST.TELEGRAM_TEST_WEBHOOK_SECRET, photo(500));
    check(label + ": PROD allowlist ignored (chat 500 silent)", r.status === 200 && calls.filter(c => c.kind === "tg").length === 0);
  }

  // ---- resolver: preview missing TEST vars -> fail closed, never fall back ----
  for (const missing of Object.keys(TEST)) {
    reset();
    const vars = Object.assign({ VERCEL_ENV: "preview" }, PROD, TEST);
    delete vars[missing];
    setEnv(vars);
    r = await post(TEST.TELEGRAM_TEST_WEBHOOK_SECRET, photo(600));
    const r2 = await post(PROD.TELEGRAM_WEBHOOK_SECRET, photo(500));
    check("preview missing " + missing + ": 200, nothing processed, no fallback to PROD", r.status === 200 && r2.status === 200 && calls.length === 0,
      "calls=" + calls.length);
  }
  const leaked = logs.some(l => /PRODFAKE|TESTFAKE|prod-secret-fake|test-secret-fake/.test(l));
  check("no token/secret value in any log line", !leaked);

  // ---- receipt-flow regression (preview config, all mocked) ----
  setEnv(Object.assign({ VERCEL_ENV: "preview" }, PROD, TEST));
  const S = TEST.TELEGRAM_TEST_WEBHOOK_SECRET, CHAT = 600;
  reset();
  r = await post(S, photo(CHAT));
  const summary = calls.find(c => c.method === "sendMessage");
  const pid = Object.keys(pending)[0];
  check("photo -> Gemini once, file uploaded, pending row, summary with buttons",
    calls.filter(c => c.kind === "gemini").length === 1 && calls.some(c => c.kind === "storage" && c.method === "POST") && pid &&
    summary && summary.body.reply_markup && JSON.stringify(summary.body.reply_markup).indexOf("confirm:" + pid) !== -1);
  check("summary shows the extracted amount", summary && /123\.45|123/.test(summary.body.text));
  check("message_id saved on the pending row", pending[pid] && pending[pid].message_id === nextMsgId);

  // cycle category
  const before = pending[pid].extracted.category;
  calls = [];
  r = await post(S, tap(CHAT, "cyclecat:" + pid, nextMsgId));
  check("category cycle -> category changed + message edited", pending[pid].extracted.category !== before &&
    calls.some(c => c.method === "editMessageText"), before + " -> " + pending[pid].extracted.category);

  // cancel
  calls = [];
  r = await post(S, tap(CHAT, "cancel:" + pid, nextMsgId));
  check("cancel -> pending deleted, storage file deleted, message edited 'בוטל'", !pending[pid] &&
    calls.some(c => c.kind === "storage" && c.method === "DELETE") &&
    calls.some(c => c.method === "editMessageText" && /בוטל/.test(c.body.text)) && expenses.length === 0);

  // confirm on a fresh receipt
  calls = [];
  await post(S, photo(CHAT));
  const pid2 = Object.keys(pending).find(k => k !== pid);
  calls = [];
  await post(S, tap(CHAT, "confirm:" + pid2, nextMsgId));
  check("confirm -> one business_expenses insert, pending deleted, 'נשמר'", expenses.length === 1 && !pending[pid2] &&
    calls.some(c => c.method === "editMessageText" && /נשמר/.test(c.body.text)));
  // double tap after it's gone
  calls = [];
  await post(S, tap(CHAT, "confirm:" + pid2, nextMsgId));
  check("second confirm tap -> no second insert", expenses.length === 1);

  // missing amount refusal
  geminiExtraction = Object.assign({}, geminiExtraction, { total_amount: null });
  calls = [];
  await post(S, photo(CHAT));
  const pid3 = Object.keys(pending).find(k => k !== pid && k !== pid2);
  calls = [];
  await post(S, tap(CHAT, "confirm:" + pid3, nextMsgId));
  check("missing amount -> confirm refused, nothing saved", expenses.length === 1 && calls.some(c => c.method === "sendMessage" && /חסר סכום/.test(c.body.text || "")));

  // wrong secret / GET
  r = await post("nope", photo(CHAT));
  check("wrong secret -> 401", r.status === 401);
  check("everything in the regression used the TEST token only", calls.every(c => !c.token || c.token === TEST.TELEGRAM_TEST_BOT_TOKEN));

  console.error = origErr;
  origLog("\n" + pass + "/" + (pass + fail) + " passed");
  if (fail) process.exitCode = 1;
})();
