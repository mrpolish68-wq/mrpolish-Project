// Vercel serverless function: aggregates recent Facebook + Instagram post
// engagement for the admin dashboard's "Social Snapshot" tab.
//
// The Meta Page/Instagram access token is a real credential (unlike the
// Supabase anon key elsewhere in this project, it is NOT safe to embed in
// client-side JS — anyone who requests admin.html's static source directly
// could read it out and use it to post as the Page). So this function
// keeps it server-side, reading it from Vercel's own environment
// variables (Project Settings -> Environment Variables), not from the
// repo's local .env file.
//
// Required Vercel env vars: META_PAGE_ACCESS_TOKEN, META_PAGE_ID, META_IG_USER_ID
//
// Auth: same real-session gate as publish-now.js / check-publish-status.js. This endpoint is
// only ever called by the logged-in dashboard, so it requires a valid Supabase session before
// spending any of the Page's Meta API quota. Without this an anonymous caller could hammer the
// Graph API (risking a throttle that would then break the publishing pipeline, which shares the
// same Page token) and read the Page's private engagement analytics.
"use strict";

const GRAPH_VERSION = "v20.0";

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
// Public anon key (already embedded client-side in admin.html) — used only to validate a
// caller-supplied user access_token against Supabase, never to bypass RLS.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";

async function verifySupabaseUser(accessToken) {
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + accessToken }
  });
  if (!res.ok) return null;
  var data = await res.json();
  return data && data.id ? data : null;
}

async function fetchJson(url) {
  var res = await fetch(url);
  return res.json();
}

async function getFacebookSummary(pageId, token) {
  var fields = "message,created_time,permalink_url,likes.summary(true),comments.summary(true),shares";
  var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId +
    "/posts?fields=" + encodeURIComponent(fields) + "&limit=10&access_token=" + encodeURIComponent(token);
  var profileUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId +
    "?fields=name,fan_count,followers_count&access_token=" + encodeURIComponent(token);

  var postsData = await fetchJson(url);
  var profileData = await fetchJson(profileUrl);

  var posts = (postsData.data || []).map(function (p) {
    return {
      platform: "facebook",
      id: p.id,
      date: p.created_time,
      text: p.message || "",
      permalink: p.permalink_url || "",
      likes: (p.likes && p.likes.summary && p.likes.summary.total_count) || 0,
      comments: (p.comments && p.comments.summary && p.comments.summary.total_count) || 0,
      shares: (p.shares && p.shares.count) || 0
    };
  });

  return {
    error: postsData.error || profileData.error || null,
    followers: profileData.followers_count || profileData.fan_count || 0,
    posts: posts
  };
}

async function getInstagramSummary(igUserId, token) {
  var fields = "caption,media_type,permalink,timestamp,like_count,comments_count";
  var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId +
    "/media?fields=" + encodeURIComponent(fields) + "&limit=10&access_token=" + encodeURIComponent(token);
  var profileUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId +
    "?fields=username,followers_count,media_count&access_token=" + encodeURIComponent(token);

  var mediaData = await fetchJson(url);
  var profileData = await fetchJson(profileUrl);

  var posts = (mediaData.data || []).map(function (m) {
    return {
      platform: "instagram",
      id: m.id,
      date: m.timestamp,
      text: m.caption || "",
      permalink: m.permalink || "",
      likes: m.like_count || 0,
      comments: m.comments_count || 0,
      shares: null
    };
  });

  return {
    error: mediaData.error || profileData.error || null,
    followers: profileData.followers_count || 0,
    posts: posts
  };
}

module.exports = async function handler(req, res) {
  var authHeader = req.headers.authorization || "";
  var accessToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!accessToken) {
    res.status(401).json({ error: "Missing session token." });
    return;
  }
  var user = await verifySupabaseUser(accessToken);
  if (!user) {
    res.status(401).json({ error: "Invalid or expired session — please log in again." });
    return;
  }

  var token = process.env.META_PAGE_ACCESS_TOKEN;
  var pageId = process.env.META_PAGE_ID;
  var igUserId = process.env.META_IG_USER_ID;

  if (!token || !pageId) {
    res.status(500).json({ error: "Server is missing META_PAGE_ACCESS_TOKEN / META_PAGE_ID configuration." });
    return;
  }

  try {
    var facebook = await getFacebookSummary(pageId, token);
    var instagram = igUserId ? await getInstagramSummary(igUserId, token) : null;

    var posts = facebook.posts.concat(instagram ? instagram.posts : []);
    posts.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

    res.status(200).json({
      facebook: { followers: facebook.followers, error: facebook.error ? facebook.error.message : null },
      instagram: instagram
        ? { followers: instagram.followers, error: instagram.error ? instagram.error.message : null }
        : { followers: null, error: "META_IG_USER_ID not configured" },
      posts: posts
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to reach the Meta Graph API: " + err.message });
  }
};
