// shared/media-client.js in Chrome (playwright-core): prepareImage (orientation, ≤ 2560 px, metadata
// gone), HEIC refused where the browser can't decode it, a video cover frame, and the TUS upload
// (6 MB chunks, headers, progress, a failed chunk resumed from the server's offset, resume after a
// "reload"). A local static server + a MOCK TUS server (page.route). Nothing reaches Supabase.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { chromium } = require("playwright-core");

const ROOT = path.resolve(__dirname, "..");
let fixture = null;
const server = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (u === "/__mc__.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end('<!doctype html><meta charset="utf-8"><script src="/shared/media-client.js"></script>'); return; }
  if (u === "/__fixture.jpg") { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(fixture); return; }
  const p = path.join(ROOT, decodeURIComponent(u));
  if (!p.startsWith(path.normalize(ROOT)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": p.endsWith(".js") ? "text/javascript" : p.endsWith(".mp4") ? "video/mp4" : "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
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
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, PATCH, HEAD, OPTIONS",
  "access-control-expose-headers": "Location, Upload-Offset, Upload-Length, Tus-Resumable" };

(async () => {
  fixture = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#7a6a55" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="2000"><rect width="1500" height="2000" fill="#ff0000"/></svg>'), left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: "SECRET-CAM" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 44/1 0/1" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const fm = await sharp(fixture).metadata();

  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await (await browser.newContext()).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // ---- mock TUS server ----
  const tus = { uploads: {}, posts: [], patches: [], heads: 0, failNextAt: null };
  await page.route("https://tus.test/**", async (route) => {
    const req = route.request(), m = req.method(), h = req.headers();
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (m === "POST") {
      const id = "u" + (tus.posts.length + 1);
      tus.posts.push(h);
      tus.uploads[id] = { length: Number(h["upload-length"]), chunks: [] };
      return route.fulfill({ status: 201, headers: Object.assign({ Location: "https://tus.test/upload/resumable/" + id, "Tus-Resumable": "1.0.0" }, CORS) });
    }
    const id = req.url().split("/").pop(), up = tus.uploads[id];
    const offset = up ? up.chunks.reduce((s, c) => s + c.length, 0) : 0;
    if (m === "HEAD") {
      tus.heads++;
      if (!up) return route.fulfill({ status: 404, headers: CORS });
      return route.fulfill({ status: 200, headers: Object.assign({ "Upload-Offset": String(offset), "Upload-Length": String(up.length), "Tus-Resumable": "1.0.0" }, CORS) });
    }
    if (m === "PATCH") {
      const body = req.postDataBuffer() || Buffer.alloc(0);
      tus.patches.push({ id, offset: Number(h["upload-offset"]), size: body.length, ct: h["content-type"], tr: h["tus-resumable"], auth: h["authorization"], apikey: h["apikey"] });
      if (tus.failNextAt !== null && Number(h["upload-offset"]) === tus.failNextAt) { tus.failNextAt = null; return route.fulfill({ status: 500, headers: CORS }); }
      if (Number(h["upload-offset"]) !== offset) return route.fulfill({ status: 409, headers: CORS });
      up.chunks.push(body);
      return route.fulfill({ status: 204, headers: Object.assign({ "Upload-Offset": String(offset + body.length), "Tus-Resumable": "1.0.0" }, CORS) });
    }
    return route.fulfill({ status: 405, headers: CORS });
  });

  await page.goto(base + "/__mc__.html");
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };

  // ---- prepareImage ----
  check("fixture: 3000×2000 with EXIF orientation 6 + a GPS block", fm.width === 3000 && fm.orientation === 6 && gpsEntries(fixture) > 0, JSON.stringify({ o: fm.orientation, gps: gpsEntries(fixture) }));
  const prep = await page.evaluate(async () => {
    const b = await (await fetch("/__fixture.jpg")).blob();
    const r = await MrpMediaClient.prepareImage(new File([b], "IMG_1.jpg", { type: "image/jpeg" }));
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { w: r.width, h: r.height, type: r.blob.type, b64: btoa(s) };
  });
  const out = Buffer.from(prep.b64, "base64"), om = await sharp(out).metadata();
  check("prepareImage: orientation applied + fits 2560 (3000×2000 rot 6 → 1707×2560), JPEG", prep.w === 1707 && prep.h === 2560 && om.width === 1707 && om.height === 2560 && prep.type === "image/jpeg", prep.w + "x" + prep.h);
  check("prepareImage: NO EXIF / GPS / orientation in the output", !om.exif && !om.orientation && out.indexOf(Buffer.from("SECRET-CAM")) === -1 && gpsEntries(out) === -1);
  const top = await sharp(out).extract({ left: 850, top: 30, width: 1, height: 1 }).raw().toBuffer();
  check("prepareImage: the red half ends up on top (rotated, not just resized)", top[0] > 200 && top[1] < 80, [...top].join(","));
  const small = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 640; c.height = 480;
    const b = await new Promise(r => c.toBlob(r, "image/png"));
    const res = await MrpMediaClient.prepareImage(new File([b], "s.png", { type: "image/png" }));
    return [res.width, res.height, res.blob.type];
  });
  check("prepareImage: a small PNG is not enlarged, comes out as JPEG", small[0] === 640 && small[1] === 480 && small[2] === "image/jpeg", small.join(","));

  // ---- HEIC ----
  const heic = await page.evaluate(async () => {
    const bytes = new Uint8Array(64); bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]);   // ....ftypheic
    try { await MrpMediaClient.prepareImage(new File([bytes], "IMG_2.HEIC", { type: "image/heic" })); return "no error"; }
    catch (e) { return e.code + "|" + e.he; }
  });
  check("HEIC that Chrome can't decode → heic_unsupported with a Hebrew hint", /^heic_unsupported\|.*HEIC/.test(heic), heic);
  check("isHeic by type or name", await page.evaluate(() => MrpMediaClient.isHeic({ type: "image/heif", name: "a" }) && MrpMediaClient.isHeic({ type: "", name: "b.HEIC" }) && !MrpMediaClient.isHeic({ type: "image/jpeg", name: "c.jpg" })));

  // ---- video cover + info ----
  const vid = await page.evaluate(async () => {
    const b = await (await fetch("/assets/hero-bg.mp4")).blob();
    const f = new File([b], "v.mp4", { type: "video/mp4" });
    const info = await MrpMediaClient.readVideoInfo(f);
    const fr = await MrpMediaClient.captureVideoFrame(f, { at: 1 });
    return { info, w: fr.width, h: fr.height, type: fr.blob.type, size: fr.blob.size, d: fr.duration };
  });
  check("readVideoInfo: 1920×1080, ~4 s", vid.info.width === 1920 && vid.info.height === 1080 && Math.abs(vid.info.duration - 4.06) < 0.2, JSON.stringify(vid.info));
  check("captureVideoFrame: a JPEG cover 1920×1080 from the video", vid.type === "image/jpeg" && vid.w === 1920 && vid.h === 1080 && vid.size > 5000, JSON.stringify(vid));

  // ---- TUS: chunks, headers, progress, a failed chunk resumed ----
  const SIX = 6 * 1024 * 1024;
  tus.failNextAt = SIX;   // the 2nd chunk fails once
  const up = await page.evaluate(async (SIX) => {
    const n = 2 * SIX + 1024 * 1024 + 123, data = new Uint8Array(n);
    let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; data[i] = x >>> 24; }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map(b => b.toString(16).padStart(2, "0")).join("");
    const prog = [];
    const r = await MrpMediaClient.tusUpload({ endpoint: "https://tus.test/upload/resumable", accessToken: "user-jwt-fake", apikey: "anon-fake",
      bucket: "project-originals", path: "p1/x.mp4", file: new File([data], "x.mp4", { type: "video/mp4" }), contentType: "video/mp4", onProgress: (p) => prog.push(p) });
    const left = Object.keys(localStorage).filter(k => k.startsWith("mrp_tus:"));
    return { r, hash, n, prog, left };
  }, SIX);
  const assembled = Buffer.concat(tus.uploads.u1.chunks);
  check("TUS: the file arrives complete and byte-identical (SHA-256)", assembled.length === up.n && crypto.createHash("sha256").update(assembled).digest("hex") === up.hash);
  const okPatches = tus.patches.filter(p => p.id === "u1");
  check("TUS: 6 MB chunks (Supabase's required size), the last one smaller", okPatches.filter(p => p.size === SIX).length >= 2 && okPatches[okPatches.length - 1].size === 1024 * 1024 + 123,
    okPatches.map(p => p.offset + ":" + p.size).join(" "));
  check("TUS: the failed chunk → HEAD → resumed from the server's offset (sent twice, file still correct)", tus.heads === 1 && okPatches.filter(p => p.offset === SIX).length === 2);
  const post = tus.posts[0];
  const metaPairs = Object.fromEntries(post["upload-metadata"].split(",").map(s => s.split(" ")).map(([k, v]) => [k, Buffer.from(v, "base64").toString()]));
  check("TUS create: Tus-Resumable 1.0.0, Upload-Length, the user's session + apikey, x-upsert", post["tus-resumable"] === "1.0.0" && Number(post["upload-length"]) === up.n &&
    post.authorization === "Bearer user-jwt-fake" && post.apikey === "anon-fake" && post["x-upsert"] === "true");
  check("TUS metadata: bucketName / objectName / contentType", metaPairs.bucketName === "project-originals" && metaPairs.objectName === "p1/x.mp4" && metaPairs.contentType === "video/mp4", JSON.stringify(metaPairs));
  check("TUS PATCH headers: offset+octet-stream, Tus-Resumable, auth", okPatches.every(p => p.ct === "application/offset+octet-stream" && p.tr === "1.0.0" && p.auth === "Bearer user-jwt-fake"));
  check("TUS progress: rises to exactly 1", up.prog.length > 3 && up.prog[up.prog.length - 1] === 1 && up.prog.every((p, i) => i === 0 || p >= up.prog[i - 1] || p >= 0.4), up.prog.slice(-3).join(","));
  check("TUS: the resume record is cleared after success", up.left.length === 0 && up.r.path === "p1/x.mp4");

  // ---- TUS: resume after a page reload (localStorage) ----
  tus.uploads.r9 = { length: 7 * 1024 * 1024, chunks: [] };
  const resumed = await page.evaluate(async (SIX) => {
    const data = new Uint8Array(7 * 1024 * 1024).fill(7);
    const prefix = new Uint8Array(SIX).fill(7);
    await fetch("https://tus.test/upload/resumable/r9", { method: "PATCH", headers: { "Upload-Offset": "0", "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream" }, body: prefix });
    localStorage.setItem("mrp_tus:project-originals/p1/big.mp4:" + data.length, "https://tus.test/upload/resumable/r9");
    await MrpMediaClient.tusUpload({ endpoint: "https://tus.test/upload/resumable", accessToken: "t", apikey: "a", bucket: "project-originals", path: "p1/big.mp4",
      file: new File([data], "big.mp4", { type: "video/mp4" }), contentType: "video/mp4" });
    return true;
  }, SIX);
  const r9 = tus.patches.filter(p => p.id === "r9");
  check("TUS resume after reload: no new upload created, only the missing 1 MB is sent", resumed && tus.posts.length === 1 && r9.length === 2 && r9[1].offset === SIX && r9[1].size === 1024 * 1024 &&
    Buffer.concat(tus.uploads.r9.chunks).length === 7 * 1024 * 1024, r9.map(p => p.offset + ":" + p.size).join(" "));

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  await browser.close();
  server.close();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.log("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; process.exit(1); });
