# Command 7 — the ONE real end-to-end publish test (plan, for the owner's approval at the final audit)

**Nothing here has been run.** Command 7 was tested against Meta only with mocks plus read-only calls (`debug_token`, posts / media / comments reads). This is the single real test, to run once, after the merge checklist (§34.6) and before telling Miri the feature is live.

## Goal
Prove that one real project goes from the bot to Facebook + Instagram through the real pipeline:
- carousel → Facebook multi-photo post + Instagram carousel
- video → Facebook video + Instagram Reel, using the two-phase container
- the Telegram ✅ notifications, the project_publications rows, and later the 7-day video retention

## Preconditions (all must be true)
1. The branch is merged and production is redeployed (`publish-scheduled-content` maxDuration 120, the new helpers live). `supabase-command7.sql` is already applied (2026-10-31).
2. The pg_cron `publish-every-10-min` job ran OK in the last hour, and `waiting` = 0. No other post is due within ±1 hour of the test slot.
3. `debug_token` is valid and data access is > 14 days away (currently 2027-01-28).
4. Instagram publishing quota used < 90 / 100 in the last 24 h.
5. A **real, consented project** that the owner is happy to have public: 3–4 photos (2 before/after pairs) + **one short video** (MP4/MOV H.264, 10–30 s, < 50 MB). It must have no privacy flags, and Miri has read and approved the caption.

## Steps (owner + Claude together)
| # | Who | Action | Expected |
|---|---|---|---|
| 1 | Miri | Production bot: 📸 פרויקט חדש → photos + video → ✅ סיימתי → consent yes → destinations **פייסבוק + אינסטגרם** (not story, not site) → timing **⚡ עכשיו** → ✅ אשר | The reply lists "📣 פוסט תמונות: בסבב הבא" and "🎬 סרטון: <next free slot>" |
| 2 | Claude (read-only SQL) | Check content_queue for `project_id` | 2 rows `approved`: `carousel` (platform both, 3–4 media_items with `ig_url`) + `reel` (`storage://project-originals/…`); 4 project_publications rows |
| 3 | pg_cron (≤ 10 min) | The carousel's run | FB: one post with all photos; IG: a carousel; row `published`; Telegram ✅ with both buttons |
| 4 | pg_cron (at the reel's slot) | Phase 1 | FB video posted; row stays `approved` with `ig_container_id`, `IN_PROGRESS`; **no** Telegram message yet |
| 5 | pg_cron (next 1–3 runs) | Phase 2 | `FINISHED` → Reel published → row `published`; Telegram ✅ "פייסבוק: ✅ פורסם / אינסטגרם: ✅ פורסם" |
| 6 | Owner | Open both posts from the Telegram buttons | Photos in order (before → after), the watermark, the caption and the CTA are correct; the video plays |
| 7 | Claude | +7 days: read-only check | The video file is gone from project-originals, `project_media.file_deleted_at` is set, the posts are untouched |

## Stop / rollback
- Anything unexpected at step 2 → reject the rows in the panel (✋ דחה) before the run. Nothing has reached Meta yet.
- A Facebook post that is wrong → the owner deletes it in Facebook (the API also supports `DELETE /{post-id}`). An Instagram post that is wrong → the owner deletes it in the app (API deletion is unverified).
- An `ERROR` / `EXPIRED` container → the row goes `failed` with a reason, and the auto-retry re-uploads at most twice. To stop it: ✋ דחה in the panel.
- Never re-approve a row that already has `fb_post_id`. The pipeline skips Facebook anyway, but check first.

## What it costs
1 Gemini analysis unit, 2 posts on each platform (real, public), Instagram quota ≈ 2–3 calls.
