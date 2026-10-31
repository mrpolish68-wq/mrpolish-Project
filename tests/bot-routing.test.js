// Phase 5b mocked harness: routing, dedupe, ACK/waitUntil, menu, receipt quota, bug fixes,
// receipt regression. EVERY outbound call is mocked. Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");

// ---- @vercel/functions mock: collect background work so tests can await it ----
let bg = [];
require.cache[require.resolve(path.join(REPO, "node_modules/@vercel/functions"))] = {
  id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } }
};

// ---- env (preview config) ----
Object.assign(process.env, {
  VERCEL_ENV: "preview",
  TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake",
  TELEGRAM_TEST_ALLOWED_CHATS: Array.from({ length: 40 }, (_, i) => String(600 + i)).join(","),
  TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_WEBHOOK_SECRET: "prod-secret-fake", TELEGRAM_ALLOWED_CHATS: "500",
  SUPABASE_SERVICE_ROLE_KEY: "svc-fake", GOOGLE_AI_API_KEY: "g-fake"
});
const SECRET = "test-secret-fake";

// ---- mini PostgREST ----
const db = { telegram_pending_receipts: [], telegram_pending_quotes: [], telegram_processed_updates: [], telegram_chat_state: [], telegram_daily_usage: [], business_expenses: [] };
let awaitingSinceColumn = true;
let quotaRemaining = { receipt: 20, quote: 15 };   // consume returns remaining-1, or -1 at 0
let quotaFail = false;
let dedupeFail = false;
let expensesInsertFail = false;
let storageUploadFail = false;
const storageFiles = new Set();     // receipts bucket objects that "exist"
let storageDeleteFail = false;      // single-object DELETE fails (❌ path)
let storageBulkDeleteFail = false;  // bulk DELETE fails (sweep path)
const storageOps = [];              // order of storage deletes vs row deletes (M3)
let geminiExtraction;
let calls = [];
let nextId = 1, nextMsgId = 900, nowShiftMs = 0;

function parseFilters(qs) {
  const out = [];
  for (const part of (qs || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(part.slice(0, eq)), val = decodeURIComponent(part.slice(eq + 1));
    if (["select", "order", "limit"].includes(key)) { out[key] = val; continue; }
    if (key === "or") { out.push({ or: val }); continue; }
    out.push({ col: key, op: val });
  }
  return out;
}
function match(row, f) {
  if (f.or) { // only the claim filter: (claimed_at.is.null,claimed_at.lt.<iso>)
    const m = f.or.match(/claimed_at\.lt\.(.+)\)$/);
    return row.claimed_at == null || (m && row.claimed_at < m[1]);
  }
  const v = row[f.col], op = f.op;
  if (op === "not.is.null") return v != null;
  if (op === "is.null") return v == null;
  const inm = op.match(/^in\.\((.*)\)$/);
  if (inm) return inm[1].split(",").map(decodeURIComponent).includes(String(v));
  const m = op.match(/^(eq|gte|lt|gt|lte)\.(.*)$/);
  if (!m) return true;
  const a = String(v), b = m[2];
  if (m[1] === "eq") return a === b;
  if (m[1] === "gte") return v != null && a >= b;
  if (m[1] === "lt") return v != null && a < b;
  if (m[1] === "gt") return v != null && a > b;
  if (m[1] === "lte") return v != null && a <= b;
  return true;
}
function rowsFor(table, filters) {
  let rows = db[table].filter(r => filters.every(f => match(r, f)));
  if (filters.order) { const [c, dir] = filters.order.split("."); rows.sort((x, y) => (x[c] < y[c] ? -1 : 1) * (dir === "desc" ? -1 : 1)); }
  if (filters.limit) rows = rows.slice(0, +filters.limit);
  return rows;
}
function res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }

global.fetch = async function (url, init) {
  init = init || {}; url = String(url);
  const method = init.method || "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\//))) { calls.push({ kind: "tgfile", token: m[1] }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([255, 216, 255, 1]).buffer }; }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (m[2] === "getFile") return res(200, { ok: true, result: { file_path: "photos/f.jpg", file_size: 4 } });
    if (m[2] === "sendMessage") return res(200, { ok: true, result: { message_id: ++nextMsgId } });
    return res(200, { ok: true, result: true });
  }
  if (url.includes("generativelanguage.googleapis.com")) { calls.push({ kind: "gemini" }); return res(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(geminiExtraction) }] } }] }); }
  if (/\/storage\/v1\/object\/receipts$/.test(url) && method === "DELETE") { // bulk delete (sweep)
    const prefixes = body.prefixes || [];
    calls.push({ kind: "storageBulk", prefixes });
    if (storageBulkDeleteFail) return res(500, {});
    prefixes.forEach(p => { storageOps.push("file:" + p); storageFiles.delete(p); });
    return res(200, prefixes.map(name => ({ name })));
  }
  if (url.includes("/storage/v1/object/receipts/")) {
    const p = decodeURIComponent(url.split("/storage/v1/object/receipts/")[1]);
    calls.push({ kind: "storage", method, path: p });
    if (method === "POST" && storageUploadFail) return res(400, { message: "pii-text-from-storage" });
    if (method === "POST") storageFiles.add(p);
    if (method === "DELETE") { if (storageDeleteFail) return res(500, {}); storageOps.push("file:" + p); storageFiles.delete(p); }
    return res(200, {});
  }
  if ((m = url.match(/\/rest\/v1\/rpc\/(\w+)$/))) {
    calls.push({ kind: "rpc", name: m[1], body });
    if (quotaFail) return res(500, { message: "x" });
    const k = body.p_kind;
    if (m[1] === "get_daily_quota_remaining") return res(200, quotaRemaining[k]);
    if (quotaRemaining[k] <= 0) return res(200, -1);
    quotaRemaining[k]--; return res(200, quotaRemaining[k]);
  }
  if ((m = url.match(/\/rest\/v1\/(\w+)(?:\?(.*))?$/))) {
    const table = m[1], qs = m[2] || "";
    calls.push({ kind: "rest", table, method, qs, body });
    const filters = parseFilters(qs);
    if (table === "telegram_pending_receipts" && !awaitingSinceColumn && (/awaiting_since/.test(qs) || (body && "awaiting_since" in body))) {
      return res(400, { code: "PGRST204", message: "Could not find the 'awaiting_since' column" });
    }
    if (method === "POST") {
      if (table === "telegram_processed_updates") {
        if (dedupeFail) return res(500, {});
        if (db[table].some(r => r.update_id === body.update_id)) return res(409, { code: "23505" });
        db[table].push({ update_id: body.update_id, created_at: new Date().toISOString() }); return res(201, null);
      }
      if (table === "business_expenses" && expensesInsertFail) return res(400, { code: "23514", message: "Failing row contains (secret-pii-value)" });
      const row = Object.assign({ id: "00000000-0000-4000-8000-" + String(nextId++).padStart(12, "0"), created_at: new Date(Date.now() - nowShiftMs).toISOString(), claimed_at: null }, body);
      db[table].push(row); return res(201, [row]);
    }
    if (method === "GET") return res(200, rowsFor(table, filters));
    if (method === "PATCH") { const rows = rowsFor(table, filters); rows.forEach(r => Object.assign(r, body)); return res(200, rows); }
    if (method === "DELETE") { const del = rowsFor(table, filters); if (table === "telegram_pending_receipts") del.forEach(r => storageOps.push("row:" + r.id)); db[table] = db[table].filter(r => !del.includes(r)); return res(204, null); }
  }
  throw new Error("unmocked fetch " + url);
};

const logs = [];
console.error = (...a) => logs.push(a.join(" "));
const handler = require(REPO + "/api/telegram-webhook.js");

let updateId = 1000;
async function post(update, opts) {
  opts = opts || {};
  const out = { status: 0 };
  let geminiAtAck = -1, sentAtAck = -1;
  await new Promise(resolve => {
    const r = { status(c) { out.status = c; return r; }, json(b) { out.body = b; geminiAtAck = calls.filter(c => c.kind === "gemini").length; sentAtAck = calls.filter(c => c.method === "sendMessage" || c.method === "editMessageText").length; resolve(); return r; }, setHeader() {} };
    handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": opts.secret || SECRET }, body: Object.assign({ update_id: opts.updateId || ++updateId }, update) }, r);
  });
  out.geminiAtAck = geminiAtAck; out.sentAtAck = sentAtAck;
  const pending = bg; bg = [];
  await Promise.all(pending);
  return out;
}
const msg = (chat, extra) => ({ message: Object.assign({ message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat } }, extra) });
const text = (chat, t) => msg(chat, { text: t });
const photo = (chat) => msg(chat, { photo: [{ file_id: "s" }, { file_id: "b" }] });
const tap = (chat, data, mid) => ({ callback_query: { id: "cb" + (updateId + 1), data, from: { id: chat }, message: { message_id: mid || 1, chat: { id: chat } } } });

const sent = () => calls.filter(c => c.kind === "tg" && (c.method === "sendMessage" || c.method === "editMessageText"));
const lastSent = () => sent().slice(-1)[0];
const has = (c, re) => !!c && re.test(c.body.text || "");
const kbHasMenu = (c) => !!c && c.body.reply_markup && JSON.stringify(c.body.reply_markup).includes("💰 סיכום הוצאות החודש");
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); }
function resetCalls() { calls = []; }
function freshReceiptExtraction() { geminiExtraction = { vendor_name: "סופר דוגמה", date: "2026-10-20", total_amount: 123.45, vat_amount: null, amount_before_vat: null, invoice_number: null, category: "שונות", confidence_notes: "" }; }
freshReceiptExtraction();

(async function () {
  let r, c;
  // ===== Menu =====
  resetCalls(); r = await post(text(600, "/start"));
  c = lastSent();
  check("/start -> welcome + help + persistent keyboard", r.status === 200 && has(c, /שלום!/) && has(c, /📷 קבלה/) && kbHasMenu(c) && c.body.reply_markup.is_persistent === true);
  check("/start shows '📊 נותרו היום: 15 הצעות מחיר'", has(c, /📊 נותרו היום: 15 הצעות מחיר/));
  check("/start uses get_daily_quota_remaining('quote', 15)", calls.some(x => x.kind === "rpc" && x.name === "get_daily_quota_remaining" && x.body.p_kind === "quote" && x.body.p_limit === 15));
  check("keyboard has the 7 approved buttons (📸 פרויקט חדש = the 4th row, command 5)", c && JSON.stringify(c.body.reply_markup.keyboard) === JSON.stringify([[{ text: "🧾 הצעת מחיר חדשה" }, { text: "📷 סריקת קבלה" }], [{ text: "📜 הצעות אחרונות" }, { text: "🔍 חיפוש הצעה" }], [{ text: "💰 סיכום הוצאות החודש" }, { text: "❓ עזרה" }], [{ text: "📸 פרויקט חדש" }]]));
  check("help mentions 📸 פרויקט חדש", has(c, /📸 פרויקט חדש: שולחים תמונות/));
  resetCalls(); await post(text(600, "/start@Mrpolish_test_quotes_bot")); check("/start@botname = /start", has(lastSent(), /שלום!/));
  resetCalls(); await post(text(600, "/help")); c = lastSent(); check("/help -> help + quota line", has(c, /מה אפשר לעשות כאן/) && has(c, /נותרו היום/) && !has(c, /שלום!/));
  resetCalls(); await post(text(600, "❓ עזרה")); check("❓ עזרה -> help", has(lastSent(), /מה אפשר לעשות כאן/));
  quotaFail = true; resetCalls(); await post(text(600, "/help")); quotaFail = false;
  check("help still sent when the quota lookup fails (line omitted)", has(lastSent(), /מה אפשר לעשות כאן/) && !has(lastSent(), /נותרו היום/));
  for (const t of ["/quote", "🧾 הצעת מחיר חדשה"]) {
    resetCalls(); await post(text(600, t)); check(t + " -> quote flow (ask for details)", has(lastSent(), /שם הלקוח/));
  }
  resetCalls(); await post(text(600, "📜 הצעות אחרונות")); check("📜 -> recent-quotes flow (5d)", has(lastSent(), /ההצעות האחרונות|עדיין אין הצעות|שגיאה זמנית בטעינת ההצעות/));
  resetCalls(); await post(text(600, "🔍 חיפוש הצעה")); check("🔍 -> search prompt (5d)", has(lastSent(), /שלחו את שם הלקוח/));
  resetCalls(); await post(text(600, "📷 סריקת קבלה")); check("📷 סריקת קבלה -> photo instructions", has(lastSent(), /שלחו עכשיו תמונה/));
  // month summary (Israel month)
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
  db.business_expenses.push({ date: ym + "-03", amount: 100, category: "דלק/רכב" }, { date: ym + "-10", amount: 50.5, category: "דלק/רכב" }, { date: ym + "-11", amount: 200, category: "שונות" }, { date: "2020-01-01", amount: 999, category: "שונות" });
  resetCalls(); await post(text(600, "💰 סיכום הוצאות החודש")); c = lastSent();
  check("💰 summary: this month only, total + per category (code math)", has(c, /350\.50 ₪/) && has(c, /3 הוצאות/) && has(c, /דלק\/רכב: 150\.50 ₪/) && has(c, /שונות: 200\.00 ₪/) && !has(c, /999/), c && c.body.text.replace(/\n/g, " | "));
  db.business_expenses = [];

  // ===== Routing =====
  resetCalls(); await post(msg(601, { voice: { file_id: "v", duration: 3 } })); check("voice -> quote flow", has(lastSent(), /שם הלקוח|⏳ מעבד|יש כבר טיוטת|טיוטת הצעת|לא מצאתי|המערכת עמוסה|משהו השתבש|לא הצלחתי לקרוא/));
  resetCalls(); await post(text(601, "הצעת מחיר לדני")); check("text 'הצעת מחיר…' -> quote flow", has(lastSent(), /שם הלקוח|⏳ מעבד|יש כבר טיוטת|טיוטת הצעת|לא מצאתי|המערכת עמוסה|משהו השתבש|לא הצלחתי לקרוא/));
  resetCalls(); await post(text(601, "ליטוש 40 מ\"ר")); check("text with מ\"ר -> quote flow", has(lastSent(), /שם הלקוח|⏳ מעבד|יש כבר טיוטת|טיוטת הצעת|לא מצאתי|המערכת עמוסה|משהו השתבש|לא הצלחתי לקרוא/));
  resetCalls(); await post(text(630, "מה קורה?")); c = lastSent();
  check("unclear text -> 'לא בטוח שהבנתי' + inline '🧾 להכין הצעת מחיר?'", has(c, /לא בטוח שהבנתי/) && JSON.stringify(c.body.reply_markup).includes("newquote"));
  resetCalls(); await post(tap(630, "newquote")); check("tap '🧾 להכין הצעת מחיר?' -> quote flow", has(lastSent(), /שם הלקוח|⏳ מעבד|יש כבר טיוטת|טיוטת הצעת|לא מצאתי|המערכת עמוסה|משהו השתבש|לא הצלחתי לקרוא/));
  resetCalls(); await post(msg(601, { sticker: { file_id: "x" } })); check("sticker -> unclear", has(lastSent(), /לא בטוח שהבנתי/));
  resetCalls(); r = await post(text(500, "/start")); check("non-allowlisted chat -> silent", r.status === 200 && calls.filter(x => x.kind === "tg").length === 0);

  // ===== Dedupe + ACK =====
  resetCalls(); r = await post(text(602, "/help"), { updateId: 5555 }); const firstSends = sent().length;
  resetCalls(); r = await post(text(602, "/help"), { updateId: 5555 });
  check("duplicate update_id -> 200, nothing processed", r.status === 200 && firstSends === 1 && calls.filter(x => x.kind === "tg").length === 0 && calls.some(x => x.table === "telegram_processed_updates"));
  dedupeFail = true; resetCalls(); r = await post(text(602, "/help")); dedupeFail = false;
  check("dedupe insert error -> fails open (processed)", has(lastSent(), /מה אפשר לעשות כאן/));
  check("dedupe error logged as status only", logs.some(l => /dedupe insert HTTP 500/.test(l)));
  resetCalls(); r = await post(photo(603));
  check("ACK 200 sent before any heavy work (Gemini/summary ran after the ACK)", r.status === 200 && r.geminiAtAck === 0 && r.sentAtAck === 0 && calls.some(x => x.kind === "gemini"));
  const pr = db.telegram_pending_receipts.find(x => x.chat_id === 603);
  resetCalls(); r = await post(tap(603, "cyclecat:" + pr.id, pr.message_id));
  const ansIdx = calls.findIndex(x => x.method === "answerCallbackQuery"), editIdx = calls.findIndex(x => x.method === "editMessageText");
  check("callback answered immediately ('⏳'), before the work", ansIdx !== -1 && calls[ansIdx].body.text === "⏳" && editIdx > ansIdx && r.sentAtAck === 0);
  check("callback answered exactly once", calls.filter(x => x.method === "answerCallbackQuery").length === 1);

  // ===== Receipt quota =====
  resetCalls(); await post(photo(604));
  const rpcIdx = calls.findIndex(x => x.kind === "rpc" && x.name === "consume_daily_quota"), gemIdx = calls.findIndex(x => x.kind === "gemini");
  check("receipt: consume_daily_quota('receipt', 20) BEFORE Gemini", rpcIdx !== -1 && gemIdx > rpcIdx && calls[rpcIdx].body.p_kind === "receipt" && calls[rpcIdx].body.p_limit === 20);
  quotaRemaining.receipt = 0; resetCalls(); await post(photo(605));
  check("receipt at the daily limit -> friendly message, no download, no Gemini", has(lastSent(), /הגענו למכסת סריקת הקבלות להיום \(20\)/) && !calls.some(x => x.kind === "gemini" || x.kind === "tgfile"));
  quotaRemaining.receipt = 20; quotaFail = true; resetCalls(); await post(photo(606)); quotaFail = false;
  check("quota unavailable -> fail closed (temporary error, no Gemini)", has(lastSent(), /שגיאה זמנית/) && !calls.some(x => x.kind === "gemini"));

  // ===== Bug fix: edit freshness from the tap =====
  nowShiftMs = 40 * 60 * 1000; // the receipt "arrived" 40 minutes ago
  resetCalls(); await post(photo(607)); nowShiftMs = 0;
  let p7 = db.telegram_pending_receipts.find(x => x.chat_id === 607);
  await post(tap(607, "editdate:" + p7.id, p7.message_id));
  check("edit tap records awaiting_since", p7.awaiting_edit_field === "date" && !!p7.awaiting_since);
  resetCalls(); await post(text(607, "15/08/2026"));
  check("reply 40 min after the receipt but right after the tap -> applied (old bug: ignored)", p7.extracted.date === "2026-08-15" && p7.awaiting_edit_field === null && has(lastSent(), /עודכן: תאריך/));
  // stale tap (> 30 min) -> not treated as an edit
  await post(tap(607, "editamount:" + p7.id, p7.message_id));
  p7.awaiting_since = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  resetCalls(); await post(text(607, "245.50"));
  check("reply > 30 min after the tap -> not an edit", p7.extracted.total_amount === 123.45 && !has(lastSent(), /עודכן/));
  db.telegram_pending_receipts = db.telegram_pending_receipts.filter(x => x.chat_id !== 607);

  // ===== Menu tap cancels a pending edit =====
  resetCalls(); await post(photo(609));
  let p9 = db.telegram_pending_receipts.find(x => x.chat_id === 609);
  await post(tap(609, "editdate:" + p9.id, p9.message_id));
  db.telegram_chat_state.push({ chat_id: 609, state: "awaiting_search", state_since: new Date().toISOString() });
  db.telegram_pending_quotes.push({ id: "q9", chat_id: 609, awaiting_edit_field: "total", awaiting_since: new Date().toISOString(), created_at: new Date().toISOString() });
  resetCalls(); await post(text(609, "❓ עזרה"));
  check("menu tap clears receipt + quote edit state and chat state", p9.awaiting_edit_field === null && p9.awaiting_since === null &&
    db.telegram_pending_quotes.find(x => x.id === "q9").awaiting_edit_field === null && !db.telegram_chat_state.some(x => x.chat_id === 609));
  resetCalls(); await post(text(609, "15/08/2026"));
  check("…so the next text is NOT taken as a receipt edit (6b: the open quote draft asks instead)", p9.extracted.date === "2026-10-20" && !has(lastSent(), /עודכן/) && has(lastSent(), /יש טיוטה פתוחה/));

  // ===== Newest pending edit wins (receipt vs quote) =====
  resetCalls(); await post(photo(610));
  let p10 = db.telegram_pending_receipts.find(x => x.chat_id === 610);
  await post(tap(610, "editamount:" + p10.id, p10.message_id));
  p10.awaiting_since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.telegram_pending_quotes.push({ id: "q10", chat_id: 610, awaiting_edit_field: "total", awaiting_since: new Date(Date.now() - 60 * 1000).toISOString(), created_at: new Date().toISOString() });
  resetCalls(); await post(text(610, "300"));
  check("quote edit newer -> text goes to the quote draft, receipt untouched", !has(lastSent(), /עודכן: סכום/) && p10.extracted.total_amount === 123.45);
  db.telegram_pending_quotes.find(x => x.id === "q10").awaiting_since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  resetCalls(); await post(text(610, "300"));
  check("receipt edit newer -> applied to the receipt", p10.extracted.total_amount === 300);
  db.telegram_pending_quotes.push({ id: "q10v", chat_id: 610, awaiting_edit_field: "voice", awaiting_since: new Date().toISOString(), created_at: new Date().toISOString() });
  resetCalls(); await post(text(610, "מה קורה?"));
  check("a quote waiting for a 🎤 correction takes a text message too (5c)", !has(lastSent(), /לא בטוח שהבנתי/));

  // fallback before the migration (no awaiting_since column)
  awaitingSinceColumn = false;
  resetCalls(); await post(photo(608));
  let p8 = db.telegram_pending_receipts.find(x => x.chat_id === 608);
  await post(tap(608, "editamount:" + p8.id, p8.message_id));
  check("no column yet: edit tap still works (retried without awaiting_since)", p8.awaiting_edit_field === "amount" && !("awaiting_since" in p8 && p8.awaiting_since));
  resetCalls(); await post(text(608, "245.50"));
  check("no column yet: reply uses the old created_at window", p8.extracted.total_amount === 245.5 && has(lastSent(), /עודכן: סכום/));
  awaitingSinceColumn = true;

  // ===== Rate limits split per flow =====
  for (let i = 0; i < 10; i++) await post(photo(611));
  resetCalls(); await post(photo(611));
  check("11th receipt in 10 min -> receipt rate-limit message", has(lastSent(), /אפשר לשלוח קבלה נוספת/) && !calls.some(x => x.kind === "gemini"));
  resetCalls(); await post(text(611, "❓ עזרה"));
  check("menu still works after the receipt flow is throttled", has(lastSent(), /מה אפשר לעשות כאן/));
  resetCalls(); await post(text(611, "הצעת מחיר"));
  check("quote flow still works after the receipt flow is throttled", has(lastSent(), /שם הלקוח|⏳ מעבד|יש כבר טיוטת|טיוטת הצעת|לא מצאתי|המערכת עמוסה|משהו השתבש|לא הצלחתי לקרוא/));

  // ===== No PostgREST bodies / PII in logs =====
  logs.length = 0;
  resetCalls(); await post(photo(612));
  let p12 = db.telegram_pending_receipts.find(x => x.chat_id === 612);
  expensesInsertFail = true; await post(tap(612, "confirm:" + p12.id, p12.message_id)); expensesInsertFail = false;
  check("insert failure logs status + code only (no row values)", logs.some(l => /business_expenses insert failed: .*400 23514/.test(l)) && !logs.some(l => /secret-pii-value/.test(l)));
  check("insert failure -> user told to retry (as a message)", has(lastSent(), /שגיאה בשמירה/));
  storageUploadFail = true; resetCalls(); await post(photo(613)); storageUploadFail = false;
  check("storage failure logs status only (no response body)", logs.some(l => /Storage upload failed: 400/.test(l)) && !logs.some(l => /pii-text-from-storage/.test(l)));
  check("no token / secret in any log line", !logs.some(l => /TESTFAKE|PRODFAKE|test-secret-fake|svc-fake/.test(l)));

  // ===== Retention sweep =====
  // The first background run of this process already swept; check the DELETEs it issued earlier is hard,
  // so verify the throttle + targets directly by re-requiring a fresh module instance.
  delete require.cache[require.resolve(REPO + "/api/telegram-webhook.js")];
  const fresh = require(REPO + "/api/telegram-webhook.js");
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  db.telegram_processed_updates.push({ update_id: 1, created_at: old });
  db.telegram_pending_quotes.push({ id: "qold", chat_id: 1, created_at: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
  db.telegram_chat_state.push({ chat_id: 1, state: "idle", state_since: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
  db.telegram_daily_usage.push({ day: "2020-01-01", kind: "quote", count: 1 }, { day: new Date().toISOString().slice(0, 10), kind: "quote", count: 1 });
  const t49 = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
  db.telegram_pending_receipts.push({ id: "rold", chat_id: 1, receipt_path: "old-a.jpg", created_at: t49 });
  db.telegram_pending_receipts.push({ id: "rold2", chat_id: 1, receipt_path: "old-b.jpg", created_at: t49 }); // its expense WAS confirmed (row lingered)
  db.telegram_pending_receipts.push({ id: "rnew", chat_id: 1, receipt_path: "new-c.jpg", created_at: new Date().toISOString() });
  db.business_expenses.push({ receipt_url: "old-b.jpg", amount: 1, category: "שונות", date: "2026-01-01" });
  ["old-a.jpg", "old-b.jpg", "new-c.jpg"].forEach(p => storageFiles.add(p));
  storageOps.length = 0;
  const postFresh = (u) => new Promise(resolve => { const rr = { status() { return rr; }, json() { resolve(); return rr; }, setHeader() {} }; fresh({ method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: Object.assign({ update_id: ++updateId }, u) }, rr); });
  resetCalls(); await postFresh(text(614, "/help")); await Promise.all(bg.splice(0));
  const sweeps = calls.filter(x => x.method === "DELETE" && x.kind === "rest").map(x => x.table + "?" + decodeURIComponent(x.qs).split("=")[0]);
  check("sweep: all 5 tables, by the right column (receipts: read by created_at, rows deleted by id)", ["telegram_pending_quotes?created_at", "telegram_chat_state?state_since", "telegram_processed_updates?created_at", "telegram_daily_usage?day", "telegram_pending_receipts?id"].every(s => sweeps.includes(s)) &&
    calls.some(x => x.kind === "rest" && x.table === "telegram_pending_receipts" && x.method === "GET" && /created_at=lt\./.test(x.qs)), sweeps.join(", "));
  check("M3 sweep: the expired receipt's FILE is deleted first, then its row", storageOps.indexOf("file:old-a.jpg") !== -1 && storageOps.indexOf("file:old-a.jpg") < storageOps.indexOf("row:rold") && !storageFiles.has("old-a.jpg"), storageOps.join(" "));
  check("M3 sweep: a file a CONFIRMED expense points to is never deleted (its stale row is)", storageFiles.has("old-b.jpg") && !storageOps.includes("file:old-b.jpg") && !db.telegram_pending_receipts.some(x => x.id === "rold2"));
  check("M3 sweep: a recent pending receipt (< 48 h) is untouched, file and row", storageFiles.has("new-c.jpg") && db.telegram_pending_receipts.some(x => x.id === "rnew"));
  check("sweep: old rows gone, recent kept", !db.telegram_processed_updates.some(x => x.update_id === 1) && !db.telegram_pending_quotes.some(x => x.id === "qold") &&
    !db.telegram_chat_state.some(x => x.chat_id === 1) && db.telegram_daily_usage.length === 1 && !db.telegram_pending_receipts.some(x => x.id === "rold"));
  // storage failing -> the rows stay (retried on the next sweep), so no file is ever orphaned
  delete require.cache[require.resolve(REPO + "/api/telegram-webhook.js")];
  const fresh2 = require(REPO + "/api/telegram-webhook.js");
  db.telegram_pending_receipts.push({ id: "rold3", chat_id: 1, receipt_path: "old-d.jpg", created_at: t49 });
  storageFiles.add("old-d.jpg"); storageBulkDeleteFail = true;
  const postFresh2 = (u) => new Promise(resolve => { const rr = { status() { return rr; }, json() { resolve(); return rr; }, setHeader() {} }; fresh2({ method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: Object.assign({ update_id: ++updateId }, u) }, rr); });
  resetCalls(); await postFresh2(text(615, "/help")); await Promise.all(bg.splice(0)); storageBulkDeleteFail = false;
  check("M3 sweep: Storage delete fails -> the rows are KEPT (file still referenced, retried next sweep)", db.telegram_pending_receipts.some(x => x.id === "rold3") && storageFiles.has("old-d.jpg"));
  db.telegram_pending_receipts = db.telegram_pending_receipts.filter(x => x.id !== "rold3" && x.id !== "rnew");
  resetCalls(); await postFresh(text(614, "/help")); await Promise.all(bg.splice(0));
  check("sweep throttled (not again within 10 min)", !calls.some(x => x.method === "DELETE" && x.table === "telegram_processed_updates"));

  // ===== Receipt regression =====
  resetCalls(); await post(photo(620));
  let s = calls.find(x => x.method === "sendMessage" && x.body.reply_markup && JSON.stringify(x.body.reply_markup).includes("confirm:"));
  let p20 = db.telegram_pending_receipts.find(x => x.chat_id === 620);
  check("L6 receipt summary date shown as DD.MM.YYYY ('20.10.2026'), stored ISO unchanged", calls.some(x => x.method === "sendMessage" && /📅 תאריך: 20\.10\.2026/.test(x.body.text || "")) &&
    db.telegram_pending_receipts.some(x => x.chat_id === 620 && x.extracted.date === "2026-10-20"));
  check("regression: photo -> Gemini, upload, pending row, summary with buttons", !!s && !!p20 && calls.some(x => x.kind === "storage" && x.method === "POST") && p20.message_id === nextMsgId);
  const cat0 = p20.extracted.category; await post(tap(620, "cyclecat:" + p20.id, p20.message_id));
  check("regression: category cycle", p20.extracted.category !== cat0);
  resetCalls(); await post(tap(620, "cancel:" + p20.id, p20.message_id));
  check("regression: cancel -> row + file deleted, 'בוטל'", !db.telegram_pending_receipts.includes(p20) && calls.some(x => x.kind === "storage" && x.method === "DELETE") && has(lastSent(), /בוטל/));
  check("M3 ❌: the file is deleted BEFORE the row", storageOps.lastIndexOf("file:" + p20.receipt_path) < storageOps.lastIndexOf("row:" + p20.id) && storageOps.lastIndexOf("file:" + p20.receipt_path) !== -1);
  await post(photo(625)); const p25 = db.telegram_pending_receipts.find(x => x.chat_id === 625);
  storageDeleteFail = true; resetCalls(); await post(tap(625, "cancel:" + p25.id, p25.message_id)); storageDeleteFail = false;
  check("M3 ❌: if the file can't be deleted, the row is kept (the sweep removes both later), user still sees 'בוטל'", db.telegram_pending_receipts.includes(p25) && has(lastSent(), /בוטל/));
  db.telegram_pending_receipts = db.telegram_pending_receipts.filter(x => x !== p25);
  const before = db.business_expenses.length;
  await post(photo(621)); let p21 = db.telegram_pending_receipts.find(x => x.chat_id === 621);
  resetCalls(); await post(tap(621, "confirm:" + p21.id, p21.message_id));
  check("regression: confirm -> one expense, 'נשמר'", db.business_expenses.length === before + 1 && has(lastSent(), /נשמר בהוצאות העסק/));
  resetCalls(); await post(tap(621, "confirm:" + p21.id, p21.message_id));
  check("regression: second confirm -> no second insert, 'כבר טופלה' message", db.business_expenses.length === before + 1 && has(lastSent(), /כבר טופלה/));
  geminiExtraction.total_amount = null; await post(photo(622)); freshReceiptExtraction();
  let p22 = db.telegram_pending_receipts.find(x => x.chat_id === 622);
  resetCalls(); await post(tap(622, "confirm:" + p22.id, p22.message_id));
  check("regression: missing amount -> refused, nothing saved", db.business_expenses.length === before + 1 && calls.some(x => x.method === "sendMessage" && /חסר סכום/.test(x.body.text)));
  resetCalls(); r = await post(photo(620), { secret: "wrong" });
  check("regression: wrong secret -> 401, nothing done", r.status === 401 && calls.length === 0);
  check("everything used the TEST token only", calls.every(x => !x.token || x.token === "222:TESTFAKE"));

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  if (fail) process.exitCode = 1;
})().catch(e => { console.log("HARNESS ERROR " + e.stack); process.exitCode = 1; });
