// Burst guard in admin.html (handoff §33), Playwright (playwright-core + installed Chrome) against a
// local static server. The Supabase client is a STUB (content_queue rows in memory); /api/publish-now
// is mocked. Nothing reaches Supabase or Meta.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(path.normalize(ROOT)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

const STUB = `(() => {
  localStorage.setItem("sb-mmognkxkglkotzkuxzly-auth-token", "stub");
  const H = 3600 * 1000, D = 24 * H, now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const mk = (id, title, kind, at, status) => ({ id, title, caption: "c", platform: "both", media_type: kind === "R" ? "reel" : "image",
    content_category: kind === "R" ? "reel" : "post", media_url: "/logo.webp", scheduled_for: iso(at), status: status || "pending_approval",
    publish_attempts: 0, fb_post_id: null, ig_post_id: null, pin_requested: false, created_at: iso(now - 30 * D) });
  const S = window.__sb = { seq: 0, updates: [], rows: [
    mk("A", "ישן א רילס", "R", now - 5 * D), mk("B", "ישן ב פוסט", "P", now - 4 * D), mk("C", "ישן ג רילס", "R", now - 3 * D),
    mk("D", "עתידי ד", "P", now + 2 * D), mk("E", "מאושר קיים", "P", now + 3 * D, "approved"),
    mk("F", "בודד ו", "P", now - 1 * D), mk("G", "בודד ז", "P", now - 2 * H), mk("K", "לדחייה", "P", now + 5 * D)
  ] };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function resolve(q) {
    const has = (op) => q.ops.find(o => o[0] === op);
    if (q.table === "content_queue") {
      const upd = has("update");
      if (upd) {
        let rows = S.rows;
        const filters = [];
        q.ops.forEach(([op, args]) => {
          if (op === "eq") { rows = rows.filter(r => r[args[0]] === args[1]); filters.push("eq:" + args[0] + "=" + args[1]); }
          if (op === "in") { rows = rows.filter(r => args[1].includes(r[args[0]])); filters.push("in:" + args[0] + "=" + args[1].join(",")); }
          if (op === "gt") { rows = rows.filter(r => new Date(r[args[0]]) > new Date(args[1])); filters.push("gt:" + args[0]); }
        });
        rows.forEach(r => Object.assign(r, upd[1][0]));
        S.updates.push({ seq: ++S.seq, patch: upd[1][0], filters, matched: rows.map(r => r.id) });
        return Promise.resolve({ data: clone(rows), error: null });
      }
      return Promise.resolve({ data: clone(S.rows).sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for)), error: null });
    }
    return Promise.resolve({ data: [], error: null, count: 0 });
  }
  function query(table) {
    const q = { table, ops: [] };
    const b = new Proxy(function () {}, { get(t, prop) {
      if (prop === "then") return (a, c) => resolve(q).then(a, c);
      if (prop === "catch") return (c) => resolve(q).catch(c);
      if (prop === "finally") return (c) => resolve(q).finally(c);
      return (...args) => { q.ops.push([prop, args]); return b; };
    } });
    return b;
  }
  const generic = () => new Proxy(function () {}, { get(t, prop) { if (prop === "then") return undefined; return () => Promise.resolve({ data: null, error: null }); } });
  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "test@example.com" } }, error: null }),
      getSession: () => Promise.resolve({ data: { session: { access_token: "fake-access-token" } }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from: (t) => query(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    channel: () => { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel: () => Promise.resolve("ok"),
    storage: { from: () => generic() },
    functions: generic()
  };
  Object.defineProperty(window, "supabase", { configurable: false, get: () => ({ createClient: () => client }), set: () => {} });
})();`;

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
  await context.addInitScript(STUB);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  const confirms = [];
  page.on("dialog", async (d) => { confirms.push(d.message()); await d.accept(); });
  const publishNow = [];
  await page.route("**/api/publish-now", async (route) => {
    publishNow.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "x", ok: true, deferred: true, throttled: true }) });
  });
  const supabaseHits = [];
  await page.route("**/*.supabase.co/**", (route) => { supabaseHits.push(route.request().url()); route.abort(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
  const wait = (ms) => page.waitForTimeout(ms);
  const updates = () => page.evaluate(() => window.__sb.updates);
  const rowById = (id) => page.evaluate((id) => window.__sb.rows.find(r => r.id === id), id);
  const israel = (isoStr) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(isoStr));

  await page.goto(base + "/admin.html", { waitUntil: "load" });
  await page.click('button[data-view="content"]');
  await page.waitForSelector('[data-cq-approve="F"]', { timeout: 15000 });
  check("panel: content cards rendered from the stub", await page.isVisible('[data-cq-approve="F"]'));

  // ===== 1. single Approve on a past-dated row → dialog; Cancel changes nothing =====
  await page.click('[data-cq-approve="F"]');
  await page.waitForSelector("#cqPastModal:not([hidden])");
  check("single past: dialog shown with the exact Hebrew question", (await page.textContent("#cqPastText")).trim() === "התאריך של הפוסט הזה כבר עבר. לפרסם עכשיו, או לקבוע מועד חדש?");
  check("single past: three options", (await page.textContent("#cqPastNow")).includes("לפרסם עכשיו") && (await page.textContent("#cqPastPick")).includes("לבחור מועד") &&
    (await page.$$eval("#cqPastModal [data-past-close]", els => els.map(e => e.textContent.trim()))).includes("ביטול"));
  check("single past: focus moves into the dialog (a11y)", await page.evaluate(() => document.activeElement && document.activeElement.id === "cqPastNow"));
  await page.click('#cqPastModal button[data-past-close]:not(.cq-modal__close)');
  check("single past → ביטול: dialog closed, no update, no publish", (await page.isHidden("#cqPastModal")) && (await updates()).length === 0 && publishNow.length === 0);

  await page.click('[data-cq-approve="F"]');
  await page.keyboard.press("Escape");
  check("single past → Escape closes it, nothing changed", (await page.isHidden("#cqPastModal")) && (await updates()).length === 0);

  // ===== 2. "לבחור מועד": prefilled next free slot, rejects a past time, then date FIRST, status SECOND =====
  await page.click('[data-cq-approve="F"]');
  await page.click("#cqPastPick");
  check("pick: date/time picker shown", await page.isVisible("#cqPastPicker"));
  const preDate = await page.inputValue("#cqPastDate"), preTime = await page.inputValue("#cqPastTime");
  const E = await rowById("E");
  const eIsrael = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(E.scheduled_for));
  check("pick: prefilled with the next free slot after the queue (a 10/14/19 slot, after the approved post)", /^(10|14|19):00$/.test(preTime) && preDate >= eIsrael, preDate + " " + preTime + " (queue ends " + eIsrael + ")");
  await page.fill("#cqPastDate", "2020-01-01");
  await page.click("#cqPastConfirm");
  check("pick: a past date is refused with a Hebrew error, nothing saved", (await page.isVisible("#cqPastError")) && (await page.textContent("#cqPastError")).includes("עתידיים") && (await updates()).length === 0);
  await page.fill("#cqPastDate", preDate);
  await page.click("#cqPastConfirm");
  await wait(400);
  let u = await updates();
  check("pick: 1st write = scheduled_for only (eq id=F)", u.length === 2 && JSON.stringify(Object.keys(u[0].patch)) === '["scheduled_for"]' && u[0].filters.join() === "eq:id=F", JSON.stringify(u));
  check("pick: 2nd write = status approved, guarded by scheduled_for > now", u[1] && u[1].patch.status === "approved" && u[1].filters.includes("in:id=F") && u[1].filters.includes("gt:scheduled_for") && u[1].matched.join() === "F");
  const F = await rowById("F");
  check("pick: saved as Israel time (the picker's wall clock)", israel(F.scheduled_for).endsWith(preTime), israel(F.scheduled_for));
  check("pick: no publish-now call (the row isn't due)", publishNow.length === 0);

  // ===== 3. "לפרסם עכשיו" → approve + publish-now (the server may still defer it) =====
  await page.click('[data-cq-approve="G"]');
  await page.click("#cqPastNow");
  await wait(400);
  u = await updates();
  check("now: status approved + exactly one publish-now for G", u.length === 3 && u[2].patch.status === "approved" && u[2].filters.join() === "eq:id=G" &&
    publishNow.length === 1 && publishNow[0].id === "G", JSON.stringify(publishNow));

  // ===== 4. bulk Approve with past rows → spread dialog + preview, dates FIRST, never publish-now =====
  const dBefore = (await rowById("D")).scheduled_for;
  for (const id of ["A", "B", "C", "D"]) await page.check('.cq-card-check[data-select-id="' + id + '"]');
  await page.click("#cqBulkApprove");
  await page.waitForSelector("#cqSpreadModal:not([hidden])");
  const table = await page.$$eval("#cqSpreadBody tr", trs => trs.map(tr => Array.from(tr.cells).map(td => td.textContent.trim())));
  check("bulk: dialog lists only the 3 past rows, oldest first", table.length === 3 && table.map(r => r[3]).join("|") === "ישן א רילס|ישן ב פוסט|ישן ג רילס", JSON.stringify(table));
  check("bulk: columns date / day / time / title / type / platforms", table.every(r => /^\d\d\.\d\d$/.test(r[0]) && /^(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)$/.test(r[1]) &&
    /^(10|14|19):00$/.test(r[2]) && r[5] === "פייסבוק + אינסטגרם"), JSON.stringify(table[0]));
  check("bulk: the future row is mentioned as keeping its date", (await page.isVisible("#cqSpreadFuture")) && (await page.textContent("#cqSpreadFuture")).includes("1"));
  const beforeBulk = (await updates()).length;
  await page.click("#cqSpreadApprove");
  await wait(600);
  u = (await updates()).slice(beforeBulk);
  check("bulk: 3 scheduled_for writes first (A, B, C), then ONE status write", u.length === 4 && u.slice(0, 3).every(x => JSON.stringify(Object.keys(x.patch)) === '["scheduled_for"]') &&
    u.slice(0, 3).map(x => x.filters[0]).join() === "eq:id=A,eq:id=B,eq:id=C" && u[3].patch.status === "approved", JSON.stringify(u.map(x => [Object.keys(x.patch), x.filters])));
  check("bulk: the status write covers A–D and is guarded by scheduled_for > now", u[3].filters.includes("in:id=A,B,C,D") && u[3].filters.includes("gt:scheduled_for") && u[3].matched.sort().join() === "A,B,C,D");
  const rows = await page.evaluate(() => window.__sb.rows);
  const A = rows.find(r => r.id === "A"), Bq = rows.find(r => r.id === "B"), C = rows.find(r => r.id === "C"), Dq = rows.find(r => r.id === "D"), Fq = rows.find(r => r.id === "F");
  check("bulk: spread slots are after the existing queue (incl. the just-scheduled F)", new Date(A.scheduled_for) > new Date(Fq.scheduled_for) && new Date(A.scheduled_for) > new Date(E.scheduled_for));
  check("bulk: oldest first and strictly increasing", new Date(A.scheduled_for) < new Date(Bq.scheduled_for) && new Date(Bq.scheduled_for) < new Date(C.scheduled_for));
  check("bulk: the future row D kept its own date (approved, date unchanged)", Dq.scheduled_for === dBefore && Dq.status === "approved");
  check("bulk: no two reels back to back on the same day (A and C)", (() => {
    const day = (s) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(s));
    return day(A.scheduled_for) !== day(C.scheduled_for) || day(Bq.scheduled_for) === day(A.scheduled_for);
  })());
  check("bulk: never calls publish-now", publishNow.length === 1);
  check("bulk: dialog closed, selection cleared", (await page.isHidden("#cqSpreadModal")) && (await page.textContent("#cqBulkCount")).trim().startsWith("0"));

  // ===== 5. bulk Approve with only future rows → no dialog, approve only, no publish-now =====
  // (re-open K as pending; D is approved now)
  await page.check('.cq-card-check[data-select-id="K"]');
  const beforeK = (await updates()).length;
  await page.click("#cqBulkApprove");
  await wait(400);
  u = (await updates()).slice(beforeK);
  check("bulk future-only: no dialog, one guarded status write, no publish-now", (await page.isHidden("#cqSpreadModal")) && u.length === 1 && u[0].patch.status === "approved" &&
    u[0].filters.includes("gt:scheduled_for") && publishNow.length === 1);

  // ===== 6. bulk reject sets rejected_at =====
  await page.evaluate(() => { const k = window.__sb.rows.find(r => r.id === "K"); k.status = "pending_approval"; });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await wait(300);
  const kBox = await page.$('.cq-card-check[data-select-id="K"]');
  if (kBox) await kBox.check();
  const beforeR = (await updates()).length;
  await page.click("#cqBulkReject");
  await wait(400);
  u = (await updates()).slice(beforeR);
  check("bulk reject: status rejected + rejected_at (so the row gets archived)", u.length === 1 && u[0].patch.status === "rejected" && !isNaN(new Date(u[0].patch.rejected_at).getTime()), JSON.stringify(u));

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  check("the stub never leaked a real Supabase request", supabaseHits.length === 0, supabaseHits[0]);

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  await browser.close();
  server.close();
  process.exitCode = fail ? 1 : 0;
})().catch(async (err) => { console.log("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; process.exit(1); });
