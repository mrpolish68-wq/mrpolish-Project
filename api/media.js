// Project media endpoint (media-projects plan, Phase 8) — the 8th Vercel function (Hobby limit: 12).
//
//   POST /api/media?action=create-upload  {project_id, kind: 'image'|'video', content_type, bytes}
//        → where to upload: a path in the private bucket project-originals + a signed upload URL (small
//          files) and the TUS endpoint (the panel uploads big files resumably with its own session).
//          Files never pass through this function (Vercel's 4.5 MB body limit).
//   POST /api/media?action=process        {project_id, path, role?, pair_no?, sort?, cover_path?}
//        → image: the uploaded file → a ≤ 2560px JPEG original (private) + site variants + the 4:5
//          Instagram JPEG (public bucket project-media), watermarked per the project (D4), a
//          project_media row; the raw upload is deleted. Video: MP4/MOV metadata via Range reads
//          (≤ 50 MB, H.264/HEVC, 3 s – 15 min) + an optional cover image → a project_media row.
//   POST /api/media?action=delete         {media_id} → the row's files (both buckets) + the row.
//
// Auth: a real Supabase session (the panel) OR X-Internal-Secret = INTERNAL_API_SECRET (the bot,
// server-to-server). Every action is rate-limited; process also uses the daily `media_file` quota.
// Errors carry a `code` and a Hebrew `he` message the panel / bot can show as-is.
"use strict";

const crypto = require("crypto");
const { enforce } = require("./_rate-limit.js");
const { consumeQuota } = require("./_quota.js");
const MP = require("./_media-process.js");
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
const LIMITS = { "create-upload": [60, 60000], process: [30, 60000], delete: [30, 60000] };
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
async function getProject(id) {
  var rows = await rest("projects?id=eq." + encodeURIComponent(id) + "&select=id,watermark,status");
  return rows && rows[0] || null;
}
async function storageUpload(bucket, objectPath, buffer, contentType, cacheSeconds) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket + "/" + objectPath, {
    method: "POST", body: buffer, signal: AbortSignal.timeout(timeoutMs),
    headers: svc({ "Content-Type": contentType, "x-upsert": "true", "cache-control": String(cacheSeconds || 3600) })
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
    await storageUpload(PUBLIC, p, v.buffer, files[i][2], 31536000);   // immutable: the path has the media id
    variants[files[i][0]] = { path: p, width: v.width, height: v.height };
  }
  var igPath = base + "/" + (opts && opts.prefix || "") + "ig.jpg";
  await storageUpload(PUBLIC, igPath, out.ig.buffer, "image/jpeg", 31536000);
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
  var saved = await rest("project_media", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  console.log("[media] processed project=" + projectId + " media=" + mediaId + " kind=" + row.kind);
  res.status(200).json({ ok: true, media: saved && saved[0] || row, quota_remaining: q.remaining });
}

async function deleteAction(body, res) {
  var mediaId = String(body.media_id || "");
  if (!UUID_RE.test(mediaId)) return fail(res, 400, "bad_media", "קובץ לא תקין.");
  var rows = await rest("project_media?id=eq." + mediaId + "&select=id,project_id,original_path,variants");
  var m = rows && rows[0];
  if (!m) return fail(res, 404, "media_not_found", "הקובץ לא נמצא.");
  var publicPaths = [], privatePaths = [m.original_path];
  (function collect(v) {
    if (!v || typeof v !== "object") return;
    if (typeof v.path === "string") publicPaths.push(v.path);
    Object.keys(v).forEach(function (k) { if (v[k] && typeof v[k] === "object") collect(v[k]); });
  })(m.variants);
  if (m.variants && typeof m.variants.cover_original === "string") privatePaths.push(m.variants.cover_original);
  await storageRemove(PUBLIC, publicPaths);
  await storageRemove(ORIGINALS, privatePaths);
  await rest("project_media?id=eq." + mediaId, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  console.log("[media] deleted media=" + mediaId);
  res.status(200).json({ ok: true, deleted: mediaId, files: publicPaths.length + privatePaths.length });
}

const ACTIONS = { "create-upload": createUpload, process: processAction, delete: deleteAction };

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
    if (err && err.code === "quota_unavailable") return fail(res, 503, "quota_unavailable", "המערכת עמוסה כרגע. נסו שוב בעוד רגע.");
    console.error("[media] " + action + " failed: " + (err && err.message));
    fail(res, 500, "failed", "משהו השתבש. נסו שוב.");
  }
};

module.exports._setTimeoutMs = function (ms) { timeoutMs = ms; };
