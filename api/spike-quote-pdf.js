// PHASE 1 SPIKE — preview-only feasibility test for server-side quote PDFs.
//
// Proves headless Chromium (puppeteer-core + @sparticuz/chromium) can render a Hebrew RTL,
// one-page A4 vector PDF on this Vercel project, with Heebo embedded locally (no Google Fonts
// fetch) and the logo inlined. FAKE DATA ONLY — no Supabase, no Telegram, no Gemini, no PII.
// Since Phase 2 it renders through shared/quote-template.js, the same module admin.html uses.
// ?long=1 renders a ~20-line description to exercise the one-page auto-fit.
//
// Hard-gated to VERCEL_ENV === "preview": returns 404 in production and locally, so it can
// never run on the live site even if this file is accidentally merged. Delete this file once
// the real renderer (api/render-quote-pdf.js) exists.
//
// Timing headers: X-Chromium-Launch-Ms, X-Render-Ms, X-Total-Ms, X-Cold-Start. Logs carry
// timings only, never document content.
"use strict";

const fs = require("fs");
const path = require("path");
const T = require("../shared/quote-template.js");

// Module-level: true only for the first request served by this instance.
let isColdStart = true;
let fontDataUri = null;

function loadFontDataUri() {
  if (!fontDataUri) {
    const buf = fs.readFileSync(path.join(__dirname, "..", "shared", "fonts", "Heebo-wght.ttf"));
    fontDataUri = "data:font/ttf;base64," + buf.toString("base64");
  }
  return fontDataUri;
}

// FAKE data only, in the same shape admin.html passes to buildDoc (total is a number).
const FAKE = {
  num: "999",
  date: "25.10.2026",
  client: "ישראל ישראלי",
  address: "רחוב הדוגמה 1, נתניה",
  desc: [
    "ליטוש שיש בסלון ובמטבח: 80 מ״ר × 75 ₪ = 6,000 ₪.",
    "הברקה קריסטלית לאחר הליטוש (כלול במחיר).",
    "מריחת סילר הגנה על כל השטח — 2 שכבות.",
    "טיפול בכתמים ובסדקים קטנים לאורך 12 מטר אורך.",
    "פינוי פסולת וניקוי סופי בסיום העבודה.",
    "משך עבודה משוער: 2–3 ימי עבודה (בדיקת מספרים: 1/2, 3.5%, 052-1234567)."
  ].join("\n"),
  total: 6000,
  vat_mode: "exempt"
};

// ?long=1 — ~20-line description to exercise the one-page auto-fit.
function fakeLong() {
  const lines = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(i + ". ליטוש והברקה של אזור " + i + " — " + (10 + i) + " מ״ר × 70 ₪, כולל מריחת סילר הגנה וטיפול בכתמים.");
  }
  return Object.assign({}, FAKE, { desc: lines.join("\n"), total: 24500 });
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

module.exports = async function handler(req, res) {
  if (process.env.VERCEL_ENV !== "preview") {
    res.status(404).send("Not found");
    return;
  }

  const t0 = Date.now();
  const cold = isColdStart;
  isColdStart = false;
  let browser = null;
  let launchMs = 0;
  let renderMs = 0;

  try {
    // Both packages are ESM-only in these versions; this file stays CommonJS like every other api/*.js.
    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteer = (await import("puppeteer-core")).default;

    const tLaunch = Date.now();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: 794, height: T.A4_HEIGHT_PX, deviceScaleFactor: 1 }
    });
    launchMs = Date.now() - tLaunch;

    const tRender = Date.now();
    const page = await browser.newPage();
    const long = /(?:^|[?&])long=1(?:&|$)/.test((req.url || "").split("?")[1] || "");
    await page.setContent(buildHtml(long ? fakeLong() : FAKE), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    // fitToOnePage is self-contained, so its source runs in the page as-is.
    const fit = await page.evaluate("(" + T.fitToOnePage.toString() + ")(document, " + T.A4_HEIGHT_PX + ")");

    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, pageRanges: "1" });
    renderMs = Date.now() - tRender;
    const totalMs = Date.now() - t0;

    console.log("[spike-quote-pdf] cold=" + cold + " launchMs=" + launchMs + " renderMs=" + renderMs +
      " totalMs=" + totalMs + " long=" + long + " descFontPx=" + fit.size + " zoom=" + fit.zoom + " fits=" + fit.fits);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="spike-quote.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Chromium-Launch-Ms", String(launchMs));
    res.setHeader("X-Render-Ms", String(renderMs));
    res.setHeader("X-Total-Ms", String(totalMs));
    res.setHeader("X-Cold-Start", String(cold));
    res.setHeader("X-Desc-Font-Px", String(fit.size));
    res.setHeader("X-Zoom", String(fit.zoom));
    res.setHeader("X-Fits-One-Page", String(fit.fits));
    res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error("[spike-quote-pdf] failed after " + (Date.now() - t0) + "ms: " + err.message);
    res.status(500).json({ error: "spike render failed", detail: err.message, launchMs: launchMs, cold: cold });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
