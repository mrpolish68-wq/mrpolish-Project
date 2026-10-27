// Telegram Bot Integration for Business Expense Receipts — Phase 2 (+ pre-confirmation
// editing).
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
//   Which bot: production uses the three vars above; previews/local use their TELEGRAM_TEST_*
//   counterparts (a separate test bot) and never fall back — see telegramConfig().
//   Every Supabase write here uses the service_role key (bypasses RLS), same posture as
//   the cron-triggered writes in publish-scheduled-content.js / analytics-agent.js.
//
// Multi-step interaction across stateless invocations: the message that uploads a photo
// and the later tap on "✅ אשר" arrive as two completely separate webhook calls, quite
// possibly on different serverless instances. Telegram's inline-keyboard callback_data
// has a hard 64-byte limit — nowhere near enough to carry the full extracted payload — so
// the extraction result is parked in telegram_pending_receipts (service_role-only, RLS
// enabled with zero policies) keyed by a short uuid, and that uuid is what actually rides
// in callback_data ("confirm:<uuid>" / "cancel:<uuid>" / etc). See
// supabase-telegram-receipts.sql + supabase-telegram-receipts-edit.sql.
//
// Pre-confirmation editing: three extra buttons (✏️ שנה תאריך / ✏️ שנה סכום / 🏷️ שנה
// קטגוריה) let Ori correct a wrong extraction without leaving Telegram. Category is a
// fixed 6-value enum, so its button just CYCLES to the next value on every tap — fully
// synchronous, no extra state needed. Date/amount are free-form, so tapping their button
// sets telegram_pending_receipts.awaiting_edit_field and prompts Ori to reply with the
// new value as a plain text message; the NEXT plain-text message from that chat (within
// 30 minutes — see findAwaitingEdit) is then interpreted as that reply rather than a new
// receipt upload attempt. The pending row's message_id is stored specifically so these
// edits (which usually arrive as plain messages, not callback_queries — Telegram doesn't
// hand back the triggering message's id on a plain text reply the way it does on a
// button tap) can still edit the ONE summary message in place instead of spamming a new
// message into the chat for every correction.
//
// Reliability + routing (Telegram quotes, Phase 5b): every update is deduped by update_id
// (telegram_processed_updates, insert-first), ACKed with 200 right away, and processed in
// waitUntil; callbacks are answered immediately. A message is routed: menu label/command ->
// pending edit (receipt or quote draft, newest wins) -> photo/document = receipt -> voice or
// text with a quote keyword = quote -> otherwise "unclear" + a "🧾 להכין הצעת מחיר?" button.
// Separate per-chat rate limits per flow (receipt / quote / menu). See routeMessage().
//
// Data flow (deliberately mirrors admin.html's "AI suggests, human confirms" scanner):
//   photo/PDF in -> download from Telegram -> Gemini extraction -> upload original to the
//   private "receipts" Storage bucket (Phase 1's bucket) -> pending row + summary message
//   with edit/Confirm/Cancel buttons -> optional edits -> tap Confirm -> insert into
//   business_expenses (source: "ocr") -> pending row deleted, Telegram message updated in
//   place. A receipt with no legible total amount can't be confirmed — there's no way to
//   type a brand-new amount except via the explicit "✏️ שנה סכום" flow, so a bare Confirm
//   tap on a missing-amount receipt is refused rather than saving a fabricated value.
"use strict";

const crypto = require("crypto");
const { waitUntil } = require("@vercel/functions");
const { rateLimit } = require("./_rate-limit.js");
const { consumeQuota, getRemaining, LIMITS } = require("./_quota.js");
const QX = require("./_quote-extract.js");
const { estimateDescriptionFits } = require("../shared/quote-template.js");
const { callGemini, normalizeExtraction, ALLOWED_MIME_TYPES, CATEGORIES } = require("./parse-receipt.js");

// Constant-time comparison for the webhook secret — a plain !== short-circuits on the
// first mismatched byte, which is the textbook timing side-channel for secret
// comparison. Practically very hard to exploit over the internet through Vercel's own
// latency jitter, but this is a one-line fix for exactly the class of bug a security
// audit exists to catch.
function safeEqual(a, b) {
  var bufA = Buffer.from(String(a || ""), "utf8");
  var bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const TELEGRAM_API_ROOT = "https://api.telegram.org/bot";
const TELEGRAM_FILE_ROOT = "https://api.telegram.org/file/bot";

const MAX_FILE_BYTES = 15 * 1024 * 1024; // same guard as the dashboard's client-side check
const PENDING_TTL_HOURS = 48; // opportunistic sweep, see sweepRetention()
const AWAITING_EDIT_TTL_MS = 30 * 60 * 1000; // see findAwaitingEdit()

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
  var data = await res.json().catch(function () { return null; });
  // Status + PostgREST error code only: the body can echo row values ("Failing row contains …").
  if (!res.ok) throw new Error("Supabase insert into " + table + " failed: " + res.status + (data && data.code ? " " + data.code : ""));
  return data[0];
}

async function supabaseSelectOne(table, filterQs) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQs + "&select=*", { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query on " + table + " failed: " + res.status);
  var rows = await res.json();
  return rows[0] || null;
}

async function supabasePatch(table, filterQs, patch) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQs, {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error("Supabase patch on " + table + " failed: " + res.status);
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
  if (!res.ok) throw new Error("Storage upload failed: " + res.status); // status only, never the body
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

// Opportunistic retention sweeps (no DB jobs; supabase-quotes-telegram.sql §8). At most once
// per SWEEP_INTERVAL_MS per warm instance, inside waitUntil, so they never delay a reply.
var SWEEP_INTERVAL_MS = 10 * 60 * 1000;
var RETENTION = [
  // [table, timestamp column, max age ms]
  ["telegram_pending_receipts", "created_at", PENDING_TTL_HOURS * 60 * 60 * 1000],
  ["telegram_pending_quotes", "created_at", 24 * 60 * 60 * 1000],      // drafts + transcripts
  ["telegram_chat_state", "state_since", 24 * 60 * 60 * 1000],
  ["telegram_processed_updates", "created_at", 7 * 24 * 60 * 60 * 1000],
  ["telegram_daily_usage", "day", 30 * 24 * 60 * 60 * 1000]
];
var lastSweepAt = 0;

async function sweepRetention() {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = Date.now();
  for (var i = 0; i < RETENTION.length; i++) {
    var table = RETENTION[i][0], column = RETENTION[i][1];
    var cutoff = new Date(Date.now() - RETENTION[i][2]).toISOString();
    if (column === "day") cutoff = cutoff.slice(0, 10);
    try {
      await supabaseDelete(table, column + "=lt." + encodeURIComponent(cutoff));
    } catch (err) {
      console.error("[telegram-webhook] retention sweep failed for " + table + ": " + err.message);
    }
  }
}

// Dedupe: insert the update_id FIRST. A redelivery (Telegram retries when our reply was
// slow or failed) hits the primary key -> 409 -> "duplicate". Any other failure fails OPEN
// (process the update), so a DB hiccup never drops a real message.
async function claimUpdate(updateId) {
  if (typeof updateId !== "number") return true;
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/telegram_processed_updates", {
      method: "POST",
      headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
      body: JSON.stringify({ update_id: updateId })
    });
    if (res.status === 409) return false;
    if (!res.ok) console.error("[telegram-webhook] dedupe insert HTTP " + res.status + " (failing open)");
    return true;
  } catch (err) {
    console.error("[telegram-webhook] dedupe insert failed (failing open)");
    return true;
  }
}

// Edit freshness is measured from the edit TAP (awaiting_since), not from when the receipt
// arrived (created_at, the old bug): a receipt sent 25 minutes ago whose edit button was
// tapped just now must still take the reply. awaiting_since is added by
// supabase-telegram-receipts-awaiting-since.sql; until that file is applied, PostgREST
// rejects the unknown column (PGRST204 / 42703) and the code falls back to the old
// created_at behavior instead of breaking the receipt edit flow.
var receiptsHaveAwaitingSince = true;

function isMissingColumnError(status, body) {
  return status === 400 && body && (body.code === "PGRST204" || body.code === "42703");
}

// Sets (or clears, with field=null) the receipt edit state. Returns nothing; throws on failure.
async function setReceiptAwaitingEdit(pendingId, field) {
  var patch = { awaiting_edit_field: field };
  if (receiptsHaveAwaitingSince) patch.awaiting_since = field ? new Date().toISOString() : null;
  var res = await fetch(SUPABASE_URL + "/rest/v1/telegram_pending_receipts?id=eq." + encodeURIComponent(pendingId), {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(patch)
  });
  if (res.ok) return;
  var body = await res.json().catch(function () { return null; });
  if (receiptsHaveAwaitingSince && isMissingColumnError(res.status, body)) {
    receiptsHaveAwaitingSince = false;
    return setReceiptAwaitingEdit(pendingId, field);
  }
  throw new Error("Supabase patch on telegram_pending_receipts failed: " + res.status);
}

// The most recent pending receipt for this chat that's mid-edit (awaiting_edit_field
// set), if any, within the freshness window. Scoped to a recent window on purpose: if
// Ori tapped an edit button, got distracted, and messages the bot again an hour later
// about something unrelated, that later text should NOT be silently swallowed as an
// edit reply for a receipt he's long since forgotten about.
async function findAwaitingEdit(chatId) {
  var cutoff = encodeURIComponent(new Date(Date.now() - AWAITING_EDIT_TTL_MS).toISOString());
  var col = receiptsHaveAwaitingSince ? "awaiting_since" : "created_at";
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/telegram_pending_receipts?chat_id=eq." + chatId +
      "&awaiting_edit_field=not.is.null&" + col + "=gte." + cutoff +
      "&order=" + col + ".desc&limit=1&select=*",
      { headers: supabaseHeaders() }
    );
    if (!res.ok) {
      var body = await res.json().catch(function () { return null; });
      if (receiptsHaveAwaitingSince && isMissingColumnError(res.status, body)) {
        receiptsHaveAwaitingSince = false;
        return findAwaitingEdit(chatId);
      }
      return null;
    }
    var rows = await res.json();
    if (!rows[0]) return null;
    rows[0].edit_since = rows[0][col];
    return rows[0];
  } catch (err) {
    console.error("[telegram-webhook] findAwaitingEdit failed: " + err.message);
    return null;
  }
}

// Same for quote drafts (telegram_pending_quotes has awaiting_since from the start).
async function findAwaitingQuoteEdit(chatId) {
  var cutoff = encodeURIComponent(new Date(Date.now() - AWAITING_EDIT_TTL_MS).toISOString());
  try {
    var res = await fetch(
      SUPABASE_URL + "/rest/v1/telegram_pending_quotes?chat_id=eq." + chatId +
      "&awaiting_edit_field=not.is.null&awaiting_since=gte." + cutoff +
      "&order=awaiting_since.desc&limit=1&select=id,awaiting_edit_field,awaiting_since",
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    var rows = await res.json();
    if (!rows[0]) return null;
    rows[0].edit_since = rows[0].awaiting_since;
    return rows[0];
  } catch (err) {
    console.error("[telegram-webhook] findAwaitingQuoteEdit failed: " + err.message);
    return null;
  }
}

// A menu tap starts over: clears any pending edit state (receipts + quote drafts) and the
// chat's menu state. Best-effort; drafts themselves are kept.
async function clearEditState(chatId) {
  var receiptPatch = { awaiting_edit_field: null };
  if (receiptsHaveAwaitingSince) receiptPatch.awaiting_since = null;
  var ops = [
    supabasePatch("telegram_pending_receipts", "chat_id=eq." + chatId + "&awaiting_edit_field=not.is.null", receiptPatch),
    supabasePatch("telegram_pending_quotes", "chat_id=eq." + chatId + "&awaiting_edit_field=not.is.null", { awaiting_edit_field: null, awaiting_since: null }),
    supabaseDelete("telegram_chat_state", "chat_id=eq." + chatId)
  ];
  var results = await Promise.allSettled(ops);
  if (results[0].status === "rejected" && receiptsHaveAwaitingSince) {
    // Most likely the awaiting_since column isn't there yet: retry without it.
    await supabasePatch("telegram_pending_receipts", "chat_id=eq." + chatId + "&awaiting_edit_field=not.is.null", { awaiting_edit_field: null })
      .catch(function () {});
  }
  results.forEach(function (r) {
    if (r.status === "rejected") console.error("[telegram-webhook] clearEditState: " + r.reason.message);
  });
}

// Claims a pending row atomically before the one operation that genuinely can't be
// double-run safely: inserting into business_expenses. A fat-finger double-tap on
// "✅ אשר", or Telegram redelivering the same callback_query when our response was
// slow, would otherwise both read the row as "still there" before either deleted it —
// two business_expenses rows for one receipt. This conditional UPDATE (claimed only if
// currently unclaimed or past its lease) is atomic per-row in Postgres, so only one
// concurrent caller ever gets a non-null result back — same claim/lease pattern as
// publish-scheduled-content.js's claimRow()/CLAIM_LEASE_MS for content_queue. The lease
// also self-heals a crash mid-processing: after it expires, a retry can reclaim.
var CLAIM_LEASE_MS = 2 * 60 * 1000;

async function claimPendingRow(id) {
  var cutoffIso = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  var url = SUPABASE_URL + "/rest/v1/telegram_pending_receipts?id=eq." + encodeURIComponent(id) +
    "&or=(claimed_at.is.null,claimed_at.lt." + encodeURIComponent(cutoffIso) + ")";
  var res = await fetch(url, {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=representation" }, supabaseHeaders()),
    body: JSON.stringify({ claimed_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("Supabase claim failed: " + res.status);
  var rows = await res.json();
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Which bot this deployment serves
// ---------------------------------------------------------------------------

// Production serves Miri's bot from TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET /
// TELEGRAM_ALLOWED_CHATS and ignores the TEST_ vars entirely. Every other environment
// (branch previews, local runs) serves the separate TEST bot from TELEGRAM_TEST_BOT_TOKEN /
// TELEGRAM_TEST_WEBHOOK_SECRET / TELEGRAM_TEST_ALLOWED_CHATS (Preview-only vars, see
// tools/set-test-webhook.js) and NEVER falls back to the production values: a preview with a
// missing TEST_ var processes nothing (see the handler). Values are never logged.
function telegramConfig() {
  var env = process.env;
  if (env.VERCEL_ENV === "production") {
    return {
      test: false,
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
      allowedChats: env.TELEGRAM_ALLOWED_CHATS || ""
    };
  }
  return {
    test: true,
    botToken: env.TELEGRAM_TEST_BOT_TOKEN || "",
    webhookSecret: env.TELEGRAM_TEST_WEBHOOK_SECRET || "",
    allowedChats: env.TELEGRAM_TEST_ALLOWED_CHATS || ""
  };
}

// ---------------------------------------------------------------------------
// Telegram Bot API helpers
// ---------------------------------------------------------------------------

async function tgCall(method, payload) {
  var token = telegramConfig().botToken;
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
  var token = telegramConfig().botToken;
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

// Money everywhere in the bot reads like the PDF: the number, a space, then ₪ ("4,200 ₪").
function fmtMoney(n) {
  return Number(n).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₪";
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }

// Accepts "YYYY-MM-DD" or Israeli "DD/MM/YYYY" (also DD.MM.YYYY, 2-digit year). Returns
// a normalized "YYYY-MM-DD" string, or null if the reply couldn't be understood.
function parseDateReply(text) {
  var t = (text || "").trim();
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) {
    var y = parseInt(iso[1], 10), m = parseInt(iso[2], 10), d = parseInt(iso[3], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return y + "-" + pad2(m) + "-" + pad2(d);
    return null;
  }
  var il = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(t);
  if (il) {
    var d2 = parseInt(il[1], 10), m2 = parseInt(il[2], 10);
    var yRaw = il[3];
    var y2 = yRaw.length === 2 ? 2000 + parseInt(yRaw, 10) : parseInt(yRaw, 10);
    if (m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) return y2 + "-" + pad2(m2) + "-" + pad2(d2);
  }
  return null;
}

// Strips currency symbols/commas/"ש"ח" and parses a positive number. Returns null if
// the reply couldn't be understood as a sane amount.
function parseAmountReply(text) {
  var cleaned = (text || "").replace(/[₪,\s]/g, "").replace(/ש["׳]?ח/g, "");
  var n = parseFloat(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function nextCategory(current) {
  var idx = CATEGORIES.indexOf(current);
  var nextIdx = idx === -1 ? 0 : (idx + 1) % CATEGORIES.length;
  return CATEGORIES[nextIdx];
}

// ---------------------------------------------------------------------------
// Duplicate-receipt detection — same matching rules as admin.html's client-side
// check (kept in sync by hand; there's no shared module across the browser/server
// boundary in this zero-dependency project), just querying Supabase directly instead
// of an in-memory array since there's no already-loaded dataset here. Two ways to
// flag a match:
//   1. Exact invoice_number (trimmed, non-empty) — the strongest signal.
//   2. Same date + same amount + same/similar vendor_name (substring match either
//      direction, to tolerate e.g. "פז" vs "פז חברת הדלק"). If vendor_name wasn't
//      extracted at all, date+amount alone is the fallback signal.
// Fails OPEN on any query error — an advisory feature like this should never block a
// legitimate save just because the check itself hiccuped.
// ---------------------------------------------------------------------------

function normalizeInvoice(s) { return String(s || "").trim(); }
function normalizeForMatch(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
function vendorsMatch(a, b) {
  var na = normalizeForMatch(a), nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

async function findDuplicateExpense(extracted) {
  try {
    var invoiceNum = normalizeInvoice(extracted.invoice_number);
    if (invoiceNum) {
      var byInvoiceRes = await fetch(
        SUPABASE_URL + "/rest/v1/business_expenses?invoice_number=eq." + encodeURIComponent(invoiceNum) + "&select=*&limit=1",
        { headers: supabaseHeaders() }
      );
      if (byInvoiceRes.ok) {
        var byInvoiceRows = await byInvoiceRes.json();
        if (byInvoiceRows[0]) return byInvoiceRows[0];
      }
    }
    if (extracted.date && extracted.total_amount != null) {
      var byDateAmountRes = await fetch(
        SUPABASE_URL + "/rest/v1/business_expenses?date=eq." + encodeURIComponent(extracted.date) +
        "&amount=eq." + encodeURIComponent(extracted.total_amount) + "&select=*&limit=20",
        { headers: supabaseHeaders() }
      );
      if (byDateAmountRes.ok) {
        var candidates = await byDateAmountRes.json();
        if (extracted.vendor_name) {
          var vendorMatch = candidates.filter(function (r) { return vendorsMatch(r.vendor_name, extracted.vendor_name); })[0];
          if (vendorMatch) return vendorMatch;
        } else if (candidates.length) {
          return candidates[0];
        }
      }
    }
  } catch (err) {
    console.error("[telegram-webhook] duplicate check failed (failing open): " + err.message);
  }
  return null;
}

function fmtDateIL(iso) {
  var parts = String(iso || "").split("-");
  return parts.length === 3 ? (parts[2] + "/" + parts[1] + "/" + parts[0]) : "לא ידוע";
}

function formatDupWarning(match) {
  return "⚠️ אזהרה: קיימת כבר הוצאה זהה במערכת!\n" +
    "• תאריך: " + fmtDateIL(match.date) + "\n" +
    "• ספק: " + (match.vendor_name || "לא צוין") + "\n" +
    "• סכום: " + fmtMoney(match.amount) + "\n" +
    "• מס' חשבונית: " + (match.invoice_number || "לא צוין");
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
    lines.push("", "❌ לא זוהה סכום — לא ניתן לשמור לפני שמעדכנים אותו (\"✏️ שנה סכום\") או ממלאים ידנית בלוח הבקרה.");
  }
  return lines.join("\n");
}

function actionKeyboard(pendingId, hasDuplicate) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ שנה תאריך", callback_data: "editdate:" + pendingId },
        { text: "✏️ שנה סכום", callback_data: "editamount:" + pendingId },
        { text: "🏷️ שנה קטגוריה", callback_data: "cyclecat:" + pendingId }
      ],
      [
        { text: hasDuplicate ? "⚠️ אשר בכל זאת" : "✅ אשר ושמור בהוצאות", callback_data: "confirm:" + pendingId },
        { text: "❌ בטל", callback_data: "cancel:" + pendingId }
      ]
    ]
  };
}

// Combines the duplicate check + summary text + keyboard into one call, since every
// place that (re)renders the summary message needs to re-check for a duplicate too —
// an edit to date/amount is exactly the kind of change that can create or remove a
// match, so this is deliberately re-run on every render rather than cached once.
async function buildSummaryPayload(extracted, pendingId) {
  var dup = await findDuplicateExpense(extracted);
  var text = (dup ? formatDupWarning(dup) + "\n\n" : "") + formatSummary(extracted);
  return { text: text, keyboard: actionKeyboard(pendingId, !!dup) };
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

  // Daily receipt quota (global, resets at midnight Israel time), used up BEFORE Gemini.
  // Fails closed: if the quota can't be checked, no AI call is made.
  var quota;
  try {
    quota = await consumeQuota("receipt");
  } catch (err) {
    console.error("[telegram-webhook] receipt quota check failed: " + err.code);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית. נסו לשלוח שוב בעוד רגע." });
    return;
  }
  if (!quota.ok) {
    await tgCallSafe("sendMessage", {
      chat_id: chatId,
      text: "הגענו למכסת סריקת הקבלות להיום (" + LIMITS.receipt + ") 🙂\nאפשר לשלוח שוב מחר, או להזין את ההוצאה ידנית בלוח הבקרה."
    });
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

  var initialPayload = await buildSummaryPayload(extracted, pending.id);
  var sent = await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: initialPayload.text,
    reply_markup: initialPayload.keyboard
  });
  // Needed so a later free-text edit reply (date/amount) can edit THIS message in place
  // instead of sending a new one — see the file header for why a plain message doesn't
  // otherwise carry its own message context the way a callback_query does.
  if (sent && sent.message_id) {
    try {
      await supabasePatch("telegram_pending_receipts", "id=eq." + encodeURIComponent(pending.id), { message_id: sent.message_id });
    } catch (err) {
      console.error("[telegram-webhook] message_id patch failed: " + err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Edit-reply handling — Ori tapped "✏️ שנה תאריך"/"✏️ שנה סכום" and then sent the new
// value as a plain text message.
// ---------------------------------------------------------------------------

async function processEditReply(pending, text, chatId) {
  var field = pending.awaiting_edit_field;
  var newExtracted = Object.assign({}, pending.extracted);
  var applied = false;

  if (field === "date") {
    var parsedDate = parseDateReply(text);
    if (parsedDate) { newExtracted.date = parsedDate; applied = true; }
  } else if (field === "amount") {
    var parsedAmount = parseAmountReply(text);
    if (parsedAmount != null) { newExtracted.total_amount = parsedAmount; applied = true; }
  }

  if (!applied) {
    var retryText = field === "date"
      ? "לא הצלחתי להבין את התאריך. נסו שוב, למשל 15/08/2026 או 2026-08-15."
      : "לא הצלחתי להבין את הסכום. שלחו מספר בלבד, למשל 245.50.";
    await tgCallSafe("sendMessage", { chat_id: chatId, text: retryText });
    return; // awaiting_edit_field stays set — the next reply gets another try
  }

  try {
    await supabasePatch("telegram_pending_receipts", "id=eq." + encodeURIComponent(pending.id), {
      extracted: newExtracted,
      awaiting_edit_field: null
    });
  } catch (err) {
    console.error("[telegram-webhook] edit reply patch failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בעדכון. נסו שוב." });
    return;
  }

  var fieldLabelHe = field === "date" ? "תאריך" : "סכום";
  var editReplyPayload = await buildSummaryPayload(newExtracted, pending.id);
  var refreshedText = editReplyPayload.text + "\n\n✏️ עודכן: " + fieldLabelHe;
  if (pending.message_id) {
    await tgCallSafe("editMessageText", { chat_id: chatId, message_id: pending.message_id, text: refreshedText, reply_markup: editReplyPayload.keyboard });
  } else {
    await tgCallSafe("sendMessage", { chat_id: chatId, text: refreshedText, reply_markup: editReplyPayload.keyboard });
  }
}

// ---------------------------------------------------------------------------
// Callback query handling — Ori tapped one of the inline-keyboard buttons
// ---------------------------------------------------------------------------

var KNOWN_ACTIONS = ["confirm", "cancel", "editdate", "editamount", "cyclecat", "newquote"];

// Every callback is answered immediately in the handler (stops the button's spinner), and a
// callback can be answered only once, so anything the user must read is sent as a message.
function cbNotice(chatId, text) {
  return tgCallSafe("sendMessage", { chat_id: chatId, text: text });
}

async function processCallbackQuery(query, chatId) {
  var data = query.data || "";
  if (data.indexOf("q:") === 0) return processQuoteCallback(query, chatId);
  var sep = data.indexOf(":");
  var action = sep === -1 ? data : data.slice(0, sep);
  var pendingId = sep === -1 ? "" : data.slice(sep + 1);
  var messageId = query.message && query.message.message_id;

  if (KNOWN_ACTIONS.indexOf(action) === -1) {
    return;
  }
  if (action === "newquote") {
    await startQuote(chatId, null);
    return;
  }

  var pending;
  try {
    pending = await supabaseSelectOne("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
  } catch (err) {
    console.error("[telegram-webhook] pending lookup failed: " + err.message);
    await cbNotice(chatId, "שגיאה זמנית. נסו שוב.");
    return;
  }

  // Missing row (already handled, expired, or tampered id) / chat mismatch — same
  // response either way, no need to distinguish for the user.
  if (!pending || String(pending.chat_id) !== String(chatId)) {
    await cbNotice(chatId, "הבקשה כבר טופלה או שפג תוקפה.");
    if (messageId) await tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    return;
  }

  if (action === "cancel") {
    await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
    await deleteReceiptFromStorage(pending.receipt_path);
    if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(pending.extracted) + "\n\n❌ בוטל — לא נשמר." });
    return;
  }

  if (action === "cyclecat") {
    var afterCycle = Object.assign({}, pending.extracted, { category: nextCategory(pending.extracted.category) });
    try {
      await supabasePatch("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId), { extracted: afterCycle });
    } catch (err) {
      console.error("[telegram-webhook] category cycle patch failed: " + err.message);
      await cbNotice(chatId, "שגיאה. נסו שוב.");
      return;
    }
    var cyclePayload = await buildSummaryPayload(afterCycle, pendingId);
    if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: cyclePayload.text, reply_markup: cyclePayload.keyboard });
    return;
  }

  if (action === "editdate" || action === "editamount") {
    var field = action === "editdate" ? "date" : "amount";
    try {
      await setReceiptAwaitingEdit(pendingId, field);
    } catch (err) {
      console.error("[telegram-webhook] awaiting_edit_field patch failed: " + err.message);
      await cbNotice(chatId, "שגיאה. נסו שוב.");
      return;
    }
    var promptNote = field === "date"
      ? "✏️ שלחו כעת את התאריך החדש (למשל 15/08/2026 או 2026-08-15)."
      : "✏️ שלחו כעת את הסכום החדש (מספר בלבד, למשל 245.50).";
    var editPromptPayload = await buildSummaryPayload(pending.extracted, pendingId);
    var promptedText = editPromptPayload.text + "\n\n" + promptNote;
    if (messageId) {
      await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: promptedText, reply_markup: editPromptPayload.keyboard });
    } else {
      await tgCallSafe("sendMessage", { chat_id: chatId, text: promptedText, reply_markup: editPromptPayload.keyboard });
    }
    return;
  }

  // action === "confirm". Claim FIRST — this is the one step that genuinely can't run
  // twice safely (see claimPendingRow's comment). A losing concurrent tap gets a plain
  // "already being handled" response rather than risking a duplicate saved expense.
  var claimed;
  try {
    claimed = await claimPendingRow(pendingId);
  } catch (err) {
    console.error("[telegram-webhook] claim failed: " + err.message);
    await cbNotice(chatId, "שגיאה זמנית. נסו שוב.");
    return;
  }
  if (!claimed) {
    return;
  }

  // A receipt with no legible amount can't be saved as-is — Ori must either tap
  // "✏️ שנה סכום" first or finish the entry manually in the dashboard; there's no
  // honest way to insert a financial record with a fabricated placeholder.
  if (claimed.extracted.total_amount == null) {
    await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
    await deleteReceiptFromStorage(claimed.receipt_path);
    await cbNotice(chatId, "לא ניתן לשמור — חסר סכום.");
    if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(claimed.extracted) + "\n\n❌ לא נשמר — יש להוסיף ידנית בלוח הבקרה." });
    return;
  }

  try {
    await supabaseInsert("business_expenses", {
      date: claimed.extracted.date || new Date().toISOString().slice(0, 10),
      category: claimed.extracted.category,
      amount: claimed.extracted.total_amount,
      description: null,
      vendor_name: claimed.extracted.vendor_name,
      invoice_number: claimed.extracted.invoice_number,
      vat_amount: claimed.extracted.vat_amount,
      amount_before_vat: claimed.extracted.amount_before_vat,
      receipt_url: claimed.receipt_path,
      source: "ocr"
    });
  } catch (err) {
    console.error("[telegram-webhook] business_expenses insert failed: " + err.message);
    // Release the claim immediately rather than making Ori wait out the full lease —
    // the row (and its Storage file) are still intact, an instant retry can pick it
    // back up. Best-effort: if this itself fails, the lease still self-heals in 2 min.
    await supabasePatch("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId), { claimed_at: null }).catch(function () {});
    await cbNotice(chatId, "שגיאה בשמירה. נסו שוב.");
    return;
  }

  await supabaseDelete("telegram_pending_receipts", "id=eq." + encodeURIComponent(pendingId));
  if (messageId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: messageId, text: formatSummary(claimed.extracted) + "\n\n✅ נשמר בהוצאות העסק." });
}

// ---------------------------------------------------------------------------
// Quote drafts (Phase 5c): start -> extract (Gemini reads, code decides) -> draft message
// with buttons -> code-only edits / one-tap voice correction -> ✅ (PDF in 5d) or ❌.
// One active draft per chat, in telegram_pending_quotes (draft jsonb incl. the transcript;
// deleted on cancel, swept after 24h). Audio is downloaded into memory only, never stored.
// ---------------------------------------------------------------------------

var MAX_VOICE_SECONDS = 180;
var MAX_VOICE_BYTES = 15 * 1024 * 1024;
var TRANSCRIPT_PREVIEW_CHARS = 300;
var QUOTE_FIELD_BY_ACTION = { client: "client_name", addr: "address", desc: "description", total: "total", date: "quote_date" };
var QUOTE_FIELD_LABEL = { client_name: "לקוח", address: "כתובת", description: "תיאור", total: "סכום", quote_date: "תאריך" };
var QUOTE_FIELD_PROMPT = {
  client_name: "✏️ מה שם הלקוח?",
  address: "✏️ מה הכתובת?",
  description: "✏️ שלחו את תיאור העבודה מחדש. כל שורה בהודעה תהיה שורה בהצעה.",
  total: "✏️ מה המחיר הסופי? (מספר, למשל 4500)",
  quote_date: "✏️ מה התאריך? (למשל 27.10.2026)",
  voice: "🎤 הקליטו או כתבו מה לתקן, למשל: \"תשנה את השטח ל-50 מטר\"."
};
var QUOTE_ASK_TEXT =
  "🧾 בואו נכין הצעת מחיר.\n" +
  "שלחו הודעה קולית 🎤 או הודעה כתובה עם:\n" +
  "• שם הלקוח\n• הכתובת\n• מה העבודה\n• המחיר הסופי";
var AI_ERROR_TEXT = {
  ai_busy: "המערכת עמוסה כרגע 🙏 נסו שוב בעוד כמה דקות, או הכינו את ההצעה בלוח הבקרה.",
  ai_failed: "משהו השתבש בעיבוד ההודעה. נסו לשלוח שוב, או הכינו את ההצעה בלוח הבקרה.",
  invalid_input: "לא הצלחתי לקרוא את ההודעה. נסו הקלטה קצרה יותר או הודעה כתובה.",
  empty_input: "ההודעה ריקה. שלחו את פרטי העבודה בהקלטה או בטקסט."
};

// "תכין לי הצעת מחיר" carries no job details: words like these are removed, and if almost
// nothing is left (no digits, < 6 letters), the message is a trigger only.
var TRIGGER_WORDS = ["תכין", "תכיני", "תכינו", "להכין", "הכן", "הכיני", "נכין", "תעשה", "תעשי", "לעשות", "תוציא", "תוציאי",
  "להוציא", "תפיק", "להפיק", "אני", "רוצה", "צריך", "צריכה", "צריכים", "אפשר", "בבקשה", "לי", "לנו", "נא", "הצעת", "מחיר",
  "הצעה", "הצעות", "חדשה", "בוא", "בואי", "שלום", "היי", "הי", "עוד", "אחת"];

function isTriggerOnly(text) {
  if (/\d/.test(text)) return false;
  var words = (text.match(/[א-ת]+/g) || []).filter(function (w) {
    if (TRIGGER_WORDS.indexOf(w) !== -1) return false;
    return !(w.length > 2 && "והלשב".indexOf(w[0]) !== -1 && TRIGGER_WORDS.indexOf(w.slice(1)) !== -1);
  });
  return words.join("").length < 6;
}

function quoteInputFromMessage(msg) {
  var a = msg.voice || msg.audio;
  if (a) return { kind: "voice", file_id: a.file_id, mime: a.mime_type || "audio/ogg", duration: a.duration || 0, file_size: a.file_size || 0 };
  var text = typeof msg.text === "string" ? msg.text.trim() : "";
  return text ? { kind: "text", text: text } : null;
}

// Voice limits, checked before any quota or download. Returns an error text or null.
function voiceLimitError(input) {
  if (input.kind !== "voice") return null;
  if (input.duration > MAX_VOICE_SECONDS) return "ההקלטה ארוכה מ-3 דקות. נסו הקלטה קצרה יותר 🙂";
  if (input.file_size > MAX_VOICE_BYTES) return "הקובץ גדול מדי (מעל 15MB). נסו הקלטה קצרה יותר.";
  return null;
}

// Audio into memory only (never stored, never logged). Throws QuoteExtractError-like codes.
async function downloadVoice(input) {
  var info = await tgCall("getFile", { file_id: input.file_id });
  if (info.file_size && info.file_size > MAX_VOICE_BYTES) throw new QX.QuoteExtractError("invalid_input", "audio too large");
  var buf = await tgDownloadFile(info.file_path);
  return { audio: buf, mimeType: input.mime };
}

async function messageForExtract(input) {
  return input.kind === "voice" ? downloadVoice(input) : { text: input.text };
}

// --- chat state (collecting_quote / quote_conflict), fresh for AWAITING_EDIT_TTL_MS ---

async function setChatState(chatId, state, context) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/telegram_chat_state?on_conflict=chat_id", {
    method: "POST",
    headers: Object.assign({ Prefer: "resolution=merge-duplicates,return=minimal" }, supabaseHeaders()),
    body: JSON.stringify({ chat_id: chatId, state: state, state_since: new Date().toISOString(), context: context || {} })
  });
  if (!res.ok) throw new Error("chat state upsert failed: " + res.status);
}

async function getChatState(chatId) {
  try {
    var row = await supabaseSelectOne("telegram_chat_state", "chat_id=eq." + chatId);
    if (!row || Date.now() - new Date(row.state_since).getTime() > AWAITING_EDIT_TTL_MS) return null;
    return row;
  } catch (err) {
    console.error("[telegram-webhook] chat state lookup failed: " + err.message);
    return null;
  }
}

function clearChatState(chatId) {
  return supabaseDelete("telegram_chat_state", "chat_id=eq." + chatId).catch(function (err) {
    console.error("[telegram-webhook] chat state clear failed: " + err.message);
  });
}

// --- drafts ---

async function findActiveDraft(chatId) {
  return supabaseSelectOne("telegram_pending_quotes", "chat_id=eq." + chatId + "&order=created_at.desc&limit=1");
}

async function loadDraftRow(id) {
  return supabaseSelectOne("telegram_pending_quotes", "id=eq." + encodeURIComponent(id));
}

function fmtShekel(n) {
  return Number(n).toLocaleString("he-IL", { maximumFractionDigits: 2 }) + " ₪";
}

// Re-derives everything that depends on the fields: description text, one-page fit
// (estimateDescriptionFits), missing fields and the warnings shown on the draft. Code only.
function recomputeDraft(d) {
  d.description_lines = d.description_lines || [];
  d.description = d.description_lines.join("\n");
  var est = estimateDescriptionFits(d.description);
  d.fit = { lines: est.lines, maxLines: est.maxLines, fits: est.fits };
  var items = d.items || [];
  var priced = items.filter(function (it) { return it.line_total != null; });
  d.items_sum = priced.length ? Math.round(priced.reduce(function (s, it) { return s + it.line_total; }, 0) * 100) / 100 : null;
  d.warnings = [];
  if (d.total != null && items.length && priced.length === items.length && Math.abs(d.items_sum - d.total) > 0.5) {
    d.warnings.push({ code: "sum_mismatch", items_sum: d.items_sum, total: d.total });
  }
  if (!est.fits) d.warnings.push({ code: "too_long", lines: est.lines, maxLines: est.maxLines });
  d.missing = [];
  if (!d.client_name) d.missing.push("client_name");
  if (!d.address) d.missing.push("address");
  if (!d.description) d.missing.push("description");
  if (d.total == null) d.missing.push("total");
  return d;
}

// ✅ needs a total, a client name (quotes.client_name is NOT NULL) and a description that fits.
function draftReady(d) {
  return d.total != null && d.total > 0 && !!d.client_name && !!(d.fit && d.fit.fits);
}

function renderDraft(row, footer) {
  var d = row.draft;
  var lines = [
    "🧾 טיוטת הצעת מחיר",
    "(מספר ההצעה ייקבע באישור)",
    "",
    "📅 תאריך: " + (d.quote_date || QX.todayIL()),
    "👤 לקוח: " + (d.client_name || "❗ חסר שם לקוח"),
    "📍 כתובת: " + (d.address || "—"),
    "",
    "📋 תיאור העבודה:",
    d.description || "—",
    "",
    d.total != null ? "💰 סה״כ לתשלום: " + fmtShekel(d.total) : "❗ חסר מחיר — מה המחיר הסופי?"
  ];
  (d.warnings || []).forEach(function (w) {
    if (w.code === "sum_mismatch") lines.push("⚠️ סכום הפריטים (" + fmtShekel(w.items_sum) + ") שונה מהמחיר הסופי (" + fmtShekel(w.total) + "). יודפס המחיר הסופי.");
    if (w.code === "too_long") lines.push("⚠️ התיאור ארוך מדי לעמוד אחד (" + w.lines + " שורות, עד " + w.maxLines + "). אפשר ✂️ לקצר אוטומטית או ✏️ לערוך.");
  });
  if (d.input_kind === "voice" && d.transcript) {
    var t = d.transcript.length > TRANSCRIPT_PREVIEW_CHARS ? d.transcript.slice(0, TRANSCRIPT_PREVIEW_CHARS) + "…" : d.transcript;
    lines.push("", "📝 מה הבנתי: " + t);
  }
  if (footer) lines.push("", footer);
  var text = lines.join("\n");
  if (text.length > 4000) text = text.slice(0, 3999) + "…"; // Telegram's 4096-char message limit

  var id = row.id;
  var kb = [];
  if (draftReady(d)) kb.push([{ text: "✅ אשר והפק PDF", callback_data: "q:ok:" + id }]);
  kb.push([{ text: "✏️ לקוח", callback_data: "q:client:" + id }, { text: "✏️ כתובת", callback_data: "q:addr:" + id }, { text: "✏️ תיאור", callback_data: "q:desc:" + id }]);
  kb.push([{ text: "✏️ סכום", callback_data: "q:total:" + id }, { text: "✏️ תאריך", callback_data: "q:date:" + id }]);
  var extra = [];
  if ((row.voice_corrections || 0) < LIMITS.voiceCorrections) extra.push({ text: "🎤 תיקון בהקלטה", callback_data: "q:voice:" + id });
  if (d.fit && !d.fit.fits) extra.push({ text: "✂️ לקצר אוטומטית", callback_data: "q:short:" + id });
  if (extra.length) kb.push(extra);
  kb.push([{ text: "❌ ביטול", callback_data: "q:cancel:" + id }]);
  return { text: text, keyboard: { inline_keyboard: kb } };
}

// Shows the draft in its message (edit in place); if that fails (e.g. the message is gone),
// sends it as a new message and remembers the new message_id.
async function showDraft(row, chatId, footer) {
  var view = renderDraft(row, footer);
  if (row.message_id) {
    var edited = await tgCallSafe("editMessageText", { chat_id: chatId, message_id: row.message_id, text: view.text, reply_markup: view.keyboard });
    if (edited) return;
  }
  var sentMsg = await tgCallSafe("sendMessage", { chat_id: chatId, text: view.text, reply_markup: view.keyboard });
  if (sentMsg && sentMsg.message_id) {
    row.message_id = sentMsg.message_id;
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { message_id: sentMsg.message_id })
      .catch(function (err) { console.error("[telegram-webhook] draft message_id patch failed: " + err.message); });
  }
}

// A missing total puts the draft straight into "waiting for the total".
function awaitingPatchFor(d) {
  return d.total == null
    ? { awaiting_edit_field: "total", awaiting_since: new Date().toISOString() }
    : { awaiting_edit_field: null, awaiting_since: null };
}

// --- follow-up messages while a draft is OPEN (Phase 6b) ---
// Open = not yet approved: no quote created and not claimed by an approve in progress.
async function findOpenDraft(chatId) {
  try {
    var row = await findActiveDraft(chatId);
    if (!row || row.quote_id) return null;
    if (row.claimed_at && Date.now() - new Date(row.claimed_at).getTime() < QUOTE_CLAIM_LEASE_MS) return null;
    return row;
  } catch (err) {
    console.error("[telegram-webhook] open draft lookup failed: " + err.message);
    return null;
  }
}

// A message that is only an amount ("4200", "4,200 ₪", "ארבעת אלפים") = the new final price. Code only.
async function updateDraftTotal(row, text, chatId) {
  var n = parseQuoteTotal(text);
  if (n == null) { await tgCallSafe("sendMessage", { chat_id: chatId, text: EDIT_RETRY_TEXT.total }); return; }
  var d = row.draft;
  d.total = n;
  d.total_source = "manual";
  recomputeDraft(d);
  try {
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), Object.assign({ draft: d }, awaitingPatchFor(d)));
  } catch (err) {
    console.error("[telegram-webhook] draft total patch failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בעדכון. נסו שוב." });
    return;
  }
  await showDraft(row, chatId, null);
  await tgCallSafe("sendMessage", { chat_id: chatId, text: "✏️ הסכום עודכן ל-" + fmtShekel(n) });
}

// Any other text/voice: ask what to do with it. The message is parked in chat state (text, or the
// voice note's Telegram file_id; never the audio) until a button is tapped.
async function askDraftFollowup(row, input, chatId) {
  try { await setChatState(chatId, "draft_followup", { input: input, draft_id: row.id }); } catch (err) {
    console.error("[telegram-webhook] " + err.message);
  }
  var canCorrect = (row.voice_corrections || 0) < LIMITS.voiceCorrections;
  var buttons = [];
  if (canCorrect) buttons.push({ text: "✏️ לתקן את הטיוטה", callback_data: "q:fix:" + row.id });
  buttons.push({ text: "🧾 הצעה חדשה", callback_data: "q:new:" + row.id });
  buttons.push({ text: "✖️ התעלם", callback_data: "q:skip:" + row.id });
  await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: "יש טיוטה פתוחה" + (row.draft && row.draft.client_name ? " (" + row.draft.client_name + ")" : "") + ". לעדכן אותה?" +
      (canCorrect ? "" : "\n(נגמרו " + LIMITS.voiceCorrections + " התיקונים להצעה הזו. אפשר לערוך בכפתורי ✏️ שבטיוטה.)"),
    reply_markup: { inline_keyboard: [buttons] }
  });
}

// Entry point for 🧾 / /quote / keyword text / voice. input = null for a bare trigger.
async function startQuote(chatId, input) {
  var existing = null;
  try { existing = await findActiveDraft(chatId); } catch (err) {
    console.error("[telegram-webhook] active draft lookup failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית. נסו שוב בעוד רגע." });
    return;
  }
  if (existing) {
    try { await setChatState(chatId, "quote_conflict", { input: input, draft_id: existing.id }); } catch (err) {
      console.error("[telegram-webhook] " + err.message);
    }
    await tgCallSafe("sendMessage", {
      chat_id: chatId,
      text: "יש כבר טיוטת הצעת מחיר פתוחה" + (existing.draft && existing.draft.client_name ? " (" + existing.draft.client_name + ")" : "") + ".\nמה לעשות?",
      reply_markup: { inline_keyboard: [[
        { text: "↩️ להמשיך בטיוטה", callback_data: "q:cont:" + existing.id },
        { text: "🆕 להתחיל הצעה חדשה", callback_data: "q:new:" + existing.id }
      ]] }
    });
    return;
  }
  if (!input) {
    try { await setChatState(chatId, "collecting_quote", {}); } catch (err) { console.error("[telegram-webhook] " + err.message); }
    await tgCallSafe("sendMessage", { chat_id: chatId, text: QUOTE_ASK_TEXT, reply_markup: MAIN_KEYBOARD });
    return;
  }
  await createDraftFrom(chatId, input);
}

async function createDraftFrom(chatId, input) {
  var limitErr = voiceLimitError(input);
  if (limitErr) { await tgCallSafe("sendMessage", { chat_id: chatId, text: limitErr }); return; }

  // One unit of the daily quote quota per NEW quote (corrections and edits are free).
  var quota;
  try { quota = await consumeQuota("quote"); } catch (err) {
    console.error("[telegram-webhook] quote quota check failed: " + err.code);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית. נסו שוב בעוד רגע." });
    return;
  }
  if (!quota.ok) {
    await tgCallSafe("sendMessage", {
      chat_id: chatId,
      text: "הגענו למכסת הצעות המחיר להיום (" + LIMITS.quote + ") 🙂\nאפשר להמשיך מחר, או להכין את ההצעה בלוח הבקרה."
    });
    return;
  }

  var wait = await tgCallSafe("sendMessage", { chat_id: chatId, text: "⏳ מעבד…" });
  var waitId = wait && wait.message_id;
  async function say(text) {
    if (waitId) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: waitId, text: text });
    else await tgCallSafe("sendMessage", { chat_id: chatId, text: text });
  }

  var draft;
  try {
    draft = await QX.extractQuote(await messageForExtract(input), { todayIL: QX.todayIL() });
  } catch (err) {
    var code = err && err.code && AI_ERROR_TEXT[err.code] ? err.code : "ai_failed";
    if (!(err && err.code)) console.error("[telegram-webhook] quote extraction failed: " + err.message);
    await say(AI_ERROR_TEXT[code]);
    return;
  }

  if ((draft.warnings || []).some(function (w) { return w.code === "no_quote_content"; })) {
    try { await setChatState(chatId, "collecting_quote", {}); } catch (err) { console.error("[telegram-webhook] " + err.message); }
    await say("לא מצאתי בהודעה פרטים של עבודה 🙂\n" + QUOTE_ASK_TEXT.split("\n").slice(1).join("\n"));
    return;
  }

  draft.input_kind = input.kind;
  recomputeDraft(draft);
  var row;
  try {
    row = await supabaseInsert("telegram_pending_quotes", Object.assign({ chat_id: chatId, draft: draft, message_id: waitId || null }, awaitingPatchFor(draft)));
  } catch (err) {
    console.error("[telegram-webhook] draft insert failed: " + err.message);
    await say("שגיאה בשמירת הטיוטה. נסו שוב.");
    return;
  }
  await showDraft(row, chatId, "📊 נותרו היום: " + quota.remaining + " הצעות מחיר");
}

// Code-only parsers for the ✏️ replies.
function parseQuoteDate(text) {
  var t = String(text || "").trim();
  if (t === "היום") return QX.todayIL();
  var y, mo, d, m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/))) { d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; }
  else return null;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2020 || y > 2100) return null;
  return pad2(d) + "." + pad2(mo) + "." + y;
}

function parseQuoteTotal(text) {
  var n = QX.parseAmount(text);
  if (n == null || !isFinite(n) || n <= 0 || n >= 1000000) return null;
  return Math.round(n * 100) / 100;
}

// Manual edits: phones are dropped entirely (no placeholder inside a name or address).
function cleanLine(s, max) {
  var v = QX.stripPhones(String(s || "")).replace(/\[מספר הוסר\]/g, "").replace(/[\s,]+$/, "").replace(/\s+/g, " ").trim();
  return v.length > max ? v.slice(0, max) : v;
}

// Applies one ✏️ reply to the draft (mutates d). Returns false when the reply isn't usable.
function applyFieldEdit(d, field, text) {
  if (field === "client_name" || field === "address") {
    var v = cleanLine(text, field === "client_name" ? 120 : 200);
    if (!v) return false;
    d[field] = v;
    return true;
  }
  if (field === "description") {
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return cleanLine(l, 200); }).filter(Boolean).slice(0, 20);
    if (!lines.length) return false;
    d.description_lines = lines;
    return true;
  }
  if (field === "total") {
    var n = parseQuoteTotal(text);
    if (n == null) return false;
    d.total = n;
    d.total_source = "manual";
    return true;
  }
  if (field === "quote_date") {
    var dt = parseQuoteDate(text);
    if (!dt) return false;
    d.quote_date = dt;
    d.quote_date_stated = true;
    return true;
  }
  return false;
}

var EDIT_RETRY_TEXT = {
  client_name: "לא קיבלתי שם. שלחו את שם הלקוח.",
  address: "לא קיבלתי כתובת. שלחו את הכתובת.",
  description: "לא קיבלתי תיאור. שלחו את תיאור העבודה.",
  total: "לא הבנתי את הסכום. שלחו מספר, למשל 4500.",
  quote_date: "לא הבנתי את התאריך. שלחו למשל 27.10.2026."
};

// The reply to a ✏️ prompt or a 🎤 correction. awaiting = { id, awaiting_edit_field }.
async function processQuoteEditReply(awaiting, msg, chatId) {
  var row;
  try { row = await loadDraftRow(awaiting.id); } catch (err) {
    console.error("[telegram-webhook] draft lookup failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית. נסו שוב בעוד רגע." });
    return;
  }
  if (!row) return;
  var field = row.awaiting_edit_field;

  if (field === "voice") return processQuoteCorrection(row, quoteInputFromMessage(msg), chatId);

  var text = typeof msg.text === "string" ? msg.text.trim() : "";
  var d = row.draft;
  if (!text || !applyFieldEdit(d, field, text)) {
    await tgCallSafe("sendMessage", { chat_id: chatId, text: EDIT_RETRY_TEXT[field] || "נסו שוב." });
    return; // still awaiting the same field
  }
  recomputeDraft(d);
  try {
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), Object.assign({ draft: d }, awaitingPatchFor(d)));
  } catch (err) {
    console.error("[telegram-webhook] draft edit patch failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בעדכון. נסו שוב." });
    return;
  }
  await showDraft(row, chatId, "✏️ עודכן: " + QUOTE_FIELD_LABEL[field]);
}

// input = { kind: "text", text } | { kind: "voice", file_id, … } (a voice note is re-downloaded by file_id).
async function processQuoteCorrection(row, input, chatId) {
  var used = row.voice_corrections || 0;
  if (used >= LIMITS.voiceCorrections) {
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { awaiting_edit_field: null, awaiting_since: null }).catch(function () {});
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "כבר השתמשנו ב-" + LIMITS.voiceCorrections + " תיקונים להצעה הזו. אפשר לערוך עם כפתורי ✏️." });
    return;
  }
  if (!input) { await tgCallSafe("sendMessage", { chat_id: chatId, text: QUOTE_FIELD_PROMPT.voice }); return; }
  var limitErr = voiceLimitError(input);
  if (limitErr) { await tgCallSafe("sendMessage", { chat_id: chatId, text: limitErr }); return; }

  // The corrected draft goes into a NEW message at the bottom of the chat; the old one loses its buttons.
  var wait = await tgCallSafe("sendMessage", { chat_id: chatId, text: "⏳ מעבד את התיקון…" });
  var updated;
  try {
    updated = await QX.applyCorrection(row.draft, await messageForExtract(input));
  } catch (err) {
    var code = err && err.code && AI_ERROR_TEXT[err.code] ? err.code : "ai_failed";
    if (!(err && err.code)) console.error("[telegram-webhook] quote correction failed: " + err.message);
    var t = AI_ERROR_TEXT[code];
    if (wait && wait.message_id) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: wait.message_id, text: t });
    else await tgCallSafe("sendMessage", { chat_id: chatId, text: t });
    return; // still awaiting the correction
  }
  updated.input_kind = input.kind === "voice" ? "voice" : row.draft.input_kind;
  recomputeDraft(updated);
  var oldMessageId = row.message_id;
  var patch = Object.assign({ draft: updated, voice_corrections: used + 1, message_id: (wait && wait.message_id) || oldMessageId }, awaitingPatchFor(updated));
  try {
    // Optimistic: only if no other correction landed meanwhile (the DB also caps it at 3).
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id) + "&voice_corrections=eq." + used, patch);
  } catch (err) {
    console.error("[telegram-webhook] correction patch failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה בעדכון. נסו שוב." });
    return;
  }
  Object.assign(row, patch);
  if (oldMessageId && oldMessageId !== row.message_id) {
    await tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: oldMessageId, reply_markup: { inline_keyboard: [] } });
  }
  await showDraft(row, chatId, "🎤 עודכן לפי התיקון (" + (used + 1) + "/" + LIMITS.voiceCorrections + ")");
}

var QUOTE_CLAIM_LEASE_MS = 2 * 60 * 1000;

async function claimDraftRow(id) {
  var cutoffIso = new Date(Date.now() - QUOTE_CLAIM_LEASE_MS).toISOString();
  var res = await fetch(SUPABASE_URL + "/rest/v1/telegram_pending_quotes?id=eq." + encodeURIComponent(id) +
    "&or=(claimed_at.is.null,claimed_at.lt." + encodeURIComponent(cutoffIso) + ")", {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=representation" }, supabaseHeaders()),
    body: JSON.stringify({ claimed_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("draft claim failed: " + res.status);
  var rows = await res.json();
  return rows[0] || null;
}

function releaseDraftClaim(id) {
  return supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(id), { claimed_at: null })
    .catch(function (err) { console.error("[telegram-webhook] draft claim release failed: " + err.message); });
}

// ---------------------------------------------------------------------------
// Approve → number → PDF → send (Phase 5d)
// ---------------------------------------------------------------------------
// The PDF is rendered by api/render-quote-pdf.js over HTTP (X-Internal-Secret), not by loading
// it here: Chromium stays out of this function's bundle, rendering gets its own 60 s budget,
// and the render function already stores quotes-pdf/<id>.pdf and sets pdf_path trigger-safely.

function pad3(n) { return String(n).padStart(3, "0"); }

function quoteCaption(q) {
  return "הצעת מחיר מס׳ " + pad3(q.number) + " · " + (q.client_name || "") + " · " + fmtShekel(q.total);
}

// create_quote(jsonb) with the service key: numbering, source='telegram', chat id (bot-only keys).
async function createQuoteRpc(d, chatId) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/create_quote", {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ p: {
      client_name: d.client_name,
      address: d.address || null,
      description: (d.description_lines || []).join("\n"),
      total: d.total,
      quote_date: d.quote_date || QX.todayIL(),
      vat_mode: "exempt",
      source: "telegram",
      telegram_chat_id: chatId
    } })
  });
  var data = await res.json().catch(function () { return null; });
  if (!res.ok) throw new Error("create_quote failed: " + res.status + (data && data.code ? " " + data.code : ""));
  var row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id) throw new Error("create_quote returned no row");
  return row;
}

async function loadQuote(id) {
  return supabaseSelectOne("quotes", "id=eq." + encodeURIComponent(id)); // full row: number, client, total, pdf_path…
}

// -> { ok:true, pdf } | { ok:false, tooLong:true, lines, maxLines } | { ok:false, status }
async function renderQuotePdf(quoteId) {
  var env = process.env;
  var host = env.VERCEL_ENV === "production" ? (env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL) : env.VERCEL_URL;
  if (!host || !env.INTERNAL_API_SECRET) {
    console.error("[telegram-webhook] render: missing VERCEL_URL / INTERNAL_API_SECRET");
    return { ok: false, status: 0 };
  }
  var headers = { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_API_SECRET };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  var res;
  try {
    res = await fetch("https://" + host + "/api/render-quote-pdf", {
      method: "POST", headers: headers, body: JSON.stringify({ quote_id: quoteId }), redirect: "manual",
      signal: AbortSignal.timeout(55000)
    });
  } catch (err) {
    console.error("[telegram-webhook] render request failed");
    return { ok: false, status: 0 };
  }
  if (res.status === 200) return { ok: true, pdf: Buffer.from(await res.arrayBuffer()) };
  if (res.status === 422) {
    var j = await res.json().catch(function () { return {}; });
    return { ok: false, tooLong: true, lines: j.lines, maxLines: j.maxLines };
  }
  console.error("[telegram-webhook] render HTTP " + res.status);
  return { ok: false, status: res.status };
}

async function downloadStoredPdf(objectPath) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/quotes-pdf/" + objectPath, { headers: { apikey: key, Authorization: "Bearer " + key } });
  if (!res.ok) throw new Error("stored PDF download failed: " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Multipart sendDocument (the PDF never touches disk).
async function tgSendDocument(chatId, pdf, filename, caption) {
  var form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("document", new Blob([pdf], { type: "application/pdf" }), filename);
  var res = await fetch(TELEGRAM_API_ROOT + telegramConfig().botToken + "/sendDocument", { method: "POST", body: form });
  var data = await res.json().catch(function () { return {}; });
  if (!data.ok) throw new Error("Telegram API sendDocument failed: " + (data.description || res.status));
  return data.result;
}

// Renders (or reuses the stored PDF when allowed) and sends it. -> same shape as renderQuotePdf.
async function deliverQuotePdf(chatId, quote, useStored) {
  var pdf = null;
  if (useStored && quote.pdf_path) {
    try { pdf = await downloadStoredPdf(quote.pdf_path); } catch (err) { console.error("[telegram-webhook] " + err.message + " (re-rendering)"); }
  }
  if (!pdf) {
    await tgCallSafe("sendChatAction", { chat_id: chatId, action: "upload_document" });
    var r = await renderQuotePdf(quote.id);
    if (!r.ok) return r;
    pdf = r.pdf;
  }
  try {
    await tgSendDocument(chatId, pdf, "הצעת-מחיר-" + pad3(quote.number) + ".pdf", quoteCaption(quote));
  } catch (err) {
    console.error("[telegram-webhook] " + err.message);
    return { ok: false, status: "send" };
  }
  return { ok: true };
}

// After ✅ (row is claimed): create the quote ONCE (quote_id on the draft guards against a second
// one), then PDF + send. On a PDF/send failure the quote is kept and the draft offers 🔄 / ✂️.
async function finishApprovedQuote(row, chatId) {
  var d = row.draft;
  var say = function (text, keyboard) {
    var p = { chat_id: chatId, message_id: row.message_id, text: text };
    if (keyboard) p.reply_markup = keyboard;
    return row.message_id ? tgCallSafe("editMessageText", p) : tgCallSafe("sendMessage", { chat_id: chatId, text: text, reply_markup: keyboard });
  };
  var quote;
  if (!row.quote_id) {
    await say("⏳ יוצר את ההצעה…");
    try {
      quote = await createQuoteRpc(d, chatId);
    } catch (err) {
      console.error("[telegram-webhook] " + err.message);
      await releaseDraftClaim(row.id);
      await showDraft(row, chatId, "❗ שגיאה ביצירת ההצעה. נסו ✅ שוב.");
      return;
    }
    d.quote_number = quote.number;
    row.quote_id = quote.id;
    try {
      await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { quote_id: quote.id, draft: d });
    } catch (err) {
      // The quote exists; keep going. (A retry would only be blocked by quote_id, so log it.)
      console.error("[telegram-webhook] draft quote_id patch failed: " + err.message);
    }
  } else {
    try { quote = await loadQuote(row.quote_id); } catch (err) { quote = null; }
    if (!quote) {
      await releaseDraftClaim(row.id);
      await say("❗ לא מצאתי את ההצעה השמורה. אפשר לחפש אותה ב-🔍 או בלוח הבקרה.");
      return;
    }
  }

  await say("⏳ מפיק PDF להצעה מס׳ " + pad3(quote.number) + "…");
  var result = await deliverQuotePdf(chatId, quote, false);
  if (result.ok) {
    await say("✅ הצעה מס׳ " + pad3(quote.number) + " נשלחה");
    await supabaseDelete("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id)) // transcript gone with it
      .catch(function (err) { console.error("[telegram-webhook] draft delete failed: " + err.message); });
    return;
  }
  await releaseDraftClaim(row.id);
  if (result.tooLong) {
    await say("ההצעה נשמרה (מס׳ " + pad3(quote.number) + ") אבל התיאור ארוך מדי לעמוד אחד (" + result.lines + " שורות, עד " + result.maxLines + ").",
      { inline_keyboard: [[{ text: "✂️ לקצר ולהפיק מחדש", callback_data: "q:short:" + row.id }], [{ text: "🔄 לנסות שוב", callback_data: "q:retry:" + row.id }]] });
    return;
  }
  await say("ההצעה נשמרה (מס׳ " + pad3(quote.number) + ") אבל ה-PDF נכשל.",
    { inline_keyboard: [[{ text: "🔄 לנסות שוב", callback_data: "q:retry:" + row.id }]] });
}

// --- 📜 recent / 🔍 search ---

var QUOTE_LIST_COLUMNS = "id,number,client_name,total,quote_date,source";

async function sendQuoteList(chatId, title, rows) {
  var lines = rows.map(function (q) {
    return "מס׳ " + pad3(q.number) + " · " + (q.client_name || "—") + " · " + fmtShekel(q.total) + " · " + (q.quote_date || "") +
      " · " + (q.source === "telegram" ? "📱 טלגרם" : "💻 פאנל");
  });
  await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: title + "\n\n" + lines.join("\n"),
    reply_markup: { inline_keyboard: rows.map(function (q) { return [{ text: "📄 שלח PDF מס׳ " + pad3(q.number), callback_data: "q:pdf:" + q.id }]; }) }
  });
}

async function sendRecentQuotes(chatId) {
  var rows;
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/quotes?select=" + QUOTE_LIST_COLUMNS + "&order=number.desc&limit=5", { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("HTTP " + res.status);
    rows = await res.json();
  } catch (err) {
    console.error("[telegram-webhook] recent quotes query failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית בטעינת ההצעות. נסו שוב בעוד רגע." });
    return;
  }
  if (!rows.length) { await tgCallSafe("sendMessage", { chat_id: chatId, text: "עדיין אין הצעות מחיר.", reply_markup: MAIN_KEYBOARD }); return; }
  await sendQuoteList(chatId, "📜 ההצעות האחרונות:", rows);
}

async function askSearch(chatId) {
  try { await setChatState(chatId, "awaiting_search", {}); } catch (err) { console.error("[telegram-webhook] " + err.message); }
  await tgCallSafe("sendMessage", { chat_id: chatId, text: "🔍 שלחו את שם הלקוח (או חלק ממנו).", reply_markup: MAIN_KEYBOARD });
}

// ilike pattern from user text: PostgREST's * wildcard is removed from the input, and LIKE's own
// wildcards/escape (% _ \) are escaped, so the name is matched literally.
function ilikeContains(term) {
  return "*" + term.replace(/\*/g, "").replace(/[\\%_]/g, function (c) { return "\\" + c; }) + "*";
}

async function searchQuotes(chatId, text) {
  var term = String(text || "").replace(/\*/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (term.length < 2) {
    try { await setChatState(chatId, "awaiting_search", {}); } catch (e) { /* best-effort */ }
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שלחו לפחות 2 אותיות משם הלקוח." });
    return;
  }
  var rows;
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/quotes?select=" + QUOTE_LIST_COLUMNS + "&client_name=ilike." +
      encodeURIComponent(ilikeContains(term)) + "&order=number.desc&limit=5", { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("HTTP " + res.status);
    rows = await res.json();
  } catch (err) {
    console.error("[telegram-webhook] quote search failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית בחיפוש. נסו שוב בעוד רגע." });
    return;
  }
  if (!rows.length) { await tgCallSafe("sendMessage", { chat_id: chatId, text: "לא נמצאו הצעות 🙂", reply_markup: MAIN_KEYBOARD }); return; }
  await sendQuoteList(chatId, "🔍 תוצאות החיפוש:", rows);
}

// 📄 from a list: the stored PDF when there is one, otherwise render → send.
async function resendQuotePdf(chatId, quoteId) {
  var quote;
  try { quote = await loadQuote(quoteId); } catch (err) {
    console.error("[telegram-webhook] quote lookup failed: " + err.message);
    await cbNotice(chatId, "שגיאה זמנית. נסו שוב.");
    return;
  }
  if (!quote) { await cbNotice(chatId, "ההצעה לא נמצאה."); return; }
  var r = await deliverQuotePdf(chatId, quote, true);
  if (r.ok) return;
  if (r.tooLong) { await cbNotice(chatId, "לא ניתן להפיק PDF להצעה מס׳ " + pad3(quote.number) + ": התיאור ארוך מדי לעמוד אחד. אפשר לקצר אותו בלוח הבקרה."); return; }
  await cbNotice(chatId, "שליחת ה-PDF של הצעה מס׳ " + pad3(quote.number) + " נכשלה. נסו שוב בעוד רגע.");
}

// callback_data "q:<action>:<draft uuid>" (≤ 64 bytes: "q:client:" + 36).
async function processQuoteCallback(query, chatId) {
  var parts = String(query.data || "").split(":");
  var action = parts[1];
  var id = parts[2] || "";
  var tappedMessageId = query.message && query.message.message_id;

  if (action === "pdf") { await resendQuotePdf(chatId, id); return; }

  var row;
  try { row = id ? await loadDraftRow(id) : null; } catch (err) {
    console.error("[telegram-webhook] draft lookup failed: " + err.message);
    await cbNotice(chatId, "שגיאה זמנית. נסו שוב.");
    return;
  }

  if (action === "cont" || action === "new") {
    var state = await getChatState(chatId);
    await clearChatState(chatId);
    if (action === "cont") {
      if (!row || String(row.chat_id) !== String(chatId)) { await startQuote(chatId, null); return; }
      row.message_id = null; // re-show at the bottom of the chat
      await showDraft(row, chatId, null);
      return;
    }
    if (row && String(row.chat_id) === String(chatId)) {
      await supabaseDelete("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id)).catch(function (err) {
        console.error("[telegram-webhook] draft delete failed: " + err.message);
      });
      if (row.message_id) await tgCallSafe("editMessageText", { chat_id: chatId, message_id: row.message_id, text: "🧾 הטיוטה הקודמת בוטלה." });
    }
    var input = state && (state.state === "quote_conflict" || state.state === "draft_followup") && state.context ? state.context.input : null;
    if (input) await createDraftFrom(chatId, input);
    else await startQuote(chatId, null);
    return;
  }

  if (!row || String(row.chat_id) !== String(chatId)) {
    await cbNotice(chatId, "ההצעה הזו כבר טופלה או בוטלה.");
    if (tappedMessageId) await tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: tappedMessageId, reply_markup: { inline_keyboard: [] } });
    return;
  }
  var d = row.draft;

  if (action === "cancel") {
    await supabaseDelete("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id)); // the transcript goes with it
    await clearChatState(chatId);
    await tgCallSafe("editMessageText", { chat_id: chatId, message_id: tappedMessageId || row.message_id,
      text: row.quote_id ? "ההצעה מס׳ " + pad3(d.quote_number) + " נשמרה. אפשר לשלוח את ה-PDF מ-📜 הצעות אחרונות." : "🧾 טיוטת הצעת המחיר בוטלה." });
    return;
  }

  // Once the quote exists (number taken), only 🔄 retry / ✂️ shorten / ❌ make sense for this draft.
  if (row.quote_id && action !== "retry" && action !== "short" && action !== "ok") {
    await cbNotice(chatId, "ההצעה כבר נשמרה (מס׳ " + pad3(d.quote_number) + "). אפשר ✂️ לקצר או 🔄 לנסות שוב, ולשנות פרטים בלוח הבקרה.");
    return;
  }

  if (action === "fix" || action === "skip") {
    var fstate = await getChatState(chatId);
    var parked = fstate && fstate.state === "draft_followup" && fstate.context && fstate.context.draft_id === row.id ? fstate.context.input : null;
    await clearChatState(chatId);
    if (tappedMessageId) await tgCallSafe("editMessageReplyMarkup", { chat_id: chatId, message_id: tappedMessageId, reply_markup: { inline_keyboard: [] } });
    if (action === "skip") {
      await tgCallSafe("sendMessage", { chat_id: chatId, text: "בסדר, הטיוטה נשארה כמו שהיא." });
      return;
    }
    if (!parked) { await cbNotice(chatId, "ההודעה כבר לא זמינה. שלחו אותה שוב."); return; }
    await processQuoteCorrection(row, parked, chatId); // counts toward the 3-correction cap
    return;
  }

  if (QUOTE_FIELD_BY_ACTION[action]) {
    var field = QUOTE_FIELD_BY_ACTION[action];
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { awaiting_edit_field: field, awaiting_since: new Date().toISOString() });
    var prompt = QUOTE_FIELD_PROMPT[field];
    if (field === "description" && d.description) prompt += "\n\nהתיאור הנוכחי:\n" + d.description;
    await tgCallSafe("sendMessage", { chat_id: chatId, text: prompt });
    return;
  }

  if (action === "voice") {
    if ((row.voice_corrections || 0) >= LIMITS.voiceCorrections) {
      await cbNotice(chatId, "כבר השתמשנו ב-" + LIMITS.voiceCorrections + " תיקונים להצעה הזו. אפשר לערוך עם כפתורי ✏️.");
      return;
    }
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { awaiting_edit_field: "voice", awaiting_since: new Date().toISOString() });
    await tgCallSafe("sendMessage", { chat_id: chatId, text: QUOTE_FIELD_PROMPT.voice });
    return;
  }

  if (action === "short" && row.quote_id) {
    var lockedShort;
    try { lockedShort = await claimDraftRow(row.id); } catch (err) { console.error("[telegram-webhook] " + err.message); await cbNotice(chatId, "שגיאה זמנית. נסו שוב."); return; }
    if (!lockedShort) return;
    await tgCallSafe("sendChatAction", { chat_id: chatId, action: "typing" });
    try {
      await QX.shortenDescription(d, {});
    } catch (err) {
      await releaseDraftClaim(row.id);
      await cbNotice(chatId, AI_ERROR_TEXT[err && err.code] || AI_ERROR_TEXT.ai_failed);
      return;
    }
    recomputeDraft(d);
    try {
      // The printed description lives on the quote; updating it clears pdf_path (trigger) until re-rendered.
      await supabasePatch("quotes", "id=eq." + encodeURIComponent(row.quote_id), { description: d.description });
      await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { draft: d });
    } catch (err) {
      console.error("[telegram-webhook] shorten update failed: " + err.message);
      await releaseDraftClaim(row.id);
      await cbNotice(chatId, "שגיאה בעדכון. נסו שוב.");
      return;
    }
    var target = Object.assign(lockedShort, { draft: d });
    if (tappedMessageId) target.message_id = tappedMessageId;
    await finishApprovedQuote(target, chatId);
    return;
  }

  if (action === "short") {
    if (d.fit && d.fit.fits) { await cbNotice(chatId, "התיאור כבר נכנס בעמוד אחד 🙂"); return; }
    await tgCallSafe("sendChatAction", { chat_id: chatId, action: "typing" });
    try {
      await QX.shortenIfTooLong(d, {});
    } catch (err) {
      await cbNotice(chatId, AI_ERROR_TEXT[err && err.code] || AI_ERROR_TEXT.ai_failed);
      return;
    }
    recomputeDraft(d);
    await supabasePatch("telegram_pending_quotes", "id=eq." + encodeURIComponent(row.id), { draft: d });
    await showDraft(row, chatId, d.fit.fits ? "✂️ התיאור קוצר" : "✂️ קיצרתי, אבל זה עדיין ארוך מדי. אפשר ✏️ לערוך את התיאור.");
    return;
  }

  if (action === "ok" || action === "retry") {
    if (!row.quote_id && !draftReady(d)) {
      await cbNotice(chatId, d.total == null ? "חסר מחיר סופי. לחצו ✏️ סכום." : !d.client_name ? "חסר שם לקוח. לחצו ✏️ לקוח." : "התיאור ארוך מדי לעמוד אחד.");
      return;
    }
    var claimed;
    try { claimed = await claimDraftRow(row.id); } catch (err) {
      console.error("[telegram-webhook] " + err.message);
      await cbNotice(chatId, "שגיאה זמנית. נסו שוב.");
      return;
    }
    if (!claimed) return; // a concurrent tap is already handling it
    if (tappedMessageId) claimed.message_id = tappedMessageId; // the message the user is looking at
    await finishApprovedQuote(claimed, chatId);
    return;
  }
}

// ---------------------------------------------------------------------------
// Menu: persistent reply keyboard, /start /help /quote, help text
// ---------------------------------------------------------------------------

var MENU = {
  NEW_QUOTE: "🧾 הצעת מחיר חדשה",
  RECEIPT: "📷 סריקת קבלה",
  RECENT: "📜 הצעות אחרונות",
  SEARCH: "🔍 חיפוש הצעה",
  SUMMARY: "💰 סיכום הוצאות החודש",
  HELP: "❓ עזרה"
};

var MAIN_KEYBOARD = {
  keyboard: [
    [{ text: MENU.NEW_QUOTE }, { text: MENU.RECEIPT }],
    [{ text: MENU.RECENT }, { text: MENU.SEARCH }],
    [{ text: MENU.SUMMARY }, { text: MENU.HELP }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

// Exact menu labels and commands only (no AI). "/start@botname" counts as "/start".
var LABEL_ACTIONS = {};
LABEL_ACTIONS[MENU.NEW_QUOTE] = "quote";
LABEL_ACTIONS[MENU.RECEIPT] = "receipt";
LABEL_ACTIONS[MENU.RECENT] = "recent";
LABEL_ACTIONS[MENU.SEARCH] = "search";
LABEL_ACTIONS[MENU.SUMMARY] = "summary";
LABEL_ACTIONS[MENU.HELP] = "help";
var COMMAND_ACTIONS = { "/start": "start", "/help": "help", "/quote": "quote" };

function menuAction(text) {
  if (!text) return null;
  if (LABEL_ACTIONS[text]) return LABEL_ACTIONS[text];
  if (text[0] === "/") return COMMAND_ACTIONS[text.split(/\s/)[0].split("@")[0].toLowerCase()] || null;
  return null;
}

// Keyword intent for a quote (plan: keyword / exact-label matching only, no AI classification).
var QUOTE_INTENT_RE = /הצעת מחיר|הצעה|מטר|מ["״'׳]ר/;

var HELP_TEXT =
  "מה אפשר לעשות כאן:\n\n" +
  "📷 קבלה: שולחים תמונה של קבלה או חשבונית (או קובץ PDF). אני קורא אותה, מראה לכם את הפרטים, " +
  "ואחרי שתלחצו ✅ היא נשמרת בהוצאות העסק.\n\n" +
  "🧾 הצעת מחיר: לוחצים על 🧾 ושולחים הקלטה קולית או הודעה כתובה עם שם הלקוח, הכתובת, העבודה והמחיר הסופי. " +
  "אני מכין טיוטה, ואפשר לתקן אותה בכפתורים לפני האישור.\n\n" +
  "📜 הצעות אחרונות / 🔍 חיפוש הצעה: רואים הצעות קודמות ושולחים שוב את ה-PDF.\n\n" +
  "💰 סיכום החודש: כמה הוצאנו החודש, לפי קטגוריה.\n\n" +
  "בכל רגע אפשר ללחוץ על כפתור בתפריט למטה כדי להתחיל מחדש.";

async function quotaLine() {
  try {
    return "\n\n📊 נותרו היום: " + (await getRemaining("quote")) + " הצעות מחיר";
  } catch (err) {
    return ""; // the line is informative only; never block the menu on it
  }
}

async function sendHelp(chatId, intro) {
  await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: (intro ? intro + "\n\n" : "") + HELP_TEXT + (await quotaLine()),
    reply_markup: MAIN_KEYBOARD
  });
}

// Unclear message: offer the quote flow (plan: "🧾 להכין הצעת מחיר?").
function sendUnclear(chatId) {
  return tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: "לא בטוח שהבנתי 🙂\nאפשר לשלוח תמונה של קבלה, או לבחור פעולה מהתפריט למטה.",
    reply_markup: { inline_keyboard: [[{ text: "🧾 להכין הצעת מחיר?", callback_data: "newquote" }]] }
  });
}

var HE_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

// 💰 This calendar month (Israel time), from the DB only: total + per category.
async function sendMonthSummary(chatId) {
  var parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  var y = +parts.find(function (p) { return p.type === "year"; }).value;
  var m = +parts.find(function (p) { return p.type === "month"; }).value;
  var from = y + "-" + pad2(m) + "-01";
  var to = (m === 12 ? (y + 1) + "-01" : y + "-" + pad2(m + 1)) + "-01";
  var rows;
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/business_expenses?select=amount,category&date=gte." + from + "&date=lt." + to, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("HTTP " + res.status);
    rows = await res.json();
  } catch (err) {
    console.error("[telegram-webhook] month summary query failed: " + err.message);
    await tgCallSafe("sendMessage", { chat_id: chatId, text: "שגיאה זמנית בטעינת הסיכום. נסו שוב בעוד רגע." });
    return;
  }
  var title = "💰 הוצאות " + HE_MONTHS[m - 1] + " " + y;
  if (!rows.length) {
    await tgCallSafe("sendMessage", { chat_id: chatId, text: title + "\n\nאין עדיין הוצאות רשומות החודש.", reply_markup: MAIN_KEYBOARD });
    return;
  }
  var byCat = {};
  var total = 0;
  rows.forEach(function (r) {
    var a = Number(r.amount) || 0;
    total += a;
    byCat[r.category] = (byCat[r.category] || 0) + a;
  });
  var lines = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })
    .map(function (c) { return "• " + c + ": " + fmtMoney(byCat[c]); });
  await tgCallSafe("sendMessage", {
    chat_id: chatId,
    text: title + "\n\nסה״כ: " + fmtMoney(total) + " (" + rows.length + " הוצאות)\n\n" + lines.join("\n"),
    reply_markup: MAIN_KEYBOARD
  });
}

async function handleMenu(action, chatId) {
  if (action === "start") return sendHelp(chatId, "שלום! אני הבוט של מיסטר פוליש 🙂");
  if (action === "help") return sendHelp(chatId, null);
  if (action === "quote") return startQuote(chatId, null);
  if (action === "recent") return sendRecentQuotes(chatId);
  if (action === "search") return askSearch(chatId);
  if (action === "summary") return sendMonthSummary(chatId);
  if (action === "receipt") {
    return tgCallSafe("sendMessage", {
      chat_id: chatId,
      text: "📷 שלחו עכשיו תמונה של הקבלה (מהמצלמה או מהגלריה), או קובץ PDF.",
      reply_markup: MAIN_KEYBOARD
    });
  }
}

// ---------------------------------------------------------------------------
// Routing (one message): menu label/command -> pending edit (newest wins) -> photo/document =
// receipt -> voice/text with quote intent = quote -> otherwise "unclear" + the quote offer.
// ---------------------------------------------------------------------------

// Separate per-chat budgets per flow, so a burst in one flow doesn't lock the others.
var FLOW_LIMITS = {
  receipt: { max: 10, windowMs: 10 * 60 * 1000, text: "לאט לאט 🙂 אפשר לשלוח קבלה נוספת בעוד כמה דקות." },
  quote: { max: 10, windowMs: 10 * 60 * 1000, text: "לאט לאט 🙂 אפשר לנסות שוב בעוד כמה דקות." },
  menu: { max: 30, windowMs: 10 * 60 * 1000, text: "לאט לאט 🙂 נסו שוב בעוד רגע." }
};

async function withinFlowLimit(flow, chatId) {
  var l = FLOW_LIMITS[flow];
  if (rateLimit("telegram-" + flow + ":" + chatId, l.max, l.windowMs).ok) return true;
  await tgCallSafe("sendMessage", { chat_id: chatId, text: l.text });
  return false;
}

async function routeMessage(msg, chatId) {
  var text = typeof msg.text === "string" ? msg.text.trim() : "";
  var isVoice = !!(msg.voice || msg.audio);

  var action = menuAction(text);
  if (action) {
    if (!(await withinFlowLimit("menu", chatId))) return;
    await clearEditState(chatId); // a menu tap starts over
    await handleMenu(action, chatId);
    return;
  }

  if (text || isVoice) {
    var found = await Promise.all([text ? findAwaitingEdit(chatId) : null, findAwaitingQuoteEdit(chatId)]);
    var receiptEdit = found[0];
    var quoteEdit = found[1];
    // A 🎤 correction takes the next voice OR text; the ✏️ fields take text only.
    if (quoteEdit && isVoice && quoteEdit.awaiting_edit_field !== "voice") quoteEdit = null;
    if (receiptEdit && quoteEdit) {
      if (new Date(quoteEdit.edit_since) > new Date(receiptEdit.edit_since)) receiptEdit = null; else quoteEdit = null;
    }
    if (receiptEdit) {
      if (!(await withinFlowLimit("menu", chatId))) return;
      await processEditReply(receiptEdit, text, chatId);
      return;
    }
    if (quoteEdit) {
      if (!(await withinFlowLimit("quote", chatId))) return;
      await processQuoteEditReply(quoteEdit, msg, chatId);
      return;
    }

    // After "🧾" / "/quote" / a bare trigger, the next text or voice is the quote's details.
    var state = await getChatState(chatId);
    if (state && state.state === "awaiting_search" && text) {
      if (!(await withinFlowLimit("menu", chatId))) return;
      await clearChatState(chatId);
      await searchQuotes(chatId, text);
      return;
    }
    if (state && state.state === "collecting_quote") {
      if (!(await withinFlowLimit("quote", chatId))) return;
      await clearChatState(chatId);
      await createDraftFrom(chatId, quoteInputFromMessage(msg));
      return;
    }
  }

  if ((msg.photo && msg.photo.length) || msg.document) {
    if (!(await withinFlowLimit("receipt", chatId))) return;
    await processReceiptMessage(msg, chatId);
    return;
  }

  // An OPEN draft: a bare amount updates its price; other text/voice asks what to do with it.
  // (A bare quote trigger like "תכין לי הצעת מחיר" still goes to the continue/new choice below.)
  var bareTrigger = !isVoice && QUOTE_INTENT_RE.test(text) && isTriggerOnly(text);
  if ((text || isVoice) && !bareTrigger) {
    var open = await findOpenDraft(chatId);
    if (open) {
      if (!(await withinFlowLimit("quote", chatId))) return;
      if (!isVoice && QX.isAmountOnly(text)) await updateDraftTotal(open, text, chatId);
      else await askDraftFollowup(open, quoteInputFromMessage(msg), chatId);
      return;
    }
  }

  if (isVoice || QUOTE_INTENT_RE.test(text)) {
    if (!(await withinFlowLimit("quote", chatId))) return;
    await startQuote(chatId, !isVoice && isTriggerOnly(text) ? null : quoteInputFromMessage(msg));
    return;
  }

  if (!(await withinFlowLimit("menu", chatId))) return;
  await sendUnclear(chatId);
}

// Runs after the 200 ACK (waitUntil). Never throws.
function runInBackground(label, fn) {
  var p = Promise.resolve().then(fn).catch(function (err) {
    console.error("[telegram-webhook] " + label + " failed: " + err.message);
  }).then(sweepRetention).catch(function () {});
  waitUntil(p);
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function isAllowedChat(chatId) {
  var allowedRaw = telegramConfig().allowedChats;
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

  var tgConfig = telegramConfig();
  var botToken = tgConfig.botToken;
  var webhookSecret = tgConfig.webhookSecret;
  // Previews also require the test allowlist up front (fail closed before any Telegram call).
  // In production an empty allowlist keeps its existing behavior: isAllowedChat() fails closed.
  if (!botToken || !webhookSecret || (tgConfig.test && !tgConfig.allowedChats) ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GOOGLE_AI_API_KEY) {
    console.error("[telegram-webhook] missing " +
      (tgConfig.test ? "TELEGRAM_TEST_BOT_TOKEN / TELEGRAM_TEST_WEBHOOK_SECRET / TELEGRAM_TEST_ALLOWED_CHATS" : "TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET") +
      " / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_AI_API_KEY configuration");
    // Still 200 — Telegram would otherwise retry indefinitely, and there's no useful
    // reply we can send without a working bot token in the first place.
    res.status(200).json({ ok: true });
    return;
  }

  // Telegram echoes back whatever secret_token was set on setWebhook (see
  // tools/set-telegram-webhook.js) on this exact header, on every real call. Anything
  // else did not come from Telegram.
  if (!safeEqual(req.headers["x-telegram-bot-api-secret-token"], webhookSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  var update = req.body || {};

  // Order: allowlist (no DB work for strangers) -> dedupe by update_id -> ACK 200 fast -> the
  // real work in waitUntil (Telegram retries anything slower than its timeout, and a retry is
  // dropped by the dedupe). Always 200 to Telegram, even on our own bugs: a 5xx only replays a
  // partially processed update.
  try {
    if (update.callback_query) {
      var q = update.callback_query;
      var cbChatId = q.message && q.message.chat && q.message.chat.id;
      if (cbChatId == null || !isAllowedChat(cbChatId)) {
        await tgCallSafe("answerCallbackQuery", { callback_query_id: q.id });
        res.status(200).json({ ok: true });
        return;
      }
      if (!(await claimUpdate(update.update_id))) {
        res.status(200).json({ ok: true }); // duplicate delivery
        return;
      }
      if (!rateLimit("telegram-callback:" + cbChatId, 20, 60 * 1000).ok) {
        await tgCallSafe("answerCallbackQuery", { callback_query_id: q.id, text: "לאט לאט 🙂" });
        res.status(200).json({ ok: true });
        return;
      }
      // Answer right away (stops the button spinner); the result arrives as a message edit.
      await tgCallSafe("answerCallbackQuery", { callback_query_id: q.id, text: "⏳" });
      runInBackground("callback", function () { return processCallbackQuery(q, cbChatId); });
      res.status(200).json({ ok: true });
      return;
    }

    if (update.message) {
      var msg = update.message;
      var chatId = msg.chat && msg.chat.id;
      if (chatId == null || !isAllowedChat(chatId)) {
        // Silent — a stranger who finds/messages the bot gets no reply at all, so the
        // allowlist doubles as "does this bot even do anything for you" concealment.
        res.status(200).json({ ok: true });
        return;
      }
      if (!(await claimUpdate(update.update_id))) {
        res.status(200).json({ ok: true }); // duplicate delivery
        return;
      }
      runInBackground("message", function () { return routeMessage(msg, chatId); });
      res.status(200).json({ ok: true });
      return;
    }

    // Any other update type (edited_message, my_chat_member, etc.) — nothing to do.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[telegram-webhook] unhandled error: " + err.message);
    res.status(200).json({ ok: true });
  }
};
