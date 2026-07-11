// Vercel cron job: publishes approved, due rows from content_queue to
// Facebook + Instagram, then writes the result back to Supabase.
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
"use strict";

const GRAPH_VERSION = "v20.0";
const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";

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

async function updateRow(id, patch) {
  var url = SUPABASE_URL + "/rest/v1/content_queue?id=eq." + encodeURIComponent(id);
  var res = await fetch(url, {
    method: "PATCH",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error("Supabase update failed: " + res.status);
}

async function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function publishFacebook(row, token, pageId) {
  if (row.media_type === "image") {
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId + "/photos";
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: row.media_url, caption: row.caption, access_token: token })
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
    body: JSON.stringify({ file_url: row.media_url, description: row.caption, access_token: token })
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
  if (row.media_type === "video" || row.media_type === "reel") containerParams.video_url = row.media_url;
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

  // Bounded poll (~10s) — sufficient for images; video/Reel needs a two-phase design (see file header).
  for (var i = 0; i < 5; i++) {
    var statusRes = await fetch("https://graph.facebook.com/" + GRAPH_VERSION + "/" + creationId + "?fields=status_code&access_token=" + encodeURIComponent(token));
    var statusData = await statusRes.json();
    if (statusData.status_code === "FINISHED") break;
    if (statusData.status_code === "ERROR") throw new Error("Instagram: media processing failed");
    await sleep(2000);
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

  var results = [];
  for (var i = 0; i < due.length; i++) {
    var row = due[i];
    var fbPostId = null, igPostId = null, error = null;
    try {
      if (row.platform === "facebook" || row.platform === "both") {
        fbPostId = await publishFacebook(row, token, pageId);
      }
      if ((row.platform === "instagram" || row.platform === "both") && igUserId) {
        igPostId = await publishInstagram(row, token, igUserId);
      }
      await updateRow(row.id, {
        status: "published",
        published_at: new Date().toISOString(),
        fb_post_id: fbPostId,
        ig_post_id: igPostId,
        publish_error: null
      });
      results.push({ id: row.id, ok: true, fbPostId: fbPostId, igPostId: igPostId });
    } catch (err) {
      error = err.message;
      try {
        await updateRow(row.id, { status: "failed", publish_error: error });
      } catch (updateErr) {
        error += " (also failed to record error: " + updateErr.message + ")";
      }
      results.push({ id: row.id, ok: false, error: error });
    }
  }

  res.status(200).json({ processed: results.length, results: results });
};
