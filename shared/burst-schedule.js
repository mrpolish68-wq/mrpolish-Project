/* Burst guard: spreads past-dated content_queue rows over future publishing slots, so a bulk
   Approve can never send a pile of old posts to Meta at once (the 2026-10-30 incident, handoff §33).
   UMD: window.MrpBurstSchedule in admin.html, require() in the tests. No DOM, no network.

   Slots (Israel time): Sun–Thu 10:00 / 14:00 / 19:00 · Fri 10:00 / 14:00 · Sat 19:00.
   Rules: oldest first; at most one item per slot (so max 3 a day); never two reels one after
   another on the same day (the next reel moves to the next day); start from the first slot after
   the latest existing approved/scheduled post and at least MIN_LEAD_MS from now. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MrpBurstSchedule = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TZ = "Asia/Jerusalem";
  var SLOTS_BY_DOW = { 0: [10, 14, 19], 1: [10, 14, 19], 2: [10, 14, 19], 3: [10, 14, 19], 4: [10, 14, 19], 5: [10, 14], 6: [19] };
  var DOW_HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  var MIN_LEAD_MS = 15 * 60 * 1000;

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function israelParts(date) {
    var d = new Date(date);
    var map = {};
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d).forEach(function (p) { if (p.type !== "literal") map[p.type] = p.value; });
    return { y: +map.year, m: +map.month, d: +map.day, h: map.hour === "24" ? 0 : +map.hour, min: +map.minute };
  }

  // Israel wall-clock → UTC instant (Intl round-trip, so DST needs no hardcoded offset).
  function israelWallToDate(y, m, d, h, min) {
    var guess = Date.UTC(y, m - 1, d, h, min || 0, 0);
    var p = israelParts(guess);
    var asWall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, 0);
    return new Date(guess - (asWall - guess));
  }

  function dayKey(p) { return p.y + "-" + pad2(p.m) + "-" + pad2(p.d); }
  function dowOf(p) { return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }

  function isReel(row) {
    return !!row && (row.media_type === "reel" || row.media_type === "video" || row.content_category === "reel");
  }

  function isPast(row, now) {
    var t = new Date(row && row.scheduled_for).getTime();
    return !isNaN(t) && t <= (now ? new Date(now).getTime() : Date.now());
  }

  // Every slot strictly after `after` (a Date), in order, for up to `days` days.
  function slotsAfter(after, days) {
    var out = [];
    var start = israelParts(after);
    for (var i = 0; i < (days || 120); i++) {
      var base = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
      var p = { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
      var dow = base.getUTCDay();
      SLOTS_BY_DOW[dow].forEach(function (h) {
        var at = israelWallToDate(p.y, p.m, p.d, h, 0);
        if (at.getTime() > after.getTime()) out.push({ at: at, day: dayKey(p), dow: dow, hour: h });
      });
    }
    return out;
  }

  // rows: the past-dated rows to spread. opts.existing: rows already approved/scheduled (not part
  // of this batch). Returns [{ row, at (Date), iso, day, dow, hour, dateLabel, dayLabel, timeLabel }].
  function planSpread(rows, opts) {
    opts = opts || {};
    var now = opts.now ? new Date(opts.now) : new Date();
    var existing = (opts.existing || []).filter(function (r) { return r && !isNaN(new Date(r.scheduled_for).getTime()); })
      .sort(function (a, b) { return new Date(a.scheduled_for) - new Date(b.scheduled_for); });
    var latest = existing.length ? existing[existing.length - 1] : null;
    var after = new Date(Math.max(now.getTime() + MIN_LEAD_MS - 1, latest ? new Date(latest.scheduled_for).getTime() : 0));

    var items = rows.slice().sort(function (a, b) {
      var d = new Date(a.scheduled_for) - new Date(b.scheduled_for);
      return d || String(a.id).localeCompare(String(b.id));
    });
    var slots = slotsAfter(after, 30 + items.length * 2);
    var lastDay = latest ? dayKey(israelParts(latest.scheduled_for)) : null;
    var lastWasReel = latest ? isReel(latest) : false;
    var out = [], si = 0;
    items.forEach(function (row) {
      var slot = slots[si];
      if (isReel(row) && lastWasReel && slot && slot.day === lastDay) {
        while (slots[si] && slots[si].day === lastDay) si++;
        slot = slots[si];
      }
      if (!slot) throw new Error("no free slot");
      si++;
      lastDay = slot.day; lastWasReel = isReel(row);
      var p = israelParts(slot.at);
      out.push({
        row: row, at: slot.at, iso: slot.at.toISOString(), day: slot.day, dow: slot.dow, hour: slot.hour,
        dateLabel: pad2(p.d) + "." + pad2(p.m), dayLabel: DOW_HE[slot.dow], timeLabel: pad2(p.h) + ":" + pad2(p.min)
      });
    });
    return out;
  }

  // The first free slot after the existing approved/scheduled posts (for the single-row date picker).
  function nextFreeSlot(opts) {
    var plan = planSpread([{ id: "_", scheduled_for: new Date(0).toISOString() }], opts);
    return plan[0];
  }

  return { SLOTS_BY_DOW: SLOTS_BY_DOW, DOW_HE: DOW_HE, MIN_LEAD_MS: MIN_LEAD_MS, israelParts: israelParts,
    israelWallToDate: israelWallToDate, isReel: isReel, isPast: isPast, slotsAfter: slotsAfter, planSpread: planSpread, nextFreeSlot: nextFreeSlot };
});
