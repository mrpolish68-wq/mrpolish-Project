// Projects → Facebook / Instagram / story posts in content_queue (media-projects command 7). A helper,
// not a Vercel function. Callers: api/site.js POST ?action=publish (the bot's ✅ אשר and the panel's
// "📣 אישור פרסום ברשתות") and the publish cron (queuePending, the safety net).
//
// What a project becomes (the publisher, burst guard and notifications then handle them like any row):
//   facebook / instagram → ONE feed row: 2–10 photos = 'carousel' (Facebook multi-photo + Instagram
//     carousel, the 1080×1350 copies), 1 photo = 'image'; platform both / facebook / instagram
//   + the project's first video (if any) → ONE 'reel' row, at the next free slot after the feed post
//     (never two posts in one slot); the video stays private — the row carries a storage reference
//   ig_story → ONE Instagram story (the first "after" photo, else the video)
// Timing: the project's slot (publish_plan.at) if still in the future, otherwise now (the next run).
// Rows are 'approved' at once — D1: Miri's approval in the bot IS the approval.
//
// Exactly once: the approval is a scheduler_state row "social:<project id>" ({status: approved →
// queuing → queued | blocked}); only the caller whose conditional PATCH moves it to 'queuing' builds
// the rows. A crash mid-way leaves 'queuing' for 5 min, then the cron retries; if rows for the project
// already exist the retry only records them. The DB guard on project_publications still refuses a
// project without consent or with unreviewed flagged media (then the new rows are cancelled).
// Logs: ids, counts and reason codes only.
"use strict";

const BS = require("../shared/burst-schedule.js");
const MM = require("./_meta-media.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const PUBLIC_BASE = SUPABASE_URL + "/storage/v1/object/public/project-media/";
const SOCIAL = ["facebook", "instagram", "ig_story"];
const STALE_QUEUING_MS = 5 * 60 * 1000;
var timeoutMs = 12000;

function svc(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(pathQs, init) {
  init = Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, init || {});
  init.headers = svc(init.headers);
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + pathQs, init);
  var body = res.status === 204 ? null : await res.json().catch(function () { return null; });
  return { status: res.status, ok: res.ok, body: body };
}
function enc(s) { return encodeURIComponent(s); }
function pub(path) { return PUBLIC_BASE + String(path).split("/").map(enc).join("/"); }
function lockKey(projectId) { return "social:" + projectId; }

function needsReview(m) { var f = m.ai_flags || {}; return !m.flags_ack_at && (f.faces === true || f.plates === true || f.house_numbers === true); }

// Photos in story order: each pair before → after, then the rest by sort. Only images that have both
// the Facebook copy (w1600 JPEG) and the Instagram copy (1080×1350 JPEG).
function orderedImages(media) {
  var imgs = media.filter(function (m) { return m.kind === "image" && m.variants && m.variants.ig && (m.variants.jpg || m.variants.w1600); });
  function rank(m) {
    var pair = m.pair_no != null && (m.role === "before" || m.role === "after") ? m.pair_no : 1e6;
    return [pair, m.role === "before" ? 0 : m.role === "after" ? 1 : 2, m.sort || 0];
  }
  return imgs.slice().sort(function (a, b) {
    var x = rank(a), y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}
function imageItem(m) {
  var v = m.variants;
  return { type: "image", url: pub((v.jpg || v.w1600).path), ig_url: pub(v.ig.path), media_id: m.id };
}

// The first free burst-guard slot strictly after `after` that no queued post already uses.
function nextFreeSlotAfter(after, taken) {
  var used = {};
  taken.forEach(function (t) { used[Math.round(new Date(t).getTime() / 60000)] = true; });
  var slots = BS.slotsAfter(new Date(after), 60);
  for (var i = 0; i < slots.length; i++) if (!used[Math.round(slots[i].at.getTime() / 60000)]) return slots[i].at;
  throw new Error("no free slot");
}

// Pure: the content_queue rows for a project (no ids, no I/O). now: Date. taken: scheduled_for of
// every approved / scheduled row already in the queue.
function buildRows(p, media, now, taken) {
  var meta = p.ai_meta || {}, plan = meta.publish_plan || {};
  var dests = (plan.destinations || []).filter(function (d) { return SOCIAL.indexOf(d) !== -1; });
  if (!dests.length) return { rows: [], reason: "no_social" };
  var caption = String(meta.caption_he || "").trim();
  if (!caption) return { rows: [], reason: "no_caption" };
  var title = String(p.title_he || "פרויקט").trim().slice(0, 120);
  var at = plan.timing === "at" && plan.at && new Date(plan.at).getTime() > now.getTime() ? new Date(plan.at) : now;
  var images = orderedImages(media);
  var video = media.filter(function (m) { return m.kind === "video" && !m.file_deleted_at && m.original_path; })
    .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })[0] || null;
  var cover = video && video.variants && video.variants.cover && (video.variants.cover.jpg || video.variants.cover.w1600);
  var wantFb = dests.indexOf("facebook") !== -1, wantIg = dests.indexOf("instagram") !== -1;
  var platform = wantFb && wantIg ? "both" : wantFb ? "facebook" : wantIg ? "instagram" : null;
  var base = { caption: caption, status: "approved", approved_at: now.toISOString(), project_id: p.id };
  var rows = [];
  if (platform && images.length) {
    var items = images.slice(0, MM.IG_CAROUSEL_MAX).map(imageItem);
    rows.push(Object.assign({}, base, {
      kind: "feed", destinations: dests.filter(function (d) { return d !== "ig_story"; }),
      title: title, platform: platform, media_type: items.length >= 2 ? "carousel" : "image", content_category: "post",
      media_url: items[0].url, media_items: items.map(function (it) { return { type: it.type, url: it.url, ig_url: it.ig_url }; }),
      scheduled_for: at.toISOString()
    }));
  }
  if (platform && video) {
    var vAt = rows.length ? nextFreeSlotAfter(at, taken.concat([at.toISOString()])) : at;
    rows.push(Object.assign({}, base, {
      kind: "video", destinations: dests.filter(function (d) { return d !== "ig_story"; }),
      title: "סרטון: " + title, platform: platform, media_type: "reel", content_category: "reel",
      media_url: MM.storageRef("project-originals", video.original_path),
      thumbnail_url: cover ? pub(cover.path) : null,
      media_items: [{ type: "video", storage: "project-originals", path: video.original_path, media_id: video.id }],
      scheduled_for: vAt.toISOString()
    }));
  }
  if (dests.indexOf("ig_story") !== -1) {
    var storyImg = images.find(function (m) { return m.role === "after"; }) || images[0];
    if (storyImg || video) {
      rows.push(Object.assign({}, base, {
        kind: "story", destinations: ["ig_story"],
        title: "סטורי: " + title, platform: "instagram", media_type: "story", content_category: "story",
        media_url: storyImg ? pub(storyImg.variants.ig.path) : MM.storageRef("project-originals", video.original_path),
        scheduled_for: at.toISOString()
      }));
    }
  }
  if (!rows.length) return { rows: [], reason: "no_media" };
  return { rows: rows };
}

// ---------------------------------------------------------------------------
// the lock (scheduler_state "social:<id>")
// ---------------------------------------------------------------------------
async function readLock(projectId) {
  var r = await rest("scheduler_state?key=eq." + enc(lockKey(projectId)) + "&select=key,value,updated_at");
  if (!r.ok) throw new Error("lock read failed: " + r.status);
  return r.body && r.body[0] || null;
}
async function setLock(projectId, value, expectStatus) {
  var qs = "scheduler_state?key=eq." + enc(lockKey(projectId)) + (expectStatus ? "&value->>status=eq." + enc(expectStatus) : "");
  var r = await rest(qs, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ value: value, updated_at: new Date().toISOString() }) });
  if (!r.ok) throw new Error("lock update failed: " + r.status);
  return Array.isArray(r.body) && r.body.length > 0;
}

// Records the approval (once). by: 'telegram' | 'panel'.
async function approve(projectId, by) {
  var r = await rest("scheduler_state?on_conflict=key", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ key: lockKey(projectId), value: { status: "approved", approved_at: new Date().toISOString(), by: by || null } })
  });
  if (!r.ok) throw new Error("approval record failed: " + r.status);
  if (Array.isArray(r.body) && r.body.length > 0) return true;
  // Approved again after a block (e.g. the caption was missing and is fixed now) → reopen it.
  // A queued project is never reopened (that would post it twice).
  return setLock(projectId, { status: "approved", approved_at: new Date().toISOString(), by: by || null, reopened: true }, "blocked");
}

// Moves approved (or a stale 'queuing') → 'queuing'. True = this caller builds the rows.
async function claim(projectId, lock) {
  var v = lock.value || {};
  var stale = v.status === "queuing" && Date.now() - new Date(lock.updated_at).getTime() > STALE_QUEUING_MS;
  if (v.status !== "approved" && !stale) return false;
  return setLock(projectId, Object.assign({}, v, { status: "queuing", claimed_at: new Date().toISOString() }), v.status);
}

// ---------------------------------------------------------------------------
// queue one project
// ---------------------------------------------------------------------------
async function queueProject(projectId, opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  var lock = await readLock(projectId);
  if (!lock) return { ok: false, reason: "not_approved" };
  if (lock.value && lock.value.status === "queued") return { ok: true, already: true, rows: lock.value.rows || [] };
  if (lock.value && lock.value.status === "blocked") return { ok: false, reason: lock.value.reason || "blocked" };
  if (!(await claim(projectId, lock))) return { ok: true, busy: true };
  var v = Object.assign({}, lock.value, { status: "queuing" });

  async function finish(status, extra) {
    await setLock(projectId, Object.assign({}, v, { status: status, done_at: new Date().toISOString() }, extra || {}), "queuing").catch(function () {});
  }
  try {
    var pr = await rest("projects?id=eq." + enc(projectId) + "&select=id,status,consent,title_he,ai_meta");
    if (!pr.ok) throw new Error("project lookup failed: " + pr.status);
    var p = pr.body && pr.body[0];
    if (!p) { await finish("blocked", { reason: "not_found" }); return { ok: false, reason: "not_found" }; }
    if (p.consent !== "yes") { await finish("blocked", { reason: "no_consent" }); return { ok: false, reason: "no_consent" }; }
    if (p.status !== "ready" && p.status !== "published") {
      await setLock(projectId, Object.assign({}, v, { status: "approved" }), "queuing").catch(function () {});   // not ready yet: retry later
      return { ok: false, reason: "not_ready" };
    }
    // A retry after a crash: rows already created → just record them (never a second copy).
    var existing = await rest("content_queue?project_id=eq." + enc(projectId) + "&status=neq.rejected&select=id,media_type,scheduled_for");
    if (!existing.ok) throw new Error("queue lookup failed: " + existing.status);
    if (existing.body && existing.body.length) {
      var rec = existing.body.map(function (x) { return { id: x.id, media_type: x.media_type, scheduled_for: x.scheduled_for }; });
      await finish("queued", { rows: rec, recovered: true });
      return { ok: true, queued: rec.length, rows: rec, recovered: true };
    }
    var mr = await rest("project_media?project_id=eq." + enc(projectId) + "&select=id,kind,role,pair_no,sort,variants,original_path,ai_flags,flags_ack_at,file_deleted_at&order=sort.asc");
    if (!mr.ok) throw new Error("media lookup failed: " + mr.status);
    var media = mr.body || [];
    if (media.some(needsReview)) { await finish("blocked", { reason: "flags" }); return { ok: false, reason: "flags" }; }
    var tk = await rest("content_queue?status=in.(approved,scheduled)&select=scheduled_for");
    if (!tk.ok) throw new Error("slots lookup failed: " + tk.status);
    var built = buildRows(p, media, now, (tk.body || []).map(function (x) { return x.scheduled_for; }));
    if (!built.rows.length) { await finish("blocked", { reason: built.reason }); return { ok: false, reason: built.reason }; }

    // PostgREST's multi-row insert needs the SAME keys in every object: missing ones are sent as null.
    var insert = built.rows.map(function (r) { var o = Object.assign({}, r); delete o.kind; delete o.destinations; return o; });
    var keys = {};
    insert.forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = true; }); });
    insert = insert.map(function (o) { var x = {}; Object.keys(keys).forEach(function (k) { x[k] = o[k] === undefined ? null : o[k]; }); return x; });
    var ins = await rest("content_queue", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(insert) });
    if (!ins.ok || !Array.isArray(ins.body) || ins.body.length !== insert.length) throw new Error("queue insert failed: " + ins.status);
    var created = ins.body;
    var pubs = [];
    built.rows.forEach(function (r, i) {
      r.destinations.forEach(function (d) { pubs.push({ project_id: projectId, destination: d, content_queue_id: created[i].id, scheduled_for: created[i].scheduled_for }); });
    });
    var pi = await rest("project_publications", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(pubs) });
    if (!pi.ok) {
      // The DB guard refused (consent / flags changed meanwhile): cancel the rows just made.
      await rest("content_queue?id=in.(" + created.map(function (c) { return c.id; }).join(",") + ")", {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "rejected", rejected_at: new Date().toISOString(), notes: "בוטל אוטומטית: הפרויקט לא עבר את בדיקת ההסכמה / הפרטיות." })
      }).catch(function () {});
      await finish("blocked", { reason: "guard" });
      return { ok: false, reason: "guard" };
    }
    var rec2 = created.map(function (c) { return { id: c.id, media_type: c.media_type, scheduled_for: c.scheduled_for }; });
    await finish("queued", { rows: rec2 });
    console.log("[social-queue] project=" + projectId + " queued=" + rec2.length);
    return { ok: true, queued: rec2.length, rows: rec2 };
  } catch (err) {
    // Back to 'approved': the next cron run tries again.
    await setLock(projectId, Object.assign({}, v, { status: "approved", last_error: String(err.message).slice(0, 120) }), "queuing").catch(function () {});
    console.error("[social-queue] project=" + projectId + " failed: " + err.message);
    return { ok: false, reason: "failed" };
  }
}

// The bot's ✅ / the panel's button: record the approval, then queue at once.
async function approveAndQueue(projectId, by, opts) {
  await approve(projectId, by);
  return queueProject(projectId, opts);
}

// The cron's safety net: every approved (or stuck) project that isn't queued yet.
async function queuePending(opts) {
  var r = await rest("scheduler_state?key=like.social:*&or=(value->>status.eq.approved,value->>status.eq.queuing)&select=key,value,updated_at&order=updated_at.asc&limit=10");
  if (!r.ok) throw new Error("pending lookup failed: " + r.status);
  var out = { checked: 0, queued: 0 };
  for (var i = 0; i < (r.body || []).length; i++) {
    var id = String(r.body[i].key).slice("social:".length);
    out.checked++;
    var res = await queueProject(id, opts).catch(function () { return { ok: false }; });
    if (res.queued) out.queued += res.queued;
  }
  return out;
}

// The panel / bot: the current state of a project's social approval (no I/O beyond one read).
async function socialState(projectId) {
  var lock = await readLock(projectId);
  return lock ? lock.value : null;
}

module.exports = { approve, approveAndQueue, queueProject, queuePending, socialState, buildRows, orderedImages, nextFreeSlotAfter, SOCIAL,
  _setTimeoutMs: function (ms) { timeoutMs = ms; } };
