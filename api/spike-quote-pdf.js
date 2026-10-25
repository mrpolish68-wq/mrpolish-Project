// PHASE 1 SPIKE — preview-only feasibility test for server-side quote PDFs.
//
// Proves headless Chromium (puppeteer-core + @sparticuz/chromium) can render a Hebrew RTL,
// one-page A4 vector PDF on this Vercel project, with Heebo embedded locally (no Google Fonts
// fetch) and the logo inlined. FAKE DATA ONLY — no Supabase, no Telegram, no Gemini, no PII.
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
const LOGO_DATA_URI = require("../shared/quote-logo.js");

// Module-level: true only for the first request served by this instance.
let isColdStart = true;
let fontDataUri = null;

const A4_HEIGHT_PX = 1123; // 297mm at 96dpi; the .wo width (794px) is exactly 210mm

function loadFontDataUri() {
  if (!fontDataUri) {
    const buf = fs.readFileSync(path.join(__dirname, "..", "shared", "fonts", "Heebo-wght.ttf"));
    fontDataUri = "data:font/ttf;base64," + buf.toString("base64");
  }
  return fontDataUri;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Copied verbatim from admin.html's WO_CSS for a like-for-like layout comparison. buildDoc
// below differs from admin.html's only by the approved client-phone line and VAT wording.
const WO_CSS =
  ".wo,.wo *{box-sizing:border-box;margin:0;padding:0;}" +
  ".wo{color:#1a1a1a;font-family:'Heebo','Arial','Segoe UI',sans-serif;direction:rtl;padding:42px 46px;background:#fff;width:794px;}" +
  ".wo-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:3px solid #c9a23a;padding-bottom:18px;margin-bottom:22px;}" +
  ".wo-head-right{text-align:right;}" +
  ".wo-bsd{font-size:12px;color:#666;letter-spacing:1px;margin-bottom:6px;}" +
  ".wo-brand-name{font-weight:900;font-size:42px;color:#1a2a52;line-height:1.05;}" +
  ".wo-sub{font-size:16px;color:#7a6320;font-weight:600;margin-top:7px;}" +
  ".wo-contact{font-size:14px;color:#333;margin-top:9px;}" +
  ".wo-head-left{display:flex;flex-direction:column;align-items:flex-start;flex-shrink:0;}" +
  ".wo-logo{width:132px;height:90px;flex-shrink:0;overflow:hidden;}" +
  ".wo-logo img{width:100%;height:100%;object-fit:contain;border-radius:8px;display:block;}" +
  ".wo-license{font-size:13px;color:#1a2a52;font-weight:700;margin-top:8px;}" +
  ".wo-titlebar{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #1a2a52;padding-bottom:10px;margin-bottom:20px;}" +
  ".wo-title{font-weight:800;font-size:24px;color:#1a2a52;}" +
  ".wo-date{font-size:16px;color:#333;font-weight:600;}" +
  ".wo-meta{margin-bottom:20px;font-size:16px;}" +
  ".wo-field{padding:8px 2px 9px;border-bottom:1px dashed #b8b8b8;margin-bottom:11px;}" +
  ".wo-field b{color:#7a6320;margin-left:6px;}" +
  ".wo-block .lbl{font-weight:700;color:#7a6320;margin-bottom:9px;font-size:16px;}" +
  ".wo-desc{position:relative;min-height:224px;}" +
  ".wo-rules{position:absolute;top:0;left:0;right:0;}" +
  ".wo-rule{height:32px;border-bottom:1px solid #dcdcdc;}" +
  ".wo-desc-text{position:relative;line-height:32px;font-size:16px;color:#222;white-space:pre-wrap;padding:0 4px;}" +
  ".wo-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:34px;margin-top:28px;}" +
  ".wo-foot-right{width:58%;}" +
  ".wo-terms{font-size:14px;color:#333;line-height:1.95;}" +
  ".wo-terms b{color:#1a2a52;}" +
  ".wo-total{display:inline-block;margin-top:16px;background:#faf3df;border:2px solid #c9a23a;border-radius:10px;padding:13px 24px;font-size:21px;font-weight:800;color:#1a2a52;}" +
  ".wo-greet{text-align:left;font-weight:800;color:#1a2a52;font-size:18px;line-height:1.75;}" +
  ".wo-sign{display:flex;justify-content:space-between;gap:50px;margin-top:54px;font-size:16px;color:#333;font-weight:600;}";

const FAKE = {
  num: "999",
  date: "25.10.2026",
  client: "ישראל ישראלי",
  phone: "050-0000000",
  address: "רחוב הדוגמה 1, נתניה",
  desc: [
    "ליטוש שיש בסלון ובמטבח: 80 מ״ר × 75 ₪ = 6,000 ₪.",
    "הברקה קריסטלית לאחר הליטוש (כלול במחיר).",
    "מריחת סילר הגנה על כל השטח — 2 שכבות.",
    "טיפול בכתמים ובסדקים קטנים לאורך 12 מטר אורך.",
    "פינוי פסולת וניקוי סופי בסיום העבודה.",
    "משך עבודה משוער: 2–3 ימי עבודה (בדיקת מספרים: 1/2, 3.5%, 052-1234567)."
  ].join("\n"),
  total: "6,000"
};

function buildDoc(d) {
  let rules = "";
  for (let i = 0; i < 7; i++) rules += '<div class="wo-rule"></div>';
  return '' +
    '<div class="wo">' +
      '<div class="wo-head">' +
        '<div class="wo-head-right">' +
          '<div class="wo-bsd">בס"ד</div>' +
          '<div class="wo-brand-name">מיסטר פוליש</div>' +
          '<div class="wo-sub">כל עבודות הליטוש, פוליש והברקה קריסטלית</div>' +
          '<div class="wo-contact">רח׳ אהרון אהרונסון 15, נתניה | אורי: 052-9534540</div>' +
        '</div>' +
        '<div class="wo-head-left">' +
          '<div class="wo-logo"><img src="' + LOGO_DATA_URI + '" alt="מיסטר פוליש" /></div>' +
          '<div class="wo-license">עוסק פטור 023062185</div>' +
        '</div>' +
      '</div>' +
      '<div class="wo-titlebar">' +
        '<span class="wo-title">הצעת מחיר מס׳ ' + esc(d.num) + '</span>' +
        '<span class="wo-date">תאריך: ' + esc(d.date) + '</span>' +
      '</div>' +
      '<div class="wo-meta">' +
        '<div class="wo-field"><b>עבור הלקוח:</b>' + esc(d.client) + '</div>' +
        '<div class="wo-field"><b>טלפון:</b><span dir="ltr">' + esc(d.phone) + '</span></div>' +
        '<div class="wo-field"><b>כתובת:</b>' + esc(d.address) + '</div>' +
      '</div>' +
      '<div class="wo-block"><div class="lbl">תיאור העבודה ודרישת הלקוח:</div>' +
        '<div class="wo-desc"><div class="wo-rules">' + rules + '</div>' +
        '<div class="wo-desc-text">' + esc(d.desc) + '</div></div></div>' +
      '<div class="wo-foot">' +
        '<div class="wo-foot-right">' +
          '<div class="wo-terms"><b>תנאי תשלום:</b><br/>50% ביום ההגעה.<br/>40% ביום בסוף העבודה.<br/>10% לפינישים הסופיים.<br/>עוסק פטור – המחיר סופי, לא יתווסף מע"מ.</div>' +
          '<div class="wo-total">סך הכל לתשלום: ' + esc(d.total) + ' ₪</div>' +
        '</div>' +
        '<div class="wo-greet">בברכה,<br/>אורי מרגלית<br/>מיסטר פוליש</div>' +
      '</div>' +
      '<div class="wo-sign"><span>חתימת הלקוח: _________________</span><span>חתימת המבצע: _________________</span></div>' +
    '</div>';
}

function buildHtml(d) {
  return '<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="utf-8">' +
    '<style>' +
      "@font-face{font-family:'Heebo';src:url(" + loadFontDataUri() + ") format('truetype');font-weight:100 900;font-style:normal;}" +
      "@page{size:A4;margin:0;}html,body{margin:0;padding:0;background:#fff;}" +
      WO_CSS +
    '</style></head><body>' + buildDoc(d) + '</body></html>';
}

// One-page guarantee (approved rule). Stage 1: shrink only the description text (and its
// ruled lines, so they stay aligned) down to an 11px floor. Stage 2, only if a very long
// description still overflows at the floor: zoom the whole document uniformly to fit, the
// same "shrink to one page" outcome as the panel's html2canvas path.
// Runs INSIDE the page (passed to page.evaluate), so it must stay self-contained.
function fitToOnePage(maxH) {
  const wo = document.querySelector(".wo");
  const text = document.querySelector(".wo-desc-text");
  const rules = document.querySelectorAll(".wo-rule");
  let size = 16;
  const apply = function (s) {
    const lh = Math.round(s * 2);
    text.style.fontSize = s + "px";
    text.style.lineHeight = lh + "px";
    rules.forEach(function (r) { r.style.height = lh + "px"; });
  };
  while (wo.scrollHeight > maxH && size > 11) {
    size -= 0.5;
    apply(size);
  }
  let zoom = 1;
  if (wo.scrollHeight > maxH) {
    zoom = Math.floor((maxH / wo.scrollHeight) * 1000) / 1000;
    wo.style.zoom = String(zoom);
    wo.style.margin = "0 auto"; // keep the narrower zoomed page horizontally centred
  }
  const finalH = Math.ceil(wo.getBoundingClientRect().height);
  return { size: size, zoom: zoom, height: finalH, fits: finalH <= maxH };
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
      defaultViewport: { width: 794, height: A4_HEIGHT_PX, deviceScaleFactor: 1 }
    });
    launchMs = Date.now() - tLaunch;

    const tRender = Date.now();
    const page = await browser.newPage();
    await page.setContent(buildHtml(FAKE), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const fit = await page.evaluate(fitToOnePage, A4_HEIGHT_PX);

    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, pageRanges: "1" });
    renderMs = Date.now() - tRender;
    const totalMs = Date.now() - t0;

    console.log("[spike-quote-pdf] cold=" + cold + " launchMs=" + launchMs + " renderMs=" + renderMs +
      " totalMs=" + totalMs + " descFontPx=" + fit.size + " zoom=" + fit.zoom + " fits=" + fit.fits);

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
