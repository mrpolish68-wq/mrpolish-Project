// The homepage project gallery + a project page (media-projects command 6), in Chrome via playwright-core
// against a local static server. /api/site?r=gallery is MOCKED (10 projects); a project page is rendered
// by the real api/site.js (its HTML builder) and served locally. Every external request is faked/blocked.
// Desktop 1280 (inline stage) + phone 390 (the full-screen dialog) + the static fallback + RTL / EN.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, ".playwright-mcp", "site-gallery-tests");
fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".mp4": "video/mp4" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(path.normalize(ROOT)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

// 10 fake projects in the API's shape (images: the local gallery JPEGs)
const SVC = [["marble_stone", "שיש ואבן", "Marble & stone"], ["stairs", "מדרגות", "Stairs"], ["floor_polish", "ליטוש מרצפות", "Floor polishing"]];
// distinct URLs per width (?w=…, the local server ignores the query) → the tests see which one the browser picked
function im(p, k, n) { const u = "/assets/gallery/project" + p + "-" + k + n + ".jpeg"; return { s: { 480: u + "?w=480", 960: u + "?w=960", 1600: u + "?w=1600" }, jpg: u, w: 1600, h: 1200, alt: { he: "חלופי " + p + k + n, en: "alt " + p + k + n } }; }
const PROJECTS = Array.from({ length: 10 }, (_, i) => {
  const s = SVC[i % 3], p = (i % 5) + 1, two = p === 1 || p === 2 || p === 4;
  const angles = [{ before: im(p, "before", 1), after: im(p, "after", 1) }].concat(two ? [{ before: im(p, "before", 2), after: im(p, "after", 2) }] : []);
  return { slug: "proj-" + (i + 1), service: s[0], published_at: "2026-10-" + String(30 - i).padStart(2, "0") + "T10:00:00Z",
    title: { he: "פרויקט " + (i + 1), en: "Project " + (i + 1) }, summary: { he: "תיאור קצר " + (i + 1), en: "Short summary " + (i + 1) },
    city: i % 2 ? { he: "רעננה", en: "Ra'anana" } : null, serviceLabel: { he: s[1], en: s[2] }, cover: angles[0].after, coverBefore: angles[0].before, angles };
});
const site = require(path.join(ROOT, "api", "site.js"));

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " — " + detail : "")); };

async function open(browser, base, viewport, opts) {
  opts = opts || {};
  const phone = viewport.width < 500;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, locale: "he-IL" });
  await ctx.addInitScript((l) => { try { sessionStorage.setItem("mrp_splash_seen", "1"); if (l) localStorage.setItem("mrp_lang", l); } catch (e) {} }, opts.lang || null);
  const errors = [], api = [];
  await ctx.route("**/*", async (route) => {
    const u = route.request().url();
    if (/\/api\/site\?r=gallery/.test(u)) {
      api.push(u);
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (opts.apiFail) return route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, projects: PROJECTS }) });
    }
    if (/\/projects\/proj-1/.test(u)) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: site._internal.projectPage(PROJECTS[0], PROJECTS, /lang=en/.test(u) ? "en" : "he") });
    if (opts.blockMain && /\/main\.js$/.test(u)) return route.abort();
    if (u.startsWith(base)) return route.continue();
    if (/supabase\.co/.test(u)) return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "[]" });
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return { ctx, page, errors, api };
}
async function toGallery(page, base) {
  await page.goto(base + "/index.html", { waitUntil: "load" });
  // content above can still grow (lazy media) and push the section away: scroll again until it boots
  for (let i = 0; i < 12 && !(await page.getAttribute("#compare", "data-source")); i++) {
    await page.evaluate(() => document.getElementById("compare").scrollIntoView());
    await page.waitForTimeout(500);
  }
  await page.waitForSelector("#pgGrid .pcard", { timeout: 15000 });
  await page.waitForTimeout(400);
}
const noOverflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  try {
    // ============================================================ DESKTOP 1280
    const D = await open(browser, base, { width: 1280, height: 900 });
    const page = D.page;
    await toGallery(page, base);
    check("desktop: the gallery loads from /api/site?r=gallery (data-source=api)", D.api.length === 1 && (await page.getAttribute("#compare", "data-source")) === "api");
    const cols = (pg) => pg.$eval("#pgGrid", e => getComputedStyle(e).gridTemplateColumns.split(" ").length);
    check("desktop 1280: 3 columns (5 projects = 3 + 2, no lone card)", (await cols(page)) === 3);
    check("headings balanced: card titles text-wrap: balance", await page.$eval("#pgGrid .pcard__title", e => getComputedStyle(e).textWrap === "balance" || getComputedStyle(e).textWrapStyle === "balance"));
    check("cards: 8 of 10 + 'עוד פרויקטים (2)'", (await page.$$("#pgGrid .pcard")).length === 8 && /עוד פרויקטים \(2\)/.test(await page.textContent("#pgMore")) && !(await page.isHidden("#pgMore")));
    const card = await page.$eval("#pgGrid .pcard", (b) => { const i = b.querySelector(".pcard__after"); return { srcset: i.getAttribute("srcset"), sizes: i.getAttribute("sizes"), w: i.getAttribute("width"), h: i.getAttribute("height"), lazy: i.getAttribute("loading"), alt: i.alt, sliver: !!b.querySelector(".pcard__before"), text: b.textContent }; });
    check("card: responsive image (srcset 480/960, sizes, width/height, lazy) + its alt", /480w, .* 960w/.test(card.srcset) && /\(min-width: 1024px\) 370px/.test(card.sizes) && card.w === "1600" && card.h === "1200" && card.lazy === "lazy" && card.alt === "חלופי 1after1");
    check("card: title + service chip (+ the 'before' sliver, hidden from screen readers)", /פרויקט 1/.test(card.text) && /שיש ואבן/.test(card.text) && card.sliver &&
      await page.$eval("#pgGrid .pcard .pcard__before", e => e.getAttribute("aria-hidden") === "true"));
    check("card with a city: a pin + the city (and a screen-reader label)", /עיר: רעננה/.test(await page.textContent("#pgGrid li:nth-child(2) .pcard__meta")));
    check("stage: the first project, its title + link to /projects/<slug>", (await page.textContent("#pgTitle")) === "פרויקט 1" && (await page.getAttribute("#pgLink", "href")) === "/projects/proj-1" && !(await page.isHidden("#pgLink")));
    check("stage: the slider images use the srcset + width/height", /480w/.test(await page.getAttribute("#cmpAfterImg", "srcset")) && (await page.getAttribute("#cmpAfterImg", "width")) === "1600");
    check("stage: dots for a multi-angle project (2), aria-pressed", (await page.$$("#galleryDots .gallery-dot")).length === 2 && (await page.getAttribute("#galleryDots .gallery-dot", "aria-pressed")) === "true");
    await page.screenshot({ path: path.join(SHOTS, "desktop-gallery.png"), fullPage: false });

    // filters
    const chips = await page.$$eval("#pgFilters .gallery-tab", (b) => b.map(x => x.textContent + ":" + x.getAttribute("aria-pressed")));
    check("filters: 'הכל' + the 3 services present, as toggle buttons", chips.join() === "הכל:true,ליטוש מרצפות:false,שיש ואבן:false,מדרגות:false", chips.join());
    await page.click('#pgFilters [data-filter="stairs"]');
    await page.waitForTimeout(150);
    check("filter 'מדרגות' → only stairs cards (3), pressed state, announced", (await page.$$("#pgGrid .pcard")).length === 3 && (await page.getAttribute('[data-filter="stairs"]', "aria-pressed")) === "true" &&
      (await page.textContent("#pgLive")) === "3 פרויקטים" && (await page.isHidden("#pgMore")));
    await page.click('#pgFilters [data-filter="all"]');
    await page.click("#pgMore");
    await page.waitForTimeout(150);
    check("load more → all 10, focus on the first new card, the button hides", (await page.$$("#pgGrid .pcard")).length === 10 &&
      (await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-k"))) === "8" && (await page.isHidden("#pgMore")));

    // a card → the inline stage
    await page.click('#pgGrid .pcard[data-k="3"]');
    await page.waitForTimeout(700);
    check("desktop: a card loads INLINE (no dialog), the title has focus, aria-current on the card", !(await page.$eval("#pgDialog", d => d.open)) && (await page.textContent("#pgTitle")) === "פרויקט 4" &&
      (await page.evaluate(() => document.activeElement.id)) === "pgTitle" && (await page.getAttribute('#pgGrid .pcard[data-k="3"]', "aria-current")) === "true");
    check("desktop: the stage scrolled into view", await page.$eval("#pgStage", e => { const r = e.getBoundingClientRect(); return r.top >= -2 && r.top < window.innerHeight / 2; }));
    const below = await page.evaluate(() => { const hb = document.querySelector(".site-header").getBoundingClientRect().bottom, c = document.querySelector("#pgStage .compare").getBoundingClientRect(),
      badge = document.querySelector("#pgStage .compare__badge--after").getBoundingClientRect(); return { hb: Math.round(hb), top: Math.round(c.top), badge: Math.round(badge.top), r: getComputedStyle(document.querySelector("#pgStage .compare")).borderRadius }; });
    check("desktop: the image top + the 'אחרי' badge sit BELOW the sticky header (scroll-margin), rounded on all 4 corners", below.top >= below.hb && below.badge > below.hb && below.r === "22px", JSON.stringify(below));
    check("stage: the new project's images + alt", /project4-after1/.test(await page.getAttribute("#cmpAfterImg", "srcset")) && (await page.getAttribute("#cmpAfterImg", "alt")) === "חלופי 4after1");
    await page.focus(".compare__handle");
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
    check("slider: keyboard ←/→ moves it (aria-valuenow 54)", (await page.getAttribute(".compare__handle", "aria-valuenow")) === "54");
    await page.click('#galleryDots [data-angle="1"]');
    await page.waitForTimeout(400);
    check("dots: angle 2 → the second pair", /project4-after2/.test(await page.getAttribute("#cmpAfterImg", "srcset")) && (await page.getAttribute('#galleryDots [data-angle="1"]', "aria-pressed")) === "true");
    check("a11y: every visible button in the section has a name", await page.$$eval("#compare button", (b) => b.filter(x => x.offsetParent !== null && !(x.getAttribute("aria-label") || x.textContent.trim())).length === 0));

    // EN
    await page.click("#langSwitch");
    await page.waitForTimeout(500);
    const en = await page.evaluate(() => ({ dir: document.documentElement.dir, chip: document.querySelector("#pgFilters .gallery-tab").textContent, card: document.querySelector("#pgGrid .pcard__title").textContent,
      alt: document.querySelector("#pgGrid .pcard__after").alt, title: document.getElementById("pgTitle").textContent, link: document.getElementById("pgLink").getAttribute("href"), handle: document.querySelector(".compare__handle").getAttribute("aria-label") }));
    check("EN: ltr; chips, card titles, alt texts, the stage, the link (?lang=en) and the slider label in English",
      en.dir === "ltr" && en.chip === "All" && en.card === "Project 1" && en.alt === "alt 1after1" && en.title === "Project 4" && en.link === "/projects/proj-4?lang=en" && /Drag to compare/.test(en.handle), JSON.stringify(en));
    await page.screenshot({ path: path.join(SHOTS, "desktop-gallery-en.png"), fullPage: false });
    check("desktop: no horizontal scroll, no console errors", (await noOverflow(page)) && D.errors.length === 0, D.errors.slice(0, 3).join(" | "));
    await D.ctx.close();

    // ============================================================ PHONE 390
    const M = await open(browser, base, { width: 390, height: 844 });
    const mp = M.page;
    await toGallery(mp, base);
    check("phone: cards in one column, no horizontal scroll", (await mp.$eval("#pgGrid .pcard", e => e.getBoundingClientRect().width)) > 330 && (await noOverflow(mp)));
    check("phone: touch targets ≥ 44px (chips, card, load more)", (await mp.$eval("#pgFilters .gallery-tab", e => e.getBoundingClientRect().height)) >= 44 &&
      (await mp.$eval("#pgMore", e => e.getBoundingClientRect().height)) >= 44);
    check("phone: the chips scroll sideways inside their row (not the page)", await mp.$eval("#pgFilters", e => getComputedStyle(e).overflowX === "auto"));
    await mp.click('#pgGrid .pcard[data-k="1"]');
    await mp.waitForTimeout(600);
    check("phone: a card opens the FULL-SCREEN dialog with the stage inside", await mp.$eval("#pgDialog", d => d.open && d.contains(document.getElementById("pgStage")) && d.getBoundingClientRect().width >= 389));
    check("phone dialog: focus on the close button (named), the page behind can't scroll", (await mp.evaluate(() => document.activeElement.id)) === "pgClose" &&
      (await mp.getAttribute("#pgClose", "aria-label")) === "סגירה" && (await mp.evaluate(() => document.documentElement.classList.contains("pg-locked"))));
    check("phone dialog: the project shown (title + slider)", (await mp.textContent("#pgTitle")) === "פרויקט 2" && /project2-after1/.test(await mp.getAttribute("#cmpAfterImg", "srcset")));
    await mp.screenshot({ path: path.join(SHOTS, "phone-dialog.png") });
    await mp.keyboard.press("Escape");
    await mp.waitForTimeout(300);
    check("phone: Esc closes → the stage goes back, focus returns to the same card, scroll unlocked", !(await mp.$eval("#pgDialog", d => d.open)) &&
      (await mp.evaluate(() => document.getElementById("pgStageSlot").contains(document.getElementById("pgStage")))) &&
      (await mp.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-k"))) === "1" && !(await mp.evaluate(() => document.documentElement.classList.contains("pg-locked"))));
    check("phone: no console errors", M.errors.length === 0, M.errors.slice(0, 3).join(" | "));
    check("phone 390: 1 column", (await cols(mp)) === 1);
    await M.ctx.close();

    // tablet: 2 columns; phones 375 / 390: the action bar never covers the footer links at the end of the page
    const T = await open(browser, base, { width: 768, height: 1024 });
    await toGallery(T.page, base);
    check("tablet 768: 2 columns", (await cols(T.page)) === 2);
    await T.ctx.close();
    async function barClear(pg) {
      // instant (the site scrolls smoothly), twice: lazy content can still grow the page
      for (let i = 0; i < 2; i++) { await pg.evaluate(() => window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: "instant" })); await pg.waitForTimeout(500); }
      return pg.evaluate(() => {
        const bar = document.querySelector(".mobile-bar").getBoundingClientRect();
        const links = [...document.querySelectorAll("footer a")].filter(a => a.offsetParent !== null);
        const lowest = Math.max(...links.map(a => a.getBoundingClientRect().bottom));
        return { barTop: Math.round(bar.top), lowestLink: Math.round(lowest), ok: links.length > 0 && lowest <= bar.top };
      });
    }
    for (const w of [375, 390]) {
      const B = await open(browser, base, { width: w, height: 812 });
      await B.page.goto(base + "/index.html", { waitUntil: "load" });
      await B.page.waitForTimeout(600);
      const r = await barClear(B.page);
      check("home " + w + ": at the end of the page the footer links sit above the action bar", r.ok, JSON.stringify(r));
      await B.page.goto(base + "/projects/proj-1", { waitUntil: "load" });
      await B.page.waitForTimeout(400);
      const r2 = await barClear(B.page);
      check("project page " + w + ": the footer links (accessibility, privacy) sit above the action bar", r2.ok, JSON.stringify(r2));
      await B.ctx.close();
    }

    // English before the first paint (the <head> script): LTR at once, texts hidden until main.js swaps them
    const E = await open(browser, base, { width: 1280, height: 900 }, { lang: "en", blockMain: true });
    await E.page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
    const early = await E.page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, pending: document.documentElement.classList.contains("i18n-pending"),
      hidden: getComputedStyle(document.querySelector("[data-i18n]")).visibility }));
    await E.page.waitForTimeout(3300);
    const late = await E.page.evaluate(() => document.documentElement.classList.contains("i18n-pending"));
    check("EN head script: LTR + lang en before main.js; texts hidden meanwhile; a 3 s safety net if main.js never runs",
      early.dir === "ltr" && early.lang === "en" && early.pending && early.hidden === "hidden" && !late, JSON.stringify(early) + " late=" + late);
    await E.ctx.close();
    const E2 = await open(browser, base, { width: 1280, height: 900 }, { lang: "en" });
    await E2.page.goto(base + "/index.html", { waitUntil: "load" });
    check("EN with main.js: texts swapped in, revealed at once (no pending), lang-en class", await E2.page.evaluate(() => !document.documentElement.classList.contains("i18n-pending") &&
      document.documentElement.classList.contains("lang-en") && /Before/.test(document.querySelector(".compare__badge--before").textContent)));
    await E2.ctx.close();

    // ============================================================ FALLBACK
    const F = await open(browser, base, { width: 1280, height: 900 }, { apiFail: true });
    await toGallery(F.page, base);
    check("fallback: API 500 → the static 5 projects (data-source=static), JPEG images, no project-page link",
      (await F.page.getAttribute("#compare", "data-source")) === "static" && (await F.page.$$("#pgGrid .pcard")).length === 5 &&
      /assets\/gallery\/project1-after1\.jpeg$/.test(await F.page.getAttribute("#pgGrid .pcard__after", "src")) && (await F.page.isHidden("#pgLink")));
    check("fallback: the static projects keep their EN titles + the Kfar Saba city", /שיש קרמה/.test(await F.page.textContent("#pgGrid")) && /כפר סבא/.test(await F.page.textContent("#pgGrid")));
    check("fallback: no console errors", F.errors.length === 0, F.errors.slice(0, 3).join(" | "));
    await F.ctx.close();

    // ============================================================ SLOW API: no layout shift while the data arrives
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const S = await open(browser, base, vp, { delayMs: 2500 });
      await S.page.addInitScript(() => {});
      await S.page.goto(base + "/index.html", { waitUntil: "load" });
      await S.page.evaluate(() => { window.__cls = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift" }); });
      for (let i = 0; i < 8; i++) { await S.page.evaluate(() => document.getElementById("compare").scrollIntoView()); await S.page.waitForTimeout(250); }
      const before = await S.page.evaluate(() => ({ skel: document.querySelectorAll("#pgGrid .pcard-skel").length, busy: document.getElementById("pgGrid").getAttribute("aria-busy") }));
      await S.page.evaluate(() => { window.__cls = 0; });   // only what the data's arrival does from here on
      await S.page.waitForSelector("#pgGrid .pcard", { timeout: 15000 });
      await S.page.waitForTimeout(800);
      const cls = await S.page.evaluate(() => window.__cls);
      check("slow API (" + vp.width + "): placeholders hold the space (4 skeletons, aria-busy) → the data's arrival shifts the visible page by CLS < 0.05", before.skel === 4 && before.busy === "true" && cls < 0.05 &&
        (await S.page.getAttribute("#pgGrid", "aria-busy")) === null, "skel=" + before.skel + " cls=" + cls.toFixed(3));
      await S.ctx.close();
    }

    // ============================================================ PROJECT PAGE (rendered by api/site.js)
    const PG = await open(browser, base, { width: 375, height: 812 });
    await PG.page.goto(base + "/projects/proj-1", { waitUntil: "load" });
    await PG.page.waitForTimeout(400);
    check("project page: H1, the slider, 2 dots, the CTA, more projects", (await PG.page.textContent("h1")) === "פרויקט 1" && !!(await PG.page.$("#ppCompare .compare__handle")) &&
      (await PG.page.$$("#ppDots .gallery-dot")).length === 2 && !!(await PG.page.$('.pp-cta a[href^="tel:"]')) && (await PG.page.$$(".pp-more .pcard")).length === 3);
    const crumbs = await PG.page.evaluate(() => {
      const ol = document.querySelector(".pp-crumbs ol"), lis = [...ol.children], last = lis[lis.length - 1];
      const mids = lis.map(li => { const r = li.getBoundingClientRect(); return r.top + r.height / 2; });   // the linked crumbs are taller tap targets
      return { oneLine: Math.max(...mids) - Math.min(...mids) < 6, mids: mids.map(Math.round), sep: getComputedStyle(lis[0], "::after").content, ellipsis: getComputedStyle(last).textOverflow, nowrap: getComputedStyle(last).whiteSpace };
    });
    check("project page 375: breadcrumbs on ONE line, '/' glued after its item, the current title ellipsized", crumbs.oneLine && crumbs.sep === '"/"' && crumbs.ellipsis === "ellipsis" && crumbs.nowrap === "nowrap", JSON.stringify(crumbs));
    check("project page: the H1 is balanced (text-wrap: balance)", await PG.page.$eval("h1", e => getComputedStyle(e).textWrap === "balance" || getComputedStyle(e).textWrapStyle === "balance"));
    const hero = await PG.page.evaluate(() => { const i = document.getElementById("ppAfter"), l = document.querySelector('link[rel="preload"][as="image"]');
      return { cur: i.currentSrc, fp: i.getAttribute("fetchpriority"), pre: l && l.getAttribute("imagesizes"), preFp: l && l.getAttribute("fetchpriority"), preSet: l && l.getAttribute("imagesrcset") }; });
    check("project page 375 (DPR 2): the hero 'after' loads w960 — never w1600 on a phone; fetchpriority high", /w=960$/.test(hero.cur) && hero.fp === "high", JSON.stringify(hero));
    check("project page: the hero is preloaded with the SAME imagesrcset / imagesizes (phones 320px) + fetchpriority high", /max-width: 600px\) 320px/.test(hero.pre || "") && hero.preFp === "high" && /480w/.test(hero.preSet || ""), JSON.stringify(hero));
    await PG.page.click('#ppDots [data-angle="1"]');
    await PG.page.waitForTimeout(400);
    check("project page: a dot switches the angle (shared/compare.js)", /project1-after2/.test(await PG.page.getAttribute("#ppAfter", "srcset")));
    await PG.page.focus("#ppCompare .compare__handle");
    await PG.page.keyboard.press("End");
    check("project page: the slider works by keyboard", (await PG.page.getAttribute("#ppCompare .compare__handle", "aria-valuenow")) === "100");
    check("project page 375: no horizontal scroll, no console errors", (await noOverflow(PG.page)) && PG.errors.length === 0, PG.errors.slice(0, 3).join(" | "));
    await PG.page.screenshot({ path: path.join(SHOTS, "project-page-375.png"), fullPage: true });
    await PG.ctx.close();
  } catch (e) {
    console.log("HARNESS ERROR " + (e && e.stack || e));
    fail++;
  } finally {
    await browser.close();
    server.close();
  }
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  process.exitCode = fail ? 1 : 0;
})();
