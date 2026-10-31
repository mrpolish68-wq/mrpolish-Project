// Project media endpoint (media-projects plan, Phase 8) — the 8th Vercel function (Hobby limit: 12).
//
//   POST /api/media?action=create-upload  {project_id, kind: 'image'|'video', content_type, bytes}
//        → where to upload: a path in the private bucket project-originals + a signed upload URL (small
//          files) and the TUS endpoint (the panel uploads big files resumably with its own session).
//          Files never pass through this function (Vercel's 4.5 MB body limit).
//   POST /api/media?action=process        {project_id, path, role?, pair_no?, sort?, cover_path?, telegram_file_unique_id?}
//        → image: the uploaded file → a ≤ 2560px JPEG original (private) + site variants + the 4:5
//          Instagram JPEG (public bucket project-media), watermarked per the project (D4), a
//          project_media row; the raw upload is deleted. Video: MP4/MOV metadata via Range reads
//          (≤ 50 MB, H.264/HEVC, 3 s – 15 min) + an optional cover image → a project_media row.
//   POST /api/media?action=delete         {media_id} → the row's files (both buckets) + the row.
//        A telegram_file_unique_id (the bot) that the project already has → 409 `duplicate`, and the
//        files made for it are removed again (unique (project_id, telegram_file_unique_id)).
//   POST /api/media?action=analyze        {project_id, text?, audio?, mime_type?} → Gemini vision (api/_media-ai.js) on the
//        project's photos (the private originals, ≤ 10): roles, pairs, alt texts, privacy flags, the
//        service / city / titles / summaries / caption; saved to project_media + projects (ai_meta).
//        A photo Miri already reviewed ("בדקתי") keeps its acknowledgement (the photo didn't change).
//        audio = a voice note from the bot (base64, in memory only — never stored).
//   POST /api/media?action=correct        {project_id, text | audio + mime_type} → a correction in plain words ("תקצר את
//        הכיתוב", "העיר היא רעננה") on the CURRENT saved state (so manual edits in the panel count).
//   POST /api/media?action=delete-project {project_id} → every file of the project (both buckets, incl.
//        unprocessed uploads) + the project (cascades to media + publications). Posts not yet published
//        are cancelled (rejected); Instagram posts already published must be deleted by hand.
//
// Auth: a real Supabase session (the panel) OR X-Internal-Secret = INTERNAL_API_SECRET (the bot,
// server-to-server). Every action is rate-limited; process also uses the daily `media_file` quota.
// Errors carry a `code` and a Hebrew `he` message the panel / bot can show as-is.
"use strict";

const crypto = require("crypto");
const { enforce } = require("./_rate-limit.js");
const { consumeQuota } = require("./_quota.js");
const MP = require("./_media-process.js");
const MA = require("./_media-ai.js");
const VM = require("./_video-meta.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";
const ORIGINALS = "project-originals";
const PUBLIC = "project-media";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp("^" + UUID + "$");
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const VIDEO_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov" };
const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"];
const MAX_BYTES = 50 * 1024 * 1024;
// Public copies: Cache-Control max-age=86400 (owner, 2026-10-31). The CDN keeps serving a cached copy
// after a delete, so a removed photo must not stay reachable for long (it was 1 year).
// Storage serves the uploaded cache-control as-is, so it must be a valid header: a bare "86400" was
// served as "public, 86400" (invalid → ignored). Checked live by tools/media-cache-check.js.
const PUBLIC_CACHE_SECONDS = 86400;
function cacheControl(bucket, seconds) {
  return (bucket === PUBLIC ? "public" : "private") + ", max-age=" + (seconds || 3600);
}
const LIMITS = { "create-upload": [60, 60000], process: [30, 60000], delete: [30, 60000], analyze: [10, 60000], correct: [10, 60000], "delete-project": [10, 60000] };
var timeoutMs = 20000;

function safeEqual(a, b) {
  var bufA = Buffer.from(String(a || ""), "utf8"), bufB = Buffer.from(String(b || ""), "utf8");
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function svc(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key }, extra || {});
}
function fail(res, status, code, he, extra) {
  res.status(status).json(Object.assign({ error: code, code: code, he: he }, extra || {}));
}
async function verifySupabaseUser(accessToken) {
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  var data = await res.json();
  return data && data.id ? data : null;
}
// The panel (a session) or the bot (the internal secret). Returns a caller label or null.
async function authenticate(req) {
  var secret = process.env.INTERNAL_API_SECRET;
  if (secret && req.headers["x-internal-secret"] && safeEqual(req.headers["x-internal-secret"], secret)) return "internal";
  var token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  var user = await verifySupabaseUser(token);
  return user ? "user:" + user.id : null;
}

// ---- Supabase REST + Storage (service role) ----
async function rest(pathQs, init) {
  init = Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init || {});
  init.headers = svc(Object.assign({ "Content-Type": "application/json" }, init.headers || {}));
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + pathQs, init);
  if (!res.ok) throw new Error("Supabase REST " + (init.method || "GET") + " " + pathQs.split("?")[0] + " failed: " + res.status);
  return res.status === 204 ? null : res.json();
}
async function getProject(id, fields) {
  var rows = await rest("projects?id=eq." + encodeURIComponent(id) + "&select=" + (fields || "id,watermark,status"));
  return rows && rows[0] || null;
}
async function storageUpload(bucket, objectPath, buffer, contentType, cacheSeconds) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + objectPath, {
    method: "POST", body: buffer, signal: AbortSignal.timeout(timeoutMs),
    headers: svc({ "Content-Type": contentType, "x-upsert": "true", "cache-control": cacheControl(bucket, cacheSeconds) })
  });
  if (!res.ok) throw new Error("storage upload " + bucket + " failed: " + res.status);
}
async function storageDownload(bucket, objectPath) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + objectPath, { headers: svc(), signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error("storage download failed: " + res.status);
  var len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new MP.MediaError("too_large", "file larger than 50 MB", "הקובץ גדול מדי (מעל 50MB).");
  return Buffer.from(await res.arrayBuffer());
}
async function storageSize(bucket, objectPath) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + objectPath, {
    headers: svc({ Range: "bytes=0-0" }), signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error("storage size failed: " + res.status);
  var cr = res.headers.get("content-range");   // "bytes 0-0/12345"
  var total = cr && Number(cr.split("/")[1]);
  return total || Number(res.headers.get("content-length") || 0);
}
async function storageRemove(bucket, paths) {
  if (!paths.length) return;
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket, {
    method: "DELETE", body: JSON.stringify({ prefixes: paths }), signal: AbortSignal.timeout(timeoutMs),
    headers: svc({ "Content-Type": "application/json" })
  });
  if (!res.ok) throw new Error("storage delete " + bucket + " failed: " + res.status);
}
async function storageList(bucket, prefix) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/list/" + bucket, {
    method: "POST", body: JSON.stringify({ prefix: prefix, limit: 1000, offset: 0 }), signal: AbortSignal.timeout(timeoutMs),
    headers: svc({ "Content-Type": "application/json" })
  });
  if (!res.ok) throw new Error("storage list " + bucket + " failed: " + res.status);
  var items = await res.json();
  return (items || []).filter(function (it) { return it && it.id; }).map(function (it) { return prefix + it.name; });   // files only (folders have no id)
}
async function signedUpload(bucket, objectPath) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/upload/sign/" + bucket + "/" + objectPath, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(timeoutMs), headers: svc({ "Content-Type": "application/json" })
  });
  if (!res.ok) throw new Error("signed upload URL failed: " + res.status);
  var data = await res.json();
  return { url: SUPABASE_URL + "/storage/v1" + data.url, token: new URL(SUPABASE_URL + "/storage/v1" + data.url).searchParams.get("token") };
}

// ---- input checks ----
function intOrNull(v, min, max) {
  if (v === undefined || v === null || v === "") return null;
  var n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}
const ROLES = ["before", "after", "detail", "video"];

// ---- actions ----
async function createUpload(body, res) {
  var projectId = String(body.project_id || "");
  var type = String(body.content_type || "").toLowerCase();
  var bytes = Number(body.bytes);
  if (!UUID_RE.test(projectId)) return fail(res, 400, "bad_project", "פרויקט לא תקין.");
  if (HEIC_TYPES.indexOf(type) !== -1) return fail(res, 415, "heic_unsupported", "הקובץ בפורמט HEIC של אייפון. העלו אותו מהדפדפן (הוא יומר אוטומטית) או שלחו אותו כתמונה רגילה.");
  var ext = IMAGE_TYPES[type] || VIDEO_TYPES[type];
  if (!ext) return fail(res, 415, "unsupported_type", "סוג הקובץ לא נתמך. אפשר תמונות JPG / PNG / WebP וסרטוני MP4 / MOV.");
  if (!(bytes > 0)) return fail(res, 400, "bad_size", "גודל הקובץ לא תקין.");
  if (bytes > MAX_BYTES) return fail(res, 413, "too_large", "הקובץ גדול מדי (מעל 50MB).");
  if (!(await getProject(projectId))) return fail(res, 404, "project_not_found", "הפרויקט לא נמצא.");
  var isVideo = !!VIDEO_TYPES[type];
  var objectPath = projectId + "/" + (isVideo ? "" : "incoming/") + crypto.randomUUID() + "." + ext;
  var signed = await signedUpload(ORIGINALS, objectPath);
  res.status(200).json({
    ok: true, bucket: ORIGINALS, path: objectPath, kind: isVideo ? "video" : "image",
    signed_url: signed.url, token: signed.token,
    tus_endpoint: SUPABASE_URL + "/storage/v1/upload/resumable"   // with the caller's own session (RLS: authenticated insert)
  });
}

const IMAGE_PATH_RE = new RegExp("^(" + UUID + ")/incoming/" + UUID + "\\.(jpg|png|webp)$");
const VIDEO_PATH_RE = new RegExp("^(" + UUID + ")/" + UUID + "\\.(mp4|mov)$");
const TG_UNIQUE_RE = /^[A-Za-z0-9_-]{1,100}$/;

async function processImageToRow(project, incomingPath, mediaId, opts) {
  var input = await storageDownload(ORIGINALS, incomingPath);
  if (!input) throw new MP.MediaError("upload_missing", "uploaded file not found", "הקובץ לא נמצא. נסו להעלות שוב.");
  var out = await MP.processImage(input, { watermark: !!project.watermark, watermarkStyle: opts && opts.watermarkStyle });
  var base = project.id + "/" + mediaId;
  var originalPath = base + ".jpg";
  await storageUpload(ORIGINALS, originalPath, out.original.buffer, "image/jpeg", 3600);
  var variants = { watermark: out.watermark };
  var files = [["w480", "w480.webp", "image/webp"], ["w960", "w960.webp", "image/webp"], ["w1600", "w1600.webp", "image/webp"], ["jpg", "w1600.jpg", "image/jpeg"]];
  for (var i = 0; i < files.length; i++) {
    var v = out.variants[files[i][0]];
    var p = base + "/" + (opts && opts.prefix || "") + files[i][1];
    await storageUpload(PUBLIC, p, v.buffer, files[i][2], PUBLIC_CACHE_SECONDS);
    variants[files[i][0]] = { path: p, width: v.width, height: v.height };
  }
  var igPath = base + "/" + (opts && opts.prefix || "") + "ig.jpg";
  await storageUpload(PUBLIC, igPath, out.ig.buffer, "image/jpeg", PUBLIC_CACHE_SECONDS);
  variants.ig = { path: igPath, width: out.ig.width, height: out.ig.height };
  await storageRemove(ORIGINALS, [incomingPath]).catch(function (err) { console.error("[media] raw cleanup failed: " + err.message); });
  return { originalPath: originalPath, original: out.original, variants: variants };
}

async function processAction(body, res) {
  var projectId = String(body.project_id || "");
  var objectPath = String(body.path || "");
  if (!UUID_RE.test(projectId)) return fail(res, 400, "bad_project", "פרויקט לא תקין.");
  var mImg = objectPath.match(IMAGE_PATH_RE), mVid = objectPath.match(VIDEO_PATH_RE);
  if ((!mImg && !mVid) || (mImg || mVid)[1] !== projectId) return fail(res, 400, "bad_path", "נתיב הקובץ לא תקין.");
  var role = body.role === undefined || body.role === null || body.role === "" ? null : String(body.role);
  if (role !== null && ROLES.indexOf(role) === -1) return fail(res, 400, "bad_role", "תפקיד התמונה לא תקין.");
  var pairNo = intOrNull(body.pair_no, 1, 100), sort = intOrNull(body.sort, 0, 10000);
  if (pairNo === undefined || sort === undefined) return fail(res, 400, "bad_order", "מספור לא תקין.");
  var coverPath = body.cover_path ? String(body.cover_path) : null;
  if (coverPath && (!IMAGE_PATH_RE.test(coverPath) || coverPath.match(IMAGE_PATH_RE)[1] !== projectId)) return fail(res, 400, "bad_path", "נתיב התמונה לא תקין.");
  var tgUnique = body.telegram_file_unique_id == null || body.telegram_file_unique_id === "" ? null : String(body.telegram_file_unique_id);
  if (tgUnique !== null && !TG_UNIQUE_RE.test(tgUnique)) return fail(res, 400, "bad_file_id", "מזהה הקובץ לא תקין.");

  var project = await getProject(projectId);
  if (!project) return fail(res, 404, "project_not_found", "הפרויקט לא נמצא.");
  var q = await consumeQuota("media_file");
  if (!q.ok) return fail(res, 429, "quota", "הגעתם למכסת הקבצים היומית. אפשר להמשיך מחר.");

  var mediaId = crypto.randomUUID();
  var row;
  if (mImg) {
    var r = await processImageToRow(project, objectPath, mediaId);
    row = { id: mediaId, project_id: projectId, kind: "image", role: role, pair_no: pairNo, sort: sort || 0,
      original_path: r.originalPath, variants: r.variants, width: r.original.width, height: r.original.height, bytes: r.original.bytes };
  } else {
    var size = await storageSize(ORIGINALS, objectPath);
    if (!size) return fail(res, 404, "upload_missing", "הקובץ לא נמצא. נסו להעלות שוב.");
    var meta = VM.validateVideo(await VM.readMp4Meta(VM.httpRangeReader(SUPABASE_URL + "/storage/v1/object/" + ORIGINALS + "/" + objectPath, svc()), size));
    var variants = null;
    if (coverPath) {
      var c = await processImageToRow(project, coverPath, mediaId, { prefix: "cover-" });
      variants = { cover: c.variants, cover_original: c.originalPath };
    }
    row = { id: mediaId, project_id: projectId, kind: "video", role: role || "video", pair_no: pairNo, sort: sort || 0,
      original_path: objectPath, variants: variants, width: meta.width, height: meta.height, bytes: meta.size,
      duration_s: meta.durationSec, codec: meta.videoCodec };
  }
  if (tgUnique) row.telegram_file_unique_id = tgUnique;
  var ins = await fetch(SUPABASE_URL + "/rest/v1/project_media", { method: "POST", body: JSON.stringify(row), signal: AbortSignal.timeout(timeoutMs),
    headers: svc({ "Content-Type": "application/json", Prefer: "return=representation" }) });
  if (ins.status === 409) {   // the same Telegram file twice (an album redelivered, a photo sent again)
    var dup = mediaPaths(row);
    await storageRemove(PUBLIC, dup.publicPaths).catch(function () {});
    await storageRemove(ORIGINALS, dup.privatePaths).catch(function () {});
    return fail(res, 409, "duplicate", "הקובץ הזה כבר נמצא בפרויקט.");
  }
  if (!ins.ok) throw new Error("Supabase REST POST project_media failed: " + ins.status);
  var saved = await ins.json();
  console.log("[media] processed project=" + projectId + " media=" + mediaId + " kind=" + row.kind);
  res.status(200).json({ ok: true, media: saved && saved[0] || row, quota_remaining: q.remaining });
}

async function deleteAction(body, res) {
  var mediaId = String(body.media_id || "");
  if (!UUID_RE.test(mediaId)) return fail(res, 400, "bad_media", "קובץ לא תקין.");
  var rows = await rest("project_media?id=eq." + mediaId + "&select=id,project_id,original_path,variants");
  var m = rows && rows[0];
  if (!m) return fail(res, 404, "media_not_found", "הקובץ לא נמצא.");
  var paths = mediaPaths(m), publicPaths = paths.publicPaths, privatePaths = paths.privatePaths;
  await storageRemove(PUBLIC, publicPaths);
  await storageRemove(ORIGINALS, privatePaths);
  await rest("project_media?id=eq." + mediaId, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  console.log("[media] deleted media=" + mediaId);
  res.status(200).json({ ok: true, deleted: mediaId, files: publicPaths.length + privatePaths.length });
}

function mediaPaths(m) {
  var publicPaths = [], privatePaths = [m.original_path];
  (function collect(v) {
    if (!v || typeof v !== "object") return;
    if (typeof v.path === "string") publicPaths.push(v.path);
    Object.keys(v).forEach(function (k) { if (v[k] && typeof v[k] === "object") collect(v[k]); });
  })(m.variants);
  if (m.variants && typeof m.variants.cover_original === "string") privatePaths.push(m.variants.cover_original);
  return { publicPaths: publicPaths, privatePaths: privatePaths };
}

// ---- AI (the panel now; the bot reuses the same actions in Phase 7) ----
const PROJECT_AI_FIELDS = "id,status,service,city,title_he,title_en,summary_he,summary_en,ai_meta";
async function projectImages(projectId) {
  var rows = await rest("project_media?project_id=eq." + projectId + "&kind=eq.image&select=id,sort,role,pair_no,alt_he,alt_en,original_path&order=sort.asc,created_at.asc");
  return (rows || []).slice(0, MA.MAX_IMAGES);
}
// The first lines of the latest captions, so a new caption opens differently (owner: varied openings).
async function recentOpenings() {
  try {
    var rows = await rest("content_queue?select=caption&caption=not.is.null&order=created_at.desc&limit=8");
    return (rows || []).map(function (r) { return String(r.caption || "").split("\n")[0]; }).filter(Boolean);
  } catch (e) { return []; }
}
async function saveAnalysis(project, result, opts) {
  for (var i = 0; i < result.images.length; i++) {
    var im = result.images[i];
    var patch = { role: im.role, pair_no: im.pair_no, alt_he: im.alt_he, alt_en: im.alt_en };
    if (opts.flags) patch.ai_flags = Object.assign({}, im.ai_flags, { quality: im.quality_flags || [] });
    await rest("project_media?id=eq." + encodeURIComponent(im.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  }
  var meta = Object.assign({}, project.ai_meta || {}, {
    caption_body_he: result.caption_body_he, caption_he: result.caption_he, hashtags: result.hashtags,
    pairing_source: result.pairing_source, pairing_confidence: result.pairing_confidence, needs_review: !!result.needs_review,
    stated_claims: result.stated_claims || [], missing: result.missing || [], warnings: result.warnings || [],
    analyzed_at: new Date().toISOString()
  });
  var p = { ai_meta: meta, service: result.service, title_he: result.title_he, title_en: result.title_en, summary_he: result.summary_he, summary_en: result.summary_en };
  if (result.city) p.city = result.city;                      // never erase a city Miri typed
  if (project.status === "collecting") p.status = "draft";
  Object.keys(p).forEach(function (k) { if (p[k] === null || p[k] === undefined) delete p[k]; });
  var saved = await rest("projects?id=eq." + project.id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(p) });
  return saved && saved[0] || null;
}
function publicAnalysis(r) {
  return {
    images: r.images.map(function (im) { return { id: im.id, role: im.role, pair_no: im.pair_no, alt_he: im.alt_he, alt_en: im.alt_en, privacy_flags: im.privacy_flags, quality_flags: im.quality_flags, flagged: im.flagged }; }),
    pairing_source: r.pairing_source, needs_review: r.needs_review, service: r.service, city: r.city, title_he: r.title_he, title_en: r.title_en,
    summary_he: r.summary_he, summary_en: r.summary_en, caption_he: r.caption_he, hashtags: r.hashtags, missing: r.missing, warnings: r.warnings,
    transcript: r.transcript || null   // a voice note's words, for the caller to show once — never saved
  };
}

// A voice note from the bot: base64 in the body (Telegram voice ≤ 3 min ≈ 1 MB, far under Vercel's
// 4.5 MB body cap). → { audio: Buffer, mimeType } | null (none) | false (invalid). Never stored.
const AUDIO_TYPES = ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/webm"];
const MAX_AUDIO_B64 = 4 * 1024 * 1024;
function voiceInput(body) {
  if (body.audio == null || body.audio === "") return null;
  var mime = String(body.mime_type || "audio/ogg").split(";")[0].trim().toLowerCase();
  if (typeof body.audio !== "string" || body.audio.length > MAX_AUDIO_B64 || !/^[A-Za-z0-9+/=]+$/.test(body.audio) || AUDIO_TYPES.indexOf(mime) === -1) return false;
  var buf = Buffer.from(body.audio, "base64");
  return buf.length ? { audio: buf, mimeType: mime } : false;
}

async function analyzeAction(body, res) {
  var projectId = String(body.project_id || "");
  if (!UUID_RE.test(projectId)) return fail(res, 400, "bad_project", "פרויקט לא תקין.");
  var project = await getProject(projectId, PROJECT_AI_FIELDS);
  if (!project) return fail(res, 404, "project_not_found", "הפרויקט לא נמצא.");
  var rows = await projectImages(projectId);
  if (!rows.length) return fail(res, 400, "no_images", "אין עדיין תמונות בפרויקט. העלו תמונות ואז נתחו.");
  var images = (await Promise.all(rows.map(async function (m, i) {
    var buf = await storageDownload(ORIGINALS, m.original_path);
    return buf ? { id: m.id, buffer: buf, order: i } : null;
  }))).filter(Boolean);
  if (!images.length) return fail(res, 404, "upload_missing", "קובצי התמונות לא נמצאו. נסו להעלות שוב.");
  var text = typeof body.text === "string" ? body.text.slice(0, 2000) : "";
  var voice = voiceInput(body);
  if (voice === false) return fail(res, 400, "bad_audio", "ההקלטה לא תקינה או ארוכה מדי.");
  var result = await MA.analyzeProject(Object.assign({ images: images, text: text || undefined }, voice || {}), { avoidOpenings: await recentOpenings() });
  var saved = await saveAnalysis(project, result, { flags: true });
  console.log("[media] analyzed project=" + projectId + " images=" + images.length + " pairing=" + result.pairing_source);
  res.status(200).json({ ok: true, analysis: publicAnalysis(result), project: saved });
}

async function correctAction(body, res) {
  var projectId = String(body.project_id || "");
  var text = typeof body.text === "string" ? body.text.trim().slice(0, 1000) : "";
  if (!UUID_RE.test(projectId)) return fail(res, 400, "bad_project", "פרויקט לא תקין.");
  var voice = voiceInput(body);
  if (voice === false) return fail(res, 400, "bad_audio", "ההקלטה לא תקינה או ארוכה מדי.");
  if (!text && !voice) return fail(res, 400, "empty_correction", "מה לתקן?");
  var project = await getProject(projectId, PROJECT_AI_FIELDS);
  if (!project) return fail(res, 404, "project_not_found", "הפרויקט לא נמצא.");
  var rows = await projectImages(projectId);
  var meta = project.ai_meta || {};
  // the CURRENT saved state (manual edits in the panel included) is what gets corrected
  var analysis = {
    images: rows.map(function (m) { return { id: m.id, role: m.role || "detail", pair_no: m.pair_no, alt_he: m.alt_he, alt_en: m.alt_en, privacy_flags: [], quality_flags: [] }; }),
    service: project.service || "other", city: project.city || null, title_he: project.title_he, title_en: project.title_en,
    summary_he: project.summary_he, summary_en: project.summary_en, caption_body_he: meta.caption_body_he || null,
    hashtags: meta.hashtags || [], stated_claims: meta.stated_claims || [], missing: meta.missing || [],
    pairing_source: meta.pairing_source || "manual", pairing_confidence: meta.pairing_confidence || 0, needs_review: !!meta.needs_review
  };
  var result = await MA.applyMediaCorrection(analysis, voice || { text: text }, {});
  var saved = await saveAnalysis(project, result, { flags: false });
  console.log("[media] corrected project=" + projectId + " warnings=" + (result.warnings || []).join(","));
  res.status(200).json({ ok: true, analysis: publicAnalysis(result), project: saved });
}

async function deleteProjectAction(body, res) {
  var projectId = String(body.project_id || "");
  if (!UUID_RE.test(projectId)) return fail(res, 400, "bad_project", "פרויקט לא תקין.");
  var project = await getProject(projectId);
  if (!project) return fail(res, 404, "project_not_found", "הפרויקט לא נמצא.");
  var rows = (await rest("project_media?project_id=eq." + projectId + "&select=id,original_path,variants")) || [];
  var pub = [], priv = [];
  rows.forEach(function (m) { var p = mediaPaths(m); pub = pub.concat(p.publicPaths); priv = priv.concat(p.privatePaths); });
  // uploads that never got processed (a closed tab, a failed process) live under the project too
  var leftovers = (await storageList(ORIGINALS, projectId + "/")).concat(await storageList(ORIGINALS, projectId + "/incoming/"));
  leftovers.forEach(function (p) { if (priv.indexOf(p) === -1) priv.push(p); });
  var posts = (await rest("content_queue?project_id=eq." + projectId + "&select=id,status,fb_post_id,ig_post_id")) || [];
  var open = posts.filter(function (p) { return ["pending_approval", "approved", "scheduled", "failed"].indexOf(p.status) !== -1; });
  if (open.length) {   // their media is about to disappear → never publish them
    await rest("content_queue?id=in.(" + open.map(function (p) { return p.id; }).join(",") + ")", { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "rejected", rejected_at: new Date().toISOString() }) });
  }
  await storageRemove(PUBLIC, pub);
  await storageRemove(ORIGINALS, priv);
  await rest("projects?id=eq." + projectId, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  console.log("[media] deleted project=" + projectId + " files=" + (pub.length + priv.length));
  res.status(200).json({ ok: true, deleted: projectId, files: pub.length + priv.length, cancelled_posts: open.length,
    instagram_posts: posts.filter(function (p) { return p.ig_post_id; }).length, facebook_posts: posts.filter(function (p) { return p.fb_post_id; }).length });
}

const ACTIONS = { "create-upload": createUpload, process: processAction, delete: deleteAction, analyze: analyzeAction, correct: correctAction, "delete-project": deleteProjectAction };

module.exports = async function handler(req, res) {
  var action = req.query && typeof req.query.action === "string" ? req.query.action : "";
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return fail(res, 404, "not_found", "לא נמצא.");
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Method not allowed");
  if (enforce(req, res, "media-" + action, LIMITS[action][0], LIMITS[action][1])) return;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return fail(res, 500, "server_config", "תקלה בהגדרות השרת.");
  var caller;
  try { caller = await authenticate(req); } catch (e) { caller = null; }
  if (!caller) return fail(res, 401, "unauthorized", "צריך להתחבר מחדש.");
  try {
    await ACTIONS[action](req.body || {}, res);
  } catch (err) {
    if (err instanceof MP.MediaError || err instanceof VM.VideoError) {
      var status = err.code === "too_large" ? 413 : (err.code === "heic_unsupported" || err.code === "unsupported_type" || err.code === "unsupported_codec" || err.code === "not_mp4") ? 415 : 422;
      return fail(res, status, err.code, err.he);
    }
    if (err instanceof MA.MediaAiError) {
      var aiStatus = { invalid_input: 400, quota: 429, quota_unavailable: 503, ai_busy: 503, ai_failed: 502 }[err.code] || 502;
      return fail(res, aiStatus, err.code, err.he);
    }
    if (err && err.code === "quota_unavailable") return fail(res, 503, "quota_unavailable", "המערכת עמוסה כרגע. נסו שוב בעוד רגע.");
    console.error("[media] " + action + " failed: " + (err && err.message));
    fail(res, 500, "failed", "משהו השתבש. נסו שוב.");
  }
};

module.exports._setTimeoutMs = function (ms) { timeoutMs = ms; };
