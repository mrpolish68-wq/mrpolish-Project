# Mr. Polish — Social Assets (2026-06-29)
Follow-up content for the marble article: *"How to Repair Scratches on Marble Without Causing Damage."*

All assets are **brand-exact** — colors and fonts mirror the website `styles.css`
(Charcoal `oklch(0.17 0.006 264)` + Gold `oklch(0.82 0.13 88)`, Heebo + Playfair Display).

---

## 1 + 2 · Image cards (Instagram Story + Facebook Quick-Tip)
Self-contained HTML — open in any Chrome browser, or auto-export to PNG.

| File | Output | Size |
|------|--------|------|
| `ig-story.html`    | Instagram Story | 1080 × 1920 (9:16) |
| `fb-quicktip.html` | Facebook post   | 1080 × 1350 (4:5)  |

### Export to PNG (one command)
```bash
cd marketing/social-2026-06-29
npm i -D playwright
npx playwright install chromium
node shoot.mjs          # → out/ig-story.png  +  out/fb-quicktip.png  (2x, crisp)
```
Or simply open each `.html`, hit screenshot at the listed resolution.

---

## 3 · 15-second Reel / TikTok  (Remotion project)
Real production project — renders to MP4. 1080×1920, 30fps, 4 scenes:
hook → blot gently → rinse → shine + CTA. Burned-in Hebrew captions + gold progress bar.

```bash
cd reel-remotion
npm install
npm run dev        # opens Remotion Studio to preview/tweak live
npm run render     # → out/marble-reel.mp4
```

### Optional voiceover (HeyGen / any TTS)
The script auto-runs caption-only. To add narration:
1. Generate an mp3 of the VO line (see bottom of `src/MarbleReel.tsx`) —
   in HeyGen pick a Hebrew voice, paste the script, export audio.
2. Save it as `reel-remotion/public/vo.mp3`.
3. Un-comment the `Audio` import + `<Audio src={staticFile("vo.mp3")} />` in `MarbleReel.tsx`.

---

## Captions to paste when posting
- **IG Story:** add the "Link" sticker → marble article URL.
- **FB Quick-Tip & Reel captions:** use the Hebrew copy from the content brief (kept brand name as `Mr. Polish`).
