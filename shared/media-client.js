/* Browser helpers for project media uploads in the panel (media-projects plan, Phase 6/8).
   UMD: window.MrpMediaClient. No dependencies.

   prepareImage(file, {maxEdge, quality})  → { blob (JPEG), width, height }
       Decodes with the EXIF orientation applied, fits inside 2560 px and re-encodes through a canvas,
       which drops ALL metadata (EXIF / GPS / XMP). HEIC/HEIF: works where the browser can decode it
       (Safari); elsewhere it throws { code: 'heic_unsupported', he: … }.
   captureVideoFrame(file, {at, maxEdge, quality}) → { blob (JPEG), width, height, duration }
       A cover image taken from the video itself (at ~1 s, or the middle of a short clip).
   readVideoInfo(file) → { duration, width, height }   (what the browser reports — the server re-checks)
   tusUpload({ endpoint, accessToken, apikey, bucket, path, file, contentType, onProgress, signal })
       → { path }   Resumable upload (TUS 1.0.0) in 6 MB chunks (Supabase's required size), with
       progress, retries (HEAD → resume from the server's offset) and resume after a page reload
       (the upload URL is remembered in localStorage by bucket/path/size). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MrpMediaClient = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CHUNK = 6 * 1024 * 1024;
  var HEIC_RE = /\.(heic|heif)$/i;

  function mediaError(code, he, message) {
    var e = new Error(message || code);
    e.code = code; e.he = he;
    return e;
  }
  function isHeic(file) {
    return /^image\/hei[cf]/i.test(file.type || "") || HEIC_RE.test(file.name || "");
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(mediaError("encode_failed", "לא הצלחנו לעבד את התמונה.")); }, "image/jpeg", quality);
    });
  }
  function fit(w, h, maxEdge) {
    var s = Math.min(1, maxEdge / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }

  function prepareImage(file, opts) {
    opts = opts || {};
    var maxEdge = opts.maxEdge || 2560, quality = opts.quality || 0.85;
    return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () {
      if (isHeic(file)) throw mediaError("heic_unsupported", "הדפדפן הזה לא יודע לפתוח תמונות HEIC. פתחו את התמונה בגלריה ושלחו/שמרו אותה כ-JPG, או העלו מהאייפון בספארי.");
      throw mediaError("decode_failed", "לא הצלחנו לפתוח את התמונה. נסו קובץ אחר.");
    }).then(function (bmp) {
      var size = fit(bmp.width, bmp.height, maxEdge);
      var canvas = document.createElement("canvas");
      canvas.width = size.width; canvas.height = size.height;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";                 // transparent PNGs → white, like the server does
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, size.width, size.height);
      if (bmp.close) bmp.close();
      return canvasToBlob(canvas, quality).then(function (blob) { return { blob: blob, width: size.width, height: size.height }; });
    });
  }

  function loadVideo(file) {
    return new Promise(function (resolve, reject) {
      var v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      var url = URL.createObjectURL(file);
      v.onloadedmetadata = function () { resolve({ video: v, url: url }); };
      v.onerror = function () { URL.revokeObjectURL(url); reject(mediaError("video_unreadable", "הדפדפן לא הצליח לפתוח את הסרטון. נסו MP4.")); };
      v.src = url;
    });
  }
  function readVideoInfo(file) {
    return loadVideo(file).then(function (o) {
      var info = { duration: o.video.duration, width: o.video.videoWidth, height: o.video.videoHeight };
      URL.revokeObjectURL(o.url);
      return info;
    });
  }
  function captureVideoFrame(file, opts) {
    opts = opts || {};
    return loadVideo(file).then(function (o) {
      var v = o.video;
      var at = Math.min(opts.at != null ? opts.at : 1, isFinite(v.duration) && v.duration > 0 ? v.duration / 2 : 0);
      return new Promise(function (resolve, reject) {
        v.onseeked = function () {
          var size = fit(v.videoWidth, v.videoHeight, opts.maxEdge || 2560);
          var canvas = document.createElement("canvas");
          canvas.width = size.width; canvas.height = size.height;
          canvas.getContext("2d").drawImage(v, 0, 0, size.width, size.height);
          canvasToBlob(canvas, opts.quality || 0.85).then(function (blob) {
            URL.revokeObjectURL(o.url);
            resolve({ blob: blob, width: size.width, height: size.height, duration: v.duration });
          }, reject);
        };
        v.onerror = function () { URL.revokeObjectURL(o.url); reject(mediaError("video_unreadable", "לא הצלחנו לקחת תמונת שער מהסרטון.")); };
        v.currentTime = at;
      });
    });
  }

  // ---- TUS ----
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function storeKey(o) { return "mrp_tus:" + o.bucket + "/" + o.path + ":" + o.file.size; }
  function xhr(method, url, headers, body, onUp, signal) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, url, true);
      Object.keys(headers).forEach(function (k) { x.setRequestHeader(k, headers[k]); });
      if (onUp && x.upload) x.upload.onprogress = function (e) { if (e.lengthComputable) onUp(e.loaded); };
      x.onload = function () { resolve(x); };
      x.onerror = function () { reject(mediaError("network", "בעיית רשת בהעלאה. מנסים שוב…")); };
      if (signal) {
        if (signal.aborted) { reject(mediaError("aborted", "ההעלאה בוטלה.")); return; }
        signal.addEventListener("abort", function () { x.abort(); reject(mediaError("aborted", "ההעלאה בוטלה.")); });
      }
      x.send(body === undefined ? null : body);
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function tusUpload(o) {
    var base = { "Tus-Resumable": "1.0.0", Authorization: "Bearer " + o.accessToken, apikey: o.apikey };
    var total = o.file.size, key = storeKey(o), location = null, offset = 0, attempts = 0;
    var report = function (n) { if (o.onProgress) o.onProgress(Math.min(1, n / total), n, total); };
    function h(extra) { return Object.assign({}, base, extra); }

    function create() {
      var meta = ["bucketName " + b64(o.bucket), "objectName " + b64(o.path), "contentType " + b64(o.contentType || o.file.type || "application/octet-stream"), "cacheControl " + b64("3600")].join(",");
      return xhr("POST", o.endpoint, h({ "Upload-Length": String(total), "Upload-Metadata": meta, "x-upsert": "true" }), undefined, null, o.signal).then(function (x) {
        if (x.status !== 201) throw mediaError("upload_failed", "ההעלאה נכשלה (" + x.status + ").");
        location = new URL(x.getResponseHeader("Location"), o.endpoint).toString();
        try { localStorage.setItem(key, location); } catch (e) {}
        offset = 0;
      });
    }
    function head() {
      return xhr("HEAD", location, h({}), undefined, null, o.signal).then(function (x) {
        if (x.status === 404 || x.status === 410) { location = null; return create(); }
        if (x.status !== 200 && x.status !== 204) throw mediaError("upload_failed", "ההעלאה נכשלה (" + x.status + ").");
        offset = Number(x.getResponseHeader("Upload-Offset") || 0);
      });
    }
    function sendChunks() {
      if (offset >= total) return Promise.resolve();
      var end = Math.min(total, offset + CHUNK);
      return xhr("PATCH", location, h({ "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }),
        o.file.slice(offset, end), function (loaded) { report(offset + loaded); }, o.signal).then(function (x) {
        if (x.status !== 204) throw mediaError("upload_failed", "ההעלאה נכשלה (" + x.status + ").");
        offset = Number(x.getResponseHeader("Upload-Offset") || end);
        attempts = 0;
        report(offset);
        return sendChunks();
      });
    }
    function run() {
      return sendChunks().catch(function (err) {
        if (err.code === "aborted" || ++attempts > 4) throw err;
        return sleep(500 * Math.pow(2, attempts)).then(head).then(run);   // resume from the server's offset
      });
    }
    var saved = null;
    try { saved = localStorage.getItem(key); } catch (e) {}
    var start = saved ? (location = saved, head()) : create();
    return start.then(run).then(function () {
      try { localStorage.removeItem(key); } catch (e) {}
      report(total);
      return { path: o.path };
    });
  }

  return { prepareImage: prepareImage, captureVideoFrame: captureVideoFrame, readVideoInfo: readVideoInfo, tusUpload: tusUpload, isHeic: isHeic, CHUNK: CHUNK };
});
