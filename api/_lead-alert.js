// Instant Telegram alert for every new site lead (media-projects plan, Phase 4; decision D11:
// alerts go to the production bot's allowed chats). Served by api/analytics-agent.js at
// POST /api/analytics-agent?task=lead-alert — no new Vercel function.
//
// Who calls it: the database. supabase-lead-alert.sql adds an AFTER INSERT trigger on public.leads
// that queues an async pg_net POST {id} with the X-Internal-Secret header (DB_WEBHOOK_SECRET, read
// from Supabase Vault). The trigger swallows every error, so a lead insert can never fail because
// of the alert. A pg_cron sweep calls this endpoint without an id to re-send any recent lead whose
// alert didn't go out (Telegram down, the endpoint not reachable, …).
//
// Idempotent: leads.notified_at is claimed with a conditional PATCH (only while it's still NULL),
// so the trigger's call and a sweep can never both send. If no chat could be reached, the claim is
// released so the next sweep retries. Logs carry the lead id only (no name / phone).
"use strict";

const crypto = require("crypto");
const { allowedChatIds, telegramConfig, tgCallTimed } = require("./_telegram.js");
const { formatIsraelTime } = require("./_publish-notify.js");

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const PANEL_URL = "https://mr-polishes.com/admin.html";
const SEPARATOR = "━━━━━━━━━━";
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000; // only leads from the last 24 h are (re)sent
const SWEEP_MIN_AGE_MS = 60 * 1000;          // leave a brand-new lead to the trigger's own call
const SWEEP_MAX = 10;
var timeoutMs = 8000;

function safeEqual(a, b) {
  var bufA = Buffer.from(String(a || ""), "utf8");
  var bufB = Buffer.from(String(b || ""), "utf8");
  if (!bufA.length || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function supabaseHeaders(extra) {
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign({ apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(path, init) {
  init = Object.assign({ signal: AbortSignal.timeout(10000) }, init || {});
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, init);
  if (!res.ok) throw new Error("Supabase " + (init.method || "GET") + " leads failed: " + res.status);
  return res.status === 204 ? null : res.json();
}

function clean(s, max) {
  var t = String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]+/g, " ").replace(/[ \t]+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

// The form appends "[הסכמה לדיוור שיווקי: כן/לא]" to notes (an audit trail, main.js §3).
function splitNotes(notes) {
  var raw = String(notes || "");
  var m = raw.match(/\n?\[הסכמה לדיוור שיווקי: (כן|לא)\]\s*$/);
  return { message: (m ? raw.slice(0, m.index) : raw).trim(), marketing: m ? m[1] : null };
}

// An Israeli phone → the wa.me number (972…), or null if it doesn't look like one.
function waNumber(phone) {
  var d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("00972")) d = d.slice(2);
  if (!d.startsWith("972")) {
    if (d.startsWith("0")) d = "972" + d.slice(1);
    else if (d.length === 9) d = "972" + d;
  }
  return /^972[2-9]\d{7,8}$/.test(d) ? d : null;
}

function buildLeadMessage(lead) {
  var notes = splitNotes(lead.notes);
  var name = clean(lead.name, 60) || "—";
  var lines = ["🔔 ליד חדש מהאתר", SEPARATOR, "👤 " + name, "📞 " + (clean(lead.phone, 30) || "—"), "🛠️ " + (clean(lead.service, 80) || "—")];
  if (lead.location) lines.push("📍 " + clean(lead.location, 80));
  if (notes.message) lines.push("💬 " + clean(notes.message, 500));
  lines.push("🕐 " + formatIsraelTime(lead.created_at ? new Date(lead.created_at) : new Date()));

  var buttons = [];
  var wa = waNumber(lead.phone);
  if (wa) {
    var first = name.split(" ")[0];
    var text = "היי " + first + ", כאן מיסטר פוליש 👋 קיבלנו את הפנייה שלך מהאתר.";
    buttons.push({ text: "💬 וואטסאפ", url: "https://wa.me/" + wa + "?text=" + encodeURIComponent(text) });
  }
  buttons.push({ text: "🗂️ פתח בפאנל", url: PANEL_URL });
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons.map(function (b) { return [b]; }) } };
}

async function sendToChats(msg) {
  var cfg = telegramConfig();
  var chats = allowedChatIds();
  if (!cfg.botToken || !chats.length) return { sent: 0, configured: false };
  var sent = 0;
  for (var i = 0; i < chats.length; i++) {
    try {
      await tgCallTimed("sendMessage", { chat_id: chats[i], text: msg.text, reply_markup: msg.reply_markup, disable_web_page_preview: true }, timeoutMs);
      sent++;
    } catch (err) {
      console.error("[lead-alert] send failed: " + err.message);
    }
  }
  return { sent: sent, configured: true };
}

// One lead: claim notified_at (only while NULL) → send → release the claim if nothing was delivered.
async function alertOne(id) {
  var rows = await rest("leads?id=eq." + encodeURIComponent(id) + "&select=id,created_at,name,phone,service,notes,location,notified_at");
  var lead = rows && rows[0];
  if (!lead) return { id: id, status: "not_found" };
  if (lead.notified_at) return { id: id, status: "already_notified" };

  var claimedAt = new Date().toISOString();
  var claimed = await rest("leads?id=eq." + encodeURIComponent(id) + "&notified_at=is.null", {
    method: "PATCH", headers: supabaseHeaders({ Prefer: "return=representation" }), body: JSON.stringify({ notified_at: claimedAt })
  });
  if (!Array.isArray(claimed) || !claimed.length) return { id: id, status: "already_notified" };

  var result;
  try {
    result = await sendToChats(buildLeadMessage(lead));
  } catch (err) {
    result = { sent: 0, configured: true };
    console.error("[lead-alert] build/send failed id=" + id + ": " + err.message);
  }
  if (!result.sent) {
    // Release the claim so the next sweep retries (only our own claim: notified_at still = claimedAt).
    await rest("leads?id=eq." + encodeURIComponent(id) + "&notified_at=eq." + encodeURIComponent(claimedAt), {
      method: "PATCH", headers: supabaseHeaders({ Prefer: "return=minimal" }), body: JSON.stringify({ notified_at: null })
    }).catch(function (err) { console.error("[lead-alert] release failed id=" + id + ": " + err.message); });
    console.error("[lead-alert] not delivered id=" + id + (result.configured ? "" : " (bot not configured)"));
    return { id: id, status: "not_delivered" };
  }
  console.log("[lead-alert] sent id=" + id + " chats=" + result.sent);
  return { id: id, status: "sent", chats: result.sent };
}

async function sweep() {
  var now = Date.now();
  var rows = await rest("leads?select=id&notified_at=is.null" +
    "&created_at=gte." + encodeURIComponent(new Date(now - SWEEP_WINDOW_MS).toISOString()) +
    "&created_at=lte." + encodeURIComponent(new Date(now - SWEEP_MIN_AGE_MS).toISOString()) +
    "&order=created_at.asc&limit=" + SWEEP_MAX);
  var results = [];
  for (var i = 0; i < (rows || []).length; i++) results.push(await alertOne(rows[i].id));
  return results;
}

// POST /api/analytics-agent?task=lead-alert   headers: X-Internal-Secret   body: {id} (or {} = sweep)
async function handleLeadAlert(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  var secret = process.env.DB_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.headers["x-internal-secret"], secret)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY configuration." });
    return;
  }
  var id = req.body && req.body.id;
  try {
    if (id === undefined || id === null || id === "") {
      var results = await sweep();
      res.status(200).json({ ok: true, swept: results.length, results: results });
      return;
    }
    if (!/^[1-9]\d{0,17}$/.test(String(id))) {
      res.status(400).json({ error: "Invalid lead id." });
      return;
    }
    var r = await alertOne(String(id));
    var code = r.status === "not_found" ? 404 : r.status === "not_delivered" ? 502 : 200;
    res.status(code).json(Object.assign({ ok: code === 200 }, r));
  } catch (err) {
    console.error("[lead-alert] failed: " + err.message);
    res.status(500).json({ error: "Lead alert failed." });
  }
}

module.exports = { handleLeadAlert, alertOne, sweep, buildLeadMessage, waNumber, splitNotes,
  _setTimeoutMs: function (ms) { timeoutMs = ms; } };
