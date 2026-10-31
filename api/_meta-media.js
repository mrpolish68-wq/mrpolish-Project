// Meta publishing for multi-item posts and videos (media-projects command 7). A helper, not a Vercel
// function: used by api/publish-scheduled-content.js (publishOne + the container poll pass).
//
//   Facebook multi-photo: every photo is uploaded UNPUBLISHED (/photos published=false; temporary=true
//     when the post is natively scheduled), then ONE feed post carries them (/feed attached_media).
//   Instagram carousel: one child container per item (is_carousel_item, the 1080×1350 JPEG copies,
//     max 10) → one CAROUSEL container (children + caption) → a short bounded poll → media_publish.
//   Instagram video (REELS) — two-phase, never blocks a run: createReelContainer() returns at once;
//     later scheduler runs call containerStatus() and publishContainer() once it is FINISHED.
//
// Project videos live in the PRIVATE bucket project-originals. Their content_queue rows carry a
// storage reference ("storage://project-originals/<project>/<file>.mp4"), turned into a short-lived
// signed URL only at publish time (Meta fetches it), so no video is ever made public.
// Nothing here logs a token, a URL with a token, or a caption.
"use strict";

const GRAPH_VERSION = "v20.0";
const GRAPH = "https://graph.facebook.com/" + GRAPH_VERSION + "/";
const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const IG_CAROUSEL_MAX = 10;
const SIGNED_URL_SECONDS = 24 * 3600;            // Meta may fetch a video a while after the container is made
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STORAGE_REF_RE = new RegExp("^storage://(project-originals)/(" + UUID + "/" + UUID + "\\.(?:mp4|mov))$");
// An Instagram container is only usable for 24 h; a container still IN_PROGRESS after this is treated as EXPIRED.
const CONTAINER_MAX_AGE_MS = 24 * 3600 * 1000;

var timeoutMs = 20000;
var pollDelayMs = 2000;

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function metaErr(prefix, error) {
  var e = new Error(prefix + ": " + ((error && error.message) || "unknown error"));
  e.meta = error || null;
  return e;
}

async function graphPost(path, params) {
  var res = await fetch(GRAPH + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs)
  });
  return res.json();
}
async function graphGet(path, query, token) {
  var res = await fetch(GRAPH + path + "?" + query + "&access_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

// ---------------------------------------------------------------------------
// storage references (private project videos)
// ---------------------------------------------------------------------------
function storageRef(bucket, path) { return "storage://" + bucket + "/" + path; }
function parseStorageRef(s) {
  var m = String(s || "").match(STORAGE_REF_RE);
  return m ? { bucket: m[1], path: m[2] } : null;
}
function isStorageRef(s) { return /^storage:\/\//.test(String(s || "")); }

// A signed GET URL for a private object (service role). Throws on any failure.
async function signedUrl(bucket, path, seconds) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + bucket + "/" + path.split("/").map(encodeURIComponent).join("/"), {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: seconds || SIGNED_URL_SECONDS })
  });
  var body = await res.json().catch(function () { return null; });
  var rel = body && (body.signedURL || body.signedUrl);
  if (!res.ok || !rel) throw new Error("Storage: could not sign the video file (" + res.status + ")");
  return SUPABASE_URL + "/storage/v1" + (rel.charAt(0) === "/" ? "" : "/") + rel;
}

// The row's media_url ready for Meta: a storage reference → a signed URL; anything else unchanged.
async function resolveMediaUrl(url) {
  if (!isStorageRef(url)) return url;
  var ref = parseStorageRef(url);
  if (!ref) throw new Error("Storage: unsupported media reference");
  return signedUrl(ref.bucket, ref.path);
}

// ---------------------------------------------------------------------------
// carousel items
// ---------------------------------------------------------------------------
// media_items: [{ type: 'image', url, ig_url? }] — url = the Facebook copy (full ratio JPEG),
// ig_url = the Instagram 1080×1350 JPEG. Panel posts ("➕ פוסט חדש") carry { url, type } only.
function carouselItems(row) {
  var items = Array.isArray(row.media_items) ? row.media_items : [];
  return items.filter(function (it) { return it && typeof it.url === "string" && /^https:\/\//.test(it.url) && (it.type || "image") === "image"; });
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------
// scheduledForDate: a Date → a natively scheduled post (Facebook-only rows), else published now.
async function publishFacebookMulti(row, token, pageId, scheduledForDate) {
  var items = carouselItems(row);
  if (items.length < 2) throw new Error("Facebook: a multi-photo post needs at least 2 photos");
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    var p = { url: items[i].url, published: false, access_token: token };
    if (scheduledForDate) p.temporary = true;   // required for photos attached to a scheduled post
    var up = await graphPost(pageId + "/photos", p);
    if (up.error) throw metaErr("Facebook (photo " + (i + 1) + " upload)", up.error);
    ids.push(up.id);
  }
  var post = {
    message: row.caption, access_token: token,
    attached_media: ids.map(function (id) { return { media_fbid: id }; })
  };
  if (scheduledForDate) {
    post.published = false;
    post.scheduled_publish_time = Math.floor(scheduledForDate.getTime() / 1000);
  }
  var res = await graphPost(pageId + "/feed", post);
  if (res.error) throw metaErr("Facebook", res.error);
  return res.id;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------
async function waitFinished(containerId, token, tries) {
  for (var i = 0; i < (tries || 12); i++) {
    var s = await graphGet(containerId, "fields=status_code", token);
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("Instagram: media processing failed (" + s.status_code + ")");
    await sleep(pollDelayMs);
  }
  throw new Error("Instagram: media container did not finish processing within the poll window (creation_id=" + containerId + ") — safe to retry, a new container will be created.");
}

async function publishInstagramCarousel(row, token, igUserId) {
  var items = carouselItems(row).slice(0, IG_CAROUSEL_MAX);
  if (items.length < 2) throw new Error("Instagram: a carousel needs at least 2 photos");
  var children = [];
  for (var i = 0; i < items.length; i++) {
    var c = await graphPost(igUserId + "/media", { image_url: items[i].ig_url || items[i].url, is_carousel_item: true, access_token: token });
    if (c.error) throw metaErr("Instagram (carousel item " + (i + 1) + ")", c.error);
    children.push(c.id);
  }
  var parent = await graphPost(igUserId + "/media", { media_type: "CAROUSEL", children: children.join(","), caption: row.caption, access_token: token });
  if (parent.error) throw metaErr("Instagram (carousel)", parent.error);
  await waitFinished(parent.id, token, 15);
  var pub = await graphPost(igUserId + "/media_publish", { creation_id: parent.id, access_token: token });
  if (pub.error) throw metaErr("Instagram", pub.error);
  return pub.id;
}

// Phase 1: create the REELS container and return at once (no waiting). videoUrl = a resolved URL.
async function createReelContainer(row, videoUrl, token, igUserId) {
  var c = await graphPost(igUserId + "/media", {
    media_type: "REELS", video_url: videoUrl, caption: row.caption, share_to_feed: true,
    cover_url: row.thumbnail_url && /^https:\/\//.test(row.thumbnail_url) ? row.thumbnail_url : undefined,
    access_token: token
  });
  if (c.error) throw metaErr("Instagram (video upload)", c.error);
  return c.id;
}

// Phase 2: one status read. → 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' (+ the raw status text)
async function containerStatus(containerId, token) {
  var s = await graphGet(containerId, "fields=status_code,status", token);
  if (s.error) throw metaErr("Instagram (status)", s.error);
  return { code: s.status_code || "IN_PROGRESS", detail: typeof s.status === "string" ? s.status.slice(0, 200) : null };
}

async function publishContainer(containerId, token, igUserId) {
  var pub = await graphPost(igUserId + "/media_publish", { creation_id: containerId, access_token: token });
  if (pub.error) throw metaErr("Instagram", pub.error);
  return pub.id;
}

function containerTooOld(createdAt, now) {
  var t = new Date(createdAt).getTime();
  return !isNaN(t) && (now ? new Date(now).getTime() : Date.now()) - t > CONTAINER_MAX_AGE_MS;
}

module.exports = {
  GRAPH_VERSION, IG_CAROUSEL_MAX, CONTAINER_MAX_AGE_MS,
  storageRef, parseStorageRef, isStorageRef, signedUrl, resolveMediaUrl, carouselItems,
  publishFacebookMulti, publishInstagramCarousel, createReelContainer, containerStatus, publishContainer, containerTooOld,
  _set: function (o) { if (o.timeoutMs) timeoutMs = o.timeoutMs; if (o.pollDelayMs != null) pollDelayMs = o.pollDelayMs; }
};
