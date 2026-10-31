// api/media.js — create-upload / process / delete / analyze / correct / delete-project, auth (session or internal secret), validation,
// quota, rate limits. Supabase Auth, REST, Storage and the quota RPC are MOCKED; image processing
// runs for real (sharp) on a generated photo. Fake values only.
"use strict";
const path = require("path");
const sharp = require("sharp");
const REPO = path.resolve(__dirname, "..");

Object.assign(process.env, { SUPABASE_SERVICE_ROLE_KEY: "svc-fake", INTERNAL_API_SECRET: "internal-fake-secret", GOOGLE_AI_API_KEY: "g-fake" });
const P1 = "11111111-1111-4111-8111-111111111111", P2 = "22222222-2222-4222-8222-222222222222";
const ST = "https://mmognkxkglkotzkuxzly.supabase.co/storage/v1/object/";

let projects, store, media, calls, quotaLeft, quotaDown, queue, geminiReplies, geminiStatus;
function reset() {
  projects = { [P1]: { id: P1, watermark: true, status: "draft" }, [P2]: { id: P2, watermark: false, status: "draft" } };
  store = {}; media = {}; calls = []; quotaLeft = 80; quotaDown = false; queue = []; geminiReplies = []; geminiStatus = 200;
}
reset();
function res_(status, body, headers) {
  const h = Object.assign({}, headers || {});
  const buf = Buffer.isBuffer(body) ? body : null;
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => h[k.toLowerCase()] || null },
    json: async () => body, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
}
global.fetch = async function (url, init) {
  init = init || {};
  url = String(url);
  const method = init.method || "GET";
  const hdr = init.headers || {};
  let m;
  if (/\/auth\/v1\/user$/.test(url)) return hdr.Authorization === "Bearer good-session" ? res_(200, { id: "user-1" }) : res_(401, {});
  if (/\/rest\/v1\/rpc\/consume_daily_quota$/.test(url)) {
    calls.push({ kind: "quota", body: JSON.parse(init.body) });
    if (quotaDown) return res_(500, {});
    if (quotaLeft <= 0) return res_(200, -1);
    return res_(200, --quotaLeft);
  }
  if (url.startsWith("https://generativelanguage.googleapis.com/")) {
    const body = JSON.parse(init.body);
    calls.push({ kind: "gemini", body });
    if (geminiStatus !== 200) return res_(geminiStatus, { error: { status: geminiStatus === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL" } });
    return res_(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(geminiReplies.shift() || {}) }] } }] });
  }
  if ((m = url.match(/\/rest\/v1\/projects\?id=eq\.([^&]+)/))) {
    if (method === "PATCH") { const p = JSON.parse(init.body); Object.assign(projects[m[1]], p); calls.push({ kind: "project-patch", patch: p }); return res_(200, [projects[m[1]]]); }
    if (method === "DELETE") { delete projects[m[1]]; Object.keys(media).forEach(k => { if (media[k].project_id === m[1]) delete media[k]; }); calls.push({ kind: "project-delete", id: m[1] }); return res_(204, null); }
    return res_(200, projects[m[1]] ? [projects[m[1]]] : []);
  }
  if ((m = url.match(/\/rest\/v1\/project_media\?project_id=eq\.([^&]+)(.*)$/))) {
    let rows = Object.values(media).filter(r => r.project_id === m[1]);
    if (/kind=eq\.image/.test(m[2])) rows = rows.filter(r => r.kind === "image");
    return res_(200, rows.sort((a, b) => a.sort - b.sort));
  }
  if ((m = url.match(/\/rest\/v1\/content_queue\?(.*)$/))) {
    const qs = decodeURIComponent(m[1]);
    if (method === "PATCH") { calls.push({ kind: "cq-patch", qs, patch: JSON.parse(init.body) }); return res_(204, null); }
    if (/^select=caption/.test(qs)) return res_(200, [{ caption: "השיש חזר לברק ✨\nעוד" }, { caption: "מדרגות כמו חדשות" }]);
    const pm = qs.match(/project_id=eq\.([^&]+)/);
    return res_(200, queue.filter(q => q.project_id === pm[1]));
  }
  if ((m = url.match(/\/storage\/v1\/object\/list\/([^/]+)$/))) {
    const prefix = JSON.parse(init.body).prefix;
    calls.push({ kind: "list", bucket: m[1], prefix });
    const names = Object.keys(store).filter(k => k.startsWith(m[1] + "/" + prefix)).map(k => k.slice((m[1] + "/" + prefix).length)).filter(n => !n.includes("/"));
    return res_(200, names.map(n => ({ name: n, id: "obj-" + n })).concat([{ name: "incoming", id: null }]));
  }
  if (/\/rest\/v1\/project_media$/.test(url) && method === "POST") { const row = JSON.parse(init.body); media[row.id] = row; calls.push({ kind: "insert", row }); return res_(201, [row]); }
  if ((m = url.match(/\/rest\/v1\/project_media\?id=eq\.([^&]+)/))) {
    if (method === "DELETE") { delete media[m[1]]; calls.push({ kind: "row-delete", id: m[1] }); return res_(204, null); }
    if (method === "PATCH") { const p = JSON.parse(init.body); Object.assign(media[m[1]], p); calls.push({ kind: "media-patch", id: m[1], patch: p }); return res_(204, null); }
    return res_(200, media[m[1]] ? [media[m[1]]] : []);
  }
  if ((m = url.match(/\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/))) {
    calls.push({ kind: "sign", bucket: m[1], path: m[2] });
    return res_(200, { url: "/object/upload/sign/" + m[1] + "/" + m[2] + "?token=tok-fake" });
  }
  if ((m = url.match(/\/storage\/v1\/object\/([^/]+)$/)) && method === "DELETE") {
    const prefixes = JSON.parse(init.body).prefixes;
    prefixes.forEach(p => delete store[m[1] + "/" + p]);
    calls.push({ kind: "storage-delete", bucket: m[1], prefixes });
    return res_(200, prefixes.map(n => ({ name: n })));
  }
  if ((m = url.match(/\/storage\/v1\/object\/([^/]+)\/(.+)$/))) {
    const key = m[1] + "/" + m[2];
    if (method === "POST") {
      store[key] = { buf: Buffer.from(init.body), type: hdr["Content-Type"], cache: hdr["cache-control"], upsert: hdr["x-upsert"] };
      calls.push({ kind: "upload", bucket: m[1], path: m[2], type: hdr["Content-Type"], cache: hdr["cache-control"] });
      return res_(200, { Key: key });
    }
    const f = store[key];
    if (!f) return res_(400, { error: "not_found" });
    if (hdr.Range) {
      const [a, b] = hdr.Range.replace("bytes=", "").split("-").map(Number);
      const chunk = f.buf.subarray(a, Math.min(f.buf.length, b + 1));
      calls.push({ kind: "range", bytes: chunk.length });
      return res_(206, chunk, { "content-range": "bytes " + a + "-" + (a + chunk.length - 1) + "/" + f.buf.length, "content-length": String(chunk.length) });
    }
    calls.push({ kind: "download", path: m[2] });
    return res_(200, f.buf, { "content-length": String(f.buf.length) });
  }
  throw new Error("unmocked fetch: " + method + " " + url);
};
const logs = [];
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

const media_ = require(REPO + "/api/media.js");
let passed = 0, total = 0;
function check(name, cond, detail) { total++; if (cond) { passed++; out("PASS " + name); } else out("FAIL " + name + (detail ? "  -- " + detail : "")); }
let ipN = 0;
async function call(action, body, opts) {
  opts = opts || {};
  const r = { code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const headers = Object.assign({ "x-forwarded-for": opts.ip || "10.2.0." + (++ipN) }, opts.headers === undefined ? { authorization: "Bearer good-session" } : opts.headers);
  await media_({ method: opts.method || "POST", headers, body: body || {}, query: { action } }, r);
  return r;
}
const UUIDp = "[0-9a-f-]{36}";
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
  // ---- routing / auth ----
  let r = await call("nope");
  check("unknown action → 404", r.code === 404);
  r = await call("process", {}, { method: "GET" });
  check("GET → 405", r.code === 405);
  r = await call("create-upload", {}, { headers: {} });
  check("no session → 401 + Hebrew", r.code === 401 && /להתחבר/.test(r.body.he));
  r = await call("create-upload", {}, { headers: { authorization: "Bearer bad" } });
  check("invalid session → 401", r.code === 401);
  r = await call("create-upload", {}, { headers: { "x-internal-secret": "wrong" } });
  check("wrong internal secret → 401", r.code === 401);
  r = await call("create-upload", { project_id: P1, content_type: "image/jpeg", bytes: 1000 }, { headers: { "x-internal-secret": "internal-fake-secret" } });
  check("the internal secret (the bot) is accepted", r.code === 200);

  // ---- create-upload ----
  r = await call("create-upload", { project_id: P1, content_type: "image/jpeg", bytes: 2 * 1024 * 1024 });
  check("image → a path under <project>/incoming/<uuid>.jpg in project-originals", r.code === 200 && r.body.bucket === "project-originals" &&
    new RegExp("^" + P1 + "/incoming/" + UUIDp + "\\.jpg$").test(r.body.path), JSON.stringify(r.body));
  check("…with a signed upload URL + token and the TUS endpoint", /\/storage\/v1\/object\/upload\/sign\/project-originals\//.test(r.body.signed_url) && r.body.token === "tok-fake" &&
    r.body.tus_endpoint === "https://mmognkxkglkotzkuxzly.supabase.co/storage/v1/upload/resumable");
  r = await call("create-upload", { project_id: P1, content_type: "video/quicktime", bytes: 30 * 1024 * 1024 });
  check("video (MOV) → <project>/<uuid>.mov (kept as uploaded)", r.code === 200 && r.body.kind === "video" && new RegExp("^" + P1 + "/" + UUIDp + "\\.mov$").test(r.body.path));
  r = await call("create-upload", { project_id: P1, content_type: "image/heic", bytes: 1000 });
  check("HEIC → 415 heic_unsupported (Hebrew)", r.code === 415 && r.body.code === "heic_unsupported" && /HEIC/.test(r.body.he));
  r = await call("create-upload", { project_id: P1, content_type: "image/gif", bytes: 1000 });
  check("GIF → 415 unsupported_type", r.code === 415 && r.body.code === "unsupported_type");
  r = await call("create-upload", { project_id: P1, content_type: "video/mp4", bytes: 51 * 1024 * 1024 });
  check("> 50 MB → 413 too_large", r.code === 413 && r.body.code === "too_large");
  r = await call("create-upload", { project_id: "x", content_type: "image/jpeg", bytes: 10 });
  check("a bad project id → 400", r.code === 400 && r.body.code === "bad_project");
  r = await call("create-upload", { project_id: "33333333-3333-4333-8333-333333333333", content_type: "image/jpeg", bytes: 10 });
  check("an unknown project → 404", r.code === 404 && r.body.code === "project_not_found");

  // ---- process an image ----
  reset();
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#6b5a44" } })
    .jpeg().withExif({ IFD0: { Make: "SECRET-CAM" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "31/1 44/1 0/1" } }).toBuffer();
  const inc = P1 + "/incoming/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
  store["project-originals/" + inc] = { buf: photo };
  r = await call("process", { project_id: P1, path: inc, role: "after", pair_no: 1, sort: 2 });
  const row = r.body.media;
  check("process → 200 with a project_media row", r.code === 200 && row && row.kind === "image" && row.project_id === P1, JSON.stringify(r.body).slice(0, 200));
  check("row: role/pair/sort + original ≤ 2560 (3000×2000 → 2560×1707)", row.role === "after" && row.pair_no === 1 && row.sort === 2 && row.width === 2560 && row.height === 1707);
  const ups = calls.filter(c => c.kind === "upload");
  check("original → PRIVATE project-originals/<project>/<media>.jpg", ups.some(u => u.bucket === "project-originals" && u.path === P1 + "/" + row.id + ".jpg" && u.type === "image/jpeg"));
  const pub = ups.filter(u => u.bucket === "project-media").map(u => u.path.split("/").pop()).sort();
  check("public project-media: w480/w960/w1600 .webp + w1600.jpg + ig.jpg", JSON.stringify(pub) === JSON.stringify(["ig.jpg", "w1600.jpg", "w1600.webp", "w480.webp", "w960.webp"]), pub.join(","));
  check("public files: Cache-Control max-age 1 day (86400; a deleted photo leaves the CDN within a day)", ups.filter(u => u.bucket === "project-media").length >= 5 && ups.filter(u => u.bucket === "project-media").every(u => u.cache === "86400" && u.path.startsWith(P1 + "/" + row.id + "/")));
  check("variants in the row: paths + sizes, IG 1080×1350, watermark 'badge' (project watermark on)", row.variants.ig.width === 1080 && row.variants.ig.height === 1350 &&
    row.variants.w1600.path === P1 + "/" + row.id + "/w1600.webp" && row.variants.watermark === "badge");
  const stored = store["project-originals/" + P1 + "/" + row.id + ".jpg"].buf;
  const sm = await sharp(stored).metadata();
  check("the stored original has NO EXIF/GPS (the upload had a GPS block)", gpsEntries(photo) > 0 && !sm.exif && stored.indexOf(Buffer.from("SECRET-CAM")) === -1 && gpsEntries(stored) === -1);
  check("the raw upload (incoming/) is deleted afterwards", calls.some(c => c.kind === "storage-delete" && c.bucket === "project-originals" && c.prefixes[0] === inc) && !store["project-originals/" + inc]);
  check("one unit of the daily media_file quota used", calls.filter(c => c.kind === "quota").length === 1 && calls.find(c => c.kind === "quota").body.p_kind === "media_file" && r.body.quota_remaining === 79);

  // watermark off per project
  const inc2 = P2 + "/incoming/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
  store["project-originals/" + inc2] = { buf: photo };
  r = await call("process", { project_id: P2, path: inc2 });
  check("a project with watermark OFF → variants without a watermark", r.code === 200 && r.body.media.variants.watermark === null);

  // ---- process: validation ----
  r = await call("process", { project_id: P1, path: P2 + "/incoming/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg" });
  check("a path from ANOTHER project → 400 bad_path", r.code === 400 && r.body.code === "bad_path");
  r = await call("process", { project_id: P1, path: P1 + "/incoming/../x.jpg" });
  check("path traversal → 400", r.code === 400);
  r = await call("process", { project_id: P1, path: P1 + "/" + row.id + ".jpg" });
  check("an already-processed original can't be processed again (not an incoming/ path)", r.code === 400);
  r = await call("process", { project_id: P1, path: P1 + "/incoming/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg" });
  check("missing upload → 422 upload_missing (Hebrew)", r.code === 422 && r.body.code === "upload_missing" && /להעלות שוב/.test(r.body.he));
  r = await call("process", { project_id: P1, path: inc, role: "selfie" });
  check("a bad role → 400", r.code === 400 && r.body.code === "bad_role");
  const heicPath = P1 + "/incoming/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg";
  store["project-originals/" + heicPath] = { buf: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(100)]) };
  r = await call("process", { project_id: P1, path: heicPath });
  check("a HEIC uploaded under a .jpg name is still refused (bytes win) → 415", r.code === 415 && r.body.code === "heic_unsupported");
  quotaLeft = 0;
  store["project-originals/" + inc] = { buf: photo };
  r = await call("process", { project_id: P1, path: inc });
  check("daily quota used up → 429 (Hebrew), nothing processed", r.code === 429 && r.body.code === "quota" && /מכסת/.test(r.body.he));
  quotaLeft = 80; quotaDown = true;
  r = await call("process", { project_id: P1, path: inc });
  check("quota service down → 503 (fails closed)", r.code === 503);
  quotaDown = false;

  // ---- process a video (+ a cover) ----
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const box = (type, ...parts) => { const p = Buffer.concat(parts); return Buffer.concat([u32(8 + p.length), Buffer.from(type, "latin1"), p]); };
  const fx = (n) => u32(Math.round(n * 65536) >>> 0);
  const tk = box("tkhd", Buffer.from([0, 0, 0, 3]), Buffer.alloc(36), fx(1), u32(0), u32(0), u32(0), fx(1), u32(0), u32(0), u32(0), u32(0x40000000), fx(1080), fx(1920));
  const stsd = box("stsd", Buffer.alloc(8), box("avc1", Buffer.alloc(16)));
  const hdlr = box("hdlr", Buffer.alloc(8), Buffer.from("vide", "latin1"), Buffer.alloc(12));
  const trak = box("trak", tk, box("mdia", hdlr, box("minf", box("stbl", stsd))));
  const moovOf = (durationMs) => box("moov", box("mvhd", Buffer.from([0, 0, 0, 0]), Buffer.alloc(8), u32(1000), u32(durationMs), Buffer.alloc(80)), trak);
  const ftyp = box("ftyp", Buffer.from("isom", "latin1"), u32(512));
  const mp4 = Buffer.concat([ftyp, box("mdat", Buffer.alloc(500000)), moovOf(19000)]);   // moov at the end
  const vid = P1 + "/ffffffff-ffff-4fff-8fff-ffffffffffff.mp4", cov = P1 + "/incoming/99999999-9999-4999-8999-999999999999.jpg";
  store["project-originals/" + vid] = { buf: mp4 };
  store["project-originals/" + cov] = { buf: photo };
  calls = [];
  r = await call("process", { project_id: P1, path: vid, cover_path: cov });
  const vr = r.body.media;
  check("video → a row: 1080×1920, 19 s, avc1, bytes, original_path = the upload", r.code === 200 && vr.kind === "video" && vr.width === 1080 && vr.height === 1920 &&
    Number(vr.duration_s) === 19 && vr.codec === "avc1" && vr.bytes === mp4.length && vr.original_path === vid, JSON.stringify(r.body).slice(0, 220));
  check("the video is read with Range requests only (never downloaded whole)", !calls.some(c => c.kind === "download" && c.path === vid) &&
    calls.filter(c => c.kind === "range").reduce((s, c) => s + c.bytes, 0) < 4096);
  check("the cover → cover-* variants (webp + IG) under the media id", vr.variants && vr.variants.cover && vr.variants.cover.ig.path === P1 + "/" + vr.id + "/cover-ig.jpg" &&
    typeof vr.variants.cover_original === "string");
  const longVid = P1 + "/12121212-1212-4212-8212-121212121212.mp4";
  store["project-originals/" + longVid] = { buf: Buffer.concat([ftyp, moovOf(1500)]) };
  r = await call("process", { project_id: P1, path: longVid });
  check("a 1.5 s video → 422 too_short (Hebrew)", r.code === 422 && r.body.code === "too_short" && /קצר/.test(r.body.he));

  // ---- delete ----
  calls = [];
  r = await call("delete", { media_id: vr.id });
  const dels = calls.filter(c => c.kind === "storage-delete");
  check("delete → public variants + the private original + the cover original removed, then the row", r.code === 200 &&
    dels.some(d => d.bucket === "project-media" && d.prefixes.length === 5 && d.prefixes.every(p => p.startsWith(P1 + "/" + vr.id + "/cover-"))) &&
    dels.some(d => d.bucket === "project-originals" && d.prefixes.includes(vid) && d.prefixes.includes(vr.variants.cover_original)) &&
    calls.some(c => c.kind === "row-delete" && c.id === vr.id) && !media[vr.id], JSON.stringify(dels));
  r = await call("delete", { media_id: vr.id });
  check("deleting again → 404", r.code === 404);
  r = await call("delete", { media_id: "nope" });
  check("a bad media id → 400", r.code === 400);

  // ---- analyze / correct (Gemini mocked; real sharp prep) ----
  reset();
  const ph = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#8a7a66" } }).jpeg().toBuffer();
  const M = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];
  projects[P1] = { id: P1, watermark: true, status: "collecting", service: null, city: "רעננה", title_he: null, ai_meta: { publish_plan: { destinations: ["site"] } } };
  M.forEach((id, i) => {
    media[id] = { id, project_id: P1, kind: i === 2 ? "video" : "image", sort: i, role: null, pair_no: null, original_path: P1 + "/" + id + (i === 2 ? ".mp4" : ".jpg"),
      variants: i === 2 ? null : { w480: { path: P1 + "/" + id + "/w480.webp" }, ig: { path: P1 + "/" + id + "/ig.jpg" } }, flags_ack_at: i === 0 ? "2026-10-31T08:00:00Z" : null };
    store["project-originals/" + media[id].original_path] = { buf: ph };
  });
  const aiReply = { transcript: null, pairing_confidence: 0.9, service: "marble_stone", city: null, title_he: "ליטוש שיש בסלון", title_en: "Marble polishing", summary_he: "רצפת שיש עמומה קיבלה ליטוש.", summary_en: "A dull marble floor was polished.",
    caption_body_he: "השיש בסלון חזר לברק ✨\nליטוש והברקה בכל השטח. בדיקה ללא עלות!", hashtags: ["#ליטוש_שיש", "#סילר"], missing: [],
    images: [{ index: 1, role: "before", pair_no: 1, confidence: 0.9, alt_he: "שיש לפני", alt_en: "Marble before", privacy_flags: [{ type: "face", note: "a face" }], quality_flags: ["dark"] },
      { index: 2, role: "after", pair_no: 1, confidence: 0.9, alt_he: "שיש אחרי", alt_en: "Marble after", privacy_flags: [], quality_flags: [] }] };
  geminiReplies = [JSON.parse(JSON.stringify(aiReply))];
  r = await call("analyze", { project_id: P1, text: "ליטוש שיש בסלון" });
  check("analyze → 200 + the shaped analysis", r.code === 200 && r.body.ok && r.body.analysis.images.length === 2 && r.body.analysis.pairing_source === "ai", JSON.stringify(r.body).slice(0, 200));
  const gem = calls.filter(c => c.kind === "gemini");
  check("analyze: ONE Gemini call with only the 2 photos (the video is skipped), recent openings in the prompt", gem.length === 1 &&
    gem[0].body.contents[0].parts.filter(p => p.inline_data).length === 2 && /השיש חזר לברק/.test(gem[0].body.contents[0].parts[0].text));
  check("analyze: the private originals are read (not the watermarked public variants)", calls.filter(c => c.kind === "download").every(c => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(c.path)) && calls.filter(c => c.kind === "download").length === 2);
  check("analyze: one media_ai quota unit", calls.filter(c => c.kind === "quota" && c.body.p_kind === "media_ai").length === 1, JSON.stringify(calls.filter(c => c.kind === "quota")));
  check("analyze: roles / pairs / alts / flags (+ quality) saved per photo", media[M[0]].role === "before" && media[M[0]].pair_no === 1 && media[M[1]].role === "after" &&
    media[M[0]].alt_he === "שיש לפני" && media[M[0]].ai_flags.faces === true && media[M[0]].ai_flags.quality.includes("dark"), JSON.stringify(media[M[0]]));
  check("analyze: an acknowledged photo keeps its 'בדקתי' (flags_ack_at untouched)", media[M[0]].flags_ack_at === "2026-10-31T08:00:00Z" && !calls.some(c => c.kind === "media-patch" && "flags_ack_at" in c.patch));
  check("analyze: project texts + caption saved; collecting → draft; publish_plan kept", projects[P1].title_he === "ליטוש שיש בסלון" && projects[P1].status === "draft" &&
    projects[P1].ai_meta.caption_he.includes("052-9534540") && projects[P1].ai_meta.publish_plan.destinations[0] === "site" && projects[P1].ai_meta.needs_review === false);
  check("analyze: the caption rules apply (no 'free', no unstated #סילר)", !/ללא עלות/.test(projects[P1].ai_meta.caption_he) && !projects[P1].ai_meta.hashtags.includes("#סילר"), projects[P1].ai_meta.caption_he);
  check("analyze: a city Miri typed is not erased when the AI has none", projects[P1].city === "רעננה");
  check("analyze: no prompt / caption / key in the logs", !logs.some(l => /g-fake|השיש בסלון|ליטוש שיש בסלון/.test(l)));

  geminiReplies = [{ images: [], caption_body_he: "השיש בסלון חזר לברק ✨" }];
  projects[P1].title_he = "כותרת שמירי ערכה";
  r = await call("correct", { project_id: P1, text: "תקצר את הכיתוב" });
  const corrPrompt = calls.filter(c => c.kind === "gemini").pop().body.contents[0].parts[0].text;
  check("correct → 200; the CURRENT saved state is corrected (Miri's manual title is in the prompt)", r.code === 200 && /כותרת שמירי ערכה/.test(corrPrompt) && projects[P1].ai_meta.caption_body_he === "השיש בסלון חזר לברק ✨", projects[P1].ai_meta.caption_body_he);
  check("correct: flags are not touched", !calls.filter(c => c.kind === "media-patch").slice(-2).some(c => "ai_flags" in c.patch));
  r = await call("correct", { project_id: P1, text: "  " });
  check("correct: an empty text → 400", r.code === 400 && r.body.code === "empty_correction");
  geminiStatus = 429;
  r = await call("analyze", { project_id: P1 });
  check("analyze: Gemini 429 → 503 ai_busy with a Hebrew message", r.code === 503 && r.body.code === "ai_busy" && /עמוסה/.test(r.body.he));
  geminiStatus = 200;
  r = await call("analyze", { project_id: P2 });
  check("analyze: a project without photos → 400 no_images", r.code === 400 && r.body.code === "no_images");
  r = await call("analyze", { project_id: P1 }, { headers: {} });
  check("analyze: no auth → 401 (no Gemini call)", r.code === 401);

  // ---- delete-project ----
  store["project-originals/" + P1 + "/incoming/raw-left.jpg"] = { buf: ph };
  store["project-originals/" + P1 + "/orphan.mp4"] = { buf: ph };
  queue = [{ id: "q-pending", project_id: P1, status: "approved", fb_post_id: null, ig_post_id: null }, { id: "q-done", project_id: P1, status: "published", fb_post_id: "F1", ig_post_id: "I1" }];
  r = await call("delete-project", { project_id: P1 });
  check("delete-project → 200, the project row deleted (cascade)", r.code === 200 && !projects[P1] && !Object.values(media).some(m => m.project_id === P1));
  check("delete-project: public variants + originals + unprocessed leftovers all removed", !Object.keys(store).some(k => k.includes(P1)), Object.keys(store).filter(k => k.includes(P1)).join(", "));
  check("delete-project: posts not yet published are cancelled (rejected), published ones untouched", calls.some(c => c.kind === "cq-patch" && /id=in\.\(q-pending\)/.test(c.qs) && c.patch.status === "rejected"));
  check("delete-project: reports the Instagram posts to delete by hand", r.body.instagram_posts === 1 && r.body.facebook_posts === 1 && r.body.cancelled_posts === 1);
  r = await call("delete-project", { project_id: P1 });
  check("delete-project: unknown project → 404", r.code === 404);
  r = await call("delete-project", { project_id: "../etc" });
  check("delete-project: a bad id → 400", r.code === 400);

  // ---- rate limit ----
  let last;
  for (let i = 0; i < 31; i++) last = await call("delete", { media_id: "nope" }, { ip: "10.9.9.9" });
  check("rate limit: the 31st delete in a minute → 429", last.code === 429);

  check("logs: no secrets, tokens or EXIF content", !logs.some(l => /svc-fake|internal-fake|good-session|tok-fake|SECRET-CAM/.test(l)), logs.filter(l => /fake|SECRET/.test(l)).slice(0, 2).join(" | "));

  out("\n" + passed + "/" + total + " passed");
  process.exitCode = passed === total ? 0 : 1;
})().catch(err => { out("HARNESS ERROR " + (err && err.stack || err)); process.exitCode = 1; });
