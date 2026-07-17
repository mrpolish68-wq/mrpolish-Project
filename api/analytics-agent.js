// Vercel cron job (once/day): the "Analytics" tab's data engine. Fetches Facebook +
// Instagram performance metrics, flags unanswered comments, and derives 3 daily tips +
// (on the 1st of the month) a monthly content plan — all via deterministic heuristics over
// this project's own data, never an external AI API call (no key to manage, no ongoing cost).
//
// Relationship to api/social-snapshot.js: that endpoint is a stateless, on-demand, session-
// authenticated read for the existing "Social Snapshot" tab (last ~10 posts, live from Meta,
// nothing stored). This file is the opposite shape on purpose — an unattended cron job that
// persists a daily snapshot to Supabase (meta_analytics/social_comments/ai_recommendations),
// so the Analytics tab has real history to chart and doesn't re-hit the Graph API on every
// dashboard load. The two intentionally duplicate a little Graph API plumbing rather than
// share it, matching how publish-scheduled-content.js and social-snapshot.js already each
// keep their own small REST helpers instead of cross-requiring for a few lines of code.
//
// Metric-name note: every Graph API metric used below was verified live against this
// account's actual token before being hardcoded — Meta has deprecated several "obvious"
// names recently (page_impressions, page_impressions_unique, page_engaged_users, page_fans
// all 100-error on this account as of this writing; Instagram media-level "impressions" is
// gone as of Graph API v22 too). An insights call fails ENTIRELY if any one metric in its
// list is invalid, so only confirmed-working metrics are ever requested — anything not
// verified is left out and the corresponding column stays null rather than guessed at. If
// Meta changes this again, re-verify with individual single-metric calls (see the git history
// of this file's introduction for the exact verification commands used) before adding one back.
//
// Auth: CRON_SECRET, same pattern as publish-scheduled-content.js.
"use strict";

const GRAPH_VERSION = "v20.0";
const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";

// How many recent posts/media to pull per platform for engagement summing + comment
// scanning — matches social-snapshot.js's existing "recent posts" limit.
const RECENT_POST_LIMIT = 10;

function supabaseHeaders() {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}

async function fetchJson(url) {
  var res = await fetch(url);
  return res.json();
}

async function supabaseGet(path) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error("Supabase query failed: " + res.status);
  return res.json();
}

async function supabaseInsert(table, rows) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
    method: "POST",
    headers: Object.assign({ Prefer: "return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error("Supabase insert into " + table + " failed: " + res.status);
}

// resolution: "merge-duplicates" (meta_analytics — overwrite the day's row if re-run) or
// "ignore-duplicates" (social_comments — a comment already marked replied/dismissed by Ori
// in the dashboard must never be silently reset to needs_attention by the next day's scan).
async function supabaseUpsert(table, rows, conflictCols, resolution) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=" + conflictCols, {
    method: "POST",
    headers: Object.assign({ Prefer: "resolution=" + resolution + ",return=minimal" }, supabaseHeaders()),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error("Supabase upsert into " + table + " failed: " + res.status);
}

// ---------------------------------------------------------------------------
// Metrics fetch
// ---------------------------------------------------------------------------

async function fetchFacebookDaily(pageId, token) {
  var profileUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId +
    "?fields=fan_count,followers_count&access_token=" + encodeURIComponent(token);
  var insightsUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId +
    "/insights?metric=page_post_engagements,page_video_views,page_views_total&period=day&access_token=" + encodeURIComponent(token);
  var postsUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + pageId +
    "/posts?fields=" + encodeURIComponent("id,created_time,likes.summary(true),comments.summary(true),shares") +
    "&limit=" + RECENT_POST_LIMIT + "&access_token=" + encodeURIComponent(token);

  var profile = await fetchJson(profileUrl);
  var insights = await fetchJson(insightsUrl);
  var postsData = await fetchJson(postsUrl);
  var posts = postsData.data || [];

  function latestValue(metricName) {
    var series = (insights.data || []).filter(function (m) { return m.name === metricName; })[0];
    var values = series && series.values;
    return values && values.length ? values[values.length - 1].value : null;
  }

  var pageEngagement = latestValue("page_post_engagements");
  var engagementFromPosts = posts.reduce(function (sum, p) {
    return sum + ((p.likes && p.likes.summary && p.likes.summary.total_count) || 0) +
      ((p.comments && p.comments.summary && p.comments.summary.total_count) || 0) +
      ((p.shares && p.shares.count) || 0);
  }, 0);

  return {
    follower_count: profile.followers_count || profile.fan_count || null,
    // No working page-level reach/impressions metric on this account (see file header) —
    // left null rather than reported inaccurately.
    reach: null,
    impressions: null,
    engagement_count: pageEngagement != null ? pageEngagement : engagementFromPosts,
    engagement_rate: null, // no reach denominator available for Facebook (see above)
    video_views: latestValue("page_video_views"),
    video_completion_rate: null, // not exposed at page level; would need per-video post insights
    posts_published: posts.length,
    raw_metrics: { profile: profile, insights: insights.data || null },
    posts: posts, // kept in-memory for comment scanning + category correlation, not stored as-is
    error: profile.error || insights.error || postsData.error || null
  };
}

async function fetchInstagramDaily(igUserId, token) {
  var profileUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId +
    "?fields=username,followers_count,media_count&access_token=" + encodeURIComponent(token);
  var insightsUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId +
    "/insights?metric=reach,accounts_engaged,total_interactions,profile_views&period=day&metric_type=total_value&access_token=" + encodeURIComponent(token);
  var mediaUrl = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + igUserId +
    "/media?fields=" + encodeURIComponent("id,media_type,media_product_type,timestamp,like_count,comments_count") +
    "&limit=" + RECENT_POST_LIMIT + "&access_token=" + encodeURIComponent(token);

  var profile = await fetchJson(profileUrl);
  var insights = await fetchJson(insightsUrl);
  var mediaData = await fetchJson(mediaUrl);
  var media = mediaData.data || [];

  function totalValue(metricName) {
    var series = (insights.data || []).filter(function (m) { return m.name === metricName; })[0];
    var tv = series && series.total_value;
    return tv && typeof tv.value === "number" ? tv.value : null;
  }

  var reach = totalValue("reach");
  var accountsEngaged = totalValue("total_interactions");
  var engagementFromMedia = media.reduce(function (sum, m) {
    return sum + (m.like_count || 0) + (m.comments_count || 0);
  }, 0);
  var engagementCount = accountsEngaged != null ? accountsEngaged : engagementFromMedia;

  return {
    follower_count: profile.followers_count || null,
    reach: reach,
    // "impressions" was retired for media-level insights on this account as of Graph API
    // v22 (see file header) — no working replacement found at the account level either.
    impressions: null,
    engagement_count: engagementCount,
    engagement_rate: reach ? Math.round((engagementCount / reach) * 1000) / 10 : null,
    video_views: null,
    // ig_reels_avg_watch_time / ig_reels_video_view_total_time are valid metrics on this
    // account but need a reliable per-Reel video-duration figure to turn into a completion
    // *rate*, which isn't available from the media fields fetched here — left null rather
    // than a rough guess. A future enhancement, not a bug.
    video_completion_rate: null,
    posts_published: media.length,
    raw_metrics: { profile: profile, insights: insights.data || null },
    posts: media,
    username: profile.username || null,
    error: profile.error || insights.error || mediaData.error || null
  };
}

// ---------------------------------------------------------------------------
// Comment scanning — a comment with zero replies (comment_count/replies empty) and not
// authored by the Page/account itself is flagged "needs_attention". This is deliberately
// coarse (any reply marks it "answered", not specifically a reply from us) since that's what
// the Graph API exposes cheaply without an extra per-comment call.
// ---------------------------------------------------------------------------

function draftReply(commentText) {
  var text = (commentText || "").trim();
  if (/מחיר|עלות|כמה עולה|הצעת מחיר/.test(text)) {
    return "תודה על הפנייה! נשמח להעריך את העבודה ולתת הצעת מחיר מדויקת — אפשר לשלוח פרטים ותמונות בוואטסאפ: wa.me/972529534540";
  }
  if (text.indexOf("?") !== -1) {
    return "תודה על השאלה! נשמח לענות בפירוט — אפשר גם לפנות אלינו ישירות בוואטסאפ לתשובה מהירה: wa.me/972529534540";
  }
  return "תודה רבה על התגובה החמה! 🙏";
}

async function scanFacebookComments(posts, pageId, token) {
  var flagged = [];
  for (var i = 0; i < posts.length; i++) {
    var post = posts[i];
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + post.id +
      "/comments?fields=" + encodeURIComponent("id,message,from,created_time,comment_count") +
      "&access_token=" + encodeURIComponent(token);
    var data = await fetchJson(url);
    if (data.error || !data.data) continue;
    for (var j = 0; j < data.data.length; j++) {
      var c = data.data[j];
      var isOwn = c.from && c.from.id === pageId;
      var hasReply = (c.comment_count || 0) > 0;
      if (!isOwn && !hasReply && c.message) {
        flagged.push({
          platform: "facebook", post_id: post.id, comment_id: c.id,
          post_permalink: "https://www.facebook.com/" + post.id,
          author_name: (c.from && c.from.name) || null,
          comment_text: c.message, commented_at: c.created_time,
          status: "needs_attention", suggested_reply: draftReply(c.message)
        });
      }
    }
  }
  return flagged;
}

async function scanInstagramComments(media, igUsername, token) {
  var flagged = [];
  for (var i = 0; i < media.length; i++) {
    var m = media[i];
    var url = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + m.id +
      "/comments?fields=" + encodeURIComponent("id,text,username,timestamp,replies") +
      "&access_token=" + encodeURIComponent(token);
    var data = await fetchJson(url);
    if (data.error || !data.data) continue;
    for (var j = 0; j < data.data.length; j++) {
      var c = data.data[j];
      var isOwn = igUsername && c.username === igUsername;
      var hasReply = !!(c.replies && c.replies.data && c.replies.data.length);
      if (!isOwn && !hasReply && c.text) {
        flagged.push({
          platform: "instagram", post_id: m.id, comment_id: c.id,
          post_permalink: null, author_name: c.username || null,
          comment_text: c.text, commented_at: c.timestamp,
          status: "needs_attention", suggested_reply: draftReply(c.text)
        });
      }
    }
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Daily tips — deterministic heuristics over meta_analytics history + today's live post
// engagement. Always returns exactly 3: data-driven tips first (need enough history/data to
// fire), then a rotating pool of evergreen tips pads out the rest — most relevant in the
// first weeks after this feature ships, before enough history exists for the data-driven ones.
// ---------------------------------------------------------------------------

var EVERGREEN_TIPS = [
  { title: "עקביות בפרסום", body: "פרסום קבוע 2-3 פעמים בשבוע שומר על נראות גבוהה יותר באלגוריתם של פייסבוק ואינסטגרם מאשר פרסומים מרוכזים ולא סדירים." },
  { title: "מענה מהיר לתגובות", body: "מענה לתגובות בתוך 24 שעות משפר את טווח ההגעה של הפוסט ואת שביעות רצון הלקוחות." },
  { title: "עדיפות לתוכן וידאו", body: "פוסטים עם וידאו (במיוחד רילס) נוטים לקבל טווח הגעה אורגני גבוה יותר מתמונות סטטיות בלבד." },
  { title: "לפני ואחרי", body: "תוכן 'לפני ואחרי' הוא מהמניע ביותר בתחום ליטוש ושיש — כדאי לוודא שכל עבודה גדולה מתועדת בתמונות." },
  { title: "קריאה לפעולה ברורה", body: "כל פוסט צריך קריאה לפעולה ברורה (התקשרו / שלחו וואטסאפ) — פוסטים בלעדיה ממירים פחות לפניות בפועל." }
];

function dayOfYear(date) {
  var start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

function pickEvergreen(seed, excludeTitles) {
  for (var offset = 0; offset < EVERGREEN_TIPS.length; offset++) {
    var tip = EVERGREEN_TIPS[(seed + offset) % EVERGREEN_TIPS.length];
    if (excludeTitles.indexOf(tip.title) === -1) return tip;
  }
  return EVERGREEN_TIPS[0];
}

var CATEGORY_HE = { post: "פוסט רגיל", ad: "מודעה", reel: "רילס", story: "סטורי" };

async function generateDailyTips(todayStr, fbData, igData) {
  var tips = [];
  var since = new Date(); since.setDate(since.getDate() - 8);
  var sinceStr = since.toISOString().slice(0, 10);

  // Tip: platform trend vs trailing ~7-day average engagement.
  try {
    var history = await supabaseGet("meta_analytics?snapshot_date=gte." + sinceStr +
      "&snapshot_date=lt." + todayStr + "&order=snapshot_date.asc&select=platform,engagement_count");
    [["facebook", fbData], ["instagram", igData]].forEach(function (pair) {
      var platform = pair[0], data = pair[1];
      var rows = history.filter(function (r) { return r.platform === platform && r.engagement_count != null; });
      if (rows.length < 3 || data.engagement_count == null) return; // not enough history yet
      var avg = rows.reduce(function (s, r) { return s + r.engagement_count; }, 0) / rows.length;
      if (avg === 0) return;
      var deltaPct = Math.round(((data.engagement_count - avg) / avg) * 100);
      if (Math.abs(deltaPct) < 15) return; // not a meaningful signal
      var platformHe = platform === "facebook" ? "פייסבוק" : "אינסטגרם";
      tips.push(deltaPct > 0
        ? { title: "מגמת עלייה ב" + platformHe, body: "מעורבות ב" + platformHe + " היום גבוהה ב-" + deltaPct + "% מהממוצע השבועי — כדאי לבחון אילו פוסטים אחראים לכך ולשכפל את הסגנון.", based_on: { platform: platform, deltaPct: deltaPct } }
        : { title: "ירידה במעורבות ב" + platformHe, body: "מעורבות ב" + platformHe + " היום נמוכה ב-" + Math.abs(deltaPct) + "% מהממוצע השבועי — כדאי לבדוק את שעת הפרסום ואיכות התוכן האחרון.", based_on: { platform: platform, deltaPct: deltaPct } });
    });
  } catch (err) {
    console.log("[analytics-agent] trend tip skipped: " + err.message);
  }

  // Tip: best-performing content_category among recently published rows, matched against
  // today's live post engagement fetched above (fb/igData.posts).
  try {
    var recentPublished = await supabaseGet("content_queue?status=eq.published&published_at=gte." +
      since.toISOString() + "&select=content_category,fb_post_id,ig_post_id");
    var byCategory = {};
    var livePosts = (fbData.posts || []).concat(igData.posts || []);
    recentPublished.forEach(function (row) {
      var live = livePosts.filter(function (p) { return p.id === row.fb_post_id || p.id === row.ig_post_id; })[0];
      if (!live || !row.content_category) return;
      var eng = (live.like_count || (live.likes && live.likes.summary && live.likes.summary.total_count) || 0) +
        (live.comments_count || (live.comments && live.comments.summary && live.comments.summary.total_count) || 0);
      if (!byCategory[row.content_category]) byCategory[row.content_category] = { sum: 0, count: 0 };
      byCategory[row.content_category].sum += eng;
      byCategory[row.content_category].count += 1;
    });
    var categories = Object.keys(byCategory);
    if (categories.length >= 2) {
      categories.sort(function (a, b) { return (byCategory[b].sum / byCategory[b].count) - (byCategory[a].sum / byCategory[a].count); });
      var top = categories[0];
      tips.push({
        title: "התוכן המוביל: " + (CATEGORY_HE[top] || top),
        body: "תוכן מסוג '" + (CATEGORY_HE[top] || top) + "' מקבל את המעורבות הגבוהה ביותר לאחרונה — כדאי לתכנן עוד תוכן מהסוג הזה בשבוע הקרוב.",
        based_on: { category: top, avgEngagement: Math.round(byCategory[top].sum / byCategory[top].count) }
      });
    }
  } catch (err) {
    console.log("[analytics-agent] category tip skipped: " + err.message);
  }

  var excludeTitles = tips.map(function (t) { return t.title; });
  var doy = dayOfYear(new Date());
  while (tips.length < 3) {
    var evergreen = pickEvergreen(doy + tips.length, excludeTitles);
    tips.push({ title: evergreen.title, body: evergreen.body, based_on: null });
    excludeTitles.push(evergreen.title);
  }
  return tips.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Monthly content plan — generated once, on the 1st of each month, from last month's
// content_queue category mix. Idempotent: skips if a plan already exists for this month
// (the agent may run more than once on the 1st via the frequent external trigger).
// ---------------------------------------------------------------------------

async function generateMonthlyPlanIfDue() {
  var now = new Date();
  if (now.getDate() !== 1) return null;
  var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  var existing = await supabaseGet("ai_recommendations?kind=eq.monthly_plan&period_date=eq." + monthStart + "&select=id");
  if (existing.length) return null;

  var lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
  var lastMonthRows = await supabaseGet("content_queue?status=eq.published&published_at=gte." +
    lastMonthStart.toISOString() + "&published_at=lt." + lastMonthEnd.toISOString() + "&select=content_category");

  var counts = {};
  lastMonthRows.forEach(function (r) {
    if (r.content_category) counts[r.content_category] = (counts[r.content_category] || 0) + 1;
  });
  var categories = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
  var totalPosts = lastMonthRows.length;

  // "Do more of what was actually posted last month", ordered by frequency — not ranked by
  // engagement, since this agent doesn't yet retain enough per-post historical engagement to
  // do that reliably (meta_analytics.raw_metrics has the raw data if that's added later).
  var planItems = [1, 2, 3, 4].map(function (week) {
    var category = categories.length ? categories[(week - 1) % categories.length] : "post";
    var theme = CATEGORY_HE[category] || category;
    return {
      week: week, theme: theme, category: category,
      notes: categories.length
        ? "בחודש שעבר פורסמו " + totalPosts + " פוסטים בסה\"כ; '" + theme + "' היה מהסוגים הפעילים."
        : "אין מספיק היסטוריית פרסום מהחודש הקודם — תוכנית התחלתית גנרית."
    };
  });

  var body = "תוכנית תוכן ל" + monthStart.slice(0, 7) + ": " +
    planItems.map(function (p) { return "שבוע " + p.week + " – " + p.theme; }).join(", ") + ".";

  return {
    kind: "monthly_plan", period_date: monthStart, title: "תוכנית תוכן חודשית",
    body: body, plan_items: planItems, based_on: { totalPostsLastMonth: totalPosts, categoryCounts: counts }
  };
}

// The actual work, split out from the HTTP handler so both the cron entry point below and
// api/analytics-refresh.js (the dashboard's session-authenticated "🔄 רענון אנליטיקה" button —
// same split as publish-scheduled-content.js's publishOne / publish-now.js) can run the exact
// same logic. Idempotent throughout (upserts + existence-checks), so a manual trigger the same
// day the cron already ran just corrects/no-ops rather than duplicating anything.
async function runAgent() {
  var token = process.env.META_PAGE_ACCESS_TOKEN;
  var pageId = process.env.META_PAGE_ID;
  var igUserId = process.env.META_IG_USER_ID;
  if (!token || !pageId || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Server is missing META_PAGE_ACCESS_TOKEN / META_PAGE_ID / SUPABASE_SERVICE_ROLE_KEY configuration.");
  }

  var todayStr = new Date().toISOString().slice(0, 10);
  var summary = { metrics: {}, commentsFlagged: 0, tipsWritten: 0, monthlyPlanWritten: false, errors: [] };
  var fbData = null, igData = null;

  try {
    fbData = await fetchFacebookDaily(pageId, token);
    if (fbData.error) throw new Error(fbData.error.message || JSON.stringify(fbData.error));
    await supabaseUpsert("meta_analytics", [{
      snapshot_date: todayStr, platform: "facebook",
      follower_count: fbData.follower_count, reach: fbData.reach, impressions: fbData.impressions,
      engagement_count: fbData.engagement_count, engagement_rate: fbData.engagement_rate,
      video_views: fbData.video_views, video_completion_rate: fbData.video_completion_rate,
      posts_published: fbData.posts_published, raw_metrics: fbData.raw_metrics
    }], "snapshot_date,platform", "merge-duplicates");
    summary.metrics.facebook = "ok";
  } catch (err) {
    summary.errors.push("facebook metrics: " + err.message);
    console.error("[analytics-agent] facebook metrics failed: " + err.message);
  }

  try {
    if (igUserId) {
      igData = await fetchInstagramDaily(igUserId, token);
      if (igData.error) throw new Error(igData.error.message || JSON.stringify(igData.error));
      await supabaseUpsert("meta_analytics", [{
        snapshot_date: todayStr, platform: "instagram",
        follower_count: igData.follower_count, reach: igData.reach, impressions: igData.impressions,
        engagement_count: igData.engagement_count, engagement_rate: igData.engagement_rate,
        video_views: igData.video_views, video_completion_rate: igData.video_completion_rate,
        posts_published: igData.posts_published, raw_metrics: igData.raw_metrics
      }], "snapshot_date,platform", "merge-duplicates");
      summary.metrics.instagram = "ok";
    }
  } catch (err) {
    summary.errors.push("instagram metrics: " + err.message);
    console.error("[analytics-agent] instagram metrics failed: " + err.message);
  }

  try {
    var flagged = [];
    if (fbData && fbData.posts) flagged = flagged.concat(await scanFacebookComments(fbData.posts, pageId, token));
    if (igData && igData.posts) flagged = flagged.concat(await scanInstagramComments(igData.posts, igData.username, token));
    if (flagged.length) await supabaseUpsert("social_comments", flagged, "platform,comment_id", "ignore-duplicates");
    summary.commentsFlagged = flagged.length;
  } catch (err) {
    summary.errors.push("comment scan: " + err.message);
    console.error("[analytics-agent] comment scan failed: " + err.message);
  }

  try {
    var existingTips = await supabaseGet("ai_recommendations?kind=eq.daily_tip&period_date=eq." + todayStr + "&select=id");
    if (!existingTips.length) {
      var tips = await generateDailyTips(
        todayStr,
        fbData || { engagement_count: null, posts: [] },
        igData || { engagement_count: null, posts: [] }
      );
      await supabaseInsert("ai_recommendations", tips.map(function (t) {
        return { kind: "daily_tip", period_date: todayStr, title: t.title, body: t.body, plan_items: null, based_on: t.based_on || null };
      }));
      summary.tipsWritten = tips.length;
    }
  } catch (err) {
    summary.errors.push("daily tips: " + err.message);
    console.error("[analytics-agent] daily tips failed: " + err.message);
  }

  try {
    var plan = await generateMonthlyPlanIfDue();
    if (plan) {
      await supabaseInsert("ai_recommendations", [plan]);
      summary.monthlyPlanWritten = true;
    }
  } catch (err) {
    summary.errors.push("monthly plan: " + err.message);
    console.error("[analytics-agent] monthly plan failed: " + err.message);
  }

  console.log("[analytics-agent] " + JSON.stringify(summary));
  return summary;
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

  try {
    var summary = await runAgent();
    res.status(200).json(summary);
  } catch (err) {
    console.error("[analytics-agent] failed: " + err.message);
    res.status(500).json({ error: err.message });
  }
};

// Exported for api/analytics-refresh.js (the dashboard's manual trigger) and local
// smoke-testing — same reuse pattern as publish-scheduled-content.js's exports for
// publish-now.js.
module.exports.runAgent = runAgent;
module.exports.fetchFacebookDaily = fetchFacebookDaily;
module.exports.fetchInstagramDaily = fetchInstagramDaily;
module.exports.scanFacebookComments = scanFacebookComments;
module.exports.scanInstagramComments = scanInstagramComments;
module.exports.generateDailyTips = generateDailyTips;
module.exports.generateMonthlyPlanIfDue = generateMonthlyPlanIfDue;
