// The public projects site (media-projects command 6) — the 9th Vercel function (Hobby limit: 12).
//
//   GET  /api/site?r=gallery              → the gallery JSON for the homepage (CDN-cached)
//   GET  /projects/<slug>[?lang=en]       → (vercel.json rewrite → ?r=page&slug=) a server-rendered project page
//   GET  /sitemap-projects.xml            → (rewrite → ?r=sitemap) every published project page + its images
//   POST /api/site?action=publish {project_id} → publish a ready project on the site now, if it's due
//        (the panel's 💾 with a session, the bot's ✅ אשר with X-Internal-Secret). See api/_site-publish.js.
//
// Public reads use the ANON key, so RLS applies (anon sees only published + consented projects), AND the
// code checks again: status 'published', consent 'yes', a slug, not hidden (ai_meta.site_hidden). Only the
// fields the site shows leave this function (no captions, AI notes, flags or originals).
"use strict";

const { enforce } = require("./_rate-limit.js");
const SP = require("./_site-publish.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";
const SITE = SP.SITE_URL;
const PUBLIC_BASE = SUPABASE_URL + "/storage/v1/object/public/project-media/";
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the slider: phones get w480 (DPR 1) or w960 (DPR 2–3), never w1600 — same in shared/compare.js
const SLIDER_SIZES = "(max-width: 600px) 320px, (min-width: 1000px) 900px, 100vw";
const CACHE_PUBLIC = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
const PHONE = "+972529534540", PHONE_TXT = "052-9534540";
const SERVICE_ID = { floor_polish: "floor-restoration", crystal: "crystal-polish", marble_stone: "marble-stone", sealer: "sealer", concrete: "concrete-polish",
  bomanite: "bomanite", stairs: "stairs-sills", other: "floor-restoration" };
var timeoutMs = 10000;

function safeEqual(a, b) {
  var A = Buffer.from(String(a || "")), B = Buffer.from(String(b || ""));
  return A.length > 0 && A.length === B.length && require("crypto").timingSafeEqual(A, B);
}
async function anonGet(pathQs) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + pathQs, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("public read " + pathQs.split("?")[0] + " failed: " + res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// data: the public view of published projects
// ---------------------------------------------------------------------------
function img(m) {
  var v = m && m.variants;
  if (!v || !v.w480 || !v.w960 || !v.w1600) return null;
  return {
    s: { 480: PUBLIC_BASE + v.w480.path, 960: PUBLIC_BASE + v.w960.path, 1600: PUBLIC_BASE + v.w1600.path },
    jpg: v.jpg ? PUBLIC_BASE + v.jpg.path : PUBLIC_BASE + v.w1600.path,
    w: v.w1600.width || m.width || 1600, h: v.w1600.height || m.height || 1000,
    alt: { he: m.alt_he || "", en: m.alt_en || "" }
  };
}
function shape(p, media) {
  var images = media.filter(function (m) { return m.project_id === p.id && m.kind === "image" && img(m); })
    .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  if (!images.length) return null;
  var pairs = {};
  images.forEach(function (m) { if (m.pair_no != null && (m.role === "before" || m.role === "after")) (pairs[m.pair_no] = pairs[m.pair_no] || {})[m.role] = m; });
  var angles = Object.keys(pairs).map(Number).sort(function (a, b) { return a - b; })
    .filter(function (n) { return pairs[n].before && pairs[n].after; })
    .map(function (n) { return { before: img(pairs[n].before), after: img(pairs[n].after) }; });
  if (!angles.length) angles = [{ before: null, after: img(images.find(function (m) { return m.role === "after"; }) || images[0]) }];
  // the card shows an AFTER image: the chosen cover unless it is a "before" shot
  var coverM = images.find(function (m) { return m.id === p.cover_media_id && m.role !== "before"; });
  var cover = coverM ? img(coverM) : angles[0].after;
  var coverBefore = angles[0].before;
  var ci = SP.cityInfo(p.city);
  var label = SP.SERVICE_LABEL[p.service] || SP.SERVICE_LABEL.other;
  return {
    slug: p.slug, service: p.service || "other", published_at: p.published_at,
    title: { he: p.title_he || label[0], en: p.title_en || label[1] },
    summary: { he: p.summary_he || "", en: p.summary_en || "" },
    city: ci ? { he: ci.he, en: ci.en } : null,
    serviceLabel: { he: label[0], en: label[1] },
    cover: cover, coverBefore: coverBefore, angles: angles
  };
}
async function loadPublished(opts) {
  var q = "projects?status=eq.published&consent=eq.yes&slug=not.is.null" + (opts && opts.slug ? "&slug=eq." + encodeURIComponent(opts.slug) : "") +
    "&select=id,slug,service,city,title_he,title_en,summary_he,summary_en,cover_media_id,ai_meta,published_at,consent,status&order=published_at.desc&limit=200";
  var projects = (await anonGet(q)).filter(function (p) {   // the second check, on top of RLS
    return p.status === "published" && p.consent === "yes" && p.slug && SLUG_RE.test(p.slug) && !(p.ai_meta && p.ai_meta.site_hidden);
  });
  if (!projects.length) return [];
  var media = await anonGet("project_media?project_id=in.(" + projects.map(function (p) { return p.id; }).join(",") + ")&kind=eq.image" +
    "&select=id,project_id,kind,role,pair_no,sort,variants,alt_he,alt_en,width,height&order=sort.asc");
  return projects.map(function (p) { return shape(p, media); }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function jsonForScript(o) { return JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
// a spaced dash never starts a line ("…קרמה – בית החולים" → the dash stays at the end of the line before)
function glueDash(s) { return String(s).replace(/ ([–—]) /g, " $1 "); }
function srcset(i) { return i ? i.s[480] + " 480w, " + i.s[960] + " 960w, " + i.s[1600] + " 1600w" : ""; }
function pageUrl(slug, en) { return SITE + "/projects/" + slug + (en ? "?lang=en" : ""); }

const T = {
  he: { home: "דף הבית", gallery: "לפני ואחרי", before: "לפני", after: "אחרי", drag: "גררו כדי להשוות בין לפני לאחרי", angles: "זוויות נוספות", angle: "זווית",
    more: "עוד פרויקטים", ctaTitle: "רוצים תוצאה כזו גם אצלכם?", ctaText: "אורי מגיע לבדיקה, ממליץ על הטיפול המתאים ונותן הצעת מחיר.",
    call: "התקשרו: " + PHONE_TXT, wa: "שלחו וואטסאפ", switchLang: "English", switchLabel: "Switch to English", city: "עיר", service: "שירות",
    notFoundTitle: "הפרויקט לא נמצא", notFoundText: "ייתכן שהקישור השתנה או שהפרויקט הוסר.", backGallery: "לכל הפרויקטים", skip: "דלג לתוכן", projects: "פרויקטים",
    waText: "היי, ראיתי פרויקט באתר ואשמח לבדיקה והצעת מחיר", brand: "מיסטר פוליש – אורי מרגלית" },
  en: { home: "Home", gallery: "Before & After", before: "Before", after: "After", drag: "Drag to compare before and after", angles: "More angles", angle: "Angle",
    more: "More projects", ctaTitle: "Want a result like this at your place?", ctaText: "Uri comes over to inspect, recommends the right treatment and gives a quote.",
    call: "Call: " + PHONE_TXT, wa: "WhatsApp us", switchLang: "עברית", switchLabel: "החלף לעברית", city: "City", service: "Service",
    notFoundTitle: "Project not found", notFoundText: "The link may have changed, or the project was removed.", backGallery: "All projects", skip: "Skip to content", projects: "Projects",
    waText: "Hi, I saw a project on your site and would like an inspection and a quote", brand: "Mr. Polish – Uri Margalit" }
};
const PIN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
const HANDLE_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 7 4 12 9 17"></polyline><polyline points="15 7 20 12 15 17"></polyline></svg>';

function head(o) {
  return '<!DOCTYPE html>\n<html lang="' + o.lang + '" dir="' + (o.lang === "en" ? "ltr" : "rtl") + '">\n<head>\n<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>' + esc(o.title) + "</title>\n" +
    '<meta name="description" content="' + esc(o.description) + '" />\n' + (o.robots ? '<meta name="robots" content="' + o.robots + '" />\n' : "") +
    (o.canonical ? '<link rel="canonical" href="' + esc(o.canonical) + '" />\n' : "") + (o.extraHead || "") +
    '<link rel="icon" type="image/webp" href="/favicon.webp" />\n<meta name="theme-color" content="#1c1d22" />\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com" />\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;800;900&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet" />\n' +
    '<link rel="stylesheet" href="/styles.css" />\n</head>\n';
}
function header(t, lang, altHref) {
  return '<a class="skip-link" href="#main">' + t.skip + "</a>\n" +
    '<header class="site-header pp-header">\n<div class="container header-inner">\n' +
    '<a href="/' + (lang === "en" ? "?lang=en" : "") + '" class="brand" aria-label="' + esc(t.brand + " – " + t.home) + '"><img src="/logo.webp" alt="' + esc(t.brand) + '" class="brand-logo" width="160" height="56" /></a>\n' +
    '<div class="header-actions">' + (altHref ? '<a class="lang-switch" href="' + esc(altHref) + '" hreflang="' + (lang === "en" ? "he" : "en") + '" aria-label="' + esc(t.switchLabel) + '">' + t.switchLang + "</a>" : "") +
    '<a href="tel:' + PHONE + '" class="btn btn-shimmer btn-sm header-call"><span>' + PHONE_TXT + "</span></a></div>\n</div>\n</header>\n";
}
// The site's sticky mobile action bar (the same markup + styles as the homepage; hidden on desktop)
function mobileBar(t) {
  var en = t === T.en;
  return '<nav class="mobile-bar" aria-label="' + (en ? "Quick actions" : "פעולות מהירות") + '">' +
    '<a href="tel:' + PHONE + '" class="mobile-bar-btn mb-call"><span aria-hidden="true">📞</span><span>' + (en ? "Call now" : "חייג עכשיו") + "</span></a>" +
    '<a href="https://wa.me/972529534540?text=' + encodeURIComponent(t.waText) + '" class="mobile-bar-btn mb-wa" target="_blank" rel="noopener"><span aria-hidden="true">💬</span><span>' + (en ? "WhatsApp" : "שלח וואטסאפ") + "</span></a>" +
    '<a href="https://waze.com/ul?q=Mr.%20Polish" class="mobile-bar-btn mb-waze" target="_blank" rel="noopener"><span aria-hidden="true">🧭</span><span>' + (en ? "Waze" : "ניווט בוויז") + "</span></a></nav>\n";
}
function footer(t) {
  return '<footer class="pp-footer"><div class="container"><p>© ' + new Date().getFullYear() + " " + esc(t.brand) + ' · <a href="/accessibility.html">' + (t === T.en ? "Accessibility" : "הצהרת נגישות") +
    '</a> · <a href="/privacy.html">' + (t === T.en ? "Privacy" : "מדיניות פרטיות") + "</a></p></div></footer>\n";
}
function ctaBlock(t) {
  return '<section class="pp-cta" aria-labelledby="ppCtaTitle"><h2 id="ppCtaTitle">' + t.ctaTitle + "</h2><p>" + t.ctaText + "</p>" +
    '<div class="pp-cta-actions"><a class="btn btn-gold btn-lg" href="tel:' + PHONE + '">' + t.call + "</a>" +
    '<a class="btn btn-whatsapp btn-lg" href="https://wa.me/972529534540?text=' + encodeURIComponent(t.waText) + '" target="_blank" rel="noopener">' + t.wa + "</a></div></section>\n";
}
function compareMarkup(t, first, lang) {
  var a = first.after, b = first.before;
  var sizes = SLIDER_SIZES;
  return '<div class="compare' + (b ? "" : " compare--single") + '" id="ppCompare" data-sizes="' + sizes + '">' +
    '<div class="compare__after"><img id="ppAfter" src="' + esc(a.s[960]) + '" srcset="' + esc(srcset(a)) + '" sizes="' + sizes + '" width="' + a.w + '" height="' + a.h +
      '" alt="' + esc(a.alt[lang] || t.after) + '" draggable="false" fetchpriority="high" /></div>' +
    (b ? '<div class="compare__before"><img id="ppBefore" src="' + esc(b.s[960]) + '" srcset="' + esc(srcset(b)) + '" sizes="' + sizes + '" width="' + b.w + '" height="' + b.h +
      '" alt="' + esc(b.alt[lang] || t.before) + '" draggable="false" /></div>' +
      '<span class="compare__badge compare__badge--before">' + t.before + '</span><span class="compare__badge compare__badge--after">' + t.after + "</span>" +
      '<div class="compare__divider"><button class="compare__handle" type="button" role="slider" aria-label="' + esc(t.drag) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">' + HANDLE_SVG + "</button></div>" : "") +
    "</div>";
}
function cardMarkup(p, lang, t) {
  var c = p.cover, b = p.coverBefore;
  return '<li><a class="pcard' + (b ? " pcard--split" : "") + '" href="/projects/' + esc(p.slug) + (lang === "en" ? "?lang=en" : "") + '">' +
    '<span class="pcard__media"><img class="pcard__after" src="' + esc(c.s[480]) + '" srcset="' + esc(c.s[480] + " 480w, " + c.s[960] + " 960w") + '" sizes="(min-width: 1024px) 370px, (min-width: 520px) 46vw, 92vw" width="' + c.w + '" height="' + c.h +
    '" alt="' + esc(c.alt[lang] || "") + '" loading="lazy" decoding="async" />' +
    (b ? '<span class="pcard__before" aria-hidden="true"><img src="' + esc(b.s[480]) + '" width="' + b.w + '" height="' + b.h + '" alt="" loading="lazy" decoding="async" /></span>' : "") + "</span>" +
    '<span class="pcard__body"><span class="pcard__title">' + glueDash(esc(p.title[lang])) + "</span>" +
    '<span class="pcard__meta">' + (p.city ? '<span class="pcard__city">' + PIN + "<span>" + esc(p.city[lang]) + "</span></span>" : "") +
    '<span class="pcard__chip">' + esc(p.serviceLabel[lang]) + "</span></span></span></a></li>";
}

function projectPage(p, all, lang) {
  var t = T[lang], en = lang === "en";
  var url = pageUrl(p.slug, en), altUrl = pageUrl(p.slug, !en);
  var title = p.title[lang] + (p.city ? (en ? " in " : " ב") + p.city[lang] : "") + " | " + (en ? "Mr. Polish" : "מיסטר פוליש");
  var desc = (p.summary[lang] || p.title[lang]).slice(0, 300);
  var og = p.cover;
  var others = all.filter(function (x) { return x.slug !== p.slug; })
    .sort(function (a, b) { return (b.service === p.service) - (a.service === p.service); }).slice(0, 3);
  var ld = [{
    "@context": "https://schema.org", "@type": "CreativeWork", "@id": url + "#project", url: url, name: p.title[lang], description: desc, inLanguage: en ? "en" : "he",
    datePublished: p.published_at, image: p.angles.reduce(function (acc, a) {
      [a.before, a.after].forEach(function (i, k) { if (i) acc.push({ "@type": "ImageObject", contentUrl: i.jpg, width: i.w, height: i.h, caption: i.alt[lang] || (k ? t.after : t.before) }); });
      return acc;
    }, []),
    about: { "@id": SITE + "/#service-" + (SERVICE_ID[p.service] || "floor-restoration") },
    creator: { "@id": SITE + "/#business" }, provider: { "@id": SITE + "/#business" },
    locationCreated: p.city ? { "@type": "Place", name: p.city[lang], address: { "@type": "PostalAddress", addressLocality: p.city[lang], addressCountry: "IL" } } : undefined,
    isPartOf: { "@type": "WebSite", "@id": SITE + "/#website", url: SITE + "/" }
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: t.home, item: SITE + "/" + (en ? "?lang=en" : "") },
      { "@type": "ListItem", position: 2, name: t.gallery, item: SITE + "/" + (en ? "?lang=en" : "") + "#compare" },
      { "@type": "ListItem", position: 3, name: p.title[lang], item: url }]
  }];
  var extra = '<link rel="alternate" hreflang="he" href="' + esc(pageUrl(p.slug, false)) + '" />\n<link rel="alternate" hreflang="en" href="' + esc(pageUrl(p.slug, true)) + '" />\n' +
    '<link rel="alternate" hreflang="x-default" href="' + esc(pageUrl(p.slug, false)) + '" />\n' +
    '<meta property="og:type" content="article" />\n<meta property="og:site_name" content="' + (en ? "Mr. Polish" : "מיסטר פוליש") + '" />\n' +
    '<meta property="og:locale" content="' + (en ? "en_US" : "he_IL") + '" />\n<meta property="og:title" content="' + esc(title) + '" />\n' +
    '<meta property="og:description" content="' + esc(desc) + '" />\n<meta property="og:url" content="' + esc(url) + '" />\n' +
    '<meta property="og:image" content="' + esc(og.jpg) + '" />\n<meta property="og:image:width" content="' + og.w + '" />\n<meta property="og:image:height" content="' + og.h + '" />\n' +
    '<meta property="og:image:alt" content="' + esc(og.alt[lang] || p.title[lang]) + '" />\n<meta name="twitter:card" content="summary_large_image" />\n' +
    '<meta name="twitter:title" content="' + esc(title) + '" />\n<meta name="twitter:description" content="' + esc(desc) + '" />\n<meta name="twitter:image" content="' + esc(og.jpg) + '" />\n' +
    '<link rel="preload" as="image" href="' + esc(p.angles[0].after.s[960]) + '" imagesrcset="' + esc(srcset(p.angles[0].after)) + '" imagesizes="' + SLIDER_SIZES + '" fetchpriority="high" />\n' +
    '<script type="application/ld+json">' + jsonForScript(ld) + "</script>\n";
  var data = { lang: lang, angles: p.angles.map(function (a) { return { before: a.before, after: a.after }; }), t: { before: t.before, after: t.after, angle: t.angle } };
  return head({ lang: lang, title: title, description: desc, canonical: url, extraHead: extra }) +
    '<body class="pp-body">\n' + header(t, lang, altUrl) +
    '<main id="main" class="pp-main">\n<div class="container pp-container">\n' +
    '<nav class="pp-crumbs" aria-label="' + (en ? "Breadcrumb" : "פירורי לחם") + '"><ol><li><a href="/' + (en ? "?lang=en" : "") + '">' + t.home + '</a></li><li><a href="/' + (en ? "?lang=en" : "") + '#compare">' + t.gallery +
      '</a></li><li aria-current="page">' + esc(p.title[lang]) + "</li></ol></nav>\n" +
    '<article class="pp-article">\n<header class="pp-head"><h1 class="pp-title">' + glueDash(esc(p.title[lang])) + "</h1>" +
      '<p class="pp-meta">' + (p.city ? '<span class="pcard__city">' + PIN + '<span><span class="sr-only">' + t.city + ": </span>" + esc(p.city[lang]) + "</span></span>" : "") +
      '<span class="pcard__chip"><span class="sr-only">' + t.service + ": </span>" + esc(p.serviceLabel[lang]) + "</span></p>" +
      (p.summary[lang] ? '<p class="pp-summary">' + esc(p.summary[lang]) + "</p>" : "") + "</header>\n" +
    '<div class="pp-stage">' + compareMarkup(t, p.angles[0], lang) +
      (p.angles.length > 1 ? '<div class="gallery-dots" id="ppDots" role="group" aria-label="' + esc(t.angles) + '">' + p.angles.map(function (a, i) {
        return '<button type="button" class="gallery-dot' + (i ? "" : " active") + '" aria-label="' + esc(t.angle + " " + (i + 1)) + '" aria-pressed="' + (i ? "false" : "true") + '" data-angle="' + i + '"></button>';
      }).join("") + "</div>" : "") + "</div>\n</article>\n" +
    ctaBlock(t) +
    (others.length ? '<section class="pp-more" aria-labelledby="ppMoreTitle"><h2 id="ppMoreTitle">' + t.more + '</h2><ul class="pgrid">' + others.map(function (o) { return cardMarkup(o, lang, t); }).join("") + "</ul></section>\n" : "") +
    "</div>\n</main>\n" + footer(t) + mobileBar(t) +
    '<script type="application/json" id="ppData">' + jsonForScript(data) + "</script>\n" +
    '<script src="/shared/compare.js" defer></script>\n<script src="/shared/project-page.js" defer></script>\n</body>\n</html>\n';
}

function notFoundPage(lang) {
  var t = T[lang];
  return head({ lang: lang, title: t.notFoundTitle + " | " + (lang === "en" ? "Mr. Polish" : "מיסטר פוליש"), description: t.notFoundText, robots: "noindex" }) +
    '<body class="pp-body">\n' + header(t, lang, null) + '<main id="main" class="pp-main"><div class="container pp-container pp-404"><h1 class="pp-title">' + t.notFoundTitle +
    "</h1><p>" + t.notFoundText + '</p><p><a class="btn btn-gold" href="/' + (lang === "en" ? "?lang=en" : "") + '#compare">' + t.backGallery + "</a></p></div></main>\n" + footer(t) + mobileBar(t) + "</body>\n</html>\n";
}

function sitemapXml(all) {
  var x = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">'];
  all.forEach(function (p) {
    [false, true].forEach(function (en) {
      x.push("  <url>", "    <loc>" + esc(pageUrl(p.slug, en)) + "</loc>");
      if (p.published_at) x.push("    <lastmod>" + String(p.published_at).slice(0, 10) + "</lastmod>");
      x.push('    <xhtml:link rel="alternate" hreflang="he" href="' + esc(pageUrl(p.slug, false)) + '"/>', '    <xhtml:link rel="alternate" hreflang="en" href="' + esc(pageUrl(p.slug, true)) + '"/>');
      p.angles.forEach(function (a) { [a.after, a.before].forEach(function (i) { if (i) x.push("    <image:image><image:loc>" + esc(i.jpg) + "</image:loc></image:image>"); }); });
      x.push("  </url>");
    });
  });
  x.push("</urlset>");
  return x.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// POST ?action=publish
// ---------------------------------------------------------------------------
async function caller(req) {
  var secret = process.env.INTERNAL_API_SECRET;
  if (secret && req.headers["x-internal-secret"] && safeEqual(req.headers["x-internal-secret"], secret)) return "internal";
  var token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  var u = await res.json().catch(function () { return null; });
  return u && u.id ? "user" : null;
}

module.exports = async function handler(req, res) {
  var q = req.query || {};
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (q.action === "publish") {
    if (req.method !== "POST") return res.status(405).json({ code: "method_not_allowed" });
    if (enforce(req, res, "site-publish", 20, 60000)) return;
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ code: "server_config" });
    var who = null;
    try { who = await caller(req); } catch (e) { who = null; }
    if (!who) return res.status(401).json({ code: "unauthorized", he: "צריך להתחבר מחדש." });
    var id = String((req.body || {}).project_id || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ code: "bad_project" });
    res.setHeader("Cache-Control", "no-store");
    try {
      var out = await SP.publishProject(id, {});
      return res.status(out.ok ? 200 : out.reason === "not_found" ? 404 : 409).json(out);
    } catch (err) {
      console.error("[site] publish failed: " + err.message);
      return res.status(500).json({ code: "failed" });
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ code: "method_not_allowed" });
  if (enforce(req, res, "site-read", 120, 60000)) return;
  var lang = q.lang === "en" ? "en" : "he";
  var r = q.r;
  try {
    if (r === "gallery") {
      var all = await loadPublished();
      res.setHeader("Cache-Control", CACHE_PUBLIC);
      return res.status(200).json({ ok: true, projects: all });
    }
    if (r === "sitemap") {
      var list = await loadPublished();
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
      return res.status(200).send(sitemapXml(list));
    }
    if (r === "page") {
      var slug = String(q.slug || "").toLowerCase();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      var everything = SLUG_RE.test(slug) && slug.length <= 80 ? await loadPublished() : [];
      var p = everything.find(function (x) { return x.slug === slug; });
      if (!p) {
        res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
        return res.status(404).send(notFoundPage(lang));
      }
      res.setHeader("Cache-Control", CACHE_PUBLIC);
      return res.status(200).send(projectPage(p, everything, lang));
    }
    return res.status(404).json({ code: "not_found" });
  } catch (err) {
    console.error("[site] " + r + " failed: " + err.message);
    res.setHeader("Cache-Control", "no-store");
    if (r === "page") { res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.status(503).send(notFoundPage(lang).replace(T[lang].notFoundTitle, lang === "en" ? "Temporarily unavailable" : "לא זמין כרגע")); }
    return res.status(503).json({ ok: false, code: "unavailable" });
  }
};
module.exports._internal = { shape, projectPage, notFoundPage, sitemapXml, esc, jsonForScript, T };
module.exports._setTimeoutMs = function (ms) { timeoutMs = ms; };
