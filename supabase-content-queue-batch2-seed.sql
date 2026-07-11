-- =============================================================
--  Mr. Polish — Content Batch 2 (post-pilot), grounded in:
--    1. Real competitor research (Flora Litushim — est. 1995, premium/
--       established positioning; Top Polish — price-comparison/broker
--       model, "get 3 quotes, save up to 35%"). Differentiation
--       strategy: lean AWAY from price-war content (that's Top
--       Polish's whole model) and INTO personal-craftsman
--       accountability + transparency, which neither competitor's
--       social presence appears to own.
--    2. The real Social Snapshot audit (309 FB / 9 IG followers,
--       ~1-3 likes/post historically, near-zero comments, tip-style
--       posts underperforming vs. before/after visuals).
--
--  Covers all 4 requested categories (ad/reel/post/story). Unlike the
--  deleted pilot (7 real photos, no video, no graphics), this batch
--  includes:
--    - One AI-generated ad graphic (Canva) — text was initially
--      garbled by the AI design generator (a real, verified failure
--      mode with non-Latin scripts) and was manually corrected via
--      Canva's editing API before export. File:
--      assets/generated/ad-free-inspection.png
--    - One real Reel video (Higgsfield seedance_2_0, image-to-video
--      from the actual project1-after3.jpeg — a subtle camera
--      pan/zoom, NOT a fabricated scene) — Instagram's Reels API
--      requires real video, a static image cannot be submitted as
--      media_type=REELS. File: assets/generated/reel-basalt-pan.mp4
--    - Two posts using real photos NOT used in the deleted pilot
--      (project2-before1, project4-after2)
--    - One story using another previously-unused real photo
--      (project1-before1)
--
--  All ai_* fields are hand-authored (same "author once" principle as
--  prior batches) — ratings are NOT uniformly high; the two genuinely
--  novel formats for this page (story, before-only post) score lower
--  specifically because there's no track record yet to be confident
--  about, not because the ideas are weak.
--
--  Run once, in the Supabase SQL Editor, AFTER
--  supabase-content-queue-delete-pilot.sql.
-- =============================================================

insert into public.content_queue (
  title, caption, media_type, media_url, thumbnail_url, platform, content_category,
  scheduled_for, status, notes,
  ai_rating, ai_rating_justification, ai_optimal_timing,
  ai_reach_forecast, ai_why_it_works, ai_brand_contribution, ai_generated_at
)
values
(
  'באטש 2 — מודעה: בדיקה חינם',
  '🔍 בדיקת שטח חינם + הצעת מחיר תוך 24 שעות' || chr(10) || chr(10) ||
  'לא עוד המתנה של ימים להצעת מחיר. מר פוליש מגיע, בודק ונותן לכם מחיר ברור תוך יממה - בלי הפתעות ובלי לחץ.' || chr(10) || chr(10) ||
  '💎 מעל 30 שנות מומחיות אישית של אורי מרגלית בליטוש שיש, אבן ובטון.' || chr(10) || chr(10) ||
  '📞 השאירו פרטים או התקשרו עכשיו: 052-9534540 | mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/generated/ad-free-inspection.png', null, 'both', 'ad',
  '2026-07-13 08:00:00+00', 'pending_approval', 'Canva-generated graphic; Hebrew text was garbled by the AI generator and manually corrected before export.',
  6, 'מודעה עם CTA ברור עשויה להניב פניות ישירות טובות יותר מפוסטים רגילים, אך זהו סוג תוכן חדש לעמוד - אין נתונים היסטוריים על ביצועי מודעות/גרפיקות מעוצבות, ולכן הציון זהיר.', 'ימי ראשון-שני בבוקר (תחילת שבוע עבודה), כשאנשים מתחילים לתכנן פרויקטים.',
  'פוטנציאל גבוה יחסית להמרות (פניות בפועל) בזכות ה-CTA הישיר, גם אם מספר הלייקים עצמו עשוי להיות דומה או נמוך מפוסטי לפני-אחרי (1-3 בפייסבוק, 2-4 באינסטגרם).', 'מבדל את מר פוליש מהמתחרה "טופ פוליש" שמתמקד בהשוואת מחירים - כאן הדגש הוא על מהירות ושירות אישי, לא על הזול ביותר.', 'ממצב את מר פוליש כעסק מקצועי עם תהליך ברור ומהיר, בניגוד לתדמית של קבלן שצריך לרדוף אחריו.', now()
),
(
  'באטש 2 — רילס: אבן בזלת שחורה',
  'אבן בזלת שחורה - עוד זווית, אותו ברק מושלם 🖤✨' || chr(10) || chr(10) ||
  'כל פרויקט שאנחנו מסיימים מקבל בדיקה נוספת לפני שהוא נחשב גמור - כי הפרטים הקטנים הם מה שמבדיל ליטוש מקצועי מ"ניקיון" סתם.' || chr(10) || chr(10) ||
  '🔨 מעל 30 שנות מומחיות. באותה רמת קפדנות בכל פרויקט, קטן כגדול.' || chr(10) || chr(10) ||
  '📞 mr-polishes.com',
  'reel', 'https://mr-polishes.com/assets/generated/reel-basalt-pan.mp4', 'https://mr-polishes.com/assets/gallery/project1-after3.jpeg', 'both', 'reel',
  '2026-07-14 17:00:00+00', 'pending_approval', 'Higgsfield seedance_2_0 image-to-video, start frame = project1-after3.jpeg (subtle pan/zoom, no fabricated scene changes). Please review the actual motion quality before approving - this is the first AI-generated video on this page.',
  6, 'זהו הרילס האמיתי הראשון של העמוד (וידאו עם תנועת מצלמה, לא תמונה סטטית) - פוטנציאל גבוה להישג אלגוריתמי באינסטגרם, אך הציון נשאר זהיר כי אין עדיין נתונים על ביצועי וידאו אמיתי בעמוד הזה.', 'ימי שלישי-רביעי בערב (19:00-21:00) - שעות עומס גלישה ברילס של אינסטגרם.',
  'אינסטגרם נוטה להעדיף רילס בהפצה האורגנית - פוטנציאל חשיפה מעבר לעוקבים גבוה יותר מפוסט תמונה רגיל, גם אם קשה לכמת מראש.', 'תנועת מצלמה איטית ומוקפדת על משטח מבריק יוצרת תחושת פרימיום קולנועית - שונה מתוכן הסטילס שהיה עד כה.', 'מראה רמת הפקה גבוהה יותר מהמתחרים בתחום (שמציגים בעיקר תמונות סטטיות) - תורם לתדמית פרימיום.', now()
),
(
  'באטש 2 — פוסט: כנות לגבי לפני',
  'לפני שמתחילים - ככה נראה משטח שדורש ליטוש אמיתי 📐' || chr(10) || chr(10) ||
  'הרבה עסקים מראים רק תמונות "אחרי". אנחנו מאמינים שגם ה"לפני" הוא חלק חשוב מהסיפור - כי זה עוזר לכם לזהות מתי הגיע הזמן לחדש, ולא לחכות שהנזק יחמיר.' || chr(10) || chr(10) ||
  'אבן ירושלמית עם שכבות ישנות, אבק שנצבר ומראה עייף - נקודת התחלה טיפוסית שאנחנו רואים כל שבוע.' || chr(10) || chr(10) ||
  '📞 גם אצלכם יש משטח כזה? שלחו לנו תמונה ונגיד לכם בכנות אם הגיע הזמן: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/gallery/project2-before1.jpeg', null, 'both', 'post',
  '2026-07-15 15:00:00+00', 'pending_approval', 'Unused real photo from the pilot batch (before-image only, not paired with an after-shot in this post) - deliberate honesty/transparency angle.',
  5, 'תמונת "לפני" בלבד (ללא "אחרי" מיידי) חורגת מהפורמט שהוכיח את עצמו בעמוד - יש סיכון שהתוכן ירגיש לא גמור לחלק מהעוקבים, לכן ציון בינוני.', 'ימי חמישי-שישי, כשאנשים מתכננים סופ״ש ובודקים פרויקטים ביתיים.',
  'צפי נמוך-בינוני: 0-2 לייקים בפייסבוק, 1-3 באינסטגרם - פורמט חדש שטרם נבדק.', 'שקיפות לגבי מצב לפני אמיתי בונה אמינות ומבדלת ממתחרים שמראים רק תוצאות מושלמות.', 'מציג יושרה מקצועית - תורם לאמון לטווח ארוך, גם אם לא מניב הכי הרבה לייקים מיידיים.', now()
),
(
  'באטש 2 — פוסט: אורי אישית',
  'אני אורי מרגלית, ואני עומד מאחורי כל עבודה בשם שלי 🤝' || chr(10) || chr(10) ||
  'בשוק שמלא בחברות תיווך שרק מעבירות אתכם לקבלן הזול ביותר, החלטתי לעשות את זה אחרת: אני מגיע בעצמי, מבצע בעצמי, ועומד מאחורי התוצאה בשמי האישי.' || chr(10) || chr(10) ||
  'המדרגות האלו הן דוגמה - לא סתם "עוד עבודה", אלא פרויקט שאני זוכר.' || chr(10) || chr(10) ||
  '🔨 30 שנה, אותו אדם, אותה מחויבות.' || chr(10) || chr(10) ||
  '📞 מר פוליש: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/gallery/project4-after2.jpeg', null, 'both', 'post',
  '2026-07-16 17:00:00+00', 'pending_approval', 'First-person personal-branding post, directly informed by competitor research (most competitors in this niche present as anonymous companies/brokers, not named craftsmen).',
  7, 'תוכן אישי בגוף ראשון הוא כיוון חדש שלא נוסה בעמוד עד כה - מבוסס על תובנה אמיתית ממחקר מתחרים, ולכן ציון גבוה יחסית לפוטנציאל בידול.', 'ימי שני-שלישי בערב - זמן טוב לתוכן אישי/סיפורי שדורש קריאה מלאה.',
  'תוכן אישי/אותנטי נוטה לעורר יותר אמון ושיתופים מתוכן תאגידי - צפי 2-4 לייקים בפייסבוק, 3-5 באינסטגרם, מעט מעל הממוצע ההיסטורי.', 'מבדל ישירות מול מתחרים שפועלים כחברות/מתווכים אנונימיים (כמו טופ פוליש) - שם אמיתי ואחריות אישית הם יתרון תחרותי אמיתי.', 'בונה מותג אישי סביב אורי מרגלית עצמו, לא רק סביב "מר פוליש" כמותג - מחזק נאמנות ומבדל ממתחרים גדולים וחסרי פנים.', now()
),
(
  'באטש 2 — סטורי: שאלה מהירה',
  'משטח כזה בבית? 👀 החליקו ימינה לתשובה',
  'image', 'https://mr-polishes.com/assets/gallery/project1-before1.jpeg', null, 'instagram', 'story',
  '2026-07-17 09:00:00+00', 'pending_approval', 'First Story-format content on this page. Unused real photo.',
  4, 'זהו הסטורי הראשון של העמוד - פורמט חטוף ומהיר שקשה להעריך מראש, וללא נתוני עבר בכלל. ציון נמוך-בינוני משקף חוסר ודאות, לא איכות נמוכה של הרעיון.', 'כל יום בשעות הצהריים (12:00-14:00) - הרגל גלישה נפוץ בסטוריז בהפסקת צהריים.',
  'סטוריז נעלמים אחרי 24 שעות ובדרך כלל מניבים אינטראקציה נמוכה יותר מפיד רגיל אצל עמודים קטנים - צפי צפיות נמוך.', 'פורמט קליל ומיידי, טוב לבדיקת סקרנות/מעורבות מהירה בלי להתחייב לפוסט פיד מלא.', 'מוסיף נוכחות שוטפת בין הפוסטים המרכזיים, שומר על נראות יומיומית של המותג בלי לדרוש הרבה משאבי הפקה.', now()
);
