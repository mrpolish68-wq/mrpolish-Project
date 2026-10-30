// api/_media-process.js + api/_video-meta.js with generated fixtures (sharp, no network):
// metadata is stripped (a GPS/XMP-tagged input → nothing out), sizes and the 4:5 Instagram ratio,
// EXIF rotation applied, watermark on/off (+ the original never watermarked), HEIC/HEIF refused,
// and the MP4/MOV reader (rotation, moov at the end, Range reads, validation in Hebrew).
"use strict";
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const REPO = path.resolve(__dirname, "..");
const MP = require(REPO + "/api/_media-process.js");
const VM = require(REPO + "/api/_video-meta.js");

let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; console.log("PASS " + name); } else console.log("FAIL " + name + (detail !== undefined ? "  -- " + detail : "")); }
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

// A test photo: a gradient + shapes (so the attention crop and the watermark have texture to work on).
async function photo(w, h, extra) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2b2b2b"/><stop offset="1" stop-color="#9a8c7a"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.6}" cy="${h * 0.45}" r="${Math.min(w, h) * 0.18}" fill="#d9c27a"/></svg>`;
  let img = sharp(Buffer.from(svg)).jpeg({ quality: 90 });
  if (extra) img = extra(img);
  return img.toBuffer();
}
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>SECRET-AUTHOR</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
const has = (buf, s) => buf.indexOf(Buffer.from(s, "latin1")) !== -1;
// Number of GPS entries in a JPEG's EXIF (walks IFD0 for the GPS pointer tag 0x8825);
// -1 = no EXIF segment at all, 0 = EXIF without GPS.
function gpsEntries(buf) {
  let i = 2;
  while (i < buf.length - 4 && buf[i] === 0xff) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m === 0xe1 && buf.slice(i + 4, i + 10).toString("latin1") === "Exif\0\0") {
      const t = i + 10, le = buf.slice(t, t + 2).toString() === "II";
      const r16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o), r32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
      const ifd = t + r32(t + 4), n = r16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; if (r16(e) === 0x8825) return r16(t + r32(e + 8)); }
      return 0;
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  return -1;
}


(async function main() {
  // ---------------------------------------------------------------- metadata stripped
  const tagged = await photo(4000, 3000, (i) => i.withExif({
    IFD0: { Make: "SECRET-CAM", Model: "Phone 15", Copyright: "SECRET-OWNER" },
    IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 44/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "35/1 1/1 0/1" }
  }).withXmp(XMP));
  const tm = await sharp(tagged).metadata();
  check("fixture really carries EXIF + a GPS block (4 entries) + XMP", !!tm.exif && !!tm.xmp && has(tm.exif, "SECRET-CAM") && has(tagged, "SECRET-AUTHOR") && gpsEntries(tagged) === 4, JSON.stringify({ exif: !!tm.exif, xmp: !!tm.xmp, gps: gpsEntries(tagged) }));
  const r = await MP.processImage(tagged, { watermark: false });
  const outs = { original: r.original, w480: r.variants.w480, w960: r.variants.w960, w1600: r.variants.w1600, jpg: r.variants.jpg, ig: r.ig };
  let clean = true, detail = [];
  for (const k of Object.keys(outs)) {
    const m = await sharp(outs[k].buffer).metadata();
    const bad = m.exif || m.xmp || m.iptc || m.icc || m.orientation || has(outs[k].buffer, "SECRET") || has(outs[k].buffer, "Exif\0") || (outs[k].format === "jpeg" && gpsEntries(outs[k].buffer) !== -1);
    if (bad) { clean = false; detail.push(k); }
  }
  check("GPS / EXIF / XMP / ICC in → NOTHING out, in all 6 outputs", clean, detail.join(","));

  // ---------------------------------------------------------------- sizes, formats, 4:5
  check("original: long edge ≤ 2560 (4000×3000 → 2560×1920), JPEG", r.original.width === 2560 && r.original.height === 1920 && r.original.format === "jpeg");
  check("site variants: w480 / w960 / w1600 WebP", r.variants.w480.width === 480 && r.variants.w960.width === 960 && r.variants.w1600.width === 1600 &&
    ["w480", "w960", "w1600"].every(k => r.variants[k].format === "webp"));
  check("site variants keep the aspect ratio (1600×1200)", r.variants.w1600.height === 1200 && r.variants.w480.height === 360);
  check("one JPEG fallback at 1600 px", r.variants.jpg.format === "jpeg" && r.variants.jpg.width === 1600);
  check("Instagram: exactly 1080×1350 (4:5) JPEG", r.ig.width === 1080 && r.ig.height === 1350 && r.ig.format === "jpeg");
  check("WebP is much smaller than the JPEG fallback at the same width", r.variants.w1600.bytes < r.variants.jpg.bytes);
  const small = await MP.processImage(await photo(800, 600), { watermark: false });
  check("a small photo is never enlarged (800 px stays 800) — but IG is still 1080×1350", small.original.width === 800 && small.variants.w1600.width === 800 &&
    small.variants.w960.width === 800 && small.ig.width === 1080 && small.ig.height === 1350);
  const portrait = await MP.processImage(await photo(3000, 4000), { watermark: false });
  check("portrait: 3000×4000 → original 1920×2560, IG still 4:5", portrait.original.width === 1920 && portrait.original.height === 2560 && portrait.ig.height === 1350);

  // ---------------------------------------------------------------- EXIF rotation applied
  const halves = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="300" height="400" fill="#ff0000"/><rect x="300" width="300" height="400" fill="#0000ff"/></svg>`);
  const rotated = await sharp(halves).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rr = await MP.processImage(rotated, { watermark: false });
  const px = await sharp(rr.original.buffer).extract({ left: 200, top: 20, width: 1, height: 1 }).raw().toBuffer();
  check("EXIF orientation 6 is applied: 600×400 → 400×600, the red half is on top", rr.original.width === 400 && rr.original.height === 600 && px[0] > 200 && px[2] < 60, rr.original.width + "x" + rr.original.height + " " + [...px]);

  // ---------------------------------------------------------------- transparency → white
  const png = await sharp({ create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const pr = await MP.processImage(png, { watermark: false });
  const wpx = await sharp(pr.original.buffer).extract({ left: 250, top: 250, width: 1, height: 1 }).raw().toBuffer();
  check("transparent PNG → flattened onto white (JPEG has no alpha)", pr.inputType === "png" && wpx[0] > 245 && wpx[1] > 245 && wpx[2] > 245, [...wpx].join(","));

  // ---------------------------------------------------------------- watermark
  const src = await photo(3000, 2000);
  const off = await MP.processImage(src, { watermark: false });
  const on = await MP.processImage(src, { watermark: true });
  check("watermark off → none; on → the default style 'wordmark'", off.watermark === null && on.watermark === "wordmark");
  check("the ORIGINAL is never watermarked (identical bytes on/off)", off.original.buffer.equals(on.original.buffer));
  const rawOff = await sharp(off.variants.jpg.buffer).raw().toBuffer({ resolveWithObject: true });
  const rawOn = await sharp(on.variants.jpg.buffer).raw().toBuffer({ resolveWithObject: true });
  const W = rawOn.info.width, H = rawOn.info.height, C = rawOn.info.channels;
  let minX = W, maxX = 0, minY = H, maxY = 0, changed = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * C;
    const d = Math.abs(rawOn.data[i] - rawOff.data[i]) + Math.abs(rawOn.data[i + 1] - rawOff.data[i + 1]) + Math.abs(rawOn.data[i + 2] - rawOff.data[i + 2]);
    if (d > 40) { changed++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const wmWidth = (maxX - minX + 1) / W;
  check("watermark sits in the bottom-RIGHT corner", changed > 500 && minX > W * 0.75 && minY > H * 0.8 && maxX < W && maxY < H, JSON.stringify({ minX, maxX, minY, maxY, W, H }));
  check("watermark is ~12% of the width (subtle)", wmWidth > 0.09 && wmWidth < 0.13, wmWidth.toFixed(3));
  const igOff = await sharp(off.ig.buffer).raw().toBuffer(), igOn = await sharp(on.ig.buffer).raw().toBuffer();
  check("watermark also on the Instagram image", !igOff.equals(igOn));
  for (const style of ["badge", "url"]) {
    const s = await MP.processImage(src, { watermark: true, watermarkStyle: style });
    check("style '" + style + "' renders and differs from the wordmark", s.watermark === style && !s.variants.jpg.buffer.equals(on.variants.jpg.buffer));
  }
  check("an unknown style falls back to the default", (await MP.processImage(src, { watermark: true, watermarkStyle: "nope" })).watermark === "wordmark");
  check("the 3 watermark PNGs exist with transparency", ["wordmark", "badge", "url"].every(n => fs.existsSync(path.join(REPO, "assets/watermark", n + ".png"))) &&
    (await Promise.all(["wordmark", "badge", "url"].map(n => sharp(path.join(REPO, "assets/watermark", n + ".png")).metadata()))).every(m => m.hasAlpha));

  // ---------------------------------------------------------------- refused inputs
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(200)]);
  let e = await errOf(MP.processImage(heic));
  check("HEIC refused with code heic_unsupported + a Hebrew message", e && e.code === "heic_unsupported" && /HEIC/.test(e.he) && /תמונה/.test(e.he), e && e.code);
  e = await errOf(MP.processImage(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmif1", "latin1"), Buffer.alloc(200)])));
  check("generic HEIF (mif1) refused too", e && e.code === "heic_unsupported");
  e = await errOf(MP.processImage(Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(100)])));
  check("GIF → unsupported_type", e && e.code === "unsupported_type");
  e = await errOf(MP.processImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)])));
  check("a corrupt JPEG → decode_failed (Hebrew)", e && e.code === "decode_failed" && /לא הצלחנו/.test(e.he), e && e.code);
  const big = Buffer.alloc(51 * 1024 * 1024); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  e = await errOf(MP.processImage(big));
  check("over 50 MB → too_large", e && e.code === "too_large");
  check("type comes from the bytes, not a name: a PNG is 'png', a JPEG 'jpeg'", MP.detectImageType(png) === "png" && MP.detectImageType(src) === "jpeg");

  // ---------------------------------------------------------------- video metadata
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const box = (type, ...parts) => { const p = Buffer.concat(parts); return Buffer.concat([u32(8 + p.length), Buffer.from(type, "latin1"), p]); };
  const full = (v, f) => Buffer.from([v, 0, 0, f || 0]);
  const fx = (n) => u32(Math.round(n * 65536) >>> 0);
  function matrix(deg) {
    const c = Math.round(Math.cos(deg * Math.PI / 180)), s = Math.round(Math.sin(deg * Math.PI / 180));
    return Buffer.concat([fx(c), fx(s), u32(0), fx(-s), fx(c), u32(0), u32(0), u32(0), u32(0x40000000)]);
  }
  function mvhd(timescale, duration, v1) {
    if (v1) { const d = Buffer.alloc(8); d.writeBigUInt64BE(BigInt(duration)); return box("mvhd", full(1), Buffer.alloc(16), u32(timescale), d, Buffer.alloc(80)); }
    return box("mvhd", full(0), Buffer.alloc(8), u32(timescale), u32(duration), Buffer.alloc(80));
  }
  const tkhd = (w, h, deg) => box("tkhd", full(0, 3), Buffer.alloc(36), matrix(deg), fx(w), fx(h));
  const trak = (handler, codec, w, h, deg) => box("trak", tkhd(w, h, deg),
    box("mdia", box("hdlr", full(0), u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12)),
      box("minf", box("stbl", box("stsd", full(0), u32(1), box(codec, Buffer.alloc(16)))))));
  function mp4(o) {
    const ftyp = box("ftyp", Buffer.from(o.brand || "isom", "latin1"), u32(512), Buffer.from("isomiso2avc1mp41", "latin1"));
    const moov = box("moov", mvhd(1000, Math.round(o.duration * 1000), o.v1), trak("vide", o.codec || "avc1", o.w || 1920, o.h || 1080, o.deg || 0), trak("soun", "mp4a", 0, 0, 0));
    const mdat = box("mdat", Buffer.alloc(o.mdat || 2048));
    return o.moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
  }
  let v = mp4({ duration: 19.05 });
  let m = await VM.readMp4Meta(VM.bufferReader(v), v.length);
  check("MP4: duration 19.05 s, 1920×1080, H.264 + AAC, rotation 0", m.durationSec === 19.05 && m.width === 1920 && m.height === 1080 && m.videoCodec === "avc1" && m.audioCodec === "mp4a" && m.rotation === 0 && m.container === "isom", JSON.stringify(m));
  v = mp4({ duration: 12, deg: 90 });
  m = await VM.readMp4Meta(VM.bufferReader(v), v.length);
  check("rotation 90 (a phone video) → reported 90 and the display size is portrait 1080×1920", m.rotation === 90 && m.width === 1080 && m.height === 1920, JSON.stringify(m));
  v = mp4({ duration: 8, brand: "qt  ", v1: true, codec: "hvc1" });
  m = await VM.readMp4Meta(VM.bufferReader(v), v.length);
  check("MOV (qt) + a version-1 mvhd + HEVC", m.container === "qt" && m.durationSec === 8 && VM.validateVideo(m).videoCodecName === "HEVC", JSON.stringify(m));
  const late = mp4({ duration: 30, moovLast: true, mdat: 3 * 1024 * 1024 });
  let bytesRead = 0, reads = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const [a, b] = init.headers.Range.replace("bytes=", "").split("-").map(Number);
    const chunk = late.subarray(a, Math.min(late.length, b + 1));
    bytesRead += chunk.length; reads++;
    return { status: 206, arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length) };
  };
  m = await VM.readMp4Meta(VM.httpRangeReader("https://storage.test/x.mp4", {}), late.length);
  global.fetch = realFetch;
  check("moov at the END, read over HTTP Range: correct, and only a few KB of a 3 MB file are fetched", m.durationSec === 30 && bytesRead < 4096 && reads <= 6, bytesRead + " bytes in " + reads + " reads");
  const reel = fs.readFileSync(path.join(REPO, "assets/generated/reel-basalt-story.mp4"));
  m = await VM.readMp4Meta(VM.bufferReader(reel), reel.length);
  check("a real reel from the repo: 1080×1920, 19.05 s, H.264", m.width === 1080 && m.height === 1920 && m.durationSec === 19.05 && m.videoCodec === "avc1");
  e = await errOf(Promise.resolve().then(() => VM.validateVideo(Object.assign({}, m, { size: 51 * 1024 * 1024 }))));
  check("> 50 MB → too_large, Hebrew", e && e.code === "too_large" && /גדול מדי/.test(e.he));
  v = mp4({ duration: 10, codec: "vp09" });
  e = await errOf(VM.readMp4Meta(VM.bufferReader(v), v.length).then(VM.validateVideo));
  check("VP9 → unsupported_codec, Hebrew", e && e.code === "unsupported_codec" && /MP4/.test(e.he));
  v = mp4({ duration: 2 });
  e = await errOf(VM.readMp4Meta(VM.bufferReader(v), v.length).then(VM.validateVideo));
  check("2 s → too_short", e && e.code === "too_short");
  v = mp4({ duration: 16 * 60 });
  e = await errOf(VM.readMp4Meta(VM.bufferReader(v), v.length).then(VM.validateVideo));
  check("16 min → too_long", e && e.code === "too_long");
  e = await errOf(VM.readMp4Meta(VM.bufferReader(src), src.length));
  check("not an MP4 (a JPEG) → not_mp4, Hebrew", e && e.code === "not_mp4" && /MP4/.test(e.he));

  console.log("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { console.log("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
