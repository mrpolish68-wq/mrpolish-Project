// PHASE 1 SPIKE — preview-only feasibility test for server-side quote PDFs.
//
// Proves headless Chromium (puppeteer-core + @sparticuz/chromium) can render a Hebrew RTL,
// one-page A4 vector PDF on this Vercel project, with Heebo embedded locally (no Google Fonts
// fetch) and the logo inlined. FAKE DATA ONLY — no Supabase, no Telegram, no Gemini, no PII.
// Since Phase 2 it renders through shared/quote-template.js, the same module admin.html uses,
// including fitToOnePage (a ruled line under every description line, 13px floor, no zoom).
// Default: 6-line description. ?mid=1: a realistic 12-line job breakdown (full ruled page).
// ?long=1: 20 lines, which does NOT fit at the 13px floor, so it shows the refusal notice
// (HTTP 422 HTML page) instead of a tiny PDF.
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
// The same file, injected into the page so fitToOnePage/layoutDescription run against the DOM.
const TEMPLATE_SRC = fs.readFileSync(require.resolve("../shared/quote-template.js"), "utf8");

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

// ?mid=1 — a realistic 12-line, 6-item job breakdown (sum = 9,000 ₪).
function fakeMid() {
  const desc = [
    "1. סלון ופינת אוכל: ליטוש שיש 45 מ״ר × 75 ₪ = 3,375 ₪.",
    "    כולל מילוי סדקים קטנים ליד היציאה למרפסת.",
    "2. מטבח: ליטוש שיש 18 מ״ר × 75 ₪ = 1,350 ₪.",
    "    הסרת כתמי שמן ליד הכיריים לפני הליטוש.",
    "3. מסדרון וכניסה: הברקה קריסטלית 22 מ״ר × 40 ₪ = 880 ₪.",
    "    הגנה על משקופי הדלתות בניילון ונייר דבק.",
    "4. חדר שינה הורים: ליטוש שיש 16 מ״ר × 75 ₪ = 1,200 ₪.",
    "    הזזת רהיטים כבדים באחריות הלקוח לפני ההגעה.",
    "5. מרפסת: חידוש בומנייט 12 מ״ר × 90 ₪ = 1,080 ₪.",
    "    כולל ניקוי בלחץ מים לפני העבודה.",
    "6. כל השטחים: מריחת סילר הגנה, 2 שכבות = 1,115 ₪.",
    "    זמן ייבוש: 24 שעות ללא הליכה עם נעליים."
  ].join("\n");
  return Object.assign({}, FAKE, { desc: desc, total: 9000 });
}

// ?long=1 — 20-line description: exceeds the one-page limit at the 13px floor.
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
    const q = new URLSearchParams((req.url || "").split("?")[1] || "");
    const variant = q.get("long") === "1" ? "long" : q.get("mid") === "1" ? "mid" : "default";
    const data = variant === "long" ? fakeLong() : variant === "mid" ? fakeMid() : FAKE;
    await page.setContent(buildHtml(data), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    await page.addScriptTag({ content: TEMPLATE_SRC });
    const fit = await page.evaluate("MrpQuoteTemplate.fitToOnePage(document)");

    if (!fit.fits) {
      // Refusal path: never ship a tiny PDF. Phase 4/5 turns this into "please shorten the text".
      renderMs = Date.now() - tRender;
      console.log("[spike-quote-pdf] cold=" + cold + " variant=" + variant + " fits=false lines=" + fit.lines +
        " maxLines=" + fit.maxLines + " renderMs=" + renderMs);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Fits-One-Page", "false");
      res.status(422).send('<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>ספייק הצעת מחיר</title>' +
        '<style>body{font-family:Arial,sans-serif;background:#fff;color:#1a1a1a;margin:0;padding:32px 16px;}' +
        '.box{max-width:560px;margin:0 auto;border:2px solid #c9a23a;border-radius:10px;padding:20px 24px;background:#faf3df;}' +
        'h1{font-size:20px;color:#1a2a52;margin:0 0 10px;}p{margin:6px 0;line-height:1.6;}</style></head><body><div class="box">' +
        '<h1>התיאור ארוך מדי לעמוד אחד — נא לקצר את התיאור</h1>' +
        '<p>שורות בתיאור: ' + fit.lines + ' · מקסימום בעמוד אחד: ' + fit.maxLines + ' (בגופן ' + fit.fontPx + 'px)</p>' +
        '<p>ה-PDF לא הופק, כדי שהטקסט לא יוקטן לגודל שקשה לקרוא.</p>' +
        '</div></body></html>');
      return;
    }

    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, pageRanges: "1" });
    renderMs = Date.now() - tRender;
    const totalMs = Date.now() - t0;

    console.log("[spike-quote-pdf] cold=" + cold + " launchMs=" + launchMs + " renderMs=" + renderMs +
      " totalMs=" + totalMs + " variant=" + variant + " descFontPx=" + fit.fontPx + " lineHeightPx=" + fit.lineHeightPx +
      " lines=" + fit.lines + " rules=" + fit.rules);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="spike-quote.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Chromium-Launch-Ms", String(launchMs));
    res.setHeader("X-Render-Ms", String(renderMs));
    res.setHeader("X-Total-Ms", String(totalMs));
    res.setHeader("X-Cold-Start", String(cold));
    res.setHeader("X-Desc-Font-Px", String(fit.fontPx));
    res.setHeader("X-Desc-Line-Height-Px", String(fit.lineHeightPx));
    res.setHeader("X-Desc-Lines", String(fit.lines));
    res.setHeader("X-Fits-One-Page", "true");
    res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error("[spike-quote-pdf] failed after " + (Date.now() - t0) + "ms: " + err.message);
    res.status(500).json({ error: "spike render failed", detail: err.message, launchMs: launchMs, cold: cold });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
};
