// The review-request link (media-projects decision D10): https://mr-polishes.com/?review=1 (or
// #write-review) opens the existing write-a-review modal, in Hebrew and English, without the splash.
// Playwright (playwright-core + installed Chrome) against a local static server; every external
// request is blocked (Supabase returns []). Nothing is submitted.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  let p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (p.endsWith(path.sep)) p = path.join(p, "index.html");
  if (!p.startsWith(path.normalize(ROOT)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };

  async function open(url, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport: { width: opts.width || 375, height: 812 }, isMobile: (opts.width || 375) < 800 });
    if (opts.lang) await ctx.addInitScript((l) => { try { localStorage.setItem("mrp_lang", l); } catch (e) {} }, opts.lang);
    await ctx.route("**/*", (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/supabase\.co/.test(u)) return route.fulfill({ status: 200, headers: Object.assign({ "content-type": "application/json" }, CORS), body: "[]" });
      return route.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const st = await page.evaluate(() => ({
      modalOpen: !document.getElementById("reviewModal").hidden,
      preloader: !!document.getElementById("preloader") && getComputedStyle(document.getElementById("preloader")).display !== "none",
      title: document.getElementById("reviewModalTitle").textContent.trim(),
      focusInModal: document.getElementById("reviewModal").contains(document.activeElement),
      formShown: !document.getElementById("reviewFormState").hidden,
      lang: document.documentElement.lang,
      bodyLocked: document.body.style.overflow === "hidden"
    }));
    await ctx.close();
    return Object.assign(st, { errors });
  }

  let s = await open("/index.html?review=1");
  check("?review=1 → the write-a-review modal is open (form state)", s.modalOpen && s.formShown, JSON.stringify(s));
  check("?review=1 → no splash in front of it", !s.preloader);
  check("?review=1 → focus is inside the modal, page scroll locked (a11y)", s.focusInModal && s.bodyLocked);
  check("?review=1 → Hebrew title 'כתיבת ביקורת'", s.title === "כתיבת ביקורת" && s.lang === "he", s.title);
  check("no script errors", s.errors.length === 0, s.errors.join(" | "));

  s = await open("/index.html#write-review");
  check("#write-review → the modal is open too", s.modalOpen && !s.preloader);

  s = await open("/index.html?utm_source=whatsapp&review=1", { width: 1280 });
  check("?…&review=1 with other params, desktop → open", s.modalOpen);

  s = await open("/index.html?review=1", { lang: "en" });
  check("English: the modal opens with 'Write a review'", s.modalOpen && s.title === "Write a review" && s.lang === "en", s.title);

  s = await open("/index.html");
  check("a normal visit → the modal stays closed", !s.modalOpen);
  s = await open("/index.html?review=0");
  check("?review=0 → closed", !s.modalOpen);
  s = await open("/index.html?review=12");
  check("?review=12 → closed (exact match only)", !s.modalOpen);

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  await browser.close();
  server.close();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.log("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; process.exit(1); });
