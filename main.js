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
  // ?review=1 or #write-review opens the write-a-review modal on load (the WhatsApp review request
  // links here as the secondary option to Google — media-projects plan, decision D10).
  var OPEN_REVIEW_FROM_LINK = /[?&]review=1(&|$)/.test(location.search) || location.hash === "#write-review";
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

    // A review-request link (?review=1 / #write-review) goes straight to the review form (§8d):
    // no splash in front of it.
    if (OPEN_REVIEW_FROM_LINK) {
      if (pre.parentNode) pre.parentNode.removeChild(pre);
      return;
    }

    // Perf: show the intro splash at most ONCE per browser session. Every
    // subsequent navigation / return renders the real page immediately
    // (no overlay, no scroll-lock, no 2.9MB video request).
    try {
      if (sessionStorage.getItem("mrp_splash_seen")) {
        if (pre.parentNode) pre.parentNode.removeChild(pre);
        return;
      }
      sessionStorage.setItem("mrp_splash_seen", "1");
    } catch (e) { /* private mode / storage blocked: fall through, show once */ }

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
      if (reduce) { showName(); revealTimer = setTimeout(hide, 700); return; }
      nameTimer = setTimeout(showName, 500);
      revealTimer = setTimeout(hide, 2000);
    }

    if (video) {
      video.muted = true; // required for reliable autoplay

      // Attach the source now (first visit only — repeat visits already
      // returned above, so the video bytes are never requested for them).
      var source = video.querySelector("source");
      if (source && !source.getAttribute("src") && source.dataset.src) {
        source.setAttribute("src", source.dataset.src);
        video.load();
      }

      // Prefer the video's own clock for the name cue.
      video.addEventListener("timeupdate", function () {
        if (video.currentTime >= 0.5) showName();
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
    safetyTimer = setTimeout(hide, 3000);
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

    geo_answer_title: "What is crystal polish?",
    geo_answer_text: "Crystal polish is a shining process in which a crystalline compound is physically driven into the surface of stone or marble using steel wool and dedicated machines. Unlike external, temporary wax, it changes the surface itself: a deep \"mirror effect\" finish that lasts about a year to a year and a half and protects the floor from everyday wear.",
    geo_howto_title: "Steps of the crystal-polish process",
    geo_howto_s1: "<strong>Prepping and protecting the home</strong> - clearing light furniture and tightly wrapping anything that can't be moved in protective nylon.",
    geo_howto_s2: "<strong>Thorough cleaning of the surface</strong> - removing layers of dirt, old wax or previous coatings from the stone.",
    geo_howto_s3: "<strong>Initial honing (if needed)</strong> - diamond honing to remove deep scratches and level the surface.",
    geo_howto_s4: "<strong>Applying the crystal compound</strong> - driving the compound into the stone with steel wool and a honing machine, working with water to reduce dust.",
    geo_howto_s5: "<strong>Final polishing</strong> - buffing at a controlled pace and pressure until reaching an even, deep \"mirror effect\" finish.",
    geo_howto_s6: "<strong>Sealer application (optional)</strong> - an additional hydrophobic protective layer, with one to two hours of drying time.",

    polishcompare_eyebrow: "Frequently asked",
    polishcompare_title: "Crystal Polish vs. Wax Polish vs. Acrylic Polish",
    polishcompare_answer: "The three polish types differ mainly in how deep the treatment goes and how long it lasts: wax and acrylic are external, temporary coatings that wear off within a few months, while crystal polish is physically driven into the stone and delivers a deep shine that lasts a year to a year and a half. Mr. Polish specializes in crystal polish - the most professional and durable method for stone and marble.",
    polishcompare_caption: "Comparison of polish types for stone &amp; marble floors",
    pt_h_criterion: "Criterion",
    pt_h_crystal: "Crystal Polish",
    pt_h_wax: "Wax Polish",
    pt_h_acrylic: "Acrylic Polish",
    pt_r1_label: "Durability",
    pt_r1_crystal: "About a year to a year and a half",
    pt_r1_wax: "About 3 months",
    pt_r1_acrylic: "A few weeks to a few months",
    pt_r2_label: "How it works",
    pt_r2_crystal: "Physically penetrates the stone layer",
    pt_r2_wax: "External coating on the surface",
    pt_r2_acrylic: "Thin, glossy coating on the surface",
    pt_r3_label: "Finish",
    pt_r3_crystal: "Deep shine, \"mirror effect\"",
    pt_r3_wax: "Surface shine, can be slippery when wet",
    pt_r3_acrylic: "Bright shine, tends to yellow over time",
    pt_r4_label: "Best suited for",
    pt_r4_crystal: "Marble, terrazzo &amp; natural stone",
    pt_r4_wax: "Mainly basic residential flooring",
    pt_r4_acrylic: "Mainly commercial floors/vinyl",
    pt_r5_label: "Relative price range",
    pt_r5_crystal: "₪₪ (one-time investment for a long period)",
    pt_r5_wax: "₪ (cheap but needs frequent renewal)",
    pt_r5_acrylic: "₪ (cheap but needs frequent renewal)",
    pt_r6_label: "Performed by Mr. Polish",
    pt_r6_crystal: "✔ Our core service",
    pt_r6_wax: "—",
    pt_r6_acrylic: "—",

    pricing_answer_title: "How much does floor polishing cost?",
    pricing_answer_text: "There's no fixed price list - cost depends on the room or apartment's area, the type of stone/flooring, the floor's condition (thorough honing vs. a maintenance-only polish), and whether sealer protection is also requested. The table below gives a relative scale by size, but the exact price only comes from a free, in-person inspection.",

    pricing_caption: "Relative price range by room/apartment size",
    pr_h_size: "Surface size",
    pr_h_tier: "Relative price range",
    pr_h_note: "Note",
    pr_r1_size: "Single room / bathroom",
    pr_r1_tier: "₪",
    pr_r1_note: "Minimum order - worth combining with another space if possible",
    pr_r2_size: "3-4 room apartment",
    pr_r2_tier: "₪₪",
    pr_r2_note: "The most common project - priced by actual sqm",
    pr_r3_size: "5+ room apartment / villa",
    pr_r3_tier: "₪₪₪",
    pr_r3_note: "Usually includes a volume discount based on total area",
    pr_r4_size: "Office / commercial space",
    pr_r4_tier: "₪₪ - ₪₪₪",
    pr_r4_note: "Depends on area, floor type and after-hours work",
    pricing_disclaimer: "The final price depends on the exact area, stone type and floor condition. We don't publish a fixed price list - Uri comes to inspect the surface and gives you an <a href=\"#contact\">accurate, no-obligation quote</a>, usually the same day.",

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
    gallery_open_page: "Open the project page",

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
    faq_p_q4: "What is crystal polish?",
    faq_p_a4: "Crystal polish is a professional shining process in which a crystalline compound is physically driven into the surface of stone or marble using steel wool and dedicated honing machines, hardening and making it shine from within. Unlike wax or an external coating, this process changes the surface itself — the result is a deep \"mirror effect\" shine, high durability, and significantly slower wear over time.",
    faq_p_q5: "When is it worth polishing a floor?",
    faq_p_a5: "It's worth considering a polish when the original shine fades, surface scratches appear, water or grease stains won't come out with regular cleaning, or about a year to a year and a half has passed since the last polish. Also before selling a property, renting it out, or hosting an event — crystal polish is the fastest way to upgrade a home's first impression without ripping out any flooring.",
    faq_pr_q1: "How long after the polish can I walk on the floor?",
    faq_pr_a1: "After crystal polish or regular honing, you can walk on the floor immediately. If a sealer layer (sealing and protection) is applied, we recommend waiting one to two hours for full drying before normal foot traffic.",
    faq_pr_q2: "How often should a floor be renewed or polished?",
    faq_pr_a2: "In standard residential apartments, a high-quality crystal polish stays at its best for up to one year to a year and a half. The exact duration depends on the level of wear and the floor's daily washing method; we always recommend using dedicated products that preserve the shine and protection over time.",
    faq_pr_q3: "How much does floor polishing cost?",
    faq_pr_a3: "The cost depends on the room or apartment's area, the type of stone/flooring, the floor's current condition (whether it needs thorough honing or just a maintenance polish), and whether sealer protection is also requested. Since every home is different, we don't publish a fixed price list - Uri comes to inspect the surface in person and gives you an <a href=\"#contact\">accurate, no-obligation quote</a>, usually the same day.",

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
    form_privacy_consent: "I have read the <a href=\"privacy.html\" target=\"_blank\">privacy policy</a> and agree to the processing of my details to handle my request.",
    form_marketing_consent: "I agree to receive marketing content, offers and updates by phone, SMS or WhatsApp (I can opt out at any time).",
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
    social_follow: "Follow us",
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
    // dynamic sections (the project gallery) re-render their own texts
    try { document.dispatchEvent(new CustomEvent("mrp:lang", { detail: { lang: lang } })); } catch (e) {}
  }

  var langBtn = document.getElementById("langSwitch");
  if (langBtn) {
    langBtn.addEventListener("click", function () {
      var next = document.documentElement.lang === "en" ? "he" : "en";
      applyLang(next);
    });
  }
  // Restore saved preference; ?lang=en / ?lang=he (links from the project pages) wins.
  try {
    var qLang = (location.search.match(/[?&]lang=(en|he)\b/) || [])[1];
    var saved = qLang || localStorage.getItem("mrp_lang");
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
  var LEAD_MIN_WAIT_MS = 400;   // see the redirect at the end of the submit handler
  var LEAD_MAX_WAIT_MS = 3000;

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
      // Spam Law (Amendment 40): marketing consent is a separate, unchecked-
      // by-default checkbox — never bundled with the (required) privacy
      // consent above. Recorded here as an internal audit trail only; it's
      // never added to the customer-facing WhatsApp text below.
      var marketingConsent = !!(form.marketingConsent && form.marketingConsent.checked);
      var notesWithConsent = message +
        (message ? "\n" : "") +
        "[הסכמה לדיוור שיווקי: " + (marketingConsent ? "כן" : "לא") + "]";

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
      //    Fire-and-forget so it never blocks the redirect below, BUT still
      //    surfaced on failure (see the .then() below) — a bare .catch() on
      //    fetch() only catches network-level failures, never HTTP error
      //    responses like a 401 from Row-Level Security, so a rejected
      //    insert used to fail completely silently while the visitor saw
      //    "Thanks!" and the lead was never saved (found + fixed 2026-08-15).
      //    location/notes are sent as `null` (never "") when blank — the
      //    optional-field RLS check only accepts NULL or a real value.
      //    keepalive (2026-10-30): the redirect below used to fire 400 ms after
      //    submit and abort the in-flight insert (seen as net::ERR_ABORTED), so
      //    on a slow phone connection a lead could be lost. keepalive lets the
      //    request outlive the page; a browser that refuses keepalive here (it
      //    needs a CORS preflight) falls back to a normal fetch, and the
      //    redirect waits for the insert either way (see leadDone below).
      var leadBody = JSON.stringify({
        name: name,
        phone: phone,
        location: location || null,
        service: service,
        notes: notesWithConsent || null
      });
      function postLead(keepalive) {
        return fetch(SUPABASE_URL + "leads", {
          method: "POST",
          keepalive: keepalive,
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + SUPABASE_ANON_KEY,
            "Prefer": "return=minimal"
          },
          body: leadBody
        });
      }
      var leadDone = postLead(true).catch(function () { return postLead(false); }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (body) {
            console.error("Lead DB insert failed (" + res.status + "): " + body);
            gaEvent("lead_db_error", { status: res.status });
          });
        }
      }).catch(function (err) {
        // Real network failure (offline, DNS, etc.) — WhatsApp is still the
        // primary delivery path, but log it so it isn't completely invisible.
        console.error("Lead DB insert network error: " + err);
        gaEvent("lead_db_error", { status: "network" });
      });

      // Marketing analytics: a validated lead is a successful submission.
      gaEvent("form_submission", { service: service, location: location || undefined, marketing_consent: marketingConsent });

      // 3) UX — confirm, clear the fields, then land on the thank-you page
      //    (Google Ads conversion anchor + WhatsApp fallback button).
      status.textContent = t("Thanks! Redirecting…", "תודה! מעבירים אתכם…");
      status.classList.add("ok");
      form.reset();

      // Redirect once the insert has finished (at least LEAD_MIN_WAIT_MS so the
      // "thanks" note is seen), but never later than LEAD_MAX_WAIT_MS — keepalive
      // still carries a slower insert through the page change.
      var redirected = false;
      function goThanks() {
        if (redirected) return;
        redirected = true;
        window.location.href = "thankyou.html";
      }
      Promise.all([leadDone, new Promise(function (r) { setTimeout(r, LEAD_MIN_WAIT_MS); })]).then(goThanks, goThanks);
      setTimeout(goThanks, LEAD_MAX_WAIT_MS);
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
  (function initGallery() {
    /* The project gallery (media-projects command 6). Data: /api/site?r=gallery (CDN-cached JSON of the
       published + consented projects, WebP srcset); if that fails, the static set below (the 5 projects
       the site always had). One before/after slider (shared/compare.js) in a "stage": on desktop a card
       loads into the stage right above the cards (inline — no overlay, the page keeps its context); on
       phones the same stage moves into a full-screen <dialog> (the biggest image, no drag-vs-scroll fight,
       and closing returns to the same card). */
    var w = document.getElementById("compareWidget");
    var section = document.getElementById("compare");
    if (!w || !section || !window.MrpCompare) return;
    var stage = document.getElementById("pgStage"), slot = document.getElementById("pgStageSlot");
    var titleEl = document.getElementById("pgTitle"), metaEl = document.getElementById("pgMeta");
    var summaryEl = document.getElementById("pgSummary"), linkEl = document.getElementById("pgLink");
    var dotsEl = document.getElementById("galleryDots"), filtersEl = document.getElementById("pgFilters");
    var gridEl = document.getElementById("pgGrid"), moreBtn = document.getElementById("pgMore"), liveEl = document.getElementById("pgLive");
    var dialog = document.getElementById("pgDialog"), dialogBody = document.getElementById("pgDialogBody"), closeBtn = document.getElementById("pgClose");
    var handle = w.querySelector(".compare__handle");
    var ctrl = window.MrpCompare.mount(w);
    var phone = window.matchMedia("(max-width: 899px)");
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    var STEP = 8;

    var SERVICES = ["floor_polish", "crystal", "marble_stone", "sealer", "concrete", "bomanite", "stairs", "other"];
    var SERVICE_LABEL = {
      floor_polish: { he: "ליטוש מרצפות", en: "Floor polishing" }, crystal: { he: "פוליש קריסטל", en: "Crystal polish" },
      marble_stone: { he: "שיש ואבן", en: "Marble & stone" }, sealer: { he: "סילר הגנה", en: "Protective sealer" },
      concrete: { he: "בטון", en: "Concrete" }, bomanite: { he: "בומנייט", en: "Bomanite" }, stairs: { he: "מדרגות", en: "Stairs" },
      other: { he: "ליטוש רצפות", en: "Floor restoration" }
    };
    var L = {
      he: { all: "הכל", more: "עוד פרויקטים", found: " פרויקטים", one: "פרויקט אחד", angle: "זווית", angles: "זוויות נוספות", close: "סגירה",
        drag: "גררו כדי להשוות בין לפני לאחרי", filter: "סינון לפי סוג עבודה", grid: "פרויקטים", before: "לפני", after: "אחרי", city: "עיר" },
      en: { all: "All", more: "More projects", found: " projects", one: "1 project", angle: "Angle", angles: "More angles", close: "Close",
        drag: "Drag to compare before and after", filter: "Filter by type of work", grid: "Projects", before: "Before", after: "After", city: "City" }
    };

    /* ----- The static fallback (also the data until the API answers) ----- */
    var G = "assets/gallery/";
    function sp(p, n, title) {
      return { before: { src: G + "project" + p + "-before" + n + ".jpeg", alt: { he: title.he + " – לפני הטיפול", en: title.en + " – before" } },
        after: { src: G + "project" + p + "-after" + n + ".jpeg", alt: { he: title.he + " – אחרי הטיפול", en: title.en + " – after" } } };
    }
    function staticProject(p, n, service, he, en, city) {
      var title = { he: he, en: en }, angles = [];
      for (var i = 1; i <= n; i++) angles.push(sp(p, i, title));
      return { slug: null, service: service, title: title, summary: { he: "", en: "" }, city: city || null,
        serviceLabel: SERVICE_LABEL[service], cover: angles[0].after, coverBefore: angles[0].before, angles: angles };
    }
    var STATIC = [
      staticProject(1, 3, "marble_stone", "אבן בזלת שחורה", "Black basalt"),
      staticProject(2, 2, "marble_stone", "אבן ירושלמית", "Jerusalem stone"),
      staticProject(3, 1, "floor_polish", "רצפת טרצו", "Terrazzo floor"),
      staticProject(4, 2, "stairs", "חידוש מדרגות חלילה", "Spiral staircase restoration"),
      staticProject(5, 1, "marble_stone", "שיש קרמה - בית חולים מאיר", "Crema marble – Meir Hospital", { he: "כפר סבא", en: "Kfar Saba" })
    ];

    var state = { list: STATIC, filter: "all", shown: STEP, cur: 0, angle: 0, booted: false, lastCard: null };
    function lang() { return document.documentElement.lang === "en" ? "en" : "he"; }
    function tx(o) { return o ? (o[lang()] || o.he || "") : ""; }
    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function filtered() {
      return state.list.map(function (p, k) { return { p: p, k: k }; })
        .filter(function (x) { return state.filter === "all" || x.p.service === state.filter; });
    }
    var CARD_SIZES = "(min-width: 1200px) 270px, (min-width: 900px) 31vw, (min-width: 520px) 46vw, 92vw";
    function imgTag(im, cls, alt, sizes) {
      if (!im) return "";
      var a = ' alt="' + esc(alt) + '" loading="lazy" decoding="async" class="' + cls + '"';
      if (im.s) return '<img src="' + esc(im.s[480]) + '" srcset="' + esc(im.s[480] + " 480w, " + im.s[960] + " 960w") + '" sizes="' + sizes + '" width="' + im.w + '" height="' + im.h + '"' + a + " />";
      return '<img src="' + esc(im.src) + '" width="1600" height="1000"' + a + " />";
    }
    var PIN = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
    function metaHtml(p) {
      return (p.city ? '<span class="pcard__city">' + PIN + '<span><span class="sr-only">' + L[lang()].city + ": </span>" + esc(tx(p.city)) + "</span></span>" : "") +
        '<span class="pcard__chip">' + esc(tx(p.serviceLabel)) + "</span>";
    }

    /* ----- Filters ----- */
    function renderFilters() {
      var present = SERVICES.filter(function (s) { return state.list.some(function (p) { return p.service === s; }); });
      filtersEl.setAttribute("aria-label", L[lang()].filter);
      if (present.length < 2) { filtersEl.innerHTML = ""; filtersEl.style.visibility = "hidden"; return; }   // keeps its height
      filtersEl.style.visibility = "";
      filtersEl.hidden = false;
      filtersEl.innerHTML = ["all"].concat(present).map(function (s) {
        return '<button type="button" class="gallery-tab" data-filter="' + s + '" aria-pressed="' + (state.filter === s) + '">' +
          esc(s === "all" ? L[lang()].all : tx(SERVICE_LABEL[s])) + "</button>";
      }).join("");
    }
    filtersEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-filter]");
      if (!b || b.getAttribute("data-filter") === state.filter) return;
      state.filter = b.getAttribute("data-filter");
      state.shown = STEP;
      renderFilters();
      renderGrid(-1);
      var n = filtered().length;
      liveEl.textContent = n === 1 ? L[lang()].one : n + L[lang()].found;
    });

    /* ----- Cards + load more ----- */
    function renderGrid(focusFrom) {
      var items = filtered(), shown = items.slice(0, state.shown);
      gridEl.setAttribute("aria-label", L[lang()].grid);
      gridEl.removeAttribute("aria-busy");
      gridEl.innerHTML = shown.map(function (x) {
        var p = x.p;
        return '<li><button type="button" class="pcard' + (p.coverBefore ? " pcard--split" : "") + '" data-k="' + x.k + '"' + (x.k === state.cur ? ' aria-current="true"' : "") + ">" +
          '<span class="pcard__media">' + imgTag(p.cover, "pcard__after", tx(p.cover && p.cover.alt) || tx(p.title), CARD_SIZES) +
            (p.coverBefore ? '<span class="pcard__before" aria-hidden="true">' + imgTag(p.coverBefore, "", "", "120px") + "</span>" : "") + "</span>" +
          '<span class="pcard__body"><span class="pcard__title">' + esc(tx(p.title)) + '</span><span class="pcard__meta">' + metaHtml(p) + "</span></span></button></li>";
      }).join("");
      var left = items.length - shown.length;
      moreBtn.hidden = left <= 0;
      moreBtn.textContent = L[lang()].more + " (" + left + ")";
      if (focusFrom >= 0 && gridEl.children[focusFrom]) gridEl.children[focusFrom].querySelector("button").focus();
    }
    moreBtn.addEventListener("click", function () {
      var from = state.shown;
      state.shown += STEP;
      renderGrid(from);   // focus moves to the first new card
    });
    gridEl.addEventListener("click", function (e) {
      var b = e.target.closest(".pcard");
      if (!b) return;
      state.lastCard = b;
      showProject(+b.getAttribute("data-k"));
      if (phone.matches && dialog && dialog.showModal) openDialog();
      else {
        stage.scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth", block: "start" });
        titleEl.focus({ preventScroll: true });
      }
      if (typeof gaEvent === "function") gaEvent("project_view", { project: state.list[state.cur].slug || "static" });
    });

    /* ----- The stage ----- */
    function renderDots(p) {
      dotsEl.setAttribute("aria-label", L[lang()].angles);
      if (p.angles.length <= 1) { dotsEl.innerHTML = ""; dotsEl.style.display = "none"; return; }
      dotsEl.style.display = "flex";
      dotsEl.innerHTML = p.angles.map(function (a, i) {
        return '<button type="button" class="gallery-dot' + (i === state.angle ? " active" : "") + '" data-angle="' + i + '" aria-pressed="' + (i === state.angle) +
          '" aria-label="' + esc(L[lang()].angle + " " + (i + 1)) + '"></button>';
      }).join("");
    }
    dotsEl.addEventListener("click", function (e) {
      var b = e.target.closest("[data-angle]");
      if (!b) return;
      state.angle = +b.getAttribute("data-angle");
      renderDots(state.list[state.cur]);
      ctrl.show(state.list[state.cur].angles[state.angle], lang(), L[lang()]);
    });
    function renderCaption(p) {
      titleEl.textContent = tx(p.title);
      metaEl.innerHTML = metaHtml(p);
      summaryEl.textContent = tx(p.summary);
      summaryEl.hidden = !tx(p.summary);
      if (p.slug) {
        linkEl.hidden = false;
        linkEl.href = "/projects/" + encodeURIComponent(p.slug) + (lang() === "en" ? "?lang=en" : "");
      } else linkEl.hidden = true;
      if (handle) handle.setAttribute("aria-label", L[lang()].drag);
    }
    function showProject(k) {
      var p = state.list[k];
      if (!p) return;
      state.cur = k; state.angle = 0;
      renderCaption(p);
      renderDots(p);
      ctrl.show(p.angles[0], lang(), L[lang()]);
      Array.prototype.forEach.call(gridEl.querySelectorAll(".pcard"), function (c) {
        if (+c.getAttribute("data-k") === k) c.setAttribute("aria-current", "true"); else c.removeAttribute("aria-current");
      });
    }

    /* ----- Phones: the stage in a full-screen dialog ----- */
    function openDialog() {
      slot.style.minHeight = slot.offsetHeight + "px";   // the page behind keeps its height (no jump)
      dialogBody.appendChild(stage);
      closeBtn.setAttribute("aria-label", L[lang()].close);
      document.documentElement.classList.add("pg-locked");
      dialog.showModal();
      closeBtn.focus();
    }
    if (dialog) {
      dialog.addEventListener("close", function () {
        slot.appendChild(stage);
        slot.style.minHeight = "";
        document.documentElement.classList.remove("pg-locked");
        if (state.lastCard && document.contains(state.lastCard)) state.lastCard.focus();
      });
      dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });   // the backdrop
      closeBtn.addEventListener("click", function () { dialog.close(); });
      phone.addEventListener && phone.addEventListener("change", function () { if (!phone.matches && dialog.open) dialog.close(); });
    }

    function renderAll() {
      renderFilters();
      renderGrid(-1);
      var p = state.list[state.cur];
      if (p) { renderCaption(p); renderDots(p); ctrl.show(p.angles[state.angle] || p.angles[0], lang(), L[lang()]); }
    }
    document.addEventListener("mrp:lang", function () { if (state.booted) renderAll(); });

    /* ----- Boot: the data is fetched only when the section is about to scroll into view ----- */
    function load() {
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 5000);
      return fetch("/api/site?r=gallery", { signal: ctl ? ctl.signal : undefined, headers: { Accept: "application/json" } })
        .then(function (res) { if (!res.ok) throw new Error("http " + res.status); return res.json(); })
        .then(function (data) { if (data && data.projects && data.projects.length) return data.projects; throw new Error("empty"); })
        .catch(function () { return STATIC; })
        .then(function (list) { clearTimeout(timer); return list; });
    }
    function boot() {
      if (state.booted) return;
      state.booted = true;
      load().then(function (list) {
        state.list = list;
        section.setAttribute("data-source", list === STATIC ? "static" : "api");
        state.cur = 0;
        renderAll();
      });
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries, obs) {
        if (entries.some(function (e) { return e.isIntersecting; })) { boot(); obs.disconnect(); }
      }, { rootMargin: "1500px 0px" });   // early enough that the data is usually in before the section shows
      io.observe(section);
    } else boot();
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
    if (OPEN_REVIEW_FROM_LINK) {
      // Open once the page has its language applied (the modal text is translated via data-i18n),
      // with the reviews section behind it, so closing the modal lands somewhere sensible.
      setTimeout(function () {
        var section = document.getElementById("testimonials");
        if (section && section.scrollIntoView) section.scrollIntoView({ block: "start" });
        openModal();
        gaEvent("review_link_open");
      }, 300);
    }

    modal.querySelectorAll("[data-review-close]").forEach(function (el) {
      el.addEventListener("click", closeModal);
    });

    // Focus trap: only the currently-visible state (form or success) is
    // considered, and elements with tabindex="-1" (the honeypot) are excluded.
    function getFocusable() {
      var selector = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]';
      return Array.prototype.filter.call(modal.querySelectorAll(selector), function (el) {
        if (el.tabIndex < 0) return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      });
    }

    document.addEventListener("keydown", function (e) {
      if (modal.hidden) return;
      if (e.key === "Escape") { closeModal(); return; }
      if (e.key !== "Tab") return;

      var focusable = getFocusable();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
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
    var waLink = e.target.closest && e.target.closest('a[href*="wa.me"]');
    if (waLink) {
      gaEvent("whatsapp_click");
      bumpMetric("whatsapp_clicks");
      return;
    }
    // Call-button tracking (header, hero, contact info, footer, mobile action
    // bar) — previously had zero visibility at all, found during the
    // 2026-08-15 audit. Mirrors the wa.me tracking above exactly.
    var callLink = e.target.closest && e.target.closest('a[href^="tel:"]');
    if (!callLink) return;
    gaEvent("call_click");
    bumpMetric("call_clicks");
  });

  /* ---------------------------------------------------------
     10. MISC
  --------------------------------------------------------- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------------------------------------------------------
     11. ACCESSIBILITY WIDGET (IS 5568 / WCAG AA)
     Floating toggle -> panel with text size, high contrast and
     pause-animations controls. Injected on every page that loads
     this script, so it's site-wide with no per-page markup needed.
     Preferences persist in localStorage across pages/visits.
  --------------------------------------------------------- */
  (function initA11yWidget() {
    var STORAGE_KEY = "mrp_a11y_prefs";
    var TEXT_STEPS = [87.5, 100, 112.5, 125, 137.5, 150];
    var root = document.documentElement;

    function loadPrefs() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return { scale: 100, contrast: false, motion: false };
    }
    function savePrefs(prefs) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
    }

    var prefs = loadPrefs();

    function applyPrefs() {
      root.style.fontSize = prefs.scale === 100 ? "" : prefs.scale + "%";
      root.classList.toggle("a11y-contrast", !!prefs.contrast);
      root.classList.toggle("a11y-reduce-motion", !!prefs.motion);
    }
    applyPrefs();

    // Build markup once the DOM is ready for it to be appended.
    var wrap = document.createElement("div");
    wrap.className = "a11y-widget";
    wrap.innerHTML =
      '<button type="button" class="a11y-toggle" id="a11yToggle" aria-haspopup="true" aria-expanded="false" aria-controls="a11yPanel" aria-label="אפשרויות נגישות">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="4" r="1.8" fill="currentColor" stroke="none"/>' +
          '<path d="M4 8.5c2.5 1 5.2 1.5 8 1.5s5.5-.5 8-1.5"/>' +
          '<path d="M12 10v11"/><path d="M8 21l2.5-6"/><path d="M16 21l-2.5-6"/>' +
          '<path d="M7 14l5-1.2L17 14"/>' +
        '</svg>' +
      '</button>' +
      '<div class="a11y-panel" id="a11yPanel" role="dialog" aria-label="אפשרויות נגישות" hidden>' +
        '<div class="a11y-panel__head"><span>אפשרויות נגישות</span>' +
          '<button type="button" class="a11y-panel__close" id="a11yClose" aria-label="סגירת אפשרויות נגישות">&times;</button>' +
        '</div>' +
        '<div class="a11y-row"><span>גודל טקסט</span>' +
          '<div class="a11y-btns">' +
            '<button type="button" data-a11y="text-dec" aria-label="הקטנת גודל הטקסט">A-</button>' +
            '<button type="button" data-a11y="text-reset" aria-label="איפוס גודל הטקסט">A</button>' +
            '<button type="button" data-a11y="text-inc" aria-label="הגדלת גודל הטקסט">A+</button>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="a11y-toggle-row" id="a11yContrast" data-a11y="contrast" aria-pressed="false">' +
          '<span>ניגודיות גבוהה</span><span class="a11y-state"></span>' +
        '</button>' +
        '<button type="button" class="a11y-toggle-row" id="a11yMotion" data-a11y="motion" aria-pressed="false">' +
          '<span>עצירת אנימציות</span><span class="a11y-state"></span>' +
        '</button>' +
        '<button type="button" class="a11y-reset" data-a11y="reset-all">איפוס כל ההגדרות</button>' +
        '<a class="a11y-statement-link" href="accessibility.html">הצהרת נגישות מלאה</a>' +
      '</div>';
    document.body.appendChild(wrap);

    var toggleBtn = document.getElementById("a11yToggle");
    var panel = document.getElementById("a11yPanel");
    var closeBtn = document.getElementById("a11yClose");
    var contrastRow = document.getElementById("a11yContrast");
    var motionRow = document.getElementById("a11yMotion");
    var onLabel = t("On", "פועל");
    var offLabel = t("Off", "כבוי");

    function syncUI() {
      contrastRow.setAttribute("aria-pressed", String(!!prefs.contrast));
      contrastRow.querySelector(".a11y-state").textContent = prefs.contrast ? onLabel : offLabel;
      motionRow.setAttribute("aria-pressed", String(!!prefs.motion));
      motionRow.querySelector(".a11y-state").textContent = prefs.motion ? onLabel : offLabel;
    }
    syncUI();

    function openPanel() {
      panel.hidden = false;
      toggleBtn.setAttribute("aria-expanded", "true");
      closeBtn.focus();
    }
    function closePanel() {
      panel.hidden = true;
      toggleBtn.setAttribute("aria-expanded", "false");
      toggleBtn.focus();
    }

    toggleBtn.addEventListener("click", function () {
      if (panel.hidden) openPanel(); else closePanel();
    });
    closeBtn.addEventListener("click", closePanel);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) closePanel();
    });
    document.addEventListener("click", function (e) {
      if (!panel.hidden && !wrap.contains(e.target)) closePanel();
    });

    panel.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-a11y]");
      if (!btn) return;
      var action = btn.getAttribute("data-a11y");
      var idx;
      if (action === "text-inc") {
        idx = TEXT_STEPS.indexOf(prefs.scale);
        prefs.scale = TEXT_STEPS[Math.min(TEXT_STEPS.length - 1, (idx === -1 ? 1 : idx) + 1)];
      } else if (action === "text-dec") {
        idx = TEXT_STEPS.indexOf(prefs.scale);
        prefs.scale = TEXT_STEPS[Math.max(0, (idx === -1 ? 1 : idx) - 1)];
      } else if (action === "text-reset") {
        prefs.scale = 100;
      } else if (action === "contrast") {
        prefs.contrast = !prefs.contrast;
      } else if (action === "motion") {
        prefs.motion = !prefs.motion;
      } else if (action === "reset-all") {
        prefs = { scale: 100, contrast: false, motion: false };
      }
      applyPrefs();
      syncUI();
      savePrefs(prefs);
    });
  })();

  /* ---------------------------------------------------------
     12. COOKIE CONSENT BANNER (Privacy Law Amendment 13)
     GA4 loads with Google Consent Mode defaulted to "denied" (see
     the inline <head> snippet on every page). This banner is the
     only place that flips it to "granted" for analytics_storage,
     and the choice is remembered so the banner shows once.
  --------------------------------------------------------- */
  (function initCookieBanner() {
    var STORAGE_KEY = "mrp_cookie_consent";
    var stored;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch (e) {}
    if (stored) return; // already accepted or rejected — nothing to show

    var banner = document.createElement("div");
    banner.className = "cookie-banner";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", t("Cookie notice", "הודעת עוגיות"));
    banner.innerHTML =
      '<div class="cookie-banner__inner">' +
        '<p>' + t(
          'We use cookies for analytics (Google Analytics) to improve the site. See our ',
          'אנו משתמשים בעוגיות למטרות אנליטיקה (Google Analytics) לשיפור האתר. לפרטים ראו את '
        ) +
        '<a href="privacy.html">' + t("privacy policy", "מדיניות הפרטיות") + '</a>.</p>' +
        '<div class="cookie-banner__actions">' +
          '<button type="button" class="cookie-banner__reject" id="cookieReject">' + t("Reject", "דחייה") + '</button>' +
          '<button type="button" class="cookie-banner__accept" id="cookieAccept">' + t("Accept", "אישור") + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(banner);

    // The a11y toggle sits in the same corner (bottom, inline-end) as this
    // banner's action buttons. Lift it above the banner while shown so
    // neither is obscured or unreachable by keyboard/tap.
    var a11yWidget = document.querySelector(".a11y-widget");
    function liftA11yWidget() {
      if (!a11yWidget) return;
      var baseBottom = parseFloat(getComputedStyle(a11yWidget).bottom) || 24;
      a11yWidget.style.bottom = (baseBottom + banner.offsetHeight + 12) + "px";
    }
    function resetA11yWidget() {
      if (a11yWidget) a11yWidget.style.bottom = "";
    }
    liftA11yWidget();
    window.addEventListener("resize", liftA11yWidget);

    function updateConsent(granted) {
      if (typeof window.gtag === "function") {
        window.gtag("consent", "update", {
          analytics_storage: granted ? "granted" : "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied"
        });
      }
    }

    function dismiss(choice, granted) {
      try { localStorage.setItem(STORAGE_KEY, choice); } catch (e) {}
      updateConsent(granted);
      window.removeEventListener("resize", liftA11yWidget);
      resetA11yWidget();
      banner.remove();
    }

    document.getElementById("cookieAccept").addEventListener("click", function () { dismiss("accepted", true); });
    document.getElementById("cookieReject").addEventListener("click", function () { dismiss("rejected", false); });
  })();
})();
