-- =============================================================
--  Mr. Polish — Batch 2 correction + brand-voice update.
--
--  Two rounds of Ori feedback folded into one migration:
--
--  ROUND 1 — asset quality (ad + reel flagged as unsatisfactory):
--  - Ad: was a Canva AI-generated graphic (garbled-then-corrected
--    Hebrew text, abstract marble background). Replaced with a real
--    HTML/CSS card (assets/generated/ad-free-inspection-v2.jpg) — real
--    DOM Hebrew text (no AI text-rendering risk), a genuine before/
--    after split of project1 (before2/after2 angle).
--  - Reel: was a 5s Higgsfield image-to-video pan (single AI-guessed
--    camera move, no narrative). Replaced with a ~19s 4-scene story
--    (assets/generated/reel-basalt-story.mp4) on the site's existing
--    Remotion topic-reel system — no AI-generated video anywhere.
--
--  ROUND 2 — brand voice shift (Ori's 2026-07-12 follow-up): every
--  '24-hour' / time-boxed promise is retired site-wide, replaced with
--  the new standing offer line:
--    "בדיקת התאמה ללא עלות - ייעוץ אישי מאורי"
--  Applied to every row in this batch, not just the ad, so the whole
--  queued batch speaks with one consistent voice.
--
--  Also inserts the new brand explainer video (stills-only Ken Burns
--  piece, Ori's explicit choice of "Path 2" — no live footage, built
--  entirely from the 18 real gallery photos across all 5 projects) as
--  a new pending_approval row so it shows up in the dashboard for
--  review, per Ori's "final assets ready for my review" instruction.
--
--  Run this in the Supabase SQL Editor once supabase-content-queue-
--  batch2-seed.sql has already been run. Matches existing rows by
--  their exact `title`.
-- =============================================================

update public.content_queue set
  media_url = 'https://mr-polishes.com/assets/generated/ad-free-inspection-v2.jpg',
  caption = 'רואים את ההבדל? 🔍' || chr(10) || chr(10) ||
    'זו התוצאה של ליטוש מקצועי אחד על אותה אבן בזלת - בלי צבע, בלי כיסוי, בלי החלפת ריצוף.' || chr(10) || chr(10) ||
    'בדיקת התאמה ללא עלות - ייעוץ אישי מאורי.' || chr(10) || chr(10) ||
    '📞 אורי מרגלית · 30 שנות ניסיון אישי · 052-9534540 · mr-polishes.com',
  notes = 'REVISED twice: (1) wording+composition fix - real before/after photo card instead of AI marble graphic; (2) brand-voice fix - removed the "24 hours" promise, replaced with the standing "בדיקת התאמה ללא עלות - ייעוץ אישי מאורי" line. See marketing/social-2026-07-12-batch2-fix/.',
  ai_rating_justification = 'תוקן פעמיים לאחר משוב של אורי: תחילה עיצוב ותוכן (גרסה אמיתית עם תמונת לפני/אחרי), ולאחר מכן הסרת הבטחת "24 שעות" לטובת הניסוח הקבוע החדש. עדיין אין לעמוד היסטוריית ביצועים למודעות, ולכן הציון נשאר זהיר.',
  ai_generated_at = now()
where title = 'באטש 2 — מודעה: בדיקה חינם';

update public.content_queue set
  media_url = 'https://mr-polishes.com/assets/generated/reel-basalt-story.mp4',
  thumbnail_url = 'https://mr-polishes.com/assets/gallery/project1-after2.jpeg',
  caption = 'ככה נראתה החצר לפני 👇' || chr(10) || chr(10) ||
    'אבן בזלת עם אבק, כתמים ושכבות ישנות שדהו עם הזמן - וזה מה שעשינו כדי להחזיר לה את הברק:' || chr(10) ||
    '✔️ ניקוי עומק וחשיפת האבן האמיתית' || chr(10) ||
    '✔️ ליטוש בשלבים עד לגימור אחיד' || chr(10) ||
    '✔️ אטימה שמחזירה ברק ומגנה לאורך זמן' || chr(10) || chr(10) ||
    'בלי לשבור ובלי להחליף אריח אחד.' || chr(10) || chr(10) ||
    '📞 גם אצלכם יש משטח כזה? בדיקת התאמה ללא עלות - ייעוץ אישי מאורי. mr-polishes.com',
  notes = 'REVISED twice: (1) story+motion fix - real 19s 4-scene narrative instead of a 5s AI pan; (2) brand-voice fix - CTA now reads the standing "בדיקת התאמה ללא עלות" line, no time-boxed promise. See marketing/social-2026-06-29/reel-remotion/src/topics/reels.ts (BasaltStoryReel).',
  ai_rating_justification = 'תוקן פעמיים: קודם המבנה והתנועה (סיפור אמיתי באורך 19 שניות במקום תנועת AI קצרה), ולאחר מכן ניסוח הקריאה לפעולה. עדיין אין נתוני ביצועים לפורמט רילס בעמוד הזה, ולכן הציון נשאר זהיר.',
  ai_optimal_timing = 'ימי שלישי-רביעי בערב (19:00-21:00) - שעות עומס גלישה ברילס של אינסטגרם.',
  ai_generated_at = now()
where title = 'באטש 2 — רילס: אבן בזלת שחורה';

update public.content_queue set
  caption = 'לפני שמתחילים - ככה נראה משטח שדורש ליטוש אמיתי 📐' || chr(10) || chr(10) ||
    'הרבה עסקים מראים רק תמונות "אחרי". אנחנו מאמינים שגם ה"לפני" הוא חלק חשוב מהסיפור - כי זה עוזר לכם לזהות מתי הגיע הזמן לחדש, ולא לחכות שהנזק יחמיר.' || chr(10) || chr(10) ||
    'אבן ירושלמית עם שכבות ישנות, אבק שנצבר ומראה עייף - נקודת התחלה טיפוסית שאנחנו רואים כל שבוע.' || chr(10) || chr(10) ||
    '📞 גם אצלכם יש משטח כזה? בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  notes = notes || ' | Brand-voice fix (2026-07-12): sign-off now uses the standing offer line, no time-boxed promise (this post never had one, updated for consistency across the batch).'
where title = 'באטש 2 — פוסט: כנות לגבי לפני';

update public.content_queue set
  caption = 'אני אורי מרגלית, ואני עומד מאחורי כל עבודה בשם שלי 🤝' || chr(10) || chr(10) ||
    'בשוק שמלא בחברות תיווך שרק מעבירות אתכם לקבלן הזול ביותר, החלטתי לעשות את זה אחרת: אני מגיע בעצמי, מבצע בעצמי, ועומד מאחורי התוצאה בשמי האישי.' || chr(10) || chr(10) ||
    'המדרגות האלו הן דוגמה - לא סתם "עוד עבודה", אלא פרויקט שאני זוכר.' || chr(10) || chr(10) ||
    '🔨 30 שנה, אותו אדם, אותה מחויבות.' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  notes = notes || ' | Brand-voice fix (2026-07-12): sign-off now uses the standing offer line, no time-boxed promise (this post never had one, updated for consistency across the batch).'
where title = 'באטש 2 — פוסט: אורי אישית';

update public.content_queue set
  caption = 'משטח כזה בבית? 👀 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי, החליקו ימינה',
  notes = notes || ' | Brand-voice fix (2026-07-12): story text now references the standing offer line instead of a generic prompt.'
where title = 'באטש 2 — סטורי: שאלה מהירה';

-- New: brand explainer video (Path 2 - stills-only, no live footage per Ori's call).
-- content_category = 'ad' (a brand/trust asset, not a dated feed post) so it's easy to
-- filter alongside the other paid/promo-candidate content in the dashboard.
insert into public.content_queue (
  title, caption, media_type, media_url, thumbnail_url, platform, content_category,
  scheduled_for, status, notes,
  ai_rating, ai_rating_justification, ai_optimal_timing,
  ai_reach_forecast, ai_why_it_works, ai_brand_contribution, ai_generated_at
) values (
  'סרטון הסברה — 30 שנה של ליטוש מקצועי',
  '30 שנה של ליטוש מקצועי - אבן, שיש ובטון 💎' || chr(10) || chr(10) ||
    'לא קבלן מטעם, לא תיווך - אני מגיע בעצמי לכל עבודה ועומד מאחורי התוצאה בשם שלי.' || chr(10) || chr(10) ||
    'מהבית הפרטי ועד בית החולים, מבזלת שחורה ועד שיש קרמה - כל משטח מקבל את אותה קפדנות.' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'video', 'https://mr-polishes.com/assets/generated/explainer-video.mp4', 'https://mr-polishes.com/assets/gallery/project5-after1.jpeg', 'both', 'ad',
  '2026-07-20 17:00:00+00', 'pending_approval',
  'Stills-only Ken Burns explainer, ~31s, built entirely from real project photos (all 5 gallery projects) - Ori''s explicit "Path 2" choice (no live footage of Uri; he will not be filming raw footage). Structure: hook -> personal-accountability points -> 5 real before/after project reveals (basalt, Jerusalem stone, terrazzo, chalils stairs, Meir Hospital marble) -> CTA with the new standing offer line. Source: marketing/social-2026-06-29/reel-remotion/src/topics/reels.ts (ExplainerReel). Scheduling date is a placeholder mid-month slot - move as needed once the rest of the month''s calendar is built.',
  6, 'זהו נכס המותג המרכזי הראשון של העמוד (לא פוסט בודד אלא סרטון הסברה מקיף) - פוטנציאל גבוה לבניית אמון ומודעות, אך אין שום נתון היסטורי על ביצועי וידאו ארוך יותר (31 שניות) בעמוד הזה, ולכן הציון נשאר זהיר ולא גבוה אוטומטית רק בגלל היקף ההפקה.', 'פרסום ראשוני: יום ראשון בבוקר (תחילת שבוע) עם קידום ממומן קל; לאחר מכן להשתמש כסרטון קבוע בעמוד הבית ובביו של אינסטגרם/פייסבוק.',
  'קשה לחזות לייקים/תגובות לפורמט חדש לגמרי - אך הערך האמיתי כאן הוא לא מעורבות מיידית אלא שימוש חוזר: כווידאו קבוע באתר, בביו, ובפתיחת שיחות מכירה.', 'משלב 5 הפרויקטים האמיתיים בעמוד לסיפור אחד עם מסר עקבי (30 שנה, אחריות אישית) - במקום 5 פוסטים נפרדים ולא מקושרים.', 'התשתית הראשונה שממצבת את אורי כאיש מקצוע בעל שם, לא רק כ"מר פוליש" כמותג מופשט - בדיוק הפער שמחקר המתחרים (פלורה/טופ פוליש) זיהה.', now()
);
