#!/usr/bin/env node
// Runs every test suite in tests/ and prints one summary line per suite. `npm test`.
//
// All suites are OFFLINE: Telegram, Supabase, Gemini and the PDF renderer are mocked (the SQL
// suite runs the migration files in PGlite, an in-process Postgres). Nothing touches the live
// project and no secrets are needed.
//   - panel-quotes.test.js drives admin.html in Chrome via playwright-core; set CHROME_PATH if
//     Chrome isn't at the default Windows location, or SKIP_BROWSER=1 to skip it.
// Not in here on purpose (they call real services): the live Gemini cases (bot-quotes with
// LIVE=1) and the local render-quote-pdf check against a real quote.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => /\.test\.(m?js)$/.test(f)).sort();
let failed = 0;
let total = 0;

for (const f of files) {
  if (f === "panel-quotes.test.js" && process.env.SKIP_BROWSER === "1") {
    console.log("SKIP " + f + " (SKIP_BROWSER=1)");
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/(\d+)\/(\d+) passed/);
  const ok = r.status === 0 && m && m[1] === m[2];
  if (m) total += +m[2];
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + f.padEnd(28) + (m ? m[0] : "no summary") + "  (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");
  if (!ok) {
    out.split(/\r?\n/).filter((l) => /^FAIL|HARNESS ERROR|Error/.test(l)).slice(0, 10).forEach((l) => console.log("     " + l));
  }
}

console.log("\n" + (failed ? failed + " suite(s) FAILED" : "all suites passed") + " — " + total + " checks in " + files.length + " suites");
process.exitCode = failed ? 1 : 0;
