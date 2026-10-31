/* /projects/<slug> (server-rendered by api/site.js): the before/after slider + the angle dots.
   The data rides in <script type="application/json" id="ppData"> (no inline JS → CSP-safe). */
(function () {
  "use strict";
  var dataEl = document.getElementById("ppData");
  var w = document.getElementById("ppCompare");
  if (!dataEl || !w || !window.MrpCompare) return;
  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var ctrl = window.MrpCompare.mount(w);
  var dots = document.getElementById("ppDots");
  if (!dots) return;
  dots.addEventListener("click", function (e) {
    var b = e.target.closest("[data-angle]");
    if (!b) return;
    var i = +b.getAttribute("data-angle");
    var a = data.angles[i];
    if (!a) return;
    ctrl.show(a, data.lang, data.t);
    Array.prototype.forEach.call(dots.children, function (d, k) {
      d.classList.toggle("active", k === i);
      d.setAttribute("aria-pressed", k === i ? "true" : "false");
    });
  });
})();
