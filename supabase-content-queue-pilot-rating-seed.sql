-- =============================================================
--  Mr. Polish — AI Rating + Optimal Timing for the 1-week pilot batch.
--  Run this AFTER supabase-content-queue-ai-rating.sql, once, in the
--  Supabase SQL Editor.
--
--  Same "author once" approach and honesty principle as
--  supabase-content-queue-pilot-ai-analysis.sql: ratings are NOT
--  uniformly optimistic — the repeat-angle post (#6) and the tip post
--  (#7) are scored lower on purpose, reflecting real risk factors
--  (audience fatigue, historically weak format) rather than defaulting
--  every piece to a high score.
--
--  Matches rows by their exact `title` from
--  supabase-content-queue-pilot-seed.sql.
-- =============================================================

update public.content_queue set
  ai_rating = 7,
  ai_rating_justification = 'תוכן לפני-אחרי עם קונטרסט חזק הוא הפורמט שביצע הכי טוב בעמוד עד כה - מזכה בציון גבוה יחסית, בכפוף לתקרת מעורבות מוגבלת בשל גודל הקהל הנוכחי (כ-309 עוקבים בפייסבוק, כ-9 באינסטגרם).',
  ai_optimal_timing = 'ימי שלישי-רביעי, 18:00-20:00, נוטים להניב גלישה פנויה רבה יותר מסופי שבוע - מומלץ לבדוק אם ניתן להזיז לחלון הזה.'
where title = 'פיילוט 1/7 — בזלת שחורה';

update public.content_queue set
  ai_rating = 7,
  ai_rating_justification = 'נושא מוכר ומעורר הזדהות אצל קהל ישראלי רחב, בשילוב פורמט לפני-אחרי מוכח - ציון דומה לפוסט הראשון.',
  ai_optimal_timing = 'דומה להמלצה הקודמת - ערב באמצע השבוע (שלישי-רביעי, 18:00-20:00) צפוי להניב חשיפה מעט טובה יותר מסוף השבוע.'
where title = 'פיילוט 2/7 — אבן ירושלמית';

update public.content_queue set
  ai_rating = 6,
  ai_rating_justification = 'פורמט לפני-אחרי מוכח, אך נושא ממוקד יותר (מדרגות ולא רצפה כללית) עשוי לצמצם מעט את קהל היעד הרלוונטי.',
  ai_optimal_timing = 'אמצע השבוע בשעות הערב (18:00-20:00) - עקבי עם שאר התוכן החזותי בעמוד.'
where title = 'פיילוט 3/7 — מדרגות חלילה';

update public.content_queue set
  ai_rating = 5,
  ai_rating_justification = 'נושא נוסטלגי שמדבר לקהל מבוגר יותר - פוטנציאל מעורבות בינוני, מוגבל יחסית לקהל הרחב יותר של תוכן בזלת/ירושלמית.',
  ai_optimal_timing = 'ימי חמישי-שישי בבוקר עשויים להתאים לקהל מבוגר יותר שגולש מוקדם יותר ביום - כדאי לבחון כאפשרות חלופית לערב.'
where title = 'פיילוט 4/7 — טרצו קלאסי';

update public.content_queue set
  ai_rating = 6,
  ai_rating_justification = 'תוכן ה-B2B/מוסדי הוא נושא חדש יחסית בעמוד, ולכן זהו ציון זהיר - אין די נתונים היסטוריים על ביצועי תוכן דומה כדי לתת ציון גבוה בביטחון מלא.',
  ai_optimal_timing = 'ימי חול בשעות הבוקר (09:00-11:00) עשויים להתאים יותר לקהל עסקי/מוסדי מאשר שעות הערב הרגילות.'
where title = 'פיילוט 5/7 — קרמה בית חולים מאיר';

update public.content_queue set
  ai_rating = 4,
  ai_rating_justification = 'פוסט חוזר על אותו פרויקט תוך שבוע - סיכון ממשי לתשישות קהל (fatigue) ולירידה במעורבות ביחס לפוסט הראשון על אותה אבן.',
  ai_optimal_timing = 'מומלץ לדחות פוסט זה בכמה ימים נוספים ביחס לפוסט הראשון על אותו פרויקט, ולא לפרסם בסמיכות זמן.'
where title = 'פיילוט 6/7 — בזלת שחורה, זווית נוספת';

update public.content_queue set
  ai_rating = 3,
  ai_rating_justification = 'פוסטים מסוג טיפ הניבו היסטורית את המעורבות הנמוכה ביותר בעמוד (אפס לייקים בשני מקרים דומים) - ציון נמוך משקף זאת באופן כן, לא כישלון של הרעיון עצמו אלא של הפורמט הספציפי הזה עד כה.',
  ai_optimal_timing = 'ימי ראשון בבוקר (תחילת שבוע) עשויים להתאים לתוכן מסוג טיפ/ייעוץ, כשקהל מתכנן פרויקטים לשבוע הקרוב.'
where title = 'פיילוט 7/7 — טיפ שבועי';
