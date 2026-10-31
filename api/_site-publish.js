// Site publishing for projects (media-projects command 6). Underscore-prefixed: a helper, not a Vercel
// function. Used by the publish cron (api/publish-scheduled-content.js, every 10 min via pg_cron), by
// api/site.js (POST ?action=publish — the panel's 💾 and the bot's ✅ אשר, for "now"), and by the
// migration tool.
//
// A project becomes PUBLISHED on the site when: status 'ready', consent 'yes', the "site" destination in
// ai_meta.publish_plan, not hidden (ai_meta.site_hidden), and due (timing "now", or its slot has passed).
// The DB guard (projects_guard_publish) still refuses publishing without consent or with unreviewed
// privacy flags. Publishing gives the project its slug (D7: /projects/<service>-<city>, -2, -3 … on a
// collision) and a project_publications row. Social destinations stay for command 7. Unpublish = hide
// (ai_meta.site_hidden): the site API never serves a hidden, unpublished or unconsented project.
"use strict";

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const SITE_URL = "https://mr-polishes.com";
const TIMEOUT_MS = 12000;

const SERVICE_SLUG = { floor_polish: "litush-mirtzafot", crystal: "polish-kristal", marble_stone: "litush-shayish-ve-even", sealer: "silar-hagana",
  concrete: "litush-beton", bomanite: "hidush-bomanite", stairs: "hidush-madregot", other: "litush-ritzpot" };
const SERVICE_LABEL = {
  floor_polish: ["ליטוש מרצפות", "Floor polishing"], crystal: ["פוליש קריסטל", "Crystal polish"], marble_stone: ["שיש ואבן", "Marble & stone"],
  sealer: ["סילר הגנה", "Protective sealer"], concrete: ["בטון", "Concrete"], bomanite: ["בומנייט", "Bomanite"], stairs: ["מדרגות", "Stairs"], other: ["ליטוש רצפות", "Floor restoration"]
};
// City → [English name, slug]. Anything else is transliterated letter by letter.
const CITIES = {
  "תל אביב": ["Tel Aviv", "tel-aviv"], "תל אביב-יפו": ["Tel Aviv", "tel-aviv"], "ירושלים": ["Jerusalem", "jerusalem"], "בית שמש": ["Beit Shemesh", "beit-shemesh"],
  "רעננה": ["Ra'anana", "raanana"], "הרצליה": ["Herzliya", "herzliya"], "כפר סבא": ["Kfar Saba", "kfar-saba"], "הוד השרון": ["Hod HaSharon", "hod-hasharon"],
  "רמת גן": ["Ramat Gan", "ramat-gan"], "גבעתיים": ["Givatayim", "givatayim"], "פתח תקווה": ["Petah Tikva", "petah-tikva"], "פתח תקוה": ["Petah Tikva", "petah-tikva"],
  "ראשון לציון": ["Rishon LeZion", "rishon-lezion"], "חולון": ["Holon", "holon"], "בת ים": ["Bat Yam", "bat-yam"], "נתניה": ["Netanya", "netanya"],
  "מודיעין": ["Modi'in", "modiin"], "רחובות": ["Rehovot", "rehovot"], "נס ציונה": ["Ness Ziona", "ness-ziona"], "אשדוד": ["Ashdod", "ashdod"],
  "אשקלון": ["Ashkelon", "ashkelon"], "חיפה": ["Haifa", "haifa"], "באר שבע": ["Be'er Sheva", "beer-sheva"], "בני ברק": ["Bnei Brak", "bnei-brak"],
  "מבשרת ציון": ["Mevaseret Zion", "mevaseret-zion"], "רמת השרון": ["Ramat HaSharon", "ramat-hasharon"], "ראש העין": ["Rosh HaAyin", "rosh-haayin"],
  "שוהם": ["Shoham", "shoham"], "לוד": ["Lod", "lod"], "רמלה": ["Ramla", "ramla"], "יהוד": ["Yehud", "yehud"], "אור יהודה": ["Or Yehuda", "or-yehuda"],
  "גבעת שמואל": ["Givat Shmuel", "givat-shmuel"], "קריית אונו": ["Kiryat Ono", "kiryat-ono"], "מעלה אדומים": ["Ma'ale Adumim", "maale-adumim"],
  "גבעת זאב": ["Givat Ze'ev", "givat-zeev"], "צור הדסה": ["Tzur Hadassah", "tzur-hadassah"], "אפרת": ["Efrat", "efrat"], "זכרון יעקב": ["Zichron Ya'akov", "zichron-yaakov"],
  "קיסריה": ["Caesarea", "caesarea"], "חדרה": ["Hadera", "hadera"], "יבנה": ["Yavne", "yavne"], "גדרה": ["Gedera", "gedera"], "אילת": ["Eilat", "eilat"],
  "אבן יהודה": ["Even Yehuda", "even-yehuda"], "כפר יונה": ["Kfar Yona", "kfar-yona"], "אלעד": ["El'ad", "elad"], "ביתר עילית": ["Beitar Illit", "beitar-illit"]
};
const HE_LETTERS = { "א": "a", "ב": "b", "ג": "g", "ד": "d", "ה": "h", "ו": "v", "ז": "z", "ח": "ch", "ט": "t", "י": "y", "כ": "k", "ך": "k", "ל": "l", "מ": "m", "ם": "m",
  "נ": "n", "ן": "n", "ס": "s", "ע": "a", "פ": "p", "ף": "f", "צ": "tz", "ץ": "tz", "ק": "k", "ר": "r", "ש": "sh", "ת": "t" };

function translit(s) {
  // פ is "p" at the start of a word and usually "f" inside it (כפר → kfr, פתח → pth)
  return String(s || "").split("").map(function (c, i, a) {
    if (c === "פ") return i === 0 || !/[א-ת]/.test(a[i - 1]) ? "p" : "f";
    return HE_LETTERS[c] !== undefined ? HE_LETTERS[c] : c;
  }).join("")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function cityInfo(city) {
  var c = String(city || "").trim();
  if (!c) return null;
  if (CITIES[c]) return { he: c, en: CITIES[c][0], slug: CITIES[c][1] };
  var t = translit(c);
  return { he: c, en: t ? t.split("-").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ") : c, slug: t };
}
function baseSlug(project) {
  var parts = [SERVICE_SLUG[project.service] || SERVICE_SLUG.other];
  var ci = cityInfo(project.city);
  if (ci && ci.slug) parts.push(ci.slug);
  return parts.join("-").replace(/-+/g, "-").slice(0, 72).replace(/-+$/, "");
}

function svc(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(pathQs, init) {
  init = Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, init || {});
  init.headers = svc(init.headers);
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + pathQs, init);
  var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: body };
}

// The first free slug: base, base-2, base-3 … (projects.slug is unique).
async function uniqueSlug(base, selfId) {
  var r = await rest("projects?slug=like." + encodeURIComponent(base + "*") + "&select=id,slug");
  if (!r.ok) throw new Error("slug lookup failed: " + r.status);
  var taken = {};
  (r.body || []).forEach(function (x) { if (x.id !== selfId) taken[x.slug] = true; });
  if (!taken[base]) return base;
  for (var n = 2; n < 500; n++) if (!taken[base + "-" + n]) return base + "-" + n;
  throw new Error("no free slug");
}

function siteDue(project, now) {
  var meta = project.ai_meta || {}, plan = meta.publish_plan || {};
  if ((plan.destinations || []).indexOf("site") === -1) return { ok: false, reason: "no_site" };
  if (meta.site_hidden) return { ok: false, reason: "hidden" };
  if (plan.timing === "at" && plan.at) {
    var at = new Date(plan.at);
    if (!isNaN(at) && at.getTime() > now.getTime()) return { ok: false, reason: "scheduled", at: at.toISOString() };
  }
  return { ok: true };
}

// → { ok, published?, already?, scheduled?, at?, slug?, url?, reason? }
async function publishProject(projectId, opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  var r = await rest("projects?id=eq." + encodeURIComponent(projectId) + "&select=*");
  if (!r.ok) throw new Error("project lookup failed: " + r.status);
  var p = r.body && r.body[0];
  if (!p) return { ok: false, reason: "not_found" };
  if (p.status === "published") return { ok: true, already: true, slug: p.slug, url: p.slug ? SITE_URL + "/projects/" + p.slug : null };
  if (p.status !== "ready") return { ok: false, reason: "not_ready" };
  if (p.consent !== "yes") return { ok: false, reason: "no_consent" };
  var due = siteDue(p, now);
  if (!due.ok && !(opts.force && due.reason === "scheduled")) return due.reason === "scheduled" ? { ok: true, scheduled: true, at: due.at } : { ok: false, reason: due.reason };
  for (var attempt = 0; attempt < 3; attempt++) {
    var slug = p.slug || await uniqueSlug(opts.slug || baseSlug(p), p.id);
    var up = await rest("projects?id=eq." + encodeURIComponent(p.id) + "&status=eq.ready", {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "published", published_at: now.toISOString(), slug: slug })
    });
    if (up.status === 409) { p.slug = null; continue; }   // a slug taken meanwhile → the next free one
    if (!up.ok) {
      var msg = (up.body && up.body.message) || "";
      return { ok: false, reason: /consent|flagged/.test(msg) ? "guard" : "update_failed", detail: up.status };
    }
    if (!up.body || !up.body.length) return { ok: false, reason: "not_ready" };   // someone else changed it
    var plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
    await rest("project_publications", { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ project_id: p.id, destination: "site", scheduled_for: plan.timing === "at" && plan.at ? plan.at : now.toISOString() }) }).catch(function () {});
    console.log("[site-publish] published project=" + p.id + " slug=" + slug);
    return { ok: true, published: true, slug: slug, url: SITE_URL + "/projects/" + slug };
  }
  return { ok: false, reason: "slug_conflict" };
}

// The cron: every ready + consented project whose site slot has come.
async function publishDue(opts) {
  var now = opts && opts.now ? new Date(opts.now) : new Date();
  var r = await rest("projects?status=eq.ready&consent=eq.yes&select=id,ai_meta&order=updated_at.asc&limit=50");
  if (!r.ok) throw new Error("ready projects lookup failed: " + r.status);
  var out = { checked: (r.body || []).length, published: 0, failed: 0 };
  for (var i = 0; i < (r.body || []).length; i++) {
    var p = r.body[i];
    if (!siteDue(p, now).ok) continue;
    try {
      var res = await publishProject(p.id, { now: now });
      if (res.published) out.published++; else if (!res.ok) out.failed++;
    } catch (err) { out.failed++; console.error("[site-publish] " + p.id + ": " + err.message); }
  }
  return out;
}

module.exports = { publishProject, publishDue, baseSlug, uniqueSlug, cityInfo, translit, siteDue, SERVICE_LABEL, SERVICE_SLUG, SITE_URL };
