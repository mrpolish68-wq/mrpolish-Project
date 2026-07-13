// Vercel cron job: publishes approved, due rows from content_queue to
// Facebook + Instagram, then writes the result back to Supabase.
//
// This file's core per-row logic (publishOne) is shared with
// api/publish-now.js, the real-time "Approve button" trigger — see
// that file's header for why a second entry point exists. Both call
// the exact same Meta-publishing code; only how a row is *selected*
// (a batch of due rows here vs. one specific id there) and *who's
// allowed to call it* (CRON_SECRET here vs. a real Supabase session
// there) differ.
//
// Auth: protected by CRON_SECRET (Vercel automatically sends
// "Authorization: Bearer {CRON_SECRET}" when it triggers a configured
// cron job — see vercel.json). Rejects any request without a matching
// header, so this can't be used to force-publish content by hitting
// the URL directly.
//
// Supabase access: uses the service_role key via raw REST calls (no
// supabase-js — this project has no package.json/npm dependencies by
// design, same as main.js's public-site inserts). The service_role key
// bypasses Row-Level Security, which is correct here: this function has
// no logged-in user, unlike the dashboard's authenticated session.
//
// Scope note (pilot phase): only "image" media_type is exercised so
// far (the pilot batch is real project photos). Video/Reel publishing
// on Instagram requires polling a processing container that can take
// far longer than one function invocation should block for — the
// short poll below (~10s) is enough for images but will need a
// two-phase "create container now, check+publish on a later run"
// design before real video/Reel content goes through this pipeline.
// The real-time trigger in publish-now.js inherits this same limit —
// a slow IG video publish can still exceed one request's time budget,
// in which case the row is simply left as-is and the daily cron here
// picks it up as the fallback (see that file's header).
"use strict";

const GRAPH_VERSION = "v20.0";
const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";

// Facebook rejects scheduled_publish_time closer than ~10 minutes out (and further than 75
// days). Anything nearer than this is treated as "due now" and published immediately instead
// of attempting a scheduling call that Meta would just reject.
const FB_MIN_SCHEDULE_MS = 11 * 60 * 1000;

// How long a single publisher "holds" a row once it claims it (see claimRow). Must be safely
// longer than one function's whole run (maxDuration is 60s in vercel.json) so a genuinely
// in-progress publish is never re-claimed and duplicated by an overlapping caller — but short
// enough that a row orphaned by a crash/timeout mid-publish becomes re-claimable again soon
// after, rather than being stuck forever. Status stays 'approved' throughout, so the daily
// cron is the thing that re-claims it once this lease lapses.
const CLAIM_LEASE_MS = 5 * 60 * 1000;

function supabaseHeaders() {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json"
  };
}

async function fetchDueApproved() {
  var nowIso = new Date().toISOString();
  var url = SUPABASE_URL + "/rest/v1/content_queue" +
    "?status=eq.approved&scheduled_for=lte." + encodeURIComponent(nowIso) +
    "&order=scheduled_for.asc";
  var res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query failed: " + res.status);
  return res.json();
}

async function fetchRowById(id) {
  var url = SUPABASE_URL + "/rest/v1/content_queue?id=eq." + encodeURIComponent(id) + "&select=*";
  var res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query failed: " + res.status);
  var rows = await res.json();
  return rows[0] || null;
}

// Rows Facebook accepted as natively-scheduled (see publishOne) whose scheduled_publish_time
// has actually arrived — these are the only rows that can genuinely still be "not really
// published yet" long after Approve was clicked, since Facebook's own servers publish them
// later, not this app. checkScheduledStatus() below confirms whether that's actually happened.
async function fetchDueScheduled() {
  var nowIso = new Date().toISOString();
  var url = SUPABASE_URL + "/rest/v1/content_queue" +
    "?status=eq.scheduled&scheduled_for=lte." + encodeURIComponent(nowIso) +
    "&order=scheduled_for.asc";
  var res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query failed: " + res.status);
  return res.json();
}

async function updateRow(id, patch) {
  var url = SUPABASE_URL + "/rest/v1/content_queue?id=eq." + encodeURIComponent(id);
  var res = await fetch(url, {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error("Supabase update failed: " + res.status);
}

// Atomically claim an 'approved' row so exactly one publisher acts on it, even when a manual
// Approve-click and the daily cron (or two Approve-clicks) hit the same row at the same instant.
// This is a compare-and-swap done entirely in the database: the conditional PATCH only matches
// a row that is BOTH still 'approved' AND has not been touched within CLAIM_LEASE_MS. Postgres
// serializes the two concurrent UPDATEs on the same row, so the first sets last_publish_attempt_at
// to now and the second — re-evaluating its WHERE against the just-updated row — matches 0 rows
// and backs off. Returns true if this caller won the claim, false if someone else already holds it.
//
// Why a time-lease on last_publish_attempt_at instead of a transient 'publishing' status: leaving
// the row 'approved' means a crash/timeout mid-publish self-heals — the lease simply lapses and the
// next cron run re-claims it. A transient status would instead orphan the row in a state nothing
// retries (the cron only ever looks at status='approved'). See publish-now.js's fallback header.
async function claimRow(row) {
  var nowIso = new Date().toISOString();
  var cutoffIso = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  var url = SUPABASE_URL + "/rest/v1/content_queue" +
    "?id=eq." + encodeURIComponent(row.id) +
    "&status=eq.approved" +
    "&or=(last_publish_attempt_at.is.null,last_publish_attempt_at.lt." + encodeURIComponent(cutoffIso) + ")";
  var res = await fetch(url, {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=representation" }, supabaseHeaders()),
    body: JSON.stringify({ last_publish_attempt_at: nowIso })
  });
  if (!res.ok) throw new Error("Supabase claim failed: " + res.status);
  var claimed = await res.json();
  return Array.isArray(claimed) && claimed.length > 0;
}

async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Stories carry no dedicated "underlying asset type" column (media_type='story' just means
// "publish this as a Story"), so photo-vs-video is inferred from the file extension. Every
// asset used by this pipeline so far is a plain .jpg/.jpeg/.png/.mp4 served from our own
// assets/ folder (see handoff.md), so extension sniffing is reliable here.
function isVideoAsset(url) {
  return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url || "");
}

// Facebook Page Stories (photo_stories / video_stories) are a distinct API family from
// regular Page posts — publishing a Story means it disappears after 24h and never appears
// in the Page's feed/timeline. There is no "post as story vs feed" toggle on /photos or
// /videos; using the wrong endpoint silently creates a permanent feed post instead of an
// ephemeral Story. Stories cannot be natively scheduled ahead of time via this API (unlike
// regular posts), so a future-dated Story is refused here rather than silently landing on
// whatever this function decided to do about "scheduleParams".
//
// NOTE: video_stories has not been exercised against the live Graph API yet (this pipeline
// is still image-only in practice — see file header "Scope note"). Refuse video Stories on
// Facebook for now rather than ship an unverified chunked-upload flow; photo Stories (the
// bulk of what's been requested — single project photos with a CTA) are implemented below.
async function publishFacebookStory(row, token, pageId, scheduledForDate) {
  if (scheduledForDate) {
    throw new Error("Facebook Stories cannot be scheduled ahead of time via the Graph API — schedule this row for 'now' instead.");
  }
  if (isVideoAsset(row.media_url)) {
    throw new Error("Facebook video Stories are not yet implemented in this pipeline (photo Stories only) — publish this row to Instagram only, or convert it to a photo Story.");
  }
  // Step 1: upload the photo as an unpublished Page post to get a photo_id.
  var uploadUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId + "/photos";
  var uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: row.media_url, published: false, access_token: token })
  });
  var uploadData = await uploadRes.json();
  if (uploadData.error) throw new Error("Facebook (story photo upload): " + uploadData.error.message);

  // Step 2: publish that photo as a Story.
  var storyUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId + "/photo_stories";
  var storyRes = await fetch(storyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_id: uploadData.id, access_token: token })
  });
  var storyData = await storyRes.json();
  if (storyData.error) throw new Error("Facebook (story publish): " + storyData.error.message);
  return storyData.post_id || storyData.id;
}

// scheduledForDate: pass a Date to schedule a future Facebook post (published:false +
// scheduled_publish_time) instead of publishing immediately. Instagram has no equivalent —
// see publishOne, which never calls publishInstagram for a genuinely future row.
async function publishFacebook(row, token, pageId, scheduledForDate) {
  if (row.media_type === "story") {
    return publishFacebookStory(row, token, pageId, scheduledForDate);
  }
  var scheduleParams = {};
  if (scheduledForDate) {
    scheduleParams.published = false;
    scheduleParams.scheduled_publish_time = Math.floor(scheduledForDate.getTime() / 1000);
  }
  if (row.media_type === "image") {
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId + "/photos";
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ url: row.media_url, caption: row.caption, access_token: token }, scheduleParams))
    });
    var data = await res.json();
    if (data.error) throw new Error("Facebook: " + data.error.message);
    return data.post_id || data.id;
  }
  // video / reel — simple video post (not the Reels-placement resumable-upload flow)
  var vUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId + "/videos";
  var vRes = await fetch(vUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ file_url: row.media_url, description: row.caption, access_token: token }, scheduleParams))
  });
  var vData = await vRes.json();
  if (vData.error) throw new Error("Facebook: " + vData.error.message);
  return vData.id;
}

// Every Story published through this pipeline gets a functional Link sticker pointing
// here, via the Graph API's `link` container param (Instagram's replacement for the old
// "swipe up" gesture — available to every professional account, no follower minimum).
var SITE_URL = "https://mr-polishes.com";

async function publishInstagram(row, token, igUserId) {
  var mediaType = row.media_type === "story" ? "STORIES" : row.media_type === "video" || row.media_type === "reel" ? "REELS" : null;
  var containerParams = { caption: row.caption, access_token: token };
  if (mediaType) containerParams.media_type = mediaType;
  // A Story's underlying asset can be either a photo or a video (see isVideoAsset comment
  // above) — media_type='story' alone doesn't say which, so the extension decides which
  // Graph API param carries the asset. Reels/regular videos are unambiguous already.
  var isVideoUpload = row.media_type === "video" || row.media_type === "reel" ||
    (row.media_type === "story" && isVideoAsset(row.media_url));
  if (isVideoUpload) containerParams.video_url = row.media_url;
  else containerParams.image_url = row.media_url;
  // Stories have no caption/bio-link surface of their own — the link sticker is the only
  // way to drive traffic from one, so this is unconditional rather than opt-in per row.
  if (mediaType === "STORIES") containerParams.link = row.link_url || SITE_URL;

  var createUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId + "/media";
  var createRes = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(containerParams)
  });
  var createData = await createRes.json();
  if (createData.error) throw new Error("Instagram: " + createData.error.message);
  var creationId = createData.id;

  // Bounded poll — sufficient for images (finish almost immediately) and short video/Reels
  // (~19s source clips have taken up to ~30s to reach FINISHED in practice). Still not a full
  // two-phase design (see file header): a container that's genuinely slow to process can still
  // exceed this and hit the "Media ID is not available" media_publish error below. 15 x 3s = 45s,
  // leaving headroom under this route's 60s maxDuration (vercel.json) for the rest of the
  // request (container creation, the publish call, the Facebook call before it) so the
  // function isn't killed mid-poll — a kill mid-poll is worse than a clean timeout-error,
  // since it skips the catch block entirely and leaves no publish_error on the row at all.
  var processed = false;
  for (var i = 0; i < 15; i++) {
    var statusRes = await fetch("https://graph.facebook.com/" + GRAPH_VERSION + "/" + creationId + "?fields=status_code&access_token=" + encodeURIComponent(token));
    var statusData = await statusRes.json();
    if (statusData.status_code === "FINISHED") { processed = true; break; }
    if (statusData.status_code === "ERROR") throw new Error("Instagram: media processing failed");
    await sleep(3000);
  }
  if (!processed) {
    throw new Error("Instagram: media container did not finish processing within the poll window (creation_id=" + creationId + ") — safe to retry, a new container will be created.");
  }

  var publishRes = await fetch("https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId + "/media_publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: token })
  });
  var publishData = await publishRes.json();
  if (publishData.error) throw new Error("Instagram: " + publishData.error.message);
  return publishData.id;
}

// The one function both entry points (cron batch loop + the real-time single-row trigger)
// call. ctx: { token, pageId, igUserId, triggerSource: 'cron' | 'manual' }.
async function publishOne(row, ctx) {
  // Fail closed rather than silently mis-publish: content_category is the dashboard's
  // marketing classification (what Ori picked when drafting the row) while media_type is
  // what actually selects the Graph API endpoint (see file header + handoff.md). A Story
  // row whose media_type doesn't literally equal 'story' would otherwise fall through to
  // a normal feed photo/video/Reel post below — exactly the "story published as feed post"
  // failure this guard exists to make impossible. Refuse and mark 'failed' instead.
  if (row.content_category === "story" && row.media_type !== "story") {
    var mismatchErr = "Story row has media_type='" + row.media_type + "' instead of 'story' " +
      "— refusing to publish, since that would post to the feed instead of as a Story.";
    await updateRow(row.id, {
      status: "failed", publish_error: mismatchErr,
      trigger_source: ctx.triggerSource, publish_attempts: (row.publish_attempts || 0) + 1,
      last_publish_attempt_at: new Date().toISOString()
    });
    return { id: row.id, ok: false, error: mismatchErr };
  }

  var now = new Date();
  var scheduledFor = new Date(row.scheduled_for);
  var isFuture = scheduledFor.getTime() - now.getTime() > FB_MIN_SCHEDULE_MS;
  // Skip a platform that already has a post id from a prior attempt (e.g. a 'both' row
  // where Facebook succeeded but Instagram then threw, leaving status='failed') — a retry
  // must never re-run publishFacebook/publishInstagram for a platform that's already live,
  // or it silently creates a duplicate post. See the catch block below, which is what
  // makes fb_post_id/ig_post_id survive a partial failure for this check to see next time.
  var hasFacebook = (row.platform === "facebook" || row.platform === "both") && !row.fb_post_id;
  var hasInstagram = (row.platform === "instagram" || row.platform === "both") && ctx.igUserId && !row.ig_post_id;

  // Instagram has no native "schedule for later" — every IG call publishes immediately.
  // Any row with an Instagram side that's genuinely in the future is left completely
  // alone here: publishing it now would go live today, silently breaking the whole point
  // of "future". The daily cron remains the only thing that safely handles it, once its
  // real scheduled_for actually arrives (its status is still 'approved', so the cron's
  // existing query picks it up normally — nothing extra needed on that side).
  if (isFuture && hasInstagram) {
    return {
      id: row.id, ok: true, deferred: true,
      reason: "Instagram has no native scheduling API — this will publish via the daily cron on " + row.scheduled_for + "."
    };
  }

  // Atomic claim: from here on this attempt actually touches Meta, so exactly one publisher
  // must proceed. If another caller (the cron, or a second Approve-click) already claimed this
  // row moments ago, back off cleanly — the row is untouched and still 'approved', so whoever
  // holds the claim finishes it, or the daily cron does. This is what closes the concurrent
  // double-publish race (two callers both reading status='approved' before either writes).
  var claimed = await claimRow(row);
  if (!claimed) {
    return {
      id: row.id, ok: true, skipped: true,
      reason: "Another publisher is already handling this row — skipped to avoid a duplicate post."
    };
  }

  // Seed from whatever the row already has (a prior partial success) rather than null, so
  // a skipped platform (hasFacebook/hasInstagram false because it already has a post id —
  // see above) doesn't get overwritten back to null by this attempt's patch.
  var fbPostId = row.fb_post_id || null, igPostId = row.ig_post_id || null;
  try {
    if (hasFacebook) fbPostId = await publishFacebook(row, ctx.token, ctx.pageId, isFuture ? scheduledFor : null);
    if (hasInstagram) igPostId = await publishInstagram(row, ctx.token, ctx.igUserId); // only reached when !isFuture (see guard above)

    var newStatus = isFuture ? "scheduled" : "published"; // isFuture here only ever means "Facebook-only, future"
    var patch = {
      status: newStatus, fb_post_id: fbPostId, ig_post_id: igPostId, publish_error: null,
      trigger_source: ctx.triggerSource, publish_attempts: (row.publish_attempts || 0) + 1,
      last_publish_attempt_at: new Date().toISOString()
    };
    if (newStatus === "published") patch.published_at = new Date().toISOString();
    await updateRow(row.id, patch);
    return { id: row.id, ok: true, status: newStatus, fbPostId: fbPostId, igPostId: igPostId };
  } catch (err) {
    // Persist fbPostId/igPostId here too: if Facebook already succeeded in this same
    // attempt (fbPostId got set above) and Instagram then threw, losing that id would mean
    // a live Facebook post the dashboard has no record of — and a future retry would
    // re-publish to Facebook, creating a duplicate. This is exactly what happened to the
    // 2026-07-12 basalt Reel before this fix (fb_post_id had to be recovered by hand from
    // the Graph API after the fact).
    var error = err.message;
    try {
      await updateRow(row.id, {
        status: "failed", publish_error: error, fb_post_id: fbPostId, ig_post_id: igPostId,
        trigger_source: ctx.triggerSource, publish_attempts: (row.publish_attempts || 0) + 1,
        last_publish_attempt_at: new Date().toISOString()
      });
    } catch (updateErr) {
      error += " (also failed to record error: " + updateErr.message + ")";
    }
    return { id: row.id, ok: false, error: error };
  }
}

// Confirms whether a natively-scheduled Facebook post is actually live yet, via the Graph
// API's own is_published field on the post object, and flips the row to 'published' the
// moment it genuinely is. Called two ways: automatically by the cron for every due
// 'scheduled' row (fetchDueScheduled, above), and on-demand from the dashboard's "בדיקת
// סטטוס במטא" button (api/check-publish-status.js) for a specific row Ori wants to check
// right now rather than wait for the next cron tick.
async function checkScheduledStatus(row, ctx) {
  if (!row.fb_post_id) {
    return { id: row.id, ok: false, error: "אין מזהה פוסט בפייסבוק לבדיקה." };
  }
  try {
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + row.fb_post_id +
      "?fields=is_published&access_token=" + encodeURIComponent(ctx.token);
    var res = await fetch(url);
    var data = await res.json();
    if (data.error) throw new Error("Facebook: " + data.error.message);

    if (data.is_published) {
      await updateRow(row.id, {
        status: "published", published_at: new Date().toISOString(),
        publish_error: null, last_publish_attempt_at: new Date().toISOString()
      });
      return { id: row.id, ok: true, nowPublished: true };
    }
    // Still genuinely scheduled, not published yet - not an error, just not due (or Meta
    // hasn't processed it yet). Record that a check happened without changing status.
    await updateRow(row.id, { last_publish_attempt_at: new Date().toISOString() });
    return { id: row.id, ok: true, nowPublished: false };
  } catch (err) {
    return { id: row.id, ok: false, error: err.message };
  }
}

// Checks Meta's one read-only pin-related field — there is no write endpoint to actually
// set a pin (see api/check-pin-status.js's header, and handoff.md, for the full research).
// This just tells the dashboard whether the Page's current pinned_post already happens to
// match this row, so Ori can verify a manual pin he just did in Facebook's own UI without
// having to eyeball the Page. Facebook-only — Instagram has no equivalent field at all.
async function checkPinStatus(row, ctx) {
  if (!row.fb_post_id) {
    return { id: row.id, ok: false, error: "אין מזהה פוסט בפייסבוק לבדיקה." };
  }
  try {
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + ctx.pageId +
      "?fields=pinned_post&access_token=" + encodeURIComponent(ctx.token);
    var res = await fetch(url);
    var data = await res.json();
    if (data.error) throw new Error("Facebook: " + data.error.message);

    var pinnedId = data.pinned_post && data.pinned_post.id;
    var isPinned = pinnedId === row.fb_post_id;
    if (isPinned) {
      await updateRow(row.id, { pin_confirmed_at: new Date().toISOString() });
    }
    return { id: row.id, ok: true, pinned: isPinned };
  } catch (err) {
    return { id: row.id, ok: false, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  var cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    var auth = req.headers.authorization || "";
    if (auth !== "Bearer " + cronSecret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  var token = process.env.META_PAGE_ACCESS_TOKEN;
  var pageId = process.env.META_PAGE_ID;
  var igUserId = process.env.META_IG_USER_ID;

  if (!token || !pageId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing META_PAGE_ACCESS_TOKEN / META_PAGE_ID / SUPABASE_SERVICE_ROLE_KEY configuration." });
    return;
  }

  var due;
  try {
    due = await fetchDueApproved();
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  console.log("[cron] " + due.length + " due row(s) found");
  var ctx = { token: token, pageId: pageId, igUserId: igUserId, triggerSource: "cron" };
  var results = [];
  for (var i = 0; i < due.length; i++) {
    var result = await publishOne(due[i], ctx);
    console.log("[cron] row=" + due[i].id + " " + JSON.stringify(result));
    results.push(result);
  }

  // Second pass: confirm any natively-scheduled Facebook posts whose time has arrived are
  // actually live yet, and flip them to 'published' the moment they genuinely are — this is
  // what keeps a 'scheduled' row from sitting indefinitely once Meta has actually published it.
  var dueScheduled;
  try {
    dueScheduled = await fetchDueScheduled();
  } catch (err) {
    dueScheduled = [];
    console.log("[cron] fetchDueScheduled failed: " + err.message);
  }
  var checkResults = [];
  for (var j = 0; j < dueScheduled.length; j++) {
    var checkResult = await checkScheduledStatus(dueScheduled[j], ctx);
    console.log("[cron] status-check row=" + dueScheduled[j].id + " " + JSON.stringify(checkResult));
    checkResults.push(checkResult);
  }

  res.status(200).json({ processed: results.length, results: results, statusChecks: checkResults.length, statusCheckResults: checkResults });
};

// Exported for api/publish-now.js (the real-time Approve-button trigger) to reuse — see
// that file's header. Attaching to the exported handler function itself keeps this a
// single file with one Vercel route (module.exports must stay a callable handler), while
// still letting a sibling file `require()` these pieces internally.
module.exports.publishOne = publishOne;
module.exports.fetchRowById = fetchRowById;
module.exports.checkScheduledStatus = checkScheduledStatus;
module.exports.checkPinStatus = checkPinStatus;
