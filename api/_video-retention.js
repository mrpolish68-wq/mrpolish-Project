// Video retention (owner decision D5, media-projects command 7). A helper, not a Vercel function: the
// publish cron calls maybeRun() at most once an hour.
//
// A project video's stored file (bucket project-originals) is deleted 7 days after it was published
// successfully to EVERY destination chosen for it. Only videos posted by this flow are touched: the
// candidates are content_queue / content_queue_archive rows whose media_url is a storage reference
// ("storage://project-originals/…", written only by api/_social-queue.js). A video is kept while any
// row using it is not published (approved, scheduled, failed, pending …) or was published < 7 days
// ago. The site never shows project videos, so nothing on the site depends on the file. The
// project_media row stays (its cover + history) with file_deleted_at set. Logs: counts only.
"use strict";

const MM = require("./_meta-media.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const KEEP_DAYS = 7;
const RUN_EVERY_MS = 60 * 60 * 1000;
const STATE_KEY = "video_retention";
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
  if (!res.ok) throw new Error("Supabase " + (init.method || "GET") + " " + pathQs.split("?")[0] + " failed: " + res.status);
  return body;
}

// Pure: which storage refs may be deleted. rows = every queue + archive row that uses a storage ref.
function deletableRefs(rows, now) {
  var cutoff = (now ? new Date(now) : new Date()).getTime() - KEEP_DAYS * 24 * 3600 * 1000;
  var byRef = {};
  rows.forEach(function (r) { if (MM.parseStorageRef(r.media_url)) (byRef[r.media_url] = byRef[r.media_url] || []).push(r); });
  return Object.keys(byRef).filter(function (ref) {
    return byRef[ref].every(function (r) {
      return r.status === "published" && r.published_at && new Date(r.published_at).getTime() <= cutoff;
    });
  });
}

async function storageRemove(bucket, paths) {
  var res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket, {
    method: "DELETE", headers: svc(), body: JSON.stringify({ prefixes: paths }), signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error("Storage delete failed: " + res.status);
}

async function run(opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  var sel = "select=media_url,status,published_at&media_url=like." + encodeURIComponent("storage://*");
  var rows = (await rest("content_queue?" + sel)).concat(await rest("content_queue_archive?" + sel));
  var refs = deletableRefs(rows, now);
  var out = { candidates: refs.length, deleted: 0, skipped: 0 };
  for (var i = 0; i < refs.length; i++) {
    var ref = MM.parseStorageRef(refs[i]);
    // only a video file of a project, still stored (file_deleted_at null)
    var media = await rest("project_media?original_path=eq." + encodeURIComponent(ref.path) + "&kind=eq.video&file_deleted_at=is.null&select=id");
    if (!media || !media.length) { out.skipped++; continue; }
    if (opts.dryRun) { out.deleted++; continue; }
    await storageRemove(ref.bucket, [ref.path]);
    await rest("project_media?id=eq." + encodeURIComponent(media[0].id), {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ file_deleted_at: now.toISOString() })
    });
    out.deleted++;
  }
  if (out.deleted) console.log("[video-retention] deleted=" + out.deleted + " candidates=" + out.candidates);
  return out;
}

// At most once an hour (scheduler_state "video_retention").
async function maybeRun(opts) {
  var st = await rest("scheduler_state?key=eq." + STATE_KEY + "&select=value,updated_at");
  var last = st && st[0] && new Date(st[0].updated_at).getTime();
  if (last && Date.now() - last < RUN_EVERY_MS) return { skipped: "recent" };
  await rest("scheduler_state?on_conflict=key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: STATE_KEY, value: { ran_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
  });
  return run(opts);
}

module.exports = { run, maybeRun, deletableRefs, KEEP_DAYS, _setTimeoutMs: function (ms) { timeoutMs = ms; } };
