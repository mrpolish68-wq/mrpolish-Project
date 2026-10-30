// shared/burst-schedule.js — the slot planner behind the panel's bulk-Approve spread dialog and the
// single-row date picker (burst guard, handoff §33). Pure functions, no network.
"use strict";
const path = require("path");
const B = require(path.resolve(__dirname, "..", "shared", "burst-schedule.js"));

let passed = 0, total = 0;
function check(name, cond, detail) {
  total++;
  if (cond) { passed++; console.log("PASS " + name); } else console.log("FAIL " + name + (detail ? "  -- " + detail : ""));
}
const row = (id, kind, iso) => ({ id, media_type: kind === "R" ? "reel" : "image", content_category: kind === "R" ? "reel" : "post", scheduled_for: iso });
const label = (p) => p.dayLabel + " " + p.dateLabel + " " + p.timeLabel;
const israelHour = (d) => B.israelParts(d).h;
const israelDow = (d) => { const p = B.israelParts(d); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); };

// 1. Reproduces the 19-post schedule applied by hand on 2026-10-30 (handoff §33.2)
const kinds = "R P R R P P P R R R R P P P P P R P P".split(" ");
const nineteen = kinds.map((k, i) => row("r" + String(i).padStart(2, "0"), k, new Date(Date.UTC(2026, 6, 20 + i)).toISOString()));
let plan = B.planSpread(nineteen, { now: "2026-10-31T21:50:00Z" });
const expected = ["ראשון 01.11 10:00", "ראשון 01.11 14:00", "ראשון 01.11 19:00", "שני 02.11 10:00", "שני 02.11 14:00", "שני 02.11 19:00",
  "שלישי 03.11 10:00", "שלישי 03.11 14:00", "רביעי 04.11 10:00", "חמישי 05.11 10:00", "שישי 06.11 10:00", "שישי 06.11 14:00",
  "שבת 07.11 19:00", "ראשון 08.11 10:00", "ראשון 08.11 14:00", "ראשון 08.11 19:00", "שני 09.11 10:00", "שני 09.11 14:00", "שני 09.11 19:00"];
check("reproduces the hand-made 1–9 Nov schedule exactly", JSON.stringify(plan.map(label)) === JSON.stringify(expected), plan.map(label).join(" | "));
check("ISO slots are real Israel times (Sun 1.11 10:00 = 08:00Z in winter)", plan[0].iso === "2026-11-01T08:00:00.000Z", plan[0].iso);
check("oldest first: plan keeps the input's date order", plan.every((p, i) => p.row.id === nineteen[i].id));

// 2. Input order doesn't matter (sorted by scheduled_for)
const shuffled = nineteen.slice().reverse();
check("input order is ignored (oldest first)", JSON.stringify(B.planSpread(shuffled, { now: "2026-10-31T21:50:00Z" }).map(p => p.row.id)) === JSON.stringify(nineteen.map(r => r.id)));

// 3. Slot rules over a long run: Fri only 10/14, Sat only 19, others 10/14/19, max 3 a day
const many = Array.from({ length: 60 }, (_, i) => row("m" + String(i).padStart(2, "0"), i % 3 === 0 ? "R" : "P", new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));
plan = B.planSpread(many, { now: "2026-11-10T06:00:00Z" });
const byDay = {};
plan.forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });
check("Friday: only 10:00 and 14:00", plan.filter(p => israelDow(p.at) === 5).every(p => [10, 14].includes(israelHour(p.at))));
check("Saturday: only 19:00", plan.filter(p => israelDow(p.at) === 6).every(p => israelHour(p.at) === 19) && plan.some(p => israelDow(p.at) === 6));
check("Sun–Thu: only 10:00 / 14:00 / 19:00", plan.filter(p => israelDow(p.at) < 5).every(p => [10, 14, 19].includes(israelHour(p.at))));
check("max 3 a day, one per slot", Object.values(byDay).every(d => d.length <= 3 && new Set(d.map(p => p.hour)).size === d.length));
check("never two reels one after another on the same day", Object.values(byDay).every(d => d.every((p, i) => i === 0 || !(B.isReel(p.row) && B.isReel(d[i - 1].row)))));
check("all slots are in the future and strictly increasing", plan.every((p, i) => p.at > new Date("2026-11-10T06:00:00Z") && (i === 0 || p.at > plan[i - 1].at)));

// 4. Starts after the latest existing approved/scheduled post
plan = B.planSpread([row("a", "P", "2026-08-01T07:00:00Z")], { now: "2026-10-31T10:00:00Z", existing: [row("e1", "P", "2026-11-09T17:00:00Z"), row("e0", "P", "2026-11-03T08:00:00Z")] });
check("starts after the latest existing post (Mon 9.11 19:00 → Tue 10.11 10:00)", label(plan[0]) === "שלישי 10.11 10:00", label(plan[0]));
plan = B.planSpread([row("a", "R", "2026-08-01T07:00:00Z"), row("b", "P", "2026-08-02T07:00:00Z")], { now: "2026-10-31T10:00:00Z", existing: [row("e", "R", "2026-11-03T08:00:00Z")] });
check("an existing reel at 10:00 → a first reel doesn't follow it the same day", label(plan[0]) === "רביעי 04.11 10:00" && label(plan[1]) === "רביעי 04.11 14:00", plan.map(label).join(" | "));
plan = B.planSpread([row("a", "P", "2026-08-01T07:00:00Z")], { now: "2026-10-31T10:00:00Z", existing: [row("e", "R", "2026-11-03T08:00:00Z")] });
check("…but a feed post can follow it at 14:00", label(plan[0]) === "שלישי 03.11 14:00", label(plan[0]));

// 5. Lead time from now (≥ 15 min)
plan = B.planSpread([row("a", "P", "2026-01-01T00:00:00Z")], { now: "2026-11-01T07:50:00Z" }); // Sun 09:50 Israel
check("09:50 now → 10:00 is too close, first slot is 14:00", label(plan[0]) === "ראשון 01.11 14:00", label(plan[0]));
plan = B.planSpread([row("a", "P", "2026-01-01T00:00:00Z")], { now: "2026-11-01T07:40:00Z" }); // Sun 09:40 Israel
check("09:40 now → 10:00 is fine (20 min ahead)", label(plan[0]) === "ראשון 01.11 10:00", label(plan[0]));
plan = B.planSpread([row("a", "P", "2026-01-01T00:00:00Z")], { now: "2026-11-06T13:00:00Z" }); // Fri 15:00 Israel
check("Friday afternoon → next slot is Saturday 19:00", label(plan[0]) === "שבת 07.11 19:00", label(plan[0]));

// 6. DST: across the 25 Oct 2026 switch and in summer
plan = B.planSpread([row("a", "P", "2026-01-01T00:00:00Z"), row("b", "P", "2026-01-02T00:00:00Z"), row("c", "P", "2026-01-03T00:00:00Z"), row("d", "P", "2026-01-04T00:00:00Z")], { now: "2026-10-23T05:00:00Z" });
check("DST end: Fri 23.10 10:00 = 07:00Z (summer), Sun 25.10 10:00 = 08:00Z (winter)", plan[0].iso === "2026-10-23T07:00:00.000Z" && plan[3].iso === "2026-10-25T08:00:00.000Z", plan.map(p => p.iso).join(" "));
plan = B.planSpread([row("a", "P", "2026-01-01T00:00:00Z")], { now: "2027-06-06T03:00:00Z" });
check("summer: Sun 6.6.2027 10:00 = 07:00Z", plan[0].iso === "2027-06-06T07:00:00.000Z", plan[0].iso);

// 7. Helpers
check("isPast: past / now / future", B.isPast({ scheduled_for: "2026-01-01T00:00:00Z" }, "2026-06-01T00:00:00Z") &&
  B.isPast({ scheduled_for: "2026-06-01T00:00:00Z" }, "2026-06-01T00:00:00Z") && !B.isPast({ scheduled_for: "2026-06-01T00:01:00Z" }, "2026-06-01T00:00:00Z"));
check("isReel: reel / video / reel category; not image or story", B.isReel({ media_type: "reel" }) && B.isReel({ media_type: "video" }) &&
  B.isReel({ media_type: "image", content_category: "reel" }) && !B.isReel({ media_type: "image" }) && !B.isReel({ media_type: "story" }));
const nf = B.nextFreeSlot({ now: "2026-10-31T10:00:00Z", existing: [row("e", "P", "2026-11-09T17:00:00Z")] });
check("nextFreeSlot: first slot after the existing queue", label(nf) === "שלישי 10.11 10:00", label(nf));
check("Hebrew labels: day names and DD.MM / HH:MM", /^(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת) \d\d\.\d\d \d\d:\d\d$/.test(label(nf)));

console.log("\n" + passed + "/" + total + " passed");
process.exitCode = passed === total ? 0 : 1;
