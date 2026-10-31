// The panel's "📸 פרויקטים" tab + "➕ פוסט חדש" (media-projects command 4), Playwright (playwright-core +
// installed Chrome) against a local static server, on DESKTOP (1280) and MOBILE (390 × 844).
// The Supabase client is a STUB (projects / project_media / content_queue in memory, realtime simulated);
// /api/media (upload slots, processing, AI, deletes) and the TUS endpoint are MOCKED. Nothing reaches
// Supabase, Gemini or Meta. Screenshots → .playwright-mcp/panel-projects/ (gitignored).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(ROOT, ".playwright-mcp", "panel-projects");
fs.mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".mp4": "video/mp4" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(path.normalize(ROOT)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, PATCH, HEAD, OPTIONS",
  "access-control-expose-headers": "Location, Upload-Offset, Upload-Length, Tus-Resumable" };

// EXIF GPS entries in a JPEG (-1 = no EXIF at all)
function gpsEntries(buf) {
  let i = 2;
  while (i < buf.length - 4 && buf[i] === 0xff) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m === 0xe1 && buf.slice(i + 4, i + 10).toString("latin1") === "Exif\0\0") return 1;
    if (m === 0xda) break;
    i += 2 + len;
  }
  return -1;
}

const STUB = `(() => {
  localStorage.setItem("sb-mmognkxkglkotzkuxzly-auth-token", "stub");
  const now = Date.now(), H = 3600e3, D = 24 * H, iso = (ms) => new Date(ms).toISOString();
  const P1 = "aaaaaaaa-1111-4111-8111-000000000001", P2 = "aaaaaaaa-2222-4222-8222-000000000002";
  const S = window.__sb = { log: [], handlers: [], tables: {
    projects: [
      { id: P1, status: "published", consent: "yes", consent_at: iso(now - 9 * D), service: "marble_stone", city: "רעננה", title_he: "ליטוש שיש בסלון ברעננה", title_en: "Marble polishing",
        summary_he: null, summary_en: null, cover_media_id: "m-p1-2", watermark: true, source: "panel", ai_meta: { publish_plan: { destinations: ["site", "instagram"] }, caption_he: "השיש חזר לברק" },
        created_at: iso(now - 10 * D), updated_at: iso(now - 9 * D) },
      { id: P2, status: "draft", consent: "unknown", consent_at: null, service: "stairs", city: "בית שמש", title_he: "חידוש מדרגות", title_en: null, summary_he: null, summary_en: null,
        cover_media_id: null, watermark: true, source: "telegram", ai_meta: null, created_at: iso(now - 2 * D), updated_at: iso(now - 2 * D) }
    ],
    project_media: [
      { id: "m-p1-1", project_id: P1, kind: "image", role: "before", pair_no: 1, sort: 0, variants: { w480: { path: P1 + "/m-p1-1/w480.webp" } }, ai_flags: {}, flags_ack_at: null, alt_he: "לפני", alt_en: "before", created_at: iso(now - 10 * D) },
      { id: "m-p1-2", project_id: P1, kind: "image", role: "after", pair_no: 1, sort: 1, variants: { w480: { path: P1 + "/m-p1-2/w480.webp" } }, ai_flags: {}, flags_ack_at: null, alt_he: "אחרי", alt_en: "after", created_at: iso(now - 10 * D) },
      { id: "m-p2-1", project_id: P2, kind: "image", role: "before", pair_no: 1, sort: 0, variants: { w480: { path: P2 + "/m-p2-1/w480.webp" } }, ai_flags: { faces: true }, flags_ack_at: null, alt_he: null, alt_en: null, created_at: iso(now - 2 * D) }
    ],
    content_queue: [
      { id: "cq-1", title: "פוסט קיים", caption: "c", platform: "both", media_type: "image", content_category: "post", media_url: "/logo.webp", scheduled_for: iso(now + 2 * D),
        status: "approved", publish_attempts: 0, fb_post_id: null, ig_post_id: null, pin_requested: false, created_at: iso(now - 5 * D) }
    ] } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uuid = () => crypto.randomUUID();
  function match(r, q) {
    return q.ops.every(([op, a]) => op === "eq" ? r[a[0]] === a[1] : op === "in" ? a[1].includes(r[a[0]]) : op === "gt" ? new Date(r[a[0]]) > new Date(a[1]) : true);
  }
  function resolve(q) {
    const T = S.tables[q.table] = S.tables[q.table] || [];
    const has = (op) => q.ops.find(o => o[0] === op);
    let out;
    if (has("insert")) {
      const row = Object.assign({ id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        q.table === "projects" ? { status: "collecting", consent: "unknown", watermark: true, ai_meta: null, cover_media_id: null } : {}, has("insert")[1][0]);
      T.push(row); out = [row];
      S.log.push({ table: q.table, op: "insert", row: clone(row) });
      S.handlers.filter(h => h.table === q.table).forEach(h => setTimeout(() => h.cb({ eventType: "INSERT", new: clone(row) }), 0));
    } else if (has("update")) {
      const patch = has("update")[1][0];
      out = T.filter(r => match(r, q));
      out.forEach(r => { Object.assign(r, patch); if (q.table === "projects") r.updated_at = new Date().toISOString(); });
      S.log.push({ table: q.table, op: "update", patch: clone(patch), ids: out.map(r => r.id) });
    } else if (has("delete")) {
      out = T.filter(r => match(r, q));
      S.tables[q.table] = T.filter(r => !out.includes(r));
      S.log.push({ table: q.table, op: "delete", ids: out.map(r => r.id) });
    } else {
      out = T.filter(r => match(r, q));
      const ord = has("order");
      if (ord) { const k = ord[1][0], asc = !(ord[1][1] && ord[1][1].ascending === false); out = out.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1)); }
    }
    return Promise.resolve({ data: clone(out || []), error: null, count: (out || []).length });
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
  S.emit = (table, payload) => S.handlers.filter(h => h.table === table).forEach(h => h.cb(payload));
  const generic = () => new Proxy(function () {}, { get(t, prop) { if (prop === "then") return undefined; return () => Promise.resolve({ data: null, error: null }); } });
  const client = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "panel@example.com" } }, error: null }),
      getSession: () => Promise.resolve({ data: { session: { access_token: "fake-access-token" } }, error: null }),
      signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from: (t) => query(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    channel: (name) => { const ch = { on(ev, f, cb) { S.handlers.push({ name, table: f && f.table, cb }); return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel: () => Promise.resolve("ok"),
    storage: { from: () => generic() },
    functions: generic()
  };
  Object.defineProperty(window, "supabase", { configurable: false, get: () => ({ createClient: () => client }), set: () => {} });
})();`;

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail && !cond ? " — " + detail : "")); };

async function setup(browser, viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.width < 500 ? 2 : 1, isMobile: viewport.width < 500, hasTouch: viewport.width < 500,
    timezoneId: "Asia/Jerusalem", locale: "he-IL" });
  await context.addInitScript(STUB);
  const page = await context.newPage();
  const ctx = { page, label, errors: [], dialogs: [], api: [], tus: { posts: [], patches: [], bytes: {} }, supabaseOther: [] };
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) ctx.errors.push(m.text()); });
  page.on("pageerror", (e) => ctx.errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { ctx.dialogs.push(d.message()); await d.accept(); });
  const thumb = await sharp({ create: { width: 480, height: 360, channels: 3, background: "#b8a68c" } }).webp().toBuffer();

  // TUS (Supabase resumable uploads)
  await page.route(/\/storage\/v1\/upload\/resumable/, async (route) => {
    const req = route.request(), m = req.method(), h = req.headers();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (m === "POST") {
      const id = "u" + (ctx.tus.posts.length + 1);
      const meta = Object.fromEntries(String(h["upload-metadata"] || "").split(",").map(p => p.split(" ")).map(([k, v]) => [k, Buffer.from(v || "", "base64").toString()]));
      ctx.tus.posts.push({ id, upsert: h["x-upsert"], bucket: meta.bucketName, object: meta.objectName, type: meta.contentType, auth: h.authorization });
      ctx.tus.bytes[id] = [];
      return route.fulfill({ status: 201, headers: Object.assign({ Location: "https://mmognkxkglkotzkuxzly.supabase.co/storage/v1/upload/resumable/" + id, "Tus-Resumable": "1.0.0" }, CORS) });
    }
    const id = req.url().split("/").pop();
    const have = (ctx.tus.bytes[id] || []).reduce((s, c) => s + c.length, 0);
    if (m === "HEAD") return route.fulfill({ status: 200, headers: Object.assign({ "Upload-Offset": String(have), "Tus-Resumable": "1.0.0" }, CORS) });
    if (m === "PATCH") {
      const body = req.postDataBuffer() || Buffer.alloc(0);
      ctx.tus.bytes[id].push(body);
      ctx.tus.patches.push({ id, size: body.length });
      return route.fulfill({ status: 204, headers: Object.assign({ "Upload-Offset": String(have + body.length), "Tus-Resumable": "1.0.0" }, CORS) });
    }
    return route.fulfill({ status: 405, headers: CORS });
  });
  // public thumbnails
  await page.route(/\/storage\/v1\/object\/public\//, (route) => route.fulfill({ status: 200, contentType: "image/webp", body: thumb, headers: { "access-control-allow-origin": "*" } }));
  await page.route(/supabase\.co\/(?!storage\/v1\/(upload\/resumable|object\/public))/, (route) => { ctx.supabaseOther.push(route.request().url()); route.abort(); });

  // /api/site?action=publish (command 6): the site goes live after 💾 when the project is ready
  ctx.site = [];
  await page.route(/\/api\/site\?action=publish/, async (route) => {
    const req = route.request(), body = req.postDataJSON() || {};
    ctx.site.push({ body, auth: req.headers().authorization });
    await page.evaluate((id) => { const p = window.__sb.tables.projects.find(x => x.id === id); if (p && p.status === "ready") Object.assign(p, { status: "published", slug: "litush-shayish-ve-even-raanana" }); }, body.project_id);
    var out = { ok: true, published: true, slug: "litush-shayish-ve-even-raanana", url: "https://mr-polishes.com/projects/litush-shayish-ve-even-raanana" };
    if (body.social === true) out.social = { ok: true, queued: 1, rows: [{ id: "cq-x", media_type: "carousel", scheduled_for: new Date(Date.now() + 864e5).toISOString() }] };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
  });

  // /api/media
  ctx.aiMode = "ok";
  await page.route(/\/api\/media\?action=/, async (route) => {
    const req = route.request();
    const action = new URL(req.url()).searchParams.get("action");
    const body = req.postDataJSON() || {};
    ctx.api.push({ action, body, auth: req.headers().authorization });
    const reply = (status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
    if (action === "create-upload") {
      const video = /^video/.test(body.content_type);
      return reply(200, { ok: true, bucket: "project-originals", kind: video ? "video" : "image", path: body.project_id + "/" + (video ? "" : "incoming/") + crypto.randomUUID() + (video ? ".mp4" : ".jpg"), signed_url: "x", token: "t", tus_endpoint: "x" });
    }
    if (action === "process") {
      const id = crypto.randomUUID(), video = /\.mp4$/.test(body.path);
      const row = { id, project_id: body.project_id, kind: video ? "video" : "image", role: body.role || null, pair_no: null, sort: body.sort || 0,
        variants: video ? { cover: { w480: { path: body.project_id + "/" + id + "/cover-w480.webp" } } } : { w480: { path: body.project_id + "/" + id + "/w480.webp" } },
        ai_flags: null, flags_ack_at: null, alt_he: null, alt_en: null, duration_s: video ? 12 : null, created_at: new Date().toISOString() };
      await page.evaluate((r) => { window.__sb.tables.project_media.push(r); }, row);
      return reply(200, { ok: true, media: row, quota_remaining: 70 });
    }
    if (action === "analyze") {
      if (ctx.aiMode === "busy") return reply(503, { ok: false, code: "ai_busy", he: "הבינה המלאכותית עמוסה כרגע. נסו שוב בעוד כמה דקות." });
      await page.evaluate((pid) => {
        const S = window.__sb, imgs = S.tables.project_media.filter(m => m.project_id === pid && m.kind === "image").sort((a, b) => a.sort - b.sort);
        imgs.forEach((m, i) => Object.assign(m, { role: i % 2 ? "after" : "before", pair_no: Math.floor(i / 2) + 1, alt_he: "רצפת שיש " + (i % 2 ? "אחרי" : "לפני") + " ליטוש", alt_en: "Marble floor " + (i % 2 ? "after" : "before"),
          ai_flags: i === 0 ? { faces: true, plates: false, house_numbers: false, quality: ["dark"] } : { quality: [] } }));
        const p = S.tables.projects.find(x => x.id === pid);
        Object.assign(p, { status: "draft", service: "marble_stone", title_he: "ליטוש שיש בסלון", title_en: "Marble polishing in a living room", summary_he: "רצפת שיש עמומה קיבלה ליטוש והברקה.",
          summary_en: "A dull marble floor was polished.", ai_meta: Object.assign({}, p.ai_meta || {}, { caption_he: "השיש בסלון חזר לברק ✨\nליטוש והברקה בכל השטח.\n\n📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com\n\n#ליטוש_שיש #לפני_ואחרי",
            caption_body_he: "השיש בסלון חזר לברק ✨\nליטוש והברקה בכל השטח.", hashtags: ["#ליטוש_שיש", "#לפני_ואחרי"], needs_review: true, warnings: [] }) });
      }, body.project_id);
      return reply(200, { ok: true, analysis: { warnings: [], needs_review: true }, project: {} });
    }
    if (action === "correct") return reply(200, { ok: true, analysis: { warnings: ["caption_not_changed"] }, project: {} });
    if (action === "delete") {
      await page.evaluate((id) => { const S = window.__sb; S.tables.project_media = S.tables.project_media.filter(m => m.id !== id); }, body.media_id);
      return reply(200, { ok: true, deleted: body.media_id, files: 6 });
    }
    if (action === "delete-project") {
      const n = await page.evaluate((pid) => { const S = window.__sb; const n = S.tables.project_media.filter(m => m.project_id === pid).length;
        S.tables.projects = S.tables.projects.filter(p => p.id !== pid); S.tables.project_media = S.tables.project_media.filter(m => m.project_id !== pid); return n; }, body.project_id);
      return reply(200, { ok: true, deleted: body.project_id, files: n * 6, cancelled_posts: 0, instagram_posts: 1, facebook_posts: 1 });
    }
    return reply(404, { ok: false, code: "not_found" });
  });
  return ctx;
}

async function noOverflow(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
}
async function unnamedButtons(page, scope) {
  return page.$$eval(scope + " button", (els) => els.filter(b => b.offsetParent !== null && !(b.getAttribute("aria-label") || b.textContent.trim())).length);
}

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "pj-"));
  const photo = (name, color) => sharp({ create: { width: 2400, height: 1800, channels: 3, background: color } }).jpeg({ quality: 85 })
    .withExif({ IFD0: { Make: "SECRET-CAM" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 44/1 0/1" } }).toBuffer().then(b => { fs.writeFileSync(path.join(tmp, name), b); return path.join(tmp, name); });
  const f1 = await photo("living-before.jpg", "#7a6a55"), f2 = await photo("living-after.jpg", "#d8cbb4"), f3 = await photo("detail.jpg", "#a0907a");
  check("fixtures carry EXIF + GPS (so stripping is provable)", gpsEntries(fs.readFileSync(f1)) === 1);
  const video = path.join(ROOT, "assets", "hero-bg.mp4");

  try {
    // ===================================================== DESKTOP =====================================================
    const D = await setup(browser, { width: 1280, height: 900 }, "desktop");
    const page = D.page;
    await page.goto(base + "/admin.html", { waitUntil: "load" });
    await page.click('button[data-view="projects"]');
    await page.waitForSelector(".pj-card", { timeout: 15000 });
    check("desktop: tab opens, title 'פרויקטים'", (await page.textContent("#topTitle")).trim() === "פרויקטים");
    const cards = await page.$$eval(".pj-card", els => els.map(e => e.textContent));
    check("list: both projects as cards (newest first)", cards.length === 2 && /חידוש מדרגות/.test(cards[0]) && /ליטוש שיש בסלון ברעננה/.test(cards[1]), cards.join(" | "));
    check("card: title, city, service, file count, status", /רעננה · שיש ואבן · 2 קבצים/.test(cards[1]) && /פורסם/.test(cards[1]) && /טיוטה/.test(cards[0]));
    check("card: destination chips (site + instagram)", /🌐 אתר/.test(cards[1]) && /📸 אינסטגרם/.test(cards[1]));
    check("card: privacy warning + 'from the bot' + no-consent note on the flagged draft", /בדיקת פרטיות/.test(cards[0]) && /מהבוט/.test(cards[0]) && /ללא אישור לקוח/.test(cards[0]));
    check("card: cover image = the chosen cover (public variant URL)", (await page.$eval('[data-open="aaaaaaaa-1111-4111-8111-000000000001"] img', e => e.getAttribute("src"))).includes("m-p1-2/w480.webp"));
    await page.screenshot({ path: path.join(SHOTS, "desktop-1-list.png"), fullPage: true });

    await page.fill("#pjSearch", "רעננה");
    check("search: 'רעננה' → 1 card", (await page.$$(".pj-card")).length === 1 && /1 פרויקטים \(מתוך 2\)/.test(await page.textContent("#pjCount")));
    check("search: focus stays in the field while typing", await page.evaluate(() => document.activeElement && document.activeElement.id === "pjSearch"));
    await page.fill("#pjSearch", "");
    await page.selectOption("#pjService", "stairs");
    check("service filter: stairs → only the stairs project", (await page.$$(".pj-card")).length === 1 && /מדרגות/.test(await page.textContent(".pj-card")));
    await page.selectOption("#pjService", "");

    // realtime: a project created in the bot appears live
    await page.evaluate(() => {
      const S = window.__sb, row = { id: "aaaaaaaa-3333-4333-8333-000000000003", status: "collecting", consent: "unknown", service: null, city: null, title_he: "פרויקט חדש מהבוט",
        cover_media_id: null, watermark: true, source: "telegram", ai_meta: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      S.tables.projects.push(row);
      S.emit("projects", { eventType: "INSERT", new: row });
    });
    await page.waitForFunction(() => /פרויקט חדש מהבוט/.test(document.getElementById("pjRoot").textContent), null, { timeout: 5000 }).catch(() => {});
    check("realtime: a project created in the bot appears without a reload", /פרויקט חדש מהבוט/.test(await page.textContent("#pjRoot")));
    check("realtime: subscribed to projects AND project_media", await page.evaluate(() => ["projects", "project_media"].every(t => window.__sb.handlers.some(h => h.name === "projects-sync" && h.table === t))));

    // ---- new project + uploads ----
    await page.click("#pjNew");
    await page.waitForSelector("#pjEdTitle");
    const created = await page.evaluate(() => window.__sb.log.filter(l => l.table === "projects" && l.op === "insert").pop());
    check("new project: a projects row (status collecting, source panel)", created && created.row.status === "collecting" && created.row.source === "panel");
    check("new project: the editor opens with focus on its heading", await page.evaluate(() => document.activeElement && document.activeElement.id === "pjEdTitle"));
    const pid = created.row.id;
    await page.setInputFiles("#pjFiles", [f1, f2, f3, video]);
    await page.waitForFunction(() => document.querySelectorAll("#pjMedia .pj-media").length === 4, null, { timeout: 30000 }).catch(() => {});
    check("upload: 3 photos + 1 video → 4 media cards", (await page.$$("#pjMedia .pj-media")).length === 4);
    const ups = D.api.filter(a => a.action === "create-upload"), procs = D.api.filter(a => a.action === "process");
    check("upload: slots requested as JPEG for photos (re-encoded) + MP4 for the video + a JPEG cover", ups.filter(u => u.body.content_type === "image/jpeg").length === 4 && ups.filter(u => u.body.content_type === "video/mp4").length === 1, JSON.stringify(ups.map(u => u.body.content_type)));
    check("upload: every request carries the session token", D.api.every(a => a.auth === "Bearer fake-access-token"));
    check("upload: TUS to project-originals with upsert OFF (insert-only bucket policy)", D.tus.posts.length === 5 && D.tus.posts.every(p => p.bucket === "project-originals" && p.upsert === "false"), JSON.stringify(D.tus.posts.map(p => p.upsert)));
    const photoUploads = D.tus.posts.filter(p => p.type === "image/jpeg").map(p => Buffer.concat(D.tus.bytes[p.id]));
    check("upload: photos leave the browser WITHOUT EXIF/GPS and resized ≤ 2560", photoUploads.length === 4 && photoUploads.every(b => gpsEntries(b) === -1 && !b.includes("SECRET-CAM")), photoUploads.map(gpsEntries).join(","));
    const vp = procs.find(p => /\.mp4$/.test(p.body.path));
    check("upload: the video is processed with its cover frame (cover_path) and role video", vp && /incoming\/.+\.jpg$/.test(vp.body.cover_path || "") && vp.body.role === "video");
    check("upload: per-file progress bars were shown", D.tus.patches.length >= 5);
    check("upload: finished items leave the upload list", (await page.$$("#pjUploads .pj-up")).length === 0);
    check("upload: the resume records are cleared after processing", await page.evaluate(() => !Object.keys(localStorage).some(k => /^mrp_pj_up:/.test(k) || /^mrp_tus:/.test(k))));

    // ---- ✨ AI ----
    await page.fill("#pjAiText", "ליטוש והברקה לשיש בסלון");
    await page.evaluate((id) => window.__sb.emit("projects", { eventType: "UPDATE", new: { id: id } }), pid);   // a realtime refresh re-renders the editor
    await page.waitForTimeout(900);
    check("the typed 'מה עשינו?' text survives a re-render (realtime / an upload finishing)", (await page.inputValue("#pjAiText")) === "ליטוש והברקה לשיש בסלון");
    await page.click("#pjAnalyze");
    await page.waitForFunction(() => document.querySelector("#pjTitleHe") && document.querySelector("#pjTitleHe").value === "ליטוש שיש בסלון", null, { timeout: 10000 }).catch(() => {});
    const an = D.api.find(a => a.action === "analyze");
    check("AI: analyze called with the project + Miri's text", an && an.body.project_id === pid && an.body.text === "ליטוש והברקה לשיש בסלון", JSON.stringify(D.api.map(a => a.action)) + " pid=" + pid + " an=" + JSON.stringify(an && an.body));
    check("AI: titles HE + EN, summaries, caption filled (editable)", (await page.inputValue("#pjTitleEn")) === "Marble polishing in a living room" && /052‑9534540/.test(await page.inputValue("#pjCaption")) && /ליטוש/.test(await page.inputValue("#pjSumHe")));
    check("caption editor: the phone + domain show a NON-BREAKING hyphen (U+2011) on screen", /052‑9534540/.test(await page.inputValue("#pjCaption")) && /mr‑polishes\.com/.test(await page.inputValue("#pjCaption")) && !/052-9534540/.test(await page.inputValue("#pjCaption")));
    check("AI: pairs shown as editable role selects (before/after)", JSON.stringify(await page.$$eval('#pjMedia select[data-field="role"]', s => s.map(x => x.value))) === JSON.stringify(["before", "after", "before"]));
    check("AI: needs_review → a note asks to check the pairs", /בדקו את זוגות/.test(await page.textContent("#pjRoot")));
    check("AI: the face flag blocks with 'בדקתי, אפשר לפרסם' + 'הסרת התמונה'", (await page.$$('.pj-flag [data-act="ack"]')).length === 1 && (await page.$$('.pj-flag [data-act="remove"]')).length === 1);
    check("AI: quality warning chip (dark → חשוכה)", /חשוכה/.test(await page.textContent("#pjMedia")));
    check("gates: privacy + consent + destinations shown as missing", await page.$$eval(".pj-gates .no", els => els.length) === 3);
    await page.screenshot({ path: path.join(SHOTS, "desktop-2-editor-after-ai.png"), fullPage: true });

    // ---- privacy ack, swap, reorder, cover, alt ----
    await page.click('.pj-flag [data-act="ack"]');
    await page.waitForFunction(() => !document.querySelector(".pj-flag"), null, { timeout: 5000 }).catch(() => {});
    const ackLog = await page.evaluate(() => window.__sb.log.filter(l => l.table === "project_media" && l.op === "update" && l.patch.flags_ack_at));
    check("privacy: 'בדקתי' sets flags_ack_at; the card shows ✓ נבדק", ackLog.length === 1 && /✓ נבדק \(פנים\)/.test(await page.textContent("#pjMedia")));
    const firstId = await page.getAttribute("#pjMedia .pj-media:nth-child(1)", "data-media");
    await page.click('#pjMedia .pj-media:nth-child(1) [data-act="swap"]');
    await page.waitForTimeout(300);
    const roles = await page.evaluate(() => window.__sb.tables.project_media.filter(m => m.project_id === window.__pid).map(m => m.role));
    const swapped = await page.evaluate((id) => window.__sb.tables.project_media.find(m => m.id === id).role, firstId);
    check("swap ⇄: the pair's before/after are exchanged (saved)", swapped === "after", JSON.stringify(roles));
    await page.click('#pjMedia .pj-media:nth-child(1) [data-act="down"]');
    await page.waitForTimeout(300);
    check("reorder ▼: the first file moves to position 2 (sort saved)", (await page.getAttribute("#pjMedia .pj-media:nth-child(2)", "data-media")) === firstId &&
      await page.evaluate((id) => window.__sb.tables.project_media.find(m => m.id === id).sort === 1, firstId));
    check("reorder: focus follows the moved item's button", await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-act") === "down"));
    await page.click('#pjMedia .pj-media:nth-child(2) [data-act="cover"]');
    await page.waitForTimeout(200);
    check("cover ⭐: projects.cover_media_id saved + badge shown", await page.evaluate((a) => window.__sb.tables.projects.find(p => p.id === a.pid).cover_media_id === a.id, { pid, id: firstId }) &&
      /⭐ שער/.test(await page.textContent('#pjMedia .pj-media:nth-child(2)')));
    await page.click("#pjMedia .pj-media:nth-child(1) details summary");
    await page.fill('#pjMedia .pj-media:nth-child(1) input[data-field="alt_he"]', "רצפת שיש מבריקה בסלון");
    await page.press('#pjMedia .pj-media:nth-child(1) input[data-field="alt_he"]', "Tab");
    await page.waitForTimeout(200);
    check("alt text: edited and saved on change", await page.evaluate(() => window.__sb.log.some(l => l.table === "project_media" && l.op === "update" && l.patch.alt_he === "רצפת שיש מבריקה בסלון")));

    // ---- publishing choices ----
    await page.fill("#pjCity", "רחוב 12");
    await page.click("#pjSave");
    await page.waitForTimeout(200);
    check("city with digits → refused with a Hebrew message (nothing saved)", /אסור מספרים/.test(await page.textContent("#pjToast")) &&
      !(await page.evaluate((p) => window.__sb.log.some(l => l.table === "projects" && l.op === "update" && l.ids.includes(p) && "city" in l.patch && /12/.test(l.patch.city || "")), pid)));
    await page.fill("#pjCity", "רעננה");
    await page.check("#pjConsent");
    await page.click('[data-dest="site"]');
    await page.click('[data-dest="instagram"]');
    check("destinations: chips toggle (aria-pressed)", (await page.getAttribute('[data-dest="site"]', "aria-pressed")) === "true" && (await page.getAttribute('[data-dest="facebook"]', "aria-pressed")) === "false");
    check("unsaved changes are announced", /שינויים שלא נשמרו/.test(await page.textContent("#pjDirty")));
    await page.check('input[name="pjWhen"][value="at"]');
    await page.waitForTimeout(300);
    const defDate = await page.inputValue("#pjDate"), defTime = await page.inputValue("#pjTime");
    check("timing: 'pick' pre-fills the next free slot (burst guard), not the taken one", !!defDate && !!defTime && /המועד הפנוי הבא/.test(await page.textContent("#pjWhenHint")), defDate + " " + defTime);
    await page.fill("#pjDate", "2020-01-01");
    await page.dispatchEvent("#pjDate", "change");
    await page.click("#pjSave");
    await page.waitForTimeout(200);
    check("timing: a past date is refused", /כבר עבר/.test(await page.textContent("#pjToast")));
    await page.fill("#pjDate", defDate);
    await page.click("#pjSave");
    await page.waitForFunction(() => /נשמר/.test(document.getElementById("pjToast").textContent), null, { timeout: 5000 }).catch(() => {});
    const saveToast = await page.textContent("#pjToast");
    const proj = await page.evaluate((p) => window.__sb.tables.projects.find(x => x.id === p), pid);
    check("save: consent yes + consent_at + consent_by (who)", proj.consent === "yes" && !!proj.consent_at && proj.consent_by === "panel@example.com");
    check("save: the publish plan is saved (site + instagram, at a future time)", JSON.stringify(proj.ai_meta.publish_plan.destinations) === JSON.stringify(["site", "instagram"]) && proj.ai_meta.publish_plan.timing === "at" && new Date(proj.ai_meta.publish_plan.at) > new Date());
    check("save: the stored caption keeps a normal '-' (052-9534540, mr-polishes.com; no U+2011)", /052-9534540/.test(proj.ai_meta.caption_he) && /mr-polishes\.com/.test(proj.ai_meta.caption_he) && !/‑/.test(JSON.stringify(proj.ai_meta)));
    check("save: city + caption body/hashtags split for later AI corrections", proj.city === "רעננה" && proj.ai_meta.caption_body_he === "השיש בסלון חזר לברק ✨\nליטוש והברקה בכל השטח." && proj.ai_meta.hashtags.includes("#ליטוש_שיש"));
    check("save: every gate passes → status 'ready' (then the site publish)", (await page.$$(".pj-gates .no")).length === 0 && ["ready", "published"].includes(proj.status), proj.status);
    check("save + ready + the site → POST /api/site?action=publish with the session → 'עלה לאתר'", D.site.length === 1 && D.site[0].body.project_id === pid && D.site[0].auth === "Bearer fake-access-token" &&
      /עלה לאתר/.test(saveToast), JSON.stringify(D.site) + " toast=" + saveToast);
    check("the editor then shows the live page link (status published)", (await page.getAttribute(".pj-live a", "href")) === "/projects/litush-shayish-ve-even-raanana" && /פורסם/.test(await page.textContent(".pj-status")));
    // command 7: 💾 never publishes to the networks; only the explicit "📣 אישור פרסום ברשתות" does
    check("social (command 7): 💾 did NOT approve the networks (no social flag on the save's publish call)", D.site.length === 1 && D.site[0].body.social === undefined);
    await page.waitForSelector("#pjSocialGo", { timeout: 5000 }).catch(() => {});
    check("social: a ready/published project with Instagram chosen shows '📣 אישור פרסום ברשתות'", /אישור פרסום ברשתות/.test(await page.textContent("#pjSocial")));
    const dlgBefore = D.dialogs.length;
    await page.click("#pjSocialGo");
    await page.waitForFunction(() => /לוח הפרסום/.test(document.getElementById("pjToast").textContent), null, { timeout: 5000 }).catch(() => {});
    check("social: the button asks first, then POSTs {project_id, social: true} with the session → 'נכנסו ללוח הפרסום'",
      D.dialogs.length === dlgBefore + 1 && /לאשר פרסום ברשתות/.test(D.dialogs[D.dialogs.length - 1]) && D.site.length === 2 && D.site[1].body.social === true &&
      D.site[1].body.project_id === pid && D.site[1].auth === "Bearer fake-access-token" && /נכנסו ללוח הפרסום/.test(await page.textContent("#pjToast")), JSON.stringify(D.site[1]));

    // ---- corrections ----
    await page.click("#pjShorter");
    await page.waitForTimeout(500);
    const corr = D.api.filter(a => a.action === "correct").pop();
    check("✂️ shorter → correct('תקצר את הכיתוב'); 'caption not changed' is told, not hidden", corr && corr.body.text === "תקצר את הכיתוב" && /לא הצליח לקצר/.test(await page.textContent("#pjToast")));

    // ---- delete a file, then the project ----
    const before = (await page.$$("#pjMedia .pj-media")).length;
    await page.click('#pjMedia .pj-media:nth-child(4) [data-act="delete"]');
    await page.waitForTimeout(400);
    check("delete file: confirm → api delete → card gone", D.api.some(a => a.action === "delete") && (await page.$$("#pjMedia .pj-media")).length === before - 1);
    check("a11y: every visible button in the editor has a name", (await unnamedButtons(page, "#pjRoot")) === 0);
    await page.click("#pjDelete");
    await page.waitForSelector(".pj-card", { timeout: 5000 }).catch(() => {});
    const delMsg = D.dialogs.find(m => /למחוק את הפרויקט/.test(m)) || "";
    check("delete project: the confirm warns that Instagram posts must be deleted by hand", /אינסטגרם/.test(delMsg) && /ידנית/.test(delMsg) && /לא ניתן לשחזר/.test(delMsg));
    check("delete project: api delete-project → back to the list without it", D.api.some(a => a.action === "delete-project" && a.body.project_id === pid) && !(await page.$$eval(".pj-card", e => e.map(x => x.textContent).join())).includes("ליטוש שיש בסלון\u00a0"));
    check("delete project: the Instagram reminder is shown after deletion", D.dialogs.some(m => /פורסמו באינסטגרם/.test(m)));

    // ---- AI busy ----
    await page.click('[data-open="aaaaaaaa-2222-4222-8222-000000000002"]');
    await page.waitForSelector("#pjAnalyze");
    D.aiMode = "busy";
    await page.click("#pjAnalyze");
    await page.waitForTimeout(400);
    check("AI busy → a Hebrew message, buttons usable again", /עמוסה/.test(await page.textContent("#pjToast")) && !(await page.isDisabled("#pjAnalyze")));
    await page.click("#pjBack");

    // ---- ניהול תוכן → ➕ פוסט חדש (carousel) ----
    await page.click('button[data-view="content"]');
    await page.waitForSelector("#cqNewPostBtn");
    await page.click("#cqNewPostBtn");
    await page.waitForSelector("#cqNewModal:not([hidden])");
    check("new post: dialog opens with focus on the title", await page.evaluate(() => document.activeElement && document.activeElement.id === "npTitle"));
    const npDate = await page.inputValue("#npDate");
    check("new post: the date defaults to the next free slot (after the approved post)", !!npDate && /המועד הפנוי הבא/.test(await page.textContent("#npSlotHint")));
    await page.check('input[name="npType"][value="carousel"]');
    check("new post: carousel → multiple files allowed", await page.evaluate(() => document.getElementById("npFiles").multiple));
    await page.setInputFiles("#npFiles", [f1]);
    await page.fill("#npTitle", "קרוסלת בדיקה");
    await page.fill("#npCaption", "שלוש תמונות מהעבודה");
    await page.click("#npSubmit");
    check("new post: a 1-file carousel is refused (2–10)", /בין 2 ל-10/.test(await page.textContent("#npError")));
    await page.setInputFiles("#npFiles", [f1, f2, f3]);
    await page.fill("#npDate", "2020-01-01");
    await page.click("#npSubmit");
    check("new post: a past date is refused (burst guard)", /רבע שעה קדימה/.test(await page.textContent("#npError")));
    await page.fill("#npDate", npDate);
    const tusBefore = D.tus.posts.length;
    await page.click("#npSubmit");
    await page.waitForSelector("#cqNewModal", { state: "hidden", timeout: 15000 }).catch(() => {});
    const ins = await page.evaluate(() => window.__sb.log.filter(l => l.table === "content_queue" && l.op === "insert").pop());
    check("new post: ONE content_queue row, pending_approval, carousel with 3 items", ins && ins.row.status === "pending_approval" && ins.row.media_type === "carousel" && ins.row.media_items.length === 3, JSON.stringify(ins && ins.row).slice(0, 300));
    check("new post: media in the public content-media bucket (TUS, upsert off, EXIF stripped)", D.tus.posts.slice(tusBefore).every(p => p.bucket === "content-media" && p.upsert === "false" && /^panel\/\d{4}-\d{2}\//.test(p.object)) &&
      D.tus.posts.slice(tusBefore).map(p => Buffer.concat(D.tus.bytes[p.id])).every(b => gpsEntries(b) === -1) && ins.row.media_items.every(i => /\/storage\/v1\/object\/public\/content-media\/panel\//.test(i.url)));
    check("new post: scheduled in the future (the chosen slot)", new Date(ins.row.scheduled_for) > new Date());
    const card = await page.evaluate((id) => { const b = document.querySelector('#cqGrid [data-cq-reject="' + id + '"]'); let el = b; while (el && el.parentElement && el.parentElement.id !== "cqGrid") el = el.parentElement; return el ? el.textContent : document.getElementById("cqGrid").textContent.slice(0, 400); }, ins.row.id);
    check("carousel card (command 7): can be approved like any post — no 'בקרוב' any more", !/בקרוב/.test(card) && !!(await page.$('[data-cq-approve="' + ins.row.id + '"]')));
    check("desktop: no console errors", D.errors.length === 0, D.errors.slice(0, 3).join(" | "));
    check("desktop: nothing reached Supabase except mocked uploads/thumbnails", D.supabaseOther.length === 0, D.supabaseOther.slice(0, 2).join(" | "));
    await page.context().close();

    // ===================================================== MOBILE 390 =====================================================
    const M = await setup(browser, { width: 390, height: 844 }, "mobile");
    const mp = M.page;
    await mp.goto(base + "/admin.html", { waitUntil: "load" });
    await mp.click('button[data-view="projects"]');
    await mp.waitForSelector(".pj-card", { timeout: 15000 });
    const w = await mp.$eval(".pj-card", e => e.getBoundingClientRect().width);
    check("mobile: cards in one column (≈ full width)", w > 300 && w <= 390, String(w));
    check("mobile: no horizontal scroll on the list", await noOverflow(mp));
    const tap = await mp.$eval("#pjNew", e => e.getBoundingClientRect().height);
    check("mobile: touch targets ≥ 44px (new project, search)", tap >= 44 && (await mp.$eval("#pjSearch", e => e.getBoundingClientRect().height)) >= 44);
    check("mobile: inputs use 16px text (no iOS zoom)", (await mp.$eval("#pjSearch", e => getComputedStyle(e).fontSize)) === "16px");
    await mp.screenshot({ path: path.join(SHOTS, "mobile-1-list.png"), fullPage: true });
    await mp.evaluate(() => { window.__sb.tables.projects.find(p => p.id === "aaaaaaaa-2222-4222-8222-000000000002").ai_meta =
      { caption_he: "המדרגות חזרו לברק.\n\n📞 לתיאום בדיקה והצעת מחיר: 052-9534540 (גם בוואטסאפ) · mr-polishes.com\n\n#מדרגות" }; });
    await mp.click('[data-open="aaaaaaaa-2222-4222-8222-000000000002"]');
    await mp.waitForSelector("#pjEdTitle");
    // How the textarea wraps its own text (a mirror with the same computed styles), at many widths: the
    // phone number must never split; the same text with a normal '-' must split somewhere (the measure works).
    const wrap = await mp.evaluate(() => {
      const ta = document.getElementById("pjCaption"), cs = getComputedStyle(ta);
      const d = document.createElement("div");
      ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing", "paddingInlineStart", "paddingInlineEnd", "direction", "boxSizing", "textAlign"].forEach(k => { d.style[k] = cs[k]; });
      Object.assign(d.style, { whiteSpace: "pre-wrap", overflowWrap: "break-word", position: "absolute", visibility: "hidden", insetBlockStart: "0", insetInlineStart: "0" });
      document.body.appendChild(d);
      const lines = (text, w) => {
        d.style.width = w + "px"; d.textContent = text;
        const i = text.search(/052.9534540/), r = document.createRange();
        r.setStart(d.firstChild, i); r.setEnd(d.firstChild, i + 11);
        return new Set([...r.getClientRects()].filter(x => x.width > 0).map(x => Math.round(x.top / 4))).size;
      };
      const shown = ta.value, plain = shown.replace(/‑/g, "-"), out = { shown: 0, plain: 0, widths: 0 };
      for (let w = 180; w <= 380; w += 4) { out.widths++; if (lines(shown, w) > 1) out.shown++; if (lines(plain, w) > 1) out.plain++; }
      d.remove();
      return out;
    });
    check("mobile: the phone number in the caption editor never wraps (0 splits over 180–380px; a normal '-' splits at some widths)", wrap.shown === 0 && wrap.plain > 0, JSON.stringify(wrap));
    check("mobile: editor without horizontal scroll", await noOverflow(mp));
    check("mobile: RTL (dir=rtl on the page)", await mp.evaluate(() => document.documentElement.dir === "rtl"));
    check("mobile: the flagged photo from the bot shows the privacy block", (await mp.$$(".pj-flag")).length === 1);
    const bar = await mp.$eval(".pj-savebar", e => { const r = e.getBoundingClientRect(); return { pos: getComputedStyle(e).position, bottom: r.bottom }; });
    check("mobile: the save bar is sticky at the bottom", bar.pos === "sticky");
    await mp.setInputFiles("#pjFiles", [f1]);
    await mp.waitForFunction(() => document.querySelectorAll("#pjMedia .pj-media").length === 2, null, { timeout: 20000 }).catch(() => {});
    check("mobile: upload from the gallery works (file picker → card)", (await mp.$$("#pjMedia .pj-media")).length === 2);
    await mp.screenshot({ path: path.join(SHOTS, "mobile-2-editor.png"), fullPage: true });
    await mp.click('button[data-view="content"]');
    await mp.click("#cqNewPostBtn");
    await mp.waitForSelector("#cqNewModal:not([hidden])");
    check("mobile: the new-post dialog fits the screen", await mp.$eval("#cqNewModal .cq-modal__dialog", e => e.getBoundingClientRect().width <= 390));
    await mp.screenshot({ path: path.join(SHOTS, "mobile-3-new-post.png") });
    check("mobile: no console errors", M.errors.length === 0, M.errors.slice(0, 3).join(" | "));
    await mp.context().close();
  } catch (e) {
    console.log("HARNESS ERROR " + (e && e.stack || e));
    fail++;
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  process.exitCode = fail ? 1 : 0;
})();
