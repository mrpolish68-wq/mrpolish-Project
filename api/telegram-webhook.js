// Telegram Bot Integration for Business Expense Receipts — Phase 2.
//
// Lets Ori snap a photo of a receipt straight from Telegram (no need to open the
// dashboard) and get it AI-extracted and ready to save with two taps. Reuses the exact
// same Gemini extraction core as the dashboard's scanner (api/parse-receipt.js's
// callGemini/normalizeExtraction/CATEGORIES) — one prompt/schema, two entry points.
//
// This endpoint is necessarily SESSIONLESS (Telegram calls it directly — there's no
// Supabase Auth session to check), so it's secured differently from every other
// api/*.js route in this codebase:
//   1. TELEGRAM_WEBHOOK_SECRET — Telegram's own "secret_token" webhook feature. Set once
//      via tools/set-telegram-webhook.js, Telegram echoes it back on the
//      X-Telegram-Bot-Api-Secret-Token header of every real call. A mismatch means the
//      request did NOT come from Telegram (401) — this is the primary access boundary.
//   2. TELEGRAM_ALLOWED_CHATS — a comma-separated allowlist of chat ids. Fails CLOSED: if
//      unset, nothing is processed at all. This stops a stranger who finds/messages the
//      bot from using it, even though they'd pass check #1 (Telegram legitimately relays
//      their messages too — check #1 only proves the message is real, not that it's Ori).
//   Every Supabase write here uses the service_role key (bypasses RLS), same posture as
//   the cron-triggered writes in publish-scheduled-content.js / analytics-agent.js.
//
// Multi-step interaction across stateless invocations: the message that uploads a photo
// and the later tap on "✅ אשר" arrive as two completely separate webhook calls, quite
// possibly on different serverless instances. Telegram's inline-keyboard callback_data
// has a hard 64-byte limit — nowhere near enough to carry the full extracted payload — so
// the extraction result is parked in telegram_pending_receipts (service_role-only, RLS
// enabled with zero policies) keyed by a short uuid, and that uuid is what actually rides
// in callback_data ("c:<uuid>" / "x:<uuid>"). See supabase-telegram-receipts.sql.
//
// Data flow (deliberately mirrors admin.html's "AI suggests, human confirms" scanner,
// adapted for Telegram's tap-only interaction — there's no free-text field editing here,
// so a receipt with no legible total amount can't be auto-saved; see the confirm handler):
//   photo/PDF in -> download from Telegram -> Gemini extraction -> upload original to the
//   private "receipts" Storage bucket (Phase 1's bucket) -> pending row + summary message
//   with Confirm/Cancel buttons -> tap Confirm -> insert into business_expenses
//   (source: "ocr") -> pending row deleted, Telegram message updated in place.
"use strict";

const { rateLimit } = require("./_rate-limit.js");
const { callGemini, normalizeExtraction, ALLOWED_MIME_TYPES } = require("./parse-receipt.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";
const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file/bot";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // same guard as the dashboard's client-side check
const PENDING_TTL_HOURS = 48; // opportunistic sweep, see cleanupStalePending()

// ---------------------------------------------------------------------------
// Supabase REST helpers (service_role) — this project has no package.json/npm
// dependencies, so every api/*.js file keeps its own small raw-fetch helpers rather
// than sharing a client SDK (documented convention, see analytics-agent.js's header).
// ---------------------------------------------------------------------------

function supabaseHeaders() {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function supabaseInsert(table, row) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: Object.assign({ Prefer: "return=representation" }, supabaseHeaders()),
    body: JSON.stringify(row)
  });
  var data = await res.json();
  if (!res.ok) throw new Error("Supabase insert into " + table + " failed: " + res.status + " " + JSON.stringify(data));
  return data[0];
}

async function supabaseSelectOne(table, filterQs) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQs + "&select=*", { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query on " + table + " failed: " + res.status);
  var rows = await res.json();
  return rows[0] || null;
}

async function supabaseDelete(table, filterQs) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQs, {
    method: "DELETE",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders())
  });
  if (!res.ok) throw new Error("Supabase delete on " + table + " failed: " + res.status);
}

async function uploadReceiptToStorage(path, buffer, mimeType) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/receipts/" + path, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": mimeType, "x-upsert": "false" },
    body: buffer
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error("Storage upload failed: " + res.status + " " + text);
  }
}

// Best-effort cleanup (e.g. after Ori taps "בטל") — never lets a Storage failure break
// the user-facing flow, just logs it server-side.
async function deleteReceiptFromStorage(path) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    var res = await fetch(SUPABASE_URL + "/storage/v1/object/receipts/" + path, {
      method: "DELETE",
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!res.ok) console.error("[telegram-webhook] storage cleanup non-OK for " + path + ": " + res.status);
  } catch (err) {
    console.error("[telegram-webhook] storage cleanup failed for " + path + ": " + err.message);
  }
}

async function cleanupStalePending() {
  var cutoff = new Date(Date.now() - PENDING_TTL_HOURS * 60 * 60 * 1000).toISOString();
  try {
    await supabaseDelete("telegram_pending_receipts", "created_at=lt." + encodeURIComponent(cutoff));
  } catch (err) {
    console.error("[telegram-webhook] stale-pending cleanup failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers
// ---------------------------------------------------------------------------

async function tgCall(method, payload) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var res = await fetch(TELEGRAM_API_ROOT + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  var data = await res.json();
  if (!data.ok) throw new Error("Telegram API " + method + " failed: " + (data.description || res.status));
  return data.result;
}

// Never lets a courtesy/non-critical Telegram call (typing indicator, best-effort
// message edit) take down the main flow.
function tgCallSafe(method, payload) {
  return tgCall(method, payload).catch(function (err) {
    console.error("[telegram-webhook] " + method + " (non-fatal) failed: " + err.message);
  });
}

async function tgDownloadFile(filePath) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var res = await fetch(TELEGRAM_FILE_ROOT + token + "/" + filePath);
  if (!res.ok) throw new Error("Telegram file download failed: " + res.status);
  var arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function extFromMime(mimeType) {
  var map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
  return map[mimeType] || "bin";
}

// Telegram documents don't always carry a reliable mime_type — fall back to the file
// extension for the common cases we support.
function mimeFromTelegramDocument(doc) {
  if (doc.mime_type && ALLOWED_MIME_TYPES.indexOf(doc.mime_type) !== -1) return doc.mime_type;
  var name = (doc.file_name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

function fmtMoney(n) {
  return "₪" + Number(n).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Plain text, deliberately no parse_mode. vendor_name/confidence_notes are AI-extracted
// free text from a real-world document — sending them through Telegram's Markdown/
// MarkdownV2 parser risks a "can't parse entities" 400 (or worse, silently mangled
// output) the moment a vendor name contains an unescaped _, *, (, ) etc. Plain text with
// emoji prefixes reads perfectly well without that entire class of bug.
function formatSummary(data) {
  var lines = ["🧾 קבלה נותחה בהצלחה", ""];
  lines.push("🏢 ספק / בית עסק: " + (data.vendor_name || "לא זוהה"));
  lines.push("📅 תאריך: " + (data.date || "לא זוהה"));
  lines.push("💰 סכום כולל: " + (data.total_amount != null ? fmtMoney(data.total_amount) : "❌ לא זוהה"));
  if (data.amount_before_vat != null || data.vat_amount != null) {
    lines.push("   לפני מע\"מ: " + (data.amount_before_vat != null ? fmtMoney(data.amount_before_vat) : "—") +
      "  |  מע\"מ: " + (data.vat_amount != null ? fmtMoney(data.vat_amount) : "—"));
  }
  lines.push("🏷️ קטגוריה מוצעת: " + data.category);
  if (data.invoice_number) lines.push("🧾 מס' חשבונית: " + data.invoice_number);
  if (data.confidence_notes) lines.push("", "⚠️ " + data.confidence_notes);
  if (data.total_amount == null) {
    lines.push("", "❌ לא זוהה סכום — לא ניתן לשמור אוטומטית. יש להוסיף את ההוצאה ידנית בלוח הבקרה.");
  }
  return lines.join("\n");
}

function confirmKeyboard(pendingId) {
  return {
    inline_keyboard: [[
      { text: "✅ אשר ושמור בהוצאות", callback_data: "c:" + pendingId },
      { text: "❌ בטל", callback_data: "x:" + pendingId }
    ]]
  };
}

// ---------------------------------------------------------------------------
// Message handling — a photo or supported document arrives
// ---------------------------------------------------------------------------

async function processReceiptMessage(message, chatId) {
  var fileRef = null;
  if (message.photo && message.photo.length) {
    var best = message.photo[message.photo.length - 1]; // Telegram sends multiple sizes, largest last
    fileRef = { fileId: best.file_id, mimeType: "image/jpeg" }; // Telegram always transcodes photos to JPEG
  } else if (message.document) {
    var mt = mimeFromTelegramDocument(message.document);
    if (!mt) {
      await tgCallSafe("sendMessage", { chat_id: chatId, text: "סוג קובץ לא נתמך. אפשר לשלוח תמונה (JPG/PNG/WEBP) או PDF." });
      return;
    }
    if (message.document.file_size && message.document.file_size > MAX_FILE_BYTES) {
      await tgCallSafe("sendMessage", { chat_id: chatId, text: "הקובץ גדול מדי (מעל 15MB). נסו לשלוח כתמונה, או השתמשו בלוח הבקרה." });
      return;
    }
    fileRef = { fileId: message.document.file_id, mimeType: mt };
  } else {
    await tgCallSafe("sendMessage", {
      chat_id: chatId,
      text: "שלחו לי תמונה של קבלה (מהמצלמה או מהגלריה) או קובץ PDF, ואני אנתח אותה ואכין אותה לשמירה בהוצאות העסק."
    });
    return;
  }

  var apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    console.error("[telegram-webhook] missing GOOGLE_AI_API_KEY configuration");
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "השירות אינו מוגדר כרגע. נסו שוב מאוחר יותר, או השתמשו בלוח הבקרה." });
    return;
  }

  await tgCallSafe("sendChatAction", { chat_id: chatId, action: "typing" });

  var fileInfo, fileBuffer;
  try {
    fileInfo = await tgCall("getFile", { file_id: fileRef.fileId });
    if (fileInfo.file_size && fileInfo.file_size > MAX_FILE_BYTES) {
      await tgCallSafe("sendMessage", { chat_id: chatId, text: "הקובץ גדול מדי (מעל 15MB). נסו לשלוח כתמונה, או השתמשו בלוח הבקרה." });
      return;
    }
    fileBuffer = await tgDownloadFile(fileInfo.file_path);
  } catch (err) {
    console.error("[telegram-webhook] file download failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "לא הצלחתי להוריד את הקובץ מטלגרם. נסו לשלוח שוב." });
    return;
  }

  var extracted;
  try {
    var raw = await callGemini(apiKey, fileBuffer.toString("base64"), fileRef.mimeType);
    extracted = normalizeExtraction(raw);
  } catch (err) {
    console.error("[telegram-webhook] Gemini extraction failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "ניתוח הקבלה נכשל. אפשר לנסות שוב, או להזין ידנית בלוח הבקרה." });
    return;
  }
  if (!extracted) {
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "ניתוח הקבלה החזיר תוצאה לא תקינה. אפשר לנסות שוב, או להזין ידנית בלוח הבקרה." });
    return;
  }

  var storagePath = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + extFromMime(fileRef.mimeType);
  try {
    await uploadReceiptToStorage(storagePath, fileBuffer, fileRef.mimeType);
  } catch (err) {
    console.error("[telegram-webhook] storage upload failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בשמירת קובץ הקבלה. נסו שוב." });
    return;
  }

  var pending;
  try {
    pending = await supabaseInsert("telegram_pending_receipts", {
      chat_id: chatId,
      receipt_path: storagePath,
      extracted: extracted
    });
  } catch (err) {
    console.error("[telegram-webhook] pending row insert failed: " + err.message);
    await deleteReceiptFromStorage(storagePath);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בשמירת הנתונים. נסו שוב." });
    return;
  }

  await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: formatSummary(extracted),
    reply_markup: confirmKeyboard(pending.id)
  });
}

// ---------------------------------------------------------------------------
// Callback query handling — Ori tapped "✅ אשר" or "❌ בטל"
// ---------------------------------------------------------------------------

async function processCallbackQuery(query, chatId) {
  var data = query.data || "";
  var isConfirm = data.indexOf("c:") === 0;
  var isCancel = data.indexOf("x:") === 0;
  var messageId = query.message && query.message.message_id;

  if (!isConfirm && !isCancel) {
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id });
    return;
  }
  var pendingId = data.slice(2);

  var pending;
  try {
    pending = await supabaseSelectOne("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
  } catch (err) {
    console.error("[telegram-webhook] pending lookup failed: " + err.message);
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "שגיאה זמנית. נסו שוב.", show_alert: true });
    return;
  }

  // Missing row (already handled, expired, or tampered id) / chat mismatch — same
  // response either way, no need to distinguish for the user.
  if (!pending || String(pending.chat_id) !== String(chatId)) {
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "הבקשה כבר טופלה או שפג תוקפה.", show_alert: true });
    if (messageId) await tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (isCancel) {
    await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
    await deleteReceiptFromStorage(pending.receipt_path);
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "בוטל" });
    if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(pending.extracted) + "\n\n❌ בוטל — לא נשמר." });
    return;
  }

  // Confirm. A receipt with no legible amount can't be safely auto-saved — there's no
  // free-text field editing over Telegram's inline keyboard (unlike the dashboard's
  // review modal), so the only honest option is to send Ori to the dashboard instead of
  // fabricating a placeholder amount.
  if (pending.extracted.total_amount == null) {
    await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
    await deleteReceiptFromStorage(pending.receipt_path);
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "לא ניתן לשמור — חסר סכום.", show_alert: true });
    if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(pending.extracted) + "\n\n❌ לא נשמר — יש להוסיף ידנית בלוח הבקרה." });
    return;
  }

  try {
    await supabaseInsert("business_expenses", {
      date: pending.extracted.date || new Date().toISOString().slice(0, 10),
      category: pending.extracted.category,
      amount: pending.extracted.total_amount,
      description: null,
      vendor_name: pending.extracted.vendor_name,
      invoice_number: pending.extracted.invoice_number,
      vat_amount: pending.extracted.vat_amount,
      amount_before_vat: pending.extracted.amount_before_vat,
      receipt_url: pending.receipt_path,
      source: "ocr"
    });
  } catch (err) {
    console.error("[telegram-webhook] business_expenses insert failed: " + err.message);
    await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "שגיאה בשמירה. נסו שוב.", show_alert: true });
    return;
  }

  await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
  await tgCallSafe("answerCallbackQuery", { callback_query_id: query.id, text: "✅ נשמר!" });
  if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(pending.extracted) + "\n\n✅ נשמר בהוצאות העסק." });
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function isAllowedChat(chatId) {
  var allowedRaw = process.env.TELEGRAM_ALLOWED_CHATS || "";
  var allowed = allowedRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  if (!allowed.length) return false; // fail closed — see the file header
  return allowed.indexOf(String(chatId)) !== -1;
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  var botToken = process.env.TELEGRAM_BOT_TOKEN;
  var webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!botToken || !webhookSecret || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GOOGLE_AI_API_KEY) {
    console.error("[telegram-webhook] missing TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_AI_API_KEY configuration");
    // Still 200 — Telegram would otherwise retry indefinitely, and there's no useful
    // reply we can send without a working bot token in the first place.
    res.status(200).json({ ok: true });
    return;
  }

  // Telegram echoes back whatever secret_token was set on setWebhook (see
  // tools/set-telegram-webhook.js) on this exact header, on every real call. Anything
  // else did not come from Telegram.
  if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  var update = req.body || {};

  try {
    if (update.callback_query) {
      var q = update.callback_query;
      var cbChatId = q.message && q.message.chat && q.message.chat.id;
      if (cbChatId == null || !isAllowedChat(cbChatId)) {
        await tgCallSafe("answerCallbackQuery", { callback_query_id: q.id });
        res.status(200).json({ ok: true });
        return;
      }
      if (!rateLimit("telegram-callback:" + cbChatId, 20, 60 * 1000).ok) {
        await tgCallSafe("answerCallbackQuery", { callback_query_id: q.id, text: "לאט לאט 🙂" });
        res.status(200).json({ ok: true });
        return;
      }
      await processCallbackQuery(q, cbChatId);
      res.status(200).json({ ok: true });
      return;
    }

    if (update.message) {
      var msg = update.message;
      var chatId = msg.chat && msg.chat.id;
      if (chatId == null) {
        res.status(200).json({ ok: true });
        return;
      }
      if (!isAllowedChat(chatId)) {
        // Silent — a stranger who finds/messages the bot gets no reply at all, so the
        // allowlist doubles as "does this bot even do anything for you" concealment.
        res.status(200).json({ ok: true });
        return;
      }
      if (!rateLimit("telegram-message:" + chatId, 10, 10 * 60 * 1000).ok) {
        await tgCallSafe("sendMessage", { chat_id: chatId, text: "לאט לאט 🙂 אפשר לשלוח קבלה נוספת בעוד כמה דקות." });
        res.status(200).json({ ok: true });
        return;
      }
      await cleanupStalePending();
      await processReceiptMessage(msg, chatId);
      res.status(200).json({ ok: true });
      return;
    }

    // Any other update type (edited_message, my_chat_member, etc.) — nothing to do.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[telegram-webhook] unhandled error: " + err.message);
    // Always 200 to Telegram on our own bugs too — a 5xx here just triggers Telegram's
    // retry queue, which would replay a partially-processed message/callback rather
    // than help; the error is already logged server-side for us to fix.
    res.status(200).json({ ok: true });
  }
};
