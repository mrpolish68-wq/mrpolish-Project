// The Telegram bot's "📸 פרויקט חדש" (media-projects plan, command 5 / Phase 7). Underscore-prefixed:
// a helper of api/telegram-webhook.js, not a Vercel function (still 8 / 12).
//
// Flow: 📸 → a projects row (source 'telegram', telegram_chat_id, status 'collecting') + chat state
// collecting_project → photos / videos (albums = one update per file, deduped by the Telegram
// file_unique_id) are downloaded (≤ 20 MB, the Bot API cap) and handed to api/media.js (create-upload
// → signed upload → process; the internal secret) → ONE status message "📥 התקבלו N קבצים" is edited
// in place → text / voice during collection = the description (voice: only its file_id is parked;
// the audio is downloaded into memory at analysis time, never stored; the transcript is not saved)
// → "✅ סיימתי" runs the AI automatically (api/media.js analyze, one media_ai unit) → a summary in
// the quote-draft style → ONLY what is missing or risky, one question at a time (city, pairs when
// needs_review, each privacy-flagged photo, consent) → destinations + timing (ai_meta.publish_plan,
// the same structure as the panel; burst-guard slots) → ✅ אשר = status 'ready' ("נשמר ✔ – הפרסום
// יופעל בשלב הבא"; the real publishing comes in commands 6–7).
// Also: an album outside a mode → "📷 קבלות או 📸 פרויקט חדש?" (telegram_parked_media); a photo the
// receipt scanner finds no receipt in → "להתחיל פרויקט חדש עם התמונה הזו?"; stale empty projects swept.
//
// callback_data (≤ 64 bytes): "p:<act>:<project or media uuid>[:<arg>]" / "p:albr|albp:<media_group_id>".
"use strict";

const crypto = require("crypto");
const BS = require("../shared/burst-schedule.js");
const { telegramConfig } = require("./_telegram.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const MAX_TG_DOWNLOAD = 20 * 1024 * 1024;        // Bot API getFile limit
const COLLECT_TTL_MS = 12 * 60 * 60 * 1000;      // the collecting state survives a long job day
const EDIT_TTL_MS = 30 * 60 * 1000;              // a ✏️ / 🎤 reply, like the quote edits
const OPEN_PROJECT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_COLLECTING_MS = 24 * 60 * 60 * 1000; // empty collecting projects are swept after this
const MAX_VOICE_SECONDS = 180, MAX_VOICE_BYTES = 3 * 1024 * 1024;
const MAX_TEXTS = 6, MAX_TEXT_CHARS = 1500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const DONE_RE = /^✅?\s*סיימתי[.!]*$/;

const SERVICE_HE = { floor_polish: "ליטוש מרצפות", crystal: "פוליש קריסטל", marble_stone: "שיש ואבן", sealer: "סילר הגנה",
  concrete: "בטון", bomanite: "בומנייט", stairs: "מדרגות", other: "אחר" };
const DESTS = [["site", "🌐 אתר"], ["facebook", "📘 פייסבוק"], ["instagram", "📸 אינסטגרם"], ["ig_story", "⭕ סטורי"]];
const FLAG_HE = { faces: "פנים", plates: "לוחית רישוי", house_numbers: "מספר בית" };
const CTA_HE = "📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com";

const START_TEXT = "📸 פרויקט חדש\n" +
  "שלחי את התמונות והסרטונים (אפשר כמה ביחד), ובהקלטה או בטקסט ספרי בקצרה מה עשינו ובאיזו עיר. כשמסיימים – ✅ סיימתי";
const DOC_HINT = "📎 זה הגיע כקובץ. כדי לשמור על הפרטיות (בלי מיקום ופרטי מצלמה), שלחי את התמונה או הסרטון כרגיל מהגלריה – לא כ\"קובץ\".";
const AI_ERROR_HE = {
  ai_busy: "הבינה המלאכותית עמוסה כרגע 🙏 נסי שוב בעוד כמה דקות.",
  quota: "הגענו למכסת הניתוחים להיום. אפשר להמשיך מחר, או לערוך בפאנל.",
  quota_unavailable: "המערכת עמוסה כרגע. נסי שוב בעוד רגע.",
  no_images: "עדיין אין תמונות בפרויקט."
};
const EDIT_PROMPT = {
  city: "📍 באיזו עיר היה הפרויקט? (רק שם העיר, בלי רחוב ומספר)",
  title: "✏️ מה הכותרת? (עד 70 תווים)",
  caption: "✏️ שלחי את הכיתוב החדש. הטלפון וההאשטגים יתווספו אוטומטית.",
  fix: "🎤 הקליטי או כתבי מה לתקן, למשל: \"העיר היא רעננה\" או \"התמונה השנייה היא לפני\"."
};

let D = null;   // the webhook's helpers (init)
// waits (ms): the album re-count, files still arriving at ✅, late album items. Tests shorten them.
const TIMING = { recountMs: 1500, pollMs: 2000, albumWaitMs: 1200 };
function init(deps) { D = deps; }

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function enc(s) { return encodeURIComponent(s); }
function plural(n, one, many) { return n === 1 ? one : n + " " + many; }
function publicUrl(path) { return SUPABASE_URL + "/storage/v1/object/public/project-media/" + String(path).split("/").map(enc).join("/"); }
function needsReview(m) { var f = m.ai_flags || {}; return !m.flags_ack_at && (f.faces === true || f.plates === true || f.house_numbers === true); }

async function restGet(pathQs) {
  var res = await D.fetchT(SUPABASE_URL + "/rest/v1/" + pathQs, { headers: D.supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase GET " + pathQs.split("?")[0] + " failed: " + res.status);
  return res.json();
}
async function loadProject(id) { return UUID_RE.test(id || "") ? D.supabaseSelectOne("projects", "id=eq." + enc(id)) : null; }
async function loadMedia(projectId) {
  return restGet("project_media?project_id=eq." + enc(projectId) +
    "&select=id,kind,role,pair_no,sort,variants,ai_flags,flags_ack_at,telegram_file_unique_id,created_at&order=sort.asc,created_at.asc");
}
function ownedBy(p, chatId) { return !!p && p.telegram_chat_id != null && String(p.telegram_chat_id) === String(chatId); }
// ai_meta read-modify-write; ai_meta.bot keeps the bot's review progress (the panel ignores it).
async function patchMeta(p, fn, extra) {
  var meta = Object.assign({}, p.ai_meta || {});
  var bot = Object.assign({}, meta.bot || {});
  fn(meta, bot);
  meta.bot = bot;
  await D.supabasePatch("projects", "id=eq." + enc(p.id), Object.assign({ ai_meta: meta }, extra || {}));
  p.ai_meta = meta;
  if (extra) Object.assign(p, extra);
  return p;
}

// api/media.js, server to server (the same host + internal secret + preview bypass as the quote PDF).
function mediaApi(action, body, ms) { return internalApi("/api/media?action=" + action, body, ms); }
async function internalApi(pathQs, body, ms) {
  var env = process.env;
  var host = env.VERCEL_ENV === "production" ? (env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL) : env.VERCEL_URL;
  if (!host || !env.INTERNAL_API_SECRET) return { status: 0, body: { code: "server_config" } };
  var headers = { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_API_SECRET };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    var res = await D.fetchT("https://" + host + pathQs, { method: "POST", headers: headers, body: JSON.stringify(body), redirect: "manual" }, ms || 30000);
    var j = await res.json().catch(function () { return {}; });
    return { status: res.status, body: j || {} };
  } catch (err) {
    console.error("[bot-projects] " + pathQs.split("?")[0] + " request failed");
    return { status: 0, body: { code: "network" } };
  }
}

async function tgEdit(chatId, messageId, text, keyboard) {
  try {
    await D.tgCall("editMessageText", { chat_id: chatId, message_id: messageId, text: text, reply_markup: keyboard || { inline_keyboard: [] } });
    return true;
  } catch (err) {
    return /not modified/i.test(err.message);   // same text = fine; anything else = the message is gone
  }
}
function send(chatId, text, keyboard) {
  return D.tgCallSafe("sendMessage", Object.assign({ chat_id: chatId, text: text }, keyboard ? { reply_markup: keyboard } : {}));
}
function dropButtons(chatId, messageId) {
  if (messageId) return D.tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

// ---------------------------------------------------------------------------
// chat state (telegram_chat_state: one row per chat)
// ---------------------------------------------------------------------------
async function readState(chatId) {
  try { return await D.supabaseSelectOne("telegram_chat_state", "chat_id=eq." + chatId); } catch (err) {
    console.error("[bot-projects] state lookup failed: " + err.message);
    return null;
  }
}
function fresh(row, ttl) { return !!row && Date.now() - new Date(row.state_since).getTime() <= ttl; }
// The routing hook: which project state (if any) owns this chat right now.
async function activeState(chatId) {
  var row = await readState(chatId);
  if (!row) return null;
  if (row.state === "collecting_project" && fresh(row, COLLECT_TTL_MS)) return row;
  if (row.state === "project_edit" && fresh(row, EDIT_TTL_MS)) return row;
  if (row.state === "awaiting_receipt" && fresh(row, EDIT_TTL_MS)) return row;
  return null;
}

// ---------------------------------------------------------------------------
// files: Telegram → api/media.js
// ---------------------------------------------------------------------------
function refFromMessage(msg) {
  if (msg.photo && msg.photo.length) {
    var best = msg.photo[msg.photo.length - 1];
    return { kind: "photo", file_id: best.file_id, file_unique_id: best.file_unique_id, file_size: best.file_size || 0, mime: "image/jpeg" };
  }
  if (msg.video) {
    var th = msg.video.thumbnail || msg.video.thumb || null;
    return { kind: "video", file_id: msg.video.file_id, file_unique_id: msg.video.file_unique_id, file_size: msg.video.file_size || 0,
      mime: msg.video.mime_type || "video/mp4", thumb_file_id: th && th.file_id };
  }
  if (msg.document) return { kind: "document", file_id: msg.document.file_id, file_unique_id: msg.document.file_unique_id, file_size: msg.document.file_size || 0, mime: msg.document.mime_type || "" };
  return null;
}

async function download(fileId) {
  var info = await D.tgCall("getFile", { file_id: fileId });
  if (info.file_size && info.file_size > MAX_TG_DOWNLOAD) { var e = new Error("too big"); e.tooBig = true; throw e; }
  return D.tgDownloadFile(info.file_path);
}

async function uploadOriginal(projectId, buffer, contentType) {
  var slot = await mediaApi("create-upload", { project_id: projectId, content_type: contentType, bytes: buffer.length }, 20000);
  if (slot.status !== 200) return { error: slot.body.he || "לא הצלחתי לשמור את הקובץ. נסי שוב." };
  var put = await D.fetchT(slot.body.signed_url, { method: "PUT", headers: { "Content-Type": contentType, "x-upsert": "false" }, body: buffer }, 60000)
    .catch(function () { return { ok: false }; });
  if (!put.ok) return { error: "לא הצלחתי להעלות את הקובץ. נסי שוב." };
  return { path: slot.body.path };
}

// -> { ok } | { dup } | { error: Hebrew }
async function addFile(projectId, ref, sort) {
  if (ref.kind === "document") return { error: DOC_HINT };
  if (!ref.file_unique_id || !/^[A-Za-z0-9_-]{1,100}$/.test(ref.file_unique_id)) return { error: "הקובץ לא תקין." };
  var have = await restGet("project_media?project_id=eq." + enc(projectId) + "&telegram_file_unique_id=eq." + enc(ref.file_unique_id) + "&select=id").catch(function () { return []; });
  if (have.length) return { dup: true };
  if (ref.file_size > MAX_TG_DOWNLOAD) return { error: "הקובץ גדול מדי לבוט (מעל 20MB). אפשר להעלות אותו בפאנל (📸 פרויקטים)." };
  if (ref.kind === "video" && !/^video\/(mp4|quicktime)$/.test(ref.mime)) return { error: "סוג הסרטון לא נתמך. אפשר MP4 או MOV." };
  var buf;
  try { buf = await download(ref.file_id); } catch (err) {
    return { error: err.tooBig ? "הקובץ גדול מדי לבוט (מעל 20MB). אפשר להעלות אותו בפאנל (📸 פרויקטים)." : "לא הצלחתי להוריד את הקובץ מטלגרם. נסי לשלוח שוב." };
  }
  var up = await uploadOriginal(projectId, buf, ref.kind === "video" ? ref.mime : "image/jpeg");
  if (up.error) return up;
  var body = { project_id: projectId, path: up.path, sort: Math.max(0, Math.min(10000, sort | 0)), telegram_file_unique_id: ref.file_unique_id };
  if (ref.kind === "video") {
    body.role = "video";
    if (ref.thumb_file_id) {   // the Telegram thumbnail becomes the cover
      var thumb = await download(ref.thumb_file_id).catch(function () { return null; });
      var cov = thumb ? await uploadOriginal(projectId, thumb, "image/jpeg") : null;
      if (cov && cov.path) body.cover_path = cov.path;
    }
  }
  var pr = await mediaApi("process", body, 110000);
  if (pr.status === 200) return { ok: true };
  if (pr.status === 409) return { dup: true };
  return { error: pr.body.he || "עיבוד הקובץ נכשל. נסי לשלוח שוב." };
}

// ---------------------------------------------------------------------------
// collecting
// ---------------------------------------------------------------------------
function statusView(projectId, media, ctx) {
  var photos = media.filter(function (m) { return m.kind === "image"; }).length, videos = media.length - photos;
  var lines = ["📸 פרויקט חדש", "📥 התקבלו " + media.length + " קבצים" + (media.length ? " (" + plural(photos, "תמונה אחת", "תמונות") + (videos ? ", " + plural(videos, "סרטון אחד", "סרטונים") : "") + ")" : "")];
  lines.push((ctx.texts && ctx.texts.length) || ctx.voice ? "📝 התיאור נשמר ✓" + (ctx.voice ? " (הקלטה)" : "") : "📝 עדיין אין תיאור – אפשר להקליט או לכתוב");
  lines.push("", "כשמסיימים – ✅ סיימתי");
  return { text: lines.join("\n"), keyboard: { inline_keyboard: [[{ text: "✅ סיימתי", callback_data: "p:done:" + projectId }], [{ text: "❌ ביטול הפרויקט", callback_data: "p:del:" + projectId }]] } };
}

// Edits the one status message; if it's gone, sends a new one and remembers it.
async function refreshStatus(chatId, projectId) {
  var st = await readState(chatId);
  if (!st || st.state !== "collecting_project" || !st.context || st.context.project_id !== projectId) return;
  var media = await loadMedia(projectId).catch(function () { return null; });
  if (!media) return;
  var view = statusView(projectId, media, st.context);
  if (st.context.status_mid && await tgEdit(chatId, st.context.status_mid, view.text, view.keyboard)) return;
  var sent = await send(chatId, view.text, view.keyboard);
  if (sent && sent.message_id) {
    st.context.status_mid = sent.message_id;
    await D.setChatState(chatId, "collecting_project", st.context).catch(function () {});
  }
}

// A new project (+ optional first files) and the collecting state.
async function createProject(chatId) {
  return D.supabaseInsert("projects", { status: "collecting", source: "telegram", telegram_chat_id: chatId });
}
async function beginCollecting(chatId, project, intro) {
  var base = await send(chatId, intro || START_TEXT);
  var ctx = { project_id: project.id, base_mid: (base && base.message_id) || 0, status_mid: null, texts: [], voice: null };
  var media = await loadMedia(project.id).catch(function () { return []; });
  var view = statusView(project.id, media, ctx);
  var st = await send(chatId, view.text, view.keyboard);
  ctx.status_mid = st && st.message_id || null;
  await D.setChatState(chatId, "collecting_project", ctx);
  return ctx;
}

async function findOpenProject(chatId) {
  var cutoff = new Date(Date.now() - OPEN_PROJECT_TTL_MS).toISOString();
  var rows = await restGet("projects?source=eq.telegram&telegram_chat_id=eq." + chatId + "&status=in.(collecting,draft)&created_at=gt." + enc(cutoff) +
    "&order=created_at.desc&limit=1&select=id,status,title_he,ai_meta,created_at");
  return rows[0] || null;
}

// 📸 / /project
async function startProject(chatId) {
  var open = null;
  try { open = await findOpenProject(chatId); } catch (err) { console.error("[bot-projects] open project lookup failed: " + err.message); }
  if (open) {
    await send(chatId, "יש פרויקט פתוח" + (open.title_he ? " (" + open.title_he + ")" : "") + ". להמשיך בו או להתחיל חדש?",
      { inline_keyboard: [[{ text: "↩️ להמשיך בפרויקט", callback_data: "p:cont:" + open.id }, { text: "🆕 פרויקט חדש", callback_data: "p:new:" + open.id }]] });
    return;
  }
  var p;
  try { p = await createProject(chatId); } catch (err) {
    console.error("[bot-projects] project insert failed: " + err.message);
    await send(chatId, "שגיאה זמנית. נסי שוב בעוד רגע.");
    return;
  }
  await beginCollecting(chatId, p);
}

// A project that starts WITH files (an album, or a photo that wasn't a receipt).
async function startProjectWithFiles(chatId, refs) {
  var p;
  try { p = await createProject(chatId); } catch (err) {
    console.error("[bot-projects] project insert failed: " + err.message);
    await send(chatId, "שגיאה זמנית. נסי שוב בעוד רגע.");
    return;
  }
  var errors = [];
  for (var i = 0; i < refs.length; i++) {
    var r = await addFile(p.id, refs[i], i);
    if (r.error && errors.indexOf(r.error) === -1) errors.push(r.error);
  }
  if (errors.length) await send(chatId, errors.join("\n"));
  await beginCollecting(chatId, p, "📸 פרויקט חדש נפתח עם " + plural(refs.length, "הקובץ ששלחת", "הקבצים ששלחת") + ".\n" +
    "אפשר לשלוח עוד תמונות וסרטונים, ובהקלטה או בטקסט ספרי בקצרה מה עשינו ובאיזו עיר. כשמסיימים – ✅ סיימתי");
}

// Any message while collecting. Returns true when handled.
async function handleCollect(msg, chatId, stateRow) {
  var ctx = stateRow.context || {};
  var p = await loadProject(ctx.project_id).catch(function () { return null; });
  if (!p || p.status !== "collecting") { await D.clearChatState(chatId); return false; }
  var text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (text && DONE_RE.test(text)) { await finish(chatId, p.id, null); return true; }
  var voice = msg.voice || msg.audio;
  if (voice) {
    if ((voice.duration || 0) > MAX_VOICE_SECONDS) { await send(chatId, "ההקלטה ארוכה מ-3 דקות. נסי הקלטה קצרה יותר 🙂"); return true; }
    if ((voice.file_size || 0) > MAX_VOICE_BYTES) { await send(chatId, "ההקלטה גדולה מדי. נסי הקלטה קצרה יותר."); return true; }
    var hadVoice = !!ctx.voice;
    ctx.voice = { file_id: voice.file_id, mime: voice.mime_type || "audio/ogg" };   // the file_id only; the audio is never stored
    await D.setChatState(chatId, "collecting_project", ctx);
    if (hadVoice) await send(chatId, "🎤 ההקלטה החדשה תחליף את הקודמת.");
    await refreshStatus(chatId, p.id);
    return true;
  }
  if (text) {
    ctx.texts = (ctx.texts || []).concat(text.slice(0, MAX_TEXT_CHARS)).slice(-MAX_TEXTS);
    while (ctx.texts.join("\n").length > MAX_TEXT_CHARS && ctx.texts.length > 1) ctx.texts.shift();
    await D.setChatState(chatId, "collecting_project", ctx);
    await refreshStatus(chatId, p.id);
    return true;
  }
  var ref = refFromMessage(msg);
  if (!ref) { await send(chatId, "אפשר לשלוח תמונות, סרטונים, הקלטה או טקסט. כשמסיימים – ✅ סיימתי"); return true; }
  if (ref.kind === "document") { await send(chatId, DOC_HINT); return true; }
  var r = await addFile(p.id, ref, (msg.message_id || 0) - (ctx.base_mid || 0));
  if (r.error) await send(chatId, r.error);
  await refreshStatus(chatId, p.id);
  // albums: the files finish in parallel on different instances → one late re-count fixes the number
  await sleep(TIMING.recountMs);
  await refreshStatus(chatId, p.id);
  return true;
}

// ---------------------------------------------------------------------------
// ✅ סיימתי → AI → summary → questions
// ---------------------------------------------------------------------------
async function waitForFiles(projectId) {
  var last = -1;
  for (var i = 0; i < 8; i++) {
    var n = (await loadMedia(projectId).catch(function () { return []; })).length;
    if (n === last && n > 0) return n;
    last = n;
    await sleep(TIMING.pollMs);
  }
  return Math.max(last, 0);
}

async function finish(chatId, projectId, tappedMid) {
  var p = await loadProject(projectId);
  if (!ownedBy(p, chatId)) { await send(chatId, "הפרויקט הזה כבר לא קיים."); return; }
  if (p.status !== "collecting") {   // already finished: just show where it stands
    if (p.ai_meta && p.ai_meta.analyzed_at) { await showSummary(chatId, p, null, true); await nextStep(chatId, p.id); }
    return;
  }
  var st = await readState(chatId);
  var ctx = st && st.context && st.context.project_id === projectId ? st.context : { texts: [], voice: null };
  // claim: only one ✅ runs the analysis
  var res = await D.fetchT(SUPABASE_URL + "/rest/v1/projects?id=eq." + enc(projectId) + "&status=eq.collecting", {
    method: "PATCH", headers: Object.assign({ Prefer: "return=representation" }, D.supabaseHeaders()), body: JSON.stringify({ status: "draft" })
  }).catch(function () { return { ok: false }; });
  var claimed = res.ok ? await res.json().catch(function () { return []; }) : [];
  if (!claimed.length) return;
  var statusMid = ctx.status_mid || tappedMid;
  if (statusMid) await tgEdit(chatId, statusMid, "⏳ מסיים לקבל את הקבצים…");
  await waitForFiles(projectId);
  var media = await loadMedia(projectId);
  if (!media.some(function (m) { return m.kind === "image"; })) {
    await D.supabasePatch("projects", "id=eq." + enc(projectId), { status: "collecting" }).catch(function () {});
    if (statusMid) await tgEdit(chatId, statusMid, statusView(projectId, media, ctx).text, statusView(projectId, media, ctx).keyboard);
    await send(chatId, "📷 צריך לפחות תמונה אחת. שלחי תמונות ואז ✅ סיימתי.");
    return;
  }
  // the description input waits in the state until the analysis succeeds (then it's gone)
  await D.setChatState(chatId, "project_review", { project_id: projectId, input: { texts: ctx.texts || [], voice: ctx.voice || null }, status_mid: statusMid || null });
  await runAnalysis(chatId, projectId);
}

async function runAnalysis(chatId, projectId) {
  var st = await readState(chatId);
  var input = st && st.context && st.context.project_id === projectId && st.context.input || { texts: [], voice: null };
  var statusMid = st && st.context && st.context.status_mid;
  var wait = statusMid && await tgEdit(chatId, statusMid, "⏳ מנתח את התמונות… (עד דקה)") ? { message_id: statusMid } : await send(chatId, "⏳ מנתח את התמונות… (עד דקה)");
  var body = { project_id: projectId, text: (input.texts || []).join("\n").slice(0, MAX_TEXT_CHARS) };
  if (input.voice && input.voice.file_id) {
    try {
      var audio = await download(input.voice.file_id);   // into memory only
      if (audio.length <= MAX_VOICE_BYTES) { body.audio = audio.toString("base64"); body.mime_type = input.voice.mime || "audio/ogg"; }
    } catch (err) { console.error("[bot-projects] voice download failed"); }
  }
  var r = await mediaApi("analyze", body, 150000);
  body = null;
  if (r.status !== 200) {
    var he = AI_ERROR_HE[r.body.code] || r.body.he || "הניתוח נכשל. אפשר לנסות שוב.";
    var kb = { inline_keyboard: [[{ text: "🔄 לנסות שוב", callback_data: "p:redo:" + projectId }]] };
    if (wait && wait.message_id) await tgEdit(chatId, wait.message_id, "⚠️ " + he, kb); else await send(chatId, "⚠️ " + he, kb);
    return;
  }
  await D.setChatState(chatId, "project_review", { project_id: projectId });   // the text / voice reference is dropped here
  if (wait && wait.message_id) await tgEdit(chatId, wait.message_id, "✅ הניתוח הושלם");
  var p = await loadProject(projectId);
  var transcript = r.body.analysis && r.body.analysis.transcript;
  await showSummary(chatId, p, transcript ? "📝 מה הבנתי מההקלטה: " + (transcript.length > 300 ? transcript.slice(0, 300) + "…" : transcript) : null, true);
  await nextStep(chatId, projectId);
}

function pairsOf(media) {
  var by = {};
  media.forEach(function (m) {
    if (m.kind !== "image" || m.pair_no == null || (m.role !== "before" && m.role !== "after")) return;
    (by[m.pair_no] = by[m.pair_no] || {})[m.role] = m;
  });
  return Object.keys(by).map(Number).sort(function (a, b) { return a - b; })
    .filter(function (n) { return by[n].before && by[n].after; }).map(function (n) { return { n: n, before: by[n].before, after: by[n].after }; });
}

var WARN_HE = {
  caption_not_changed: "⚠️ לא הצלחתי לקצר/לשנות את הכיתוב – הכיתוב הקודם נשאר. אפשר ✏️ לערוך ידנית.",
  caption_retried: "✂️ הכיתוב קוצר.",
  "city:not_stated_or_invalid": "⚠️ העיר לא נשמרה: רק עיר שנאמרה במפורש, בלי רחוב ומספר.",
  opening_repeated: "💡 פתיחת הכיתוב דומה לפוסט קודם – אפשר 🎤 לבקש ניסוח אחר."
};

function summaryView(p, media, footer) {
  var meta = p.ai_meta || {};
  var photos = media.filter(function (m) { return m.kind === "image"; }).length, videos = media.length - photos, pairs = pairsOf(media).length;
  var lines = [
    "📸 טיוטת פרויקט",
    "",
    "🏷️ כותרת: " + (p.title_he || "—"),
    "🛠️ שירות: " + (SERVICE_HE[p.service] || "—"),
    "📍 עיר: " + (p.city || "❗ חסרה עיר"),
    "🖼️ " + plural(photos, "תמונה אחת", "תמונות") + " · " + (pairs ? plural(pairs, "זוג אחד לפני/אחרי", "זוגות לפני/אחרי") : "בלי זוגות לפני/אחרי") +
      (videos ? " · " + plural(videos, "סרטון אחד", "סרטונים") : ""),
    "",
    "📝 תיאור לאתר:",
    p.summary_he || "—",
    "",
    "📣 כיתוב לרשתות:",
    meta.caption_he || "—"
  ];
  (meta.warnings || []).forEach(function (w) { if (WARN_HE[w]) lines.push("", WARN_HE[w]); });
  if (footer) lines.push("", footer);
  var text = lines.join("\n");
  if (text.length > 4000) text = text.slice(0, 3999) + "…";
  var id = p.id;
  return { text: text, keyboard: { inline_keyboard: [
    [{ text: "✏️ כיתוב", callback_data: "p:cap:" + id }, { text: "✏️ כותרת", callback_data: "p:ttl:" + id }, { text: "✏️ עיר", callback_data: "p:city:" + id }],
    [{ text: "🎤 תיקון", callback_data: "p:fix:" + id }, { text: "✂️ קצר יותר", callback_data: "p:short:" + id }],
    [{ text: "🗑️ מחיקת הפרויקט", callback_data: "p:del:" + id }]
  ] } };
}

// The summary as a new message at the bottom (the old one loses its buttons), id kept in ai_meta.bot.
async function showSummary(chatId, p, footer, asNew) {
  var media = await loadMedia(p.id).catch(function () { return []; });
  var view = summaryView(p, media, footer);
  var old = p.ai_meta && p.ai_meta.bot && p.ai_meta.bot.summary_mid;
  if (!asNew && old && await tgEdit(chatId, old, view.text, view.keyboard)) return;
  var sent = await send(chatId, view.text, view.keyboard);
  if (old) await dropButtons(chatId, old);
  if (sent && sent.message_id) await patchMeta(p, function (meta, bot) { bot.summary_mid = sent.message_id; }).catch(function () {});
}

// Ask ONLY what's missing or risky, one question at a time; then destinations → timing → ✅.
async function nextStep(chatId, projectId) {
  var p = await loadProject(projectId);
  if (!ownedBy(p, chatId)) return;
  var media = await loadMedia(projectId);
  var meta = p.ai_meta || {}, bot = meta.bot || {};
  if (!p.city) {
    await D.setChatState(chatId, "project_edit", { project_id: projectId, field: "city" });
    await send(chatId, EDIT_PROMPT.city);
    return;
  }
  if (meta.needs_review) {
    var pairs = pairsOf(media), ok = bot.pairs_ok || [];
    var pending = pairs.filter(function (x) { return ok.indexOf(x.n) === -1; });
    if (pending.length) { await askPair(chatId, p, pending[0], pairs.length); return; }
    await patchMeta(p, function (m, b) { m.needs_review = false; b.pairs_ok = []; });
  }
  var flagged = media.filter(needsReview);
  if (flagged.length) { await askFlag(chatId, flagged[0]); return; }
  if (p.consent !== "yes" && p.consent !== "no") {
    await send(chatId, "🤝 הלקוח אישר לפרסם את התמונות?", { inline_keyboard: [[
      { text: "✅ כן", callback_data: "p:cy:" + projectId }, { text: "🔒 לא – רק שמירה פנימית", callback_data: "p:cn:" + projectId }]] });
    return;
  }
  if (p.consent === "no") return;   // private only: nothing to publish
  if (!bot.dests_done) { await askDests(chatId, p, null); return; }
  if (!bot.timing_done) { await askTiming(chatId, p); return; }
  await askConfirm(chatId, p);
}

async function askPair(chatId, p, pair, total) {
  var url = function (m) { var v = m.variants || {}; return publicUrl((v.jpg || v.w1600 || v.w960 || v.w480).path); };
  await D.tgCallSafe("sendMediaGroup", { chat_id: chatId, media: [
    { type: "photo", media: url(pair.before), caption: "לפני" }, { type: "photo", media: url(pair.after), caption: "אחרי" }] });
  await send(chatId, "🔎 זוג " + pair.n + (total > 1 ? " מתוך " + total : "") + ": הלפני והאחרי נכונים?", { inline_keyboard: [[
    { text: "✔ נכון", callback_data: "p:pok:" + p.id + ":" + pair.n },
    { text: "⇄ החלף", callback_data: "p:psw:" + p.id + ":" + pair.n },
    { text: "✏️ תקן", callback_data: "p:pfx:" + p.id + ":" + pair.n }]] });
}

async function askFlag(chatId, m) {
  var f = m.ai_flags || {};
  var names = Object.keys(FLAG_HE).filter(function (k) { return f[k] === true; }).map(function (k) { return FLAG_HE[k]; });
  var v = m.variants || {}, src = v.jpg || v.w1600 || v.w960 || v.w480;
  var caption = "⚠️ זוהו בתמונה: " + names.join(", ") + ".\nאי אפשר לפרסם אותה עד שבודקים.";
  var kb = { inline_keyboard: [[{ text: "בדקתי, אפשר לפרסם", callback_data: "p:ack:" + m.id }], [{ text: "🗑️ להסיר את התמונה", callback_data: "p:rm:" + m.id }]] };
  if (src) {
    var sent = await D.tgCallSafe("sendPhoto", { chat_id: chatId, photo: publicUrl(src.path), caption: caption, reply_markup: kb });
    if (sent) return;
  }
  await send(chatId, caption, kb);
}

function destKeyboard(p) {
  var plan = (p.ai_meta && p.ai_meta.publish_plan) || {}, on = plan.destinations || [];
  var btn = function (d) { return { text: (on.indexOf(d[0]) !== -1 ? "☑️ " : "⬜ ") + d[1], callback_data: "p:d:" + p.id + ":" + d[0] }; };
  return { inline_keyboard: [[btn(DESTS[0]), btn(DESTS[1])], [btn(DESTS[2]), btn(DESTS[3])], [{ text: "המשך ➡️", callback_data: "p:dok:" + p.id }]] };
}
async function askDests(chatId, p, editMid) {
  var text = "📣 איפה לפרסם? (אפשר לבחור כמה)";
  if (editMid && await tgEdit(chatId, editMid, text, destKeyboard(p))) return;
  await send(chatId, text, destKeyboard(p));
}

async function askTiming(chatId, p) {
  await send(chatId, "🕐 מתי לפרסם?", { inline_keyboard: [[
    { text: "⚡ עכשיו", callback_data: "p:now:" + p.id }, { text: "🗓️ לבחור מועד", callback_data: "p:at:" + p.id }]] });
}

// The next free burst-guard slots (Sun–Thu 10/14/19, Fri 10/14, Sat 19, after every approved/scheduled post).
async function freeSlots(n) {
  var existing = await restGet("content_queue?status=in.(approved,scheduled)&select=id,scheduled_for,media_type,content_category&order=scheduled_for.asc").catch(function () { return []; });
  var rows = []; for (var i = 0; i < n; i++) rows.push({ id: "_" + i, scheduled_for: new Date(0).toISOString() });
  return BS.planSpread(rows, { existing: existing });
}
function slotLabel(s) { return "יום " + s.dayLabel + " " + s.dateLabel + " · " + s.timeLabel; }
function validSlot(at) {
  if (!(at instanceof Date) || isNaN(at) || at.getTime() < Date.now() + BS.MIN_LEAD_MS - 60000) return false;
  var q = BS.israelParts(at), dow = new Date(Date.UTC(q.y, q.m - 1, q.d)).getUTCDay();
  return q.min === 0 && (BS.SLOTS_BY_DOW[dow] || []).indexOf(q.h) !== -1;
}

function planLine(p) {
  var plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
  var dests = (plan.destinations || []).map(function (d) { var x = DESTS.find(function (y) { return y[0] === d; }); return x ? x[1] : d; }).join(", ");
  var when = plan.timing === "at" && plan.at ? (function () {
    var q = BS.israelParts(plan.at), dow = new Date(Date.UTC(q.y, q.m - 1, q.d)).getUTCDay();
    return "יום " + BS.DOW_HE[dow] + " " + q.d + "." + q.m + " · " + String(q.h).padStart(2, "0") + ":" + String(q.min).padStart(2, "0");
  })() : "בהקדם";
  return "📣 יעדים: " + (dests || "—") + "\n🕐 מתי: " + when;
}
async function askConfirm(chatId, p) {
  await send(chatId, "✅ הכול מוכן\n" + planLine(p) + "\n\nלאשר?", { inline_keyboard: [[
    { text: "✅ אשר", callback_data: "p:ok:" + p.id }, { text: "✏️ לשנות יעדים/מועד", callback_data: "p:rd:" + p.id }]] });
}

// ---------------------------------------------------------------------------
// ✏️ / 🎤 replies
// ---------------------------------------------------------------------------
const CITY_BAD_RE = /\d|רחוב|רח['׳]|שד['׳]|שדרות|סמטת|כיכר|דירה|קומה|\bstreet\b|\bst\./i;
// Taken as typed (she is asked for "רק שם העיר"): no prefix stripping — "בנימינה" / "בית שמש" are cities.
function cityFrom(t) {
  var c = String(t || "").replace(/[.!?,]+$/, "").replace(/\s+/g, " ").trim();
  if (!c || c.length > 40 || CITY_BAD_RE.test(c) || c.split(" ").length > 3 || !/^[\p{L}\s'׳"״-]+$/u.test(c)) return null;
  return c;
}

async function handleEdit(msg, chatId, stateRow) {
  var ctx = stateRow.context || {};
  var p = await loadProject(ctx.project_id).catch(function () { return null; });
  if (!ownedBy(p, chatId)) { await D.clearChatState(chatId); return false; }
  var text = typeof msg.text === "string" ? msg.text.trim() : "";
  var voice = msg.voice || msg.audio;
  var field = ctx.field;
  if (field === "fix") {
    if (!text && !voice) return false;
    await D.clearChatState(chatId);
    await correct(chatId, p, voice ? { voice: voice } : { text: text }, ctx.pairs ? { resetPairs: true } : null);
    return true;
  }
  if (!text) { await send(chatId, EDIT_PROMPT[field] || "שלחי טקסט 🙂"); return true; }
  if (field === "city") {
    var city = cityFrom(text);
    if (!city) { await send(chatId, "רק שם העיר בבקשה – בלי רחוב, מספר בית או מספרים. למשל: רעננה"); return true; }
    await D.supabasePatch("projects", "id=eq." + enc(p.id), { city: city });
    p.city = city;
  } else if (field === "title") {
    if (text.length > 70) { await send(chatId, "הכותרת ארוכה מ-70 תווים. נסי קצר יותר."); return true; }
    await D.supabasePatch("projects", "id=eq." + enc(p.id), { title_he: text });
    p.title_he = text;
  } else if (field === "caption") {
    var body = text.replace(/📞[\s\S]*$/, "").replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, "").trim().slice(0, 1200);
    if (!body) { await send(chatId, EDIT_PROMPT.caption); return true; }
    var tags = (p.ai_meta && p.ai_meta.hashtags) || [];
    await patchMeta(p, function (meta) {
      meta.caption_body_he = body;
      meta.caption_he = [body, CTA_HE, tags.join(" ")].filter(Boolean).join("\n\n");
      meta.warnings = [];
    });
  } else { await D.clearChatState(chatId); return false; }
  await D.clearChatState(chatId);
  await showSummary(chatId, p, "✏️ עודכן", true);
  await nextStep(chatId, p.id);
  return true;
}

// 🎤 / text correction and ✂️ (api/media.js correct: one media_ai unit, the shorter retry may use a 2nd).
async function correct(chatId, p, input, opts) {
  var wait = await send(chatId, "⏳ מעדכן…");
  var body = { project_id: p.id };
  if (input.voice) {
    if ((input.voice.duration || 0) > MAX_VOICE_SECONDS || (input.voice.file_size || 0) > MAX_VOICE_BYTES) {
      await send(chatId, "ההקלטה ארוכה מדי. נסי הקלטה קצרה יותר 🙂");
      return;
    }
    try {
      var audio = await download(input.voice.file_id);
      body.audio = audio.toString("base64"); body.mime_type = input.voice.mime_type || "audio/ogg";
    } catch (err) { await send(chatId, "לא הצלחתי להוריד את ההקלטה. נסי שוב."); return; }
  } else body.text = input.text;
  var r = await mediaApi("correct", body, 120000);
  body = null;
  if (wait && wait.message_id) await D.tgCallSafe("deleteMessage", { chat_id: chatId, message_id: wait.message_id });
  if (r.status !== 200) { await send(chatId, "⚠️ " + (AI_ERROR_HE[r.body.code] || r.body.he || "התיקון נכשל. נסי שוב.")); return; }
  var fresh = await loadProject(p.id);
  if (opts && opts.resetPairs) await patchMeta(fresh, function (m, b) { b.pairs_ok = []; m.needs_review = true; });
  var w = (r.body.analysis && r.body.analysis.warnings) || [];
  await showSummary(chatId, fresh, w.indexOf("caption_not_changed") !== -1 ? null : "✏️ עודכן לפי התיקון", true);
  await nextStep(chatId, p.id);
}

// ---------------------------------------------------------------------------
// callbacks "p:…"
// ---------------------------------------------------------------------------
async function processCallback(query, chatId) {
  var parts = String(query.data || "").split(":");
  var act = parts[1], id = parts[2] || "", arg = parts[3];
  var mid = query.message && query.message.message_id;

  if (act === "albr" || act === "albp") { if (GID_RE.test(id)) await albumChoice(chatId, id, act === "albp", mid); return; }
  if (!UUID_RE.test(id)) return;

  if (act === "ack" || act === "rm") {
    var m = (await restGet("project_media?id=eq." + enc(id) + "&select=id,project_id,kind").catch(function () { return []; }))[0];
    var mp = m && await loadProject(m.project_id);
    if (!m || !ownedBy(mp, chatId)) { await D.cbNotice(chatId, "התמונה כבר טופלה."); await dropButtons(chatId, mid); return; }
    await dropButtons(chatId, mid);
    if (act === "ack") await D.supabasePatch("project_media", "id=eq." + enc(id), { flags_ack_at: new Date().toISOString() });
    else {
      var del = await mediaApi("delete", { media_id: id }, 30000);
      if (del.status !== 200) { await D.cbNotice(chatId, "המחיקה נכשלה. נסי שוב."); return; }
      await send(chatId, "🗑️ התמונה הוסרה.");
    }
    await nextStep(chatId, mp.id);
    return;
  }

  var p = await loadProject(id).catch(function () { return null; });
  if (!ownedBy(p, chatId)) { await D.cbNotice(chatId, "הפרויקט הזה כבר לא קיים."); await dropButtons(chatId, mid); return; }

  if (act === "cont") {
    await dropButtons(chatId, mid);
    if (p.status === "collecting") { await beginCollecting(chatId, p, "↩️ ממשיכים בפרויקט. אפשר לשלוח עוד קבצים ותיאור. כשמסיימים – ✅ סיימתי"); return; }
    if (p.ai_meta && p.ai_meta.analyzed_at) { await showSummary(chatId, p, null, true); await nextStep(chatId, p.id); return; }
    await send(chatId, "הניתוח של הפרויקט הזה לא הושלם.", { inline_keyboard: [[{ text: "🔄 לנתח שוב", callback_data: "p:redo:" + p.id }]] });
    return;
  }
  if (act === "new") {
    await dropButtons(chatId, mid);
    var np;
    try { np = await createProject(chatId); } catch (err) { await send(chatId, "שגיאה זמנית. נסי שוב בעוד רגע."); return; }
    await beginCollecting(chatId, np);
    return;
  }
  if (act === "done") { await finish(chatId, p.id, mid); return; }
  if (act === "redo") {
    if (p.status !== "draft") return;
    await dropButtons(chatId, mid);
    var st = await readState(chatId);
    if (!(st && st.context && st.context.project_id === p.id)) await D.setChatState(chatId, "project_review", { project_id: p.id });
    await runAnalysis(chatId, p.id);
    return;
  }
  if (act === "del") {
    await send(chatId, "למחוק את הפרויקט וכל הקבצים שלו? אי אפשר לשחזר.", { inline_keyboard: [[
      { text: "🗑️ כן, למחוק", callback_data: "p:delok:" + p.id }, { text: "↩️ לא", callback_data: "p:delno:" + p.id }]] });
    return;
  }
  if (act === "delno") { await dropButtons(chatId, mid); return; }
  if (act === "delok") {
    var dr = await mediaApi("delete-project", { project_id: p.id }, 60000);
    if (dr.status !== 200) { await D.cbNotice(chatId, "המחיקה נכשלה. נסי שוב."); return; }
    var st2 = await readState(chatId);
    if (st2 && st2.context && st2.context.project_id === p.id) await D.clearChatState(chatId);
    if (mid) await tgEdit(chatId, mid, "🗑️ הפרויקט נמחק.");
    var sm = p.ai_meta && p.ai_meta.bot && p.ai_meta.bot.summary_mid;
    if (sm) await dropButtons(chatId, sm);
    return;
  }

  // everything below needs an analyzed project
  if (p.status === "collecting") { await D.cbNotice(chatId, "קודם ✅ סיימתי 🙂"); return; }

  if (act === "cap" || act === "ttl" || act === "city" || act === "fix") {
    var field = { cap: "caption", ttl: "title", city: "city", fix: "fix" }[act];
    await D.setChatState(chatId, "project_edit", { project_id: p.id, field: field });
    var prompt = EDIT_PROMPT[field];
    if (field === "caption" && p.ai_meta && p.ai_meta.caption_body_he) prompt += "\n\nהכיתוב הנוכחי:\n" + p.ai_meta.caption_body_he;
    await send(chatId, prompt);
    return;
  }
  if (act === "short") { await correct(chatId, p, { text: "תקצר את הכיתוב" }, null); return; }

  if (act === "pok" || act === "psw" || act === "pfx") {
    var n = parseInt(arg, 10);
    if (!(n >= 1)) return;
    await dropButtons(chatId, mid);
    if (act === "pfx") {
      await D.setChatState(chatId, "project_edit", { project_id: p.id, field: "fix", pairs: true });
      await send(chatId, EDIT_PROMPT.fix);
      return;
    }
    if (act === "psw") {
      var pair = pairsOf(await loadMedia(p.id)).find(function (x) { return x.n === n; });
      if (pair) {
        await D.supabasePatch("project_media", "id=eq." + enc(pair.before.id), { role: "after" });
        await D.supabasePatch("project_media", "id=eq." + enc(pair.after.id), { role: "before" });
        await send(chatId, "⇄ הוחלף: זוג " + n);
      }
    }
    await patchMeta(p, function (m, b) { b.pairs_ok = (b.pairs_ok || []).filter(function (x) { return x !== n; }).concat(n); });
    await nextStep(chatId, p.id);
    return;
  }

  if (act === "cy" || act === "cn") {
    await dropButtons(chatId, mid);
    var yes = act === "cy";
    await patchMeta(p, function (m, b) {
      if (!yes) { m.publish_plan = { destinations: [], timing: "now", at: null, saved_at: new Date().toISOString() }; b.dests_done = false; b.timing_done = false; }
    }, { consent: yes ? "yes" : "no", consent_at: new Date().toISOString(), consent_by: "telegram" });
    if (!yes) {
      await D.clearChatState(chatId);
      await send(chatId, "🔒 נשמר כפרויקט פרטי – הוא לא יפורסם. אפשר לשנות את זה בפאנל (📸 פרויקטים).");
      return;
    }
    await nextStep(chatId, p.id);
    return;
  }

  if (p.consent !== "yes") { await D.cbNotice(chatId, "קודם צריך אישור של הלקוח לפרסום."); return; }

  if (act === "d") {
    if (!DESTS.some(function (d) { return d[0] === arg; })) return;
    await patchMeta(p, function (m) {
      var plan = Object.assign({ destinations: [], timing: "now", at: null }, m.publish_plan || {});
      var on = (plan.destinations || []).slice(), i = on.indexOf(arg);
      if (i === -1) on.push(arg); else on.splice(i, 1);
      plan.destinations = DESTS.map(function (d) { return d[0]; }).filter(function (k) { return on.indexOf(k) !== -1; });
      plan.saved_at = new Date().toISOString();
      m.publish_plan = plan;
    });
    await askDests(chatId, p, mid);
    return;
  }
  if (act === "dok") {
    var chosen = ((p.ai_meta && p.ai_meta.publish_plan) || {}).destinations || [];
    if (!chosen.length) { await D.cbNotice(chatId, "בחרי לפחות יעד אחד 🙂"); return; }
    await dropButtons(chatId, mid);
    await patchMeta(p, function (m, b) { b.dests_done = true; });
    await nextStep(chatId, p.id);
    return;
  }
  if (act === "now" || act === "slot") {
    var at = null;
    if (act === "slot") {
      at = new Date(parseInt(arg, 10) * 60000);
      if (!validSlot(at)) { await D.cbNotice(chatId, "המועד הזה כבר לא פנוי. בחרי שוב."); await askTimingSlots(chatId, p, mid); return; }
    }
    await dropButtons(chatId, mid);
    await patchMeta(p, function (m, b) {
      m.publish_plan = Object.assign({}, m.publish_plan || {}, { timing: at ? "at" : "now", at: at ? at.toISOString() : null, saved_at: new Date().toISOString() });
      b.timing_done = true;
    });
    await nextStep(chatId, p.id);
    return;
  }
  if (act === "at") { await askTimingSlots(chatId, p, mid); return; }
  if (act === "tm") { if (mid) await tgEdit(chatId, mid, "🕐 מתי לפרסם?", { inline_keyboard: [[{ text: "⚡ עכשיו", callback_data: "p:now:" + p.id }, { text: "🗓️ לבחור מועד", callback_data: "p:at:" + p.id }]] }); return; }
  if (act === "rd") {
    await dropButtons(chatId, mid);
    await patchMeta(p, function (m, b) { b.dests_done = false; b.timing_done = false; });
    await nextStep(chatId, p.id);
    return;
  }
  if (act === "ok") {
    var media = await loadMedia(p.id);
    var plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
    var missing = [];
    if (!media.length) missing.push("קבצים");
    if (media.some(needsReview)) missing.push("בדיקת פרטיות");
    if (!(plan.destinations || []).length) missing.push("יעד פרסום");
    if (missing.length) { await D.cbNotice(chatId, "חסר: " + missing.join(", ")); await nextStep(chatId, p.id); return; }
    await D.supabasePatch("projects", "id=eq." + enc(p.id), { status: "ready" });
    await D.clearChatState(chatId);
    if (mid) await tgEdit(chatId, mid, "✅ " + planLine(p));
    var smid = p.ai_meta && p.ai_meta.bot && p.ai_meta.bot.summary_mid;
    if (smid) await dropButtons(chatId, smid);
    var lines = ["נשמר ✔"];
    if (plan.destinations.indexOf("site") !== -1) {   // the site: now (or at its slot, by the publish cron)
      var sp = await internalApi("/api/site?action=publish", { project_id: p.id }, 30000);
      if (sp.status === 200 && sp.body.published || sp.body.already) lines.push("🌐 עלה לאתר: " + sp.body.url);
      else if (sp.status === 200 && sp.body.scheduled) lines.push("🌐 יעלה לאתר במועד שנבחר.");
      else lines.push("🌐 האתר: יעלה בסבב הפרסום הבא (תוך כ-10 דקות).");
    }
    if (plan.destinations.some(function (d) { return d !== "site"; })) lines.push("📣 הרשתות – הפרסום יופעל בשלב הבא.");
    await send(chatId, lines.join("\n"));
    return;
  }
}

async function askTimingSlots(chatId, p, editMid) {
  var slots = [];
  try { slots = await freeSlots(4); } catch (err) { console.error("[bot-projects] slots failed: " + err.message); }
  var rows = slots.map(function (s) { return [{ text: slotLabel(s), callback_data: "p:slot:" + p.id + ":" + Math.round(s.at.getTime() / 60000) }]; });
  rows.push([{ text: "⚡ עכשיו", callback_data: "p:now:" + p.id }, { text: "↩️ חזרה", callback_data: "p:tm:" + p.id }]);
  var text = "🗓️ המועדים הפנויים הבאים בלוח הפרסום:";
  if (editMid && await tgEdit(chatId, editMid, text, { inline_keyboard: rows })) return;
  await send(chatId, text, { inline_keyboard: rows });
}

// ---------------------------------------------------------------------------
// an album outside a mode → "📷 קבלות או 📸 פרויקט חדש?"
// ---------------------------------------------------------------------------
function groupClaimId(chatId, gid) {
  var h = crypto.createHash("sha256").update("album:" + chatId + ":" + gid).digest();
  return -(h.readUIntBE(0, 6) + 1);   // a negative "update id": never a real Telegram one
}
function isMissingTable(status, body) { return status === 404 || (body && (body.code === "42P01" || body.code === "PGRST205")); }

// Returns true when the item was parked (the caller does nothing else); false → handle as today.
async function parkAlbumItem(msg, chatId) {
  var gid = String(msg.media_group_id || "");
  var ref = refFromMessage(msg);
  if (!GID_RE.test(gid) || !ref || !ref.file_unique_id) return false;
  var row = { chat_id: chatId, media_group_id: gid, message_id: msg.message_id || 0, kind: ref.kind, file_id: ref.file_id, file_unique_id: ref.file_unique_id,
    thumb_file_id: ref.thumb_file_id || null, mime_type: ref.mime || null, file_size: ref.file_size || null };
  var res = await D.fetchT(SUPABASE_URL + "/rest/v1/telegram_parked_media", { method: "POST", headers: Object.assign({ Prefer: "return=minimal" }, D.supabaseHeaders()), body: JSON.stringify(row) })
    .catch(function () { return null; });
  if (!res) return false;
  if (!res.ok && res.status !== 409) {
    var b = await res.json().catch(function () { return null; });
    if (isMissingTable(res.status, b)) console.error("[bot-projects] telegram_parked_media missing (apply supabase-telegram-parked-media.sql) — album handled as receipts");
    else console.error("[bot-projects] park failed: " + res.status);
    return false;
  }
  // ask once per album: the first item to insert this synthetic id wins
  var claim = await D.fetchT(SUPABASE_URL + "/rest/v1/telegram_processed_updates", { method: "POST", headers: Object.assign({ Prefer: "return=minimal" }, D.supabaseHeaders()),
    body: JSON.stringify({ update_id: groupClaimId(chatId, gid) }) }).catch(function () { return null; });
  if (claim && claim.status === 409) return true;
  await send(chatId, "קיבלתי כמה קבצים ביחד. מה הם?", { inline_keyboard: [[
    { text: "📷 קבלות", callback_data: "p:albr:" + gid }, { text: "📸 פרויקט חדש", callback_data: "p:albp:" + gid }]] });
  return true;
}

async function albumChoice(chatId, gid, asProject, mid) {
  await sleep(TIMING.albumWaitMs);   // late items of the album
  var rows = await restGet("telegram_parked_media?chat_id=eq." + chatId + "&media_group_id=eq." + enc(gid) + "&order=message_id.asc&select=*").catch(function () { return null; });
  if (!rows || !rows.length) { if (mid) await tgEdit(chatId, mid, "הקבצים האלה כבר טופלו."); return; }
  await D.supabaseDelete("telegram_parked_media", "chat_id=eq." + chatId + "&media_group_id=eq." + enc(gid)).catch(function () {});
  var refs = rows.map(function (r) { return { kind: r.kind, file_id: r.file_id, file_unique_id: r.file_unique_id, thumb_file_id: r.thumb_file_id, mime: r.mime_type || "", file_size: Number(r.file_size) || 0, message_id: r.message_id }; });
  if (asProject) {
    if (mid) await tgEdit(chatId, mid, "📸 פותח פרויקט חדש עם " + plural(refs.length, "הקובץ", "הקבצים") + "…");
    await startProjectWithFiles(chatId, refs.filter(function (r) { return r.kind !== "document"; }));
    if (refs.some(function (r) { return r.kind === "document"; })) await send(chatId, DOC_HINT);
    return;
  }
  if (mid) await tgEdit(chatId, mid, "📷 סורק כקבלות…");
  await D.setChatState(chatId, "awaiting_receipt", {}).catch(function () {});   // late album items → receipts too
  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    if (r.kind === "video") { await send(chatId, "🎬 סרטון לא נשמר כקבלה."); continue; }
    var fake = r.kind === "photo" ? { message_id: r.message_id, photo: [{ file_id: r.file_id, file_unique_id: r.file_unique_id, file_size: r.file_size }] }
      : { message_id: r.message_id, document: { file_id: r.file_id, file_unique_id: r.file_unique_id, mime_type: r.mime, file_size: r.file_size } };
    await D.processReceiptMessage(fake, chatId);
  }
}

// ---------------------------------------------------------------------------
// a photo the receipt scanner found nothing in → "להתחיל פרויקט חדש עם התמונה הזו?"
// ---------------------------------------------------------------------------
function looksLikeNoReceipt(message, extracted) {
  return !!(message && message.photo && message.photo.length) && extracted && extracted.total_amount == null && !extracted.vendor_name;
}
function notReceiptKeyboard(pendingId) {
  return { inline_keyboard: [[{ text: "📸 כן, פרויקט חדש", callback_data: "nrproj:" + pendingId }, { text: "🧾 לא, זו קבלה", callback_data: "nrkeep:" + pendingId }]] };
}
// The pending receipt was already scanned (one receipt-quota unit); its photo's Telegram ids ride in
// extracted._tg_photo. "כן" → the receipt is discarded and the same photo opens a project.
async function receiptToProject(chatId, pending) {
  var tg = pending.extracted && pending.extracted._tg_photo;
  if (!tg || !tg.file_id) { await send(chatId, "לא מצאתי את התמונה. שלחי אותה שוב אחרי 📸 פרויקט חדש."); return; }
  await startProjectWithFiles(chatId, [{ kind: "photo", file_id: tg.file_id, file_unique_id: tg.file_unique_id, file_size: tg.file_size || 0, mime: "image/jpeg" }]);
}

// ---------------------------------------------------------------------------
// retention: empty "collecting" projects older than 24 h (bot or panel)
// ---------------------------------------------------------------------------
async function sweepStaleProjects() {
  var cutoff = new Date(Date.now() - STALE_COLLECTING_MS).toISOString();
  var rows = await restGet("projects?status=eq.collecting&created_at=lt." + enc(cutoff) + "&select=id,project_media(id)&limit=10");
  for (var i = 0; i < rows.length; i++) {
    if ((rows[i].project_media || []).length) continue;
    var r = await mediaApi("delete-project", { project_id: rows[i].id }, 30000);   // also removes unprocessed uploads
    if (r.status !== 200) console.error("[bot-projects] stale project sweep failed: " + r.status);
  }
}

module.exports = {
  init, activeState, startProject, handleCollect, handleEdit, processCallback, parkAlbumItem, sweepStaleProjects,
  looksLikeNoReceipt, notReceiptKeyboard, receiptToProject,
  _internal: { TIMING, statusView, summaryView, pairsOf, cityFrom, validSlot, freeSlots, groupClaimId, refFromMessage, DONE_RE, START_TEXT, DOC_HINT }
};
