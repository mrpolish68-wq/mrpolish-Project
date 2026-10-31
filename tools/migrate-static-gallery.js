#!/usr/bin/env node
// Migrates the 5 static gallery projects (main.js / assets/gallery) into projects + project_media
// (media-projects command 6, D9). Every photo goes through the REAL pipeline (a preview's /api/media:
// a ≤ 2560 private original without EXIF, the WebP/JPEG/IG copies, the badge watermark ON); the
// before/after order is the static gallery's (correct — owner, D9). Each project: consent 'yes' (the
// photos were already public), source 'panel', the HE + EN texts below (written from the photos, no AI),
// the site destination, then published via api/_site-publish.js with its slug.
//
// Idempotent: a project is found by ai_meta.migration_key. Complete (all photos) → only its texts are
// refreshed; partial (an earlier run died) → deleted through the media API and redone; missing → created.
//
// Usage: node tools/migrate-static-gallery.js https://<preview>.vercel.app [--only p3] [--dry]
// Reads SUPABASE_SERVICE_ROLE_KEY, INTERNAL_API_SECRET and VERCEL_AUTOMATION_BYPASS_SECRET from .env (never printed).
"use strict";
const fs = require("fs");
const path = require("path");

const PREVIEW = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\/[^ ]+\.vercel\.app$/.test(PREVIEW)) { console.error("Usage: node tools/migrate-static-gallery.js https://<preview>.vercel.app [--only p3] [--dry]"); process.exit(2); }
const ONLY = (process.argv.indexOf("--only") !== -1) ? process.argv[process.argv.indexOf("--only") + 1] : null;
const DRY = process.argv.includes("--dry");
const ROOT = path.join(__dirname, "..");
fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).forEach(function (l) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
});
const SP = require(path.join(ROOT, "api", "_site-publish.js"));
const SB = "https://mmognkxkglkotzkuxzly.supabase.co";
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };

// The texts: only what the photos show (no sealer / crystal / "free" claims, no prices). City only where known.
const PROJECTS = [
  { key: "p1", slug: "hidush-bazelet-shchora", service: "marble_stone", city: null,
    title: ["חידוש ריצוף בזלת שחורה בחצר", "Black basalt patio renewal"],
    summary: ["ריצוף אבני בזלת בחצר היה מכוסה בלכלוך ובשאריות בנייה לבנות. אחרי הניקוי והחידוש האבן חזרה לגוון השחור העמוק שלה, והמישקים הבהירים בולטים שוב.",
      "The basalt flagstones in this yard were covered in grime and white construction residue. After cleaning and renewal the stone is back to its deep black, and the light joints stand out again."],
    angles: [
      [["אבני בזלת בחצר מכוסות בשכבה לבנה של שאריות בנייה", "Basalt flagstones in a yard covered with white construction residue"], ["ריצוף בזלת שחור ונקי בחצר עם מישקים בהירים", "Clean black basalt paving in a yard with light joints"]],
      [["ריצוף בזלת דהוי ומאובק בחצר לפני הטיפול", "Faded, dusty basalt paving in the yard before treatment"], ["שביל בזלת שחור ונקי לאורך קיר הבית", "Clean black basalt path along the house wall"]],
      [["אבני בזלת עם כתמים לבנים ושאריות טיח", "Basalt stones with white stains and plaster residue"], ["ריצוף בזלת שחור ואחיד אחרי החידוש", "Even black basalt paving after the renewal"]]
    ] },
  { key: "p2", slug: "hidush-even-yerushalmit", service: "marble_stone", city: null,
    title: ["חידוש אבן ירושלמית", "Jerusalem stone renewal"],
    summary: ["ריצוף אבן ירושלמית לא סדיר נראה דהוי ומאובק. אחרי הטיפול חזר לאבן הגוון החם והדבשי שלה.",
      "This irregular Jerusalem stone paving looked faded and dusty. After the treatment the stone got its warm, honey-colored tone back."],
    angles: [
      [["ריצוף אבן ירושלמית דהוי ומאובק ליד דלת זכוכית", "Faded, dusty Jerusalem stone paving by a glass door"], ["ריצוף אבן ירושלמית בגוון דבש חם אחרי החידוש", "Jerusalem stone paving in a warm honey tone after the renewal"]],
      [["אבן ירושלמית בהירה ומאובקת במרפסת לפני הטיפול", "Pale, dusty Jerusalem stone on a patio before treatment"], ["אבני ירושלמית נקיות בגוונים חמים לאורך הקיר", "Clean Jerusalem stones in warm tones along the wall"]]
    ] },
  { key: "p3", slug: "litush-terrazzo", service: "floor_polish", city: null,
    title: ["ליטוש רצפת טרצו", "Terrazzo floor polishing"],
    summary: ["רצפת טרצו ישנה הייתה עמומה ושרוטה. אחרי הליטוש וההברקה היא מחזירה אור, והגרגירים הצבעוניים באבן נראים בבירור.",
      "An old terrazzo floor had gone dull and scratched. After polishing it reflects the light again, and the colored chips in the stone show clearly."],
    angles: [
      [["רצפת טרצו עמומה עם גרגירי שיש גדולים לפני הליטוש", "Dull terrazzo floor with large marble chips before polishing"], ["מסדרון עם רצפת טרצו מבריקה המשקפת את האור", "Hallway with a glossy terrazzo floor reflecting the light"]]
    ] },
  { key: "p4", slug: "hidush-madregot-chalila", service: "stairs", city: null,
    title: ["חידוש מדרגות חלילה", "Spiral staircase restoration"],
    summary: ["מדרגות אבן בהירות בגרם מדרגות מסתובב היו עמומות ומלאות סימני שימוש. אחרי הליטוש הן קיבלו ברק עדין וגוון חם ואחיד.",
      "The light stone steps of this winding staircase were dull and worn. After polishing they have a soft sheen and a warm, even tone."],
    angles: [
      [["מדרגת אבן עמומה עם דיסקיות ליטוש במהלך העבודה", "A dull stone step with polishing pads during the work"], ["מדרגות אבן בגוון חם עם ברק עדין בגרם מסתובב", "Warm-toned stone steps with a soft sheen on a winding staircase"]],
      [["גרם מדרגות אבן בהיר ועמום לפני הליטוש", "A pale, dull stone staircase before polishing"], ["גרם מדרגות אבן מלוטש בגוון חם ואחיד", "A polished stone staircase in a warm, even tone"]]
    ] },
  { key: "p5", slug: "litush-shayish-krema-kfar-saba", service: "marble_stone", city: "כפר סבא",
    title: ["ליטוש שיש קרמה – בית החולים מאיר", "Crema marble polishing – Meir Hospital"],
    summary: ["רצפת שיש קרמה במסדרון בבית החולים מאיר הייתה עמומה ומלאה סימני הליכה. אחרי הליטוש וההברקה היא מבריקה עד כדי השתקפות של החלונות.",
      "The crema marble corridor floor at Meir Hospital was dull and marked by foot traffic. After polishing it shines enough to reflect the windows."],
    angles: [
      [["רצפת שיש קרמה עמומה במסדרון לפני הליטוש", "A dull crema marble corridor floor before polishing"], ["רצפת שיש קרמה מבריקה המשקפת את חלונות המסדרון", "A glossy crema marble floor reflecting the corridor windows"]]
    ] }
];

async function rest(p, init) {
  init = init || {};
  const r = await fetch(SB + "/rest/v1/" + p, Object.assign({}, init, { headers: Object.assign({}, H, init.headers || {}) }));
  const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch (e) {}
  if (!r.ok) throw new Error("REST " + (init.method || "GET") + " " + p.split("?")[0] + " → " + r.status + " " + ((b && (b.message || b.code)) || ""));
  return b;
}
async function media(action, body) {
  const r = await fetch(PREVIEW + "/api/media?action=" + action, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Internal-Secret": process.env.INTERNAL_API_SECRET, "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } });
  const j = await r.json().catch(function () { return {}; });
  if (r.status !== 200) throw new Error("media " + action + " → " + r.status + " " + (j.code || ""));
  return j;
}
async function uploadPhoto(projectId, file, role, pairNo, sort) {
  const buf = fs.readFileSync(file);
  const slot = await media("create-upload", { project_id: projectId, content_type: "image/jpeg", bytes: buf.length });
  const put = await fetch(slot.signed_url, { method: "PUT", headers: { "Content-Type": "image/jpeg", "x-upsert": "false" }, body: buf });
  if (!put.ok) throw new Error("signed upload → " + put.status);
  return (await media("process", { project_id: projectId, path: slot.path, role: role, pair_no: pairNo, sort: sort })).media;
}

(async function main() {
  const base = Date.now();
  let made = 0, refreshed = 0, published = 0;
  for (let i = 0; i < PROJECTS.length; i++) {
    const P = PROJECTS[i];
    if (ONLY && ONLY !== P.key) continue;
    const n = P.angles.length * 2;
    const texts = { service: P.service, city: P.city, title_he: P.title[0], title_en: P.title[1], summary_he: P.summary[0], summary_en: P.summary[1] };
    let row = (await rest("projects?ai_meta->>migration_key=eq." + P.key + "&ai_meta->>migrated_from=eq.static-gallery&select=*"))[0];
    if (row) {
      const have = await rest("project_media?project_id=eq." + row.id + "&select=id");
      if (have.length !== n) {
        console.log(P.key + ": partial (" + have.length + "/" + n + ") → redo");
        if (!DRY) await media("delete-project", { project_id: row.id });
        row = null;
      }
    }
    if (DRY) { console.log(P.key + ": " + (row ? "complete → refresh texts" : "create " + n + " photos") + " · slug " + P.slug); continue; }
    if (!row) {
      const now = new Date().toISOString();
      row = (await rest("projects", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(Object.assign({
        status: "collecting", source: "panel", consent: "yes", consent_at: now, consent_by: "migration (the static gallery was already public)", watermark: true,
        ai_meta: { migrated_from: "static-gallery", migration_key: P.key, publish_plan: { destinations: ["site"], timing: "now", at: null, saved_at: now } }
      }, texts)) }))[0];
      let cover = null, sort = 0;
      for (let a = 0; a < P.angles.length; a++) {
        for (const role of ["before", "after"]) {
          const file = path.join(ROOT, "assets", "gallery", "project" + P.key.slice(1) + "-" + role + (a + 1) + ".jpeg");
          const m = await uploadPhoto(row.id, file, role, a + 1, sort++);
          const alt = P.angles[a][role === "before" ? 0 : 1];
          await rest("project_media?id=eq." + m.id, { method: "PATCH", body: JSON.stringify({ alt_he: alt[0], alt_en: alt[1] }) });
          if (role === "after" && !cover) cover = m.id;
          process.stdout.write(".");
        }
      }
      await rest("projects?id=eq." + row.id, { method: "PATCH", body: JSON.stringify({ cover_media_id: cover, status: "ready" }) });
      console.log(" " + P.key + ": " + n + " photos processed");
      made++;
    } else {
      await rest("projects?id=eq." + row.id, { method: "PATCH", body: JSON.stringify(texts) });
      const ms = await rest("project_media?project_id=eq." + row.id + "&select=id,role,pair_no");
      for (const m of ms) {
        const alt = P.angles[m.pair_no - 1] && P.angles[m.pair_no - 1][m.role === "before" ? 0 : 1];
        if (alt) await rest("project_media?id=eq." + m.id, { method: "PATCH", body: JSON.stringify({ alt_he: alt[0], alt_en: alt[1] }) });
      }
      console.log(P.key + ": complete → texts refreshed");
      refreshed++;
      if (row.status === "published") continue;
    }
    // published_at: p1 newest, so the gallery keeps the static order
    const res = await SP.publishProject(row.id, { slug: P.slug, now: new Date(base - i * 60000) });
    console.log("   " + P.key + " → " + (res.published ? "published /projects/" + res.slug : JSON.stringify(res)));
    if (res.published) published++;
  }
  console.log("\ncreated " + made + ", refreshed " + refreshed + ", published " + published);
})().catch(function (e) { console.error("FAILED: " + e.message); process.exitCode = 1; });
