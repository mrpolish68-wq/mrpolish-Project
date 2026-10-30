// The public lead form (index.html + main.js §3), Playwright (playwright-core + installed Chrome)
// against a local static server. Supabase's /rest/v1/leads is MOCKED with controllable delays and
// statuses; every other external request is blocked. No lead reaches the real database.
// Covers the 2026-10-30 hotfix: keepalive on the insert, a fallback when a browser refuses
// keepalive, and a redirect that waits for the insert (min 400 ms, max 3 s).
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

// Records every leads fetch (incl. its keepalive flag) and window.open; can make keepalive throw.
const INIT = `(() => {
  window.__leadFetches = [];
  window.__opened = [];
  window.open = function (u) { window.__opened.push(String(u)); return null; };
  const orig = window.fetch.bind(window);
  window.fetch = function (url, init) {
    if (/\\/rest\\/v1\\/leads/.test(String(url))) {
      window.__leadFetches.push({ keepalive: !!(init && init.keepalive), body: init && init.body });
      try { sessionStorage.setItem("__leadFetches", JSON.stringify(window.__leadFetches)); } catch (e) {}
      if (init && init.keepalive && localStorage.getItem("__refuseKeepalive") === "1") {
        return Promise.reject(new TypeError("Failed to fetch (keepalive refused)"));
      }
    }
    return orig(url, init);
  };
  try { localStorage.setItem("mrp_lang", "he"); } catch (e) {}
})();`;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" };

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };

  async function run(opts) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await ctx.addInitScript(INIT);
    if (opts.refuseKeepalive) await ctx.addInitScript(() => { try { localStorage.setItem("__refuseKeepalive", "1"); } catch (e) {} });
    const posts = [];
    await ctx.route("**/*", async (route) => {
      const req = route.request(), url = req.url();
      if (url.startsWith(base)) return route.continue();
      if (/supabase\.co\/rest\/v1\/leads/.test(url)) {
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
        posts.push({ t: Date.now(), body: req.postDataJSON() });
        await new Promise(r => setTimeout(r, opts.delay));
        return route.fulfill({ status: opts.status || 201, headers: CORS, body: opts.status && opts.status >= 400 ? '{"message":"denied"}' : "" }).catch(() => {});
      }
      if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, headers: Object.assign({ "content-type": "application/json" }, CORS), body: "[]" });
      return route.abort();
    });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { const p = document.getElementById("preloader"); if (p) p.remove(); });
    await page.fill("#lf-name", "בדיקה – למחוק");
    await page.fill("#lf-phone", "050-0000000");
    await page.selectOption("#lf-service", { index: 0 });
    await page.fill("#lf-message", "בדיקת מערכת");
    await page.check("#lf-privacy-consent");
    const t0 = Date.now();
    await page.$eval("#leadForm", (f) => f.requestSubmit());
    const opened = await page.evaluate(() => window.__opened.slice());
    await page.waitForURL(/thankyou\.html/, { timeout: 15000 });
    const redirectMs = Date.now() - t0;
    const fetches = await page.evaluate(() => JSON.parse(sessionStorage.getItem("__leadFetches") || "[]"));
    await ctx.close();
    return { redirectMs, posts, fetches, opened, consoleErrors, firstPostMs: posts[0] ? posts[0].t - t0 : null };
  }

  // 1. fast insert
  let r = await run({ delay: 50 });
  check("fast: exactly one insert reaches Supabase", r.posts.length === 1, String(r.posts.length));
  check("fast: the insert is sent with keepalive: true", r.fetches.length === 1 && r.fetches[0].keepalive === true, JSON.stringify(r.fetches.map(f => f.keepalive)));
  check("fast: payload unchanged (name, phone, location null, service, notes + consent line)", r.posts[0] && r.posts[0].body.name === "בדיקה – למחוק" &&
    r.posts[0].body.phone === "050-0000000" && r.posts[0].body.location === null && !!r.posts[0].body.service && /\[הסכמה לדיוור שיווקי: לא\]/.test(r.posts[0].body.notes),
    JSON.stringify(r.posts[0] && r.posts[0].body));
  check("fast: redirect waits the minimum 400 ms, not longer", r.redirectMs >= 380 && r.redirectMs < 1500, r.redirectMs + "ms");
  check("fast: WhatsApp is still opened first, inside the submit gesture", r.opened.length === 1 && /^https:\/\/wa\.me\/972529534540\?text=/.test(r.opened[0]), r.opened[0]);
  // (external fonts/scripts are blocked on purpose, so "Failed to load resource" lines are expected)
  const scriptErrors = r.consoleErrors.filter(e => !/^Failed to load resource/.test(e));
  check("fast: no script errors in the console", scriptErrors.length === 0, scriptErrors.join(" | "));

  // 2. slow insert (1.8 s): the redirect waits for it (the old code redirected at 400 ms and aborted it)
  r = await run({ delay: 1800 });
  check("slow: redirect waits for the insert to finish", r.redirectMs >= 1750 && r.redirectMs < 3000, r.redirectMs + "ms");
  check("slow: one insert, keepalive", r.posts.length === 1 && r.fetches[0].keepalive === true);

  // 3. very slow insert (6 s): redirect at the 3 s cap; keepalive carries the request on
  r = await run({ delay: 6000 });
  check("very slow: redirect at the 3 s cap (never stuck on the form)", r.redirectMs >= 2900 && r.redirectMs < 4000, r.redirectMs + "ms");
  check("very slow: the insert was sent (keepalive) before the redirect", r.posts.length === 1 && r.firstPostMs !== null && r.firstPostMs < 1000 && r.fetches[0].keepalive === true);

  // 4. a browser that refuses keepalive (CORS-preflighted keepalive) → falls back to a normal fetch
  r = await run({ delay: 50, refuseKeepalive: true });
  check("keepalive refused: falls back to a normal fetch (2 attempts, 2nd without keepalive)", r.fetches.length === 2 && r.fetches[0].keepalive === true && r.fetches[1].keepalive === false,
    JSON.stringify(r.fetches.map(f => f.keepalive)));
  check("keepalive refused: exactly one insert reaches Supabase", r.posts.length === 1, String(r.posts.length));
  check("keepalive refused: redirect still after ~400 ms", r.redirectMs >= 380 && r.redirectMs < 1500, r.redirectMs + "ms");

  // 5. Supabase rejects the insert (e.g. RLS 401) → surfaced in the console, visitor still redirected
  r = await run({ delay: 50, status: 401 });
  check("rejected insert: logged as 'Lead DB insert failed (401)', still redirected", r.consoleErrors.some(e => /Lead DB insert failed \(401\)/.test(e)) && r.redirectMs < 1500,
    r.consoleErrors.join(" | ") + " " + r.redirectMs + "ms");

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  await browser.close();
  server.close();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.log("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; process.exit(1); });
