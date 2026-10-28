// Phase 5c harness: the quote draft flow. Telegram + Supabase always mocked (never touches
// public.quotes). Gemini mocked, except with LIVE=1, where only the Gemini calls go to the real
// API (fake data, a few TEXT cases). Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const fs = require("fs");
const LIVE = process.env.LIVE === "1";

let bg = [];
require.cache[require.resolve(path.join(REPO, "node_modules/@vercel/functions"))] = { id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } } };

Object.assign(process.env, {
  VERCEL_ENV: "preview",
  TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake",
  TELEGRAM_TEST_ALLOWED_CHATS: Array.from({ length: 60 }, (_, i) => String(700 + i)).join(","),
  SUPABASE_SERVICE_ROLE_KEY: "svc-fake", GOOGLE_AI_API_KEY: "g-fake"
});
if (LIVE) {
  for (const l of fs.readFileSync(path.join(REPO, ".env"), "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*GOOGLE_AI_API_KEY\s*=\s*(.*)$/);
    if (m) process.env.GOOGLE_AI_API_KEY = m[1].trim().replace(/^['"]|['"]$/g, "");
  }
}
const SECRET = "test-secret-fake";

// ---------- mocks ----------
const db = { telegram_pending_receipts: [], telegram_pending_quotes: [], telegram_processed_updates: [], telegram_chat_state: [], telegram_daily_usage: [], business_expenses: [] };
let quotaRemaining = { receipt: 20, quote: 15 };
let calls = [];
const allTexts = []; // every text/button label the bot sends during the whole run (6b money check)
let nextId = 1, nextMsgId = 5000;
let geminiQueue = [];     // responses for quote extraction / correction / shorten (in order)
let geminiStatus = null;  // e.g. 429
let failEditFor = new Set();
let draftLookupTimeoutOnce = false;
let lastGeminiBody = null;
const realFetch = global.fetch;

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
function match(row, f) {
  if (f.or) { const m = f.or.match(/claimed_at\.lt\.(.+)\)$/); return row.claimed_at == null || (m && row.claimed_at < m[1]); }
  const v = row[f.col], op = f.op;
  if (op === "not.is.null") return v != null;
  if (op === "is.null") return v == null;
  const m = op.match(/^(eq|gte|lt|gt|lte)\.(.*)$/);
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
const R = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) });
const clone = (o) => JSON.parse(JSON.stringify(o));

global.fetch = async function (url, init) {
  init = init || {}; url = String(url);
  const method = init.method || "GET";
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  let m;
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\//))) { calls.push({ kind: "tgfile" }); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(Buffer.from("FAKE-OGG-AUDIO-BYTES")).buffer }; }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (body && body.text) allTexts.push(body.text);
    if (body && body.reply_markup && body.reply_markup.inline_keyboard) body.reply_markup.inline_keyboard.flat().forEach(b => allTexts.push(b.text));
    if (m[2] === "getFile") return R(200, { ok: true, result: { file_path: "voice/f.oga", file_size: 20 } });
    if (m[2] === "sendMessage") return R(200, { ok: true, result: { message_id: ++nextMsgId } });
    if (m[2] === "editMessageText" && failEditFor.has(body.message_id)) return R(400, { ok: false, description: "message to edit not found" });
    return R(200, { ok: true, result: true });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const isQuote = init.body.includes("description_lines");
    calls.push({ kind: "gemini", quote: isQuote, shorten: isQuote && !init.body.includes("stated_total") });
    lastGeminiBody = init.body;
    if (LIVE && isQuote) return realFetch(url, init);
    if (geminiStatus) return R(geminiStatus, { error: { message: "busy" } });
    const resp = isQuote ? geminiQueue.shift() : { vendor_name: "ספק", date: "2026-10-20", total_amount: 50, vat_amount: null, amount_before_vat: null, invoice_number: null, category: "שונות", confidence_notes: "" };
    return R(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(resp) }] } }] });
  }
  if (url.includes("/storage/v1/object/")) { calls.push({ kind: "storage", method }); return R(200, {}); }
  if ((m = url.match(/\/rest\/v1\/rpc\/(\w+)$/))) {
    calls.push({ kind: "rpc", name: m[1], body });
    const k = body.p_kind;
    if (m[1] === "get_daily_quota_remaining") return R(200, quotaRemaining[k]);
    if (quotaRemaining[k] <= 0) return R(200, -1);
    quotaRemaining[k]--; return R(200, quotaRemaining[k]);
  }
  if ((m = url.match(/\/rest\/v1\/(\w+)(?:\?(.*))?$/))) {
    const table = m[1], qs = m[2] || "";
    calls.push({ kind: "rest", table, method, qs, body });
    if (!db[table]) return R(404, { code: "PGRST205" }); // e.g. "quotes": must never be called
    const f = parseFilters(qs);
    if (method === "POST") {
      if (table === "telegram_processed_updates") { if (db[table].some(r => r.update_id === body.update_id)) return R(409, {}); db[table].push({ update_id: body.update_id, created_at: new Date().toISOString() }); return R(201, null); }
      if (table === "telegram_chat_state") { db[table] = db[table].filter(r => r.chat_id !== body.chat_id); db[table].push(clone(body)); return R(201, null); }
      const row = Object.assign({ id: "00000000-0000-4000-8000-" + String(nextId++).padStart(12, "0"), created_at: new Date(Date.now() + nextId).toISOString(), claimed_at: null, voice_corrections: 0 }, clone(body));
      db[table].push(row); return R(201, [row]);
    }
    // findActiveDraft's lookup (created_at=gt.) times out once
    if (method === "GET" && table === "telegram_pending_quotes" && draftLookupTimeoutOnce && /created_at=gt\./.test(decodeURIComponent(qs))) { draftLookupTimeoutOnce = false; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }
    if (method === "GET") return R(200, rowsFor(table, f));
    if (method === "PATCH") {
      const rows = rowsFor(table, f);
      if (table === "telegram_pending_quotes" && body.voice_corrections > 3) return R(400, { code: "23514" });
      rows.forEach(r => Object.assign(r, clone(body))); return R(200, rows);
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
const QX = require(REPO + "/api/_quote-extract.js");

let updateId = 9000;
async function post(update) {
  await new Promise(resolve => {
    const r = { status() { return r; }, json() { resolve(); return r; }, setHeader() {} };
    handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: Object.assign({ update_id: ++updateId }, update) }, r);
  });
  const p = bg; bg = []; await Promise.all(p);
}
const text = (chat, t) => ({ message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat }, text: t } });
const voice = (chat, v) => ({ message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat }, voice: Object.assign({ file_id: "VOICEFILE", mime_type: "audio/ogg", duration: 12, file_size: 20000 }, v || {}) } });
const tap = (chat, data, mid) => ({ callback_query: { id: "cb" + updateId, data, from: { id: chat }, message: { message_id: mid || 1, chat: { id: chat } } } });

const tgSends = () => calls.filter(c => c.kind === "tg" && (c.method === "sendMessage" || c.method === "editMessageText"));
const last = () => tgSends().slice(-1)[0];
const txt = (c) => (c && c.body && c.body.text) || "";
const buttons = (c) => ((c && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).flat();
const btnData = (c, prefix) => (buttons(c).find(b => b.callback_data.startsWith(prefix)) || {}).callback_data;
const draftOf = (chat) => db.telegram_pending_quotes.find(r => r.chat_id === chat);
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) { if (cond) pass++; else fail++; origLog((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); results.push({ name, cond }); }
const reset = () => { calls = []; };

// A Gemini quote response (fake) in the extraction schema.
function gq(o) {
  return Object.assign({ client_name: null, address: null, items: [], stated_total: null, stated_total_evidence: null, quote_date: null, description_lines: [], transcript: "", missing: [] }, o);
}
const FULL = gq({ client_name: "דני לוי", address: "הרצל 12 רעננה", items: [{ service: "ליטוש שיש", area_m2: 40, unit_price: 80 }, { service: "סילר", quantity: 1, unit_price: 1300 }],
  stated_total: 4500, stated_total_evidence: "סה\"כ 4,500", description_lines: ["1. ליטוש שיש 40 מ\"ר, 80 ₪ למ\"ר", "2. מריחת סילר הגנה"] });
const FULL_TEXT = "הצעת מחיר לדני לוי, הרצל 12 רעננה, ליטוש שיש 40 מטר 80 שקל למטר, סילר 1,300, סה\"כ 4,500";

async function liveSuite() {
  origLog("--- LIVE Gemini (text, fake data) ---");
  const geminiBefore = () => calls.filter(c => c.kind === "gemini").length;
  reset(); await post(text(750, FULL_TEXT));
  let d = draftOf(750);
  check("LIVE full quote -> draft with total 4500, ✅ shown", d && d.draft.total === 4500 && !!btnData(last(), "q:ok:"), d && ("total=" + d.draft.total + " client=" + d.draft.client_name + " lines=" + d.draft.description_lines.length));
  reset(); await post(text(751, "הצעה למשפחת כהן, ויצמן 5 נתניה, הברקה קריסטלית בערך 25 מטר"));
  d = draftOf(751);
  check("LIVE missing price -> '❗ חסר מחיר', awaiting total, no ✅", d && d.draft.total === null && d.awaiting_edit_field === "total" && /חסר מחיר/.test(txt(last())) && !btnData(last(), "q:ok:"));
  reset(); await post(text(751, "3,800"));
  check("LIVE reply '3,800' -> total 3800 (code, no AI)", draftOf(751).draft.total === 3800 && calls.filter(c => c.kind === "gemini").length === 0);
  reset(); await post(tap(750, "q:voice:" + draftOf(750).id, draftOf(750).message_id));
  await post(text(750, "תשנה את השטח ל-50 מטר והמחיר הסופי 5,200"));
  d = draftOf(750);
  check("LIVE 🎤 text correction -> 50 m², total 5200, 1/3", d.draft.items.some(i => i.area_m2 === 50) && d.draft.total === 5200 && d.voice_corrections === 1, "total=" + d.draft.total);
  origLog("LIVE Gemini calls: " + calls.filter(c => c.kind === "gemini").length + " (this step) — see per-step counts above");
}

(async function () {
  if (LIVE) {
    let n0 = 0; const countAll = () => n0;
    const origPush = Array.prototype.push;
    await liveSuite();
    origLog("\n" + pass + "/" + (pass + fail) + " passed");
    if (fail) process.exitCode = 1;
    return;
  }
  const today = QX.todayIL();
  let c, d;

  // ===== Start: 🧾 / trigger / details =====
  reset(); await post(text(700, "🧾 הצעת מחיר חדשה"));
  check("🧾 with no draft -> ask for details, state collecting_quote", /שם הלקוח/.test(txt(last())) && db.telegram_chat_state.some(s => s.chat_id === 700 && s.state === "collecting_quote"));
  check("…no quota used, no Gemini", !calls.some(x => x.kind === "rpc" && x.name === "consume_daily_quota") && !calls.some(x => x.kind === "gemini"));
  geminiQueue.push(FULL); reset(); await post(text(700, "דני לוי הרצל 12 רעננה ליטוש 40 מטר 80 שקל סילר 1300 סה\"כ 4,500"));
  d = draftOf(700); c = last();
  const waitMsg = calls.find(x => x.method === "sendMessage" && txt(x) === "⏳ מעבד…");
  check("details after 🧾 -> quota consumed once ('quote', 15)", calls.filter(x => x.kind === "rpc" && x.name === "consume_daily_quota").length === 1 && calls.find(x => x.name === "consume_daily_quota").body.p_limit === 15);
  check("'⏳ מעבד…' first, then that SAME message edited into the draft", !!waitMsg && c.method === "editMessageText" && d && d.message_id === nextMsgId && c.body.message_id === d.message_id);
  check("draft text: date today DD.MM.YYYY, client, address, lines, ₪ total, number note", /^\d{2}\.\d{2}\.\d{4}$/.test(today) && txt(c).includes("📅 תאריך: " + today) &&
    txt(c).includes("👤 לקוח: דני לוי") && txt(c).includes("📍 כתובת: הרצל 12, רעננה") && txt(c).includes("1. ליטוש שיש") && txt(c).includes("💰 סה״כ לתשלום: 4,500 ₪") && txt(c).includes("מספר ההצעה ייקבע באישור"));
  check("'📊 נותרו היום: 14 הצעות מחיר' after creating the draft", txt(c).includes("📊 נותרו היום: 14 הצעות מחיר"));
  const allBtns = buttons(c).map(b => b.text);
  check("buttons: ✅ ✏️×5 🎤 ❌ (no ✂️ when it fits)", ["✅ אשר והפק PDF", "✏️ לקוח", "✏️ כתובת", "✏️ תיאור", "✏️ סכום", "✏️ תאריך", "🎤 תיקון בהקלטה", "❌ ביטול"].every(t => allBtns.includes(t)) && !allBtns.includes("✂️ לקצר אוטומטית"), allBtns.join(" "));
  check("callback_data 'q:<action>:<uuid>' ≤ 64 bytes", buttons(c).every(b => /^q:\w+:[0-9a-f-]{36}$/.test(b.callback_data) && Buffer.byteLength(b.callback_data) <= 64));
  check("collecting state cleared after the draft was made", !db.telegram_chat_state.some(s => s.chat_id === 700));
  check("text input: no '📝 מה הבנתי' (that's for voice)", !txt(c).includes("📝 מה הבנתי"));

  reset(); await post(text(701, "תכין לי הצעת מחיר בבקשה"));
  check("bare trigger 'תכין לי הצעת מחיר' -> ask, no Gemini, no quota", /שם הלקוח/.test(txt(last())) && !calls.some(x => x.kind === "gemini" || (x.kind === "rpc" && x.name === "consume_daily_quota")));
  geminiQueue.push(FULL); reset(); await post(text(702, FULL_TEXT));
  check("keyword text WITH details -> extracted right away", !!draftOf(702) && calls.filter(x => x.kind === "gemini").length === 1);

  // ===== One draft per chat: conflict =====
  reset(); await post(text(700, "תכין לי הצעת מחיר"));
  c = last();
  check("bare trigger while a draft exists -> continue/new buttons, no Gemini, no quota", /יש כבר טיוטת/.test(txt(c)) && btnData(c, "q:cont:") && btnData(c, "q:new:") && !calls.some(x => x.kind === "gemini" || x.name === "consume_daily_quota"));
  check("…chat state quote_conflict (nothing to park for a bare trigger)", db.telegram_chat_state.some(s => s.chat_id === 700 && s.state === "quote_conflict" && !s.context.input));
  const oldId = draftOf(700).id, oldMsg = draftOf(700).message_id;
  reset(); await post(tap(700, btnData(c, "q:cont:")));
  check("↩️ continue -> the existing draft re-sent at the bottom, nothing new", draftOf(700).id === oldId && calls.some(x => x.method === "sendMessage" && txt(x).includes("טיוטת הצעת מחיר")) && draftOf(700).message_id !== oldMsg && !calls.some(x => x.kind === "gemini"));
  reset(); await post(text(700, FULL_TEXT)); c = last();
  check("details while a draft is open -> 6b follow-up prompt, the message parked (draft_followup)", /יש טיוטה פתוחה/.test(txt(c)) && btnData(c, "q:new:") &&
    db.telegram_chat_state.some(s => s.chat_id === 700 && s.state === "draft_followup" && s.context.input.text === FULL_TEXT));
  geminiQueue.push(gq(Object.assign({}, FULL, { client_name: "רינה" })));
  const prevMsg = draftOf(700).message_id;
  reset(); await post(tap(700, btnData(c, "q:new:")));
  check("🆕 new -> old draft deleted + its message 'בוטלה', new draft from the parked message", draftOf(700).draft.client_name === "רינה" && db.telegram_pending_quotes.filter(r => r.chat_id === 700).length === 1 &&
    calls.some(x => x.method === "editMessageText" && x.body.message_id === prevMsg && /בוטלה/.test(txt(x))) && calls.filter(x => x.name === "consume_daily_quota").length === 1);

  // ===== Missing total -> awaiting total; edits in code =====
  geminiQueue.push(gq({ client_name: "משפחת כהן", address: "ויצמן 5 נתניה", items: [{ service: "הברקה קריסטלית", area_m2: 25 }], description_lines: ["הברקה קריסטלית כ-25 מ\"ר"] }));
  reset(); await post(text(703, "הצעה למשפחת כהן ויצמן 5 נתניה הברקה 25 מטר")); d = draftOf(703); c = last();
  check("missing total -> '❗ חסר מחיר — מה המחיר הסופי?', no ✅, awaiting total", txt(c).includes("❗ חסר מחיר — מה המחיר הסופי?") && !btnData(c, "q:ok:") && d.awaiting_edit_field === "total" && !!d.awaiting_since);
  reset(); await post(text(703, "בערך הרבה"));
  check("invalid total reply -> retry prompt, still awaiting", /לא הבנתי את הסכום/.test(txt(last())) && draftOf(703).awaiting_edit_field === "total");
  reset(); await post(text(703, "ארבעת אלפים"));
  c = last(); d = draftOf(703);
  check("'ארבעת אלפים' -> total 4000 (code parser), ✅ appears, edited in place", d.draft.total === 4000 && d.awaiting_edit_field === null && btnData(c, "q:ok:") && c.method === "editMessageText" && c.body.message_id === d.message_id && txt(c).includes("✏️ עודכן: סכום") && !calls.some(x => x.kind === "gemini"));
  reset(); await post(tap(703, "q:client:" + d.id)); await post(text(703, "  משה כהן, 052-1234567  "));
  check("✏️ לקוח -> trimmed, phone dropped", draftOf(703).draft.client_name === "משה כהן", draftOf(703).draft.client_name);
  reset(); await post(tap(703, "q:addr:" + d.id)); await post(text(703, "  הרצל 7, נתניה "));
  check("✏️ כתובת -> trimmed", draftOf(703).draft.address === "הרצל 7, נתניה");
  reset(); await post(tap(703, "q:date:" + d.id)); await post(text(703, "31/02/2026"));
  check("✏️ תאריך invalid (31/02) -> retry", /לא הבנתי את התאריך/.test(txt(last())) && draftOf(703).awaiting_edit_field === "quote_date");
  await post(text(703, "5/3/2026"));
  check("✏️ תאריך '5/3/2026' -> '05.03.2026'", draftOf(703).draft.quote_date === "05.03.2026" && txt(last()).includes("📅 תאריך: 05.03.2026"));
  reset(); await post(tap(703, "q:total:" + d.id)); await post(text(703, "4,750 ש\"ח"));
  check("✏️ סכום '4,750 ש\"ח' -> 4750", draftOf(703).draft.total === 4750);
  reset(); await post(tap(703, "q:desc:" + d.id));
  check("✏️ תיאור prompt shows the current description", txt(last()).includes("התיאור הנוכחי") && txt(last()).includes("הברקה קריסטלית"));
  await post(text(703, "1. הברקה קריסטלית בסלון\n\n2. ניקוי סופי"));
  check("✏️ תיאור -> lines split, empty lines dropped", JSON.stringify(draftOf(703).draft.description_lines) === JSON.stringify(["1. הברקה קריסטלית בסלון", "2. ניקוי סופי"]));

  // too long -> no ✅, ✂️ shown; ✂️ shortens (one Gemini call), ✅ back
  const long = Array.from({ length: 18 }, (_, i) => (i + 1) + ". שורת עבודה ארוכה מספר " + (i + 1)).join("\n");
  reset(); await post(tap(703, "q:desc:" + d.id)); await post(text(703, long)); c = last();
  check("too-long description -> '⚠️ ארוך מדי', no ✅, ✂️ shown", txt(c).includes("ארוך מדי לעמוד אחד") && !btnData(c, "q:ok:") && !!btnData(c, "q:short:"));
  geminiQueue.push({ description_lines: ["1. עבודות ליטוש בכל הבית", "2. ניקוי סופי"] });
  reset(); await post(tap(703, btnData(c, "q:short:"))); c = last();
  check("✂️ -> one shorten call, fits, ✅ back, '✂️ התיאור קוצר'", calls.filter(x => x.kind === "gemini" && x.shorten).length === 1 && draftOf(703).draft.fit.fits && !!btnData(c, "q:ok:") && txt(c).includes("✂️ התיאור קוצר"));

  // sum mismatch warning
  geminiQueue.push(gq({ client_name: "יוסי כץ", address: "הבנים 9", items: [{ service: "ליטוש", area_m2: 50, unit_price: 70 }], stated_total: 3000, stated_total_evidence: "סך הכל 3,000", description_lines: ["ליטוש 50 מ\"ר"] }));
  reset(); await post(text(704, "יוסי כץ הבנים 9 ליטוש 50 מטר 70 שקל סך הכל 3,000"));
  check("sum mismatch -> warning on the draft, stated total kept", txt(last()).includes("⚠️ סכום הפריטים (3,500 ₪) שונה מהמחיר הסופי (3,000 ₪)") && draftOf(704).draft.total === 3000);

  // ===== 🎤 corrections (max 3) =====
  d = draftOf(704);
  for (let i = 1; i <= 3; i++) {
    const prevMid = draftOf(704).message_id;
    geminiQueue.push(gq({ client_name: "יוסי כץ", address: "הבנים 9", items: [{ service: "ליטוש", area_m2: 50, unit_price: 60 }], stated_total: null, description_lines: ["ליטוש 50 מ\"ר"], transcript: "" }));
    reset(); await post(tap(704, "q:voice:" + d.id, prevMid));
    check("🎤 tap " + i + " -> prompt, awaiting voice", /מה לתקן/.test(txt(last())) && draftOf(704).awaiting_edit_field === "voice");
    await post(text(704, "תשנה את המחיר למטר ל-60"));
    c = last();
    check("🎤 correction " + i + " -> applyCorrection, voice_corrections=" + i + ", new message, old buttons removed", draftOf(704).voice_corrections === i &&
      calls.some(x => x.method === "sendMessage" && txt(x) === "⏳ מעבד את התיקון…") && draftOf(704).message_id !== prevMid &&
      calls.some(x => x.method === "editMessageReplyMarkup" && x.body.message_id === prevMid) && txt(c).includes("(" + i + "/3)"));
    check("🎤 correction " + i + " keeps the total (no new total stated)", draftOf(704).draft.total === 3000);
  }
  check("after 3 corrections the 🎤 button is hidden", !buttons(last()).some(b => b.text === "🎤 תיקון בהקלטה"));
  reset(); await post(tap(704, "q:voice:" + d.id));
  check("🎤 tap after 3 -> notice, no AI", /כבר השתמשנו ב-3 תיקונים/.test(txt(last())) && !calls.some(x => x.kind === "gemini"));
  check("corrections never consumed the daily quote quota (5 drafts created -> 10 left)", quotaRemaining.quote === 15 - 5, "remaining=" + quotaRemaining.quote);

  // ===== Voice input =====
  reset(); await post(voice(705, { duration: 200 }));
  check("voice > 3 min -> limit message, no quota, no download", /ארוכה מ-3 דקות/.test(txt(last())) && !calls.some(x => x.name === "consume_daily_quota" || x.kind === "tgfile"));
  reset(); await post(voice(705, { file_size: 16 * 1024 * 1024 }));
  check("voice > 15 MB -> limit message", /גדול מדי/.test(txt(last())) && !calls.some(x => x.kind === "tgfile"));
  const longTranscript = "היי, הצעת מחיר בשביל דני לוי. " + "ליטוש שיש ועוד עבודות. ".repeat(30);
  geminiQueue.push(Object.assign({}, FULL, { transcript: longTranscript }));
  reset(); await post(voice(705)); c = last(); d = draftOf(705);
  const audioB64 = Buffer.from("FAKE-OGG-AUDIO-BYTES").toString("base64");
  check("voice -> '⏳ מעבד…', download, Gemini gets inline audio/ogg", calls.some(x => txt(x) === "⏳ מעבד…") && calls.some(x => x.kind === "tgfile") && lastGeminiBody.includes('"mime_type":"audio/ogg"') && lastGeminiBody.includes(audioB64));
  check("voice draft shows '📝 מה הבנתי:' truncated to 300 chars + '…'", txt(c).includes("📝 מה הבנתי: ") && txt(c).split("📝 מה הבנתי: ")[1].split("\n")[0].length === 301);
  check("audio never stored (not in any DB row, no Storage call)", !JSON.stringify(db).includes(audioB64) && !calls.some(x => x.kind === "storage"));

  // ===== Quota / AI errors / no content =====
  quotaRemaining.quote = 0; reset(); await post(text(706, FULL_TEXT));
  check("quote quota at the limit -> friendly message, no Gemini", /הגענו למכסת הצעות המחיר להיום \(15\)/.test(txt(last())) && !calls.some(x => x.kind === "gemini") && !draftOf(706));
  quotaRemaining.quote = 10;
  geminiStatus = 429; reset(); await post(text(707, FULL_TEXT)); geminiStatus = null;
  check("Gemini 429 -> '⏳' edited to the friendly busy text, no draft", calls.some(x => x.method === "editMessageText" && /המערכת עמוסה כרגע/.test(txt(x))) && !draftOf(707));
  geminiQueue.push(gq({})); reset(); await post(text(708, "הצעת מחיר בלה בלה בלה בלה"));
  check("no quote content -> 'לא מצאתי…', state collecting_quote", /לא מצאתי בהודעה פרטים/.test(txt(last())) && db.telegram_chat_state.some(s => s.chat_id === 708 && s.state === "collecting_quote") && !draftOf(708));

  // ===== ✅ / ❌ / stale =====
  d = draftOf(703);
  reset(); await post(tap(703, "q:ok:" + d.id, d.message_id));
  check("✅ ready draft -> claimed and handed to the 5d approve flow (create_quote attempted once; full coverage in the 5d harness)", calls.filter(x => x.name === "create_quote").length === 1);
  d = draftOf(705); d.draft.total = null; d.awaiting_edit_field = null;
  reset(); await post(tap(705, "q:ok:" + d.id));
  check("✅ on a draft without a total (forged tap) -> refused, not claimed", /חסר מחיר סופי/.test(txt(last())) && !draftOf(705).claimed_at);
  reset(); await post(tap(705, "q:cancel:" + d.id, d.message_id));
  check("❌ -> row deleted (transcript gone), message 'בוטלה'", !draftOf(705) && /טיוטת הצעת המחיר בוטלה/.test(txt(last())) && !JSON.stringify(db).includes("עבודות. ליטוש"));
  reset(); await post(tap(705, "q:total:" + d.id, d.message_id));
  check("tap on a cancelled draft -> 'כבר טופלה או בוטלה', buttons removed", /כבר טופלה או בוטלה/.test(txt(last())) && calls.some(x => x.method === "editMessageReplyMarkup"));
  reset(); await post(tap(709, "q:ok:" + draftOf(704).id));
  check("tap on ANOTHER chat's draft -> refused", /כבר טופלה או בוטלה/.test(txt(last())) && !draftOf(704).claimed_at);

  // edit message gone -> draft re-sent as a new message
  d = draftOf(704); failEditFor.add(d.message_id);
  reset(); await post(tap(704, "q:total:" + d.id)); await post(text(704, "3100"));
  check("edit-in-place fails -> draft sent as a new message, message_id updated", draftOf(704).draft.total === 3100 && last().method === "sendMessage" && draftOf(704).message_id === nextMsgId);

  // ===== Menu tap clears quote edit state =====
  reset(); await post(tap(704, "q:client:" + draftOf(704).id));
  await post(text(704, "❓ עזרה"));
  check("menu tap clears the awaiting field", draftOf(704).awaiting_edit_field === null);
  reset(); await post(text(704, "משה"));
  check("…so the next text is not taken as the client name", draftOf(704).draft.client_name === "יוסי כץ");
  reset(); await post(text(710, "מה קורה?")); const nq = btnData(last(), "newquote");
  reset(); await post(tap(710, "newquote"));
  check("inline '🧾 להכין הצעת מחיר?' -> ask for details", /שם הלקוח/.test(txt(last())));

  // ===== Phase 6b (a): an OPEN draft takes a bare amount; other messages ask =====
  geminiQueue.push(gq({ client_name: "רונית", address: "התומר 3 כפר סבא", items: [{ service: "מדרגות", quantity: 18 }], description_lines: ["ליטוש 18 מדרגות"] }));
  reset(); await post(text(720, "הצעת מחיר לרונית התומר 3 כפר סבא 18 מדרגות"));
  d = draftOf(720);
  check("6b(a) live-test replay: missing total -> awaiting total", d.awaiting_edit_field === "total" && d.draft.total === null);
  reset(); await post(text(720, "3000"));
  check("6b(a) '3000' -> total 3000 (the awaited field)", draftOf(720).draft.total === 3000 && draftOf(720).awaiting_edit_field === null);
  reset(); await post(text(720, "4200"));
  c = calls.filter(x => x.method === "editMessageText").slice(-1)[0];
  check("6b(a) then '4200' (nothing awaited) -> total 4200, draft edited IN PLACE, no AI", draftOf(720).draft.total === 4200 && c && c.body.message_id === draftOf(720).message_id &&
    txt(c).includes("💰 סה״כ לתשלום: 4,200 ₪") && !calls.some(x => x.kind === "gemini"));
  check("6b(a) …reply '✏️ הסכום עודכן ל-4,200 ₪' (not 'לא בטוח שהבנתי')", txt(last()) === "✏️ הסכום עודכן ל-4,200 ₪" && !calls.some(x => /לא בטוח שהבנתי/.test(txt(x))));
  for (const [t, v] of [["4,350 ₪", 4350], ["4400 ש\"ח", 4400], ["ארבעת אלפים וחמש מאות", 4500], ["₪4,600", 4600]]) {
    reset(); await post(text(720, t));
    check("6b(a) bare amount '" + t + "' -> " + v, draftOf(720).draft.total === v && txt(last()).startsWith("✏️ הסכום עודכן ל-"));
  }
  reset(); await post(text(720, "תוסיף גם ניקוי סופי"));
  c = last();
  check("6b(a) other text -> 'יש טיוטה פתוחה (רונית). לעדכן אותה?' + ✏️ / 🧾 / ✖️, nothing applied yet", /^יש טיוטה פתוחה \(רונית\)\. לעדכן אותה\?/.test(txt(c)) &&
    buttons(c).map(b => b.text).join("|") === "✏️ לתקן את הטיוטה|🧾 הצעה חדשה|✖️ התעלם" && !calls.some(x => x.kind === "gemini"));
  check("6b(a) …the message is parked in chat state (draft_followup), not in the draft", db.telegram_chat_state.some(s => s.chat_id === 720 && s.state === "draft_followup" && s.context.input.text === "תוסיף גם ניקוי סופי" && s.context.draft_id === draftOf(720).id));
  geminiQueue.push(gq({ client_name: "רונית", address: "התומר 3, כפר סבא", items: [{ service: "מדרגות", quantity: 18 }], description_lines: ["ליטוש 18 מדרגות", "ניקוי סופי"] }));
  reset(); await post(tap(720, btnData(c, "q:fix:"), 1));
  check("6b(a) ✏️ -> applyCorrection with the parked text, counts 1/3, total kept, prompt buttons removed", lastGeminiBody.includes("תוסיף גם ניקוי סופי") && draftOf(720).voice_corrections === 1 &&
    draftOf(720).draft.description_lines.includes("ניקוי סופי") && draftOf(720).draft.total === 4600 && calls.some(x => x.method === "editMessageReplyMarkup" && x.body.message_id === 1) &&
    !db.telegram_chat_state.some(s => s.chat_id === 720));
  reset(); await post(text(720, "בעצם עזוב")); c = last();
  reset(); await post(tap(720, btnData(c, "q:skip:"), 2));
  check("6b(a) ✖️ -> nothing changed, state cleared, 'הטיוטה נשארה'", /הטיוטה נשארה/.test(txt(last())) && draftOf(720).voice_corrections === 1 && !calls.some(x => x.kind === "gemini") && !db.telegram_chat_state.some(s => s.chat_id === 720));
  reset(); await post(voice(720)); c = last();
  const parkedVoice = db.telegram_chat_state.find(s => s.chat_id === 720);
  check("6b(a) voice while a draft is open -> the same prompt; parks the voice's file_id only (no audio)", /יש טיוטה פתוחה/.test(txt(c)) && parkedVoice.context.input.kind === "voice" &&
    parkedVoice.context.input.file_id === "VOICEFILE" && !calls.some(x => x.kind === "tgfile") && !JSON.stringify(db).includes(Buffer.from("FAKE-OGG-AUDIO-BYTES").toString("base64")));
  geminiQueue.push(gq({ client_name: "רונית", address: "התומר 3, כפר סבא", items: [], description_lines: ["ליטוש 18 מדרגות"], transcript: "תוריד את הניקוי" }));
  reset(); await post(tap(720, btnData(c, "q:fix:"), 3));
  check("6b(a) ✏️ on a parked voice -> downloaded by file_id NOW, corrected, 2/3", calls.some(x => x.kind === "tgfile") && draftOf(720).voice_corrections === 2 && lastGeminiBody.includes("audio/ogg"));
  // chat 720 has now hit the real quote-flow rate limit (10 / 10 min, correct bot behavior), so the rest runs on a fresh chat
  geminiQueue.push(gq({ client_name: "רונית", address: "התומר 3, כפר סבא", items: [], stated_total: 4600, stated_total_evidence: "4,600", description_lines: ["ליטוש 18 מדרגות"] }));
  await post(text(722, "הצעת מחיר לרונית התומר 3 כפר סבא מדרגות 4,600"));
  draftOf(722).voice_corrections = 2;
  reset(); await post(text(722, "אולי שינוי אחד")); c = last();
  geminiQueue.push(gq({ client_name: "רונית", address: "התומר 3, כפר סבא", items: [], description_lines: ["ליטוש 18 מדרגות"] }));
  await post(tap(722, btnData(c, "q:fix:"), 4));
  reset(); await post(text(722, "ועוד שינוי"));
  c = last();
  check("6b(a) after 3 corrections the prompt has no ✏️ and explains why", draftOf(722).voice_corrections === 3 && !btnData(c, "q:fix:") && !!btnData(c, "q:new:") && /נגמרו 3 התיקונים/.test(txt(c)));
  reset(); await post(tap(722, "q:fix:" + draftOf(722).id, 5));
  check("6b(a) a forged ✏️ after the cap -> refused, no AI", /כבר השתמשנו ב-3 תיקונים/.test(txt(last())) && !calls.some(x => x.kind === "gemini"));
  db.telegram_chat_state = db.telegram_chat_state.filter(s => s.chat_id !== 722);
  reset(); await post(tap(722, "q:fix:" + draftOf(722).id, 6));
  check("6b(a) ✏️ when the parked message expired -> 'ההודעה כבר לא זמינה'", /ההודעה כבר לא זמינה/.test(txt(last())) || /כבר השתמשנו/.test(txt(last())));
  reset(); await post(text(722, "❓ עזרה"));
  check("6b(a) a menu label with an open draft -> the menu, not the prompt", /מה אפשר לעשות כאן/.test(txt(last())) && !calls.some(x => /יש טיוטה פתוחה/.test(txt(x))));
  reset(); await post({ message: { message_id: 1, chat: { id: 722 }, from: { id: 722 }, photo: [{ file_id: "p" }] } });
  check("6b(a) a photo with an open draft -> the receipt flow", db.telegram_pending_receipts.some(r => r.chat_id === 722) && !calls.some(x => /יש טיוטה פתוחה/.test(txt(x))));
  // not open: claimed by an approve in progress, or already a quote
  draftOf(722).claimed_at = new Date().toISOString();
  reset(); await post(text(722, "5000"));
  check("6b(a) draft being approved (claimed) is not 'open' -> '5000' isn't applied (and not throttled)", draftOf(722).draft.total === 4600 && !calls.some(x => /הסכום עודכן|לאט לאט/.test(txt(x))));
  draftOf(722).claimed_at = null; draftOf(722).quote_id = "11111111-1111-4111-8111-111111111111";
  reset(); await post(text(722, "5000"));
  check("6b(a) draft that already has a quote is not 'open' -> '5000' isn't applied (and not throttled)", draftOf(722).draft.total === 4600 && !calls.some(x => /הסכום עודכן|יש טיוטה פתוחה|לאט לאט/.test(txt(x))));

  // ===== Audit batch B =====
  quotaRemaining.quote = 15;
  // L4: the stated-total words on the draft
  geminiQueue.push(gq({ client_name: "עדי", address: "הגפן 3, חולון", items: [], stated_total: 4500, stated_total_evidence: "סה\"כ 4,500", description_lines: ["ליטוש"] }));
  reset(); await post(text(730, "הצעת מחיר לעדי הגפן 3 חולון ליטוש סה\"כ 4,500"));
  check("L4 draft shows the words the total came from: 💰 נאמר: \"סה\"כ 4,500\"", txt(last()).includes("💰 נאמר: \"סה\"כ 4,500\"") && draftOf(730).draft.total_evidence === "סה\"כ 4,500");
  reset(); await post(text(730, "4800"));
  c = calls.filter(x => x.method === "editMessageText").slice(-1)[0];
  check("L4 a total typed by hand -> no 'נאמר' line (no spoken words), evidence cleared", draftOf(730).draft.total === 4800 && draftOf(730).draft.total_evidence === null && !txt(c).includes("💰 נאמר"));
  geminiQueue.push(gq({ client_name: "גל", address: "—", items: [], stated_total: 3000, stated_total_evidence: "המחיר הסופי 3000", description_lines: ["ליטוש"] }));
  await post(text(731, "הצעת מחיר לגל ליטוש המחיר הסופי 3000"));
  const d731 = draftOf(731);
  geminiQueue.push(gq({ client_name: "גל כהן", address: "—", items: [], stated_total: null, description_lines: ["ליטוש"] }));
  reset(); await post(tap(731, "q:voice:" + d731.id)); await post(text(731, "השם הוא גל כהן"));
  check("L4 a correction without a new total keeps the total AND its words", draftOf(731).draft.total === 3000 && draftOf(731).draft.total_evidence === "המחיר הסופי 3000" && txt(last()).includes("💰 נאמר: \"המחיר הסופי 3000\""));

  // L6: a date Gemini reads as "5.3.2026" is stored and shown padded
  geminiQueue.push(gq({ client_name: "נועה", address: "—", items: [], stated_total: 900, stated_total_evidence: "900", quote_date: "5.3.2026", description_lines: ["ליטוש"] }));
  reset(); await post(text(733, "הצעת מחיר לנועה ליטוש 900 לתאריך 5.3.2026"));
  check("L6 a stated date '5.3.2026' -> '05.03.2026' (DD.MM.YYYY)", draftOf(733).draft.quote_date === "05.03.2026" && txt(last()).includes("📅 תאריך: 05.03.2026"));

  // L5: the "waiting for details" path re-checks for an open draft before creating one
  db.telegram_chat_state.push({ chat_id: 730, state: "collecting_quote", state_since: new Date().toISOString(), context: {} }); // a stale state next to a draft
  const quotaBeforeL5 = quotaRemaining.quote;
  reset(); await post(text(730, "דני לוי הרצל 12 רעננה ליטוש סה\"כ 4,500"));
  check("L5 details while 'waiting' but a draft already exists -> the continue/new choice; no AI, no quota, still ONE draft", /יש כבר טיוטת/.test(txt(last())) &&
    !calls.some(x => x.kind === "gemini") && quotaRemaining.quote === quotaBeforeL5 && db.telegram_pending_quotes.filter(r => r.chat_id === 730).length === 1);

  // L2: a timed-out lookup -> a friendly Hebrew error (not a stuck chat)
  db.telegram_chat_state = db.telegram_chat_state.filter(x => x.chat_id !== 734);
  draftLookupTimeoutOnce = true; reset(); await post(text(734, "תכין לי הצעת מחיר"));
  check("L2 the draft lookup times out -> 'שגיאה זמנית. נסו שוב בעוד רגע.'", /שגיאה זמנית/.test(txt(last())));

  // ===== Phase 7a: callback validation, 24 h draft expiry, quote rate limit 30 =====
  for (const bad of ["q:ok:not-a-uuid", "q:ok:" + draftOf(722).id + ":extra", "q:pdf:../../etc", "cyclecat:abc", "confirm:' or 1=1"]) {
    reset(); await post(tap(722, bad));
    check("7a forged callback '" + bad.slice(0, 24) + "' -> ignored (no DB lookup, no reply)", !calls.some(x => x.kind === "rest" && x.table !== "telegram_processed_updates" && x.method !== "DELETE") && tgSends().length === 0);
  }
  geminiQueue.push(gq({ client_name: "ישן", address: "—", items: [], stated_total: 1000, stated_total_evidence: "1000", description_lines: ["ישן"] }));
  await post(text(723, "הצעת מחיר לישן 1000"));
  const oldDraft = draftOf(723);
  oldDraft.created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  reset(); await post(text(723, "4200"));
  check("7a a draft older than 24 h is not 'open' (a bare amount isn't applied to it)", oldDraft.draft.total === 1000 && !calls.some(x => /הסכום עודכן|יש טיוטה פתוחה/.test(txt(x))));
  reset(); await post(tap(723, "q:total:" + oldDraft.id));
  check("7a tapping a button of a > 24 h draft -> 'כבר טופלה', and the row is deleted on the spot", /כבר טופלה או בוטלה/.test(txt(last())) && !db.telegram_pending_quotes.some(r => r.id === oldDraft.id));
  let throttled = 0;
  const quotaBefore = quotaRemaining.quote;
  for (let i = 0; i < 31; i++) {
    db.telegram_chat_state = db.telegram_chat_state.filter(s => s.chat_id !== 724); // each is a fresh bare trigger (no extraction)
    reset(); await post(text(724, "הצעת מחיר")); if (calls.some(x => /לאט לאט/.test(txt(x)))) throttled++;
  }
  check("7a quote-flow rate limit: 30 per 10 min per chat (31st throttled)", throttled === 1 && quotaRemaining.quote === quotaBefore, "throttled=" + throttled);

  // ===== Phase 6b (b): address "<street> <number>, <city>" =====
  geminiQueue.push(gq({ client_name: "אורי", address: "רעננה אהרון 2", items: [], stated_total: 3000, stated_total_evidence: "3000", description_lines: ["ליטוש"] }));
  reset(); await post(text(721, "הצעת מחיר לאורי רעננה אהרון 2 ליטוש 3000"));
  check("6b(b) 'רעננה אהרון 2' -> '📍 כתובת: אהרון 2, רעננה'", draftOf(721).draft.address === "אהרון 2, רעננה" && txt(last()).includes("📍 כתובת: אהרון 2, רעננה"));
  check("6b(b) the extraction prompt asks for '<street> <number>, <city>' and forbids inventing parts", lastGeminiBody.includes("<street> <number>, <city>") && lastGeminiBody.includes("Never invent or guess a street, number or city"));
  for (const [inp, out] of [["הרצל 12 ברעננה", "הרצל 12, רעננה"], ["הרצל 12 בת ים", "הרצל 12, בת ים"], ["ויצמן 5", "ויצמן 5"], ["התומר 3, כפר סבא", "התומר 3, כפר סבא"], ["רעננה", "רעננה"]]) {
    check("6b(b) normalizeAddress('" + inp + "') -> '" + out + "' (nothing invented)", QX.normalizeAddress(inp) === out, QX.normalizeAddress(inp));
  }

  // ===== Phase 6b (c): money "4,200 ₪" everywhere =====
  const moneyTexts = allTexts.filter(t => /₪/.test(t));
  const wrongOrder = allTexts.filter(t => /₪\s*\d/.test(t));
  check("6b(c) every amount the bot sent in this run reads '<number> ₪' (none '₪<number>')", moneyTexts.length > 20 && wrongOrder.length === 0 &&
    moneyTexts.every(t => (t.match(/\d[\d,.]*\s₪/g) || []).length > 0), "money texts=" + moneyTexts.length + " wrong=" + wrongOrder.slice(0, 1).join(" | "));
  // receipts too (fmtMoney): a receipt summary in this run
  check("6b(c) receipt summary money also '<number> ₪'", allTexts.some(t => /50\.00 ₪/.test(t)));

  // ===== Logs + receipt regression =====
  check("logs: no client names, addresses, transcripts or tokens", !logs.some(l => /דני|לוי|כהן|הרצל|ויצמן|יוסי|ליטוש|TESTFAKE|svc-fake/.test(l)), logs.filter(l => /דני|לוי|כהן|הרצל/.test(l)).slice(0, 2).join(" | "));
  reset(); await post({ message: { message_id: 1, chat: { id: 711 }, from: { id: 711 }, photo: [{ file_id: "p" }] } });
  const rp = db.telegram_pending_receipts.find(r => r.chat_id === 711);
  check("receipt regression: photo -> receipt summary (not the quote flow)", !!rp && calls.some(x => x.method === "sendMessage" && JSON.stringify(x.body.reply_markup || {}).includes("confirm:")));
  reset(); await post(tap(711, "cancel:" + rp.id, rp.message_id));
  check("receipt regression: cancel", !db.telegram_pending_receipts.some(r => r.chat_id === 711));
  check("receipt quota only for receipts (2 photos in this run -> 18 left)", quotaRemaining.receipt === 18);

  origLog("\n" + pass + "/" + (pass + fail) + " passed");
  if (fail) process.exitCode = 1;
})().catch(e => { origLog("HARNESS ERROR " + e.stack); process.exitCode = 1; });
