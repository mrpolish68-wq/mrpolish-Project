-- =============================================================
--  Mr. Polish — Content Batch 3 (rest of July, 2026-07-21 through
--  2026-07-31), built in the new standing brand voice per Ori's
--  2026-07-12 instruction: every CTA uses
--    "בדיקת התאמה ללא עלות - ייעוץ אישי מאורי"
--  with no time-boxed promises anywhere.
--
--  Material reality check first (see handoff.md §11): after Batch 2 +
--  the explainer video, only 3 of the 18 real gallery photos were
--  genuinely never-used (project2-before2, project2-after2,
--  project4-before2). This batch uses all 3, pairs 2 of them with
--  already-used-elsewhere angles (legitimate - a feed post and a
--  video montage are different contexts, and this project's own
--  original pilot already did "additional angle" posts this way),
--  and fills the rest with content that doesn't need a fresh photo:
--  a real customer testimonial (verbatim from index.html's own
--  approved reviews, not invented) and a promo push for the explainer
--  video itself.
--
--  New asset: assets/generated/testimonial-seli-sasi.jpg - same
--  brand-exact HTML/CSS -> Playwright pipeline as the Batch 2 ad card,
--  real DOM Hebrew text. Quote is copied verbatim from index.html
--  (testi5_quote / testi5_author, already public + approved on the
--  live site) - not a new/fabricated testimonial.
--
--  Ratings are deliberately uneven, same honesty principle as every
--  prior batch: the two "additional angle" posts score lowest,
--  mirroring the original pilot's own finding that repeat-angle
--  content risks audience fatigue (see
--  supabase-content-queue-pilot-rating-seed.sql, post #6, 4/10).
--
--  Run this after supabase-content-queue-batch2-fix.sql.
-- =============================================================

insert into public.content_queue (
  title, caption, media_type, media_url, thumbnail_url, platform, content_category,
  scheduled_for, status, notes,
  ai_rating, ai_rating_justification, ai_optimal_timing,
  ai_reach_forecast, ai_why_it_works, ai_brand_contribution, ai_generated_at
) values
(
  'באטש 3 — פוסט: המלצת לקוחה (Seli Sasi)',
  'מה שהלקוחות אומרים, לא מה שאנחנו אומרים על עצמנו ⭐' || chr(10) || chr(10) ||
    '"את העבודה המדהימה שלהם אי אפשר להשיג במקום אחר! באדיבות, עם חיוך, במקצועיות מטורפת ותוצאות מרהיבות!"' || chr(10) ||
    '- Seli Sasi' || chr(10) || chr(10) ||
    'תודה על האמון. אם גם אתם מחפשים תוצאה כזו -' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/generated/testimonial-seli-sasi.jpg', null, 'both', 'post',
  '2026-07-21 15:00:00+00', 'pending_approval',
  'Real testimonial, copied verbatim from index.html (testi5_quote/testi5_author) - already public/approved on the live site, not a new quote. First text-quote-card format on this page (no photo).',
  6, 'המלצת לקוחה אמיתית היא תוכן אמין ומוכח בדרך כלל, אך זהו הפורמט הראשון מסוגו (כרטיס טקסט ללא תמונת עבודה) בעמוד הזה - אין נתון היסטורי לפורמט הזה ספציפית, ולכן הציון נשאר זהיר.', 'ימי שני-שלישי אחר הצהריים.',
  'תוכן חברתי-הוכחתי נוטה לביצועים סבירים, אך קשה להעריך פורמט חדש ללא נתוני עבר.', 'ציטוט אמיתי עם 5 כוכבים בונה אמון בלי צורך "לשכנע" - הלקוחה כבר עשתה את זה.', 'מוסיף קול חיצוני ואובייקטיבי למותג, לא רק את הקול של מר פוליש עצמו.', now()
),
(
  'באטש 3 — פוסט: מדרגות חלילה, זווית נוספת',
  'מדרגות חלילה, עוד זווית מאותו הפרויקט 🪜' || chr(10) || chr(10) ||
    'לפעמים התמונה השנייה מספרת את החלק שהראשונה פספסה - הנה עוד נקודת מבט על חידוש המדרגות שביצענו.' || chr(10) || chr(10) ||
    '🔨 30 שנה, אותה קפדנות, בכל זווית ובכל פינה.' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/gallery/project4-before2.jpeg', null, 'both', 'post',
  '2026-07-23 17:00:00+00', 'pending_approval',
  'Genuinely unused photo (project4-before2) paired with the already-used project4-after1 - legitimate reuse (different context than the explainer video), but flagged as a repeat-angle post below.',
  4, 'פוסט "זווית נוספת" מאותו פרויקט - הפורמט הזה כבר הוכח כחלש יחסית בעמוד (ראו הפיילוט המקורי, פוסט 6/7, שקיבל ציון דומה מאותה סיבה בדיוק: סיכון לעייפות קהל מתוכן חוזר).', 'ימי חמישי-שישי.',
  'צפי נמוך-בינוני, בהתאם לביצועי פוסטים דומים בעבר.', 'ממשיך את סיפור הפרויקט בלי לדרוש תמונה חדשה.', 'תורם עקביות אך לא בידול - תוכן משני, לא מוביל.', now()
),
(
  'באטש 3 — סטורי: פינה נוספת השבוע',
  'עוד פינה שקיבלה טיפול השבוע 👀 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי',
  'image', 'https://mr-polishes.com/assets/gallery/project2-after2.jpeg', null, 'instagram', 'story',
  '2026-07-25 12:30:00+00', 'pending_approval',
  'Genuinely unused photo (project2-after2), reserved for this story only so it is not double-used with the 07-27 post below.',
  4, 'סטוריז ממשיכים להיות פורמט ללא נתוני עבר בעמוד הזה - ציון זהיר בהתאם, לא שיפוט על איכות התמונה.', 'שעות צהריים (12:00-14:00).',
  'צפיות נמוכות צפויות לעמוד קטן, כמו הסטורי הקודם.', 'פורמט קליל שומר על נוכחות שוטפת בין הפוסטים המרכזיים.', 'נראות יומיומית של המותג בעלות הפקה נמוכה.', now()
),
(
  'באטש 3 — פוסט: אבן ירושלמית, זווית נוספת',
  'אבן ירושלמית, עוד זווית מאותו הבית 💫' || chr(10) || chr(10) ||
    'כל פרויקט כולל בדיקה בכמה נקודות בבית, לא רק פינה אחת - כי לפעמים המשטח שדורש הכי הרבה תשומת לב לא נמצא במקום שציפיתם.' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/gallery/project2-before2.jpeg', null, 'both', 'post',
  '2026-07-27 17:00:00+00', 'pending_approval',
  'Genuinely unused photo (project2-before2) paired with project2-after1 (previously only used in the explainer video, not yet as its own feed post) - fresh feed pairing.',
  4, 'שוב פורמט "זווית נוספת" - אותה זהירות כמו פוסט המדרגות לעיל, מאותה סיבה בדיוק (סיכון לעייפות קהל).', 'ימי שני-שלישי בערב.',
  'צפי נמוך-בינוני, תואם ביצועי עבר לפורמט דומה.', 'תמונת לפני חדשה, גם אם האחרי כבר הופיע בהקשר אחר (סרטון ההסברה).', 'עקביות ולא בידול - תוכן תומך, לא מוביל.', now()
),
(
  'באטש 3 — פוסט: בית חולים מאיר, עומד בפני עצמו',
  'גם מוסדות ציבור סומכים על עבודה אישית 🏥' || chr(10) || chr(10) ||
    'בית חולים מאיר הוא דוגמה לכך שגם משטחים בתעבורה גבוהה, עם לוחות זמנים ותיאום של מוסד ציבורי, מקבלים אצלי את אותה תשומת לב כמו כל בית פרטי.' || chr(10) || chr(10) ||
    '🔨 מהבית הפרטי ועד המוסד הציבורי - אותו סטנדרט, אותה אחריות אישית.' || chr(10) || chr(10) ||
    '📞 בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'image', 'https://mr-polishes.com/assets/gallery/project5-after1.jpeg', 'https://mr-polishes.com/assets/gallery/project5-before1.jpeg', 'both', 'post',
  '2026-07-29 17:00:00+00', 'pending_approval',
  'First standalone feed post for the hospital project (previously only appeared inside the explainer video montage) - B2B credibility angle, same honest framing as the original pilot''s hospital post (no follower-based estimate; this content type has no real precedent on the page).',
  5, 'זהה בעקרון לניתוח הפיילוט המקורי לתוכן מסוג זה: פוטנציאל אמינות מוסדית גבוה, אך ללא תקדים אמיתי בעמוד להערכת מעורבות.', 'ימי רביעי-חמישי בבוקר (קהל B2B/מוסדי גולש יותר בשעות עבודה).',
  'קשה להעריך - קהל היעד לפוסט הזה עשוי להיות שונה (אדריכלים, מנהלי נכסים) מהעוקבים הרגילים.', 'שיש קרמה מבריק ואחיד הוא ההוכחה הוויזואלית החזקה ביותר לאיכות עבודה בעומס גבוה.', 'פותח דלת לפלח B2B - בדיוק הפער שמחקר המתחרים (פלורה/טופ פוליש) לא ממלא באופן אישי.', now()
),
(
  'באטש 3 — פוסט: קידום סרטון ההסברה',
  'עדיין לא ראיתם? הסרטון שמסביר מי אני ומה אני עושה 🎥' || chr(10) || chr(10) ||
    '30 שנה, 5 פרויקטים אמיתיים, ומסר אחד פשוט: אני מגיע בעצמי לכל עבודה, ועומד מאחורי התוצאה בשם שלי.' || chr(10) || chr(10) ||
    'לצפייה בסרטון המלא ולתיאום בדיקת התאמה ללא עלות - ייעוץ אישי מאורי: mr-polishes.com',
  'video', 'https://mr-polishes.com/assets/generated/explainer-video.mp4', 'https://mr-polishes.com/assets/gallery/project3-after1.jpeg', 'both', 'ad',
  '2026-07-31 19:00:00+00', 'pending_approval',
  'Reminder/promo push reusing the explainer video (queued separately for 2026-07-20 in supabase-content-queue-batch2-fix.sql) with a different caption angle ("did you see this yet") - month-end flagship push, not duplicate content.',
  5, 'תלוי לחלוטין בקליטת סרטון ההסברה המקורי, שאין לו עדיין שום נתון ביצועים - ציון זהיר עד שיהיה נתון אמיתי מהפרסום הראשון ב-20/07.', 'ימי רביעי-חמישי בערב, לאחר שהסרטון המקורי כבר פורסם ונצפה פעם אחת.',
  'תלוי בביצועי הפרסום הראשון של הסרטון - אין עדיין בסיס להערכה עצמאית.', 'תזכורת טבעית למי שפספס את הפרסום הראשון, בלי לדרוש תוכן חדש.', 'ממשיך למצב את אורי כאיש מקצוע בעל שם לאורך זמן, לא רק ברגע פרסום אחד.', now()
);
