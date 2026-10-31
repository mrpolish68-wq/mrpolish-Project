// api/site.js + api/_site-publish.js (media-projects command 6): the gallery JSON, the project pages,
// the sitemap, the publish action and the publishing rules. Supabase (REST + auth) is mocked; the mock
// can IGNORE RLS on purpose, to prove the API's own check. No network. Fake values only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "svc-fake", INTERNAL_API_SECRET: "int-fake" });

const ANON_MARK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
const P = (n) => "aaaaaaaa-0000-4000-8000-00000000000" + n;
let db, calls, rlsOn, failReads, guardFail, slugRace;
function img(pid, mid) { const b = pid + "/" + mid + "/"; return { w480: { path: b + "w480.webp", width: 480, height: 360 }, w960: { path: b + "w960.webp", width: 960, height: 720 },
  w1600: { path: b + "w1600.webp", width: 1600, height: 1200 }, jpg: { path: b + "w1600.jpg", width: 1600, height: 1200 }, ig: { path: b + "ig.jpg" }, watermark: "badge" }; }
function media(pid, id, role, pair, sort, extra) { return Object.assign({ id, project_id: pid, kind: "image", role, pair_no: pair, sort, variants: img(pid, id), alt_he: "חלופי " + id, alt_en: "alt " + id, width: 2560, height: 1920 }, extra || {}); }
function reset() {
  calls = []; rlsOn = true; failReads = false; guardFail = false; slugRace = false;
  db = {
    projects: [
      { id: P(1), slug: "litush-shayish-ve-even-raanana", status: "published", consent: "yes", service: "marble_stone", city: "רעננה", title_he: "ליטוש שיש <b>בסלון</b>", title_en: "Marble </script><script>alert(1)</script>",
        summary_he: "רצפת שיש עמומה קיבלה ברק.", summary_en: "A dull marble floor got its shine back.", cover_media_id: "m1b", ai_meta: { caption_he: "SECRET CAPTION", publish_plan: { destinations: ["site"] } }, published_at: "2026-10-31T10:00:00Z", updated_at: "2026-10-31T10:00:00Z" },
      { id: P(2), slug: "hidush-madregot", status: "published", consent: "yes", service: "stairs", city: null, title_he: "חידוש מדרגות", title_en: "Stairs", summary_he: "", summary_en: "", cover_media_id: null, ai_meta: null, published_at: "2026-10-30T10:00:00Z" },
      { id: P(3), slug: "hidden-one", status: "published", consent: "yes", service: "other", city: null, title_he: "מוסתר", ai_meta: { site_hidden: true }, published_at: "2026-10-29T10:00:00Z" },
      { id: P(4), slug: "not-consented", status: "published", consent: "no", service: "other", title_he: "ללא הסכמה", ai_meta: null, published_at: "2026-10-28T10:00:00Z" },
      { id: P(5), slug: null, status: "ready", consent: "yes", service: "marble_stone", city: "רעננה", title_he: "מוכן", ai_meta: { publish_plan: { destinations: ["site", "instagram"], timing: "now" } }, updated_at: "2026-10-31T09:00:00Z" },
      { id: P(6), slug: null, status: "ready", consent: "yes", service: "stairs", city: "בית שמש", title_he: "מתוזמן", ai_meta: { publish_plan: { destinations: ["site"], timing: "at", at: "2099-01-01T08:00:00Z" } }, updated_at: "2026-10-31T09:00:00Z" },
      { id: P(7), slug: null, status: "ready", consent: "yes", service: "other", title_he: "רק אינסטגרם", ai_meta: { publish_plan: { destinations: ["instagram"], timing: "now" } }, updated_at: "2026-10-31T09:00:00Z" },
      { id: P(8), slug: null, status: "draft", consent: "unknown", title_he: "טיוטה", ai_meta: null }
    ],
    project_media: [
      media(P(1), "m1a", "before", 1, 0), media(P(1), "m1b", "after", 1, 1), media(P(1), "m1c", "before", 2, 2), media(P(1), "m1d", "after", 2, 3),
      media(P(1), "m1v", "video", null, 4, { kind: "video", variants: null }),
      media(P(2), "m2a", "after", null, 0),
      media(P(3), "m3a", "after", 1, 0), media(P(4), "m4a", "after", 1, 0)
    ],
    project_publications: []
  };
}
function res(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }
function filt(rows, qs) {
  const parts = (qs || "").split("&").filter(Boolean).map(p => { const i = p.indexOf("="); return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))]; });
  for (const [k, v] of parts) {
    if (["select", "order", "limit"].includes(k)) continue;
    let m;
    if ((m = v.match(/^eq\.(.*)$/))) rows = rows.filter(r => String(r[k]) === m[1]);
    else if (v === "not.is.null") rows = rows.filter(r => r[k] != null);
    else if ((m = v.match(/^in\.\((.*)\)$/))) rows = rows.filter(r => m[1].split(",").includes(String(r[k])));
    else if ((m = v.match(/^like\.(.*)\*$/))) rows = rows.filter(r => r[k] && String(r[k]).startsWith(m[1]));
  }
  return rows;
}
global.fetch = async function (url, init) {
  init = init || {}; url = String(url);
  const method = init.method || "GET", h = init.headers || {};
  const anon = String(h.apikey || "").startsWith(ANON_MARK);
  if (/\/auth\/v1\/user$/.test(url)) { calls.push({ kind: "auth" }); return h.Authorization === "Bearer good-session" ? res(200, { id: "u1" }) : res(401, {}); }
  const m = url.match(/\/rest\/v1\/(\w+)\?(.*)$/) || url.match(/\/rest\/v1\/(\w+)$/);
  if (!m) throw new Error("unmocked " + url);
  const table = m[1], qs = m[2] || "";
  calls.push({ kind: "rest", table, method, qs, anon, body: init.body ? JSON.parse(init.body) : null });
  if (failReads && method === "GET") return res(500, {});
  if (method === "GET") {
    let rows = filt(db[table], qs);
    if (anon && rlsOn && table === "projects") rows = rows.filter(r => r.status === "published" && r.consent === "yes");
    if (anon && rlsOn && table === "project_media") rows = rows.filter(r => db.projects.some(p => p.id === r.project_id && p.status === "published" && p.consent === "yes"));
    return res(200, JSON.parse(JSON.stringify(rows)));
  }
  if (anon) return res(401, { message: "anon cannot write" });
  const body = JSON.parse(init.body || "null");
  if (method === "PATCH") {
    if (guardFail && body.status === "published") return res(400, { code: "23514", message: "project x has flagged media that was not reviewed" });
    if (slugRace && body.slug) { slugRace = false; return res(409, { code: "23505", message: "duplicate key value violates unique constraint projects_slug_key" }); }
    const rows = filt(db[table], qs).filter(r => !/status=eq\.ready/.test(qs) || r.status === "ready");
    rows.forEach(r => Object.assign(r, body));
    return res(200, rows);
  }
  if (method === "POST") { db[table].push(body); return res(201, null); }
  throw new Error("unmocked " + method + " " + url);
};
const logs = [];
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
const site = require(REPO + "/api/site.js");
const SP = require(REPO + "/api/_site-publish.js");
let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; out("PASS " + name); } else out("FAIL " + name + (detail ? "  -- " + detail : "")); }
let ip = 0;
async function call(query, opts) {
  opts = opts || {};
  const r = { code: 0, headers: {}, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; } };
  await site({ method: opts.method || "GET", query, headers: Object.assign({ "x-forwarded-for": "10.9.0." + (++ip) }, opts.headers || {}), body: opts.body || {} }, r);
  return r;
}

(async function () {
  // ================================================================ gallery JSON
  reset();
  let r = await call({ r: "gallery" });
  let list = r.body.projects || [];
  check("gallery → 200 JSON, CDN-cacheable (s-maxage + stale-while-revalidate)", r.code === 200 && /s-maxage=300/.test(r.headers["cache-control"]) && /stale-while-revalidate/.test(r.headers["cache-control"]));
  check("gallery: reads with the ANON key only (RLS applies)", calls.filter(c => c.kind === "rest").every(c => c.anon));
  check("gallery: only published + consented + not hidden, newest first", list.map(p => p.slug).join() === "litush-shayish-ve-even-raanana,hidush-madregot", list.map(p => p.slug).join());
  rlsOn = false; calls = [];
  r = await call({ r: "gallery" });
  check("gallery: the API's OWN check holds even if RLS let everything through (no unconsented / hidden / unpublished)",
    (r.body.projects || []).map(p => p.slug).join() === "litush-shayish-ve-even-raanana,hidush-madregot", (r.body.projects || []).map(p => p.slug).join());
  rlsOn = true;
  const p1 = list[0];
  check("gallery: angles = the before/after pairs in order; videos skipped", p1.angles.length === 2 && p1.angles[0].before.alt.he === "חלופי m1a" && p1.angles[1].after.alt.en === "alt m1d");
  check("gallery: WebP srcset 480/960/1600 + width/height (no layout shift)", /w480\.webp$/.test(p1.angles[0].after.s[480]) && /w1600\.webp$/.test(p1.angles[0].after.s[1600]) && p1.angles[0].after.w === 1600 && p1.angles[0].after.h === 1200);
  check("gallery: the card cover = the chosen AFTER image (+ the first before for the card's sliver)", /m1b\/w480/.test(p1.cover.s[480]) && /m1a\//.test(p1.coverBefore.s[480]));
  check("gallery: HE + EN texts, city (HE + EN), service label", p1.title.en.startsWith("Marble") && p1.city.he === "רעננה" && p1.city.en === "Ra'anana" && p1.serviceLabel.en === "Marble & stone");
  check("gallery: a project with only an after photo → one angle without before", list[1].angles.length === 1 && list[1].angles[0].before === null && list[1].city === null);
  check("gallery: nothing private leaves (no captions, ai_meta, originals, flags)", !/SECRET CAPTION|ai_meta|original_path|ai_flags|project-originals/.test(JSON.stringify(r.body)));
  failReads = true;
  r = await call({ r: "gallery" });
  check("gallery: Supabase down → 503 + no-store (the homepage falls back to the static set)", r.code === 503 && r.headers["cache-control"] === "no-store");
  failReads = false;

  // ================================================================ project page
  r = await call({ r: "page", slug: "litush-shayish-ve-even-raanana" });
  let html = r.body;
  check("page → 200 HTML, cacheable, lang he / rtl", r.code === 200 && /text\/html/.test(r.headers["content-type"]) && /s-maxage=300/.test(r.headers["cache-control"]) && /<html lang="he" dir="rtl">/.test(html));
  check("page: ONE H1 = the title (escaped)", (html.match(/<h1/g) || []).length === 1 && /<h1 class="pp-title">ליטוש שיש &lt;b&gt;בסלון&lt;\/b&gt;<\/h1>/.test(html));
  check("page: the city + the service + the summary", /רעננה/.test(html) && /שיש ואבן/.test(html) && /רצפת שיש עמומה קיבלה ברק/.test(html));
  check("page: the before/after slider (srcset, sizes, width/height, the handle as a slider) + angle dots",
    /id="ppCompare"/.test(html) && /srcset="[^"]+w480\.webp 480w, [^"]+w960\.webp 960w, [^"]+w1600\.webp 1600w"/.test(html) && /width="1600" height="1200"/.test(html) &&
    /role="slider"/.test(html) && (html.match(/data-angle="/g) || []).length === 2);
  check("page: canonical + hreflang he / en / x-default", /<link rel="canonical" href="https:\/\/mr-polishes\.com\/projects\/litush-shayish-ve-even-raanana" \/>/.test(html) &&
    /hreflang="en" href="https:\/\/mr-polishes\.com\/projects\/litush-shayish-ve-even-raanana\?lang=en"/.test(html) && /hreflang="x-default"/.test(html));
  check("page: OG + Twitter with the project image (the JPEG copy, size, alt)", /og:image" content="[^"]+m1b\/w1600\.jpg"/.test(html) && /og:image:width" content="1600"/.test(html) &&
    /twitter:card" content="summary_large_image"/.test(html) && /og:type" content="article"/.test(html));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  check("page: JSON-LD CreativeWork + ImageObjects + the business @id + the service + the city + breadcrumbs",
    ld[0]["@type"] === "CreativeWork" && ld[0].image.length === 4 && ld[0].image.every(i => i["@type"] === "ImageObject" && /\.jpg$/.test(i.contentUrl)) &&
    ld[0].provider["@id"] === "https://mr-polishes.com/#business" && ld[0].about["@id"] === "https://mr-polishes.com/#service-marble-stone" &&
    ld[0].locationCreated.address.addressLocality === "רעננה" && ld[1]["@type"] === "BreadcrumbList" && ld[1].itemListElement.length === 3);
  check("page: the CTA — call + WhatsApp", /href="tel:\+972529534540"/.test(html) && /https:\/\/wa\.me\/972529534540\?text=/.test(html));
  check("page: the site's sticky mobile action bar (call / WhatsApp / Waze)", /<nav class="mobile-bar"/.test(html) && /mb-call/.test(html) && /mb-wa/.test(html) && /mb-waze/.test(html));
  check("page: more projects (not itself, not hidden / unconsented)", /class="pp-more"/.test(html) && /href="\/projects\/hidush-madregot"/.test(html) && !/href="\/projects\/litush-shayish-ve-even-raanana"/.test(html.split('class="pp-more"')[1]) && !/hidden-one|not-consented/.test(html));
  check("page: the slider data is CSP-safe JSON (no inline JS) and can't break out of its script tag", /<script type="application\/json" id="ppData">/.test(html) && !/<script>alert/.test(html) && !/<\/script><script>/.test(html.split('id="ppData">')[1].split("</script>")[0]));
  r = await call({ r: "page", slug: "litush-shayish-ve-even-raanana", lang: "en" });
  html = r.body;
  check("page ?lang=en → English, ltr, the EN title escaped, EN canonical", /<html lang="en" dir="ltr">/.test(html) && /Marble &lt;\/script&gt;/.test(html) && /rel="canonical" href="[^"]+\?lang=en"/.test(html) && /Ra&#39;anana/.test(html));
  for (const [slug, why] of [["hidden-one", "hidden"], ["not-consented", "no consent"], ["nope", "unknown"]]) {
    r = await call({ r: "page", slug });
    check("page: " + why + " → 404 noindex", r.code === 404 && /noindex/.test(r.body) && /הפרויקט לא נמצא/.test(r.body));
  }
  calls = [];
  r = await call({ r: "page", slug: "../../etc" });
  check("page: a malformed slug → 404 without touching the DB", r.code === 404 && !calls.some(c => c.kind === "rest"));
  failReads = true;
  r = await call({ r: "page", slug: "hidush-madregot" });
  check("page: Supabase down → 503 (not cached)", r.code === 503 && r.headers["cache-control"] === "no-store");
  failReads = false;

  // ================================================================ sitemap
  r = await call({ r: "sitemap" });
  check("sitemap: XML, HE + EN URL per project, hreflang + image entries, only the public ones", r.code === 200 && /application\/xml/.test(r.headers["content-type"]) &&
    (r.body.match(/<loc>/g) || []).length === 4 && /xhtml:link rel="alternate" hreflang="en"/.test(r.body) && /<image:loc>[^<]+w1600\.jpg<\/image:loc>/.test(r.body) && !/hidden-one|not-consented/.test(r.body));

  // ================================================================ publish action + rules
  r = await call({ action: "publish" }, { method: "POST", body: { project_id: P(5) } });
  check("publish: no auth → 401", r.code === 401);
  r = await call({ action: "publish" }, { method: "POST", headers: { authorization: "Bearer bad" }, body: { project_id: P(5) } });
  check("publish: an invalid session → 401", r.code === 401);
  r = await call({ action: "publish" }, { method: "GET", headers: { "x-internal-secret": "int-fake" } });
  check("publish: GET → 405", r.code === 405);
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: "x" } });
  check("publish: a bad id → 400", r.code === 400);
  r = await call({ action: "publish" }, { method: "POST", headers: { authorization: "Bearer good-session" }, body: { project_id: P(5) } });
  let p5 = db.projects.find(p => p.id === P(5));
  check("publish (panel session): ready + consent + site + now → published with the D7 slug (service + city)", r.code === 200 && r.body.published && p5.status === "published" &&
    p5.slug === "litush-shayish-ve-even-raanana-2" && r.body.url === "https://mr-polishes.com/projects/litush-shayish-ve-even-raanana-2", p5.slug);
  check("publish: the slug collision got -2 (the base is taken by another project)", /-2$/.test(p5.slug));
  check("publish: a project_publications row (site)", db.project_publications.some(x => x.project_id === P(5) && x.destination === "site"));
  check("publish: no-store on the answer", r.headers["cache-control"] === "no-store");
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(5) } });
  check("publish (the bot's secret) again → 'already' (idempotent)", r.code === 200 && r.body.already && r.body.slug === p5.slug);
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(6) } });
  check("publish: a future slot → 'scheduled', still ready", r.code === 200 && r.body.scheduled && db.projects.find(p => p.id === P(6)).status === "ready");
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(7) } });
  check("publish: no site destination → refused (409 no_site)", r.code === 409 && r.body.reason === "no_site");
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(8) } });
  check("publish: a draft → refused (not_ready)", r.code === 409 && r.body.reason === "not_ready");
  db.projects.push({ id: P(9), slug: null, status: "ready", consent: "yes", service: "crystal", city: "תל אביב", ai_meta: { publish_plan: { destinations: ["site"], timing: "now" } } });
  guardFail = true;
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(9) } });
  check("publish: the DB guard refuses (unreviewed flags) → reason 'guard', still ready", r.code === 409 && r.body.reason === "guard" && db.projects.find(p => p.id === P(9)).status === "ready");
  guardFail = false; slugRace = true;
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(9) } });
  check("publish: a slug taken meanwhile (unique 409) → retried → published", r.code === 200 && r.body.published && db.projects.find(p => p.id === P(9)).slug === "polish-kristal-tel-aviv");
  db.projects.push({ id: P(0), slug: null, status: "ready", consent: "yes", service: "other", ai_meta: { site_hidden: true, publish_plan: { destinations: ["site"], timing: "now" } } });
  r = await call({ action: "publish" }, { method: "POST", headers: { "x-internal-secret": "int-fake" }, body: { project_id: P(0) } });
  check("publish: hidden from the site → refused", r.code === 409 && r.body.reason === "hidden");

  // the cron
  const p6 = db.projects.find(p => p.id === P(6));
  const due = await SP.publishDue({ now: "2099-01-01T08:05:00Z" });
  check("cron publishDue: the scheduled project is published once its slot passes; instagram-only / hidden ones are not", p6.status === "published" && p6.slug === "hidush-madregot-beit-shemesh" &&
    db.projects.find(p => p.id === P(7)).status === "ready" && db.projects.find(p => p.id === P(0)).status === "ready" && due.published === 1, JSON.stringify(due));

  // slug helpers (D7)
  check("slugs: known city → its English slug; unknown → transliterated; no city → the service only",
    SP.baseSlug({ service: "stairs", city: "בית שמש" }) === "hidush-madregot-beit-shemesh" && SP.baseSlug({ service: "concrete", city: "כפר ורדים" }) === "litush-beton-kfr-vrdym" &&
    SP.baseSlug({ service: null, city: null }) === "litush-ritzpot" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(SP.baseSlug({ service: "crystal", city: "רמת גן!!" })));

  check("no secrets or keys in the logs", !logs.some(l => /svc-fake|int-fake|good-session/.test(l)));
  out("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(e => { out("HARNESS ERROR " + (e && e.stack || e)); process.exitCode = 1; });
