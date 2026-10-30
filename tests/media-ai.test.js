// api/_media-ai.js offline: Gemini is MOCKED (opts.fetch) and so is the quota (opts.consumeQuota).
// What reaches Gemini (≤ 1024 px, no EXIF, no file names, phones stripped), the rules enforced in
// code (no prices / names / streets / phones; city only if stated; enums; lengths), the pairing
// fallbacks, privacy flags → DB flags, hashtags + the fixed CTA, corrections, quota and errors.
"use strict";
const path = require("path");
const sharp = require("sharp");
const REPO = path.resolve(__dirname, "..");
process.env.GOOGLE_AI_API_KEY = "g-fake";
const AI = require(REPO + "/api/_media-ai.js");

let passed = 0, total = 0;
const logs = [];
console.log = (...a) => logs.push(a.join(" "));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");
function check(name, cond, detail) { total++; if (cond) { passed++; out("PASS " + name); } else out("FAIL " + name + (detail !== undefined ? "  -- " + detail : "")); }
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

let requests = [], reply = null, status = 200, quotaCalls = 0, quotaMode = "ok";
const fakeFetch = async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  if (status !== 200) return { ok: false, status, json: async () => (status === 400 ? { error: { message: "Your project has exceeded its monthly spending cap" } } : { error: { status: status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL" } }) };
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }) };
};
const quota = async () => { quotaCalls++; if (quotaMode === "down") throw new Error("db down"); return quotaMode === "empty" ? { ok: false, remaining: 0 } : { ok: true, remaining: 29 }; };
const OPTS = { fetch: fakeFetch, consumeQuota: quota };
function reset(r) { requests = []; reply = r; status = 200; quotaCalls = 0; quotaMode = "ok"; }

const img = (role, pair, extra) => Object.assign({ index: 0, role, pair_no: pair, confidence: 0.9, alt_he: "רצפת שיש " + (role === "before" ? "לפני" : "אחרי") + " הליטוש", alt_en: "Marble floor " + role,
  privacy_flags: [], quality_flags: [] }, extra || {});
function base(images, extra) {
  return Object.assign({ transcript: null, images: images.map((x, i) => Object.assign(x, { index: i + 1 })), pairing_confidence: 0.9, service: "marble_stone", city: null,
    title_he: "ליטוש שיש בסלון", title_en: "Marble polishing in a living room", summary_he: "רצפת שיש עמומה קיבלה ליטוש והברקה. התוצאה: ברק עמוק ואחיד.",
    summary_en: "A dull marble floor was polished. The result: an even, deep shine.", caption_body_he: "השיש הזה שכח איך הוא נראה ✨\n\nליטוש, הברקה וסילר הגנה. פרויקט אמיתי מהשטח, לא הדמיה.",
    hashtags: ["ליטוש_שיש", "#לפני_ואחרי", "#שיש", "#מיסטר_פוליש", "#הברקת_רצפות", "#שיפוץ"], missing: [] }, extra || {});
}

(async function main() {
  const photo = (w, h, c) => sharp({ create: { width: w, height: h, channels: 3, background: c || "#776655" } }).jpeg().withExif({ IFD0: { Make: "SECRET-CAM" } }).toBuffer();
  const big = await photo(4000, 3000);
  const imgs = (n, names) => Promise.all(Array.from({ length: n }, async (_, i) => ({ id: "m" + (i + 1), buffer: big, order: i, filename: names ? names[i] : "IMG_" + (1000 + i) + ".jpg" })));

  // ---- what reaches Gemini ----
  reset(base([img("before", 1), img("after", 1)]));
  let r = await AI.analyzeProject({ images: await imgs(2, ["family-cohen-before.jpg", "x.jpg"]), text: "ליטוש שיש, תתקשרו 050-1234567" }, OPTS);
  const parts = requests[0].body.contents[0].parts;
  const inl = parts.filter(p => p.inline_data);
  const sent = await sharp(Buffer.from(inl[0].inline_data.data, "base64")).metadata();
  check("images sent as ≤ 1024 px JPEG with NO EXIF", inl.length === 2 && Math.max(sent.width, sent.height) === 1024 && !sent.exif && inl[0].inline_data.mime_type === "image/jpeg");
  const bodyText = JSON.stringify(requests[0].body);
  check("file names are NOT sent to Gemini", !/family-cohen|IMG_100/.test(bodyText));
  check("phone numbers are stripped from the user's text before sending", !/050-1234567/.test(bodyText) && /מספר הוסר/.test(bodyText));
  check("the images are labelled 'Image 1', 'Image 2' in order", parts.some(p => p.text === "Image 1:") && parts.some(p => p.text === "Image 2:"));
  check("same model + key header as the quote bot", /gemini-3\.5-flash:generateContent/.test(requests[0].url));
  check("one media_ai quota unit per call", quotaCalls === 1);
  check("result maps back to the caller's ids", r.images[0].id === "m1" && r.images[1].id === "m2" && r.pairing_source === "ai");

  // ---- caption + CTA + hashtags ----
  check("caption = body + the fixed CTA (052-9534540 + WhatsApp) + hashtags", r.caption_he.startsWith(r.caption_body_he) &&
    r.caption_he.includes("052-9534540") && r.caption_he.includes("וואטסאפ") && r.caption_he.endsWith(r.hashtags.join(" ")), r.caption_he);
  check("hashtags normalized (# added), 6–10, no duplicates", r.hashtags[0] === "#ליטוש_שיש" && r.hashtags.length >= 6 && r.hashtags.length <= 10 && new Set(r.hashtags).size === r.hashtags.length, r.hashtags.join(" "));
  reset(base([img("before", 1), img("after", 1)], { hashtags: ["#a b c", "#12345", "###", "#שיש"], service: "stairs" }));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  check("too few / bad hashtags → padded from the service + brand tags (no numbers)", r.hashtags.length >= 6 && r.hashtags.includes("#חידוש_מדרגות") && r.hashtags.includes("#a_b_c") && !r.hashtags.some(t => /\d{3,}/.test(t)), r.hashtags.join(" "));

  // ---- no prices / names / streets / phones ----
  const dirty = base([img("before", 1, { alt_he: "רצפה אצל משפחת כהן לפני" }), img("after", 1)], {
    caption_body_he: "השיש של משפחת כהן חזר לחיים ✨\n\nהעבודה עלתה 4,500 ₪ בלבד. ברחוב הרצל 12 עשינו ליטוש מלא. התוצאה מדברת בעד עצמה!",
    summary_he: "ליטוש ברחוב הרצל 12 ברעננה. התקשרו 050-7654321 לפרטים. רצפה מבריקה.", title_he: "עבודה לדנה ב-3,000 שקל", city: "רעננה" });
  reset(dirty);
  r = await AI.analyzeProject({ images: await imgs(2), text: "סיימנו אצל משפחת כהן ברחוב הרצל 12 ברעננה, עלה 4500 ש\"ח, הלקוחה דנה מרוצה" }, OPTS);
  const all = JSON.stringify([r.caption_he, r.summary_he, r.summary_en, r.title_he, r.images.map(i => i.alt_he)]);
  check("no price anywhere (₪ / ש\"ח / שקל / 4,500)", !/₪|ש"ח|שקל|4,500|4500|3,000/.test(all), all);
  check("no client names (כהן / דנה) anywhere", !/כהן|דנה/.test(all), all);
  check("no street / house number (הרצל 12) anywhere", !/הרצל|12/.test(all), all);
  check("no phone except the business number in the CTA", !/050-7654321|7654321/.test(all) && (r.caption_he.match(/\d{3}-\d{7}/g) || []).every(p => p === "052-9534540"));
  check("the clean sentences survive (hook dropped with its name, result kept)", /התוצאה מדברת בעד עצמה/.test(r.caption_body_he) && /רצפה מבריקה/.test(r.summary_he), r.caption_body_he + " | " + r.summary_he);
  check("a title that is only a price/name → rejected (null) + a warning", r.title_he === null && r.warnings.some(w => /^title_he:/.test(w)), JSON.stringify(r.warnings));
  check("an alt with a name → replaced by a safe generic alt", r.images[0].alt_he && !/כהן/.test(r.images[0].alt_he) && /לפני/.test(r.images[0].alt_he), r.images[0].alt_he);
  check("the stated city is accepted (רעננה, said by the user)", r.city === "רעננה" && !r.missing.includes("city"));

  // ---- city only if stated ----
  reset(base([img("before", 1), img("after", 1)], { city: "תל אביב" }));
  r = await AI.analyzeProject({ images: await imgs(2), text: "ליטוש שיש בסלון" }, OPTS);
  check("a city the user did NOT say → null, missing ['city'], warning", r.city === null && r.missing[0] === "city" && r.warnings.includes("city:not_stated_or_invalid"));
  reset(base([img("before", 1), img("after", 1)], { city: "הרצל 12" }));
  r = await AI.analyzeProject({ images: await imgs(2), text: "ברחוב הרצל 12" }, OPTS);
  check("a 'city' with a number / street → rejected", r.city === null);
  reset(base([img("before", 1), img("after", 1)], { city: "בית שמש" }));
  r = await AI.analyzeProject({ images: await imgs(2), text: "עבודה יפה בבית שמש היום" }, OPTS);
  check("a two-word city with the ב prefix in the text → accepted", r.city === "בית שמש" && r.hashtags.includes("#בית_שמש"), r.city + " " + r.hashtags.join(" "));
  reset(base([img("before", 1), img("after", 1)], { city: "בית שמש", hashtags: ["#ביתשמש", "#ליטושאבן", "#ליטוש_אבן", "#שיש", "#מדרגות", "#סילר"] }));
  r = await AI.analyzeProject({ images: await imgs(2), text: "בבית שמש" }, OPTS);
  check("hashtags that differ only by '_' count once (#ביתשמש = #בית_שמש, #ליטושאבן = #ליטוש_אבן)", r.hashtags.filter(t => t.replace(/_/g, "") === "#ביתשמש").length === 1 &&
    r.hashtags.filter(t => t.replace(/_/g, "") === "#ליטושאבן").length === 1, r.hashtags.join(" "));

  // ---- enums / lengths ----
  reset(base([img("before", 1, { alt_he: "א".repeat(300), quality_flags: ["blurry", "weird", "blurry"], role: "bogus" }), img("after", 1)], { service: "carpet" }));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  check("unknown service → 'other'", r.service === "other");
  check("alt capped at 125 chars", r.images[0].alt_he.length <= 126, r.images[0].alt_he.length);
  check("quality flags: enum only, deduped", JSON.stringify(r.images[0].quality_flags) === '["blurry"]');
  check("an unknown role → detail → it fills the missing 'before' (ai-roles), needs_review", r.pairing_source === "ai-roles" && r.images[0].role === "before" && r.images[1].role === "after" && r.needs_review === true);

  // ---- pairing fallbacks ----
  // the live P3 case: shuffled upload (after first), confident roles, but a low pairing score →
  // the AI's ROLES are kept and re-paired ('ai-roles'), not overwritten by the upload order
  reset(base([img("after", 1, { confidence: 0.95 }), img("before", 1, { confidence: 0.9 })], { pairing_confidence: 0 }));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  check("low pairing score + confident balanced roles → 'ai-roles': roles kept (a,b), paired", r.pairing_source === "ai-roles" &&
    r.images.map(i => i.role[0] + i.pair_no).join(",") === "a1,b1" && r.images.every(i => i.ai_role === i.role), r.images.map(i => i.role + i.pair_no).join(","));
  reset(base([img("before", 1), img("before", 1), img("after", 2), img("after", 2)]));
  r = await AI.analyzeProject({ images: await imgs(4, ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]) }, OPTS);
  check("impossible pairs (two befores in pair 1) but confident roles → re-paired within roles", r.pairing_source === "ai-roles" &&
    r.images.map(i => i.role[0] + i.pair_no).join(",") === "b1,b2,a1,a2", r.images.map(i => i.role[0] + i.pair_no).join(","));
  reset(base([img("before", 1, { confidence: 0.3 }), img("after", 1, { confidence: 0.4 }), img("before", 2, { confidence: 0.3 }), img("after", 2, { confidence: 0.2 })], { pairing_confidence: 0.3 }));
  r = await AI.analyzeProject({ images: await imgs(4) }, OPTS);
  check("unsure roles AND pairs → fallback by upload order (b,a,b,a; pairs 1,1,2,2)", r.pairing_source === "order" && r.images.map(i => i.role[0] + i.pair_no).join(",") === "b1,a1,b2,a2");
  reset(base([img("before", 1), img("before", 1), img("before", 2), img("after", 2)]));
  r = await AI.analyzeProject({ images: await imgs(4) }, OPTS);
  check("unbalanced roles (3 befores, 1 after) → fallback by order", r.pairing_source === "order");
  reset(base([img("before", 1, { confidence: 0.2 }), img("after", 1, { confidence: 0.2 }), img("before", 2, { confidence: 0.2 }), img("after", 2, { confidence: 0.2 })], { pairing_confidence: 0.2 }));
  r = await AI.analyzeProject({ images: await imgs(4, ["kitchen_after.jpg", "kitchen_before.jpg", "hall-after.jpg", "hall-before.jpg"]) }, OPTS);
  check("file names with before/after → fallback by name", r.pairing_source === "filename" && r.images.map(i => i.role[0] + i.pair_no).join(",") === "a1,b1,a2,b2", r.images.map(i => i.role + i.pair_no).join(","));
  reset(base([img("before", 1), img("after", 1), img("detail", null)], { pairing_confidence: 0.1 }));
  r = await AI.analyzeProject({ images: await imgs(3) }, OPTS);
  check("odd count by order → the last one is a detail", r.images[2].role === "detail" && r.images[2].pair_no === null);
  reset(base([img("before", 2), img("after", 2), img("detail", null)]));
  r = await AI.analyzeProject({ images: await imgs(3) }, OPTS);
  check("confident, valid AI pairs (+ a detail) are kept", r.pairing_source === "ai" && r.images[2].role === "detail");

  // the live P1 shape: 6 photos, the AI called one 'before' a detail → filled → all 6 roles right, 3 pairs
  reset(base([img("after", 2), img("before", 2), img("after", 1), img("after", 3), img("detail", null, { confidence: 0.9 }), img("before", 3)], { pairing_confidence: 0.92 }));
  r = await AI.analyzeProject({ images: await imgs(6) }, OPTS);
  check("live P1 shape: a 'detail' fills the missing before → ai-roles, 3 befores + 3 afters, AI pair numbers kept where valid",
    r.pairing_source === "ai-roles" && r.images.filter(i => i.role === "before").length === 3 && r.images[4].role === "before" && r.images[4].ai_role === "detail", r.images.map(i => i.role[0] + i.pair_no).join(","));
  check("ai_role / ai_pair keep what the AI said", r.images[0].ai_role === "after" && r.images[0].ai_pair === 2);
  // the live P3 shape: both photos called 'after' (no detail to fill) → order, needs_review
  reset(base([img("after", 1, { confidence: 0.85 }), img("after", 1, { confidence: 0.9 })], { pairing_confidence: 0.3 }));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  check("live P3 shape: two 'after's, nothing to fill → order + needs_review", r.pairing_source === "order" && r.needs_review === true);
  reset(base([img("before", 1), img("after", 1)]));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  check("confident AI pairs → needs_review false", r.pairing_source === "ai" && r.needs_review === false);

  // ---- privacy flags ----
  reset(base([img("before", 1, { privacy_flags: [{ type: "license_plate", note: "car plate 12-345-67 visible" }, { type: "face", note: "a person at the door" }, { type: "bogus", note: "x" }] }), img("after", 1)]));
  r = await AI.analyzeProject({ images: await imgs(2) }, OPTS);
  const pf = r.images[0];
  check("privacy flags: enum only (bogus dropped)", pf.privacy_flags.length === 2 && pf.privacy_flags.map(p => p.type).join(",") === "license_plate,face");
  check("flag notes never carry the number itself (digits masked)", !/\d/.test(JSON.stringify(pf.privacy_flags)), JSON.stringify(pf.privacy_flags));
  check("→ DB ai_flags {faces, plates} + flagged; the clean image isn't flagged", pf.ai_flags.faces && pf.ai_flags.plates && !pf.ai_flags.house_numbers && pf.flagged === true && r.images[1].flagged === false);

  // ---- quota + errors ----
  reset(base([img("before", 1), img("after", 1)])); quotaMode = "empty";
  let e = await errOf(AI.analyzeProject({ images: await imgs(2) }, OPTS));
  check("quota used up → 'quota' + Hebrew, and Gemini is NOT called", e && e.code === "quota" && /מכסת/.test(e.he) && requests.length === 0);
  reset(base([])); quotaMode = "down";
  e = await errOf(AI.analyzeProject({ images: await imgs(2) }, OPTS));
  check("quota service down → quota_unavailable (fails closed)", e && e.code === "quota_unavailable" && requests.length === 0);
  for (const [code, name] of [[429, "429"], [400, "spend cap"]]) {
    reset(base([])); status = code;
    e = await errOf(AI.analyzeProject({ images: await imgs(2) }, OPTS));
    check("Gemini " + name + " → ai_busy (typed, Hebrew)", e && e.code === "ai_busy" && /עמוסה/.test(e.he), e && e.code);
  }
  reset(base([])); status = 500;
  e = await errOf(AI.analyzeProject({ images: await imgs(2) }, OPTS));
  check("Gemini 500 → ai_failed", e && e.code === "ai_failed");
  e = await errOf(AI.analyzeProject({ images: [] }, OPTS));
  check("no images → invalid_input", e && e.code === "invalid_input");
  e = await errOf(AI.analyzeProject({ images: await imgs(11) }, OPTS));
  check("more than 10 images → invalid_input", e && e.code === "invalid_input" && /10/.test(e.he));
  reset(base([]));
  e = await errOf(AI.analyzeProject({ images: [{ id: "x", buffer: Buffer.from("not an image") }] }, OPTS));
  check("an unreadable image → invalid_input (before any quota use)", e && e.code === "invalid_input" && quotaCalls === 0);

  // ---- audio ----
  reset(base([img("before", 1), img("after", 1)], { transcript: "סיימנו עבודה ברעננה", city: "רעננה" }));
  r = await AI.analyzeProject({ images: await imgs(2), audio: Buffer.from("OggS-fake-audio"), mimeType: "audio/ogg" }, OPTS);
  const audioPart = requests[0].body.contents[0].parts.find(p => p.inline_data && p.inline_data.mime_type === "audio/ogg");
  check("audio → sent inline; the city from the transcript is accepted", !!audioPart && r.city === "רעננה" && r.transcript === "סיימנו עבודה ברעננה");

  // ---- corrections ----
  reset(base([img("before", 1), img("after", 1), img("before", 2), img("after", 2)]));
  const a0 = await AI.analyzeProject({ images: await imgs(4) }, OPTS);
  reset({ images: [{ index: 3, role: "after" }] });
  r = await AI.applyMediaCorrection(a0, { text: "התמונה השלישית זה לא לפני, זה אחרי" }, OPTS);
  check("'זה לא לפני, זה אחרי' → image 3 becomes after AND its partner becomes before", r.images[2].role === "after" && r.images[3].role === "before" && r.images[0].role === "before", r.images.map(i => i.role).join(","));
  check("a correction uses one quota unit and sends the current state", quotaCalls === 1 && requests[0].body.contents[0].parts[0].text.includes('"index":3'));
  reset({ images: [], city: "רעננה" });
  r = await AI.applyMediaCorrection(a0, { text: "העיר היא רעננה" }, OPTS);
  check("'העיר היא רעננה' → city set, removed from missing, hashtag added", r.city === "רעננה" && !r.missing.includes("city") && r.hashtags.includes("#רעננה"));
  reset({ images: [], city: "חיפה" });
  r = await AI.applyMediaCorrection(a0, { text: "תחליף את הכיתוב" }, OPTS);
  check("a city the correction didn't say is ignored", r.city === null && r.warnings.includes("city:not_stated_or_invalid"));
  reset({ images: [], caption_body_he: "רצפה חדשה לגמרי ✨ עלה רק 2000 ש\"ח. ליטוש מקצועי מהשטח." });
  r = await AI.applyMediaCorrection(a0, { text: "תחליף את הכיתוב" }, OPTS);
  check("a rewritten caption is sanitized too (price sentence dropped) and the CTA re-attached", !/2000|ש"ח/.test(r.caption_he) && /ליטוש מקצועי/.test(r.caption_he) && r.caption_he.includes("052-9534540"), r.caption_he);
  reset({ images: [], city: "רעננה" });
  r = await AI.applyMediaCorrection(a0, { text: "העיר היא רעננה ותכתבו כיתוב קצר יותר" }, OPTS);
  check("asked to shorten the caption but none came back → warning caption_not_changed (seen live)", r.warnings.includes("caption_not_changed") && r.city === "רעננה");
  reset({ images: [], city: "רעננה" });
  r = await AI.applyMediaCorrection(a0, { text: "העיר היא רעננה" }, OPTS);
  check("…but not when the caption wasn't mentioned", !r.warnings.includes("caption_not_changed"));
  e = await errOf(AI.applyMediaCorrection(a0, { text: "  " }, OPTS));
  check("an empty correction → invalid_input", e && e.code === "invalid_input");

  check("logs: op/timing/outcome only (no prompts, captions or keys)", logs.every(l => /^\[media-ai\] op=\w+ ms=\d+ outcome=/.test(l)) && !logs.some(l => /g-fake|כהן|שיש/.test(l)), logs.slice(0, 2).join(" | "));
  out("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { out("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
