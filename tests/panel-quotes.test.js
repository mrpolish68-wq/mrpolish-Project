// Phase 6: admin.html quote tab, Playwright (playwright-core + installed Chrome) against a local
// static server. The Supabase client is a STUB injected by an init script (nothing stubbed is in
// the repo). /api/render-quote-pdf is mocked. No network call reaches Supabase; no live quotes.
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

// ---------- the Supabase stub (runs in the page before any script) ----------
const STUB = `(() => {
  localStorage.setItem("sb-mmognkxkglkotzkuxzly-auth-token", "stub");
  const S = window.__sb = { calls: [], handler: null, cfg: { rpcMode: "ok", updateMode: "ok", signedMode: "ok" }, quotes: [] };
  for (let n = 6; n <= 13; n++) S.quotes.push({ id: "q" + n, number: n, quote_date: n + ".10.2026", client_name: "לקוח " + n, address: "רחוב " + n, description: "תיאור " + n, total: 1000 * n, source: "panel", pdf_path: null });
  S.quotes.push({ id: "q14", number: 14, quote_date: "27.10.2026", client_name: "דני לוי", address: "הרצל 12", description: "ליטוש", total: 4500, source: "telegram", pdf_path: "aaaaaaaa-0000-4000-8000-000000000014.pdf" });
  S.quotes.push({ id: "q15", number: 15, quote_date: "27.10.2026", client_name: "רינה", address: "ויצמן 5", description: "הברקה", total: 3800, source: "telegram", pdf_path: null });
  const rec = (c) => { S.calls.push(c); try { window.__record && window.__record(JSON.stringify(c)); } catch (e) {} };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function resolve(q) {
    rec({ kind: "query", table: q.table, ops: q.ops.map(o => o[0]), args: q.ops });
    const has = (op) => q.ops.find(o => o[0] === op);
    if (q.table === "quotes") {
      const upd = has("update");
      if (upd) {
        if (S.cfg.updateMode === "reject") return Promise.reject(new Error("network"));
        if (S.cfg.updateMode === "error") return Promise.resolve({ data: null, error: { message: "x" } });
        const id = has("eq")[1][1];
        const row = S.quotes.find(r => r.id === id); Object.assign(row, upd[1][0]);
        return Promise.resolve({ data: [clone(row)], error: null });
      }
      if (has("insert")) return Promise.resolve({ data: null, error: { message: "insert must not be used" } });
      return Promise.resolve({ data: clone(S.quotes).sort((a, b) => b.number - a.number), error: null });
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
      signOut: () => { rec({ kind: "signOut" }); return Promise.resolve({ error: null }); },
      onAuthStateChange: (cb) => { S.authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    from: (t) => query(t),
    rpc: (name, args) => {
      rec({ kind: "rpc", name, args, t: performance.now() });
      if (name !== "create_quote") return Promise.resolve({ data: null, error: null });
      if (S.cfg.rpcMode === "reject") return Promise.reject(new Error("network"));
      if (S.cfg.rpcMode === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
      const ref = args.p.client_ref;
      const existing = ref && S.quotes.find(r => r.client_ref === ref);
      if (existing) { rec({ kind: "rpcReturnedExisting", id: existing.id }); return Promise.resolve({ data: clone(existing), error: null }); }
      const number = S.quotes.reduce((m, r) => Math.max(m, r.number), 0) + 1;
      const row = Object.assign({ id: "q" + number, number, source: "panel", pdf_path: null }, args.p);
      S.quotes.push(row);
      if (S.cfg.rpcMode === "lost") { S.cfg.rpcMode = "ok"; return Promise.reject(new Error("network: response lost after commit")); }
      return Promise.resolve({ data: clone(row), error: null });
    },
    channel: (name) => {
      const ch = { name, on(type, filter, cb) { rec({ kind: "channel.on", name, type, filter }); S.handler = cb; return ch; }, subscribe() { rec({ kind: "channel.subscribe", name }); return ch; } };
      return ch;
    },
    removeChannel: (ch) => { rec({ kind: "removeChannel", name: ch && ch.name }); return Promise.resolve("ok"); },
    storage: { from: (bucket) => new Proxy({}, { get(t, prop) {
      if (prop === "createSignedUrl") return (p, exp, opts) => {
        rec({ kind: "signedUrl", bucket, path: p, exp, opts });
        if (S.cfg.signedMode === "error") return Promise.resolve({ data: null, error: { message: "Object not found" } });
        return Promise.resolve({ data: { signedUrl: "https://signed.example/" + p + "?token=x" }, error: null });
      };
      return () => Promise.resolve({ data: null, error: null });
    } }) },
    functions: generic()
  };
  Object.defineProperty(window, "supabase", { configurable: false, get: () => ({ createClient: () => client }), set: () => {} });
  S.emit = (payload) => S.handler && S.handler(payload);
  // record downloads instead of navigating
  HTMLAnchorElement.prototype.click = function () { rec({ kind: "download", href: this.href, name: this.download }); };
})();`;

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const calls = [];
  await context.exposeFunction("__record", (s) => calls.push(JSON.parse(s)));
  await context.addInitScript(STUB);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  const alerts = [];
  page.on("dialog", async (d) => { alerts.push(d.message()); await d.accept(); });
  let renderMode = 200;
  const renderCalls = [];
  await page.route("**/api/render-quote-pdf", async (route) => {
    const req = route.request();
    renderCalls.push({ auth: req.headers()["authorization"], body: req.postDataJSON(), method: req.method() });
    if (renderMode === 200) return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-fake" });
    return route.fulfill({ status: renderMode, contentType: "application/json", body: JSON.stringify(renderMode === 422 ? { error: "too_long", lines: 18, maxLines: 15 } : { error: "render_failed" }) });
  });
  // Any request to Supabase itself would mean the stub leaked: fail loudly.
  const supabaseHits = [];
  await page.route("**/*.supabase.co/**", (route) => { supabaseHits.push(route.request().url()); route.abort(); });

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };
  const wait = (ms) => page.waitForTimeout(ms);
  const selects = () => calls.filter(c => c.kind === "query" && c.table === "quotes" && c.ops.includes("select") && !c.ops.includes("update")).length;
  const cellText = () => page.$$eval("#qhBody tr", trs => trs.map(tr => tr.innerText.replace(/\s+/g, " ").trim()));

  await page.goto(base + "/admin.html", { waitUntil: "load" });
  await page.waitForFunction(() => window.jspdf && window.html2canvas, null, { timeout: 30000 });
  // spies on the PDF libraries (after they load)
  await page.evaluate(() => {
    const api = window.jspdf.jsPDF.API || window.jspdf.jsPDF.prototype;
    api.save = function (name) { window.__record(JSON.stringify({ kind: "pdfSave", name, t: performance.now() })); };
    const bd = window.MrpQuoteTemplate.buildDoc;
    window.MrpQuoteTemplate.buildDoc = function (data, logo) { window.__record(JSON.stringify({ kind: "buildDoc", num: data.num, client: data.client, total: String(data.total) })); return bd.apply(this, arguments); };
    const h2c = window.html2canvas;
    window.html2canvas = function () { window.__record(JSON.stringify({ kind: "html2canvas", t: performance.now() })); return h2c.apply(this, arguments); };
  });
  await wait(300);

  // ===== 1. sync after login =====
  const on = calls.find(c => c.kind === "channel.on");
  check("Realtime: subscribed after login to postgres_changes on public.quotes (INSERT/UPDATE/DELETE)", !!on && on.name === "quotes-sync" && on.type === "postgres_changes" &&
    JSON.stringify(on.filter) === JSON.stringify({ event: "*", schema: "public", table: "quotes" }) && calls.some(c => c.kind === "channel.subscribe"));

  // ===== 2. history + badge + estimate =====
  await page.click('button[data-view="ai"]');
  await page.waitForFunction(() => document.querySelectorAll("#qhBody tr").length > 5);
  let rows = await cellText();
  const badgeRows = await page.$$eval("#qhBody tr", trs => trs.filter(tr => tr.querySelector(".qh-src")).map(tr => tr.cells[0].innerText.trim()));
  check("history: '📱 טלגרם' badge on telegram rows only", JSON.stringify(badgeRows.map(t => t.slice(0, 3))) === JSON.stringify(["015", "014"]) && badgeRows.every(t => t.includes("📱 טלגרם")), badgeRows.join(" | "));
  const badgeStyle = await page.$eval(".qh-src", el => { const s = getComputedStyle(el); return s.borderRadius + " " + s.fontWeight + " " + s.display; });
  check("badge styled as a pill like the panel's badges", /999px 700 inline-block/.test(badgeStyle), badgeStyle);
  const amounts = await page.$$eval("#qhBody td.col-amount", tds => tds.map(td => td.innerText.trim()));
  check("7a amounts shown as '<number> ₪' (like the PDF and the bot)", amounts.length > 5 && amounts.every(a => /^[\d,.]+ ₪$/.test(a)) && amounts.includes("4,500 ₪"), amounts.slice(0, 3).join(" | "));
  const expectToday = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date()).replace(/\//g, ".");
  check("L6 a NEW quote's default date is DD.MM.YYYY (zero-padded), Israel time", (await page.inputValue("#ofDate")) === expectToday, await page.inputValue("#ofDate"));
  check("number field shows the estimate (max+1 = 016) + hint 'המספר הסופי ייקבע בשמירה'", (await page.inputValue("#ofNum")) === "016" &&
    (await page.isVisible("#ofNumHint")) && (await page.textContent("#ofNumHint")) === "המספר הסופי ייקבע בשמירה");

  // ===== 3. realtime events -> one debounced refetch =====
  let before = selects();
  await page.evaluate(() => {
    window.__sb.quotes.push({ id: "q16", number: 16, quote_date: "27.10.2026", client_name: "מהבוט", address: "—", description: "x", total: 1200, source: "telegram", pdf_path: "aaaaaaaa-0000-4000-8000-000000000016.pdf" });
    window.__sb.emit({ eventType: "INSERT" }); window.__sb.emit({ eventType: "UPDATE" }); window.__sb.emit({ eventType: "INSERT" });
  });
  await wait(250);
  check("3 events in a burst -> no refetch yet (debounced)", selects() === before);
  await wait(500);
  rows = await cellText();
  check("…then exactly ONE refetch, the new telegram quote 016 appears live with 📱", selects() === before + 1 && rows[0].startsWith("016") && rows[0].includes("📱 טלגרם"), rows[0]);
  check("…estimate updated to 017", (await page.inputValue("#ofNum")) === "017");
  before = selects();
  await page.evaluate(() => { window.__sb.quotes = window.__sb.quotes.filter(q => q.id !== "q6"); window.__sb.emit({ eventType: "DELETE" }); });
  await wait(700);
  rows = await cellText();
  check("DELETE event -> row removed", selects() === before + 1 && !rows.some(r => r.startsWith("006")));

  // ===== 4. wake-up refetch (visibilitychange / focus, throttled 1 per 10 s) =====
  await wait(10100); // clear any wake-up throttle left from page load
  before = selects();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await wait(150);
  check("visibilitychange → visible -> refetch", selects() === before + 1);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await wait(150);
  check("focus/visible again within 10 s -> throttled (no refetch)", selects() === before + 1);
  await wait(10100);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await wait(150);
  check("focus after 10 s -> refetch", selects() === before + 2);

  // ===== 5. new quote: fit check -> RPC -> render with the returned number =====
  const mark = calls.length;
  await page.fill("#ofClient", "לקוח חדש");
  await page.fill("#ofAddress", "הדקל 4");
  await page.fill("#ofDesc", "ליטוש שיש בסלון\nמריחת סילר");
  await page.fill("#ofTotal", "3200");
  await page.click("#ofGenerate");
  await page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
  const seg = calls.slice(mark);
  const rpc = seg.find(c => c.kind === "rpc" && c.name === "create_quote");
  const h2cIdx = seg.findIndex(c => c.kind === "html2canvas"), rpcIdx = seg.findIndex(c => c.kind === "rpc");
  const save = seg.find(c => c.kind === "pdfSave");
  check("new quote: create_quote RPC BEFORE html2canvas/PDF", rpcIdx !== -1 && h2cIdx > rpcIdx && seg.filter(c => c.kind === "html2canvas").length === 1);
  check("RPC payload {p: date, client, address, description, total, client_ref} (no number, no source)", rpc && JSON.stringify(rpc.args) === JSON.stringify({ p: { quote_date: rpc.args.p.quote_date, client_name: "לקוח חדש", address: "הדקל 4", description: "ליטוש שיש בסלון\nמריחת סילר", total: 3200, client_ref: rpc.args.p.client_ref } }), rpc && JSON.stringify(rpc.args));
  check("M1/L10 panel: client_ref is a UUID (crypto.randomUUID)", rpc && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rpc.args.p.client_ref));
  const firstRef = rpc && rpc.args.p.client_ref;
  check("PDF rendered with the RETURNED number (017): 'הצעת-מחיר-017.pdf'", save && save.name === "הצעת-מחיר-017.pdf", save && save.name);
  check("no direct insert into quotes", !seg.some(c => c.kind === "query" && c.table === "quotes" && c.ops.includes("insert")));
  rows = await cellText();
  check("new row in history (017), estimate now 018, button re-enabled", rows[0].startsWith("017") && (await page.inputValue("#ofNum")) === "018" && !(await page.isDisabled("#ofGenerate")));
  const localCounter = await page.evaluate(() => localStorage.getItem("mrp_order_seq"));
  check("localStorage counter not used/updated", localCounter === null);

  // too long -> refused before any number is used
  let m2 = calls.length; alerts.length = 0;
  await page.fill("#ofDesc", Array.from({ length: 26 }, (_, i) => "שורה " + (i + 1) + " של תיאור עבודה ארוך מאוד שתופס רוחב שורה שלמה בהצעה המודפסת").join("\n"));
  await page.click("#ofGenerate");
  await page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
  check("too-long description -> alert, NO create_quote (no number used)", alerts.includes("התיאור ארוך מדי לעמוד אחד — נא לקצר את התיאור") && !calls.slice(m2).some(c => c.kind === "rpc"));

  // RPC error / rejection
  await page.fill("#ofDesc", "תיאור קצר");
  for (const mode of ["error", "reject"]) {
    await page.evaluate((m) => { window.__sb.cfg.rpcMode = m; }, mode);
    m2 = calls.length; alerts.length = 0;
    await page.click("#ofGenerate");
    await page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
    check("RPC " + mode + " -> Hebrew error, button restored, no PDF", alerts[0] === "שמירת ההצעה נכשלה, וה-PDF לא הופק. בדקו את החיבור ונסו שוב." && !calls.slice(m2).some(c => c.kind === "pdfSave"), alerts.join(" | "));
  }
  await page.evaluate(() => { window.__sb.cfg.rpcMode = "ok"; });

  // ===== 6. edit mode: plain update, same number; .catch =====
  await page.click('[data-qh-edit="q13"]');
  check("edit mode: number 013, hint hidden", (await page.inputValue("#ofNum")) === "013" && !(await page.isVisible("#ofNumHint")));
  await page.fill("#ofTotal", "13500");
  m2 = calls.length;
  await page.click("#ofGenerate");
  await page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
  let seg2 = calls.slice(m2);
  const upd = seg2.find(c => c.kind === "query" && c.ops.includes("update"));
  check("edit: plain update(...).eq('id', q13) with number 13, no RPC, PDF 013", !!upd && upd.args.find(a => a[0] === "eq")[1][1] === "q13" && upd.args.find(a => a[0] === "update")[1][0].number === 13 &&
    !seg2.some(c => c.kind === "rpc") && seg2.some(c => c.kind === "pdfSave" && c.name === "הצעת-מחיר-013.pdf"));
  check("edit saved: banner gone, estimate back", (await page.isHidden("#ofEditingBanner")) && /^0\d\d$/.test(await page.inputValue("#ofNum")) && (await page.isVisible("#ofNumHint")));
  for (const mode of ["error", "reject"]) {
    await page.click('[data-qh-edit="q12"]');
    await page.evaluate((m) => { window.__sb.cfg.updateMode = m; }, mode);
    alerts.length = 0;
    await page.click("#ofGenerate");
    await page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
    check("edit update " + mode + " -> existing Hebrew error, button restored (the .catch fix)", alerts.includes("ה-PDF הופק בהצלחה, אך אירעה שגיאה בשמירת ההצעה בהיסטוריה. נסו שוב.") && !(await page.isDisabled("#ofGenerate")), alerts.join(" | "));
  }
  await page.evaluate(() => { window.__sb.cfg.updateMode = "ok"; });
  await page.click("#ofEditingCancel");

  // ===== M1/L10 panel: idempotent create (lost response -> retry gets the same quote) =====
  const rpcCalls = () => calls.filter(c => c.kind === "rpc" && c.name === "create_quote");
  const panelCount = () => page.evaluate(() => window.__sb.quotes.filter(q => q.source === "panel" && q.client_ref).length);
  const waitBtn = () => page.waitForFunction(() => !document.getElementById("ofGenerate").disabled, null, { timeout: 30000 });
  await page.fill("#ofClient", "לקוח אובדן"); await page.fill("#ofAddress", "הגפן 1"); await page.fill("#ofDesc", "ליטוש"); await page.fill("#ofTotal", "2100");
  let mm = calls.length; alerts.length = 0;
  await page.evaluate(() => { window.__sb.cfg.rpcMode = "lost"; });
  const before1 = await panelCount();
  await page.click("#ofGenerate"); await waitBtn();
  const lostRef = rpcCalls().slice(-1)[0].args.p.client_ref;
  check("M1 panel: response lost -> the quote WAS created, the user gets the Hebrew error, button restored, no PDF", (await panelCount()) === before1 + 1 &&
    alerts[0] === "שמירת ההצעה נכשלה, וה-PDF לא הופק. בדקו את החיבור ונסו שוב." && !calls.slice(mm).some(c => c.kind === "pdfSave"));
  check("M1 panel: this form has a NEW client_ref (the earlier save had succeeded)", lostRef !== firstRef);
  mm = calls.length; alerts.length = 0;
  await page.click("#ofGenerate"); await waitBtn(); // the user retries the same save
  let segM = calls.slice(mm);
  const retryRpc = segM.find(c => c.kind === "rpc" && c.name === "create_quote");
  const lostRow = await page.evaluate((r) => window.__sb.quotes.find(q => q.client_ref === r), lostRef);
  check("M1 panel: the retry reuses the SAME client_ref and gets the SAME quote back (no 2nd number)", !!retryRpc && retryRpc.args.p.client_ref === lostRef &&
    segM.some(c => c.kind === "rpcReturnedExisting" && c.id === lostRow.id) && (await panelCount()) === before1 + 1);
  check("M1 panel: …the PDF uses that quote's number, and no 'already saved' warning (same fields)", segM.some(c => c.kind === "pdfSave" && c.name === "הצעת-מחיר-" + String(lostRow.number).padStart(3, "0") + ".pdf") && alerts.length === 0, alerts.join(" | "));
  // lost again, then the user CHANGES the total before retrying -> the saved row wins, with a warning
  await page.fill("#ofClient", "לקוח שינוי"); await page.fill("#ofTotal", "5000");
  await page.evaluate(() => { window.__sb.cfg.rpcMode = "lost"; });
  await page.click("#ofGenerate"); await waitBtn();
  const ref2 = rpcCalls().slice(-1)[0].args.p.client_ref;
  check("M1 panel: after a successful save the next form uses a fresh client_ref", ref2 !== lostRef);
  await page.fill("#ofTotal", "5500");
  mm = calls.length; alerts.length = 0;
  await page.click("#ofGenerate"); await waitBtn();
  segM = calls.slice(mm);
  const bdoc = segM.filter(c => c.kind === "buildDoc").slice(-1)[0];
  check("M1 panel: retry after editing -> the SAVED quote comes back; the PDF shows the saved total (5000) + a warning to edit it", !!bdoc && bdoc.total === "5000" && bdoc.client === "לקוח שינוי" &&
    /ההצעה כבר נשמרה קודם/.test(alerts[0] || ""), (bdoc && bdoc.total) + " | " + (alerts[0] || "").slice(0, 40));
  // a failed attempt, then a new form (edit + cancel) -> fresh key
  await page.evaluate(() => { window.__sb.cfg.rpcMode = "reject"; });
  await page.click("#ofGenerate"); await waitBtn();
  const refFail = rpcCalls().slice(-1)[0].args.p.client_ref;
  await page.evaluate(() => { window.__sb.cfg.rpcMode = "ok"; });
  await page.click('[data-qh-edit="q12"]'); await page.click("#ofEditingCancel");
  await page.fill("#ofClient", "טופס חדש"); await page.fill("#ofTotal", "100"); await page.fill("#ofDesc", "x");
  await page.click("#ofGenerate"); await waitBtn();
  check("M1 panel: edit/cancel (a new form) resets the key -> a new client_ref", rpcCalls().slice(-1)[0].args.p.client_ref !== refFail);
  await page.click('[data-qh-edit="q11"]');
  mm = calls.length;
  await page.click("#ofGenerate"); await waitBtn();
  const updM = calls.slice(mm).find(c => c.kind === "query" && c.ops.includes("update"));
  check("M1 panel: edit mode sends no client_ref (plain update, same number)", !!updM && !("client_ref" in updM.args.find(a => a[0] === "update")[1][0]) && !calls.slice(mm).some(c => c.kind === "rpc"));
  if (await page.isVisible("#ofEditingCancel")) await page.click("#ofEditingCancel"); // a successful edit already left edit mode

  // ===== 7. PDF for telegram quotes =====
  m2 = calls.length;
  await page.click('[data-qh-view="q14"]');
  await wait(300);
  seg2 = calls.slice(m2);
  const su = seg2.find(c => c.kind === "signedUrl"), dl = seg2.find(c => c.kind === "download");
  check("telegram + pdf_path -> signed URL from quotes-pdf (60 s, download name) -> download", su && su.bucket === "quotes-pdf" && su.path === "aaaaaaaa-0000-4000-8000-000000000014.pdf" && su.exp === 60 && su.opts.download === "הצעת-מחיר-014.pdf" &&
    dl && dl.href.startsWith("https://signed.example/aaaaaaaa-0000-4000-8000-000000000014.pdf") && dl.name === "הצעת-מחיר-014.pdf" && renderCalls.length === 0 && !seg2.some(c => c.kind === "html2canvas"));
  m2 = calls.length;
  await page.click('[data-qh-view="q15"]');
  await wait(500);
  seg2 = calls.slice(m2);
  const dl2 = seg2.find(c => c.kind === "download");
  check("telegram + pdf_path null -> POST /api/render-quote-pdf with Bearer session token -> download", renderCalls.length === 1 && renderCalls[0].method === "POST" &&
    renderCalls[0].auth === "Bearer fake-access-token" && renderCalls[0].body.quote_id === "q15" && dl2 && dl2.href.startsWith("blob:") && dl2.name === "הצעת-מחיר-015.pdf");
  renderMode = 422; alerts.length = 0;
  await page.click('[data-qh-view="q15"]'); await wait(500);
  check("server render 422 -> 'התיאור ארוך מדי' alert", alerts[0] === "התיאור ארוך מדי לעמוד אחד — נא לקצר את התיאור");
  renderMode = 500; alerts.length = 0;
  await page.click('[data-qh-view="q15"]'); await wait(500);
  check("server render 500 -> Hebrew error alert, button re-enabled", alerts[0] === "אירעה שגיאה בהפקת ה-PDF. נסו שוב." && !(await page.isDisabled('[data-qh-view="q15"]')));
  renderMode = 200;
  await page.evaluate(() => { window.__sb.cfg.signedMode = "error"; });
  const rcBefore = renderCalls.length;
  await page.click('[data-qh-view="q14"]'); await wait(500);
  check("signed URL fails (file missing) -> falls back to the server render", renderCalls.length === rcBefore + 1 && renderCalls[renderCalls.length - 1].body.quote_id === "q14");
  await page.evaluate(() => { window.__sb.cfg.signedMode = "ok"; });

  // L1: a tampered pdf_path is never used for a signed URL
  await page.evaluate(() => { const q = window.__sb.quotes.find(x => x.id === "q14"); q.pdf_path = "../receipts/secret.jpg"; });
  await page.evaluate(() => { window.__sb.emit({ eventType: "UPDATE" }); }); await wait(700);
  m2 = calls.length; const rcL1 = renderCalls.length;
  await page.click('[data-qh-view="q14"]'); await wait(500);
  seg2 = calls.slice(m2);
  check("L1 panel: pdf_path '../receipts/secret.jpg' -> NO signed URL; rendered fresh on the server instead", !seg2.some(c => c.kind === "signedUrl") && renderCalls.length === rcL1 + 1 && renderCalls[renderCalls.length - 1].body.quote_id === "q14");

  // panel quote keeps html2canvas
  m2 = calls.length; const rcPanel = renderCalls.length;
  await page.click('[data-qh-view="q11"]');
  await page.waitForFunction(() => !document.querySelector('[data-qh-view="q11"]').disabled, null, { timeout: 30000 });
  seg2 = calls.slice(m2);
  check("panel quote 'צפה / הורדה' -> html2canvas path (no signed URL, no server render)", seg2.some(c => c.kind === "html2canvas") && seg2.some(c => c.kind === "pdfSave" && c.name === "הצעת-מחיר-011.pdf") && !seg2.some(c => c.kind === "signedUrl") && renderCalls.length === rcPanel);

  // ===== 8. console + network hygiene, then logout =====
  // Chrome itself logs "Failed to load resource … 422/500" for the two error responses this test
  // injects on purpose (render 422 / 500); those are the browser's network log, not page errors.
  const injected = /Failed to load resource: the server responded with a status of (422|500)/;
  const realErrors = consoleErrors.filter(e => !injected.test(e));
  check("zero console errors / page errors (besides the browser's log of the 2 injected 422/500 responses)", realErrors.length === 0 && consoleErrors.length - realErrors.length === 2, realErrors.slice(0, 3).join(" | "));
  check("no request reached Supabase (stub only)", supabaseHits.length === 0, supabaseHits.slice(0, 2).join(" | "));
  m2 = calls.length;
  await Promise.all([page.waitForURL(/login\.html/, { timeout: 10000 }).catch(() => {}), page.click("#logoutBtn")]);
  seg2 = calls.slice(m2);
  check("logout -> removeChannel('quotes-sync') before signOut", seg2.findIndex(c => c.kind === "removeChannel" && c.name === "quotes-sync") !== -1 &&
    seg2.findIndex(c => c.kind === "removeChannel") < seg2.findIndex(c => c.kind === "signOut"));

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  await browser.close();
  server.close();
  if (fail) process.exitCode = 1;
})().catch(async (e) => { console.log("HARNESS ERROR " + e.stack); process.exitCode = 1; server.close(); process.exit(1); });
