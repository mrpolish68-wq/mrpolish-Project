// Live check of the Cache-Control that Supabase SERVES for files written by api/media.js (media-projects):
// creates a "[בדיקה]" project, uploads ONE gallery photo through the preview's /api/media (internal secret),
// processes it, reads the headers back from fresh copies, then deletes the project and verifies that
// 0 rows and 0 files are left. No AI, no publishing; uses one `media_file` quota unit.
//   public copies (project-media)       → "public, max-age=86400"
//   the private original (service read) → "private, max-age=3600"
//
// Usage: node tools/media-cache-check.js https://<preview>.vercel.app
// Reads SUPABASE_SERVICE_ROLE_KEY, INTERNAL_API_SECRET and VERCEL_AUTOMATION_BYPASS_SECRET from .env (never printed).
"use strict";
const fs = require("fs");
const path = require("path");

const PREVIEW = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\/[^ ]+\.vercel\.app$/.test(PREVIEW)) { console.error("Usage: node tools/media-cache-check.js https://<preview>.vercel.app"); process.exit(2); }

const env = {};
fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach(function (l) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
});
const SB = "https://mmognkxkglkotzkuxzly.supabase.co";
const svc = (h) => Object.assign({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY }, h || {});
const PHOTO = path.join(__dirname, "..", "assets", "gallery", "project5-after1.jpeg");

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); };

async function media(action, body) {
  const r = await fetch(PREVIEW + "/api/media?action=" + action, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_API_SECRET, "x-vercel-protection-bypass": env.VERCEL_AUTOMATION_BYPASS_SECRET } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}
async function rest(p, init) {
  init = init || {};
  const r = await fetch(SB + "/rest/v1/" + p, Object.assign({}, init, { headers: svc(Object.assign({ "Content-Type": "application/json" }, init.headers || {})) }));
  return r.status === 204 ? null : r.json();
}
async function listAll(bucket, prefix) {
  const r = await fetch(SB + "/storage/v1/object/list/" + bucket, { method: "POST", headers: svc({ "Content-Type": "application/json" }), body: JSON.stringify({ prefix: prefix, limit: 1000, offset: 0 }) });
  let out = [];
  for (const it of (await r.json()) || []) out = it.id ? out.concat(prefix + it.name) : out.concat(await listAll(bucket, prefix + it.name + "/"));
  return out;
}

(async function () {
  let pid = null;
  try {
    const created = await rest("projects", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "collecting", source: "panel", title_he: "[בדיקה] cache check" }) });
    pid = created && created[0] && created[0].id;
    check("project created", !!pid);
    const buf = fs.readFileSync(PHOTO);
    const slot = await media("create-upload", { project_id: pid, content_type: "image/jpeg", bytes: buf.length });
    check("create-upload", slot.status === 200, String(slot.status));
    const put = await fetch(slot.body.signed_url, { method: "PUT", headers: { "Content-Type": "image/jpeg", "x-upsert": "false" }, body: buf });
    check("signed upload", put.ok, String(put.status));
    const pr = await media("process", { project_id: pid, path: slot.body.path, sort: 0 });
    const m = pr.body && pr.body.media;
    check("process", pr.status === 200 && m && m.variants, String(pr.status));

    for (const k of ["jpg", "w480", "w1600", "ig"]) {
      const r = await fetch(SB + "/storage/v1/object/public/project-media/" + m.variants[k].path + "?fresh=" + Date.now());
      const cc = r.headers.get("cache-control");
      check("public " + k + ": served Cache-Control is 'public, max-age=86400'", r.status === 200 && cc === "public, max-age=86400", r.status + " " + JSON.stringify(cc));
    }
    const o = await fetch(SB + "/storage/v1/object/project-originals/" + m.original_path, { headers: svc() });
    check("private original: served Cache-Control is 'private, max-age=3600'", o.status === 200 && o.headers.get("cache-control") === "private, max-age=3600", o.status + " " + JSON.stringify(o.headers.get("cache-control")));
  } catch (e) {
    check("harness", false, e && e.message);
  } finally {
    if (pid) {
      const d = await media("delete-project", { project_id: pid });
      check("delete-project", d.status === 200, String(d.status));
      const rows = (await rest("projects?id=eq." + pid + "&select=id")).length + (await rest("project_media?project_id=eq." + pid + "&select=id")).length;
      const files = (await listAll("project-originals", pid + "/")).length + (await listAll("project-media", pid + "/")).length;
      check("cleanup: 0 rows and 0 files left", rows === 0 && files === 0, "rows=" + rows + " files=" + files);
    }
  }
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  process.exitCode = fail ? 1 : 0;
})();
