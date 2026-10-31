/* "✅ העבודה בוצעה" → "⭐ בקשת ביקורת" (media-projects command 7). One module for the bot (Node) and the
   panel (browser, window.MrpReview): the exact review message (owner's wording, line breaks + emojis),
   the client's first name from the quote, the wa.me link WITHOUT a phone number (Miri picks the contact
   in WhatsApp; no phone is asked for or stored), and the service + city a quote suggests for the project
   (the city is the part after the last comma of the address — never the street or house number). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MrpReview = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var REVIEW_URL = "https://g.page/r/CRSEpD2_CFoDEBI/review";

  // "משה כהן" → "משה"; "משפחת לוי" → "משפחת לוי"; titles dropped; anything odd → null ("היי,").
  function firstName(clientName) {
    var t = String(clientName || "").replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^(מר|גב['׳]?|גברת|ד["״]ר|דר['׳]|הרב|עו["״]ד)\s+/, "");
    if (!t) return null;
    var words = t.split(" ");
    var name = words[0] === "משפחת" && words[1] ? words[0] + " " + words[1] : words[0];
    name = name.replace(/[^\p{L}\s'׳"״-]/gu, "").trim();
    return name && name.length <= 30 ? name : null;
  }

  function reviewMessage(clientName) {
    var n = firstName(clientName);
    return [
      (n ? "היי " + n + "," : "היי,") + " כאן אורי ממיסטר פוליש 😊",
      "תודה שבחרתם בנו, היה לי כיף לעבוד אצלכם!",
      "אם אתם מרוצים מהתוצאה, אשמח מאוד אם תקדישו דקה לכתוב לנו ביקורת בגוגל. זה עוזר לנו המון.",
      "👈 לחיצה על הקישור פותחת ישר את חלון הביקורת:",
      REVIEW_URL,
      "תודה רבה! 🙏"
    ].join("\n");
  }

  // No recipient: WhatsApp opens the contact picker with the text ready.
  function waUrl(text) { return "https://wa.me/?text=" + encodeURIComponent(text); }

  // The project's service from the quote's description (null = let the AI decide).
  var SERVICE_RULES = [
    ["bomanite", /בומנייט/], ["concrete", /בטון/], ["stairs", /מדרגות/], ["crystal", /קריסטל/],
    ["marble_stone", /שיש|אבן|בזלת|גרניט/], ["sealer", /סילר/], ["floor_polish", /ליטוש|מרצפות|טרצו|פוליש|הברקה/]
  ];
  function serviceFromText(text) {
    var t = String(text || "");
    for (var i = 0; i < SERVICE_RULES.length; i++) if (SERVICE_RULES[i][1].test(t)) return SERVICE_RULES[i][0];
    return null;
  }

  // "הרצל 12, רעננה" → "רעננה". Only a plain city name (letters, ≤ 3 words, no digits / street words).
  var STREET_RE = /\d|רחוב|רח['׳]|שד['׳]|שדרות|סמטת|כיכר|דירה|קומה/;
  function cityFromAddress(address) {
    var parts = String(address || "").split(",");
    if (parts.length < 2) return null;
    var c = parts[parts.length - 1].replace(/\s+/g, " ").trim();
    if (!c || c.length > 40 || STREET_RE.test(c) || c.split(" ").length > 3 || !/^[\p{L}\s'׳"״-]+$/u.test(c)) return null;
    return c;
  }

  return { REVIEW_URL: REVIEW_URL, firstName: firstName, reviewMessage: reviewMessage, waUrl: waUrl, serviceFromText: serviceFromText, cityFromAddress: cityFromAddress };
});
