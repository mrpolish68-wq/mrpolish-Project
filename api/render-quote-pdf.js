// Production quote PDF renderer (Telegram quotes, Phase 4a). It replaced the Phase 1 spike (deleted in Phase 7a).
//
// POST { quote_id } -> renders the stored quote through shared/quote-template.js (the same
// module admin.html uses) as ONE vector A4 page with headless Chromium (puppeteer-core +
// @sparticuz/chromium), Heebo embedded from shared/fonts/ (no Google Fonts fetch), then:
//   1. uploads it to the private "quotes-pdf" bucket at the deterministic path <quote id>.pdf
//      (upsert, so a regenerated PDF overwrites the old one and never leaves an orphan);
//   2. sets quotes.pdf_path in an update that sets NOTHING else, so the quotes_before_update
//      trigger keeps it (see supabase-quotes-telegram.sql §2). The update is conditioned on the
//      row's updated_at as loaded: if the quote was edited while rendering, nothing is linked
//      and the caller gets 409 (re-render);
//   3. returns the PDF bytes (application/pdf) + X-Pdf-Path.
// If the description doesn't fit one page at the 13px floor (fitToOnePage -> fits:false), it
// returns 422 { error:"too_long", lines, maxLines } and stores nothing. Never zooms.
//
// Auth: EITHER X-Internal-Secret == INTERNAL_API_SECRET (server-to-server, e.g. the Telegram
// webhook; constant-time compare) OR a real Supabase session (Authorization: Bearer <access
// token>, verified against /auth/v1/user, same as parse-receipt.js). Otherwise 401.
//
// Test-only (VERCEL_ENV !== "production", which includes local runs):
//   { test_data: { num, date, client, address, desc, total, vat_mode } } renders fake data;
//   { quote_id, dry_run: true } loads + renders a real quote read-only.
// Neither touches Storage or writes to the DB. In production both are rejected with 400.
//
// Local runs: @sparticuz/chromium only works on Linux, so outside Vercel the function uses
// LOCAL_CHROME_PATH (e.g. the installed Chrome) when it is set.
//
// Logs: timings, mode and status codes only, never quote content, ids or tokens.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { enforce } = require("./_rate-limit.js");
const T = require("../shared/quote-template.js");
// The same file, injected into the page so fitToOnePage/layoutDescription run against the DOM.
const TEMPLATE_SRC = fs.readFileSync(require.resolve("../shared/quote-template.js"), "utf8");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
// Public key, already embedded client-side in admin.html (same as parse-receipt.js). Used only
// to validate a caller-supplied user access_token, never to read data.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";
const BUCKET = "quotes-pdf";
// Only the columns the template needs, plus updated_at for the "edited while rendering" guard.
const QUOTE_COLUMNS = "id,number,quote_date,client_name,address,description,total,vat_mode,updated_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SECRET_LENGTH = 32; // a short/empty INTERNAL_API_SECRET disables the secret path
const FETCH_TIMEOUT_MS = 10000;
// Caps for test_data fields (fake data only, but still bounded).
const TEST_FIELD_MAX = { num: 10, date: 20, client: 200, address: 300, desc: 5000, vat_mode: 20 };

let isColdStart = true; // true only for the first request served by this instance
let fontDataUri = null;

function safeEqual(a, b) {
  var bufA = Buffer.from(String(a || ""), "utf8");
  var bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function loadFontDataUri() {
  if (!fontDataUri) {
    const buf = fs.readFileSync(path.join(__dirname, "..", "shared", "fonts", "Heebo-wght.ttf"));
    fontDataUri = "data:font/ttf;base64," + buf.toString("base64");
  }
  return fontDataUri;
}

// The embedded Heebo @font-face is added on the server path only; the panel uses Google Fonts.
function buildHtml(d) {
  return '<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    '<style>' +
      "@font-face{font-family:'Heebo';src:url(" + loadFontDataUri() + ") format('truetype');font-weight:100 900;font-style:normal;}" +
      "@page{size:A4;margin:0;}html,body{margin:0;padding:0;background:#fff;}" +
      T.WO_CSS +
    '</style></head><body>' + T.buildDoc(d, T.LOGO_DATA_URI) + '</body></html>';
}

// DB row -> buildDoc data, exactly as admin.html maps a history row (pad3 number, "—" blanks).
function rowToDocData(row) {
  return {
    num: String(row.number).padStart(3, "0"),
    date: row.quote_date,
    client: row.client_name,
    address: row.address || "—",
    desc: row.description || "—",
    total: row.total,
    vat_mode: row.vat_mode
  };
}

// test_data -> buildDoc data. Returns null when the shape is wrong.
function testDataToDocData(td) {
  if (!td || typeof td !== "object" || Array.isArray(td)) return null;
  var out = {};
  var keys = Object.keys(TEST_FIELD_MAX);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = td[k];
    if (v == null) { out[k] = ""; continue; }
    if (typeof v !== "string" && typeof v !== "number") return null;
    v = String(v);
    if (v.length > TEST_FIELD_MAX[k]) return null;
    out[k] = v;
  }
  var total = Number(td.total);
  if (!isFinite(total) || total < 0) return null;
  out.total = total;
  out.num = out.num || "999";
  out.vat_mode = out.vat_mode || "exempt";
  out.address = out.address || "—";
  out.desc = out.desc || "—";
  return out;
}

function serviceHeaders(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key }, extra || {});
}

async function verifySupabaseUser(accessToken) {
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) return null;
  var data = await res.json();
  return data && data.id ? data : null;
}

// Returns the row, null when it doesn't exist, or throws on a DB error. Never logs the body.
async function loadQuote(id) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/quotes?id=eq." + id + "&select=" + QUOTE_COLUMNS + "&limit=1", {
    headers: serviceHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error("quote load failed: HTTP " + res.status);
  var rows = await res.json();
  return rows && rows[0] ? rows[0] : null;
}

async function uploadPdf(objectPath, pdfBuf) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + objectPath, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/pdf", "x-upsert": "true", "Cache-Control": "no-store" }),
    body: pdfBuf,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error("storage upload failed: HTTP " + res.status);
}

// Sets pdf_path and nothing else, only if the row is unchanged since it was loaded.
// Returns true when the row was updated, false when it was edited (or deleted) meanwhile.
async function linkPdfPath(id, loadedUpdatedAt, objectPath) {
  var res = await fetch(
    SUPABASE_URL + "/rest/v1/quotes?id=eq." + id + "&updated_at=eq." + encodeURIComponent(loadedUpdatedAt) + "&select=id", {
      method: "PATCH",
      headers: serviceHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ pdf_path: objectPath }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  if (!res.ok) throw new Error("pdf_path update failed: HTTP " + res.status);
  var rows = await res.json();
  return Array.isArray(rows) && rows.length === 1;
}

async function launchBrowser() {
  // Both packages are ESM-only in these versions; this file stays CommonJS like every other api/*.js.
  const puppeteer = (await import("puppeteer-core")).default;
  const viewport = { width: 794, height: T.A4_HEIGHT_PX, deviceScaleFactor: 1 };
  if (!process.env.VERCEL && process.env.LOCAL_CHROME_PATH) {
    return puppeteer.launch({ executablePath: process.env.LOCAL_CHROME_PATH, headless: true, defaultViewport: viewport });
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
    defaultViewport: viewport
  });
}

// Renders one A4 page. Returns { fit, pdf } where pdf is null when the description doesn't fit.
async function renderPdf(browser, docData) {
  const page = await browser.newPage();
  await page.setContent(buildHtml(docData), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ content: TEMPLATE_SRC });
  const fit = await page.evaluate("MrpQuoteTemplate.fitToOnePage(document)");
  if (!fit.fits) return { fit: fit, pdf: null };
  const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, pageRanges: "1" });
  return { fit: fit, pdf: Buffer.from(pdf) };
}

async function isAuthorized(req) {
  var provided = req.headers["x-internal-secret"];
  if (provided) {
    var secret = process.env.INTERNAL_API_SECRET || "";
    return secret.length >= MIN_SECRET_LENGTH && safeEqual(provided, secret);
  }
  var accessToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!accessToken) return false;
  return !!(await verifySupabaseUser(accessToken));
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  const cold = isColdStart;
  isColdStart = false;
  let mode = "-";
  let status = 500;
  let launchMs = 0;
  let renderMs = 0;
  let storeMs = 0;
  let lines = "-";
  let browser = null;

  function reply(code, body) {
    status = code;
    res.setHeader("Cache-Control", "no-store");
    res.status(code).json(body);
  }

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      reply(405, { error: "Method not allowed" });
      return;
    }
    // Before auth, so a secret/token guessing burst is throttled too.
    if (enforce(req, res, "render-quote-pdf", 30, 5 * 60 * 1000)) { status = 429; return; }

    if (!(await isAuthorized(req))) {
      reply(401, { error: "Unauthorized" });
      return;
    }

    var body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { body = null; }
    }
    if (!body || typeof body !== "object") {
      reply(400, { error: "Invalid JSON body" });
      return;
    }

    var testMode = process.env.VERCEL_ENV !== "production";
    var docData;
    var row = null;

    if (body.test_data !== undefined) {
      mode = "test_data";
      if (!testMode) { reply(400, { error: "test_data is not available in production" }); return; }
      docData = testDataToDocData(body.test_data);
      if (!docData) { reply(400, { error: "Invalid test_data" }); return; }
    } else {
      var quoteId = body.quote_id;
      mode = body.dry_run === true ? "dry_run" : "quote";
      if (mode === "dry_run" && !testMode) { reply(400, { error: "dry_run is not available in production" }); return; }
      if (typeof quoteId !== "string" || !UUID_RE.test(quoteId)) { reply(400, { error: "Invalid quote_id" }); return; }
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { reply(500, { error: "Server is missing SUPABASE_SERVICE_ROLE_KEY configuration." }); return; }
      row = await loadQuote(quoteId);
      if (!row) { reply(404, { error: "not_found" }); return; }
      docData = rowToDocData(row);
    }

    var tLaunch = Date.now();
    browser = await launchBrowser();
    launchMs = Date.now() - tLaunch;

    var tRender = Date.now();
    var out = await renderPdf(browser, docData);
    renderMs = Date.now() - tRender;
    lines = out.fit.lines;

    if (!out.pdf) {
      reply(422, { error: "too_long", lines: out.fit.lines, maxLines: out.fit.maxLines });
      return;
    }

    var objectPath = null;
    if (mode === "quote") {
      objectPath = row.id + ".pdf";
      var tStore = Date.now();
      await uploadPdf(objectPath, out.pdf);
      var linked = await linkPdfPath(row.id, row.updated_at, objectPath);
      storeMs = Date.now() - tStore;
      if (!linked) {
        reply(409, { error: "quote_changed" });
        return;
      }
    }

    status = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="quote.pdf"');
    res.setHeader("Cache-Control", "no-store");
    if (objectPath) res.setHeader("X-Pdf-Path", objectPath);
    res.setHeader("X-Desc-Lines", String(out.fit.lines));
    res.setHeader("X-Desc-Font-Px", String(out.fit.fontPx));
    res.status(200).send(out.pdf);
  } catch (err) {
    // err.message here is ours (HTTP status) or Chromium's; neither carries quote content.
    console.error("[render-quote-pdf] error: " + err.message);
    reply(500, { error: "render_failed" });
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log("[render-quote-pdf] status=" + status + " mode=" + mode + " cold=" + cold + " launchMs=" + launchMs +
      " renderMs=" + renderMs + " storeMs=" + storeMs + " totalMs=" + (Date.now() - t0) + " lines=" + lines);
  }
};
