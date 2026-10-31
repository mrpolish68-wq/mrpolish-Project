/* The before/after comparison slider, shared by the homepage gallery (main.js) and the project
   pages (/projects/<slug>, shared/project-page.js). Media-projects command 6.
   Markup: .compare > .compare__after img, .compare__before img, .compare__divider > .compare__handle
   (role="slider"). Pointer events cover mouse + touch + pen: drag the handle, or tap anywhere to jump;
   ←/→ (2%), Home / End on the handle. Before = left, after = right (physical, in both directions).

   window.MrpCompare.mount(widgetEl) → { show(angle, lang), el }
     angle = { before, after }; each image is either { s: {480, 960, 1600}, w, h, alt: {he, en} } (the
     site API: WebP srcset) or { src, alt: {he, en} } (the static fallback). before may be null (one photo:
     no divider). */
(function (root) {
  "use strict";
  // phones: 320px → w480 at DPR 1, w960 at DPR 2–3 (never w1600 on a phone)
  var SIZES = "(max-width: 600px) 320px, (min-width: 1000px) 900px, 100vw";

  function setImg(el, im, lang, fallbackAlt) {
    if (!el) return;
    if (!im) { el.removeAttribute("src"); el.removeAttribute("srcset"); return; }
    el.alt = (im.alt && (im.alt[lang] || im.alt.he)) || fallbackAlt || "";
    if (im.s) {
      el.sizes = el.getAttribute("data-sizes") || SIZES;
      el.srcset = im.s[480] + " 480w, " + im.s[960] + " 960w, " + im.s[1600] + " 1600w";
      el.src = im.s[960];
      if (im.w && im.h) { el.width = im.w; el.height = im.h; }
    } else {
      el.removeAttribute("srcset");
      el.src = im.src;
    }
  }

  function mount(w) {
    if (!w) return null;
    var handle = w.querySelector(".compare__handle");
    var afterImg = w.querySelector(".compare__after img");
    var beforeImg = w.querySelector(".compare__before img");
    var dragging = false;
    var reduce = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function setPct(p) {
      p = Math.max(0, Math.min(100, p));
      w.style.setProperty("--pos", p + "%");
      if (handle) handle.setAttribute("aria-valuenow", String(Math.round(p)));
    }
    function setPos(clientX) {
      var r = w.getBoundingClientRect();
      setPct(((clientX - r.left) / r.width) * 100);
    }
    function endDrag() { if (dragging) { dragging = false; w.classList.remove("is-dragging"); } }

    if (handle) {
      handle.addEventListener("pointerdown", function (e) {
        dragging = true;
        w.classList.add("is-dragging");
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      handle.addEventListener("keydown", function (e) {
        var cur = parseFloat(w.style.getPropertyValue("--pos")) || 50;
        if (e.key === "ArrowLeft") cur -= 2;
        else if (e.key === "ArrowRight") cur += 2;
        else if (e.key === "Home") cur = 0;
        else if (e.key === "End") cur = 100;
        else return;
        e.preventDefault();
        setPct(cur);
      });
    }
    w.addEventListener("pointerdown", function (e) {
      if (w.classList.contains("compare--single") || e.target.closest(".compare__handle")) return;
      setPos(e.clientX);
    });
    root.addEventListener("pointermove", function (e) { if (dragging) setPos(e.clientX); });
    root.addEventListener("pointerup", endDrag);
    root.addEventListener("pointercancel", endDrag);

    function show(angle, lang, labels) {
      labels = labels || {};
      var apply = function () {
        setImg(afterImg, angle.after, lang, labels.after);
        setImg(beforeImg, angle.before, lang, labels.before);
        w.classList.toggle("compare--single", !angle.before);
        setPct(50);
        root.requestAnimationFrame(function () { w.classList.remove("is-swapping"); });
      };
      if (reduce || !afterImg || !afterImg.getAttribute("src")) { apply(); return; }
      w.classList.add("is-swapping");   // a short cross-fade answers the tap
      root.setTimeout(apply, 180);
    }
    return { el: w, show: show, setPct: setPct };
  }

  root.MrpCompare = { mount: mount };
})(window);
