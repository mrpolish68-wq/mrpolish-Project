/* =========================================================
   Mr. Polish (מיסטר פוליש) — main.js
   - Bilingual (HE/EN) switching with RTL/LTR + logical layout
   - Mobile navigation
   - Before/After comparison sliders
   - Lead form -> WhatsApp routing (no backend required yet)
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     SUPABASE — lead storage backend (REST API)
  --------------------------------------------------------- */
  var SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co/rest/v1/";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1tb2dua3hrZ2xrb3R6a3V4emx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNDMwOTIsImV4cCI6MjA5NzcxOTA5Mn0.dZlQnKYZWv2rod-22fYh8Ou20-F6Ic1VVqZhi1anyMA";

  /* ---------------------------------------------------------
     ANALYTICS — GA4 events + native Supabase counters
     - gaEvent(): sends a custom event to Google Analytics (gtag.js)
     - bumpMetric(): atomically increments a counter in Supabase via
       the increment_metric() RPC (fire-and-forget, never blocks UX)
  --------------------------------------------------------- */
  function gaEvent(name, params) {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  }
  function bumpMetric(metricName) {
    try {
      fetch(SUPABASE_URL + "rpc/increment_metric", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ metric_name: metricName }),
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* analytics is best-effort */ }
  }

  /* ---------------------------------------------------------
     0. PRELOADER / SPLASH SCREEN
     Plays preloader.mp4 once, then fades out + slides up to
     reveal the homepage. Robust against blocked autoplay via
     a safety timeout, so the site is never trapped behind it.
  --------------------------------------------------------- */
  (function initPreloader() {
    var pre = document.getElementById("preloader");
    if (!pre) return;

    var video = document.getElementById("preloaderVideo");
    var skip = document.getElementById("preloaderSkip");
    var done = false, started = false;
    var nameTimer, revealTimer, safetyTimer;

    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Lock scroll while the splash is visible.
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function showName() { pre.classList.add("show-name"); }

    function hide() {
      if (done) return;
      done = true;
      clearTimeout(nameTimer);
      clearTimeout(revealTimer);
      clearTimeout(safetyTimer);

      pre.classList.add("is-hidden");        // opacity 0 + slide up (0.8s)
      document.body.style.overflow = prevOverflow;

      // Fully remove from layout after the transition completes.
      var cleanup = function () {
        pre.style.display = "none";
        pre.setAttribute("aria-hidden", "true");
        if (video) { try { video.pause(); } catch (e) {} }
      };
      pre.addEventListener("transitionend", function te(ev) {
        if (ev.target === pre && (ev.propertyName === "transform" || ev.propertyName === "opacity")) {
          pre.removeEventListener("transitionend", te);
          cleanup();
        }
      });
      setTimeout(cleanup, 1100); // safety if transitionend never fires
    }

    // The master timeline: name fades in at 3s, full reveal at 5s.
    function startClock() {
      if (started) return;
      started = true;
      if (reduce) { showName(); revealTimer = setTimeout(hide, 1200); return; }
      nameTimer = setTimeout(showName, 3000);
      revealTimer = setTimeout(hide, 5000);
    }

    if (video) {
      video.muted = true; // required for reliable autoplay

      // Prefer the video's own clock for the name cue (machine exits ~3s).
      video.addEventListener("timeupdate", function () {
        if (video.currentTime >= 3) showName();
      });
      video.addEventListener("playing", startClock, { once: true });
      video.addEventListener("error", startClock, { once: true });

      var p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(function () { startClock(); }); // autoplay blocked -> still run timeline
      }
    }

    // Start the timeline even if media events are flaky.
    setTimeout(startClock, 400);

    // Skip button — dismiss immediately.
    if (skip) skip.addEventListener("click", hide);

    // Ultimate safety net: never trap the visitor behind the splash.
    safetyTimer = setTimeout(hide, 7000);
  })();

  /* ---------------------------------------------------------
     1. i18n DICTIONARY
     Hebrew lives in the HTML (default). English is applied
     by swapping innerHTML on [data-i18n] nodes.
  --------------------------------------------------------- */
  var EN = {
    preloader_skip: "Skip ›",
    skip: "Skip to main content",
    nav_services: "Services",
    nav_gallery: "Before &amp; After",
    nav_about: "About",
    nav_faq: "FAQ",
    nav_blog: "Blog &amp; Guides",
    nav_reviews: "Reviews",
    nav_contact: "Contact",
    header_call: "052-9534540",

    blog_eyebrow: "Knowledge Center",
    blog_title: "Blog &amp; Guides",
    blog_sub: "Professional tips and guides on floor polishing, marble &amp; stone restoration and floor care — from Uri Margalit, a 30-year expert.",

    hero_badge: "Years of experience",
    hero_title: "Your floors will shine like new",
    hero_sub: "Professional polishing and restoration of tiles, stone, marble and concrete. Crystalline shine and sealer protection — with the precision and reliability of a 30-year expert.",
    hero_call: "Call now: 052-9534540",
    hero_whatsapp: "Send a WhatsApp message",
    trust_quote: "Free, no-obligation quote",
    trust_nationwide: "Full Nationwide Service",
    trust_clean: "Clean work &amp; full warranty",

    services_eyebrow: "What we do",
    services_title: "Our professional services",
    services_intro: "End-to-end solutions for every floor and surface — in private homes, offices and commercial projects.",
    srv1_title: "Floor Polishing &amp; Restoration",
    srv1_text: "Thorough polishing for all tile types — removing deep scratches, stubborn stains and years of wear to restore the original look.",
    srv2_title: "Crystal Polishing (Premium)",
    srv2_text: "A luxurious crystalline shine that gives the floor a deep, wet-look finish that lasts, while protecting against wear.",
    srv3_title: "Marble &amp; Natural Stone Polishing",
    srv3_text: "Artistic treatment of marble and natural stone: opening seams, filling with color-matched stone adhesive and renewing the original texture.",
    srv4_title: "Concrete Polishing &amp; Smoothing",
    srv4_text: "Smoothing concrete with varied diamond grits to create a flat, strong, modern surface with a premium industrial look.",
    srv5_title: "Stamped Concrete / Bomanite",
    srv5_text: "Deep cleaning and renewal of the color and stamp of Bomanite surfaces, restoring the rich, impressive look of decorative concrete.",
    srv6_title: "Stairs &amp; Window Sills Polishing",
    srv6_text: "Precise, complex work with dedicated handheld machines to renew and level stairs, skirting and window sills in stone or marble.",
    srv7_title: "Terrazzo Restoration",
    srv7_text: "Reviving classic terrazzo (sumsum) floors by polishing the top layer, opening the pores and sealing them perfectly.",
    srv8_title: "Granolit Cleaning &amp; Refresh",
    srv8_text: "High-pressure washing that removes soot, moss and stubborn grime from outdoor granolit surfaces, including future protection.",
    srv9_title: "Grout Replacement &amp; Ceramic Scrubbing",
    srv9_text: "Aggressive cleaning of ceramic and porcelain tiles, opening old grout lines and replacing them with new sealed grout.",
    srv10_title: "Protective Sealer Application",
    srv10_text: "Applying an advanced hydrophobic protective layer that seals the floor against absorption of liquids, oils, stains and dirt.",
    srv11_title: "Post-Construction Deep Cleaning",
    srv11_text: "A premium service for new or renovated homes — removing paint, cement and construction residue and bringing the home to a sparkling state.",
    srvcta_title: "Not sure what you need?",
    srvcta_text: "We'll be glad to come over, inspect the surface and recommend the best solution for you.",
    srvcta_btn: "Request Inspection",
    opt_floor: "Floor polishing &amp; restoration",
    opt_crystal: "Crystal polish &amp; shine",
    opt_marble: "Marble &amp; natural stone polishing",
    opt_concrete: "Concrete / Bomanite polishing",
    opt_stairs: "Stairs / terrazzo / granolit renewal",
    opt_sealer: "Protective sealer application",

    flagship_eyebrow: "Flagship services",
    flagship_title: "The expertise we're proudest of",
    flagship_intro: "Our three most requested services, performed personally by Uri Margalit.",
    fcard1_title: "Crystal Polish",
    fcard1_desc: "A luxurious crystalline shine using advanced technology — a brilliant, mirror-like finish with lasting durability and maximum protection.",
    fcard2_title: "Stone &amp; Marble Restoration",
    fcard2_desc: "Deep renewal of old floors: removing scratches, reopening grout lines and filling with stone adhesive in the exact shade of your floor.",
    fcard3_title: "Sealer &amp; Stain Protection",
    fcard3_desc: "Top-grade sealing and protective coatings that prevent absorption of liquids, oils and stubborn stains on floors and natural stone.",
    fcard_cta: "Details &amp; free quote",

    testi_eyebrow: "Client reviews",
    testi_title: "What our clients say",
    testi1_quote: "\"Courteous service, professional-level work. Everything we agreed on was carried out to my satisfaction. Well done on the order and cleanliness, and the courteous attitude. Well done!\"",
    testi1_author: "- <bdi>HaKollel HaSameach</bdi> · <bdi>June 12, 2019</bdi>",
    testi2_quote: "\"Excellent! From experience — a professional company with honest people.\"",
    testi2_author: "- <bdi>David Halfon</bdi> · <bdi>August 26, 2018</bdi>",
    testi3_quote: "\"When you look at our marble floor, you can't help but see the people behind the work... What an amazing family the Margalit family is: professionals, honest, pleasant, and above all responsible. Even though the polishing process isn't much fun, the pleasantness of their work makes it a different experience. And the result is truly perfect, just as they promised!\"",
    testi3_author: "- <bdi>Lini Zar</bdi> · <bdi>November 22, 2016</bdi>",
    testi4_quote: "\"David and Uri did polishing and sealer work for us. Professional work and excellent service.\"",
    testi4_author: "- <bdi>Yael Olsher Azar</bdi> · <bdi>August 27, 2018</bdi>",
    testi5_quote: "\"Their amazing work can't be found anywhere else! With courtesy, with a smile, with incredible professionalism and stunning results!\"",
    testi5_author: "- <bdi>Seli Sasi</bdi> · <bdi>November 15, 2016</bdi>",
    testi6_quote: "\"Excellent work by a professional team that works from the heart — amazing people! Thank you so much for everything!\"",
    testi6_author: "- <bdi>Ben Atia</bdi> · <bdi>July 22, 2016</bdi>",
    reviews_cta: "Read all reviews &amp; write a review on Google 🌟",
    reviews_write_cta: "Write a review ✍️",
    review_modal_title: "Write a review",
    review_modal_sub: "We'd love to hear about your experience. Your review will be published on the site after approval.",
    review_submit: "Submit review",
    review_success_title: "Thank you!",
    review_success_msg: "Your review was saved successfully! We'd be thrilled if you could copy it and share it on our Google Maps page too, to help us grow.",
    review_success_cta: "Share your review on Google Maps 🌟",
    review_success_dismiss: "Close",

    compare_eyebrow: "See the difference",
    compare_title: "Before &amp; After",
    compare_intro: "Drag the handle to reveal the result.",

    faqtabs_eyebrow: "Got questions?",
    faqtabs_title: "Questions &amp; Answers",
    faqtabs_intro: "Everything worth knowing before we start.",
    faqcat_process: "Process &amp; Service",
    faqcat_pricing: "Pricing &amp; Booking",
    faq_p_q1: "Does the honing process create dust and dirt inside the house?",
    faq_p_a1: "Yes, the polishing process does create dust and dirt, and the amount varies directly depending on the required work (for example, stages like groove cutting or working on dry areas and baseboards can generate a significant amount of dust). However, we act responsibly and perform strict preparation to protect the house: we integrate water into the work to reduce dust dispersion as much as possible, move portable furniture away, and tightly wrap all non-movable furniture and items in protective nylon.",
    faq_p_q2: "What's the difference between crystal polish and wax polish?",
    faq_p_a2: "Wax polish is an external, temporary protective layer that gives the floor shine, but its durability is limited — lasting only about 3 months. Crystal polish, by contrast, is a deep process in which the material is driven directly into the stone using steel wool. It delivers a deep shine and lasts between one year and a year and a half, provided the maintenance guidelines are followed (strictly avoiding washing with bleach or harsh cleaning agents).",
    faq_p_q3: "Do I need to clear all the furniture out before you arrive?",
    faq_p_a3: "Please clear light furniture and decorative items from the area to be treated. For heavy, complex furniture that can't be removed from the space (such as large cabinets or massive sofas), we prepare in advance and wrap them thoroughly in dedicated protective nylon — protecting them from damage and completely preventing dust from getting in — while maneuvering around them professionally and safely.",
    faq_pr_q1: "How long after the polish can I walk on the floor?",
    faq_pr_a1: "After crystal polish or regular honing, you can walk on the floor immediately. If a sealer layer (sealing and protection) is applied, we recommend waiting one to two hours for full drying before normal foot traffic.",
    faq_pr_q2: "How often should a floor be renewed or polished?",
    faq_pr_a2: "In standard residential apartments, a high-quality crystal polish stays at its best for up to one year to a year and a half. The exact duration depends on the level of wear and the floor's daily washing method; we always recommend using dedicated products that preserve the shine and protection over time.",

    ba_before: "Before",
    ba_after: "After",

    about_eyebrow: "Who is behind Mr. Polish",
    about_title: "Uri Margalit – Your Polishing &amp; Crystal-Shine Expert",
    about_p1: "With over 30 years of experience and an uncompromising reputation, Mr. Polish — led by Uri Margalit — leads the field of floor renewal, polishing and restoration in Israel.",
    about_hl1: "<strong>Comprehensive expertise:</strong> advanced solutions for every type of surface — from artistic diamond polishing of marble and natural stone, through luxurious crystal polish, to concrete smoothing.",
    about_hl2: "<strong>Uncompromising finish:</strong> attention to the smallest details and meticulous polishing to reach the most flawless shine — a true \"mirror effect\" that completely transforms your space.",
    about_hl3: "<strong>Service standard:</strong> meticulous attention to clean work, strict adherence to schedules and a personal touch for every client. To us, your floor is a work of art.",
    about_years: "years of expertise",
    about_btn: "Talk to us",

    contact_eyebrow: "Let's begin",
    contact_title: "Get a personalized quote",
    contact_intro: "Leave your details and we'll get back to you shortly, or contact us directly. Consultation and inspection with no obligation.",
    contact_wa: "WhatsApp: 052-9534540",
    contact_area: "Full Nationwide Service ✔",
    form_name: "Full name",
    form_phone: "Phone",
    form_location: "City / Town",
    form_service: "Service type",
    form_service_other: "Other / Not sure",
    form_message: "Additional details (optional)",
    form_consent: "I agree to be contacted and accept the <a href=\"privacy.html\" target=\"_blank\">privacy policy</a>.",
    form_submit: "Send request &amp; I'll get back to you 🌟",


    footer_about: "Mr. Polish — Uri Margalit. Polishing and restoration of tiles, stone, marble and concrete with 30 years of experience.",
    footer_nav: "Navigation",
    footer_legal: "Info &amp; Terms",
    footer_privacy: "Privacy Policy",
    footer_terms: "Terms of Use",
    footer_a11y: "Accessibility Statement",
    footer_contact: "Contact",
    footer_wa: "WhatsApp",
    footer_rights: "All rights reserved.",
    bar_call: "Call now",
    bar_wa: "WhatsApp",
    bar_waze: "Waze"
  };

  // Snapshot the original Hebrew so we can switch back without reload.
  var nodes = document.querySelectorAll("[data-i18n]");
  var HE = {};
  nodes.forEach(function (el) {
    var key = el.getAttribute("data-i18n");
    if (!(key in HE)) HE[key] = el.innerHTML;
  });

  function applyLang(lang) {
    var dict = lang === "en" ? EN : HE;
    // Re-query live so dynamically-cloned nodes (e.g. marquee cards) translate too.
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] != null) el.innerHTML = dict[key];
    });

    var html = document.documentElement;
    html.lang = lang;
    html.dir = lang === "en" ? "ltr" : "rtl";

    var btn = document.getElementById("langSwitch");
    if (btn) {
      btn.textContent = lang === "en" ? "עב" : "EN";
      btn.setAttribute("aria-label", lang === "en" ? "החלף שפה לעברית" : "Switch language to English");
    }
    try { localStorage.setItem("mrp_lang", lang); } catch (e) {}
  }

  var langBtn = document.getElementById("langSwitch");
  if (langBtn) {
    langBtn.addEventListener("click", function () {
      var next = document.documentElement.lang === "en" ? "he" : "en";
      applyLang(next);
    });
  }
  // Restore saved preference
  try {
    var saved = localStorage.getItem("mrp_lang");
    if (saved === "en") applyLang("en");
  } catch (e) {}

  /* ---------------------------------------------------------
     2. MOBILE NAVIGATION
  --------------------------------------------------------- */
  var navToggle = document.getElementById("navToggle");
  var mobileMenu = document.getElementById("mobileMenu");
  if (navToggle && mobileMenu) {
    navToggle.addEventListener("click", function () {
      var open = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!open));
      navToggle.setAttribute("aria-label", open ? "פתח תפריט" : "סגור תפריט");
      mobileMenu.hidden = open;
    });
    mobileMenu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        navToggle.setAttribute("aria-expanded", "false");
        mobileMenu.hidden = true;
      });
    });
  }

  /* ---------------------------------------------------------
     3. LEAD FORM -> WhatsApp routing
     Until the backend/admin panel exists, a validated lead is
     delivered straight to Uri's WhatsApp with prefilled text.
  --------------------------------------------------------- */
  var form = document.getElementById("leadForm");
  var status = document.getElementById("formStatus");
  var PHONE_INTL = "972529534540";

  function t(en, he) {
    return document.documentElement.lang === "en" ? en : he;
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!status) return;
      status.className = "form-status";

      // Honeypot — bots fill hidden fields.
      if (form.company && form.company.value) return;

      if (!form.checkValidity()) {
        status.textContent = t("Please fill in the required fields.", "אנא מלאו את שדות החובה.");
        status.classList.add("err");
        form.reportValidity();
        return;
      }

      var name = form.name.value.trim();
      var phone = form.phone.value.trim();
      var location = form.location.value.trim();
      var service = form.service.value;
      var message = form.message.value.trim();

      // Build the prefilled WhatsApp message up-front.
      var waText = "היי אורי, שלחתי עכשיו פנייה באתר לגבי " + service +
        ". השם שלי הוא " + name + " והטלפון שלי הוא " + phone +
        (location ? " (" + location + ")" : "") + ". " + message;
      var waUrl = "https://wa.me/" + PHONE_INTL + "?text=" + encodeURIComponent(waText.trim());

      // 1) FOREGROUND WHATSAPP — open synchronously, as the very first action
      //    inside the submit gesture, to maximize the chance of bypassing
      //    popup blockers. Detect whether the tab was actually opened.
      var waWin = window.open(waUrl, "_blank");
      if (waWin) { try { waWin.opener = null; } catch (e) {} } // sever opener (manual noopener)

      // Persist the link so the thank-you page can offer a one-tap fallback —
      // this guarantees the user can still reach WhatsApp if the popup was blocked.
      try {
        sessionStorage.setItem("mrp_wa_url", waUrl);
        sessionStorage.setItem("mrp_wa_blocked", waWin ? "0" : "1");
      } catch (e) {}

      // 2) BACKGROUND DB — store the lead in the Supabase "leads" table.
      //    Fire-and-forget so it never blocks the redirect below.
      fetch(SUPABASE_URL + "leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + SUPABASE_ANON_KEY,
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          name: name,
          phone: phone,
          location: location,
          service: service,
          notes: message
        })
      }).catch(function () { /* DB write is best-effort; WhatsApp is the primary delivery */ });

      // Marketing analytics: a validated lead is a successful submission.
      gaEvent("form_submission", { service: service, location: location || undefined });

      // 3) UX — confirm, clear the fields, then land on the thank-you page
      //    (Google Ads conversion anchor + WhatsApp fallback button).
      status.textContent = t("Thanks! Redirecting…", "תודה! מעבירים אתכם…");
      status.classList.add("ok");
      form.reset();

      setTimeout(function () { window.location.href = "thankyou.html"; }, 400);
    });
  }

  /* ---------------------------------------------------------
     5. SCROLL-ENTRANCE ANIMATIONS
     Elements tagged .reveal fade/slide in once they enter view.
     Hidden state is gated by .js in CSS, so this only ever
     reveals (never hides) content for users without JS.
  --------------------------------------------------------- */
  var revealEls = document.querySelectorAll(".reveal");
  if (revealEls.length) {
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("active");
            obs.unobserve(entry.target); // reveal once, then stop watching
          }
        });
      }, { threshold: 0.15 }); // fire when ~15% of the element is in view
      revealEls.forEach(function (el) { io.observe(el); });
    } else {
      // No IntersectionObserver -> just show everything.
      revealEls.forEach(function (el) { el.classList.add("active"); });
    }
  }

  /* ---------------------------------------------------------
     6. FAQ TABS + ACCORDION (tabbed FAQ section)
  --------------------------------------------------------- */
  (function initFaqTabs() {
    var root = document.getElementById("faq-tabs");
    if (!root) return;

    // Category tabs
    var tabs = Array.prototype.slice.call(root.querySelectorAll(".faq-tab"));
    var panels = Array.prototype.slice.call(root.querySelectorAll(".faq-panel"));

    function selectTab(tab) {
      tabs.forEach(function (t) {
        var active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", String(active));
      });
      panels.forEach(function (p) {
        var active = p.id === tab.getAttribute("aria-controls");
        p.classList.toggle("is-active", active);
        p.hidden = !active;
      });
    }
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () { selectTab(tab); });
    });

    // Accordion questions (independent toggle)
    root.querySelectorAll(".faq-acc__q").forEach(function (q) {
      q.addEventListener("click", function () {
        var item = q.closest(".faq-acc__item");
        var open = item.classList.toggle("is-open");
        q.setAttribute("aria-expanded", String(open));
      });
    });
  })();

  /* ---------------------------------------------------------
     7. BEFORE / AFTER COMPARISON SLIDER
     Pointer events cover mouse + touch + pen. Drag the handle
     to scrub; tap/click anywhere jumps; arrows for keyboard.
  --------------------------------------------------------- */
  (function initCompare() {
    var w = document.getElementById("compareWidget");
    if (!w) return;
    var handle = w.querySelector(".compare__handle");
    var beforeImg = document.getElementById("cmpBeforeImg");
    var afterImg = document.getElementById("cmpAfterImg");
    var tabsEl = document.getElementById("galleryTabs");
    var dotsEl = document.getElementById("galleryDots");
    var dragging = false;

    /* ----- Project gallery configuration ----- */
    var G = "assets/gallery/";
    var PROJECTS = [
      { title: "אבן בזלת שחורה", angles: [
        { before: G + "project1-before1.jpeg", after: G + "project1-after1.jpeg" },
        { before: G + "project1-before2.jpeg", after: G + "project1-after2.jpeg" },
        { before: G + "project1-before3.jpeg", after: G + "project1-after3.jpeg" }
      ] },
      { title: "אבן ירושלמית", angles: [
        { before: G + "project2-before1.jpeg", after: G + "project2-after1.jpeg" },
        { before: G + "project2-before2.jpeg", after: G + "project2-after2.jpeg" }
      ] },
      { title: "רצפת טרצו", angles: [
        { before: G + "project3-before1.jpeg", after: G + "project3-after1.jpeg" }
      ] },
      { title: "חידוש מדרגות חלילה", angles: [
        { before: G + "project4-before1.jpeg", after: G + "project4-after1.jpeg" },
        { before: G + "project4-before2.jpeg", after: G + "project4-after2.jpeg" }
      ] },
      { title: "שיש קרמה - בית חולים מאיר", angles: [
        { before: G + "project5-before1.jpeg", after: G + "project5-after1.jpeg" }
      ] }
    ];
    var curProj = 0, curAngle = 0;

    /* ----- Slider position (drag/keyboard) ----- */
    function setPos(clientX) {
      var r = w.getBoundingClientRect();
      var p = ((clientX - r.left) / r.width) * 100;
      p = Math.max(0, Math.min(100, p));
      w.style.setProperty("--pos", p + "%");
      if (handle) handle.setAttribute("aria-valuenow", Math.round(p));
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      w.classList.remove("is-dragging");
    }

    /* ----- Dynamic image loading (graceful fallback to gradient) ----- */
    function loadImg(imgEl, src) {
      imgEl.style.display = "none"; // hide until confirmed loaded
      var probe = new Image();
      probe.onload = function () { imgEl.src = src; imgEl.style.display = ""; };
      probe.onerror = function () { imgEl.removeAttribute("src"); imgEl.style.display = "none"; };
      probe.src = src;
    }
    function loadPair(angle) {
      w.classList.add("is-swapping");          // fade out
      setTimeout(function () {
        loadImg(beforeImg, angle.before);
        loadImg(afterImg, angle.after);
        w.style.setProperty("--pos", "50%");   // reset divider on swap
        if (handle) handle.setAttribute("aria-valuenow", "50");
        requestAnimationFrame(function () { w.classList.remove("is-swapping"); }); // fade in
      }, 200);
    }

    /* ----- Lazy preloading (perf): warm a whole project's angles once ----- */
    var preloaded = {};
    function preloadProject(i) {
      if (preloaded[i]) return;     // each project fetched at most once
      preloaded[i] = true;
      PROJECTS[i].angles.forEach(function (a) {
        var b = new Image(); b.src = a.before;   // warms the browser cache only
        var f = new Image(); f.src = a.after;
      });
    }

    /* ----- Tabs & dots ----- */
    function renderDots(proj) {
      dotsEl.innerHTML = "";
      if (proj.angles.length <= 1) { dotsEl.style.display = "none"; return; }
      dotsEl.style.display = "flex";
      proj.angles.forEach(function (a, i) {
        var d = document.createElement("button");
        d.type = "button";
        d.className = "gallery-dot" + (i === curAngle ? " active" : "");
        d.setAttribute("aria-label", "זווית " + (i + 1));
        d.addEventListener("click", function () { selectAngle(i); });
        dotsEl.appendChild(d);
      });
    }
    function selectAngle(i) {
      curAngle = i;
      loadPair(PROJECTS[curProj].angles[i]);
      Array.prototype.forEach.call(dotsEl.children, function (d, idx) {
        d.classList.toggle("active", idx === i);
      });
    }
    function selectProject(i) {
      curProj = i; curAngle = 0;
      preloadProject(i); // ensure this project's images are fetched
      Array.prototype.forEach.call(tabsEl.children, function (t, idx) {
        var on = idx === i;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      renderDots(PROJECTS[i]);
      loadPair(PROJECTS[i].angles[0]);
    }
    function renderTabs() {
      PROJECTS.forEach(function (p, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "gallery-tab";
        b.setAttribute("role", "tab");
        b.textContent = p.title;
        b.addEventListener("click", function () { selectProject(i); });
        // Prefetch a deferred project's images on hover/touch/focus → instant swap on click
        b.addEventListener("pointerenter", function () { preloadProject(i); });
        b.addEventListener("focus", function () { preloadProject(i); });
        tabsEl.appendChild(b);
      });
    }

    /* ----- Drag starts on the handle (vertical page scroll stays free) ----- */
    if (handle) {
      handle.addEventListener("pointerdown", function (e) {
        dragging = true;
        w.classList.add("is-dragging");
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      handle.addEventListener("keydown", function (e) {
        var cur = parseFloat(w.style.getPropertyValue("--pos")) || 50;
        if (e.key === "ArrowLeft") cur = Math.max(0, cur - 2);
        else if (e.key === "ArrowRight") cur = Math.min(100, cur + 2);
        else if (e.key === "Home") cur = 0;
        else if (e.key === "End") cur = 100;
        else return;
        e.preventDefault();
        w.style.setProperty("--pos", cur + "%");
        handle.setAttribute("aria-valuenow", Math.round(cur));
      });
    }
    // Click/tap anywhere on the widget jumps the slider there
    w.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".compare__handle")) return;
      setPos(e.clientX);
    });
    window.addEventListener("pointermove", function (e) { if (dragging) setPos(e.clientX); });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    /* ----- Boot ----- */
    if (tabsEl && dotsEl && beforeImg && afterImg) {
      renderTabs();
      selectProject(0);
    }
  })();

  /* ---------------------------------------------------------
     8. QUICK SHARE (Web Share API → WhatsApp fallback)
  --------------------------------------------------------- */
  (function initShare() {
    var fab = document.getElementById("shareFab");
    if (!fab) return;
    var toast = document.getElementById("shareToast");
    var shareData = {
      title: "מיסטר פוליש",
      text: "היי, תראה את האתר הזה לפוליש, נראה לי ממש מקצועי לעסק/לבית שלנו!",
      url: "https://mr-polishes.com/"
    };
    function showToast(msg) {
      if (!toast) return;
      toast.textContent = msg;
      toast.classList.add("show");
      setTimeout(function () { toast.classList.remove("show"); }, 2600);
    }
    fab.addEventListener("click", function () {
      var full = shareData.text + " " + shareData.url;
      if (navigator.share) {
        navigator.share(shareData).catch(function () {});
      } else {
        window.open("https://wa.me/?text=" + encodeURIComponent(full), "_blank", "noopener");
        showToast("נפתח וואטסאפ לשיתוף 💬");
      }
    });
  })();

  /* ---------------------------------------------------------
     8b. TESTIMONIALS MARQUEE — seamless infinite loop
     Clones the base cards until one "half" is wider than the
     viewport, then duplicates that half so translateX(-50%)
     loops with zero gaps at any width. Constant speed via a
     width-based duration. Pause on hover / touch press-hold.
  --------------------------------------------------------- */
  var marqueeInited = false;
  function initMarquee() {
    if (marqueeInited) return;
    marqueeInited = true;

    var track = document.querySelector(".marquee__track");
    if (!track) return;
    var marquee = track.closest(".marquee");
    var base = Array.prototype.slice.call(track.children);
    if (!base.length) return;

    // Bulletproof: clone the base set a fixed number of times (no width math,
    // no race conditions). 4 sets of 6 cards = 24 cards; one "half" (2 sets =
    // 12 cards) easily overflows even a 4K screen, so translateX(-50%) is gapless.
    var REPEAT = 4; // MUST stay even so the two halves are identical
    track.innerHTML = "";
    var frag = document.createDocumentFragment();
    for (var i = 0; i < REPEAT; i++) {
      base.forEach(function (card) {
        var c = card.cloneNode(true);
        if (i > 0) c.setAttribute("aria-hidden", "true"); // keep one set for AT
        frag.appendChild(c);
      });
    }
    track.appendChild(frag);

    // Pause on touch press-hold (mouse hover handled in CSS)
    marquee.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse") marquee.classList.add("is-held");
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      marquee.addEventListener(ev, function () { marquee.classList.remove("is-held"); });
    });
  }

  /* ---------------------------------------------------------
     8c. DYNAMIC REVIEWS — fetch approved reviews from Supabase
     and prepend them to the static Facebook set, THEN build the
     marquee (so the clones include the fresh reviews). A network
     timeout guarantees the marquee still initialises if the fetch
     hangs or fails, so this can never trap the section empty.
  --------------------------------------------------------- */
  (function initDynamicReviews() {
    var track = document.querySelector(".marquee__track");
    if (!track) { initMarquee(); return; }

    // Build one .testi card from a Supabase review row. Everything is set via
    // textContent / DOM nodes (never innerHTML) so user input can't inject markup.
    function buildCard(r) {
      var fig = document.createElement("figure");
      fig.className = "testi";

      var stars = document.createElement("div");
      stars.className = "testi__stars";
      stars.setAttribute("role", "img");
      stars.setAttribute("aria-label", "5 מתוך 5 כוכבים");
      stars.textContent = "★★★★★";
      fig.appendChild(stars);

      var quote = document.createElement("blockquote");
      quote.className = "testi__quote";
      quote.textContent = '"' + String(r.review_text || "").trim() + '"';
      fig.appendChild(quote);

      var cap = document.createElement("figcaption");
      cap.className = "testi__author";
      cap.appendChild(document.createTextNode("- "));
      // Each segment is wrapped in <bdi> so mixed HE/EN names + dates never
      // scramble inside the RTL caption (same fix as the static cards).
      var parts = [r.first_last_name, r.job_type, r.job_date];
      var first = true;
      parts.forEach(function (val) {
        val = (val == null ? "" : String(val)).trim();
        if (!val) return;
        if (!first) cap.appendChild(document.createTextNode(" · "));
        var bdi = document.createElement("bdi");
        bdi.textContent = val;
        cap.appendChild(bdi);
        first = false;
      });
      fig.appendChild(cap);
      return fig;
    }

    function injectReviews(rows) {
      if (!rows || !rows.length) return;
      var frag = document.createDocumentFragment();
      rows.forEach(function (r) {
        if (r && r.review_text) frag.appendChild(buildCard(r));
      });
      // Prepend so the newest approved reviews lead the marquee.
      track.insertBefore(frag, track.firstChild);
    }

    // Abort the fetch after 4s so a hanging request never blocks the marquee.
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 4000);

    fetch(SUPABASE_URL + "reviews?approved=eq.true&order=created_at.desc", {
      method: "GET",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY
      },
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (rows) { injectReviews(rows); })
      .catch(function () { /* offline / blocked / timeout — static reviews still show */ })
      .then(function () { clearTimeout(timer); initMarquee(); });
  })();

  /* ---------------------------------------------------------
     8d. WRITE-A-REVIEW MODAL — opens a form, posts to Supabase
     ("reviews" table, approved=false by default), then shows a
     success state that nudges the user to also post on Google Maps.
  --------------------------------------------------------- */
  (function initReviewModal() {
    var modal = document.getElementById("reviewModal");
    var openBtn = document.getElementById("openReviewModal");
    if (!modal || !openBtn) return;

    var formState = document.getElementById("reviewFormState");
    var successState = document.getElementById("reviewSuccessState");
    var reviewForm = document.getElementById("reviewForm");
    var reviewStatus = document.getElementById("reviewStatus");
    var lastFocused = null;

    function openModal() {
      lastFocused = document.activeElement;
      // Always open on the form state (reset from any prior success view).
      if (formState) formState.hidden = false;
      if (successState) successState.hidden = true;
      modal.hidden = false;
      document.body.style.overflow = "hidden";
      var firstInput = modal.querySelector("input, textarea, button");
      if (firstInput) firstInput.focus();
      gaEvent("review_modal_open");
    }

    function closeModal() {
      modal.hidden = true;
      document.body.style.overflow = "";
      if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    }

    openBtn.addEventListener("click", openModal);

    modal.querySelectorAll("[data-review-close]").forEach(function (el) {
      el.addEventListener("click", closeModal);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) closeModal();
    });

    if (reviewForm) {
      reviewForm.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!reviewStatus) return;
        reviewStatus.className = "form-status";

        // Honeypot: silently drop bots that fill the hidden field.
        var hp = document.getElementById("rv-website");
        if (hp && hp.value) { return; }

        var payload = {
          first_last_name: (reviewForm.first_last_name.value || "").trim(),
          job_date: (reviewForm.job_date.value || "").trim(),
          job_type: (reviewForm.job_type.value || "").trim(),
          review_text: (reviewForm.review_text.value || "").trim()
        };

        if (!payload.first_last_name || !payload.review_text) {
          reviewStatus.textContent = t("Please fill in your name and review.", "נא למלא שם וכתיבת ביקורת.");
          reviewStatus.classList.add("err");
          return;
        }

        var submitBtn = reviewForm.querySelector("button[type=submit]");
        if (submitBtn) submitBtn.disabled = true;
        reviewStatus.textContent = t("Sending…", "שולח…");

        fetch(SUPABASE_URL + "reviews", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(payload)
        })
          .then(function (res) {
            if (!res.ok) throw new Error("bad status " + res.status);
            gaEvent("review_submit");
            reviewForm.reset();
            reviewStatus.textContent = "";
            // Swap to the success / Google Maps nudge state.
            if (formState) formState.hidden = true;
            if (successState) successState.hidden = false;
          })
          .catch(function () {
            reviewStatus.textContent = t(
              "Something went wrong. Please try again.",
              "משהו השתבש. אנא נסו שוב."
            );
            reviewStatus.classList.add("err");
          })
          .then(function () {
            if (submitBtn) submitBtn.disabled = false;
          });
      });
    }
  })();

  /* ---------------------------------------------------------
     9. STICKY HEADER — solid bar once scrolled (transparent at top)
  --------------------------------------------------------- */
  (function initHeaderScroll() {
    var header = document.querySelector(".site-header");
    if (!header) return;
    var onScroll = function () {
      header.classList.toggle("scrolled", window.scrollY > 40);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  })();

  /* ---------------------------------------------------------
     9c. ANALYTICS WIRING
     - Page view: native counter for the admin dashboard
       (GA4 already auto-tracks page_view via the gtag config tag).
     - WhatsApp click: GA4 event + native counter, on any wa.me link
       (hero CTA, contact info, footer, mobile action bar).
  --------------------------------------------------------- */
  bumpMetric("page_views");

  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest('a[href*="wa.me"]');
    if (!link) return;
    gaEvent("whatsapp_click");
    bumpMetric("whatsapp_clicks");
  });

  /* ---------------------------------------------------------
     10. MISC
  --------------------------------------------------------- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
})();
