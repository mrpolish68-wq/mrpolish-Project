// Phase 4b offline tests: no network at all (every fetch is a mock). Fake data only.
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const X = require(REPO + "/api/_quote-extract.js");
const Q = require(REPO + "/api/_quota.js");
const I = X._internal;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? "PASS " : "FAIL ") + name + (detail !== undefined ? " — " + detail : ""));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Mock Gemini: returns the given object as the JSON text part; counts calls.
function geminiMock(responses) {
  let i = 0;
  const f = async function (url, init) {
    f.calls++; f.lastBody = JSON.parse(init.body);
    const r = typeof responses === "function" ? responses(i++) : responses[Math.min(i++, responses.length - 1)];
    if (r && r.__status) return { ok: false, status: r.__status, json: async () => r.body || {} };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(r) }] } }] }) };
  };
  f.calls = 0;
  return f;
}
const base = { client_name: null, address: null, items: [], stated_total: null, stated_total_evidence: null, quote_date: null, description_lines: [], transcript: "", missing: [] };
const opts = (f) => ({ fetch: f, apiKey: "test", todayIL: "27.10.2026" });

(async function () {
  // parseAmount
  const amounts = [
    ["4,500", 4500], ["סה\"כ 4,500 ש\"ח", 4500], ["4500", 4500], ["4.5 אלף", 4500], ["4 אלף", 4000],
    ["ארבעת אלפים וחמש מאות", 4500], ["שלושת אלפים ומאתיים", 3200], ["חמשת אלפים מאתיים", 5200],
    ["אלף וחצי", 1500], ["ארבעה וחצי אלף", 4500], ["עשרים אלף", 20000], ["שלוש מאות", 300],
    ["אלפיים ושמונה מאות", 2800], ["שתים עשרה", 12], ["מאה ועשרים", 120], ["סופי 3,200", 3200], ["בלי מספר", null]
  ];
  amounts.forEach(([s, v]) => check("parseAmount " + s, I.parseAmount(s) === v, "got " + I.parseAmount(s)));

  // stripPhones
  const phones = ["052-1234567", "0521234567", "052 123 4567", "+972-52-123-4567", "03-1234567", "+972521234567", "054-123-45-67"];
  phones.forEach((p) => {
    const s = I.stripPhones("טלפון " + p + " תודה");
    check("stripPhones " + p, !/\d{3}/.test(s), s);
  });
  ["4,500", "12000", "45 75 3375", "27.10.2026", "40 מטר × 80"].forEach((s) =>
    check("stripPhones keeps " + s, I.stripPhones(s) === s, I.stripPhones(s)));

  // verifyStatedTotal
  const src = "דני לוי, ליטוש 40 מטר 80 שקל למטר, סך הכל ארבעת אלפים וחמש מאות";
  const items = [{ unit_price: 80, line_total: 3200 }];
  check("total ok (words)", I.verifyStatedTotal(4500, "סך הכל ארבעת אלפים וחמש מאות", src, items).total === 4500);
  check("total rejected: evidence not in source", I.verifyStatedTotal(4500, "4,500", src, items).reason === "evidence_not_in_source");
  check("total rejected: evidence encodes another number", I.verifyStatedTotal(5000, "סך הכל ארבעת אלפים וחמש מאות", src, items).reason === "evidence_mismatch");
  check("total rejected: no evidence", I.verifyStatedTotal(4500, null, src, items).total === null);
  check("total rejected: unit price taken as total", I.verifyStatedTotal(80, "80 שקל", src, items).reason === "looks_like_unit_price");
  check("total ok: digits with comma vs without", I.verifyStatedTotal(3200, "סופי 3,200", "המחיר סופי 3200 שקל", []).total === 3200);

  // buildDraft: item math, sum mismatch, missing total, total-lines dropped, phone dropped from output
  let d = I.buildDraft(Object.assign({}, base, {
    client_name: "דני לוי 052-1234567", address: "הרצל 12 רעננה",
    items: [{ service: "ליטוש שיש", area_m2: 40, unit_price: 80 }, { service: "סילר", quantity: 1, unit_price: 1000 }],
    stated_total: 4500, stated_total_evidence: "סה\"כ 4,500",
    description_lines: ["1. ליטוש שיש 40 מ\"ר × 80 ₪", "2. סילר הגנה", "סה\"כ 4,200 ₪"]
  }), "דני לוי הרצל 12 רעננה ליטוש 40 מטר 80 שקל סילר 1000 סה\"כ 4,500", "", "27.10.2026", null);
  check("item math in code", d.items[0].line_total === 3200 && d.items[1].line_total === 1000 && d.items_sum === 4200, JSON.stringify(d.items.map(i => i.line_total)));
  check("stated total kept despite mismatch", d.total === 4500);
  check("sum_mismatch warning", d.warnings.some(w => w.code === "sum_mismatch" && w.items_sum === 4200 && w.total === 4500));
  check("total line removed from description", d.description_lines.length === 2);
  check("phone dropped from output", !/1234567/.test(JSON.stringify(d)), d.client_name);
  check("date defaults to today", d.quote_date === "27.10.2026" && d.quote_date_stated === false);

  d = I.buildDraft(Object.assign({}, base, { client_name: "כהן", items: [{ service: "הברקה", area_m2: 25, unit_price: 40 }], description_lines: ["הברקה"] }),
    "כהן הברקה 25 מטר 40 למטר", "", "27.10.2026", null);
  check("never fills total from items", d.total === null && d.missing.indexOf("total") !== -1 && d.items_sum === 1000);

  // extractQuote: empty input never calls Gemini
  let f = geminiMock([base]);
  try { await X.extractQuote({ text: "   " }, opts(f)); check("empty -> empty_input", false); }
  catch (e) { check("empty -> empty_input, no Gemini call", e.code === "empty_input" && f.calls === 0); }

  // phone stripped BEFORE sending
  f = geminiMock([Object.assign({}, base, { client_name: "משה" })]);
  await X.extractQuote({ text: "משה, טלפון 052-9876543, ליטוש" }, opts(f));
  check("phone not in request to Gemini", !/9876543/.test(JSON.stringify(f.lastBody)));

  // 429 -> ai_busy (with quota info), 500 -> ai_failed, invalid JSON -> ai_failed
  f = geminiMock([{ __status: 429, body: { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }, { retryDelay: "37s" }] } } }]);
  try { await X.extractQuote({ text: "בדיקה" }, opts(f)); check("429 -> ai_busy", false); }
  catch (e) { check("429 -> ai_busy", e.code === "ai_busy" && e.retryAfter === 37 && /=20$/.test(e.quota), e.code + " " + e.quota); }
  f = geminiMock([{ __status: 500 }]);
  try { await X.extractQuote({ text: "בדיקה" }, opts(f)); check("500 -> ai_failed", false); }
  catch (e) { check("500 -> ai_failed", e.code === "ai_failed"); }
  f = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }) });
  try { await X.extractQuote({ text: "בדיקה" }, opts(f)); check("bad JSON -> ai_failed", false); }
  catch (e) { check("bad JSON -> ai_failed", e.code === "ai_failed"); }
  f = async () => { throw new Error("timeout"); };
  try { await X.extractQuote({ text: "בדיקה" }, opts(f)); check("network -> ai_busy", false); }
  catch (e) { check("network -> ai_busy", e.code === "ai_busy"); }
  try { await X.extractQuote({ audio: Buffer.from("x"), mimeType: "video/mp4" }, opts(geminiMock([base]))); check("bad mime -> invalid_input", false); }
  catch (e) { check("bad mime -> invalid_input", e.code === "invalid_input"); }

  // shorten: too long -> exactly one shorten call, then re-check
  const long = Array.from({ length: 18 }, (_, i) => (i + 1) + ". שורה ארוכה");
  const short = ["1. מקוצר", "2. מקוצר"];
  f = geminiMock([Object.assign({}, base, { client_name: "א", description_lines: long }), { description_lines: short }]);
  d = await X.extractQuote({ text: "הצעה ארוכה" }, opts(f));
  check("shorten called once and applied", f.calls === 2 && d.fit.shortened && d.fit.fits && d.description_lines.length === 2);
  f = geminiMock([Object.assign({}, base, { client_name: "א", description_lines: long }), { description_lines: long }]);
  d = await X.extractQuote({ text: "הצעה ארוכה" }, opts(f));
  check("still too long -> too_long warning, no second shorten", f.calls === 2 && d.warnings.some(w => w.code === "too_long"));
  f = geminiMock([Object.assign({}, base, { client_name: "א", description_lines: ["קצר"] })]);
  d = await X.extractQuote({ text: "קצר" }, opts(f));
  check("fits -> no shorten call", f.calls === 1 && d.fit.shortened === false);

  // correction keeps the previous total unless the correction states one with evidence
  const prev = { client_name: "דני", address: "הרצל 12", items: [{ service: "ליטוש", area_m2: 40, unit_price: 80 }], total: 4500, total_source: "stated", quote_date: "27.10.2026", quote_date_stated: false, description_lines: ["ליטוש"] };
  f = geminiMock([Object.assign({}, base, { client_name: "דני", address: "הרצל 14", items: prev.items, stated_total: 9999, stated_total_evidence: null, description_lines: ["ליטוש"] })]);
  d = await X.applyCorrection(prev, { text: "הכתובת היא הרצל 14" }, opts(f));
  check("correction without a stated total keeps the old total", d.total === 4500 && d.address === "הרצל 14");

  // quota: mocked RPC only
  function rpcMock(value, status) {
    const m = async (url, init) => { m.calls.push({ url, body: JSON.parse(init.body) }); return { ok: !status, status: status || 200, json: async () => value }; };
    m.calls = []; return m;
  }
  let m = rpcMock(4);
  let r = await Q.consumeQuota("quote", { fetch: m, serviceKey: "k" });
  check("consumeQuota ok", r.ok && r.remaining === 4 && /rpc\/consume_daily_quota$/.test(m.calls[0].url) && eq(m.calls[0].body, { p_kind: "quote", p_limit: Q.LIMITS.quote }));
  m = rpcMock(-1);
  r = await Q.consumeQuota("receipt", { fetch: m, serviceKey: "k" });
  check("consumeQuota at limit -> ok:false", !r.ok && r.remaining === 0 && m.calls[0].body.p_limit === Q.LIMITS.receipt);
  m = rpcMock(3);
  check("getRemaining", (await Q.getRemaining("quote", { fetch: m, serviceKey: "k" })) === 3 && /get_daily_quota_remaining$/.test(m.calls[0].url));
  try { await Q.consumeQuota("voiceCorrections", { fetch: rpcMock(1), serviceKey: "k" }); check("voiceCorrections not daily", false); }
  catch (e) { check("voiceCorrections is not a daily RPC kind", e.code === "invalid_kind"); }
  try { await Q.consumeQuota("quote", { fetch: rpcMock(null, 500), serviceKey: "k" }); check("HTTP 500 -> quota_unavailable", false); }
  catch (e) { check("HTTP 500 -> quota_unavailable", e.code === "quota_unavailable"); }
  try { await Q.consumeQuota("quote", { fetch: rpcMock("x"), serviceKey: "k" }); check("bad response -> quota_unavailable", false); }
  catch (e) { check("bad response -> quota_unavailable", e.code === "quota_unavailable"); }
  check("LIMITS", eq(Q.LIMITS, { quote: 15, receipt: 20, voiceCorrections: 3 }) && Object.isFrozen(Q.LIMITS));

  // spend cap / billing refusals -> ai_busy; an unrelated 400 stays ai_failed
  const busyCases = [
    [{ __status: 403, body: { error: { message: "Your project has exceeded its monthly spending cap." } } }, "ai_busy"],
    [{ __status: 400, body: { error: { message: "Billing account is disabled" } } }, "ai_busy"],
    [{ __status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted" } } }, "ai_busy"],
    [{ __status: 400, body: { error: { message: "Invalid JSON payload received." } } }, "ai_failed"]
  ];
  for (const [resp, want] of busyCases) {
    try { await X.extractQuote({ text: "בדיקה" }, opts(geminiMock([resp]))); check("refusal " + resp.__status + " -> " + want, false); }
    catch (e) { check("refusal " + resp.__status + " '" + resp.body.error.message.slice(0, 30) + "' -> " + want, e.code === want, e.code); }
  }

  console.log("\n" + pass + "/" + (pass + fail) + " passed");
  if (fail) process.exitCode = 1;
})();
