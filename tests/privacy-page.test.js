// privacy.html: the AI-processing section says exactly what the system does (audit L9), and the
// rest of the page (incl. the Amendment 13 rights section) is intact. Static check, no browser.
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "privacy.html"), "utf8");
let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name); }

const VOICE = "הבוט שלנו אינו שומר הקלטות קוליות — ההקלטה מעובדת ונמחקת מהזיכרון מיד, והיא נשארת רק בצ'אט בטלגרם, שם ניתן למחוק אותה.";
check("L9: the exact voice-recording sentence is present", html.includes(VOICE));
check("L9: the old sentence ('הקלטות קוליות אינן נשמרות') is gone", !html.includes("הקלטות קוליות אינן נשמרות"));
check("the drafts promise is still there (deleted within 24 h)", html.includes("טיוטות של הצעות מחיר שלא אושרו נמחקות באופן אוטומטי בתוך 24 שעות."));
check("the AI section heading + Gemini + minimal data are still there", html.includes("<h2>שימוש בשירותי בינה מלאכותית</h2>") && html.includes("Google (Gemini)") && html.includes("רק המידע המינימלי הנדרש"));
check("the Amendment 13 section (right of access, correction, deletion) is intact", html.includes("זכות עיון, תיקון ומחיקה - סעיף 13 לחוק הגנת הפרטיות") &&
  html.includes("לסעיף 13 לחוק הגנת הפרטיות, התשמ\"א-1981") && html.includes("<strong>לבקש למחוק</strong>"));
check("all original sections still present", ["כללי", "איזה מידע אנו אוספים", "השימוש במידע", "מסירת מידע לצדדים שלישיים", "אבטחת מידע", "עוגיות (Cookies)", "שינויים במדיניות הפרטיות"]
  .every(h => html.includes("<h2>" + h + "</h2>")));

console.log("\n" + pass + "/" + (pass + fail) + " passed");
if (fail) process.exitCode = 1;
