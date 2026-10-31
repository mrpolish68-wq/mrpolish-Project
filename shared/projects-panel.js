/* The panel's "📸 פרויקטים" tab (media-projects plan, Phase 6 — command 4). Plain browser script:
   window.MrpProjectsPanel.init({ sb, supabaseUrl, anonKey, root }) — called by admin.html the first
   time the tab opens. Uses shared/media-client.js (browser resize + EXIF strip, TUS uploads),
   shared/burst-schedule.js (publishing slots) and /api/media (process, analyze, correct, delete).

   - List: project cards (cover, title, city, service, status, destination chips), search + a service
     filter, realtime refresh (projects created in the bot appear live; needs
     supabase-projects-realtime.sql — until then it refreshes on open and when the app regains focus).
   - Editor: multi-file upload (images + videos ≤ 50 MB, per-file progress, resumable), ✨ AI analysis,
     editable pairs (role, pair, ⇄ swap), texts HE + EN, caption, alt texts, privacy flags ("בדקתי,
     אפשר לפרסם" or remove the photo), quality warnings, consent (required to publish), watermark,
     hide from the site, destinations + timing. Publishing itself is wired in commands 6 (site) and
     7 (social): the networks are queued only by the explicit "📣 אישור פרסום ברשתות" (renderSocial).
   - Edit: reorder, set the cover, delete a photo, delete the whole project (all files). */
(function () {
  "use strict";

  var SERVICES = [["floor_polish", "ליטוש מרצפות"], ["crystal", "פוליש קריסטל"], ["marble_stone", "שיש ואבן"], ["sealer", "סילר הגנה"],
    ["concrete", "בטון"], ["bomanite", "בומנייט"], ["stairs", "מדרגות"], ["other", "אחר"]];
  var SERVICE_HE = {}; SERVICES.forEach(function (s) { SERVICE_HE[s[0]] = s[1]; });
  var STATUS_HE = { collecting: "בהעלאה", draft: "טיוטה", ready: "מוכן לפרסום", published: "פורסם", archived: "בארכיון" };
  var DESTS = [["site", "🌐 אתר"], ["facebook", "📘 פייסבוק"], ["instagram", "📸 אינסטגרם"], ["ig_story", "⭕ סטורי"]];
  var DEST_HE = {}; DESTS.forEach(function (d) { DEST_HE[d[0]] = d[1]; });
  var ROLE_HE = { before: "לפני", after: "אחרי", detail: "פרט", video: "וידאו" };
  var QUALITY_HE = { blurry: "מטושטשת", dark: "חשוכה", tilted: "עקומה" };
  var FLAG_HE = { faces: "פנים", plates: "לוחית רישוי", house_numbers: "מספר בית", documents: "מסמך", other: "פרט מזהה" };
  var WARN_HE = {
    caption_not_changed: "ה-AI לא הצליח לקצר/לשנות את הכיתוב — הכיתוב הקודם נשאר. אפשר לערוך ידנית.",
    caption_retried: "הכיתוב קוצר (בניסיון השני).",
    "city:not_stated_or_invalid": "העיר לא נשמרה: אפשר רק עיר שנאמרה במפורש (בלי רחוב ומספר).",
    opening_repeated: "פתיחת הכיתוב דומה לפוסט קודם — כדאי לנסח אחרת.",
    "service:not_stated": "סוג השירות לא סומן כסילר/קריסטל כי זה לא נאמר."
  };
  var MAX_VIDEO = 50 * 1024 * 1024;
  var MAX_FILES = 30;
  var PARALLEL = 2;

  var S = null;   // { sb, url, key, root, BS, MC, list, media, filter, current, uploads, ... }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  // The caption editor is a plain <textarea> (no spans), so the phone number and the domain get a
  // non-breaking hyphen (U+2011) on screen only — Chrome wrapped "052-" / "9534540" on phones.
  // Converted back on save: the stored / published caption keeps a normal "-".
  function captionToEditor(s) { return String(s || "").replace(/(\d)-(?=\d)/g, "$1‑").replace(/\bmr-polishes\.com/g, "mr‑polishes.com"); }
  function captionFromEditor(s) { return String(s || "").replace(/‑/g, "-"); }
  function $(sel, el) { return (el || S.root).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || S.root).querySelectorAll(sel)); }
  function pub(path) { return path ? S.url + "/storage/v1/object/public/project-media/" + path.split("/").map(encodeURIComponent).join("/") : ""; }
  function thumbOf(m) {
    var v = m && m.variants;
    if (!v) return "";
    if (v.w480) return pub(v.w480.path);
    if (v.cover && v.cover.w480) return pub(v.cover.w480.path);
    return "";
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function needsReview(m) {
    var f = m.ai_flags || {};
    return !m.flags_ack_at && !!(f.faces || f.plates || f.house_numbers);
  }
  function announce(msg) { var el = $("#pjLive"); if (el) { el.textContent = ""; setTimeout(function () { el.textContent = msg; }, 30); } }
  function toast(msg, bad) {
    var t = $("#pjToast");
    if (!t) return;
    t.textContent = msg; t.className = "pj-toast show" + (bad ? " bad" : "");
    clearTimeout(t._h); t._h = setTimeout(function () { t.className = "pj-toast"; }, 2600);
    announce(msg);
  }
  function token() {
    return S.sb.auth.getSession().then(function (r) {
      var t = r && r.data && r.data.session && r.data.session.access_token;
      if (!t) throw Object.assign(new Error("no session"), { he: "צריך להתחבר מחדש." });
      return t;
    });
  }
  function api(action, body) {
    return token().then(function (t) {
      return fetch("/api/media?action=" + encodeURIComponent(action), {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.ok) throw Object.assign(new Error(data.code || ("http " + res.status)), { code: data.code, he: data.he || "משהו השתבש. נסו שוב." });
          return data;
        });
      });
    });
  }
  // The site (command 6): a ready project with the "site" destination goes live now (timing "now") or
  // at its slot (the publish cron). Same server rules as the bot (api/site.js → api/_site-publish.js).
  function sitePublish(projectId) {
    return token().then(function (t) {
      return fetch("/api/site?action=publish", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ project_id: projectId })
      }).then(function (res) { return res.json().catch(function () { return {}; }); });
    });
  }

  function db(promise, he) {
    return promise.then(function (r) {
      if (r.error) throw Object.assign(new Error(r.error.message || "db"), { he: he || "השמירה נכשלה. נסו שוב." });
      return r.data;
    });
  }

  /* ------------------------------------------------------------------ data */
  function loadList() {
    return db(S.sb.from("projects").select("id,status,consent,service,city,title_he,cover_media_id,ai_meta,source,watermark,created_at,updated_at")
      .order("updated_at", { ascending: false }).limit(200), "שגיאה בטעינת הפרויקטים.").then(function (projects) {
      S.list = projects || [];
      var ids = S.list.map(function (p) { return p.id; });
      if (!ids.length) { S.media = {}; return; }
      return db(S.sb.from("project_media").select("id,project_id,kind,role,pair_no,sort,variants,ai_flags,flags_ack_at,alt_he,alt_en,width,height,duration_s,created_at")
        .in("project_id", ids).order("sort", { ascending: true }), "שגיאה בטעינת הקבצים.").then(function (rows) {
        S.media = {};
        (rows || []).forEach(function (m) { (S.media[m.project_id] = S.media[m.project_id] || []).push(m); });
      });
    });
  }
  function loadProject(id) {
    return Promise.all([
      db(S.sb.from("projects").select("*").eq("id", id), "שגיאה בטעינת הפרויקט."),
      db(S.sb.from("project_media").select("*").eq("project_id", id).order("sort", { ascending: true }), "שגיאה בטעינת הקבצים.")
    ]).then(function (r) {
      var p = r[0] && r[0][0];
      if (!p) throw Object.assign(new Error("not found"), { he: "הפרויקט לא נמצא (אולי נמחק)." });
      S.current = { project: p, media: (r[1] || []).slice().sort(function (a, b) { return a.sort - b.sort || String(a.created_at).localeCompare(String(b.created_at)); }) };
      S.media[id] = S.current.media;
      return S.current;
    });
  }
  function queuedRows() {
    return db(S.sb.from("content_queue").select("id,scheduled_for,media_type,content_category,status").in("status", ["approved", "scheduled"])
      .gt("scheduled_for", new Date().toISOString()), "").catch(function () { return []; });
  }

  /* ------------------------------------------------------------------ list */
  function renderList() {
    S.view = "list";
    var q = (S.filter.q || "").trim().toLowerCase(), svc = S.filter.service || "";
    var rows = S.list.filter(function (p) {
      if (svc && p.service !== svc) return false;
      if (!q) return true;
      return [p.title_he, p.city, SERVICE_HE[p.service], (p.ai_meta && p.ai_meta.caption_he) || ""].join(" ").toLowerCase().indexOf(q) !== -1;
    });
    var cards = rows.map(function (p) {
      var media = S.media[p.id] || [];
      var cover = media.filter(function (m) { return m.id === p.cover_media_id; })[0] || media.filter(function (m) { return m.role === "after"; })[0] || media[0];
      var img = thumbOf(cover);
      var plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
      var flagged = media.some(needsReview);
      var chips = (plan.destinations || []).map(function (d) { return '<span class="pj-chip">' + esc(DEST_HE[d] || d) + "</span>"; }).join("");
      return '<li><button type="button" class="pj-card" data-open="' + esc(p.id) + '" aria-label="' + esc("פתיחת הפרויקט " + (p.title_he || "ללא כותרת")) + '">' +
        '<span class="pj-card-img">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async" />' : '<span class="pj-card-noimg" aria-hidden="true">📷</span>') +
        '<span class="pj-status pj-status-' + esc(p.status) + '">' + esc(STATUS_HE[p.status] || p.status) + "</span></span>" +
        '<span class="pj-card-body"><b class="pj-card-title">' + esc(p.title_he || "פרויקט ללא כותרת") + "</b>" +
        '<span class="pj-card-meta">' + esc([p.city, SERVICE_HE[p.service]].filter(Boolean).join(" · ") || "—") + " · " + media.length + " קבצים" +
        (p.source === "telegram" ? " · מהבוט" : "") + (p.ai_meta && p.ai_meta.migrated_from ? " · מהגלריה הקודמת" : "") + "</span>" +
        (flagged ? '<span class="pj-card-warn">⚠️ תמונה דורשת בדיקת פרטיות</span>' : "") +
        (p.consent !== "yes" ? '<span class="pj-card-note">ללא אישור לקוח לפרסום</span>' : "") +
        (chips ? '<span class="pj-chips">' + chips + "</span>" : "") + "</span></button></li>";
    }).join("");
    S.root.innerHTML =
      '<div class="pj-toolbar">' +
        '<div class="pj-search"><span aria-hidden="true">🔍</span><label class="pj-sr" for="pjSearch">חיפוש פרויקט</label>' +
        '<input type="search" id="pjSearch" placeholder="חיפוש לפי כותרת או עיר…" autocomplete="off" value="' + esc(S.filter.q || "") + '" /></div>' +
        '<label class="pj-sr" for="pjService">סינון לפי שירות</label><select id="pjService"><option value="">כל השירותים</option>' +
          SERVICES.map(function (s) { return '<option value="' + s[0] + '"' + (svc === s[0] ? " selected" : "") + ">" + esc(s[1]) + "</option>"; }).join("") + "</select>" +
        '<button type="button" class="btn btn-shimmer btn-sm" id="pjNew">➕ פרויקט חדש</button>' +
      "</div>" +
      '<p class="pj-count" id="pjCount">' + rows.length + " פרויקטים" + (rows.length !== S.list.length ? " (מתוך " + S.list.length + ")" : "") + "</p>" +
      (rows.length ? '<ul class="pj-grid" id="pjGrid">' + cards + "</ul>" :
        '<div class="pj-empty">' + (S.list.length ? "אין פרויקטים שמתאימים לחיפוש." : "עדיין אין פרויקטים. לחצו על \"➕ פרויקט חדש\" כדי להעלות תמונות לפני/אחרי.") + "</div>") +
      chrome();
  }
  function chrome() { return '<div class="pj-toast" id="pjToast" role="status"></div><div class="pj-sr" id="pjLive" aria-live="polite"></div>'; }

  function createProject() {
    var btn = $("#pjNew");
    if (btn) btn.disabled = true;
    db(S.sb.from("projects").insert({ status: "collecting", source: "panel" }).select(), "לא הצלחנו ליצור פרויקט. נסו שוב.").then(function (rows) {
      var p = rows && rows[0];
      S.list.unshift(p); S.media[p.id] = [];
      return openProject(p.id, { fresh: true });
    }).catch(function (e) { toast(e.he || "שגיאה", true); if (btn) btn.disabled = false; });
  }

  /* ------------------------------------------------------------------ editor */
  function openProject(id, opts) {
    S.dirty = false;
    return loadProject(id).then(function () {
      renderEditor();
      var h = $("#pjEdTitle"); if (h) h.focus();
      if (opts && opts.fresh) announce("נוצר פרויקט חדש. אפשר להעלות תמונות.");
    }).catch(function (e) { toast(e.he || "שגיאה", true); refreshList(); });
  }

  function mediaCard(m, i, all) {
    var img = thumbOf(m);
    var isVideo = m.kind === "video";
    var f = m.ai_flags || {};
    var flagNames = Object.keys(FLAG_HE).filter(function (k) { return f[k] === true; }).map(function (k) { return FLAG_HE[k]; });
    var review = needsReview(m);
    var quality = (f.quality || []).map(function (q) { return '<span class="pj-chip pj-chip-warn">' + esc(QUALITY_HE[q] || q) + "</span>"; }).join("");
    var isCover = S.current.project.cover_media_id === m.id;
    var partner = (m.role === "before" || m.role === "after") && m.pair_no != null && all.some(function (o) { return o !== m && o.pair_no === m.pair_no && (o.role === "before" || o.role === "after"); });
    var n = i + 1;
    return '<li class="pj-media' + (review ? " pj-media-flag" : "") + '" data-media="' + esc(m.id) + '">' +
      '<div class="pj-media-img">' + (img ? '<img src="' + esc(img) + '" alt="' + esc(m.alt_he || ("קובץ " + n)) + '" loading="lazy" />' : '<span class="pj-card-noimg" aria-hidden="true">' + (isVideo ? "🎬" : "📷") + "</span>") +
        (isVideo ? '<span class="pj-badge">🎬 ' + (m.duration_s ? Math.round(m.duration_s) + " ש׳" : "וידאו") + "</span>" : "") +
        (isCover ? '<span class="pj-badge pj-badge-cover">⭐ שער</span>' : "") + "</div>" +
      '<div class="pj-media-body">' +
        (isVideo ? '<p class="pj-media-role">וידאו</p>' :
        '<div class="pj-media-row"><label>תפקיד<select data-field="role" aria-label="תפקיד קובץ ' + n + '">' +
          ["before", "after", "detail"].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" + ROLE_HE[r] + "</option>"; }).join("") +
          (m.role ? "" : '<option value="" selected>—</option>') + "</select></label>" +
        '<label>זוג<input type="number" min="1" max="50" inputmode="numeric" data-field="pair_no" value="' + (m.pair_no == null ? "" : m.pair_no) + '" aria-label="מספר זוג לקובץ ' + n + '" /></label>' +
        (partner ? '<button type="button" class="pj-icon" data-act="swap" aria-label="החלפת לפני/אחרי בזוג ' + m.pair_no + '" title="החלפת לפני ↔ אחרי">⇄</button>' : "") + "</div>") +
        (quality ? '<div class="pj-chips">' + quality + "</div>" : "") +
        (flagNames.length ? (review ?
          '<div class="pj-flag" role="alert"><b>⚠️ זוהה: ' + esc(flagNames.join(", ")) + "</b><span>אי אפשר לפרסם עד שבודקים את התמונה.</span>" +
          '<div class="pj-flag-actions"><button type="button" class="btn btn-sm btn-navy" data-act="ack">בדקתי, אפשר לפרסם</button>' +
          '<button type="button" class="btn btn-sm pj-btn-danger" data-act="remove">הסרת התמונה</button></div></div>' :
          '<p class="pj-ok">✓ נבדק (' + esc(flagNames.join(", ")) + ")</p>") : "") +
        (isVideo ? "" : '<details class="pj-alt"><summary>טקסט חלופי (נגישות)</summary>' +
          '<label>עברית<input type="text" maxlength="125" data-field="alt_he" value="' + esc(m.alt_he || "") + '" /></label>' +
          '<label>English<input type="text" dir="ltr" maxlength="125" data-field="alt_en" value="' + esc(m.alt_en || "") + '" /></label></details>') +
        '<div class="pj-media-actions">' +
          '<button type="button" class="pj-icon" data-act="up" aria-label="הזזת קובץ ' + n + ' קדימה"' + (i === 0 ? " disabled" : "") + ">▲</button>" +
          '<button type="button" class="pj-icon" data-act="down" aria-label="הזזת קובץ ' + n + ' אחורה"' + (i === all.length - 1 ? " disabled" : "") + ">▼</button>" +
          '<button type="button" class="pj-icon" data-act="cover" aria-pressed="' + isCover + '" aria-label="קביעת קובץ ' + n + ' כתמונת שער">⭐</button>' +
          '<button type="button" class="pj-icon pj-icon-danger" data-act="delete" aria-label="מחיקת קובץ ' + n + '">🗑</button>' +
        "</div></div></li>";
  }

  function uploadRows() {
    return S.uploads.filter(function (u) { return u.projectId === S.current.project.id && u.state !== "done"; }).map(function (u) {
      var pct = Math.round((u.progress || 0) * 100);
      return '<li class="pj-up pj-up-' + u.state + '"><span class="pj-up-name">' + esc(u.file.name) + "</span>" +
        '<span class="pj-up-bar" role="progressbar" aria-label="' + esc("העלאת " + u.file.name) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="inline-size:' + pct + '%"></i></span>' +
        '<span class="pj-up-state">' + esc(u.state === "error" ? (u.error || "נכשל") : u.state === "processing" ? "מעבד…" : u.state === "queued" ? "ממתין" : pct + "%") + "</span>" +
        (u.state === "error" ? '<button type="button" class="pj-icon" data-retry="' + u.id + '" aria-label="ניסיון חוזר">↻</button>' : "") + "</li>";
    }).join("");
  }
  function renderUploads() { var el = $("#pjUploads"); if (el) el.innerHTML = uploadRows(); }

  function renderEditor() {
    S.view = "editor";
    var p = S.current.project, media = S.current.media, meta = p.ai_meta || {}, plan = meta.publish_plan || {};
    var dests = plan.destinations || [];
    var images = media.filter(function (m) { return m.kind === "image"; });
    var flagged = media.filter(needsReview).length;
    var gates = [
      [p.consent === "yes", "אישור הלקוח לפרסום"],
      [flagged === 0, flagged ? flagged + " תמונות ממתינות לבדיקת פרטיות" : "בדיקת פרטיות"],
      [media.length > 0, "לפחות קובץ אחד"],
      [dests.length > 0, "יעד פרסום אחד לפחות"]
    ];
    var at = plan.timing === "at" && plan.at ? S.BS.israelParts(plan.at) : null;
    S.root.innerHTML =
      '<div class="pj-ed-head"><button type="button" class="btn btn-navy btn-sm" id="pjBack">→ לכל הפרויקטים</button>' +
      '<span class="pj-status pj-status-' + esc(p.status) + '">' + esc(STATUS_HE[p.status] || p.status) + "</span></div>" +
      '<h3 class="pj-ed-title" id="pjEdTitle" tabindex="-1">' + esc(p.title_he || "פרויקט חדש") + "</h3>" +

      '<section class="pj-sec" aria-labelledby="pjSecFiles"><h4 id="pjSecFiles">1. תמונות וסרטונים</h4>' +
        '<label class="pj-drop" id="pjDrop" for="pjFiles"><span class="pj-drop-ic" aria-hidden="true">⬆️</span>' +
        '<b>בחירת תמונות וסרטונים מהגלריה</b><span>או גררו לכאן · תמונות JPG / PNG / HEIC, סרטוני MP4 / MOV עד 50MB</span></label>' +
        '<input type="file" id="pjFiles" class="pj-file" multiple accept="image/*,video/mp4,video/quicktime,.heic,.heif,.mov" />' +
        '<ul class="pj-uploads" id="pjUploads">' + uploadRows() + "</ul>" +
        (media.length ? '<ul class="pj-media-grid" id="pjMedia">' + media.map(function (m, i) { return mediaCard(m, i, media); }).join("") + "</ul>" : '<p class="pj-muted">עדיין אין קבצים בפרויקט.</p>') +
      "</section>" +

      '<section class="pj-sec" aria-labelledby="pjSecAi"><h4 id="pjSecAi">2. ✨ ניתוח AI</h4>' +
        '<p class="pj-muted">ה-AI מסדר זוגות לפני/אחרי, כותב כותרת, תיאור, כיתוב וטקסט חלופי, ומסמן פנים, לוחיות רישוי ומספרי בתים. הכול ניתן לעריכה.</p>' +
        '<label class="pj-field"><span>מה עשינו? (סוג העבודה והעיר — בלי שמות, כתובות ומחירים)</span>' +
        '<textarea id="pjAiText" rows="2" maxlength="600" placeholder="לדוגמה: ליטוש והברקה לשיש בסלון בבית שמש">' + esc((S.aiDraft || {})[p.id] || "") + "</textarea></label>" +
        '<button type="button" class="btn btn-shimmer btn-sm" id="pjAnalyze"' + (images.length ? "" : " disabled") + ">✨ ניתוח AI</button>" +
        (images.length ? "" : ' <span class="pj-muted">(קודם מעלים תמונות)</span>') +
        (meta.needs_review && images.length ? '<div class="pj-note" role="note">🔎 בדקו את זוגות הלפני/אחרי למעלה — ה-AI לא בטוח בהם. אפשר לשנות תפקיד, מספר זוג או להחליף ⇄.</div>' : "") +
        warningsHtml(meta.warnings) +
      "</section>" +

      '<section class="pj-sec" aria-labelledby="pjSecText"><h4 id="pjSecText">3. טקסטים</h4>' +
        '<div class="pj-row2"><label class="pj-field"><span>כותרת (עברית)</span><input type="text" id="pjTitleHe" maxlength="70" value="' + esc(p.title_he || "") + '" /></label>' +
        '<label class="pj-field"><span>Title (English)</span><input type="text" id="pjTitleEn" dir="ltr" maxlength="70" value="' + esc(p.title_en || "") + '" /></label></div>' +
        '<div class="pj-row2"><label class="pj-field"><span>שירות</span><select id="pjServiceSel"><option value="">—</option>' +
          SERVICES.map(function (s) { return '<option value="' + s[0] + '"' + (p.service === s[0] ? " selected" : "") + ">" + esc(s[1]) + "</option>"; }).join("") + "</select></label>" +
        '<label class="pj-field"><span>עיר (בלי רחוב ומספר)</span><input type="text" id="pjCity" maxlength="40" value="' + esc(p.city || "") + '" /></label></div>' +
        '<label class="pj-field"><span>תיאור לאתר (עברית)</span><textarea id="pjSumHe" rows="3" maxlength="420">' + esc(p.summary_he || "") + "</textarea></label>" +
        '<label class="pj-field"><span>Description for the site (English)</span><textarea id="pjSumEn" rows="3" dir="ltr" maxlength="420">' + esc(p.summary_en || "") + "</textarea></label>" +
        '<label class="pj-field"><span>כיתוב לרשתות</span><textarea id="pjCaption" rows="7" maxlength="2200">' + esc(captionToEditor(meta.caption_he)) + "</textarea></label>" +
        '<div class="pj-correct"><label class="pj-sr" for="pjCorrText">תיקון במילים</label><input type="text" id="pjCorrText" maxlength="300" placeholder="תיקון במילים, למשל: העיר היא רעננה" />' +
        '<button type="button" class="btn btn-navy btn-sm" id="pjCorrect">תיקון</button><button type="button" class="btn btn-navy btn-sm" id="pjShorter">✂️ קצר יותר</button></div>' +
      "</section>" +

      '<section class="pj-sec" aria-labelledby="pjSecPub"><h4 id="pjSecPub">4. פרסום</h4>' +
        '<label class="pj-toggle"><input type="checkbox" id="pjConsent"' + (p.consent === "yes" ? " checked" : "") + " /> <span><b>הלקוח אישר פרסום</b>" +
          (p.consent === "unknown" ? " · טרם סומן" : p.consent === "no" ? " · לא אישר — הפרויקט נשמר רק פנימית" : "") + " (חובה לפרסום)</span></label>" +
        '<label class="pj-toggle"><input type="checkbox" id="pjWatermark"' + (p.watermark ? " checked" : "") + " /> <span><b>סימן מים (לוגו)</b> · חל על קבצים שיועלו מעכשיו</span></label>" +
        '<label class="pj-toggle"><input type="checkbox" id="pjHidden"' + (meta.site_hidden ? " checked" : "") + " /> <span><b>הסתרה מהאתר</b> · הפרויקט לא יוצג בגלריה</span></label>" +
        '<fieldset class="pj-dests"><legend>איפה לפרסם?</legend>' +
          DESTS.map(function (d) { var on = dests.indexOf(d[0]) !== -1; return '<button type="button" class="pj-dest" data-dest="' + d[0] + '" aria-pressed="' + on + '">' + esc(d[1]) + "</button>"; }).join("") +
        "</fieldset>" +
        '<fieldset class="pj-timing"><legend>מתי?</legend>' +
          '<label><input type="radio" name="pjWhen" value="now"' + (plan.timing !== "at" ? " checked" : "") + " /> בהקדם</label>" +
          '<label><input type="radio" name="pjWhen" value="at"' + (plan.timing === "at" ? " checked" : "") + " /> לבחור מועד</label>" +
          '<div class="pj-when-at" id="pjWhenAt"' + (plan.timing === "at" ? "" : " hidden") + '>' +
            '<label>תאריך<input type="date" id="pjDate" value="' + (at ? at.y + "-" + pad2(at.m) + "-" + pad2(at.d) : "") + '" /></label>' +
            '<label>שעה<input type="time" id="pjTime" step="300" value="' + (at ? pad2(at.h) + ":" + pad2(at.min) : "") + '" /></label></div>' +
          '<p class="pj-muted" id="pjWhenHint"></p>' +
        "</fieldset>" +
        '<ul class="pj-gates" aria-label="מה חסר לפרסום">' + gates.map(function (g) { return '<li class="' + (g[0] ? "ok" : "no") + '">' + (g[0] ? "✓ " : "✗ ") + esc(g[1]) + "</li>"; }).join("") + "</ul>" +
        (p.status === "published" && p.slug && !meta.site_hidden
          ? '<p class="pj-live">🌐 פורסם באתר · <a href="/projects/' + esc(p.slug) + '" target="_blank" rel="noopener">לעמוד הפרויקט</a></p>'
          : p.status === "published" && meta.site_hidden ? '<p class="pj-live">🙈 מוסתר מהאתר (הורידו את הסימון כדי להחזיר)</p>'
          : '<p class="pj-live">🌐 האתר: כשכל הסעיפים ✓ ושומרים, הפרויקט עולה לאתר — מיד או במועד שנבחר.</p>') +
        '<div class="pj-social" id="pjSocial" aria-live="polite"></div>' +
      "</section>" +

      '<section class="pj-sec pj-danger" aria-labelledby="pjSecDel"><h4 id="pjSecDel">מחיקת הפרויקט</h4>' +
        '<p class="pj-muted">מוחק את כל הקבצים מהאחסון. פוסטים שכבר עלו לאינסטגרם לא נמחקים אוטומטית — צריך למחוק אותם ידנית באפליקציה.</p>' +
        '<button type="button" class="btn btn-sm pj-btn-danger" id="pjDelete">🗑 מחיקת הפרויקט</button></section>' +

      '<div class="pj-savebar"><span class="pj-dirty" id="pjDirty" aria-live="polite"></span>' +
        '<button type="button" class="btn btn-shimmer btn-sm" id="pjSave">💾 שמירה</button></div>' + chrome();
    updateWhenHint();
    renderSocial();
  }

  // Facebook / Instagram / story (command 7). The posts are queued only by an explicit approval —
  // "📣 אישור פרסום ברשתות" (the panel's saves never publish to the networks by themselves). Once
  // queued, this shows each post with its time and status (they are managed in ניהול תוכן).
  var SOCIAL_DESTS = ["facebook", "instagram", "ig_story"];
  var SOCIAL_KIND = { carousel: "פוסט תמונות", image: "פוסט תמונה", reel: "סרטון", video: "סרטון", story: "סטורי" };
  var QUEUE_STATUS = { approved: "מתוזמן", scheduled: "מתוזמן בפייסבוק", published: "פורסם ✓", failed: "נכשל — לבדוק בניהול תוכן", pending_approval: "ממתין", rejected: "בוטל" };
  function israelLabel(iso) {
    var q = S.BS.israelParts(iso);
    return pad2(q.d) + "." + pad2(q.m) + " · " + pad2(q.h) + ":" + pad2(q.min);
  }
  function renderSocial() {
    var box = $("#pjSocial");
    if (!box || !S.current) return;
    var p = S.current.project, plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
    var wanted = (plan.destinations || []).filter(function (d) { return SOCIAL_DESTS.indexOf(d) !== -1; });
    db(S.sb.from("content_queue").select("id,media_type,status,scheduled_for,published_at").eq("project_id", p.id).order("scheduled_for"), "")
      .catch(function () { return null; }).then(function (rows) {
        var el = $("#pjSocial");
        if (!el || !S.current || S.current.project.id !== p.id) return;
        rows = (rows || []).filter(function (r) { return r.status !== "rejected"; });
        if (rows.length) {
          el.innerHTML = '<p class="pj-live">📣 ברשתות:</p><ul class="pj-social-list">' + rows.map(function (r) {
            return "<li>" + esc(SOCIAL_KIND[r.media_type] || "פוסט") + " · " + esc(israelLabel(r.published_at || r.scheduled_for)) + " · " + esc(QUEUE_STATUS[r.status] || r.status) + "</li>";
          }).join("") + "</ul>";
          return;
        }
        if (!wanted.length) { el.innerHTML = ""; return; }
        var can = p.consent === "yes" && (p.status === "ready" || p.status === "published");
        el.innerHTML = can
          ? '<button type="button" class="btn btn-gold btn-sm" id="pjSocialGo">📣 אישור פרסום ברשתות</button>' +
            '<p class="pj-muted">הפוסטים ייכנסו ללוח הפרסום ויפורסמו אוטומטית במועד שנבחר (עד 3 בכל סבב). תגיע הודעה בטלגרם על כל פוסט.</p>'
          : '<p class="pj-muted">📣 הרשתות: אפשר לאשר אחרי שכל הסעיפים ✓ ושומרים.</p>';
      });
  }
  function approveSocial() {
    if (S.dirty) { toast("קודם 💾 שומרים את השינויים.", true); return; }
    if (!confirm("לאשר פרסום ברשתות?\nהפוסטים ייכנסו ללוח הפרסום ויפורסמו אוטומטית — אי אפשר לבטל פוסט שכבר עלה.")) return;
    var btn = $("#pjSocialGo"); if (btn) btn.disabled = true;
    var id = S.current.project.id;
    return token().then(function (t) {
      return fetch("/api/site?action=publish", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ project_id: id, social: true })
      }).then(function (res) { return res.json().catch(function () { return {}; }); });
    }).then(function (r) {
      var s = r.social || {};
      toast(s.queued || s.already ? "📣 הפוסטים נכנסו ללוח הפרסום" : s.reason === "no_caption" ? "חסר כיתוב לרשתות." : s.reason === "no_media" ? "אין תמונה או סרטון לפרסום." :
        s.reason === "flags" || s.reason === "guard" || s.reason === "no_consent" ? "הפרסום נעצר בבדיקת ההסכמה / הפרטיות." : "נשמר — ייכנס ללוח בסבב הבא.", !(s.queued || s.already || s.busy));
      renderSocial();
    }).catch(function () { toast("הפעולה נכשלה. נסו שוב.", true); var b = $("#pjSocialGo"); if (b) b.disabled = false; });
  }
  function warningsHtml(list) {
    var items = (list || []).map(function (w) { return WARN_HE[w]; }).filter(Boolean);
    return items.length ? '<ul class="pj-warn">' + items.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" : "";
  }
  function setDirty(on) { S.dirty = on; var d = $("#pjDirty"); if (d) d.textContent = on ? "יש שינויים שלא נשמרו" : ""; }

  function updateWhenHint() {
    var hint = $("#pjWhenHint");
    if (!hint) return;
    var when = ($("input[name=pjWhen]:checked") || {}).value;
    queuedRows().then(function (rows) {
      S.queued = rows || [];
      var slot = S.BS.nextFreeSlot({ existing: S.queued });
      if (when === "at") {
        var d = $("#pjDate"), t = $("#pjTime");
        if (d && t && !d.value) {
          var p = S.BS.israelParts(slot.iso);
          d.value = p.y + "-" + pad2(p.m) + "-" + pad2(p.d); t.value = pad2(p.h) + ":" + pad2(p.min);
        }
        var chosen = pickedDate();
        var clash = chosen && S.queued.some(function (r) { return Math.abs(new Date(r.scheduled_for) - chosen) < 60 * 60 * 1000; });
        hint.textContent = !chosen ? "" : chosen <= new Date() ? "⚠️ המועד כבר עבר — בחרו מועד עתידי." :
          clash ? "⚠️ בשעה הזאת כבר מתוזמן פוסט. מועד פנוי מומלץ: יום " + slot.dayLabel + " " + slot.dateLabel + " " + slot.timeLabel + "." :
          "המועד הפנוי הבא לפי לוח הפרסום: יום " + slot.dayLabel + " " + slot.dateLabel + " " + slot.timeLabel + ".";
      } else {
        hint.textContent = "לרשתות: לא יותר מ-3 פוסטים ב-10 דקות (מגן ריבוי). המועד הפנוי הבא: יום " + slot.dayLabel + " " + slot.dateLabel + " " + slot.timeLabel + ".";
      }
    });
  }
  function pickedDate() {
    var d = $("#pjDate"), t = $("#pjTime");
    if (!d || !t || !d.value || !t.value) return null;
    var a = d.value.split("-").map(Number), b = t.value.split(":").map(Number);
    return S.BS.israelWallToDate(a[0], a[1], a[2], b[0], b[1]);
  }

  // The caption textarea holds body + CTA + hashtags; the body (for AI corrections) is what's above the CTA.
  function splitCaption(text) {
    var t = String(text || "").trim();
    var cut = t.indexOf("📞");
    var body = (cut === -1 ? t.replace(/(\s*#[\p{L}\p{N}_]+)+\s*$/u, "") : t.slice(0, cut)).trim();
    var tags = (t.slice(cut === -1 ? body.length : cut).match(/#[\p{L}\p{N}_]+/gu) || []);
    return { body: body, hashtags: tags };
  }

  function collectProject() {
    var p = S.current.project, meta = Object.assign({}, p.ai_meta || {});
    var city = $("#pjCity").value.trim();
    if (/\d/.test(city)) throw Object.assign(new Error("city"), { he: "בעיר אסור מספרים (רק שם העיר, בלי רחוב ומספר בית)." });
    var when = ($("input[name=pjWhen]:checked") || {}).value === "at" ? "at" : "now";
    var at = null;
    if (when === "at") {
      at = pickedDate();
      if (!at) throw Object.assign(new Error("date"), { he: "בחרו תאריך ושעה לפרסום." });
      if (at <= new Date()) throw Object.assign(new Error("past"), { he: "המועד שבחרתם כבר עבר — בחרו מועד עתידי." });
    }
    var dests = $all(".pj-dest[aria-pressed=true]").map(function (b) { return b.getAttribute("data-dest"); });
    var cap = captionFromEditor($("#pjCaption").value);
    var split = splitCaption(cap);
    meta.caption_he = cap.trim() || null;
    meta.caption_body_he = split.body || null;
    if (split.hashtags.length) meta.hashtags = split.hashtags;
    meta.site_hidden = $("#pjHidden").checked;
    meta.publish_plan = { destinations: dests, timing: when, at: at ? at.toISOString() : null, saved_at: new Date().toISOString() };
    var consentOn = $("#pjConsent").checked;
    var patch = {
      title_he: $("#pjTitleHe").value.trim() || null, title_en: $("#pjTitleEn").value.trim() || null,
      summary_he: $("#pjSumHe").value.trim() || null, summary_en: $("#pjSumEn").value.trim() || null,
      service: $("#pjServiceSel").value || null, city: city || null, watermark: $("#pjWatermark").checked, ai_meta: meta
    };
    if (consentOn && p.consent !== "yes") { patch.consent = "yes"; patch.consent_at = new Date().toISOString(); patch.consent_by = S.userEmail || "panel"; }
    if (!consentOn && p.consent === "yes") { patch.consent = "no"; patch.consent_at = new Date().toISOString(); patch.consent_by = S.userEmail || "panel"; }
    // draft / ready (published + archived are kept): ready = everything needed to publish is there
    if (p.status !== "published" && p.status !== "archived") {
      var media = S.current.media;
      var ready = (patch.consent || p.consent) === "yes" && media.length > 0 && !media.some(needsReview) && dests.length > 0;
      patch.status = media.length ? (ready ? "ready" : "draft") : p.status;
    }
    return patch;
  }

  function saveProject(quiet) {
    var patch;
    try { patch = collectProject(); } catch (e) { toast(e.he || "שגיאה", true); return Promise.reject(e); }
    var btn = $("#pjSave"); if (btn) btn.disabled = true;
    return db(S.sb.from("projects").update(patch).eq("id", S.current.project.id).select(), "השמירה נכשלה. נסו שוב.").then(function (rows) {
      if (rows && rows[0]) S.current.project = rows[0];
      setDirty(false);
      var p = S.current.project, plan = (p.ai_meta && p.ai_meta.publish_plan) || {};
      // (render first, THEN the toast: renderEditor() rebuilds #pjToast, so the other order wiped it at once)
      if (quiet || p.status !== "ready" || (plan.destinations || []).indexOf("site") === -1) {
        if (!quiet) { renderEditor(); toast("נשמר ✓"); }
        return p;
      }
      return sitePublish(p.id).catch(function () { return {}; }).then(function (r) {
        var reload = r.published ? db(S.sb.from("projects").select("*").eq("id", p.id), "").then(function (x) { if (x && x[0]) S.current.project = x[0]; }) : Promise.resolve();
        return reload.catch(function () {}).then(function () {
          renderEditor();
          toast(r.published ? "נשמר ✓ · עלה לאתר" : r.scheduled ? "נשמר ✓ · יעלה לאתר במועד שנבחר" : "נשמר ✓");
          return S.current.project;
        });
      });
    }).catch(function (e) { toast(e.he || "השמירה נכשלה.", true); throw e; }).finally(function () { var b = $("#pjSave"); if (b) b.disabled = false; });
  }

  function updateMedia(id, patch) {
    return db(S.sb.from("project_media").update(patch).eq("id", id).select(), "העדכון נכשל. נסו שוב.").then(function (rows) {
      var m = rows && rows[0];
      if (m) S.current.media = S.current.media.map(function (o) { return o.id === id ? Object.assign({}, o, m) : o; });
      return m;
    });
  }

  /* ------------------------------------------------------------------ uploads */
  var seq = 0;
  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var pid = S.current.project.id;
    var room = MAX_FILES - S.current.media.length - S.uploads.filter(function (u) { return u.projectId === pid && u.state !== "done" && u.state !== "error"; }).length;
    if (list.length > room) { toast("אפשר עד " + MAX_FILES + " קבצים בפרויקט.", true); list = list.slice(0, Math.max(0, room)); }
    list.forEach(function (file) {
      var isVideo = /^video\//.test(file.type) || /\.(mp4|mov)$/i.test(file.name);
      var u = { id: ++seq, projectId: pid, file: file, kind: isVideo ? "video" : "image", state: "queued", progress: 0 };
      if (isVideo && file.size > MAX_VIDEO) { u.state = "error"; u.error = "גדול מ-50MB"; }
      else if (!isVideo && !/^image\//.test(file.type) && !S.MC.isHeic(file)) { u.state = "error"; u.error = "סוג קובץ לא נתמך"; }
      S.uploads.push(u);
    });
    renderUploads();
    pump();
  }
  function pump() {
    var running = S.uploads.filter(function (u) { return u.state === "uploading" || u.state === "processing" || u.state === "preparing"; }).length;
    S.uploads.filter(function (u) { return u.state === "queued"; }).slice(0, Math.max(0, PARALLEL - running)).forEach(function (u) {
      u.state = "preparing";
      uploadOne(u).then(function (media) {
        u.state = "done"; u.progress = 1;
        if (S.current && S.current.project.id === u.projectId) {
          S.current.media.push(media);
          S.current.media.sort(function (a, b) { return a.sort - b.sort; });
          if (S.current.project.status === "collecting") S.current.project.status = "draft";
          var wasDirty = S.dirty;
          if (!wasDirty) renderEditor(); else { refreshMediaGrid(); renderUploads(); }
        }
        announce("הקובץ " + u.file.name + " הועלה.");
      }).catch(function (e) {
        u.state = "error"; u.error = e.he || "ההעלאה נכשלה";
        renderUploads();
      }).then(pump);
    });
    renderUploads();
  }
  function resumeKey(u) { return "mrp_pj_up:" + u.projectId + ":" + u.file.name + ":" + u.file.size + ":" + (u.file.lastModified || 0); }
  function tus(path, blob, contentType, onProgress) {
    return token().then(function (t) {
      return S.MC.tusUpload({ endpoint: S.url + "/storage/v1/upload/resumable", accessToken: t, apikey: S.key, bucket: "project-originals",
        path: path, file: blob, contentType: contentType, onProgress: onProgress, upsert: false });
    });
  }
  function uploadOne(u) {
    var pid = u.projectId, key = resumeKey(u), saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) {}
    var sort = (S.current && S.current.project.id === pid ? S.current.media.reduce(function (mx, m) { return Math.max(mx, m.sort || 0); }, -1) : -1) + u.id;
    var progress = function (f) { u.progress = f; u.state = "uploading"; renderUploads(); };
    var remember = function (o) { try { localStorage.setItem(key, JSON.stringify(o)); } catch (e) {} };
    var forget = function () { try { localStorage.removeItem(key); } catch (e) {} };
    var slot = function (contentType, bytes) {
      return api("create-upload", { project_id: pid, kind: /^video/.test(contentType) ? "video" : "image", content_type: contentType, bytes: bytes });
    };
    var done = function (body) {
      u.state = "processing"; renderUploads();
      return api("process", Object.assign({ project_id: pid, sort: sort }, body)).then(function (r) { forget(); return r.media; }, function (e) {
        if (e.code === "upload_missing") forget();
        throw e;
      });
    };
    if (u.kind === "video") {
      var type = /\.mov$/i.test(u.file.name) || u.file.type === "video/quicktime" ? "video/quicktime" : "video/mp4";
      return S.MC.readVideoInfo(u.file).catch(function () { return null; }).then(function (info) {
        if (info && isFinite(info.duration) && (info.duration < 3 || info.duration > 900)) throw { he: "סרטון צריך להיות בין 3 שניות ל-15 דקות." };
        if (saved && saved.path) return saved;
        return S.MC.captureVideoFrame(u.file).then(function (frame) {
          return slot("image/jpeg", frame.blob.size).then(function (c) { return tus(c.path, frame.blob, "image/jpeg").then(function () { return c.path; }); });
        }).catch(function () { return null; }).then(function (coverPath) {
          return slot(type, u.file.size).then(function (v) { var o = { path: v.path, cover: coverPath }; remember(o); return o; });
        });
      }).then(function (o) {
        return tus(o.path, u.file, type, progress).then(function () { return done({ path: o.path, cover_path: o.cover || undefined, role: "video" }); });
      });
    }
    return S.MC.prepareImage(u.file).then(function (img) {
      u.state = "uploading"; renderUploads();
      var go = saved && saved.path ? Promise.resolve(saved) : slot("image/jpeg", img.blob.size).then(function (c) { var o = { path: c.path }; remember(o); return o; });
      return go.then(function (o) { return tus(o.path, img.blob, "image/jpeg", progress).then(function () { return done({ path: o.path }); }); });
    });
  }
  function refreshMediaGrid() {
    var grid = $("#pjMedia");
    if (grid) grid.innerHTML = S.current.media.map(function (m, i) { return mediaCard(m, i, S.current.media); }).join("");
  }

  /* ------------------------------------------------------------------ media actions */
  function mediaAction(act, id) {
    var media = S.current.media, i = media.findIndex(function (m) { return m.id === id; }), m = media[i];
    if (!m) return;
    if (act === "up" || act === "down") {
      var j = act === "up" ? i - 1 : i + 1, o = media[j];
      if (!o) return;
      // normalize sort to positions first (uploads may share a sort), then swap the two
      var ops = media.map(function (x, k) { return x.sort === k ? null : updateMedia(x.id, { sort: k }); }).filter(Boolean);
      return Promise.all(ops).then(function () { return Promise.all([updateMedia(m.id, { sort: j }), updateMedia(o.id, { sort: i })]); }).then(function () {
        S.current.media.sort(function (a, b) { return a.sort - b.sort; });
        refreshMediaGrid();
        var btn = $('[data-media="' + id + '"] [data-act="' + act + '"]'); if (btn && !btn.disabled) btn.focus();
        toast("הסדר עודכן ✓");
      }).catch(function (e) { toast(e.he, true); });
    }
    if (act === "cover") {
      return db(S.sb.from("projects").update({ cover_media_id: id }).eq("id", S.current.project.id).select(), "העדכון נכשל.").then(function (rows) {
        if (rows && rows[0]) S.current.project.cover_media_id = rows[0].cover_media_id;
        refreshMediaGrid(); toast("תמונת השער עודכנה ⭐");
      }).catch(function (e) { toast(e.he, true); });
    }
    if (act === "swap") {
      var partner = media.filter(function (o) { return o !== m && o.pair_no === m.pair_no && (o.role === "before" || o.role === "after"); })[0];
      if (!partner) return;
      return Promise.all([updateMedia(m.id, { role: partner.role }), updateMedia(partner.id, { role: m.role })]).then(function () {
        refreshMediaGrid(); toast("לפני ↔ אחרי הוחלפו ✓");
      }).catch(function (e) { toast(e.he, true); });
    }
    if (act === "ack") {
      return updateMedia(id, { flags_ack_at: new Date().toISOString() }).then(function () { refreshAfterMediaChange(); toast("סומן כנבדק ✓"); }).catch(function (e) { toast(e.he, true); });
    }
    if (act === "delete" || act === "remove") {
      if (!confirm("למחוק את הקובץ הזה מהפרויקט? הוא יימחק גם מהאחסון.")) return;
      return api("delete", { media_id: id }).then(function () {
        S.current.media = S.current.media.filter(function (o) { return o.id !== id; });
        if (S.current.project.cover_media_id === id) S.current.project.cover_media_id = null;
        refreshAfterMediaChange(); toast("הקובץ נמחק");
      }).catch(function (e) { toast(e.he, true); });
    }
  }
  function refreshAfterMediaChange() { if (S.dirty) refreshMediaGrid(); else renderEditor(); }

  /* ------------------------------------------------------------------ AI */
  function runAi(kind, text) {
    var btns = $all("#pjAnalyze, #pjCorrect, #pjShorter");
    btns.forEach(function (b) { b.disabled = true; });
    var busy = kind === "analyze" ? "✨ מנתח את התמונות… (עד דקה)" : "מתקן…";
    toast(busy);
    var before = S.dirty ? saveProject(true) : Promise.resolve();
    return before.then(function () {
      return api(kind, kind === "analyze" ? { project_id: S.current.project.id, text: text || "" } : { project_id: S.current.project.id, text: text });
    }).then(function (r) {
      return loadProject(S.current.project.id).then(function () {
        renderEditor();
        var w = (r.analysis && r.analysis.warnings) || [];
        toast(w.indexOf("caption_not_changed") !== -1 ? WARN_HE.caption_not_changed : kind === "analyze" ? "הניתוח הושלם ✓ בדקו ועדכנו לפי הצורך" : "עודכן ✓", w.indexOf("caption_not_changed") !== -1);
      });
    }).catch(function (e) {
      toast((e && e.he) || "הניתוח נכשל. נסו שוב.", true);
      btns.forEach(function (b) { b.disabled = false; });
    });
  }

  /* ------------------------------------------------------------------ delete project */
  function deleteProject() {
    var p = S.current.project;
    var msg = "למחוק את הפרויקט \"" + (p.title_he || "ללא כותרת") + "\" ואת כל " + S.current.media.length + " הקבצים שלו?\n\n" +
      "• לא ניתן לשחזר.\n• פוסטים שכבר עלו לאינסטגרם לא נמחקים אוטומטית — צריך למחוק אותם ידנית באפליקציה.\n• פוסטים שעוד לא פורסמו יבוטלו.";
    if (!confirm(msg)) return;
    var btn = $("#pjDelete"); if (btn) btn.disabled = true;
    api("delete-project", { project_id: p.id }).then(function (r) {
      S.list = S.list.filter(function (x) { return x.id !== p.id; });
      delete S.media[p.id];
      S.current = null;
      renderList();
      toast("הפרויקט נמחק (" + r.files + " קבצים)");
      if (r.instagram_posts) alert("שימו לב: " + r.instagram_posts + " פוסטים של הפרויקט כבר פורסמו באינסטגרם. צריך למחוק אותם ידנית באפליקציה.");
    }).catch(function (e) { toast(e.he, true); if (btn) btn.disabled = false; });
  }

  /* ------------------------------------------------------------------ events */
  function bind() {
    var root = S.root;
    root.addEventListener("click", function (e) {
      var t = e.target.closest("button, [data-open]");
      if (!t || !root.contains(t)) return;
      if (t.hasAttribute("data-open")) return openProject(t.getAttribute("data-open"));
      if (t.id === "pjNew") return createProject();
      if (t.id === "pjBack") {
        if (S.dirty && !confirm("יש שינויים שלא נשמרו. לצאת בלי לשמור?")) return;
        S.current = null; S.dirty = false; return refreshList();
      }
      if (t.id === "pjSave") return saveProject().catch(function () {});
      if (t.id === "pjDelete") return deleteProject();
      if (t.id === "pjSocialGo") return approveSocial();
      if (t.id === "pjAnalyze") {
        var hasText = S.current.project.title_he || (S.current.project.ai_meta || {}).caption_he;
        if (hasText && !confirm("הניתוח יחליף את הכותרת, התיאורים והכיתוב הקיימים. להמשיך?")) return;
        return runAi("analyze", $("#pjAiText").value.trim());
      }
      if (t.id === "pjCorrect") { var c = $("#pjCorrText").value.trim(); if (!c) return toast("כתבו מה לתקן.", true); return runAi("correct", c); }
      if (t.id === "pjShorter") return runAi("correct", "תקצר את הכיתוב");
      if (t.hasAttribute("data-dest")) { t.setAttribute("aria-pressed", t.getAttribute("aria-pressed") === "true" ? "false" : "true"); return setDirty(true); }
      if (t.hasAttribute("data-retry")) {
        var u = S.uploads.filter(function (x) { return String(x.id) === t.getAttribute("data-retry"); })[0];
        if (u) { u.state = "queued"; u.error = null; pump(); }
        return;
      }
      var act = t.getAttribute("data-act"), card = t.closest("[data-media]");
      if (act && card) return mediaAction(act, card.getAttribute("data-media"));
    });
    root.addEventListener("input", function (e) {
      if (e.target.id === "pjSearch") { S.filter.q = e.target.value; var pos = e.target.selectionStart; renderList(); var s = $("#pjSearch"); s.focus(); try { s.setSelectionRange(pos, pos); } catch (x) {} return; }
      // "מה עשינו?" isn't project data (it isn't saved), but it must survive a re-render (realtime, an upload finishing)
      if (e.target.id === "pjAiText" && S.current) { (S.aiDraft = S.aiDraft || {})[S.current.project.id] = e.target.value; return; }
      if (S.view === "editor" && !e.target.closest("[data-media]") && e.target.id !== "pjCorrText" && e.target.type !== "file") setDirty(true);
    });
    root.addEventListener("change", function (e) {
      var t = e.target;
      if (t.id === "pjService") { S.filter.service = t.value; return renderList(); }
      if (t.id === "pjFiles") { addFiles(t.files); t.value = ""; return; }
      if (t.name === "pjWhen") { var at = $("#pjWhenAt"); if (at) at.hidden = t.value !== "at"; setDirty(true); return updateWhenHint(); }
      if (t.id === "pjDate" || t.id === "pjTime") return updateWhenHint();
      var card = t.closest("[data-media]"), field = t.getAttribute("data-field");
      if (card && field) {
        var v = t.value;
        var patch = {};
        if (field === "pair_no") { var n = v === "" ? null : Number(v); if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 50)) { toast("מספר זוג בין 1 ל-50.", true); return; } patch.pair_no = n; }
        else if (field === "role") { patch.role = v || null; if (v === "detail") patch.pair_no = null; }
        else patch[field] = v.trim() || null;
        updateMedia(card.getAttribute("data-media"), patch).then(function () {
          if (field === "role") refreshMediaGrid();
          toast("נשמר ✓");
        }).catch(function (err) { toast(err.he, true); });
      }
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      root.addEventListener(ev, function (e) { var d = e.target.closest && e.target.closest("#pjDrop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
    });
    root.addEventListener("dragleave", function (e) { var d = e.target.closest && e.target.closest("#pjDrop"); if (d) d.classList.remove("over"); });
    root.addEventListener("drop", function (e) {
      var d = e.target.closest && e.target.closest("#pjDrop");
      if (!d) return;
      e.preventDefault(); d.classList.remove("over");
      addFiles(e.dataTransfer && e.dataTransfer.files);
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && S.view === "list") refreshList(); });
    window.addEventListener("beforeunload", function (e) {
      if (S.uploads.some(function (u) { return u.state === "uploading" || u.state === "processing" || u.state === "preparing"; })) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  function refreshList() {
    return loadList().then(renderList).catch(function (e) {
      S.root.innerHTML = '<div class="pj-empty">' + esc(e.he || "שגיאה בטעינה. נסו לרענן.") + "</div>" + chrome();
    });
  }
  var rtTimer = null;
  function onRealtime(payload) {
    clearTimeout(rtTimer);
    rtTimer = setTimeout(function () {
      if (S.view === "list") return refreshList();
      var row = (payload && (payload.new || payload.old)) || {};
      var pid = row.project_id || row.id;
      var busy = S.uploads.some(function (u) { return u.state !== "done" && u.state !== "error"; });
      if (S.current && pid === S.current.project.id && !S.dirty && !busy) loadProject(pid).then(renderEditor).catch(function () {});
    }, 700);
  }

  function init(opts) {
    if (S) { if (S.view === "list") refreshList(); return; }
    S = { sb: opts.sb, url: opts.supabaseUrl, key: opts.anonKey, root: opts.root, BS: window.MrpBurstSchedule, MC: window.MrpMediaClient,
      list: [], media: {}, filter: { q: "", service: "" }, current: null, uploads: [], view: "list", dirty: false, queued: [] };
    bind();
    opts.sb.auth.getUser().then(function (r) { S.userEmail = r && r.data && r.data.user && r.data.user.email || null; }).catch(function () {});
    try {
      S.channel = opts.sb.channel("projects-sync")
        .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, onRealtime)
        .on("postgres_changes", { event: "*", schema: "public", table: "project_media" }, onRealtime)
        .subscribe();
    } catch (e) { /* realtime is a bonus: the tab also refreshes on open / focus */ }
    S.root.innerHTML = '<div class="pj-empty">טוען פרויקטים…</div>';
    S.loading = refreshList();
    return S.loading;
  }
  function stop() { if (S && S.channel) { try { S.sb.removeChannel(S.channel); } catch (e) {} } }

  // "✅ העבודה בוצעה" in the quotes tab (command 7): a new project pre-filled with the quote's service +
  // city and linked to it (projects.quote_id) — or the quote's existing project. q: { id, number, service, city }.
  function newFromQuote(opts, q) {
    if (!S) init(opts);
    return (S.loading || Promise.resolve()).then(function () {
      return db(S.sb.from("projects").select("id").eq("quote_id", q.id).order("created_at", { ascending: false }).limit(1), "");
    }).then(function (found) {
      if (found && found[0]) { announce("לעבודה הזו כבר יש פרויקט — הוא נפתח."); return openProject(found[0].id); }
      return db(S.sb.from("projects").insert({ status: "collecting", source: "panel", quote_id: q.id, service: q.service || null, city: q.city || null,
        ai_meta: { from_quote: { number: q.number } } }).select(), "לא הצלחנו ליצור פרויקט. נסו שוב.").then(function (rows) {
        var p = rows && rows[0];
        S.list.unshift(p); S.media[p.id] = [];
        return openProject(p.id, { fresh: true });
      });
    }).catch(function (e) { toast(e.he || "שגיאה", true); });
  }

  window.MrpProjectsPanel = { init: init, stop: stop, newFromQuote: newFromQuote, _splitCaption: splitCaption };
})();
