#!/usr/bin/env node
// LIVE evaluation of api/_media-ai.js against real Gemini (costs a few calls; NOT part of npm test).
//   node tools/media-ai-live-eval.js
// Calls (default 8, hard cap MAX_CALLS): 5 × analyzeProject on the 5 existing gallery projects (assets/gallery,
// SHUFFLED order + neutral names photo-N.jpg), 1 × analyzeProject on 2 synthetic privacy images (a car
// with a fake plate, a door with a house number — generated here, nothing real), 2 × applyMediaCorrection.
// The daily DB quota is NOT used (a fake consumeQuota). GOOGLE_AI_API_KEY is read from .env, never printed.
// Writes the full JSON report to .playwright-mcp/media-ai-eval/ (gitignored) and prints a summary.
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const sharp = require("sharp");

fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/).forEach(function (l) {
  const m = l.match(/^\s*(GOOGLE_AI_API_KEY)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
});
if (!process.env.GOOGLE_AI_API_KEY) { console.error("GOOGLE_AI_API_KEY missing in .env"); process.exit(2); }
const AI = require(path.join(ROOT, "api", "_media-ai.js"));
const OUT = path.join(ROOT, ".playwright-mcp", "media-ai-eval");
fs.mkdirSync(OUT, { recursive: true });

let calls = 0;
// MAX_CALLS (default 15) is a HARD cap: the quota stub refuses any call beyond it (nothing reaches Gemini).
const MAX_CALLS = Number(process.env.MAX_CALLS || 15);
const OPTS = { consumeQuota: async () => { if (calls >= MAX_CALLS) throw new Error("live call budget exceeded"); calls++; return { ok: true, remaining: 99 }; } };

// The 5 gallery projects (ground truth from the file names; the owner confirmed the before/after order).
const PROJECTS = [
  { key: "P1 basalt", n: 3, text: "סיימנו פרויקט ליטוש בזלת שחורה בחצר, ניקוי ומילוי פוגות", services: ["marble_stone"], city: null },
  { key: "P2 Jerusalem stone", n: 2, text: "ניקוי, ליטוש וסילר לאבן ירושלמית במרפסת בירושלים", services: ["marble_stone", "sealer"], city: "ירושלים" },
  { key: "P3 terrazzo", n: 1, text: "", services: ["floor_polish", "crystal"], city: null },
  { key: "P4 stairs", n: 2, text: "חידוש מדרגות חלילה אצל משפחת לוי ברחוב הנרקיס 7 בבית שמש, עלה 6800 ש\"ח, הלקוחה רותי מאוד מרוצה", services: ["stairs"], city: "בית שמש",
    // whole words only: "לוי" must not match inside "בלויות" (worn) — a false alarm in the first run
    forbidden: /(^|[^א-ת])(לוי|רותי|הנרקיס)([^א-ת]|$)|(^|\D)7(\D|$)|6800|6,800|ש"ח|₪|שקל/ },
  { key: "P5 crema marble", n: 1, text: "ליטוש והברקה לשיש קרמה בלובי של בית חולים", services: ["marble_stone", "crystal"], city: null }
];
function rng(seed) { return function () { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; }; }
function shuffle(arr, seed) { const r = rng(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function evalProject(p, idx) {
  const files = [];
  for (let k = 1; k <= p.n; k++) for (const role of ["before", "after"]) files.push({ truth: { role, pair: k }, file: path.join(ROOT, "assets/gallery", "project" + (idx + 1) + "-" + role + k + ".jpeg") });
  const shuffled = shuffle(files, 7 + idx * 13);
  const images = shuffled.map((f, i) => ({ id: "img" + i, order: i, filename: "photo-" + (i + 1) + ".jpg", buffer: fs.readFileSync(f.file), truth: f.truth }));
  const t0 = Date.now();
  const r = await AI.analyzeProject({ images: images.map(({ truth, ...x }) => x), text: p.text || undefined, todayIL: "30.10.2026" }, OPTS);
  const ms = Date.now() - t0;
  const truthById = Object.fromEntries(images.map(i => [i.id, i.truth]));
  const roleOk = r.images.filter(im => im.role === truthById[im.id].role).length;
  const byPair = {};
  r.images.forEach(im => { if (im.pair_no != null) (byPair[im.pair_no] = byPair[im.pair_no] || []).push(truthById[im.id]); });
  const pairsOk = Object.values(byPair).filter(m => m.length === 2 && m[0].pair === m[1].pair && m[0].role !== m[1].role).length;
  const allText = JSON.stringify([r.caption_he, r.title_he, r.title_en, r.summary_he, r.summary_en, r.images.map(i => [i.alt_he, i.alt_en])]);
  return {
    project: p.key, images: images.length, order: shuffled.map(f => f.truth.role[0] + f.truth.pair).join(","),
    roles_correct: roleOk + "/" + images.length, pairs_correct: pairsOk + "/" + p.n, pairing_source: r.pairing_source, pairing_confidence: r.pairing_confidence,
    service: r.service, service_ok: p.services.includes(r.service), city: r.city, city_ok: r.city === p.city,
    forbidden_found: p.forbidden ? p.forbidden.test(allText) : false, flagged: r.images.filter(i => i.flagged).length,
    alt_he_sample: r.images[0].alt_he, alt_en_sample: r.images[0].alt_en, title_he: r.title_he, caption_he: r.caption_he,
    warnings: r.warnings, missing: r.missing, ms: ms, analysis: r
  };
}

async function privacyImages() {
  const car = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#c9c4bb"/>
    <rect y="560" width="1024" height="208" fill="#77736c"/>
    <path d="M220 470 Q240 330 380 310 L660 310 Q790 330 810 470 L840 560 L190 560 Z" fill="#2e4a7a"/>
    <rect x="300" y="345" width="430" height="110" rx="18" fill="#9fc2dd"/>
    <circle cx="300" cy="575" r="62" fill="#1d1d1d"/><circle cx="730" cy="575" r="62" fill="#1d1d1d"/>
    <rect x="410" y="485" width="210" height="52" rx="6" fill="#f2c200" stroke="#111" stroke-width="4"/>
    <rect x="410" y="485" width="34" height="52" fill="#1f4fbf"/><text x="427" y="519" font-family="Arial" font-size="13" fill="#fff" text-anchor="middle">IL</text>
    <text x="532" y="525" font-family="Arial" font-weight="bold" font-size="36" fill="#111" text-anchor="middle">12-345-67</text></svg>`;
  const door = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#e8e1d4"/>
    <rect x="330" y="140" width="360" height="560" fill="#7a4e2d" stroke="#4d2f19" stroke-width="10"/>
    <circle cx="640" cy="430" r="14" fill="#d4af37"/>
    <rect x="740" y="210" width="150" height="110" rx="10" fill="#1f3c88" stroke="#fff" stroke-width="6"/>
    <text x="815" y="292" font-family="Arial" font-weight="bold" font-size="80" fill="#fff" text-anchor="middle">24</text>
    <rect y="700" width="1024" height="68" fill="#bfb6a6"/></svg>`;
  return [
    { id: "car", order: 0, filename: "photo-1.jpg", buffer: await sharp(Buffer.from(car)).jpeg().toBuffer() },
    { id: "door", order: 1, filename: "photo-2.jpg", buffer: await sharp(Buffer.from(door)).jpeg().toBuffer() }
  ];
}

(async () => {
  const results = [];
  // ONLY=P1,P3 runs just those projects; SKIP_PRIVACY=1 / SKIP_CORRECTIONS=1 skip those calls (to save live calls)
  const only = (process.env.ONLY || "").split(",").filter(Boolean);
  for (let i = 0; i < PROJECTS.length; i++) {
    if (only.length && !only.some(k => PROJECTS[i].key.startsWith(k))) continue;
    try { results.push(await evalProject(PROJECTS[i], i)); }
    catch (e) { results.push({ project: PROJECTS[i].key, error: e.code + " " + e.message }); }
  }
  let privacy = "skipped";
  if (!process.env.SKIP_PRIVACY) try {
    const imgs = await privacyImages();
    const r = await AI.analyzeProject({ images: imgs, text: "בדיקת פרטיות" }, OPTS);
    privacy = r.images.map(im => ({ id: im.id, flags: im.privacy_flags.map(p => p.type), ai_flags: im.ai_flags, flagged: im.flagged }));
  } catch (e) { privacy = { error: e.code + " " + e.message }; }
  const corrections = [];
  // SHORTER_ONLY=1 CORRECT_ON=P1 → only the "shorter caption" correction, on that project (1–2 calls)
  if (process.env.SHORTER_ONLY && !process.env.SKIP_CORRECTIONS) {
    const t = results.find(r => r.analysis && r.project.startsWith(process.env.CORRECT_ON || "P1"));
    if (t) try {
      const c = await AI.applyMediaCorrection(t.analysis, { text: "תקצר את הכיתוב בבקשה" }, OPTS);
      corrections.push({ ask: "shorter caption (" + t.project + ")", caption_len_before: (t.analysis.caption_body_he || "").length,
        caption_len_after: (c.caption_body_he || "").length, warnings: c.warnings, caption_he: c.caption_he, ok: !c.warnings.includes("caption_not_changed") });
    } catch (e) { corrections.push({ error: e.code + " " + e.message }); }
  }
  const p2 = results.find(r => r.project === "P2 Jerusalem stone" && r.analysis);
  if (p2 && !process.env.SKIP_CORRECTIONS && !process.env.SHORTER_ONLY) {
    try {
      const before = p2.analysis.images.map(i => i.role[0] + (i.pair_no || "-")).join(",");
      const c1 = await AI.applyMediaCorrection(p2.analysis, { text: "התמונה הראשונה זה לא " + (p2.analysis.images[0].role === "before" ? "לפני, זה אחרי" : "אחרי, זה לפני") }, OPTS);
      corrections.push({ ask: "flip image 1", before, after: c1.images.map(i => i.role[0] + (i.pair_no || "-")).join(","), ok: c1.images[0].role !== p2.analysis.images[0].role });
      const c2 = await AI.applyMediaCorrection(c1, { text: "העיר היא רעננה ותכתבו כיתוב קצר יותר" }, OPTS);
      corrections.push({ ask: "city רעננה + shorter caption", city: c2.city, caption_len_before: (c1.caption_body_he || "").length, caption_len_after: (c2.caption_body_he || "").length, caption_he: c2.caption_he, ok: c2.city === "רעננה" });
    } catch (e) { corrections.push({ error: e.code + " " + e.message }); }
  }
  const report = { live_calls: calls, results, privacy, corrections };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("live Gemini calls: " + calls);
  console.log("\nproject              | imgs | shuffled order | roles | pairs | pairing (conf) | service (ok) | city (ok) | forbidden | ms");
  results.forEach(r => {
    if (r.error) return console.log(r.project + " ERROR " + r.error);
    console.log([r.project.padEnd(20), String(r.images).padEnd(4), r.order.padEnd(14), r.roles_correct.padEnd(5), r.pairs_correct.padEnd(5),
      (r.pairing_source + " (" + r.pairing_confidence + ")").padEnd(14), (r.service + (r.service_ok ? " ✓" : " ✗")).padEnd(12), (String(r.city) + (r.city_ok ? " ✓" : " ✗")).padEnd(9),
      r.forbidden_found ? "FOUND ✗" : "none ✓", r.ms].join(" | "));
  });
  console.log("\nprivacy: " + JSON.stringify(privacy));
  console.log("corrections: " + JSON.stringify(corrections.map(c => Object.assign({}, c, { caption_he: undefined }))));
  results.forEach(r => { if (!r.error) console.log("\n--- " + r.project + " · alt_he: " + r.alt_he_sample + "\n    alt_en: " + r.alt_en_sample + "\n    title: " + r.title_he + "\n    warnings: " + JSON.stringify(r.warnings)); });
  results.filter(r => !r.error).slice(0, 5).forEach(r => console.log("\n=== caption " + r.project + " ===\n" + r.caption_he));
  const c2 = corrections.find(c => c.caption_he);
  if (c2) console.log("\n=== caption after correction ===\n" + c2.caption_he);
})().catch(e => { console.error(e.stack); process.exit(1); });
