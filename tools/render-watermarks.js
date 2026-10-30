#!/usr/bin/env node
// Renders the three watermark designs to transparent PNGs in assets/watermark/ (committed). The
// server (api/_media-process.js) only COMPOSITES these PNGs — it never renders text itself, because
// Vercel's runtime has no fonts and sharp's SVG text would come out as boxes.
//
//   wordmark.png — gold "MR. POLISH" in the site's display font (Playfair Display), soft shadow
//   badge.png    — the logo (marble background) in a small rounded badge with a thin gold rim
//   url.png      — a minimal "mr-polishes.com" in the site's body font (Heebo), white + soft shadow
//
// Each is drawn large (crisp when scaled to ~12% of a photo's width) with a shadow that keeps it
// readable on both dark and light floors. Re-run after changing a design:
//   node tools/render-watermarks.js        (needs Chrome + network for Google Fonts)
"use strict";
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "assets", "watermark");
const logoB64 = fs.readFileSync(path.join(ROOT, "logo.webp")).toString("base64");

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@600;700&family=Playfair+Display:wght@700;800&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; background: transparent; }
  .wm { display: inline-block; padding: 28px 36px; }
  #wordmark span {
    font: 800 132px/1 "Playfair Display", serif; letter-spacing: 6px; white-space: nowrap;
    background: linear-gradient(180deg, #f6e7b0 0%, #e2c36a 38%, #c39a3a 70%, #a77e28 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    -webkit-text-stroke: 1.5px rgba(70, 50, 10, 0.55);
    filter: drop-shadow(0 3px 6px rgba(0,0,0,0.55)) drop-shadow(0 0 2px rgba(0,0,0,0.35));
  }
  #badge .b {
    width: 300px; height: 300px; border-radius: 64px; overflow: hidden;
    border: 6px solid #d9b65a; box-shadow: 0 6px 18px rgba(0,0,0,0.45), 0 0 0 2px rgba(255,255,255,0.55);
    background: #fff url(data:image/webp;base64,${logoB64}) center / cover no-repeat;
  }
  #url span {
    font: 700 96px/1 "Heebo", sans-serif; letter-spacing: 1px; white-space: nowrap; color: rgba(255,255,255,0.96);
    text-shadow: 0 2px 4px rgba(0,0,0,0.65), 0 0 12px rgba(0,0,0,0.35);
  }
</style></head><body>
  <div class="wm" id="wordmark"><span>MR. POLISH</span></div><br>
  <div class="wm" id="badge"><div class="b"></div></div><br>
  <div class="wm" id="url"><span dir="ltr">mr-polishes.com</span></div>
</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
  await page.setContent(HTML, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const fontsOk = await page.evaluate(() => document.fonts.check('800 132px "Playfair Display"') && document.fonts.check('700 96px "Heebo"'));
  if (!fontsOk) throw new Error("web fonts did not load (network?) — refusing to render with fallback fonts");
  for (const id of ["wordmark", "badge", "url"]) {
    await page.locator("#" + id).screenshot({ path: path.join(OUT, id + ".png"), omitBackground: true });
    console.log("wrote assets/watermark/" + id + ".png");
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
