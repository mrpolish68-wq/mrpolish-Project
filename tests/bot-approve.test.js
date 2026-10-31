// Phase 5d harness: approve → create_quote → PDF → sendDocument, failures/retry/422, 📜 recent,
// 🔍 search, 📄 resend. EVERYTHING is mocked (no live quotes, no real network). Fake values only.
"use strict";
const path = require("path");
const fs = require("fs");
const REPO = path.resolve(__dirname, "..");

let bg = [];
require.cache[require.resolve(path.join(REPO, "node_modules/@vercel/functions"))] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } } };

const BASE_ENV = {
  VERCEL_ENV: "preview", VERCEL_URL: "branch-preview-fake.vercel.app",
  INTERNAL_API_SECRET: "internal-secret-fake-0123456789abcdef0123456789", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-fake",
  TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake",
  TELEGRAM_TEST_ALLOWED_CHATS: Array.from({ length: 40 }, (_, i) => String(800 + i)).join(","),
  SUPABASE_SERVICE_ROLE_KEY: "svc-fake", GOOGLE_AI_API_KEY: "g-fake"
};
Object.assign(process.env, BASE_ENV);
let SECRET = "test-secret-fake";

// ---------- mocks ----------
const db = { telegram_pending_receipts: [], telegram_pending_quotes: [], telegram_processed_updates: [], telegram_chat_state: [], telegram_daily_usage: [], business_expenses: [], quotes: [], quote_counter: [{ id: true, floor_next: 14 }] };
let quotaRemaining = { receipt: 20, quote: 15 };
let calls = [];
let nextId = 1, nextMsgId = 7000;
let geminiQueue = [];
let renderMode = "ok";        // ok | 500 | 422
let sendDocMode = "ok";       // ok | fail
let storedDownloadOk = true;
let createQuoteFail = false;
let createQuoteMode = "idempotent"; // "idempotent" = after supabase-quotes-idempotency.sql; "legacy" = the function before it (ignores client_ref)
let loseCreateResponseOnce = false;  // create_quote commits, then the response is lost (network error)
let failQuoteIdPatchOnce = false;    // saving quote_id on the draft fails once
const uuid = () => "00000000-0000-4000-8000-" + String(nextId++).padStart(12, "0");

function parseFilters(qs) {
  const out = [];
  for (const part of (qs || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(part.slice(0, eq)), val = decodeURIComponent(part.slice(eq + 1));
    if (["select", "order", "limit", "on_conflict"].includes(key)) { out[key] = val; continue; }
    if (key === "or") { out.push({ or: val }); continue; }
    out.push({ col: key, op: val });
  }
  return out;
}
function likeToRe(pat) { // PostgREST ilike: * = %, LIKE escapes \% \_ \\
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i];
    if (ch === "\\" && i + 1 < pat.length) { re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (ch === "*" || ch === "%") re += ".*"; else if (ch === "_") re += "."; else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}
function match(row, f) {
  if (f.or) { const m = f.or.match(/claimed_at\.lt\.(.+)\)$/); return row.claimed_at == null || (m && row.claimed_at < m[1]); }
  const v = row[f.col], op = f.op;
  if (op === "not.is.null") return v != null;
  if (op === "is.null") return v == null;
  let m = op.match(/^ilike\.(.*)$/); if (m) return v != null && likeToRe(m[1]).test(String(v));
  m = op.match(/^in\.\((.*)\)$/); if (m) return m[1].split(",").includes(String(v));
  m = op.match(/^(eq|gte|lt|gt|lte)\.(.*)$/);
  if (!m) return true;
  if (m[1] === "eq") return String(v) === m[2];
  if (m[1] === "gte") return v != null && String(v) >= m[2];
  if (m[1] === "lt") return v != null && String(v) < m[2];
  if (m[1] === "gt") return v != null && String(v) > m[2];
  if (m[1] === "lte") return v != null && String(v) <= m[2];
}
function rowsFor(table, filters) {
  let rows = db[table].filter(r => filters.every(f => match(r, f)));
  if (filters.order) { const [c, dir] = filters.order.split("."); rows.sort((x, y) => (x[c] < y[c] ? -1 : 1) * (dir === "desc" ? -1 : 1)); }
  if (filters.limit) rows = rows.slice(0, +filters.limit);
  return rows;
}
const R = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array(Buffer.from(String(body))).buffer });
const clone = (o) => JSON.parse(JSON.stringify(o));

const unsignaled = []; // L2: every outbound request must carry an AbortSignal
let createQuoteTimeoutOnce = false;
global.fetch = async function (url, init) {
  init = init || {}; url = String(url);
  if (!init.signal) unsignaled.push(url.replace(/^https:\/\/([^/]+).*/, "$1") + " " + (init.method || "GET"));
  const method = init.method || "GET";
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendDocument$/))) {
    const form = init.body;
    const doc = form.get("document");
    const bytes = Buffer.from(await doc.arrayBuffer()).toString();
    calls.push({ kind: "tg", method: "sendDocument", token: m[1], chat_id: form.get("chat_id"), caption: form.get("caption"), filename: doc.name, type: doc.type, bytes });
    if (sendDocMode === "fail") return R(400, { ok: false, description: "Bad Request: fake" });
    return R(200, { ok: true, result: { message_id: ++nextMsgId } });
  }
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (m[2] === "sendMessage") return R(200, { ok: true, result: { message_id: ++nextMsgId } });
    return R(200, { ok: true, result: true });
  }
  if ((m = url.match(/^https:\/\/([^/]+)\/api\/render-quote-pdf$/))) {
    calls.push({ kind: "render", host: m[1], headers: init.headers, body, redirect: init.redirect });
    if (renderMode === "500") return R(500, { error: "render_failed" });
    if (renderMode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (renderMode === "422") return R(422, { error: "too_long", lines: 18, maxLines: 15 });
    const q = db.quotes.find(x => x.id === body.quote_id);
    if (q) q.pdf_path = q.id + ".pdf";
    return R(200, "%PDF-rendered-" + body.quote_id);
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const isShorten = init.body.includes("description_lines") && !init.body.includes("stated_total");
    calls.push({ kind: "gemini", shorten: isShorten });
    return R(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(geminiQueue.shift()) }] } }] });
  }
  if ((m = url.match(/\/storage\/v1\/object\/quotes-pdf\/(.+)$/))) {
    calls.push({ kind: "storage", method, path: m[1] });
    if (!storedDownloadOk) return R(404, { message: "not found" });
    return R(200, "%PDF-stored-" + m[1]);
  }
  if ((m = url.match(/\/rest\/v1\/rpc\/(\w+)$/))) {
    calls.push({ kind: "rpc", name: m[1], body });
    if (m[1] === "create_quote") {
      if (createQuoteFail) return R(500, { code: "XX000", message: "Failing row contains (secret-pii)" });
      if (createQuoteTimeoutOnce) { createQuoteTimeoutOnce = false; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }
      const p = body.p;
      if (createQuoteMode === "idempotent" && p.client_ref) {
        const existing = db.quotes.find(q => q.client_ref === p.client_ref);
        if (existing) { calls.push({ kind: "createReturnedExisting", id: existing.id }); return R(200, existing); }
      }
      const max = db.quotes.reduce((a, q) => Math.max(a, q.number), 0);
      const number = Math.max(max + 1, db.quote_counter[0].floor_next);
      const row = { id: uuid(), number, quote_date: p.quote_date, client_name: p.client_name, address: p.address, description: p.description, total: p.total, source: p.source, vat_mode: p.vat_mode, telegram_chat_id: p.telegram_chat_id, pdf_path: null,
        client_ref: createQuoteMode === "idempotent" ? (p.client_ref || null) : null };
      db.quotes.push(row); db.quote_counter[0].floor_next = Math.max(db.quote_counter[0].floor_next, number + 1);
      if (loseCreateResponseOnce) { loseCreateResponseOnce = false; throw new Error("socket hang up (response lost after commit)"); }
      return R(200, row);
    }
    const k = body.p_kind;
    if (m[1] === "get_daily_quota_remaining") return R(200, quotaRemaining[k]);
    if (quotaRemaining[k] <= 0) return R(200, -1);
    quotaRemaining[k]--; return R(200, quotaRemaining[k]);
  }
  if ((m = url.match(/\/rest\/v1\/(\w+)(?:\?(.*))?$/))) {
    const table = m[1], qs = m[2] || "";
    calls.push({ kind: "rest", table, method, qs, body });
    const f = parseFilters(qs);
    if (method === "POST") {
      if (table === "telegram_processed_updates") { if (db[table].some(r => r.update_id === body.update_id)) return R(409, {}); db[table].push({ update_id: body.update_id, created_at: new Date().toISOString() }); return R(201, null); }
      if (table === "telegram_chat_state") { db[table] = db[table].filter(r => r.chat_id !== body.chat_id); db[table].push(clone(body)); return R(201, null); }
      const row = Object.assign({ id: uuid(), created_at: new Date(Date.now() + nextId).toISOString(), claimed_at: null, voice_corrections: 0, quote_id: null }, clone(body));
      db[table].push(row); return R(201, [row]);
    }
    if (method === "GET") return R(200, rowsFor(table, f));
    if (method === "PATCH") {
      if (table === "telegram_pending_quotes" && body && "quote_id" in body && failQuoteIdPatchOnce) { failQuoteIdPatchOnce = false; return R(500, {}); }
      const rows = rowsFor(table, f);
      rows.forEach(r => { Object.assign(r, clone(body)); if (table === "quotes" && "description" in body) r.pdf_path = null; }); // mimics the trigger
      return R(200, rows);
    }
    if (method === "DELETE") { const del = rowsFor(table, f); db[table] = db[table].filter(r => !del.includes(r)); return R(204, null); }
  }
  throw new Error("unmocked " + url);
};

const logs = [];
const origLog = console.log;
console.error = (...a) => logs.push(a.join(" "));
console.log = (...a) => { const s = a.join(" "); if (s.startsWith("[")) logs.push(s); else origLog(s); };
const handler = require(REPO + "/api/telegram-webhook.js");

let updateId = 20000;
function postNoWait(update) {
  return new Promise(resolve => {
    const r = { status() { return r; }, json() { resolve(); return r; }, setHeader() {} };
    handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: Object.assign({ update_id: ++updateId }, update) }, r);
  });
}
async function post(update) { await postNoWait(update); const p = bg; bg = []; await Promise.all(p); }
const text = (chat, t) => ({ message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat }, text: t } });
const tap = (chat, data, mid) => ({ callback_query: { id: "cb" + updateId, data, from: { id: chat }, message: { message_id: mid || 1, chat: { id: chat } } } });

const sends = () => calls.filter(c => c.kind === "tg" && (c.method === "sendMessage" || c.method === "editMessageText"));
const last = () => sends().slice(-1)[0];
const txt = (c) => (c && c.body && c.body.text) || "";
const btns = (c) => ((c && c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat();
const btn = (c, prefix) => (btns(c).find(b => b.callback_data.startsWith(prefix)) || {}).callback_data;
const draftOf = (chat) => db.telegram_pending_quotes.find(r => r.chat_id === chat);
const count = (pred) => calls.filter(pred).length;
const docs = () => calls.filter(c => c.method === "sendDocument");
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else fail++; origLog((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); }
const reset = () => { calls = []; };

function gq(o) { return Object.assign({ client_name: null, address: null, items: [], stated_total: null, stated_total_evidence: null, quote_date: null, description_lines: [], transcript: "", missing: [] }, o); }
const FULL = gq({ client_name: "דני לוי", address: "הרצל 12 רעננה", items: [{ service: "ליטוש שיש", area_m2: 40, unit_price: 80 }, { service: "סילר", quantity: 1, unit_price: 1300 }],
  stated_total: 4500, stated_total_evidence: "סה\"כ 4,500", description_lines: ["1. ליטוש שיש 40 מ\"ר", "2. מריחת סילר הגנה"] });
const FULL_TEXT = "הצעת מחיר לדני לוי הרצל 12 רעננה ליטוש 40 מטר 80 שקל סילר 1,300 סה\"כ 4,500";
async function makeDraft(chat, resp) { geminiQueue.push(resp || FULL); await post(text(chat, FULL_TEXT)); return draftOf(chat); }

// existing quotes: 6..13 from the panel
for (let n = 6; n <= 13; n++) db.quotes.push({ id: uuid(), number: n, quote_date: n + ".10.2026", client_name: n % 2 ? "משפחת כהן " + n : "לקוח פאנל " + n, address: null, description: "תיאור", total: 1000 * n, source: "panel", vat_mode: "exempt", telegram_chat_id: null, pdf_path: null });

(async function () {
  let d, c;
  // ===== ✅ happy path =====
  d = await makeDraft(800);
  reset(); await post(tap(800, "q:ok:" + d.id, d.message_id));
  const cq = calls.filter(x => x.name === "create_quote");
  check("✅ -> create_quote once, service key, payload as specified", cq.length === 1 && JSON.stringify(cq[0].body.p) === JSON.stringify({
    client_name: "דני לוי", address: "הרצל 12, רעננה", description: "1. ליטוש שיש 40 מ\"ר\n2. מריחת סילר הגנה", total: 4500, quote_date: d.draft.quote_date, vat_mode: "exempt", source: "telegram", telegram_chat_id: 800, client_ref: d.id }), JSON.stringify(cq[0] && cq[0].body.p));
  check("M1: client_ref = the draft id (idempotency key)", cq[0] && cq[0].body.p.client_ref === d.id);
  const q14 = db.quotes.find(q => q.number === 14);
  check("…numbered 14 (DB floor), source telegram, chat id stored", !!q14 && q14.source === "telegram" && q14.telegram_chat_id === 800);
  const rc = calls.find(x => x.kind === "render");
  check("render via HTTP: https://VERCEL_URL/api/render-quote-pdf, X-Internal-Secret + bypass header (preview), {quote_id}", !!rc && rc.host === "branch-preview-fake.vercel.app" &&
    rc.headers["X-Internal-Secret"] === BASE_ENV.INTERNAL_API_SECRET && rc.headers["x-vercel-protection-bypass"] === "bypass-fake" && rc.body.quote_id === q14.id && rc.redirect === "manual");
  const doc = docs()[0];
  check("sendDocument multipart: filename 'הצעת-מחיר-014.pdf', application/pdf, the rendered bytes", !!doc && doc.filename === "הצעת-מחיר-014.pdf" && doc.type === "application/pdf" && doc.bytes === "%PDF-rendered-" + q14.id && doc.chat_id === "800");
  check("caption 'הצעת מחיר מס׳ 014 · דני לוי · 4,500 ₪' (6b money format)", doc && doc.caption === "הצעת מחיר מס׳ 014 · דני לוי · 4,500 ₪", doc && doc.caption);
  check("draft message edited to '✅ הצעה מס׳ 014 נשלחה'", calls.some(x => x.method === "editMessageText" && x.body.message_id === d.message_id && txt(x) === "✅ הצעה מס׳ 014 נשלחה"));
  check("draft row deleted (transcript gone), quote kept", !draftOf(800) && db.quotes.some(q => q.id === q14.id));
  check("order: create_quote -> render -> sendDocument", calls.findIndex(x => x.name === "create_quote") < calls.findIndex(x => x.kind === "render") && calls.findIndex(x => x.kind === "render") < calls.findIndex(x => x.method === "sendDocument"));

  // ===== double-tap (concurrent) =====
  d = await makeDraft(801);
  reset();
  await Promise.all([postNoWait(tap(801, "q:ok:" + d.id, d.message_id)), postNoWait(tap(801, "q:ok:" + d.id, d.message_id))]);
  { const p = bg; bg = []; await Promise.all(p); }
  check("concurrent double-tap ✅ -> exactly ONE quote, one PDF", count(x => x.name === "create_quote") === 1 && docs().length === 1 && db.quotes.filter(q => q.telegram_chat_id === 801).length === 1);

  // ===== render failure -> keep quote, 🔄 retry =====
  d = await makeDraft(802);
  renderMode = "500"; reset(); await post(tap(802, "q:ok:" + d.id, d.message_id)); renderMode = "ok";
  c = last();
  const q16 = db.quotes.find(q => q.telegram_chat_id === 802);
  check("PDF fails -> 'ההצעה נשמרה (מס׳ 016) אבל ה-PDF נכשל' + 🔄", txt(c) === "ההצעה נשמרה (מס׳ 016) אבל ה-PDF נכשל." && !!btn(c, "q:retry:"), txt(c));
  check("…quote kept, draft kept with quote_id, claim released, nothing sent", !!q16 && draftOf(802).quote_id === q16.id && draftOf(802).claimed_at === null && docs().length === 0);
  reset(); await post(tap(802, "q:client:" + d.id));
  check("✏️ after the quote exists -> blocked ('כבר נשמרה')", /כבר נשמרה \(מס׳ 016\)/.test(txt(last())) && draftOf(802).awaiting_edit_field == null);
  reset(); await post(tap(802, btn(c, "q:retry:"), d.message_id));
  check("🔄 retry -> NO second create_quote, re-render by quote_id, sent, draft deleted", count(x => x.name === "create_quote") === 0 && calls.find(x => x.kind === "render").body.quote_id === q16.id && docs().length === 1 && !draftOf(802));
  check("…still exactly one quote for that draft", db.quotes.filter(q => q.telegram_chat_id === 802).length === 1);

  // ===== sendDocument failure -> same retry path =====
  d = await makeDraft(803);
  sendDocMode = "fail"; reset(); await post(tap(803, "q:ok:" + d.id, d.message_id)); sendDocMode = "ok";
  check("sendDocument fails -> 'ה-PDF נכשל' + 🔄, quote kept", /אבל ה-PDF נכשל/.test(txt(last())) && !!btn(last(), "q:retry:") && draftOf(803).quote_id);
  reset(); await post(tap(803, btn(last(), "q:retry:") || "q:retry:" + d.id, d.message_id));
  check("🔄 after a send failure -> sent", docs().length === 1 && count(x => x.name === "create_quote") === 0 && !draftOf(803));

  // ===== 422 too_long -> ✂️ shorten + re-render =====
  d = await makeDraft(804);
  renderMode = "422"; reset(); await post(tap(804, "q:ok:" + d.id, d.message_id)); renderMode = "ok";
  c = last();
  const q18 = db.quotes.find(q => q.telegram_chat_id === 804);
  check("422 -> 'נשמרה (מס׳ 018) אבל התיאור ארוך מדי (18 שורות, עד 15)' + ✂️ + 🔄", /ההצעה נשמרה \(מס׳ 018\) אבל התיאור ארוך מדי לעמוד אחד \(18 שורות, עד 15\)/.test(txt(c)) && !!btn(c, "q:short:") && !!btn(c, "q:retry:"), txt(c));
  geminiQueue.push({ description_lines: ["1. ליטוש שיש", "2. סילר"] });
  reset(); await post(tap(804, btn(c, "q:short:"), d.message_id));
  check("✂️ after 422 -> one forced shorten call (even though the estimate 'fits')", count(x => x.kind === "gemini" && x.shorten) === 1);
  check("…the QUOTE's description updated (pdf_path cleared by the trigger), then re-rendered + sent", q18.description === "1. ליטוש שיש\n2. סילר" && calls.some(x => x.kind === "rest" && x.table === "quotes" && x.method === "PATCH") && docs().length === 1 && !draftOf(804));
  check("…no second quote", count(x => x.name === "create_quote") === 0 && db.quotes.filter(q => q.telegram_chat_id === 804).length === 1);

  // ===== create_quote failure =====
  d = await makeDraft(805);
  createQuoteFail = true; reset(); await post(tap(805, "q:ok:" + d.id, d.message_id)); createQuoteFail = false;
  check("create_quote fails -> draft shown again with an error, claim released, no quote", /שגיאה ביצירת ההצעה/.test(txt(last())) && draftOf(805).claimed_at === null && !draftOf(805).quote_id && !db.quotes.some(q => q.telegram_chat_id === 805));
  check("…create_quote error logged without the response body", logs.some(l => /create_quote failed: 500 XX000/.test(l)) && !logs.some(l => /secret-pii/.test(l)));
  reset(); await post(tap(805, "q:ok:" + d.id, d.message_id));
  check("✅ again after that -> works", docs().length === 1 && db.quotes.filter(q => q.telegram_chat_id === 805).length === 1);

  // ===== ❌ after the quote exists =====
  d = await makeDraft(806);
  renderMode = "500"; await post(tap(806, "q:ok:" + d.id, d.message_id)); renderMode = "ok";
  const q806 = db.quotes.find(q => q.telegram_chat_id === 806);
  reset(); await post(tap(806, "q:cancel:" + d.id, d.message_id));
  check("❌ on a saved quote's draft -> draft deleted, quote kept, message points to 📜", !draftOf(806) && db.quotes.some(q => q.id === q806.id) && /נשמרה. אפשר לשלוח את ה-PDF מ-📜/.test(txt(last())));

  // ===== missing config -> failure path, not a crash =====
  delete process.env.INTERNAL_API_SECRET;
  d = await makeDraft(807);
  reset(); await post(tap(807, "q:ok:" + d.id, d.message_id));
  check("no INTERNAL_API_SECRET -> quote kept + 'PDF נכשל' + 🔄 (no render call)", /אבל ה-PDF נכשל/.test(txt(last())) && count(x => x.kind === "render") === 0 && draftOf(807).quote_id);
  process.env.INTERNAL_API_SECRET = BASE_ENV.INTERNAL_API_SECRET;
  await post(tap(807, "q:retry:" + d.id, d.message_id));

  // ===== 📜 recent =====
  reset(); await post(text(810, "📜 הצעות אחרונות")); c = last();
  const top5 = db.quotes.slice().sort((a, b) => b.number - a.number).slice(0, 5);
  check("📜 -> last 5 by number, with ₪, date, 📱/💻", top5.every(q => txt(c).includes("מס׳ " + String(q.number).padStart(3, "0"))) && /📱 טלגרם/.test(txt(c)) && (txt(c).match(/\n/g) || []).length === 6, txt(c).split("\n")[2]);
  const pdfBtns = (x) => btns(x).filter(b => b.callback_data.startsWith("q:pdf:"));
  const jobBtns = (x) => btns(x).filter(b => b.callback_data.startsWith("j:"));
  check("📜 buttons: '📄 PDF מס׳ N' = q:pdf:<quote id> (≤ 64 bytes)", pdfBtns(c).length === 5 && pdfBtns(c).every((b, i) => b.callback_data === "q:pdf:" + top5[i].id && Buffer.byteLength(b.callback_data) <= 64));
  check("📜 buttons (command 7): one job button per quote in the same row — ✅ העבודה בוצעה (j:done) or ⭐ בקשת ביקורת (j:rev) once done",
    c.body.reply_markup.inline_keyboard.every((row, i) => row.length === 2 && row[1].callback_data === (top5[i].job_done_at ? "j:rev:" : "j:done:") + top5[i].id &&
      row[1].text === (top5[i].job_done_at ? "⭐ בקשת ביקורת" : "✅ העבודה בוצעה") && Buffer.byteLength(row[1].callback_data) <= 64));
  const panelOld = db.quotes.find(q => q.number === 9);
  const qs = calls.find(x => x.kind === "rest" && x.table === "quotes" && x.method === "GET");
  check("📜 query selects list columns only (no description/address)", qs && /select=id,number,client_name,total,quote_date,source,job_done_at(&|$)/.test(qs.qs) && !/description|address/.test(qs.qs));

  // ===== 📄 resend =====
  reset(); await post(tap(810, "q:pdf:" + q14.id));
  check("📄 with a stored PDF -> downloaded from quotes-pdf and sent, no render", count(x => x.kind === "storage" && x.path === q14.id + ".pdf") === 1 && count(x => x.kind === "render") === 0 && docs()[0].bytes === "%PDF-stored-" + q14.id + ".pdf" && docs()[0].filename === "הצעת-מחיר-014.pdf");
  reset(); await post(tap(810, "q:pdf:" + panelOld.id));
  check("📄 panel quote without pdf_path -> rendered then sent", count(x => x.kind === "render") === 1 && docs().length === 1 && docs()[0].filename === "הצעת-מחיר-009.pdf");
  storedDownloadOk = false; reset(); await post(tap(810, "q:pdf:" + q14.id)); storedDownloadOk = true;
  check("📄 stored download fails -> falls back to rendering", count(x => x.kind === "render") === 1 && docs().length === 1);
  renderMode = "422"; const q10 = db.quotes.find(q => q.number === 10); reset(); await post(tap(810, "q:pdf:" + q10.id)); renderMode = "ok";
  check("📄 422 -> 'התיאור ארוך מדי' message", /לא ניתן להפיק PDF להצעה מס׳ 010/.test(txt(last())) && docs().length === 0);
  reset(); await post(tap(810, "q:pdf:00000000-0000-4000-8000-999999999999"));
  check("📄 unknown quote -> 'ההצעה לא נמצאה'", /ההצעה לא נמצאה/.test(txt(last())));

  // ===== 🔍 search =====
  reset(); await post(text(811, "🔍 חיפוש הצעה"));
  check("🔍 -> prompt + state awaiting_search", /שלחו את שם הלקוח/.test(txt(last())) && db.telegram_chat_state.some(s => s.chat_id === 811 && s.state === "awaiting_search"));
  reset(); await post(text(811, "כהן"));
  c = last();
  const sq = calls.find(x => x.kind === "rest" && x.table === "quotes" && x.method === "GET");
  check("search 'כהן' -> ilike.*כהן*, up to 5, newest first, same buttons", /client_name=ilike\.\*כהן\*/.test(decodeURIComponent(sq.qs)) && /limit=5/.test(sq.qs) && pdfBtns(c).length === 4 && jobBtns(c).length === 4 && txt(c).startsWith("🔍 תוצאות החיפוש:"), decodeURIComponent(sq.qs));
  check("…state cleared after searching", !db.telegram_chat_state.some(s => s.chat_id === 811));
  await post(text(811, "🔍 חיפוש הצעה")); reset(); await post(text(811, "50%_x*"));
  const sq2 = calls.find(x => x.kind === "rest" && x.table === "quotes" && x.method === "GET");
  check("wildcards escaped: '50%_x*' -> ilike.*50\\%\\_x* (literal match)", decodeURIComponent(sq2.qs).includes("client_name=ilike.*50\\%\\_x*"), decodeURIComponent(sq2.qs));
  check("no match -> 'לא נמצאו הצעות'", /לא נמצאו הצעות/.test(txt(last())));
  db.quotes.push({ id: uuid(), number: 99, quote_date: "1.1.2026", client_name: "אבי 50%_x", total: 1, source: "panel" });
  db.quotes.push({ id: uuid(), number: 98, quote_date: "1.1.2026", client_name: "אבי 50abx", total: 1, source: "panel" });
  await post(text(811, "🔍 חיפוש הצעה")); reset(); await post(text(811, "50%_x"));
  check("escaped search matches the literal name only (not '50abx')", pdfBtns(last()).length === 1 && txt(last()).includes("אבי 50%_x") && !txt(last()).includes("50abx"));
  await post(text(811, "🔍 חיפוש הצעה")); reset(); await post(text(811, "א"));
  check("1-letter search -> ask again, still awaiting", /לפחות 2 אותיות/.test(txt(last())) && db.telegram_chat_state.some(s => s.chat_id === 811 && s.state === "awaiting_search"));
  reset(); await post(text(811, "❓ עזרה"));
  check("menu tap cancels awaiting_search", !db.telegram_chat_state.some(s => s.chat_id === 811) && /מה אפשר לעשות כאן/.test(txt(last())));
  reset(); await post(text(811, "כהן"));
  check("…so 'כהן' afterwards is not a search", !calls.some(x => x.kind === "rest" && x.table === "quotes" && x.method === "GET" && /ilike/.test(x.qs)));

  // ===== M1: idempotent approve (client_ref = draft id) =====
  // (a) create_quote succeeds, saving quote_id on the draft FAILS, and the PDF also fails -> 🔄
  d = await makeDraft(820);
  failQuoteIdPatchOnce = true; renderMode = "500";
  reset(); await post(tap(820, "q:ok:" + d.id, d.message_id));
  renderMode = "ok";
  const qA = db.quotes.filter(q => q.telegram_chat_id === 820);
  check("M1(a) quote created, quote_id NOT saved on the draft, 'PDF נכשל' + 🔄", qA.length === 1 && draftOf(820).quote_id == null && /אבל ה-PDF נכשל/.test(txt(last())) && !!btn(last(), "q:retry:"));
  const retryA = btn(last(), "q:retry:"); // read the button BEFORE reset() clears the recorded calls
  reset(); await post(tap(820, retryA, d.message_id));
  const qA2 = db.quotes.filter(q => q.telegram_chat_id === 820);
  check("M1(a) 🔄 calls create_quote again (no quote_id) with the SAME client_ref -> gets the SAME quote back", count(x => x.name === "create_quote") === 1 &&
    calls.find(x => x.name === "create_quote").body.p.client_ref === d.id && calls.some(x => x.kind === "createReturnedExisting" && x.id === qA[0].id));
  check("M1(a) …still exactly ONE quote, the PDF goes out with ITS number, draft deleted", qA2.length === 1 && docs().length === 1 && docs()[0].filename === "הצעת-מחיר-" + String(qA[0].number).padStart(3, "0") + ".pdf" && !draftOf(820));

  // (b) create_quote COMMITS but its response is lost -> error, claim released -> ✅ again
  d = await makeDraft(821);
  loseCreateResponseOnce = true;
  reset(); await post(tap(821, "q:ok:" + d.id, d.message_id));
  const qB = db.quotes.filter(q => q.telegram_chat_id === 821);
  check("M1(b) response lost: the quote WAS created, the user sees 'שגיאה ביצירת ההצעה', claim released, nothing sent", qB.length === 1 && /שגיאה ביצירת ההצעה/.test(txt(last())) && draftOf(821).claimed_at === null && docs().length === 0);
  reset(); await post(tap(821, "q:ok:" + d.id, d.message_id));
  const qB2 = db.quotes.filter(q => q.telegram_chat_id === 821);
  check("M1(b) ✅ again -> create_quote returns the SAME quote (no second number), PDF sent", qB2.length === 1 && calls.some(x => x.kind === "createReturnedExisting" && x.id === qB[0].id) &&
    docs().length === 1 && docs()[0].caption.startsWith("הצעת מחיר מס׳ " + String(qB[0].number).padStart(3, "0")) && !draftOf(821));
  check("M1(b) the numbering counter did not move for the retry", db.quote_counter[0].floor_next === Math.max(...db.quotes.map(q => q.number)) + 1);

  // (c) compatibility: the function BEFORE the SQL (ignores client_ref) -> the normal path still works
  createQuoteMode = "legacy";
  d = await makeDraft(822);
  reset(); await post(tap(822, "q:ok:" + d.id, d.message_id));
  check("M1(c) old function (before the SQL): approve still works (1 quote, PDF sent)", db.quotes.filter(q => q.telegram_chat_id === 822).length === 1 && docs().length === 1 && !draftOf(822));
  d = await makeDraft(823);
  loseCreateResponseOnce = true;
  await post(tap(823, "q:ok:" + d.id, d.message_id));
  await post(tap(823, "q:ok:" + d.id, d.message_id));
  check("M1(c) old function + lost response -> a 2nd quote (the known bug; fixed once the SQL is applied)", db.quotes.filter(q => q.telegram_chat_id === 823).length === 2);
  createQuoteMode = "idempotent";

  // ===== Audit batch B =====
  quotaRemaining.quote = 15; // this suite creates many drafts; start the batch with a fresh daily quota
  // M2: both in-progress messages carry 🔄; a render timeout -> the error with 🔄 (never a stuck message)
  d = await makeDraft(830);
  reset(); await post(tap(830, "q:ok:" + d.id, d.message_id));
  const progress = calls.filter(x => x.method === "editMessageText" && /^⏳/.test(txt(x)));
  check("M2 '⏳ יוצר את ההצעה…' and '⏳ מפיק PDF…' both carry a 🔄 (q:retry) button", progress.length >= 2 &&
    progress.every(x => btns(x).some(b => b.callback_data === "q:retry:" + d.id)), progress.map(x => txt(x).slice(0, 14)).join(" | "));
  check("M2 the render request uses a 35 s timeout (under the 60 s function limit)", /var RENDER_TIMEOUT_MS = 35000;/.test(fs.readFileSync(REPO + "/api/telegram-webhook.js", "utf8")) &&
    /AbortSignal\.timeout\(RENDER_TIMEOUT_MS\)/.test(fs.readFileSync(REPO + "/api/telegram-webhook.js", "utf8")));
  d = await makeDraft(831);
  renderMode = "timeout"; reset(); await post(tap(831, "q:ok:" + d.id, d.message_id)); renderMode = "ok";
  c = last();
  check("M2 render times out -> the message becomes 'ה-PDF נכשל (זמן ההמתנה עבר)' WITH 🔄, quote kept", /אבל ה-PDF נכשל \(זמן ההמתנה עבר\)/.test(txt(c)) && btn(c, "q:retry:") === "q:retry:" + d.id &&
    db.quotes.filter(q => q.telegram_chat_id === 831).length === 1 && draftOf(831).claimed_at === null);
  reset(); await post(tap(831, "q:retry:" + d.id, d.message_id));
  check("M2 🔄 after the timeout -> re-rendered by quote_id and sent, no 2nd quote", docs().length === 1 && db.quotes.filter(q => q.telegram_chat_id === 831).length === 1 && !draftOf(831));
  d = await makeDraft(832);
  draftOf(832).claimed_at = new Date().toISOString(); // an approval is running
  reset(); await post(tap(832, "q:retry:" + d.id, d.message_id));
  check("M2 🔄/✅ while an approval holds the lease -> a 'still in progress' note (not silence), nothing created", /עדיין בהפקה/.test(txt(last())) && count(x => x.name === "create_quote") === 0);

  // L5: ❌ and 🆕 are ignored while the draft is being approved
  reset(); await post(tap(832, "q:cancel:" + d.id, d.message_id));
  check("L5 ❌ on a draft being approved -> ignored with a note, the draft stays", !!draftOf(832) && /אי אפשר לבטל/.test(txt(last())));
  reset(); await post(tap(832, "q:new:" + d.id, d.message_id));
  check("L5 🆕 on a draft being approved -> not deleted, a note", !!draftOf(832) && /נמצאת כרגע בהפקה/.test(txt(last())));
  draftOf(832).claimed_at = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // the lease expired (a killed run)
  reset(); await post(tap(832, "q:cancel:" + d.id, d.message_id));
  check("L5 after the lease expires, ❌ works again", !draftOf(832) && /בוטלה/.test(txt(last())));

  // L1: a stored PDF is used only if pdf_path is <uuid>.pdf
  const qBad = db.quotes.find(q => q.number === 12);
  qBad.pdf_path = "../receipts/secret.jpg";
  reset(); await post(tap(810, "q:pdf:" + qBad.id));
  check("L1 pdf_path '../receipts/secret.jpg' -> NOT downloaded with the service key; re-rendered + sent", count(x => x.kind === "storage") === 0 && count(x => x.kind === "render") === 1 && docs().length === 1);
  check("L1 …logged without the path", logs.some(l => /unexpected pdf_path format/.test(l)) && !logs.some(l => /secret\.jpg/.test(l)));
  const qGood = db.quotes.find(q => q.pdf_path && /^[0-9a-f-]{36}\.pdf$/.test(q.pdf_path));
  reset(); await post(tap(810, "q:pdf:" + qGood.id));
  check("L1 a proper <uuid>.pdf is still served from storage (no render)", count(x => x.kind === "storage") === 1 && count(x => x.kind === "render") === 0);

  // L2: a timed-out request -> the friendly Hebrew error; and every request carries a timeout
  d = await makeDraft(833);
  createQuoteTimeoutOnce = true; reset(); await post(tap(833, "q:ok:" + d.id, d.message_id));
  check("L2 create_quote times out -> 'שגיאה ביצירת ההצעה. נסו ✅ שוב.', claim released", /שגיאה ביצירת ההצעה/.test(txt(last())) && draftOf(833).claimed_at === null);
  check("L2 every outbound request in this whole run carried a timeout signal (Supabase, Storage, Telegram, render)", unsignaled.length === 0, unsignaled.slice(0, 3).join(" | "));

  // ===== production base URL =====
  Object.assign(process.env, { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "mr-polishes.com", TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_WEBHOOK_SECRET: "prod-secret-fake", TELEGRAM_ALLOWED_CHATS: "500" });
  SECRET = "prod-secret-fake";
  d = await makeDraft(500);
  reset(); await post(tap(500, "q:ok:" + d.id, d.message_id));
  const prc = calls.find(x => x.kind === "render");
  check("production: render on the production domain (not the protected deployment URL), prod bot token for sendDocument", prc && prc.host === "mr-polishes.com" && docs()[0] && docs()[0].token === "111:PRODFAKE");
  Object.assign(process.env, { VERCEL_ENV: "preview" }); SECRET = "test-secret-fake";

  // ===== logs =====
  check("logs: no client names, addresses, descriptions, tokens or secrets", !logs.some(l => /דני|לוי|כהן|הרצל|ליטוש|TESTFAKE|PRODFAKE|svc-fake|internal-secret-fake|bypass-fake/.test(l)), logs.filter(l => /דני|כהן|secret|bypass/.test(l)).slice(0, 2).join(" | "));
  check("never a real network call (every URL mocked; unmocked would throw)", !logs.some(l => /unmocked/.test(l)));

  origLog("\n" + pass + "/" + (pass + fail) + " passed");
  if (fail) process.exitCode = 1;
})().catch(e => { origLog("HARNESS ERROR " + e.stack); process.exitCode = 1; });
