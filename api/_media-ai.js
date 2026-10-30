// Gemini vision for project media (media-projects plan, Phase 9; decisions D3, D6, D7). A shared
// helper (no Vercel function). Same model, key and busy-detection as the quote bot (callGemini in
// api/_quote-extract.js).
//
//   analyzeProject({ images: [{ id, buffer, filename?, order }], text?, audio?, mimeType?, todayIL? }, opts)
//   applyMediaCorrection(analysis, { text } | { audio, mimeType }, opts)
//   prepareForAi(buffer) → a ≤ 1024 px EXIF-free JPEG (analyzeProject re-encodes every image anyway)
//
// Gemini only LOOKS and SUGGESTS: roles (before / after / detail), pairs, alt texts, privacy and
// quality flags, the service, titles, the site summary and the caption body + hashtags (Hebrew AND
// English, D6). Everything that must be true is decided in CODE afterwards:
//   - no prices, no phone numbers, no client names, no street or house numbers anywhere in the text:
//     the sentences carrying them are removed, then every field is re-checked and rejected (null)
//     if anything is still there;
//   - the city is accepted ONLY when the user actually said it (it must appear in their text or the
//     transcript), and never with a digit or a street word (D7);
//   - roles / services / flag types are enums, lengths are capped;
//   - when the pairing confidence is low or the pairs don't make sense, pairing falls back to the
//     file names (before/after/לפני/אחרי) or the upload order (1st = before, 2nd = after, …);
//   - the call to action (phone 052-9534540 + WhatsApp) is appended by code, word for word.
// Quota: one 'media_ai' unit per call (api/_quota.js); a 429 / spend-cap refusal → code 'ai_busy'.
"use strict";

const sharp = require("sharp");
const QX = require("./_quote-extract.js");
const { consumeQuota } = require("./_quota.js");

const SERVICES = ["floor_polish", "crystal", "marble_stone", "sealer", "concrete", "bomanite", "stairs", "other"];
const ROLES = ["before", "after", "detail"];
const PRIVACY_TYPES = ["face", "license_plate", "house_number", "document", "other"];
const QUALITY_FLAGS = ["blurry", "dark", "tilted"];
const MAX_IMAGES = 10;            // an Instagram carousel's API limit
const AI_EDGE = 1024;
const PAIRING_MIN_CONFIDENCE = 0.6;
const ROLE_MIN_CONFIDENCE = 0.6;
const GEMINI_VISION_TIMEOUT_MS = 55000;
const LIMITS = { alt: 125, title: 70, summary: 420, caption: 900, note: 120, city: 40 };
const CTA_HE = "📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: 052-9534540 (גם בוואטסאפ) · mr-polishes.com";
const SERVICE_HE = { floor_polish: "ליטוש מרצפות", crystal: "פוליש קריסטל", marble_stone: "ליטוש שיש ואבן", sealer: "סילר הגנה",
  concrete: "ליטוש בטון", bomanite: "חידוש בומנייט", stairs: "חידוש מדרגות", other: "ליטוש רצפות" };
const SERVICE_TAGS = { floor_polish: ["#ליטוש_מרצפות", "#חידוש_ריצוף"], crystal: ["#פוליש_קריסטל", "#הברקת_רצפות"], marble_stone: ["#ליטוש_שיש", "#ליטוש_אבן"],
  sealer: ["#סילר", "#הגנה_לאבן"], concrete: ["#ליטוש_בטון", "#בטון_מוחלק"], bomanite: ["#בומנייט", "#בטון_מוטבע"], stairs: ["#חידוש_מדרגות", "#ליטוש_מדרגות"], other: ["#ליטוש_רצפות"] };
const BASE_TAGS = ["#מיסטר_פוליש", "#לפני_ואחרי", "#ליטוש_רצפות", "#רצפות", "#עיצוב_הבית", "#שיפוץ"];

// The brand voice, learned (read-only) from the published content_queue captions, 2026-10-30.
const BRAND_VOICE = [
  "Write like Mr. Polish's own posts: warm, confident, expert but plain Hebrew, never salesy.",
  "Structure: ONE short hook line ending with ONE fitting emoji; then 1–2 short paragraphs: what was done on this floor and the result.",
  "Typical phrases: 'פרויקט אמיתי מהשטח, לא הדמיה', 'שירות בפריסה ארצית', '30 שנות ניסיון של אורי'. Use at most one of them.",
  "Talk about the floor/stone and the work (ליטוש, הברקה, סילר, חידוש), not about the client.",
  "Do NOT write the call to action, a phone number, a link or hashtags inside the caption body — the system adds them."
].join("\n");

class MediaAiError extends Error {
  constructor(code, message, he, extra) {
    super(message || code);
    this.name = "MediaAiError";
    this.code = code;      // invalid_input | quota | quota_unavailable | ai_busy | ai_failed
    this.he = he;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Sanitizing (the rules enforced in code)
// ---------------------------------------------------------------------------
const STREET_WORDS = "רחוב|רח['׳]|שדרות|שד['׳]|שדרת|סמטת|סמטה|דרך|כיכר|מספר בית|בית מספר|דירה|קומה|כניסה";
const STREET_RE = new RegExp("(?:" + STREET_WORDS + ")\\s*[^\\s,.]*(?:\\s+[^\\s,.]+){0,2}?\\s*\\d+|\\b[א-ת]{2,}\\s+\\d{1,4}[א-ת]?\\s*,", "u");
const PRICE_RE = /₪|ש["״'׳]ח|\bשקל|\bNIS\b|\bILS\b|(?:מחיר|עלות|עלה|עולה|תשלום|שילמ|שולמ|תקציב)[^.\n!?]{0,25}\d/i;
const PHONE_RE = /(?:\+|00)?972[\s\-.]?\d|\b0\d{1,2}[\s\-.]?\d{3}[\s\-.]?\d{3,4}\b|\d(?:[\s\-.]?\d){8,}/;
const HONORIFIC_RE = /(?:משפחת|למשפחת|ממשפחת|הלקוח(?:ה)?|הלקוחות|ללקוח(?:ה)?)\s+(?!שלנו|שלי|שלו|שלה|ש)[א-תA-Za-z]{2,}/;
const CITY_BAD_RE = new RegExp("\\d|" + STREET_WORDS, "u");

function clean(v, max) {
  if (v == null) return null;
  var s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!s) return null;
  if (s.length > max) {
    var cut = s.slice(0, max);
    var sp = cut.lastIndexOf(" ");
    s = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, "") + "…";
  }
  return s;
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Words the user mentioned that must never reach published text: client names after "משפחת",
// "אצל", "הלקוח" …, street names after a street word, plus any names the caller knows (a quote).
function sensitiveTokens(sourceText, knownNames) {
  var t = String(sourceText || ""), out = [];
  var grab = function (re) { var m; while ((m = re.exec(t))) for (var i = 1; i < m.length; i++) if (m[i] && m[i].length >= 2) out.push(m[i]); };
  grab(/(?:משפחת|למשפחת|ממשפחת)\s+([א-תA-Za-z]+)/g);
  grab(/(?:אצל|הלקוח(?:ה)?|ללקוח(?:ה)?|לקוח(?:ה)?)\s+(?!ה|שלנו|שלי|ב|משפחת|למשפחת)([א-תA-Za-z]{2,})/g);
  grab(new RegExp("(?:" + STREET_WORDS + ")\\s+([א-תA-Za-z'׳\"]{2,})(?:\\s+([א-תA-Za-z]{2,}))?", "gu"));
  grab(/([א-ת]{2,})\s+\d{1,4}[א-ת]?\s*(?:,|ב[א-ת])/g);
  (knownNames || []).forEach(function (n) { String(n || "").split(/\s+/).forEach(function (p) { if (p.length >= 2) out.push(p); }); });
  // words that follow "הלקוח" / "אצל" in ordinary sentences and are not names
  var STOP = ["ליטוש", "רצפה", "רצפת", "שיש", "אבן", "בטון", "מדרגות", "פוליש", "מיסטר", "אורי", "בית", "דירה", "הבית", "בעבודה",
    "מאוד", "מאד", "מרוצה", "מרוצים", "מרוצות", "היה", "הייתה", "היתה", "אמר", "אמרה", "ביקש", "ביקשה", "רצה", "רצתה", "גם", "כבר",
    "לא", "שוב", "עצמו", "עצמה", "קיבל", "קיבלה", "שמח", "שמחה", "התלהב", "התלהבה", "אהב", "אהבה", "פרטי", "פרטית", "חדש", "חדשה"];
  return out.filter(function (w, i, a) { return a.indexOf(w) === i && STOP.indexOf(w) === -1; });
}

function forbiddenIn(s, tokens) {
  if (!s) return null;
  if (PRICE_RE.test(s)) return "price";
  if (PHONE_RE.test(s)) return "phone";
  if (STREET_RE.test(s)) return "street";
  if (HONORIFIC_RE.test(s)) return "client";
  for (var i = 0; i < tokens.length; i++) {
    if (new RegExp("(^|[^א-תA-Za-z])[ובלמשה]?" + escapeRe(tokens[i]) + "($|[^א-תA-Za-z])", "u").test(s)) return "name";
  }
  return null;
}
// Drop the sentences that carry a forbidden thing; re-check; null if anything survives.
function sanitize(s, tokens, max) {
  s = clean(s, 4000);
  if (!s) return { value: null, removed: [] };
  var removed = [];
  var kept = s.split(/(?<=[.!?…\n])\s*/u).filter(function (sentence) {
    var why = forbiddenIn(sentence, tokens);
    if (why) removed.push(why);
    return !why;
  }).join(" ").replace(/\s+\n/g, "\n").trim();
  kept = clean(kept, max);
  if (kept && forbiddenIn(kept, tokens)) return { value: null, removed: removed.concat("rejected") };
  return { value: kept, removed: removed };
}

// ---------------------------------------------------------------------------
// City (D7): only if the user said it; a city, never a street or a number
// ---------------------------------------------------------------------------
function normHe(s) { return String(s || "").replace(/[׳'"״\-–]/g, " ").replace(/\s+/g, " ").trim(); }
function acceptCity(candidate, sourceText) {
  var c = clean(candidate, LIMITS.city);
  if (!c) return null;
  c = c.replace(/^(?:ב|ל|מ)(?=[א-ת]{3,})/, function (p, off, str) { return str.length > 3 && normHe(sourceText).indexOf(str) === -1 && normHe(sourceText).indexOf(str.slice(1)) !== -1 ? "" : p; });
  if (CITY_BAD_RE.test(c) || c.split(" ").length > 3) return null;
  var src = " " + normHe(sourceText) + " ";
  var city = normHe(c);
  var stated = new RegExp("[\\s,.(]([בלמה]|מה)?" + escapeRe(city) + "(?=[\\s,.)!?]|$)", "u").test(src);
  return stated ? city : null;
}

// ---------------------------------------------------------------------------
// Pairing: validate the AI's pairs, else fall back to file names / upload order
// ---------------------------------------------------------------------------
function validPairs(images) {
  var byPair = {};
  images.forEach(function (im) { if (im.role !== "detail" && im.pair_no != null) (byPair[im.pair_no] = byPair[im.pair_no] || []).push(im.role); });
  var pairs = Object.keys(byPair);
  if (!pairs.length) return false;
  return pairs.every(function (k) { var r = byPair[k]; return r.length === 2 && r.indexOf("before") !== -1 && r.indexOf("after") !== -1; }) &&
    images.every(function (im) { return im.role === "detail" ? true : im.pair_no != null; });
}
// When the AI's pairs aren't usable but its per-image roles are confident and balanced (as many
// befores as afters), keep the roles and re-pair within them: the AI's own pair numbers where they
// still form valid pairs, else by upload order (k-th before with k-th after).
// If the roles are unbalanced only because the AI called a before/after photo a 'detail' (seen live:
// project photos are often all before/after), the least-confident details take the missing role.
function pairWithinAiRoles(images) {
  var count = function (role) { return images.filter(function (im) { return im.role === role; }).length; };
  var diff = count("before") - count("after");
  var details = images.filter(function (im) { return im.role === "detail"; }).sort(function (a, b) { return a.confidence - b.confidence; });
  if (diff !== 0 && details.length >= Math.abs(diff)) {
    details.slice(0, Math.abs(diff)).forEach(function (im) { im.role = diff > 0 ? "after" : "before"; im.role_filled = true; });
  }
  var paired = images.filter(function (im) { return im.role === "before" || im.role === "after"; });
  if (paired.length < 2 || paired.some(function (im) { return !im.role_filled && im.confidence < ROLE_MIN_CONFIDENCE; })) return revert(images);
  var befores = paired.filter(function (im) { return im.role === "before"; }), afters = paired.filter(function (im) { return im.role === "after"; });
  if (befores.length !== afters.length) return revert(images);
  var byOrder = function (a, b) { return (a.order || 0) - (b.order || 0); };
  var byPair = function (a, b) { return (a.pair_no || 99) - (b.pair_no || 99) || byOrder(a, b); };
  befores.sort(byPair); afters.sort(byPair);
  befores.forEach(function (b, i) { b.pair_no = i + 1; afters[i].pair_no = i + 1; });
  images.forEach(function (im) { if (im.role === "detail") im.pair_no = null; delete im.role_filled; });
  return true;
}
function revert(images) {
  images.forEach(function (im) { if (im.role_filled) { im.role = "detail"; delete im.role_filled; } });
  return false;
}

function fallbackPairing(images) {
  var sorted = images.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  var BEFORE = /(^|[^a-z])(before|pre|old)([^a-z]|$)|לפני/i, AFTER = /(^|[^a-z])(after|post|new)([^a-z]|$)|אחרי/i;
  var named = sorted.filter(function (im) { return BEFORE.test(im.filename || "") || AFTER.test(im.filename || ""); });
  if (named.length === sorted.length && sorted.length >= 2) {
    var befores = sorted.filter(function (im) { return BEFORE.test(im.filename); }), afters = sorted.filter(function (im) { return AFTER.test(im.filename) && !BEFORE.test(im.filename); });
    var n = Math.min(befores.length, afters.length);
    sorted.forEach(function (im) { im.role = "detail"; im.pair_no = null; });
    for (var i = 0; i < n; i++) { befores[i].role = "before"; befores[i].pair_no = i + 1; afters[i].role = "after"; afters[i].pair_no = i + 1; }
    return "filename";
  }
  sorted.forEach(function (im, i) {
    if (i === sorted.length - 1 && sorted.length % 2 === 1) { im.role = "detail"; im.pair_no = null; return; }
    im.role = i % 2 === 0 ? "before" : "after";
    im.pair_no = Math.floor(i / 2) + 1;
  });
  return "order";
}

// ---------------------------------------------------------------------------
// Hashtags + caption
// ---------------------------------------------------------------------------
function normalizeTags(list, service, city) {
  var out = [];
  // "#בית_שמש" and "#ביתשמש" are the same tag: compare without underscores
  var key = function (t) { return t.replace(/_/g, ""); };
  var has = function (t) { return out.some(function (o) { return key(o) === key(t); }); };
  (list || []).forEach(function (t) {
    var tag = "#" + String(t || "").replace(/^#+/, "").trim().replace(/\s+/g, "_");
    if (/^#[\p{L}\p{N}_]{2,40}$/u.test(tag) && !has(tag) && !/\d{3,}/.test(tag)) out.push(tag);
  });
  var pad = (SERVICE_TAGS[service] || []).concat(BASE_TAGS);
  for (var i = 0; out.length < 6 && i < pad.length; i++) if (!has(pad[i])) out.push(pad[i]);
  out = out.slice(0, 10);
  if (city) {   // the stated city is always tagged (local search), replacing the last tag if full
    var cityTag = "#" + city.replace(/\s+/g, "_");
    if (!has(cityTag)) { if (out.length >= 10) out.pop(); out.push(cityTag); }
  }
  return out;
}
function composeCaption(body, hashtags) {
  return [body, CTA_HE, hashtags.join(" ")].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
const S = { type: "STRING" }, N = { type: "NUMBER" }, I = { type: "INTEGER" };
const nullableS = { type: "STRING", nullable: true };
const IMAGE_SCHEMA = {
  type: "OBJECT",
  properties: {
    index: I, role: { type: "STRING", enum: ROLES }, pair_no: { type: "INTEGER", nullable: true }, confidence: N,
    alt_he: S, alt_en: S,
    privacy_flags: { type: "ARRAY", items: { type: "OBJECT", properties: { type: { type: "STRING", enum: PRIVACY_TYPES }, note: S }, required: ["type", "note"] } },
    quality_flags: { type: "ARRAY", items: { type: "STRING", enum: QUALITY_FLAGS } }
  },
  required: ["index", "role", "pair_no", "confidence", "alt_he", "alt_en", "privacy_flags", "quality_flags"]
};
const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: nullableS, images: { type: "ARRAY", items: IMAGE_SCHEMA }, pairing_confidence: N,
    service: { type: "STRING", enum: SERVICES }, city: nullableS, title_he: S, title_en: S, summary_he: S, summary_en: S,
    caption_body_he: S, hashtags: { type: "ARRAY", items: S }, missing: { type: "ARRAY", items: S }
  },
  required: ["images", "pairing_confidence", "service", "city", "title_he", "title_en", "summary_he", "summary_en", "caption_body_he", "hashtags", "missing"]
};
const CORRECTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: nullableS,
    images: { type: "ARRAY", items: { type: "OBJECT", properties: { index: I, role: { type: "STRING", enum: ROLES, nullable: true }, pair_no: { type: "INTEGER", nullable: true } }, required: ["index"] } },
    service: { type: "STRING", enum: SERVICES, nullable: true }, city: nullableS,
    title_he: nullableS, title_en: nullableS, summary_he: nullableS, summary_en: nullableS,
    caption_body_he: nullableS, hashtags: { type: "ARRAY", items: S, nullable: true }
  },
  required: ["images"]
};

const RULES = [
  "HARD RULES: never write prices, amounts of money, phone numbers, client or family names, street names, house numbers or apartment numbers — in ANY field.",
  "City: fill 'city' ONLY if the user's message explicitly says the city; otherwise null and add \"city\" to missing. Never guess a city from the photos.",
  "service must be one of: " + SERVICES.join(", ") + " (floor_polish = tile/terrazzo floor polishing; crystal = crystal polish/shine; marble_stone = marble or natural stone (incl. Jerusalem stone, basalt); sealer = protective sealer; concrete = polished/smoothed concrete; bomanite = stamped concrete; stairs = staircases; other).",
  "Privacy: for EVERY image list privacy_flags for each visible face (even small or partial), car license plate, house/building/apartment number, document/screen with personal text, or other identifying detail. Describe it in the note WITHOUT copying any number or name. Empty array if none.",
  "quality_flags: blurry / dark / tilted when clearly so.",
  "alt_he / alt_en: one factual sentence (≤ 120 chars) describing the floor and the state (before/after) — no names, no places beyond the city.",
  "title_he/title_en: ≤ 60 chars. summary_he/summary_en: 2–3 sentences for the project page on the website.",
  "hashtags: 6–10 relevant Hebrew hashtags (no numbers); join words with an underscore, e.g. #ליטוש_שיש, #אבן_ירושלמית."
].join("\n");

function imageParts(images) {
  var parts = [];
  images.forEach(function (im, i) {
    parts.push({ text: "Image " + (i + 1) + ":" });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: im.ai.toString("base64") } });
  });
  return parts;
}
function readUserInput(input) {
  if (input && input.audio != null) {
    var mime = String(input.mimeType || "").split(";")[0].trim().toLowerCase();
    var buf = Buffer.isBuffer(input.audio) ? input.audio : Buffer.from(String(input.audio), "base64");
    if (!buf.length || buf.length > 15 * 1024 * 1024) throw new MediaAiError("invalid_input", "bad audio", "ההקלטה ריקה או ארוכה מדי.");
    return { kind: "audio", part: { inline_data: { mime_type: mime || "audio/ogg", data: buf.toString("base64") } }, text: "" };
  }
  var text = input && typeof input.text === "string" ? input.text.trim().slice(0, 4000) : "";
  return { kind: text ? "text" : "none", text: text ? QX.stripPhones(text) : "" };
}

async function useQuota(opts) {
  var fn = (opts && opts.consumeQuota) || function () { return consumeQuota("media_ai"); };
  var q;
  try { q = await fn(); } catch (e) {
    throw new MediaAiError("quota_unavailable", "quota check failed", "המערכת עמוסה כרגע. נסו שוב בעוד רגע.");
  }
  if (!q || !q.ok) throw new MediaAiError("quota", "daily media_ai quota used up", "הגעתם למכסת הניתוחים היומית. אפשר להמשיך מחר.");
  return q;
}
async function gemini(op, parts, schema, opts) {
  try {
    // vision with up to 10 photos needs more than the quote bot's 25 s (api/media.js has 60 s)
    return await QX.callGemini(op, parts, schema, Object.assign({ logTag: "media-ai", temperature: 0.4, timeoutMs: GEMINI_VISION_TIMEOUT_MS }, opts || {}));
  } catch (err) {
    if (err && err.code === "ai_busy") throw new MediaAiError("ai_busy", err.message, "הבינה המלאכותית עמוסה כרגע. נסו שוב בעוד כמה דקות.", { retryAfter: err.retryAfter });
    throw new MediaAiError("ai_failed", (err && err.message) || "Gemini failed", "לא הצלחנו לנתח את התמונות. נסו שוב.");
  }
}

async function prepareForAi(buffer) {
  return sharp(buffer, { failOn: "error", limitInputPixels: 100 * 1000 * 1000 }).rotate()
    .resize({ width: AI_EDGE, height: AI_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Shaping the AI's answer into a safe analysis
// ---------------------------------------------------------------------------
function flagsToDb(privacy) {
  var f = { faces: false, plates: false, house_numbers: false, documents: false, other: false, notes: [] };
  privacy.forEach(function (p) {
    if (p.type === "face") f.faces = true;
    else if (p.type === "license_plate") f.plates = true;
    else if (p.type === "house_number") f.house_numbers = true;
    else if (p.type === "document") f.documents = true;
    else f.other = true;
    if (p.note) f.notes.push(p.note);
  });
  return f;
}

function shape(raw, ctx) {
  var tokens = ctx.tokens, warnings = [];
  var field = function (name, value, max) {
    var r = sanitize(value, tokens, max);
    if (r.removed.length) warnings.push(name + ":" + r.removed.join("+"));
    return r.value;
  };
  var service = SERVICES.indexOf(raw.service) !== -1 ? raw.service : "other";

  // images (by the AI's 1-based index, mapped back to the caller's ids)
  var byIndex = {};
  (raw.images || []).forEach(function (r) { if (Number.isInteger(r.index) && r.index >= 1 && r.index <= ctx.images.length) byIndex[r.index] = r; });
  var images = ctx.images.map(function (src, i) {
    var r = byIndex[i + 1] || {};
    var privacy = (Array.isArray(r.privacy_flags) ? r.privacy_flags : []).filter(function (p) { return p && PRIVACY_TYPES.indexOf(p.type) !== -1; })
      .map(function (p) { return { type: p.type, note: clean(String(p.note || "").replace(/\d/g, "#"), LIMITS.note) || p.type }; });
    var roleFallbackAlt = SERVICE_HE[service] + " – " + (r.role === "before" ? "לפני הטיפול" : r.role === "after" ? "אחרי הטיפול" : "פרט מהעבודה");
    return {
      id: src.id, order: src.order, filename: src.filename,
      role: ROLES.indexOf(r.role) !== -1 ? r.role : "detail",
      pair_no: Number.isInteger(r.pair_no) && r.pair_no >= 1 && r.pair_no <= 50 ? r.pair_no : null,
      confidence: typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0,
      alt_he: field("alt_he#" + (i + 1), r.alt_he, LIMITS.alt) || roleFallbackAlt,
      alt_en: field("alt_en#" + (i + 1), r.alt_en, LIMITS.alt) || "Floor " + (r.role === "after" ? "after" : r.role === "before" ? "before" : "detail") + " – Mr. Polish",
      privacy_flags: privacy,
      quality_flags: (Array.isArray(r.quality_flags) ? r.quality_flags : []).filter(function (q, k, a) { return QUALITY_FLAGS.indexOf(q) !== -1 && a.indexOf(q) === k; })
    };
  });
  var pairingConfidence = typeof raw.pairing_confidence === "number" ? Math.max(0, Math.min(1, raw.pairing_confidence)) : 0;
  var pairingSource = "ai";
  images.forEach(function (im) { im.ai_role = im.role; im.ai_pair = im.pair_no; });   // what the AI said, kept for review
  if (images.length >= 2 && (pairingConfidence < PAIRING_MIN_CONFIDENCE || !validPairs(images))) {
    pairingSource = pairWithinAiRoles(images) ? "ai-roles" : fallbackPairing(images);
    warnings.push("pairing:" + pairingSource);
  }
  images.forEach(function (im) { im.ai_flags = flagsToDb(im.privacy_flags); im.flagged = im.privacy_flags.some(function (p) { return p.type !== "other"; }) || im.privacy_flags.length > 0; });

  var sourceText = [ctx.userText, raw.transcript].filter(Boolean).join("\n");
  var city = acceptCity(raw.city, sourceText);
  if (raw.city && !city) warnings.push("city:not_stated_or_invalid");
  var body = field("caption", raw.caption_body_he, LIMITS.caption);
  var hashtags = normalizeTags(raw.hashtags, service, city);
  var missing = (Array.isArray(raw.missing) ? raw.missing : []).filter(function (m) { return typeof m === "string" && m !== "city"; }).slice(0, 5);
  if (!city) missing.unshift("city");
  if (!body) missing.push("caption");
  return {
    images: images.map(function (im) { delete im.order; delete im.filename; return im; }),
    pairing_source: pairingSource, pairing_confidence: pairingConfidence,
    // anything but the AI's own confident pairs → the bot shows the pairs and asks Miri to confirm
    needs_review: pairingSource !== "ai",
    service: service, city: city,
    title_he: field("title_he", raw.title_he, LIMITS.title), title_en: field("title_en", raw.title_en, LIMITS.title),
    summary_he: field("summary_he", raw.summary_he, LIMITS.summary), summary_en: field("summary_en", raw.summary_en, LIMITS.summary),
    caption_body_he: body, hashtags: hashtags, caption_he: body ? composeCaption(body, hashtags) : null,
    transcript: raw.transcript ? QX.stripPhones(String(raw.transcript)).slice(0, 4000) : null,
    missing: missing.filter(function (m, i, a) { return a.indexOf(m) === i; }),
    warnings: warnings
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function analyzeProject(input, opts) {
  opts = opts || {};
  var images = (input && input.images) || [];
  if (!images.length) throw new MediaAiError("invalid_input", "no images", "לא התקבלו תמונות.");
  if (images.length > MAX_IMAGES) throw new MediaAiError("invalid_input", "too many images", "אפשר עד " + MAX_IMAGES + " תמונות בפרויקט.");
  var prepared = [];
  for (var i = 0; i < images.length; i++) {
    var im = images[i];
    if (!im || !im.id || !Buffer.isBuffer(im.buffer)) throw new MediaAiError("invalid_input", "bad image", "אחת התמונות לא תקינה.");
    var ai;
    try { ai = await prepareForAi(im.buffer); } catch (e) { throw new MediaAiError("invalid_input", "unreadable image", "לא הצלחנו לקרוא את אחת התמונות."); }
    prepared.push({ id: String(im.id), order: Number.isFinite(im.order) ? im.order : i, filename: im.filename ? String(im.filename) : "", ai: ai });
  }
  prepared.sort(function (a, b) { return a.order - b.order; });
  var user = readUserInput(input || {});
  await useQuota(opts);

  var prompt = [
    "You help Mr. Polish (Uri Margalit, 30 years of floor polishing and stone restoration in Israel) publish a finished project.",
    "Below are " + prepared.length + " photos of ONE project, numbered in upload order (the order may be shuffled). Today in Israel: " + (input.todayIL || QX.todayIL()) + ".",
    "For each image decide: before (the floor before the work: dull, stained, scratched, dirty, unfinished) / after (finished: clean, shiny, even, sealed) / detail (anything else). Pair each before with the after that shows the SAME spot (same floor, angle and surroundings) using pair_no 1, 2, …; details get pair_no null. 'confidence' (per image) = how sure you are of that image's ROLE. 'pairing_confidence' = how sure you are that each pair shows the same spot (before and after photos are often taken from slightly different angles — that is normal).",
    user.kind === "audio" ? "The user also sent a voice note (attached last): transcribe it into 'transcript' and use what it says." :
      user.kind === "text" ? "The user's message (use it; it is the ONLY source for the city):\n«" + user.text + "»" : "The user sent no message.",
    RULES,
    "caption_body_he (Hebrew, for Facebook/Instagram):\n" + BRAND_VOICE,
    "Output Hebrew AND English where both are asked."
  ].join("\n\n");
  var parts = [{ text: prompt }].concat(imageParts(prepared));
  if (user.kind === "audio") parts.push({ text: "Voice note:" }, user.part);
  var raw = await gemini("analyze", parts, ANALYSIS_SCHEMA, opts);
  var result = shape(raw || {}, { images: prepared, userText: user.text, tokens: sensitiveTokens(user.text + "\n" + ((raw && raw.transcript) || ""), opts.knownNames) });
  return result;
}

// Edits in plain words: "תחליף את הכיתוב", "זה לא לפני, זה אחרי", "העיר היא רעננה".
async function applyMediaCorrection(analysis, input, opts) {
  opts = opts || {};
  if (!analysis || !Array.isArray(analysis.images)) throw new MediaAiError("invalid_input", "missing analysis", "אין ניתוח לתקן.");
  var user = readUserInput(input || {});
  if (user.kind === "none") throw new MediaAiError("invalid_input", "empty correction", "מה לתקן?");
  await useQuota(opts);
  var state = {
    images: analysis.images.map(function (im, i) { return { index: i + 1, role: im.role, pair_no: im.pair_no, alt_he: im.alt_he }; }),
    service: analysis.service, city: analysis.city, title_he: analysis.title_he, summary_he: analysis.summary_he,
    caption_body_he: analysis.caption_body_he, hashtags: analysis.hashtags
  };
  var prompt = [
    "Current analysis of a Mr. Polish project (JSON):", JSON.stringify(state),
    user.kind === "audio" ? "The user's correction is the attached voice note — transcribe it into 'transcript'." : "The user's correction:\n«" + user.text + "»",
    "Return ONLY what the correction changes (leave the rest null / out). Image references like 'התמונה השנייה' = index 2. If a before becomes an after (or the opposite), give that image's new role; the system fixes its pair partner.",
    "If the correction asks to change the caption in ANY way (rewrite, shorten, lengthen, other tone, add/remove something) you MUST return a new caption_body_he — when asked to shorten, make it clearly shorter (at most about half). Same voice:\n" + BRAND_VOICE,
    "One message may ask for several changes (e.g. the city AND the caption): return all of them.",
    RULES
  ].join("\n\n");
  var parts = [{ text: prompt }];
  if (user.kind === "audio") parts.push(user.part);
  var patch = await gemini("correct", parts, CORRECTION_SCHEMA, opts) || {};

  var spoken = [user.text, patch.transcript].filter(Boolean).join("\n");
  var tokens = sensitiveTokens(spoken, opts.knownNames);
  var warnings = [];
  var next = JSON.parse(JSON.stringify(analysis));
  next.warnings = [];
  (patch.images || []).forEach(function (p) {
    var im = next.images[p.index - 1];
    if (!im) return;
    var oldRole = im.role;
    if (ROLES.indexOf(p.role) !== -1) im.role = p.role;
    if (Number.isInteger(p.pair_no) && p.pair_no >= 1) im.pair_no = p.pair_no;
    if (im.role !== oldRole && im.pair_no != null && im.role !== "detail") {
      next.images.forEach(function (o) {   // keep the pair valid: the partner takes the other role
        if (o !== im && o.pair_no === im.pair_no && o.role === im.role) o.role = im.role === "before" ? "after" : "before";
      });
    }
    if (im.role === "detail") im.pair_no = null;
  });
  if (SERVICES.indexOf(patch.service) !== -1) next.service = patch.service;
  if (patch.city) {
    var c = acceptCity(patch.city, spoken);
    if (c) next.city = c; else warnings.push("city:not_stated_or_invalid");
  }
  ["title_he", "title_en", "summary_he", "summary_en", "caption_body_he"].forEach(function (k) {
    if (patch[k] == null) return;
    var r = sanitize(patch[k], tokens, k === "caption_body_he" ? LIMITS.caption : k.indexOf("title") === 0 ? LIMITS.title : LIMITS.summary);
    if (r.removed.length) warnings.push(k + ":" + r.removed.join("+"));
    if (r.value) next[k] = r.value;
  });
  // asked to change the caption but none came back → say so (the bot tells Miri instead of pretending)
  if (/כיתוב|טקסט|caption|תקצר|לקצר|קצר יותר|ארוך יותר|להאריך את|תשכתב|לשכתב|תכתוב מחדש|תנסח/i.test(spoken) && patch.caption_body_he == null) warnings.push("caption_not_changed");
  next.hashtags = normalizeTags(Array.isArray(patch.hashtags) ? patch.hashtags : next.hashtags, next.service, next.city);
  next.caption_he = next.caption_body_he ? composeCaption(next.caption_body_he, next.hashtags) : null;
  next.missing = (next.missing || []).filter(function (m) { return !(m === "city" && next.city); });
  if (!next.city && next.missing.indexOf("city") === -1) next.missing.unshift("city");
  next.transcript = patch.transcript ? QX.stripPhones(String(patch.transcript)).slice(0, 4000) : null;
  next.warnings = warnings;
  return next;
}

module.exports = {
  analyzeProject, applyMediaCorrection, prepareForAi, MediaAiError,
  SERVICES, ROLES, PRIVACY_TYPES, CTA_HE, BRAND_VOICE,
  _internal: { sanitize, forbiddenIn, sensitiveTokens, acceptCity, validPairs, fallbackPairing, normalizeTags, composeCaption, shape, flagsToDb }
};
