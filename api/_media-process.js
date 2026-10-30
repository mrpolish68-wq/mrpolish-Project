// Image processing for project media (media-projects plan, Phase 8; decisions D4 watermark, D5 originals).
// Used by api/media.js (panel uploads) and, later, the Telegram bot. Pure: buffers in, buffers out.
//
// One decode, every output from the same pixels (no double compression):
//   1. refuse anything that isn't JPEG / PNG / WebP — HEIC/HEIF gets its own code (`heic_unsupported`):
//      sharp's prebuilt libvips can't decode HEVC (patent), and the bot asks Miri to send a *photo*;
//   2. auto-rotate from EXIF, flatten transparency onto white, convert to sRGB, fit inside 2560 px;
//   3. encode: the ORIGINAL (≤ 2560 px JPEG q85, never watermarked, kept privately — D5);
//      site variants w480 / w960 / w1600 WebP + one w1600 JPEG fallback; Instagram 1080×1350 (4:5)
//      JPEG with sharp's attention crop (every carousel slide uses the same 4:5 ratio).
//   4. the watermark (only when the project's `watermark` is on — D4) goes on the variants + IG,
//      never on the original.
// Metadata: sharp writes NO EXIF / GPS / XMP / IPTC / ICC unless asked (pixels are converted to sRGB
// first, so no profile = sRGB). tests/media-process.test.js proves it on a GPS-tagged input.
"use strict";

const path = require("path");
const sharp = require("sharp");

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100 * 1000 * 1000;   // a decompression-bomb guard (a 12 MP photo is ~12 M)
const ORIGINAL_MAX_EDGE = 2560;
const SITE_WIDTHS = [480, 960, 1600];
const IG_SIZE = { width: 1080, height: 1350 };  // 4:5
const WATERMARK_MIN_PX = 60;
const WATERMARK_MARGIN = 0.03;                  // of the shorter side
// The three designs rendered by tools/render-watermarks.js, each with its width (share of the
// output width) and opacity. Owner decision 2026-10-30: the BADGE, 20% smaller than the first
// 12% (≈ 9.6%), at 85% opacity — the default everywhere.
const WATERMARKS = {
  badge:    { width: 0.096, opacity: 0.85 },
  wordmark: { width: 0.12,  opacity: 1 },
  url:      { width: 0.12,  opacity: 1 }
};
const WATERMARK_STYLES = Object.keys(WATERMARKS);
const DEFAULT_WATERMARK_STYLE = "badge";
const WATERMARK_WIDTH = WATERMARKS[DEFAULT_WATERMARK_STYLE].width;
const WATERMARK_DIR = path.join(__dirname, "..", "assets", "watermark");

class MediaError extends Error {
  constructor(code, message, he) {
    super(message);
    this.code = code;
    this.he = he;   // a short Hebrew message the panel / bot can show as-is
  }
}

// ---- type detection by magic bytes (never by the file name or the claimed content type) ----
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif", "avis"];
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 4, 8) === "ftyp" && HEIF_BRANDS.indexOf(buf.toString("latin1", 8, 12)) !== -1) return "heif";
  return null;
}

function assertSupportedImage(buf) {
  var type = detectImageType(buf);
  if (type === "heif") {
    throw new MediaError("heic_unsupported", "HEIC/HEIF images are not supported",
      "הקובץ בפורמט HEIC של אייפון. שלחו אותו כתמונה רגילה (לא כקובץ) או צלמו מסך, ונסו שוב.");
  }
  if (!type) {
    throw new MediaError("unsupported_type", "Only JPEG, PNG and WebP images are supported",
      "סוג הקובץ לא נתמך. אפשר להעלות תמונות JPG, PNG או WebP.");
  }
  if (buf.length > MAX_INPUT_BYTES) {
    throw new MediaError("too_large", "Image is larger than 50 MB", "התמונה גדולה מדי (מעל 50MB).");
  }
  return type;
}

// ---- watermark ----
var wmCache = {};
async function watermarkFor(style, outWidth, outHeight) {
  if (WATERMARK_STYLES.indexOf(style) === -1) style = DEFAULT_WATERMARK_STYLE;
  var spec = WATERMARKS[style];
  var w = Math.max(WATERMARK_MIN_PX, Math.round(outWidth * spec.width));
  var key = style + ":" + w;
  if (!wmCache[key]) {
    var img = sharp(path.join(WATERMARK_DIR, style + ".png")).resize({ width: w });
    if (spec.opacity < 1) {
      // composite has no opacity option: scale the PNG's own alpha (dest-in with a constant alpha)
      img = sharp(await img.png().toBuffer()).composite([{
        input: Buffer.from([255, 255, 255, Math.round(255 * spec.opacity)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in"
      }]);
    }
    wmCache[key] = await img.png().toBuffer({ resolveWithObject: true });
  }
  var wm = wmCache[key];
  var margin = Math.round(Math.min(outWidth, outHeight) * WATERMARK_MARGIN);
  // bottom RIGHT: the site's "before" badge sits bottom-left and "after" top-right, so this corner is free
  return { input: wm.data, left: Math.max(0, outWidth - wm.info.width - margin), top: Math.max(0, outHeight - wm.info.height - margin) };
}

async function fromRaw(base, opts) {
  var img = sharp(base.data, { raw: base.info });
  if (opts.resize) img = img.resize(opts.resize);
  var sized = await img.raw().toBuffer({ resolveWithObject: true });
  var out = sharp(sized.data, { raw: sized.info });
  if (opts.watermark) out = out.composite([await watermarkFor(opts.watermark, sized.info.width, sized.info.height)]);
  out = opts.format === "webp" ? out.webp({ quality: opts.quality || 80, effort: 4 }) : out.jpeg({ quality: opts.quality || 85, mozjpeg: true });
  var res = await out.toBuffer({ resolveWithObject: true });
  return { buffer: res.data, width: res.info.width, height: res.info.height, format: res.info.format, bytes: res.data.length };
}

// processImage(buffer, { watermark: boolean, watermarkStyle?: 'wordmark'|'badge'|'url' })
//   → { inputType, original, variants: { w480, w960, w1600, jpg }, ig, watermark: style|null }
async function processImage(buffer, opts) {
  opts = opts || {};
  var inputType = assertSupportedImage(buffer);
  var base;
  try {
    base = await sharp(buffer, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()                                                   // EXIF orientation → pixels
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .resize({ width: ORIGINAL_MAX_EDGE, height: ORIGINAL_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new MediaError("decode_failed", "The image could not be read: " + err.message, "לא הצלחנו לקרוא את התמונה. נסו קובץ אחר.");
  }

  var wm = opts.watermark ? (WATERMARK_STYLES.indexOf(opts.watermarkStyle) !== -1 ? opts.watermarkStyle : DEFAULT_WATERMARK_STYLE) : null;
  var original = await fromRaw(base, { format: "jpeg", quality: 85 });
  var variants = {};
  for (var i = 0; i < SITE_WIDTHS.length; i++) {
    var w = SITE_WIDTHS[i];
    variants["w" + w] = await fromRaw(base, { resize: { width: w, withoutEnlargement: true }, format: "webp", quality: 80, watermark: wm });
  }
  variants.jpg = await fromRaw(base, { resize: { width: 1600, withoutEnlargement: true }, format: "jpeg", quality: 82, watermark: wm });
  var ig = await fromRaw(base, {
    resize: { width: IG_SIZE.width, height: IG_SIZE.height, fit: "cover", position: sharp.strategy.attention },
    format: "jpeg", quality: 85, watermark: wm
  });
  return { inputType: inputType, original: original, variants: variants, ig: ig, watermark: wm };
}

module.exports = {
  processImage, detectImageType, assertSupportedImage, MediaError,
  MAX_INPUT_BYTES, ORIGINAL_MAX_EDGE, SITE_WIDTHS, IG_SIZE, WATERMARK_STYLES, DEFAULT_WATERMARK_STYLE, WATERMARK_WIDTH
};
