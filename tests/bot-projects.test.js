// Media-projects command 5: the bot's "📸 פרויקט חדש" — mocked harness for every path: menu, collecting
// (albums, dedupe, video + cover, documents, too big, the media_file quota, text / voice), ✅ סיימתי →
// the AI (auto), the questions (city, pairs, privacy flags, consent no / yes), destinations + timing
// (burst-guard slots), ✅ אשר, the edits (✏️ / 🎤 / ✂️), delete, the photo-not-a-receipt prompt, album
// routing (📷 / 📸 / receipt mode / table missing), the stale sweep, ownership, and a receipt regression.
// EVERY outbound call is mocked (Telegram, Supabase REST + Storage, /api/media, Gemini). Fake values only.
"use strict";
const path = require("path");
const crypto = require("crypto");
const REPO = path.resolve(__dirname, "..");

let bg = [];
require.cache[require.resolve(path.join(REPO, "node_modules/@vercel/functions"))] = {
  id: "vf", filename: "vf", loaded: true, exports: { waitUntil: (p) => { bg.push(p); } }
};
Object.assign(process.env, {
  VERCEL_ENV: "preview", VERCEL_URL: "preview.example",
  TELEGRAM_TEST_BOT_TOKEN: "222:TESTFAKE", TELEGRAM_TEST_WEBHOOK_SECRET: "test-secret-fake",
  TELEGRAM_TEST_ALLOWED_CHATS: Array.from({ length: 40 }, (_, i) => String(600 + i)).join(","),
  TELEGRAM_BOT_TOKEN: "111:PRODFAKE", TELEGRAM_WEBHOOK_SECRET: "prod-secret-fake", TELEGRAM_ALLOWED_CHATS: "500",
  SUPABASE_SERVICE_ROLE_KEY: "svc-fake", GOOGLE_AI_API_KEY: "g-fake",
  INTERNAL_API_SECRET: "int-secret-fake", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-fake"
});
const SECRET = "test-secret-fake";
const BS = require(REPO + "/shared/burst-schedule.js");

// ---------------------------------------------------------------- mock state
const db = { projects: [], project_media: [], telegram_chat_state: [], telegram_processed_updates: [], telegram_pending_receipts: [],
  telegram_parked_media: [], content_queue: [], business_expenses: [], telegram_pending_quotes: [], telegram_daily_usage: [] };
let quota = { receipt: 20, quote: 15, media_file: 80, media_ai: 30 };
let parkedTableMissing = false;
let aiMode = "ok";             // ok | busy
let correctMode = "short";     // short | not_changed
let scenario = {};             // what the mocked analyze returns
let geminiExtraction;
let calls = [];
let nextMsgId = 100;          // ONE id sequence per chat for both sides, like Telegram (the bot's sort relies on it)
const fileSizes = {};          // Telegram file_id → size
const goneMessages = new Set();
const storageReceipts = new Set();
const uploaded = {};           // project-originals paths uploaded through the signed URLs

const uuid = () => crypto.randomUUID();
function res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new Uint8Array(0).buffer }; }

function parseQs(qs) {
  const f = []; f.opts = {};
  for (const part of (qs || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent(part.slice(0, eq)), v = decodeURIComponent(part.slice(eq + 1));
    if (["select", "order", "limit", "on_conflict"].includes(k)) { f.opts[k] = v; continue; }
    f.push({ col: k, op: v });
  }
  return f;
}
function matchRow(row, { col, op }) {
  const v = row[col];
  if (op === "is.null") return v == null;
  if (op === "not.is.null") return v != null;
  let m = op.match(/^in\.\((.*)\)$/);
  if (m) return m[1].split(",").includes(String(v));
  m = op.match(/^(eq|gt|lt|gte|lte)\.(.*)$/);
  if (!m) return true;
  const a = String(v), b = m[2];
  return { eq: a === b, gt: v != null && a > b, lt: v != null && a < b, gte: v != null && a >= b, lte: v != null && a <= b }[m[1]];
}
function select(table, f) {
  let rows = db[table].filter(r => f.every(x => matchRow(r, x)));
  if (f.opts.order) { const [c, dir] = f.opts.order.split(",")[0].split("."); rows = rows.slice().sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (dir === "desc" ? -1 : 1)); }
  if (f.opts.limit) rows = rows.slice(0, +f.opts.limit);
  if (/project_media\(/.test(f.opts.select || "")) rows = rows.map(r => Object.assign({}, r, { project_media: db.project_media.filter(m => m.project_id === r.id).map(m => ({ id: m.id })) }));
  return rows.map(r => JSON.parse(JSON.stringify(r)));
}

// /api/media (mocked like the real one: internal secret, quota, unique (project, telegram id) → 409)
function mediaApi(action, body, headers) {
  calls.push({ kind: "media", action, body, secret: headers["X-Internal-Secret"], bypass: headers["x-vercel-protection-bypass"] });
  if (headers["X-Internal-Secret"] !== "int-secret-fake") return res(401, { code: "unauthorized" });
  const proj = db.projects.find(p => p.id === body.project_id);
  if (action === "create-upload") {
    if (!proj) return res(404, { code: "project_not_found", he: "הפרויקט לא נמצא." });
    const video = /^video\//.test(body.content_type);
    const p = body.project_id + "/" + (video ? "" : "incoming/") + uuid() + (video ? ".mp4" : ".jpg");
    return res(200, { ok: true, path: p, signed_url: "https://mmognkxkglkotzkuxzly.supabase.co/storage/v1/object/upload/sign/project-originals/" + p + "?token=t" });
  }
  if (action === "process") {
    if (!proj) return res(404, { code: "project_not_found" });
    if (!uploaded[body.path]) return res(404, { code: "upload_missing", he: "הקובץ לא נמצא." });
    if (quota.media_file <= 0) return res(429, { code: "quota", he: "הגעתם למכסת הקבצים היומית. אפשר להמשיך מחר." });
    quota.media_file--;
    if (body.telegram_file_unique_id && db.project_media.some(m => m.project_id === body.project_id && m.telegram_file_unique_id === body.telegram_file_unique_id)) {
      return res(409, { code: "duplicate", he: "הקובץ הזה כבר נמצא בפרויקט." });
    }
    const id = uuid(), video = /\.mp4$/.test(body.path);
    const base = body.project_id + "/" + id + "/" + (video ? "cover-" : "");
    const row = { id, project_id: body.project_id, kind: video ? "video" : "image", role: body.role || null, pair_no: null, sort: body.sort || 0,
      variants: video ? (body.cover_path ? { cover: { jpg: { path: base + "w1600.jpg" } } } : null) : { jpg: { path: base + "w1600.jpg" }, w480: { path: base + "w480.webp" } },
      ai_flags: null, flags_ack_at: null, telegram_file_unique_id: body.telegram_file_unique_id || null, cover_path: body.cover_path || null, created_at: new Date().toISOString() };
    db.project_media.push(row);
    return res(200, { ok: true, media: row });
  }
  if (action === "analyze") {
    if (aiMode === "busy") return res(503, { code: "ai_busy", he: "עמוס" });
    quota.media_ai--;
    const imgs = db.project_media.filter(m => m.project_id === body.project_id && m.kind === "image").sort((a, b) => a.sort - b.sort);
    imgs.forEach((m, i) => {
      const s = (scenario.images || [])[i] || { role: i % 2 ? "after" : "before", pair_no: Math.floor(i / 2) + 1 };
      Object.assign(m, { role: s.role, pair_no: s.pair_no, ai_flags: Object.assign({ quality: [] }, s.flags || {}) });
    });
    Object.assign(proj, { status: proj.status === "collecting" ? "draft" : proj.status, service: "marble_stone", title_he: "ליטוש שיש בסלון", title_en: "Marble",
      summary_he: "רצפת שיש עמומה קיבלה ליטוש והברקה.", city: scenario.city === undefined ? "רעננה" : scenario.city,
      ai_meta: Object.assign({}, proj.ai_meta || {}, { caption_body_he: "השיש בסלון חזר לברק.", hashtags: ["#ליטוש_שיש"], needs_review: !!scenario.needs_review,
        caption_he: "השיש בסלון חזר לברק.\n\n📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com\n\n#ליטוש_שיש", warnings: [], analyzed_at: new Date().toISOString() }) });
    return res(200, { ok: true, analysis: { transcript: body.audio ? "ליטשנו שיש בסלון ברעננה" : null, warnings: [] }, project: proj });
  }
  if (action === "correct") {
    quota.media_ai--;
    const meta = proj.ai_meta || {};
    if (correctMode === "short") { meta.caption_body_he = "שיש מבריק."; meta.caption_he = "שיש מבריק.\n\n📞 …"; meta.warnings = []; }
    else meta.warnings = ["caption_not_changed"];
    proj.ai_meta = Object.assign({}, meta);
    return res(200, { ok: true, analysis: { warnings: meta.warnings }, project: proj });
  }
  if (action === "delete") {
    db.project_media = db.project_media.filter(m => m.id !== body.media_id);
    return res(200, { ok: true });
  }
  if (action === "delete-project") {
    db.projects = db.projects.filter(p => p.id !== body.project_id);
    db.project_media = db.project_media.filter(m => m.project_id !== body.project_id);
    return res(200, { ok: true, deleted: body.project_id });
  }
  return res(404, { code: "not_found" });
}

global.fetch = async function (url, init) {
  init = init || {}; url = String(url);
  const method = init.method || "GET";
  const headers = init.headers || {};
  const body = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch (e) { return init.body; } })() : init.body;
  let m;
  if ((m = url.match(/^https:\/\/preview\.example\/api\/media\?action=([\w-]+)$/))) return mediaApi(m[1], body, headers);
  if ((m = url.match(/\/storage\/v1\/object\/upload\/sign\/project-originals\/(.+)\?token=/))) {
    calls.push({ kind: "put", path: m[1], method, upsert: headers["x-upsert"], bytes: Buffer.from(init.body || []).toString() });
    uploaded[m[1]] = true; return res(200, {});
  }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/file\/bot([^/]+)\/f\/(.+)$/))) {
    calls.push({ kind: "tgfile", token: m[1], file_id: m[2] });
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(Buffer.from("BYTES:" + m[2])).buffer };
  }
  if ((m = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/))) {
    calls.push({ kind: "tg", token: m[1], method: m[2], body });
    if (m[2] === "getFile") return res(200, { ok: true, result: { file_path: "f/" + body.file_id, file_size: fileSizes[body.file_id] || 1000 } });
    if (m[2] === "editMessageText" && goneMessages.has(body.message_id)) return res(400, { ok: false, description: "Bad Request: message to edit not found" });
    if (["sendMessage", "sendPhoto"].includes(m[2])) return res(200, { ok: true, result: { message_id: ++nextMsgId } });
    if (m[2] === "sendMediaGroup") return res(200, { ok: true, result: body.media.map(() => ({ message_id: ++nextMsgId })) });
    return res(200, { ok: true, result: true });
  }
  if (url.includes("generativelanguage.googleapis.com")) { calls.push({ kind: "gemini" }); return res(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(geminiExtraction) }] } }] }); }
  if (url.includes("/storage/v1/object/receipts/")) {
    const p = decodeURIComponent(url.split("/storage/v1/object/receipts/")[1]);
    calls.push({ kind: "receiptStorage", method, path: p });
    if (method === "POST") storageReceipts.add(p);
    if (method === "DELETE") storageReceipts.delete(p);
    return res(200, {});
  }
  if ((m = url.match(/\/rest\/v1\/rpc\/(\w+)$/))) {
    calls.push({ kind: "rpc", name: m[1], body });
    const k = body.p_kind;
    if (m[1] === "get_daily_quota_remaining") return res(200, quota[k]);
    if (quota[k] <= 0) return res(200, -1);
    quota[k]--; return res(200, quota[k]);
  }
  if ((m = url.match(/\/rest\/v1\/(\w+)(?:\?(.*))?$/))) {
    const table = m[1], f = parseQs(m[2] || "");
    calls.push({ kind: "rest", table, method, qs: m[2] || "", body });
    if (table === "telegram_parked_media" && parkedTableMissing) return res(404, { code: "PGRST205", message: "Could not find the table" });
    if (!db[table]) throw new Error("unmocked table " + table);
    if (method === "GET") return res(200, select(table, f));
    if (method === "POST") {
      if (table === "telegram_processed_updates") {
        if (db[table].some(r => r.update_id === body.update_id)) return res(409, { code: "23505" });
        db[table].push({ update_id: body.update_id, created_at: new Date().toISOString() }); return res(201, null);
      }
      if (table === "telegram_chat_state") {
        db[table] = db[table].filter(r => String(r.chat_id) !== String(body.chat_id));
        db[table].push(JSON.parse(JSON.stringify(body))); return res(201, null);
      }
      if (table === "telegram_parked_media" && db[table].some(r => r.chat_id === body.chat_id && r.media_group_id === body.media_group_id && r.file_unique_id === body.file_unique_id)) return res(409, { code: "23505" });
      const row = Object.assign({ id: uuid(), created_at: new Date().toISOString() },
        table === "projects" ? { consent: "unknown", watermark: true, ai_meta: null, city: null, title_he: null, service: null, summary_he: null } : {},
        table === "telegram_pending_receipts" ? { claimed_at: null, message_id: null } : {}, body);
      db[table].push(row); return res(201, [JSON.parse(JSON.stringify(row))]);
    }
    if (method === "PATCH") {
      const rows = db[table].filter(r => f.every(x => matchRow(r, x)) && (!/claimed_at/.test(m[2] || "") || r.claimed_at == null));
      rows.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(body))));
      return res(200, rows.map(r => JSON.parse(JSON.stringify(r))));
    }
    if (method === "DELETE") { const del = db[table].filter(r => f.every(x => matchRow(r, x))); db[table] = db[table].filter(r => !del.includes(r)); return res(204, null); }
  }
  throw new Error("unmocked fetch " + method + " " + url);
};

const logs = [];
console.error = (...a) => logs.push(a.join(" "));
const handler = require(REPO + "/api/telegram-webhook.js");
const BP = require(REPO + "/api/_bot-projects.js");
Object.assign(BP._internal.TIMING, { recountMs: 1, pollMs: 1, albumWaitMs: 1 });

let updateId = 7000;
async function post(update) {
  await new Promise(resolve => {
    const r = { status() { return r; }, json() { resolve(); return r; }, setHeader() {} };
    handler({ method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: Object.assign({ update_id: ++updateId }, update) }, r);
  });
  while (bg.length) { const p = bg; bg = []; await Promise.all(p); }
}
const msg = (chat, extra) => ({ message: Object.assign({ message_id: ++nextMsgId, chat: { id: chat, type: "private" }, from: { id: chat } }, extra) });
const text = (chat, t) => msg(chat, { text: t });
const photo = (chat, fid, extra) => msg(chat, Object.assign({ photo: [{ file_id: fid + "-s", file_unique_id: "u-" + fid + "-s", file_size: 100 }, { file_id: fid, file_unique_id: "u-" + fid, file_size: 900 }] }, extra || {}));
const tap = (chat, data, messageId) => ({ callback_query: { id: "cb" + (updateId + 1), data, from: { id: chat }, message: { message_id: messageId || 1, chat: { id: chat } } } });

const tg = (method) => calls.filter(c => c.kind === "tg" && (!method || c.method === method));
const texts = () => tg().filter(c => c.method === "sendMessage" || c.method === "editMessageText" || c.method === "sendPhoto").map(c => c.body.text || c.body.caption || "");
const lastText = () => texts().slice(-1)[0] || "";
const media = (action) => calls.filter(c => c.kind === "media" && (!action || c.action === action));
function button(re) {
  const msgs = tg().filter(c => c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard).reverse();
  for (const c of msgs) for (const row of c.body.reply_markup.inline_keyboard) for (const b of row) if (re.test(b.text)) return b.callback_data;
  return null;
}
const stateOf = (chat) => db.telegram_chat_state.find(r => String(r.chat_id) === String(chat));
const projectsOf = (chat) => db.projects.filter(p => String(p.telegram_chat_id) === String(chat));
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " — " + detail : "")); }
function reset() { calls = []; }
function receiptExtraction() { geminiExtraction = { vendor_name: "סופר דוגמה", date: "2026-10-20", total_amount: 123.45, vat_amount: null, amount_before_vat: null, invoice_number: null, category: "שונות", confidence_notes: "" }; }
function noReceiptExtraction() { geminiExtraction = { vendor_name: null, date: null, total_amount: null, vat_amount: null, amount_before_vat: null, invoice_number: null, category: "שונות", confidence_notes: "" }; }

(async function () {
  try {
    // ================================================================== menu + start
    const A = 600;
    reset(); await post(text(A, "📸 פרויקט חדש"));
    let P = projectsOf(A)[0];
    check("📸 → a projects row: collecting, source telegram, telegram_chat_id", P && P.status === "collecting" && P.source === "telegram" && P.telegram_chat_id === A);
    check("📸 → the owner's exact start text", texts().some(t => t === BP._internal.START_TEXT) && /שלחי את התמונות והסרטונים \(אפשר כמה ביחד\), ובהקלטה או בטקסט ספרי בקצרה מה עשינו ובאיזו עיר\. כשמסיימים – ✅ סיימתי/.test(BP._internal.START_TEXT));
    check("📸 → one status message with ✅ סיימתי", /📥 התקבלו 0 קבצים/.test(lastText()) && button(/✅ סיימתי/) === "p:done:" + P.id);
    check("📸 → chat state collecting_project (project id, status message id)", stateOf(A) && stateOf(A).state === "collecting_project" && stateOf(A).context.project_id === P.id && stateOf(A).context.status_mid > 0);
    const statusMid = stateOf(A).context.status_mid;

    // ================================================================== collecting
    reset();
    for (const f of ["al1", "al2", "al3"]) await post(photo(A, f, { media_group_id: "g-100" }));
    let rows = db.project_media.filter(m => m.project_id === P.id);
    check("album of 3 in project mode → 3 project_media rows (no album question)", rows.length === 3 && !texts().some(t => /קבלות או/.test(t)));
    check("album: no receipt scan (no Gemini, no receipt quota)", !calls.some(c => c.kind === "gemini") && quota.receipt === 20);
    check("album: create-upload JPEG → signed PUT (upsert off) → process with the Telegram file_unique_id", media("create-upload").every(c => c.body.content_type === "image/jpeg") &&
      calls.filter(c => c.kind === "put").every(c => c.upsert === "false") && media("process").map(c => c.body.telegram_file_unique_id).join() === "u-al1,u-al2,u-al3");
    check("album: the largest photo size is downloaded", calls.filter(c => c.kind === "tgfile").map(c => c.file_id).join() === "al1,al2,al3");
    check("server-to-server: every media call carries the internal secret + the preview bypass", media().every(c => c.secret === "int-secret-fake" && c.bypass === "bypass-fake"));
    check("the ONE status message is edited in place: 📥 התקבלו 3 קבצים", tg("editMessageText").some(c => c.body.message_id === statusMid && /📥 התקבלו 3 קבצים \(3 תמונות\)/.test(c.body.text)) && !tg("sendMessage").some(c => /📥/.test(c.body.text)));
    check("sort follows the message order", rows.map(r => r.sort).every((s, i, a) => i === 0 || s > a[i - 1]));

    reset(); await post(photo(A, "al2"));
    check("dedupe: the same photo again → no new row, no upload, no process", db.project_media.filter(m => m.project_id === P.id).length === 3 && !media("process").length && !calls.some(c => c.kind === "put"));

    // race: the pre-check misses, the DB unique index catches it (api/media.js → 409)
    reset();
    const realGet = global.fetch;
    let hide = true;
    global.fetch = async (u, i) => (hide && /telegram_file_unique_id=eq\.u-al3/.test(String(u)) ? res(200, []) : realGet(u, i));
    await post(photo(A, "al3"));
    global.fetch = realGet; hide = false;
    check("dedupe race: process → 409 duplicate → no new row, no error message", media("process").length === 1 && db.project_media.filter(m => m.project_id === P.id).length === 3 && !texts().some(t => /נכשל|שגיאה/.test(t)));

    reset();
    await post(msg(A, { video: { file_id: "vid1", file_unique_id: "u-vid1", file_size: 5e6, mime_type: "video/mp4", duration: 12, thumbnail: { file_id: "th1", file_unique_id: "u-th1" } } }));
    const vrow = db.project_media.find(m => m.telegram_file_unique_id === "u-vid1");
    check("video → MP4 upload + the Telegram thumbnail uploaded as the cover → process(role video, cover_path)", vrow && vrow.kind === "video" && /incoming\/.+\.jpg$/.test(vrow.cover_path || "") &&
      media("process")[0].body.role === "video" && calls.some(c => c.kind === "tgfile" && c.file_id === "th1"));
    check("status: 4 files (3 photos, 1 video)", /📥 התקבלו 4 קבצים \(3 תמונות, סרטון אחד\)/.test(tg("editMessageText").slice(-1)[0].body.text));

    reset(); await post(msg(A, { document: { file_id: "doc1", file_unique_id: "u-doc1", mime_type: "image/heic", file_name: "IMG_1.HEIC", file_size: 3e6 } }));
    check("a photo sent as a FILE (HEIC) → the Hebrew 'send as a photo' hint, nothing uploaded", /לא כ"קובץ"/.test(lastText()) && !media().length && !calls.some(c => c.kind === "tgfile"));

    reset(); fileSizes["big1"] = 25e6;
    await post(msg(A, { video: { file_id: "big1", file_unique_id: "u-big1", file_size: 25e6, mime_type: "video/mp4", duration: 60 } }));
    check("a video over 20 MB → 'too big for the bot' (panel hint), no download", /מעל 20MB/.test(texts().join("\n")) && !calls.some(c => c.kind === "tgfile"));

    reset(); quota.media_file = 0;
    await post(photo(A, "q1"));
    check("media_file quota used up → the server's Hebrew message is relayed, no row", /מכסת הקבצים היומית/.test(texts().join("\n")) && !db.project_media.some(m => m.telegram_file_unique_id === "u-q1"));
    quota.media_file = 80;

    reset(); await post(text(A, "ליטוש שיש בסלון"));
    await post(msg(A, { voice: { file_id: "voice1", file_unique_id: "u-voice1", duration: 20, mime_type: "audio/ogg", file_size: 30000 } }));
    let ctx = stateOf(A).context;
    check("text during collection → saved as the description (state), not a quote / receipt", ctx.texts.join() === "ליטוש שיש בסלון" && !calls.some(c => c.kind === "gemini") && !calls.some(c => c.table === "telegram_pending_quotes" && c.method === "POST"));
    check("voice during collection → only its file_id is parked (no download yet)", ctx.voice && ctx.voice.file_id === "voice1" && !calls.some(c => c.kind === "tgfile"));
    check("status shows 📝 התיאור נשמר ✓ (הקלטה)", /📝 התיאור נשמר ✓ \(הקלטה\)/.test(tg("editMessageText").slice(-1)[0].body.text));

    // ================================================================== ✅ סיימתי → AI
    scenario = { city: null, needs_review: true, images: [{ role: "before", pair_no: 1, flags: { faces: true } }, { role: "after", pair_no: 1 }, { role: "before", pair_no: 2 }] };
    // the 3rd photo has no partner → add one more photo so there are 2 full pairs
    await post(photo(A, "al4"));
    scenario.images.push({ role: "after", pair_no: 2, flags: { house_numbers: true } });
    reset();
    await post(tap(A, "p:done:" + P.id, statusMid));
    P = db.projects.find(p => p.id === P.id);
    const an = media("analyze");
    check("✅ סיימתי → the AI runs AUTOMATICALLY, once", an.length === 1 && P.status === "draft");
    check("analyze gets the typed text + the voice note (downloaded into memory, base64) ", an[0].body.text === "ליטוש שיש בסלון" && an[0].body.audio === Buffer.from("BYTES:voice1").toString("base64") && an[0].body.mime_type === "audio/ogg");
    check("after the analysis the description input is gone from the state (no text, no voice file_id)", JSON.stringify(stateOf(A) || {}).indexOf("voice1") === -1 && JSON.stringify(stateOf(A) || {}).indexOf("ליטוש שיש בסלון") === -1);
    const summary = texts().find(t => /📸 טיוטת פרויקט/.test(t)) || "";
    check("summary (quote-draft style): title, service, city, site text, caption, counts", /🏷️ כותרת: ליטוש שיש בסלון/.test(summary) && /🛠️ שירות: שיש ואבן/.test(summary) &&
      /📍 עיר: ❗ חסרה עיר/.test(summary) && /📝 תיאור לאתר:\nרצפת שיש/.test(summary) && /📣 כיתוב לרשתות:\nהשיש בסלון חזר לברק/.test(summary) && /🖼️ 4 תמונות · 2 זוגות לפני\/אחרי · סרטון אחד/.test(summary), summary);
    check("summary shows what the voice note said (once; not stored)", /📝 מה הבנתי מההקלטה: ליטשנו שיש בסלון ברעננה/.test(summary) && !JSON.stringify(db.projects).includes("ליטשנו"));
    check("summary edit buttons: ✏️ כיתוב / כותרת / עיר, 🎤 תיקון, ✂️ קצר יותר", ["✏️ כיתוב", "✏️ כותרת", "✏️ עיר", "🎤 תיקון", "✂️ קצר יותר"].every(t => button(new RegExp("^" + t + "$"))));
    reset(); await post(tap(A, "p:done:" + P.id, statusMid));
    check("a 2nd ✅ tap → no 2nd analysis", !media("analyze").length);

    // ---- question 1: the city
    check("missing city → asked first (one question)", (stateOf(A) || {}).state === "project_edit" && stateOf(A).context.field === "city");
    reset(); await post(text(A, "רחוב הרצל 5"));
    check("a street + number as the city → refused, nothing saved", /רק שם העיר/.test(lastText()) && !db.projects.find(p => p.id === P.id).city);
    reset(); await post(text(A, "רעננה"));
    check("'רעננה' → saved; next: the pairs (needs_review)", db.projects.find(p => p.id === P.id).city === "רעננה" && tg("sendMediaGroup").length === 1);
    // ---- question 2: pairs
    const mg = tg("sendMediaGroup")[0].body.media;
    check("pair 1: sendMediaGroup before + after (public JPEG copies, captions לפני / אחרי)", mg.length === 2 && mg[0].caption === "לפני" && mg[1].caption === "אחרי" && mg.every(x => /\/storage\/v1\/object\/public\/project-media\/.+w1600\.jpg$/.test(x.media)));
    check("pair 1: ✔ נכון / ⇄ החלף / ✏️ תקן", /זוג 1 מתוך 2/.test(lastText()) && button(/✔ נכון/) === "p:pok:" + P.id + ":1" && button(/⇄ החלף/) && button(/✏️ תקן/));
    reset(); await post(tap(A, "p:pok:" + P.id + ":1"));
    check("✔ נכון → pair 2 is shown next", /זוג 2 מתוך 2/.test(lastText()));
    const p2 = db.project_media.filter(m => m.project_id === P.id && m.pair_no === 2);
    const beforeId = p2.find(m => m.role === "before").id;
    reset(); await post(tap(A, "p:psw:" + P.id + ":2"));
    check("⇄ החלף → the pair's before/after are swapped in the DB", db.project_media.find(m => m.id === beforeId).role === "after");
    check("all pairs confirmed → needs_review off (the panel stops asking)", db.projects.find(p => p.id === P.id).ai_meta.needs_review === false);
    // ---- question 3: privacy flags (one at a time)
    const flagged1 = db.project_media.find(m => m.project_id === P.id && m.ai_flags && m.ai_flags.faces);
    check("flagged photo → sendPhoto + 'בדקתי, אפשר לפרסם' / '🗑️ להסיר את התמונה'", tg("sendPhoto").length === 1 && /זוהו בתמונה: פנים/.test(tg("sendPhoto")[0].body.caption) &&
      button(/בדקתי, אפשר לפרסם/) === "p:ack:" + flagged1.id && button(/להסיר את התמונה/) === "p:rm:" + flagged1.id);
    reset(); await post(tap(A, "p:ack:" + flagged1.id));
    check("בדקתי → flags_ack_at set; the next flagged photo is asked", !!db.project_media.find(m => m.id === flagged1.id).flags_ack_at && /מספר בית/.test(tg("sendPhoto")[0].body.caption));
    const flagged2 = db.project_media.find(m => m.project_id === P.id && m.ai_flags && m.ai_flags.house_numbers);
    reset(); await post(tap(A, "p:rm:" + flagged2.id));
    check("🗑️ להסיר → api/media.js delete; then the consent question", media("delete").length === 1 && media("delete")[0].body.media_id === flagged2.id && /הלקוח אישר לפרסם/.test(lastText()));

    // ---- edits (any time)
    reset(); await post(tap(A, "p:cap:" + P.id));
    check("✏️ כיתוב → prompt (with the current caption)", /שלחי את הכיתוב החדש/.test(lastText()) && /השיש בסלון חזר לברק/.test(lastText()));
    reset(); await post(text(A, "עבודה יפה על השיש בסלון"));
    let meta = db.projects.find(p => p.id === P.id).ai_meta;
    check("caption edit → body + the CTA + the hashtags, saved like the panel (caption_he + caption_body_he)", meta.caption_body_he === "עבודה יפה על השיש בסלון" &&
      meta.caption_he === "עבודה יפה על השיש בסלון\n\n📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com\n\n#ליטוש_שיש");
    check("after an edit: a fresh summary + the open question again (consent)", /✏️ עודכן/.test(texts().find(t => /טיוטת פרויקט/.test(t)) || "") && /הלקוח אישר לפרסם/.test(lastText()));
    reset(); await post(tap(A, "p:ttl:" + P.id)); await post(text(A, "א".repeat(71)));
    check("✏️ כותרת > 70 chars → refused", /ארוכה מ-70/.test(lastText()));
    await post(text(A, "שיש מבריק ברעננה"));
    check("✏️ כותרת → saved", db.projects.find(p => p.id === P.id).title_he === "שיש מבריק ברעננה");
    reset(); await post(tap(A, "p:fix:" + P.id)); await post(msg(A, { voice: { file_id: "fixv", file_unique_id: "u-fixv", duration: 8, mime_type: "audio/ogg", file_size: 9000 } }));
    check("🎤 תיקון by voice → correct with the audio (downloaded into memory), no text", media("correct").length === 1 && media("correct")[0].body.audio === Buffer.from("BYTES:fixv").toString("base64") && !media("correct")[0].body.text);
    reset(); correctMode = "not_changed"; await post(tap(A, "p:short:" + P.id));
    check("✂️ קצר יותר → correct('תקצר את הכיתוב'); 'not changed' is said, not hidden", media("correct")[0].body.text === "תקצר את הכיתוב" && texts().some(t => /לא הצלחתי לקצר/.test(t)));
    reset(); correctMode = "short"; await post(tap(A, "p:short:" + P.id));
    check("✂️ קצר יותר → the shorter caption in the new summary", texts().some(t => /📣 כיתוב לרשתות:\nשיש מבריק\./.test(t)));

    // ---- consent yes → destinations → timing → ✅
    reset(); await post(tap(A, "p:cy:" + P.id));
    P = db.projects.find(p => p.id === P.id);
    check("consent כן → consent yes + when + by (telegram)", P.consent === "yes" && !!P.consent_at && P.consent_by === "telegram");
    check("then: destinations as checkboxes (⬜ אתר / פייסבוק / אינסטגרם / סטורי) + המשך", /איפה לפרסם/.test(lastText()) && ["⬜ 🌐 אתר", "⬜ 📘 פייסבוק", "⬜ 📸 אינסטגרם", "⬜ ⭕ סטורי"].every(t => button(new RegExp("^" + t + "$"))));
    reset(); await post(tap(A, "p:dok:" + P.id, 77));
    check("המשך with nothing chosen → 'choose at least one'", texts().some(t => /לפחות יעד אחד/.test(t)));
    reset(); await post(tap(A, "p:d:" + P.id + ":site", 77)); await post(tap(A, "p:d:" + P.id + ":instagram", 77));
    check("a tap toggles a checkbox (the same message is edited)", tg("editMessageText").slice(-1)[0].body.message_id === 77 && button(/^☑️ 🌐 אתר$/) && button(/^☑️ 📸 אינסטגרם$/) && button(/^⬜ 📘 פייסבוק$/));
    check("destinations saved in ai_meta.publish_plan (the panel's structure, panel order)", JSON.stringify(db.projects.find(p => p.id === P.id).ai_meta.publish_plan.destinations) === '["site","instagram"]');
    reset(); await post(tap(A, "p:dok:" + P.id, 77));
    check("המשך → 'מתי לפרסם?' עכשיו / לבחור מועד", /מתי לפרסם/.test(lastText()) && button(/⚡ עכשיו/) && button(/לבחור מועד/));
    // burst-guard slots: an approved post on a Thursday 19:00 → next free = Fri 10, Fri 14, Sat 19, Sun 10
    const t0 = BS.israelParts(Date.now() + 3 * 864e5);
    let thu = BS.israelWallToDate(t0.y, t0.m, t0.d, 19, 0);
    while (new Date(Date.UTC(BS.israelParts(thu).y, BS.israelParts(thu).m - 1, BS.israelParts(thu).d)).getUTCDay() !== 4) thu = new Date(thu.getTime() + 864e5);
    const tp = BS.israelParts(thu); thu = BS.israelWallToDate(tp.y, tp.m, tp.d, 19, 0);
    db.content_queue.push({ id: "cq1", status: "approved", scheduled_for: thu.toISOString(), media_type: "image", content_category: "post" });
    reset(); await post(tap(A, "p:at:" + P.id, 78));
    const slotBtns = tg("editMessageText").slice(-1)[0].body.reply_markup.inline_keyboard.slice(0, 4).map(r => r[0]);
    const hrs = slotBtns.map(b => { const q = BS.israelParts(new Date(+b.callback_data.split(":")[3] * 60000)); return new Date(Date.UTC(q.y, q.m - 1, q.d)).getUTCDay() + "@" + q.h; });
    check("לבחור מועד → the next 4 FREE slots after the queue, Friday/Shabbat rules (Fri 10, Fri 14, Sat 19, Sun 10)", hrs.join() === "5@10,5@14,6@19,0@10", hrs.join());
    check("slot labels in Hebrew ('יום שישי DD.MM · 10:00')", /^יום שישי \d\d\.\d\d · 10:00$/.test(slotBtns[0].text), slotBtns[0].text);
    reset(); await post(tap(A, "p:slot:" + P.id + ":" + Math.round((Date.now() - 864e5) / 60000), 78));
    check("a past / invalid slot → refused, the slots are shown again", texts().some(t => /כבר לא פנוי/.test(t)));
    reset(); await post(tap(A, slotBtns[1].callback_data, 78));
    let plan = db.projects.find(p => p.id === P.id).ai_meta.publish_plan;
    check("slot chosen → publish_plan {destinations, timing 'at', at, saved_at}", plan.timing === "at" && plan.at === new Date(+slotBtns[1].callback_data.split(":")[3] * 60000).toISOString() && !!plan.saved_at);
    check("then the final check: destinations + when + ✅ אשר", /הכול מוכן/.test(lastText()) && /📣 יעדים: 🌐 אתר, 📸 אינסטגרם/.test(lastText()) && /🕐 מתי: יום שישי/.test(lastText()) && button(/^✅ אשר$/) === "p:ok:" + P.id);
    reset(); await post(tap(A, "p:ok:" + P.id, 79));
    P = db.projects.find(p => p.id === P.id);
    check("✅ אשר → status ready + 'נשמר ✔ – הפרסום יופעל בשלב הבא'", P.status === "ready" && texts().includes("נשמר ✔ – הפרסום יופעל בשלב הבא"));
    check("✅ אשר publishes NOTHING (no content_queue row, no publish call)", db.content_queue.length === 1 && !calls.some(c => /publish/.test(c.action || c.qs || "")));
    check("the state is cleared after ✅", !stateOf(A));

    // ================================================================== consent no + ai busy + delete
    const B = 601;
    scenario = { city: "בית שמש", needs_review: false, images: [{ role: "before", pair_no: 1 }, { role: "after", pair_no: 1 }] };
    reset(); await post(text(B, "/project")); let PB = projectsOf(B)[0];
    check("/project = 📸 פרויקט חדש", PB && PB.status === "collecting");
    reset(); await post(tap(B, "p:done:" + PB.id));
    check("✅ with no photos → 'צריך לפחות תמונה אחת', back to collecting, no AI", /לפחות תמונה אחת/.test(texts().join("\n")) && db.projects.find(p => p.id === PB.id).status === "collecting" && !media("analyze").length);
    await post(photo(B, "b1")); await post(photo(B, "b2"));
    aiMode = "busy"; reset(); await post(text(B, "סיימתי"));
    check("'סיימתי' as text = ✅; AI busy → a Hebrew message + 🔄", media("analyze").length === 1 && /עמוסה/.test(texts().join("\n")) && button(/לנסות שוב/) === "p:redo:" + PB.id);
    aiMode = "ok"; reset(); await post(tap(B, "p:redo:" + PB.id));
    check("🔄 → analyzed; city known + no pairs to review + no flags → straight to consent", media("analyze").length === 1 && /הלקוח אישר לפרסם/.test(lastText()) && !tg("sendMediaGroup").length);
    reset(); await post(tap(B, "p:cn:" + PB.id));
    PB = db.projects.find(p => p.id === PB.id);
    check("consent לא → private only: consent no, no destinations, never 'ready'", PB.consent === "no" && PB.consent_by === "telegram" && PB.status === "draft" && PB.ai_meta.publish_plan.destinations.length === 0 && /פרויקט פרטי/.test(lastText()));
    reset(); await post(tap(B, "p:d:" + PB.id + ":site"));
    check("after 'לא', destination buttons are refused", /אישור של הלקוח/.test(texts().join("\n")) && db.projects.find(p => p.id === PB.id).ai_meta.publish_plan.destinations.length === 0);
    reset(); await post(tap(B, "p:del:" + PB.id)); await post(tap(B, "p:delok:" + PB.id, 55));
    check("🗑️ delete → confirm → api/media.js delete-project", media("delete-project").length === 1 && !db.projects.some(p => p.id === PB.id) && /הפרויקט נמחק/.test(texts().join("\n")));

    // ================================================================== ownership
    const C = 602;
    reset(); await post(text(C, "📸 פרויקט חדש")); const PC = projectsOf(C)[0];
    reset(); await post(tap(A, "p:del:" + PC.id)); await post(tap(A, "p:delok:" + PC.id));
    check("another chat's project → refused, nothing deleted", db.projects.some(p => p.id === PC.id) && !media("delete-project").length);
    // open project → continue / new
    reset(); await post(text(C, "💰 סיכום הוצאות החודש")); await post(text(C, "📸 פרויקט חדש"));
    check("📸 with an open project → 'להמשיך או להתחיל חדש?'", /יש פרויקט פתוח/.test(lastText()) && button(/להמשיך/) === "p:cont:" + PC.id);
    reset(); await post(tap(C, "p:cont:" + PC.id));
    check("↩️ להמשיך → collecting again (same project, new status message)", stateOf(C) && stateOf(C).state === "collecting_project" && stateOf(C).context.project_id === PC.id && projectsOf(C).length === 1);

    // ================================================================== photo that is not a receipt
    const R = 603;
    noReceiptExtraction(); reset();
    await post(photo(R, "job1"));
    const pend = db.telegram_pending_receipts.find(p => p.chat_id === R);
    check("single photo, no mode → the receipt scan as today (1 Gemini call, 1 receipt unit)", calls.filter(c => c.kind === "gemini").length === 1 && quota.receipt === 19);
    check("no amount + no vendor → 'זה לא נראה כמו קבלה. להתחיל פרויקט חדש עם התמונה הזו?' כן / לא", lastText() === "זה לא נראה כמו קבלה. להתחיל פרויקט חדש עם התמונה הזו?" &&
      button(/כן, פרויקט חדש/) === "nrproj:" + pend.id && button(/לא, זו קבלה/) === "nrkeep:" + pend.id);
    reset(); await post(tap(R, "nrkeep:" + pend.id, 31));
    check("לא → the normal receipt summary in the same message, no 2nd scan / quota", tg("editMessageText").slice(-1)[0].body.message_id === 31 && /קבלה נותחה/.test(lastText()) && !calls.some(c => c.kind === "gemini") && quota.receipt === 19);
    reset(); await post(photo(R, "job2"));
    const pend2 = db.telegram_pending_receipts.find(p => p.chat_id === R && p.extracted._tg_photo && p.extracted._tg_photo.file_id === "job2");
    reset(); await post(tap(R, "nrproj:" + pend2.id, 32));
    const PR = projectsOf(R)[0];
    check("כן → the pending receipt + its file are deleted", !db.telegram_pending_receipts.some(p => p.id === pend2.id) && calls.some(c => c.kind === "receiptStorage" && c.method === "DELETE"));
    check("כן → a project WITH that photo (process with its file_unique_id), collecting, no 2nd scan", PR && db.project_media.some(m => m.project_id === PR.id && m.telegram_file_unique_id === "u-job2") &&
      stateOf(R).state === "collecting_project" && !calls.some(c => c.kind === "gemini") && quota.receipt === 18);
    // regression: a real receipt
    const R2 = 604;
    receiptExtraction(); reset(); await post(photo(R2, "rec1"));
    const pr2 = db.telegram_pending_receipts.find(p => p.chat_id === R2);
    check("regression: a real receipt → the normal summary, no project question, no _tg_photo", /קבלה נותחה בהצלחה/.test(lastText()) && !/פרויקט/.test(lastText()) && !pr2.extracted._tg_photo);
    reset(); await post(tap(R2, "confirm:" + pr2.id, 33));
    check("regression: ✅ saves to business_expenses (named fields only)", db.business_expenses.length === 1 && db.business_expenses[0].amount === 123.45 && !("_tg_photo" in db.business_expenses[0]));
    // the not-a-receipt row kept as a receipt then confirmed: no amount → refused as before; no _tg_photo leaks anywhere
    check("the 'לא' path kept the scan in telegram_pending_receipts (still editable as a receipt)", db.telegram_pending_receipts.some(p => p.id === pend.id));

    // ================================================================== albums outside a mode
    const G = 605;
    reset();
    for (const f of ["ga1", "ga2", "ga3"]) await post(photo(G, f, { media_group_id: "g-200" }));
    check("album, no mode → parked (3 rows), ONE question '📷 קבלות או 📸 פרויקט חדש?', no scan", db.telegram_parked_media.filter(r => r.media_group_id === "g-200").length === 3 &&
      texts().filter(t => /קבלות או|מה הם/.test(t)).length === 1 && button(/📸 פרויקט חדש/) === "p:albp:g-200" && !calls.some(c => c.kind === "gemini"));
    reset(); await post(tap(G, "p:albp:g-200", 41));
    const PG = projectsOf(G)[0];
    check("📸 → a project with all 3 album files; parked rows deleted; collecting", PG && db.project_media.filter(m => m.project_id === PG.id).length === 3 && !db.telegram_parked_media.some(r => r.media_group_id === "g-200") && stateOf(G).state === "collecting_project");
    reset(); await post(tap(G, "p:albp:g-200", 41));
    check("a 2nd tap on the same album question → 'already handled', no 2nd project", projectsOf(G).length === 1 && /כבר טופלו/.test(lastText()));
    const G2 = 606;
    receiptExtraction(); reset();
    for (const f of ["gr1", "gr2"]) await post(photo(G2, f, { media_group_id: "g-300" }));
    reset(); const rBefore = quota.receipt; await post(tap(G2, "p:albr:g-300", 42));
    check("📷 קבלות → each parked photo is scanned as a receipt (2 scans, 2 units), parked rows deleted", calls.filter(c => c.kind === "gemini").length === 2 && quota.receipt === rBefore - 2 &&
      db.telegram_pending_receipts.filter(p => p.chat_id === G2).length === 2 && !db.telegram_parked_media.some(r => r.media_group_id === "g-300"));
    const G3 = 607;
    reset(); await post(text(G3, "📷 סריקת קבלה"));
    for (const f of ["gm1", "gm2"]) await post(photo(G3, f, { media_group_id: "g-400" }));
    check("after 📷 (receipt mode) an album → straight to receipts, no question", calls.filter(c => c.kind === "gemini").length === 2 && !texts().some(t => /מה הם/.test(t)) && !db.telegram_parked_media.some(r => r.media_group_id === "g-400"));
    const G4 = 608;
    parkedTableMissing = true; reset();
    for (const f of ["gx1", "gx2"]) await post(photo(G4, f, { media_group_id: "g-500" }));
    check("parked table not applied yet → the album is handled as today (receipts), logged", calls.filter(c => c.kind === "gemini").length === 2 && logs.some(l => /telegram_parked_media missing/.test(l)));
    parkedTableMissing = false;

    // ================================================================== sweep
    const old = new Date(Date.now() - 25 * 3600e3).toISOString();
    db.projects.push({ id: uuid(), status: "collecting", source: "panel", created_at: old, ai_meta: null });
    const oldWithFile = { id: uuid(), status: "collecting", source: "telegram", telegram_chat_id: 609, created_at: old, ai_meta: null };
    db.projects.push(oldWithFile); db.project_media.push({ id: uuid(), project_id: oldWithFile.id, kind: "image", sort: 0 });
    reset();
    await BP.sweepStaleProjects();
    check("sweep: an empty collecting project > 24 h old → delete-project (files too); one with files and fresh ones stay",
      media("delete-project").length === 1 && db.projects.some(p => p.id === oldWithFile.id) && db.projects.some(p => p.id === PC.id));

    // ================================================================== hygiene
    check("logs never contain the internal secret, the bypass or the bot token", !logs.some(l => /int-secret-fake|bypass-fake|TESTFAKE/.test(l)));
    check("callback_data always ≤ 64 bytes", tg().every(c => !c.body || !c.body.reply_markup || !c.body.reply_markup.inline_keyboard ||
      c.body.reply_markup.inline_keyboard.every(r => r.every(b => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64))));
    check("only the TEST bot was used (preview)", tg().every(c => c.token === "222:TESTFAKE"));
  } catch (e) {
    console.log("HARNESS ERROR " + (e && e.stack || e));
    fail++;
  }
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  process.exitCode = fail ? 1 : 0;
})();
