// A tiny MP4 / MOV metadata reader (no ffmpeg): container brand, duration, display size, rotation,
// video + audio codecs. It reads ISO-BMFF boxes through `read(offset, length)` so it works on a Buffer
// AND on a file in Supabase Storage via HTTP Range requests (a 50 MB video is never downloaded whole:
// only the box headers and the `moov` box, wherever it sits — start or end of the file).
// Used by api/media.js; validateVideo() gives the panel / bot a short Hebrew error.
"use strict";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;   // Supabase Free per-file cap (and the panel's limit)
const MIN_DURATION_S = 3;                     // Instagram Reels minimum
const MAX_DURATION_S = 15 * 60;               // Instagram Reels maximum
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const VIDEO_CODECS = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC" };
// Compared after trim() (brands are space-padded to 4 chars: "qt  " → "qt" — iPhone MOV files).
const CONTAINERS = ["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V", "qt", "MSNV", "3gp4", "3gp5", "dash"];

class VideoError extends Error {
  constructor(code, message, he) { super(message); this.code = code; this.he = he; }
}

function bufferReader(buf) {
  return async function (offset, length) { return buf.subarray(offset, Math.min(buf.length, offset + length)); };
}
// A reader over HTTP Range requests (e.g. the Supabase Storage object URL + the service-role headers).
function httpRangeReader(url, headers) {
  return async function (offset, length) {
    var res = await fetch(url, { headers: Object.assign({}, headers, { Range: "bytes=" + offset + "-" + (offset + length - 1) }), signal: AbortSignal.timeout(15000) });
    if (res.status !== 206 && res.status !== 200) throw new Error("range read failed: " + res.status);
    var b = Buffer.from(await res.arrayBuffer());
    return res.status === 200 ? b.subarray(offset, offset + length) : b;
  };
}

// Child boxes of a parsed box payload (a Buffer).
function children(buf) {
  var out = [], o = 0;
  while (o + 8 <= buf.length) {
    var size = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8), hdr = 8;
    if (size === 1) { if (o + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(o + 8)); hdr = 16; }
    else if (size === 0) size = buf.length - o;
    if (size < hdr || o + size > buf.length) break;
    out.push({ type: type, data: buf.subarray(o + hdr, o + size) });
    o += size;
  }
  return out;
}
const child = (buf, type) => children(buf).find(b => b.type === type);

function fixed16(v) { return v / 65536; }
function rotationFromMatrix(data, at) {
  var a = data.readInt32BE(at), b = data.readInt32BE(at + 4);
  var deg = Math.round(Math.atan2(fixed16(b), fixed16(a)) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function parseTrak(trak) {
  var t = {};
  var tkhd = child(trak, "tkhd");
  if (tkhd) {
    var d = tkhd.data, v1 = d[0] === 1, m = v1 ? 52 : 40;
    if (d.length >= m + 44) {
      t.rotation = rotationFromMatrix(d, m);
      t.width = Math.round(fixed16(d.readUInt32BE(m + 36)));
      t.height = Math.round(fixed16(d.readUInt32BE(m + 40)));
    }
  }
  var mdia = child(trak, "mdia");
  if (mdia) {
    var hdlr = child(mdia.data, "hdlr");
    if (hdlr && hdlr.data.length >= 12) t.handler = hdlr.data.toString("latin1", 8, 12);
    var minf = child(mdia.data, "minf"), stbl = minf && child(minf.data, "stbl"), stsd = stbl && child(stbl.data, "stsd");
    if (stsd && stsd.data.length >= 16) t.codec = stsd.data.toString("latin1", 12, 16);
  }
  return t;
}

// readMp4Meta(read, size) → { container, durationSec, width, height, rotation, videoCodec, audioCodec, size }
async function readMp4Meta(read, size) {
  var offset = 0, brand = null, moov = null, guard = 0;
  while (offset + 8 <= size && guard++ < 1000) {
    var h = await read(offset, 16);
    if (h.length < 8) break;
    var boxSize = h.readUInt32BE(0), type = h.toString("latin1", 4, 8), hdr = 8;
    if (boxSize === 1) { boxSize = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < hdr) break;
    if (type === "ftyp") brand = (await read(offset + 8, 4)).toString("latin1");
    if (type === "moov") {
      if (boxSize > MAX_MOOV_BYTES) throw new VideoError("bad_video", "moov box too large", "לא הצלחנו לקרוא את הסרטון.");
      moov = await read(offset + hdr, boxSize - hdr);
      break;
    }
    offset += boxSize;
  }
  if (!brand) throw new VideoError("not_mp4", "Not an MP4/MOV file", "הסרטון צריך להיות בפורמט MP4 או MOV.");
  if (!moov) throw new VideoError("bad_video", "No moov box", "לא הצלחנו לקרוא את הסרטון. נסו לשמור אותו מחדש ולהעלות שוב.");

  var meta = { container: brand.trim(), size: size, durationSec: null, width: null, height: null, rotation: 0, videoCodec: null, audioCodec: null };
  var mvhd = child(moov, "mvhd");
  if (mvhd) {
    var d = mvhd.data, v1 = d[0] === 1;
    var timescale = v1 ? d.readUInt32BE(20) : d.readUInt32BE(12);
    var duration = v1 ? Number(d.readBigUInt64BE(24)) : d.readUInt32BE(16);
    if (timescale) meta.durationSec = Math.round(duration / timescale * 100) / 100;
  }
  children(moov).filter(b => b.type === "trak").forEach(function (trak) {
    var t = parseTrak(trak.data);
    if (t.handler === "vide" && !meta.videoCodec) {
      meta.videoCodec = t.codec || null;
      meta.rotation = t.rotation || 0;
      var swap = meta.rotation === 90 || meta.rotation === 270;
      meta.width = swap ? t.height : t.width;
      meta.height = swap ? t.width : t.height;
    }
    if (t.handler === "soun" && !meta.audioCodec) meta.audioCodec = t.codec || null;
  });
  return meta;
}

// Throws a VideoError (with a Hebrew message) when the video can't be used.
function validateVideo(meta) {
  if (meta.size > MAX_VIDEO_BYTES) {
    throw new VideoError("too_large", "Video larger than 50 MB", "הסרטון גדול מדי (מעל 50MB). קצרו אותו או שלחו באיכות נמוכה יותר.");
  }
  if (!meta.videoCodec) throw new VideoError("no_video_track", "No video track", "לא נמצא וידאו בקובץ.");
  if (!VIDEO_CODECS[meta.videoCodec]) {
    throw new VideoError("unsupported_codec", "Unsupported video codec " + meta.videoCodec, "הסרטון מקודד בפורמט שלא נתמך. צלמו או שמרו אותו כ-MP4 רגיל (H.264) ונסו שוב.");
  }
  if (meta.durationSec === null || meta.durationSec < MIN_DURATION_S) {
    throw new VideoError("too_short", "Video shorter than 3 s", "הסרטון קצר מדי (פחות מ-3 שניות).");
  }
  if (meta.durationSec > MAX_DURATION_S) {
    throw new VideoError("too_long", "Video longer than 15 min", "הסרטון ארוך מדי (מעל 15 דקות).");
  }
  if (CONTAINERS.indexOf(meta.container) === -1) {
    throw new VideoError("not_mp4", "Unsupported container " + meta.container, "הסרטון צריך להיות בפורמט MP4 או MOV.");
  }
  return Object.assign({}, meta, { videoCodecName: VIDEO_CODECS[meta.videoCodec] });
}

module.exports = { readMp4Meta, validateVideo, bufferReader, httpRangeReader, VideoError, MAX_VIDEO_BYTES, VIDEO_CODECS };
