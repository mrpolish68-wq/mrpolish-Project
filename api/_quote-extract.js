// Gemini quote extraction for the Telegram bot (Telegram quotes, Phase 4b). Underscore-prefixed,
// so Vercel treats it as a helper, not a route.
//
//   extractQuote({ text } | { audio, mimeType }, { todayIL })  -> draft
//   applyCorrection(draft, { text } | { audio, mimeType })     -> updated draft
//
// Gemini only READS the message and returns structured fields. Everything that decides money or
// a printed value is done in code here:
//   - item math (area/quantity × unit price, the item sum) is computed in code;
//   - the total is taken ONLY from stated_total, and ONLY when its evidence (the exact words the
//     user said) appears in the user's text / transcript AND encodes that same number (digits or
//     Hebrew number words). It is never filled in from the items. No accepted total -> missing
//     includes "total" and the bot asks for it;
//   - an item sum that differs from the stated total keeps the stated total + a sum_mismatch warning.
//
// Privacy (Gemini free tier, see telegram-quotes-plan.md "Privacy"): phone numbers are stripped
// from text before it is sent and from every output string; Gemini gets only the current message
// (plus, for a correction, the current draft it corrects); audio is passed through in memory and
// never stored. Logs carry the operation, input kind, timing and outcome only.
//
// Own minimal Gemini call (same model + endpoint style as parse-receipt.js, which stays as is).
// Raw fetch, no SDK, like every other api/*.js file.
"use strict";

const T = require("../shared/quote-template.js");

// Same pinned model as parse-receipt.js. The key is on a paid Tier 1 project with a monthly spend
// cap; a 429 or a spend-cap/quota refusal surfaces as ai_busy (see callGemini).
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";
const GEMINI_TIMEOUT_MS = 25000;

const AUDIO_MIME_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac", "audio/mp4", "audio/m4a", "audio/x-m4a"];
// Same cap as the bot (15 MB). A 3-minute Telegram voice note is under 1 MB; Gemini's inline
// request limit (~20 MB incl. base64) is only reachable by an unusually high-bitrate file.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_ITEMS = 20;
const MAX_LINES = 20;     // hard cap on what we accept from Gemini before the fit check
const MAX_LINE_CHARS = 200;
const PHONE_PLACEHOLDER = "[מספר הוסר]";

class QuoteExtractError extends Error {
  // code: "empty_input" | "invalid_input" | "ai_busy" (429/503/timeout, retry later) | "ai_failed"
  constructor(code, message, extra) {
    super(message || code);
    this.name = "QuoteExtractError";
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

// Israeli mobile/landline numbers, local or +972, with optional - / space / . separators, plus any
// other run of 9+ digits (dashes allowed). Prices ("4,500", "12000") and separate numbers
// ("45 75 3375") don't match.
const PHONE_RES = [
  /(?:\+|00)?972[\s\-.]?\(?0?\)?[\s\-.]?(?:5\d|[2-489]|7\d)[\s\-.]?\d{3}[\s\-.]?\d{3,4}/g,
  /\b0(?:5\d|[2-489]|7\d)[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g,
  /\b0(?:5\d|7\d)[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}\b/g,
  /\d(?:-?\d){8,}/g
];

function stripPhones(s) {
  if (s == null) return s;
  var out = String(s);
  for (var i = 0; i < PHONE_RES.length; i++) out = out.replace(PHONE_RES[i], PHONE_PLACEHOLDER);
  return out;
}

// ---------------------------------------------------------------------------
// Numbers: digits or Hebrew number words -> value
// ---------------------------------------------------------------------------

const HE_UNITS = {
  "אחד": 1, "אחת": 1,
  "שתיים": 2, "שתים": 2, "שניים": 2, "שנים": 2, "שני": 2, "שתי": 2,
  "שלוש": 3, "שלושה": 3, "שלושת": 3, "שלש": 3, "שלשה": 3, "שלשת": 3,
  "ארבע": 4, "ארבעה": 4, "ארבעת": 4,
  "חמש": 5, "חמישה": 5, "חמשה": 5, "חמשת": 5,
  "שש": 6, "שישה": 6, "ששה": 6, "ששת": 6,
  "שבע": 7, "שבעה": 7, "שבעת": 7,
  "שמונה": 8, "שמונת": 8,
  "תשע": 9, "תשעה": 9, "תשעת": 9,
  "עשר": 10, "עשרה": 10, "עשרת": 10,
  "עשרים": 20, "שלושים": 30, "שלשים": 30, "ארבעים": 40, "חמישים": 50, "חמשים": 50,
  "שישים": 60, "ששים": 60, "שבעים": 70, "שמונים": 80, "תשעים": 90,
  "מאה": 100, "מאתיים": 200
};
const HE_SCALE_WORDS = ["מאות", "אלף", "אלפים", "אלפיים", "חצי"];

function heWord(w) {
  w = w.replace(/[׳״'"]/g, "");
  if (HE_UNITS[w] !== undefined || HE_SCALE_WORDS.indexOf(w) !== -1) return w;
  // Conjunction prefix: "וחמש", "ומאתיים", "וחצי".
  if (w.length > 1 && w[0] === "ו") {
    var rest = w.slice(1);
    if (HE_UNITS[rest] !== undefined || HE_SCALE_WORDS.indexOf(rest) !== -1) return rest;
  }
  return null;
}

// Reads ONE amount from a short phrase: "4,500", "4500 ש״ח", "4.5 אלף", "ארבעת אלפים וחמש מאות",
// "שלושת אלפים ומאתיים", "אלף וחצי". Non-number words are ignored. Returns null if there's no number.
function parseAmount(phrase) {
  var tokens = String(phrase || "").match(/\d[\d,]*(?:\.\d+)?|[א-ת׳״'"]+/g) || [];
  var total = 0, cur = 0, any = false, afterThousand = false;
  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];
    if (/^\d/.test(tok)) {
      cur += parseFloat(tok.replace(/,/g, ""));
      any = true; afterThousand = false;
      continue;
    }
    var w = heWord(tok);
    if (!w) continue;
    any = true;
    if (w === "אלף" || w === "אלפים") { total += (cur || 1) * 1000; cur = 0; afterThousand = true; }
    else if (w === "אלפיים") { total += 2000; cur = 0; afterThousand = true; }
    else if (w === "מאות") { cur = (cur || 1) * 100; }
    else if (w === "חצי") {
      if (cur > 0) cur += 0.5;
      else if (afterThousand) total += 500;
    } else { cur += HE_UNITS[w]; }
  }
  return any ? total + cur : null;
}

// Letters + digits only, so "4,500 ש״ח" matches "4500 שח" and spacing/punctuation don't matter.
function squash(s) {
  return String(s || "").replace(/[^א-ת0-9a-zA-Z]/g, "").toLowerCase();
}

const TOTAL_CUE_RE = /סה["״']?כ|סך|סופי|הכל|הכול|כולל|ביחד|יחד|לתשלום|בסך|total/i;

// The total rule. Returns { total, reason } where total is null unless the evidence is verbatim in
// the source and encodes the stated number.
function verifyStatedTotal(stated, evidence, source, items) {
  if (typeof stated !== "number" || !isFinite(stated) || stated <= 0) return { total: null, reason: "none" };
  if (!evidence || typeof evidence !== "string") return { total: null, reason: "no_evidence" };
  var ev = squash(evidence);
  if (!ev || squash(source).indexOf(ev) === -1) return { total: null, reason: "evidence_not_in_source" };
  var parsed = parseAmount(evidence);
  if (parsed == null || Math.abs(parsed - stated) > 0.5) return { total: null, reason: "evidence_mismatch" };
  // A unit price mistaken for the total ("80 ש״ח למטר"), unless the words say it's the total.
  var isUnitPrice = (items || []).some(function (it) { return it.unit_price === stated && it.line_total !== stated; });
  if (isUnitPrice && !TOTAL_CUE_RE.test(evidence)) return { total: null, reason: "looks_like_unit_price" };
  return { total: round2(stated), reason: "ok" };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const ITEM_SCHEMA = {
  type: "OBJECT",
  properties: {
    service: { type: "STRING", description: "השירות, בעברית מקצועית קצרה" },
    area_m2: { type: "NUMBER", nullable: true },
    quantity: { type: "NUMBER", nullable: true },
    unit: { type: "STRING", nullable: true },
    unit_price: { type: "NUMBER", nullable: true },
    notes: { type: "STRING", nullable: true }
  },
  required: ["service"]
};

const DRAFT_SCHEMA = {
  type: "OBJECT",
  properties: {
    client_name: { type: "STRING", nullable: true },
    address: { type: "STRING", nullable: true },
    items: { type: "ARRAY", items: ITEM_SCHEMA },
    stated_total: { type: "NUMBER", nullable: true },
    stated_total_evidence: { type: "STRING", nullable: true },
    quote_date: { type: "STRING", nullable: true },
    description_lines: { type: "ARRAY", items: { type: "STRING" } },
    transcript: { type: "STRING" },
    missing: { type: "ARRAY", items: { type: "STRING" } }
  },
  required: ["items", "description_lines", "transcript", "missing"]
};

const SHORTEN_SCHEMA = {
  type: "OBJECT",
  properties: { description_lines: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["description_lines"]
};

const BUSINESS =
  "You work for Mr. Polish (מיסטר פוליש), an Israeli floor-polishing and stone-restoration contractor " +
  "(ליטוש שיש ואבן, הברקה קריסטלית, מריחת סילר הגנה, חידוש בטון ובומנייט, מדרגות). ";

const FIELD_RULES =
  "Rules:\n" +
  "- client_name / address: exactly as said; null if not said. Never invent them.\n" +
  "- items: one entry per job/service. area_m2 for square meters (מטר / מ\"ר / מטר רבוע), quantity for " +
  "counted things (מדרגות, יחידות); for a fixed-price item set quantity 1. unit_price only if a price per unit " +
  "(or a fixed price for that item) was explicitly said. Approximate words (בערך, כ-, ~) still give the number; " +
  "mention the approximation in notes. Never compute anything.\n" +
  "- stated_total: ONLY a final total price the speaker explicitly said (סה\"כ, סופי, המחיר הכולל, the price " +
  "for everything). NEVER add up items, never multiply, never guess. If no final total was said, null.\n" +
  "- stated_total_evidence: the EXACT words of the total copied verbatim from the message (e.g. " +
  "\"סה\"כ 4,500\" or \"ארבעת אלפים וחמש מאות\"), null when stated_total is null.\n" +
  "- quote_date: only if a date was explicitly said, as D.M.YYYY; null otherwise.\n" +
  "- description_lines: the work description for the printed quote, professional Hebrew, at most 12 short " +
  "lines (up to ~70 characters each). If there are several items, number them (\"1. \", \"2. \"). You may " +
  "repeat quantities and unit prices exactly as said, but NEVER write computed results, sums or the total. " +
  "No client name, address or phone in the description. Drop hesitations and filler words.\n" +
  "- NEVER output a phone number anywhere, even if one was said.\n" +
  "- missing: list which of client_name, address, description, total were not provided.\n";

function extractionPrompt(todayIL, isAudio) {
  return BUSINESS +
    "Read the " + (isAudio ? "voice message (Hebrew audio)" : "Hebrew message") + " below, in which the business " +
    "owner or assistant dictates a price quote (הצעת מחיר). Extract the fields defined by the response schema.\n" +
    "Today's date in Israel is " + todayIL + " (use it only to resolve relative dates like \"מחר\").\n" +
    FIELD_RULES +
    "- transcript: " + (isAudio ? "a faithful Hebrew transcript of the audio (phone numbers omitted)." : "an empty string.") + "\n" +
    "If the message is not a price quote at all, return nulls and empty arrays.";
}

function correctionPrompt(draftJson, isAudio) {
  return BUSINESS +
    "Below is the CURRENT draft of a price quote (JSON) and then a correction " +
    (isAudio ? "voice message (Hebrew audio)" : "message (Hebrew)") + ". Apply the correction and return the " +
    "FULL updated draft in the response schema. Keep every field the correction doesn't change exactly as it is.\n" +
    "For stated_total and stated_total_evidence: if the correction states a new final total, return it with its " +
    "exact words from the CORRECTION message; otherwise return the current total and null evidence.\n" +
    FIELD_RULES +
    "- transcript: " + (isAudio ? "a faithful Hebrew transcript of the correction audio only (phone numbers omitted)." : "an empty string.") + "\n\n" +
    "CURRENT DRAFT:\n" + draftJson;
}

function extractRetryAfter(data) {
  var details = (data && data.error && data.error.details) || [];
  for (var i = 0; i < details.length; i++) {
    var d = details[i];
    if (d && d.retryDelay) return parseInt(String(d.retryDelay), 10) || null;
  }
  return null;
}

// Quota metadata from a 429 body (quota id + value): not user data, useful to confirm the real limit.
function extractQuotaInfo(data) {
  var details = (data && data.error && data.error.details) || [];
  for (var i = 0; i < details.length; i++) {
    var v = details[i] && details[i].violations;
    if (v && v[0]) return (v[0].quotaId || "?") + "=" + (v[0].quotaValue || "?");
  }
  return null;
}

// Temporary refusals the bot answers with its friendly "busy" message: rate limits (429), overload
// (503), and quota / spend-cap / billing refusals, which Google may send as 429 RESOURCE_EXHAUSTED
// or as a 400/403 whose error mentions billing, quota or the spend cap.
const BUSY_MESSAGE_RE = /billing|quota|spend|budget|exhausted|exceeded/i;
function isBusyResponse(status, data) {
  if (status === 429 || status === 503) return true;
  var err = (data && data.error) || {};
  if (err.status === "RESOURCE_EXHAUSTED") return true;
  return (status === 400 || status === 403) && BUSY_MESSAGE_RE.test(String(err.message || ""));
}

async function callGemini(op, parts, schema, opts) {
  var apiKey = (opts && opts.apiKey) || process.env.GOOGLE_AI_API_KEY;
  var doFetch = (opts && opts.fetch) || fetch;
  if (!apiKey) throw new QuoteExtractError("ai_failed", "missing GOOGLE_AI_API_KEY");
  var t0 = Date.now();
  var outcome = "ok";
  try {
    var res;
    try {
      res = await doFetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: parts }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 }
        }),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
      });
    } catch (err) {
      outcome = "ai_busy(network)";
      throw new QuoteExtractError("ai_busy", "Gemini unreachable or timed out");
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (isBusyResponse(res.status, data)) {
      var quota = extractQuotaInfo(data);
      outcome = "ai_busy(" + res.status + (quota ? " " + quota : "") + ")";
      throw new QuoteExtractError("ai_busy", "Gemini HTTP " + res.status, { retryAfter: extractRetryAfter(data), quota: quota });
    }
    if (!res.ok) {
      outcome = "ai_failed(" + res.status + ")";
      throw new QuoteExtractError("ai_failed", "Gemini HTTP " + res.status);
    }
    var cand = data && data.candidates && data.candidates[0];
    var textPart = cand && cand.content && (cand.content.parts || []).filter(function (p) { return p.text && !p.thought; })[0];
    if (!textPart) {
      outcome = "ai_failed(empty " + ((cand && cand.finishReason) || "-") + ")";
      throw new QuoteExtractError("ai_failed", "Gemini returned no content");
    }
    try {
      return JSON.parse(textPart.text);
    } catch (e) {
      outcome = "ai_failed(json)";
      throw new QuoteExtractError("ai_failed", "Gemini response was not valid JSON");
    }
  } finally {
    console.log("[quote-extract] op=" + op + " ms=" + (Date.now() - t0) + " outcome=" + outcome);
  }
}

// ---------------------------------------------------------------------------
// Input + output shaping
// ---------------------------------------------------------------------------

// -> { kind:"text", text } | { kind:"audio", base64, mimeType }. Throws empty_input / invalid_input.
function readInput(input) {
  if (!input || typeof input !== "object") throw new QuoteExtractError("invalid_input", "input must be { text } or { audio, mimeType }");
  if (input.audio != null) {
    var mime = String(input.mimeType || "").split(";")[0].trim().toLowerCase();
    if (AUDIO_MIME_TYPES.indexOf(mime) === -1) throw new QuoteExtractError("invalid_input", "unsupported audio type");
    var buf = Buffer.isBuffer(input.audio) ? input.audio : Buffer.from(String(input.audio), "base64");
    if (!buf.length) throw new QuoteExtractError("empty_input", "empty audio");
    if (buf.length > MAX_AUDIO_BYTES) throw new QuoteExtractError("invalid_input", "audio too large");
    return { kind: "audio", base64: buf.toString("base64"), mimeType: mime };
  }
  var text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new QuoteExtractError("empty_input", "empty text");
  if (text.length > MAX_TEXT_CHARS) throw new QuoteExtractError("invalid_input", "text too long");
  return { kind: "text", text: stripPhones(text) };
}

function messageParts(prompt, inp) {
  if (inp.kind === "audio") return [{ text: prompt }, { inline_data: { mime_type: inp.mimeType, data: inp.base64 } }];
  return [{ text: prompt + "\n\nMESSAGE:\n" + inp.text }];
}

function cleanStr(v, max) {
  if (v == null) return null;
  var s = stripPhones(String(v)).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function cleanNum(v) {
  return typeof v === "number" && isFinite(v) && v >= 0 ? v : null;
}

function normalizeItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).slice(0, MAX_ITEMS).map(function (it) {
    it = it || {};
    var item = {
      service: cleanStr(it.service, 120) || "",
      area_m2: cleanNum(it.area_m2),
      quantity: cleanNum(it.quantity),
      unit: cleanStr(it.unit, 30),
      unit_price: cleanNum(it.unit_price),
      notes: cleanStr(it.notes, 200)
    };
    // Item math happens here, never in the model.
    var qty = item.area_m2 != null ? item.area_m2 : item.quantity;
    item.line_total = item.unit_price != null && qty != null ? round2(item.unit_price * qty) : null;
    return item;
  }).filter(function (it) { return it.service; });
}

const TOTAL_LINE_RE = /סה["״']?כ|סך[\s-]?הכו?ל/;

function normalizeLines(rawLines) {
  return (Array.isArray(rawLines) ? rawLines : [])
    .map(function (l) { return cleanStr(l, MAX_LINE_CHARS); })
    .filter(function (l) { return l && l !== PHONE_PLACEHOLDER && !TOTAL_LINE_RE.test(l); }) // the total is printed once, in its own box
    .slice(0, MAX_LINES);
}

const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

// Builds the draft from Gemini's raw fields. `source` is the text the total evidence must appear in
// (the user's phone-stripped text, or the transcript). `fallback` (corrections) supplies the
// previous total/date when the correction doesn't state a new one.
function buildDraft(raw, source, transcript, todayIL, fallback) {
  raw = raw || {};
  var warnings = [];
  var items = normalizeItems(raw.items);
  var lines = normalizeLines(raw.description_lines);

  var v = verifyStatedTotal(raw.stated_total, raw.stated_total_evidence, source, items);
  var total = v.total;
  var totalSource = total != null ? "stated" : null;
  if (total == null && fallback && fallback.total != null) { total = fallback.total; totalSource = fallback.total_source || "stated"; }
  if (total == null && v.reason !== "none" && v.reason !== "no_evidence") warnings.push({ code: "total_rejected", reason: v.reason });

  var priced = items.filter(function (it) { return it.line_total != null; });
  var itemsSum = priced.length ? round2(priced.reduce(function (s, it) { return s + it.line_total; }, 0)) : null;
  var allPriced = items.length > 0 && priced.length === items.length;
  if (total != null && allPriced && Math.abs(itemsSum - total) > 0.5) {
    warnings.push({ code: "sum_mismatch", items_sum: itemsSum, total: total });
  }

  var quoteDate = null;
  var dateStated = false;
  var m = typeof raw.quote_date === "string" ? raw.quote_date.trim().match(DATE_RE) : null;
  if (m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) { quoteDate = pad2(+m[1]) + "." + pad2(+m[2]) + "." + m[3]; dateStated = true; }
  else if (raw.quote_date) warnings.push({ code: "date_unreadable" });
  if (!quoteDate && fallback && fallback.quote_date) { quoteDate = fallback.quote_date; dateStated = !!fallback.quote_date_stated; }
  if (!quoteDate) quoteDate = todayIL;

  var description = lines.join("\n");
  var draft = {
    client_name: cleanStr(raw.client_name, 120),
    address: cleanStr(raw.address, 200),
    items: items,
    items_sum: itemsSum,
    total: total,
    total_source: totalSource,
    quote_date: quoteDate,
    quote_date_stated: dateStated,
    description_lines: lines,
    description: description,
    transcript: transcript || "",
    missing: [],
    warnings: warnings
  };
  if (!draft.client_name) draft.missing.push("client_name");
  if (!draft.address) draft.missing.push("address");
  if (!description) draft.missing.push("description");
  if (draft.total == null) draft.missing.push("total");
  if (!draft.client_name && !draft.address && !items.length && !description && draft.total == null) {
    warnings.push({ code: "no_quote_content" });
  }
  return draft;
}

// One shorten() call when the description would be refused, then a re-check.
async function ensureFits(draft, opts) {
  var est = T.estimateDescriptionFits(draft.description);
  draft.fit = { lines: est.lines, maxLines: est.maxLines, fits: est.fits, shortened: false };
  if (est.fits) return draft;
  var raw = await callGemini("shorten", [{ text: shortenPrompt(draft.description_lines) }], SHORTEN_SCHEMA, opts);
  var lines = normalizeLines(raw && raw.description_lines);
  if (lines.length) {
    draft.description_lines = lines;
    draft.description = lines.join("\n");
  }
  est = T.estimateDescriptionFits(draft.description);
  draft.fit = { lines: est.lines, maxLines: est.maxLines, fits: est.fits, shortened: true };
  if (!est.fits) draft.warnings.push({ code: "too_long", lines: est.lines, maxLines: est.maxLines });
  return draft;
}

function shortenPrompt(lines) {
  return BUSINESS +
    "Shorten this Hebrew work description for a one-page price quote to at most 12 short lines (~70 characters " +
    "each). Keep every service, quantity, measurement and price EXACTLY as written; do not add, change or " +
    "compute any number; no totals. Keep the numbering if present. Professional Hebrew.\n\nDESCRIPTION:\n" +
    lines.join("\n");
}

// Today in Israel as DD.MM.YYYY (zero-padded; he-IL alone gives "5.3.2026").
function todayIL(date) {
  var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" })
    .formatToParts(date || new Date());
  function get(t) { return parts.filter(function (p) { return p.type === t; })[0].value; }
  return get("day") + "." + get("month") + "." + get("year");
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function extractQuote(input, opts) {
  opts = opts || {};
  var inp = readInput(input);
  var today = opts.todayIL || todayIL();
  var raw = await callGemini("extract:" + inp.kind, messageParts(extractionPrompt(today, inp.kind === "audio"), inp), DRAFT_SCHEMA, opts);
  var transcript = inp.kind === "audio" ? cleanTranscript(raw && raw.transcript) : inp.text;
  var draft = buildDraft(raw, transcript, transcript, today, null);
  return ensureFits(draft, opts);
}

async function applyCorrection(draft, input, opts) {
  opts = opts || {};
  if (!draft || typeof draft !== "object") throw new QuoteExtractError("invalid_input", "missing draft");
  var inp = readInput(input);
  var current = {
    client_name: draft.client_name || null,
    address: draft.address || null,
    items: (draft.items || []).map(function (it) {
      return { service: it.service, area_m2: it.area_m2, quantity: it.quantity, unit: it.unit, unit_price: it.unit_price, notes: it.notes };
    }),
    stated_total: draft.total == null ? null : draft.total,
    quote_date: draft.quote_date_stated ? draft.quote_date : null,
    description_lines: draft.description_lines || []
  };
  var raw = await callGemini("correct:" + inp.kind,
    messageParts(correctionPrompt(stripPhones(JSON.stringify(current)), inp.kind === "audio"), inp), DRAFT_SCHEMA, opts);
  var transcript = inp.kind === "audio" ? cleanTranscript(raw && raw.transcript) : inp.text;
  // The total may change only with evidence in THIS correction; otherwise the previous total stays.
  var updated = buildDraft(raw, transcript, transcript, draft.quote_date || todayIL(), {
    total: draft.total, total_source: draft.total_source, quote_date: draft.quote_date, quote_date_stated: draft.quote_date_stated
  });
  return ensureFits(updated, opts);
}

function cleanTranscript(t) {
  return t == null ? "" : stripPhones(String(t)).trim().slice(0, MAX_TEXT_CHARS);
}

module.exports = {
  extractQuote: extractQuote,
  applyCorrection: applyCorrection,
  QuoteExtractError: QuoteExtractError,
  todayIL: todayIL,
  // used by the bot's manual edits (code only, no AI) and the ✂️ button
  parseAmount: parseAmount,
  stripPhones: stripPhones,
  shortenIfTooLong: ensureFits,
  GEMINI_MODEL: GEMINI_MODEL,
  // exported for tests
  _internal: { stripPhones: stripPhones, parseAmount: parseAmount, verifyStatedTotal: verifyStatedTotal, buildDraft: buildDraft }
};
