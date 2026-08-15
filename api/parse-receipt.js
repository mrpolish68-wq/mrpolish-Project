// Smart Receipt Scanner — Phase 1 (see handoff.md's "Next up" section for the original
// scoping notes). Takes a photographed/uploaded receipt or invoice image (or PDF) and
// returns AI-extracted structured fields for Ori to review before saving — this endpoint
// NEVER writes to Supabase itself (no DB call, no Storage call). The admin dashboard's
// review modal pre-fills from this response, Ori corrects anything wrong, and only THEN
// does the client write the confirmed row + upload the original file — same
// "AI suggests, human confirms" shape as the content queue's AI ratings, which are
// authored once and displayed read-only, never auto-published.
//
// This is the first real external AI API call anywhere in this codebase. Every other
// "AI" surface (api/analytics-agent.js's daily tips/monthly plan) is deliberately a
// deterministic heuristic over this project's own data, specifically to avoid an API
// key/ongoing cost (see handoff.md §19) — real OCR genuinely needs a real vision model,
// so this is the one deliberate exception.
//
// Provider: Google Gemini (gemini-2.0-flash, vision + structured JSON output via
// generationConfig.responseSchema) — chosen for cost, confirmed with the project owner.
// Called via raw fetch, no SDK — this project has no package.json/npm dependencies by
// design (same convention as every other api/*.js file's raw REST calls).
//
// Auth: same real-Supabase-session pattern as check-pin-status.js / publish-now.js —
// this needs to be logged-in-Ori-only (burns real API quota per call), not public.
"use strict";

const { enforce } = require("./_rate-limit.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
// Public key, already embedded client-side in admin.html — safe to duplicate here. Used
// only to validate a caller-supplied user access_token against Supabase, never to bypass RLS.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent";

// Must match business_expense_category's live enum values exactly
// (see supabase-business-expenses-receipts.sql) — Gemini is constrained to only ever
// return one of these via generationConfig.responseSchema's enum below.
const CATEGORIES = ["חומרי עבודה/פוליש", "דלק/רכב", "שיווק/פרסום", "ציוד ותחזוקה", "הוצאות משרד", "שונות"];

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// Server-side safety net, not the primary guard — the client already downscales images
// and caps PDFs before sending (see admin.html's handleReceiptFile) to stay well under
// Vercel's ~4.5MB total request body ceiling. ~4MB of base64 text here.
const MAX_BASE64_LENGTH = 4 * 1024 * 1024;

const EXTRACTION_PROMPT =
  "You are analyzing a photo or scan of a receipt or invoice (קבלה / חשבונית) for an " +
  "Israeli floor-polishing and stone-restoration contractor business (Mr. Polish / " +
  'מיסטר פוליש), for the purpose of business expense bookkeeping. Extract the fields ' +
  "defined by the response schema from the document.\n\n" +
  "Rules:\n" +
  '- All amounts must be plain numbers (e.g. 123.45), never include a currency symbol (₪, ש"ח, etc).\n' +
  "- date must be in YYYY-MM-DD format. If the year is ambiguous or missing, use your best judgement " +
  "based on any date format conventions visible (Israeli documents are typically DD/MM/YYYY).\n" +
  "- If VAT (מע\"מ) is shown as a separate line, extract vat_amount and amount_before_vat exactly as printed. " +
  "If only a single total is shown with no VAT breakdown, leave vat_amount and amount_before_vat as null " +
  "rather than estimating them.\n" +
  "- category must be exactly one of the allowed values in the schema — pick the single best fit for what " +
  "was purchased (e.g. fuel/gas station receipts -> " + '"' + "דלק/רכב" + '"' + ", polishing materials/tools/diamond " +
  "pads/chemicals -> " + '"' + "חומרי עבודה/פוליש" + '"' + ", office supplies -> " + '"' + "הוצאות משרד" + '"' + "; if genuinely unclear, use " +
  '"' + "שונות" + '"' + ").\n" +
  "- confidence_notes: one short sentence in Hebrew naming any field you could not read with high confidence " +
  "(e.g. blurry total, torn corner covering the date). Leave it an empty string if everything is clearly legible.\n" +
  "- If a field is simply not present on the document (e.g. no invoice number printed), return null for it — " +
  "do not invent a value.";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    vendor_name: { type: "STRING", nullable: true, description: "שם בית העסק או הספק" },
    date: { type: "STRING", nullable: true, description: "תאריך העסקה, פורמט YYYY-MM-DD" },
    total_amount: { type: "NUMBER", nullable: true, description: "סכום כולל לתשלום" },
    vat_amount: { type: "NUMBER", nullable: true, description: 'סכום מע"מ, אם מופיע בנפרד' },
    amount_before_vat: { type: "NUMBER", nullable: true, description: 'סכום לפני מע"מ' },
    invoice_number: { type: "STRING", nullable: true, description: "מספר חשבונית או קבלה" },
    category: { type: "STRING", enum: CATEGORIES, description: "סיווג ההוצאה" },
    confidence_notes: { type: "STRING", nullable: true, description: "הערות לגבי שדות שלא זוהו בוודאות גבוהה" }
  },
  required: ["category"]
};

async function verifySupabaseUser(accessToken) {
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken }
  });
  if (!res.ok) return null;
  var data = await res.json();
  return data && data.id ? data : null;
}

async function callGemini(apiKey, base64Image, mimeType) {
  var body = {
    contents: [
      {
        parts: [
          { text: EXTRACTION_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1
    }
  };

  var res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body)
  });

  var data = await res.json();
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || ("Gemini request failed: " + res.status);
    throw new Error(msg);
  }

  var candidate = data.candidates && data.candidates[0];
  var part = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0];
  var text = part && part.text;
  if (!text) {
    var finishReason = candidate && candidate.finishReason;
    throw new Error("Gemini returned no content" + (finishReason ? " (finishReason: " + finishReason + ")" : ""));
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("Gemini response was not valid JSON");
  }
  return parsed;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // Tighter than the other session-gated routes — each call has a real API cost, unlike
  // the free Graph API reads the other routes make.
  if (enforce(req, res, "parse-receipt", 15, 5 * 60 * 1000)) return;

  var authHeader = req.headers.authorization || "";
  var accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    res.status(401).json({ error: "Missing session token." });
    return;
  }
  var user = await verifySupabaseUser(accessToken);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired session — please log in again." });
    return;
  }

  var apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing GOOGLE_AI_API_KEY configuration." });
    return;
  }

  var image = req.body && req.body.image;
  var mimeType = req.body && req.body.mimeType;
  if (!image || typeof image !== "string") {
    res.status(400).json({ error: "Missing receipt image." });
    return;
  }
  if (!mimeType || ALLOWED_MIME_TYPES.indexOf(mimeType) === -1) {
    res.status(400).json({ error: "סוג קובץ לא נתמך. יש להעלות תמונה (JPG/PNG/WEBP) או PDF." });
    return;
  }
  if (image.length > MAX_BASE64_LENGTH) {
    res.status(400).json({ error: "הקובץ גדול מדי לניתוח אוטומטי. ניתן למלא את הפרטים ידנית." });
    return;
  }

  console.log("[parse-receipt] user=" + user.id + " mimeType=" + mimeType + " size~=" + Math.round(image.length * 0.75 / 1024) + "KB");

  var result;
  try {
    result = await callGemini(apiKey, image, mimeType);
  } catch (err) {
    console.error("[parse-receipt] Gemini call failed: " + err.message);
    res.status(502).json({ error: "ניתוח הקבלה נכשל. ניתן למלא את הפרטים ידנית.", detail: err.message });
    return;
  }

  if (!result || CATEGORIES.indexOf(result.category) === -1) {
    console.error("[parse-receipt] unexpected result shape: " + JSON.stringify(result));
    res.status(502).json({ error: "ניתוח הקבלה החזיר תוצאה לא תקינה. ניתן למלא את הפרטים ידנית." });
    return;
  }

  res.status(200).json({
    vendor_name: result.vendor_name || null,
    date: result.date || null,
    total_amount: typeof result.total_amount === "number" ? result.total_amount : null,
    vat_amount: typeof result.vat_amount === "number" ? result.vat_amount : null,
    amount_before_vat: typeof result.amount_before_vat === "number" ? result.amount_before_vat : null,
    invoice_number: result.invoice_number || null,
    category: result.category,
    confidence_notes: result.confidence_notes || null
  });
};
