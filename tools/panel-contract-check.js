// Live contract check for api/panel.js (media-projects Phase 2): calls every OLD panel URL on
// production and on a preview and compares status codes + response bodies. Nothing is published
// or written: unauthenticated / wrong-method / invalid-session calls, and — with --login — only
// read-only authenticated calls (social snapshot, status/pin checks on a non-existent id,
// publish-now without an id, which returns 400 before anything else).
//
// Usage:
//   node tools/panel-contract-check.js <preview-url>            # no session needed
//   node tools/panel-contract-check.js <preview-url> --login    # + authenticated read-only calls:
//        a Chrome window opens on the production login page; log in once (the session works on both,
//        same Supabase project). The token is read from the page and never printed.
// Reads VERCEL_AUTOMATION_BYPASS_SECRET from .env for the preview (never printed).
"use strict";
const fs = require("fs");
const path = require("path");

const PROD = "https://mr-polishes.com";
const PREVIEW = (process.argv[2] || "").replace(/\/$/, "");
const LOGIN = process.argv.includes("--login");
if (!/^https:\/\/[^ ]+\.vercel\.app$/.test(PREVIEW)) { console.error("Usage: node tools/panel-contract-check.js https://<preview>.vercel.app [--login]"); process.exit(2); }

const env = {};
fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).forEach(function (l) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
});

const MISSING_ID = "00000000-0000-4000-8000-0000000000aa"; // no such content_queue row
const ROUTES = [
  { name: "publish-now", method: "POST" },
  { name: "check-publish-status", method: "POST" },
  { name: "check-pin-status", method: "POST" },
  { name: "social-snapshot", method: "GET" },
  { name: "analytics-refresh", method: "POST" }
];

async function hit(base, route, method, opts) {
  opts = opts || {};
  const headers = { "Content-Type": "application/json" };
  if (base === PREVIEW) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (opts.auth) headers.Authorization = opts.auth;
  const res = await fetch(base + "/api/" + route, { method, headers, body: method === "GET" ? undefined : JSON.stringify(opts.body || {}), redirect: "manual" });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = { _nonJson: text.slice(0, 60) }; }
  return { status: res.status, body };
}
function shape(v) {
  if (Array.isArray(v)) return "array";
  if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach(k => { o[k] = shape(v[k]); }); return o; }
  return v === null ? "null" : typeof v;
}

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) pass++; else fail++; console.log((cond ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : "")); }
async function compare(label, route, method, opts, expectStatus, byShape) {
  const p = await hit(PROD, route, method, opts), v = await hit(PREVIEW, route, method, opts);
  const same = byShape ? JSON.stringify(shape(p.body)) === JSON.stringify(shape(v.body)) : JSON.stringify(p.body) === JSON.stringify(v.body);
  check(route + " · " + label + ": production " + p.status + " = preview " + v.status + (byShape ? " (same shape)" : " (same body)"),
    p.status === v.status && p.status === expectStatus && same, JSON.stringify({ prod: p.body, preview: v.body }).slice(0, 220));
}

async function getSessionByLogin() {
  const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: false });
  const page = await (await browser.newContext()).newPage();
  await page.goto(PROD + "/login.html");
  console.log("…log in in the Chrome window (waiting up to 5 minutes)");
  const deadline = Date.now() + 5 * 60 * 1000;
  let token = null;
  while (!token && Date.now() < deadline) {
    token = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^sb-.*-auth-token$/.test(k)) { try { const v = JSON.parse(localStorage.getItem(k)); return v && v.access_token || null; } catch (e) {} }
      }
      return null;
    }).catch(() => null);
    if (!token) await new Promise(r => setTimeout(r, 1500));
  }
  await browser.close();
  return token;
}

(async function main() {
  console.log("production: " + PROD + "   preview: (given)\n");
  for (const r of ROUTES) {
    await compare("no session", r.name, r.method, {}, 401);
    await compare("invalid session", r.name, r.method, { auth: "Bearer not-a-real-session" }, 401);
    if (r.method === "POST") await compare("wrong method (GET)", r.name, "GET", {}, 405);
  }
  const unknown = await hit(PREVIEW, "panel?action=nope", "POST");
  check("preview /api/panel?action=nope → 404", unknown.status === 404, JSON.stringify(unknown.body));
  const underscore = await hit(PREVIEW, "_publish-now", "POST");
  check("preview /api/_publish-now is not a route (404)", underscore.status === 404, String(underscore.status));

  if (LOGIN) {
    const token = await getSessionByLogin();
    if (!token) { check("login: session obtained", false, "no session within 5 minutes"); }
    else {
      const auth = "Bearer " + token;
      await compare("session, no id (returns before any publish)", "publish-now", "POST", { auth }, 400);
      await compare("session, non-existent id", "check-publish-status", "POST", { auth, body: { id: MISSING_ID } }, 404);
      await compare("session, non-existent id", "check-pin-status", "POST", { auth, body: { id: MISSING_ID } }, 404);
      await compare("session (read-only)", "social-snapshot", "GET", { auth }, 200, true);
    }
  } else {
    console.log("\n(authenticated read-only calls skipped — run again with --login)");
  }
  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log("error: " + e.message); process.exit(1); });
