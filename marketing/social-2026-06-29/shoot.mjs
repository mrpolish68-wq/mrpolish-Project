// Automation: render the two HTML cards to exact-size PNGs with Playwright.
// Usage:
//   npm i -D playwright            (once)
//   npx playwright install chromium  (once)
//   node shoot.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const shots = [
  { file: "ig-story.html", out: "out/ig-story.png", w: 1080, h: 1920 },
  { file: "fb-quicktip.html", out: "out/fb-quicktip.png", w: 1080, h: 1350 },
];

const browser = await chromium.launch();
for (const s of shots) {
  const page = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 2, // crisp 2x export
  });
  await page.goto("file://" + resolve(here, s.file).replace(/\\/g, "/"));
  await page.waitForTimeout(1200); // let webfonts settle
  await page.locator(".stage").screenshot({ path: resolve(here, s.out) });
  console.log("✓", s.out);
  await page.close();
}
await browser.close();
