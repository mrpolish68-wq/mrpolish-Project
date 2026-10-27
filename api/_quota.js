// Daily quotas for the Telegram bot (Telegram quotes, Phase 4b). Underscore-prefixed, so Vercel
// treats it as a helper, not a route.
//
//   consumeQuota(kind)  -> { ok, remaining }   uses one unit of today's quota (atomic, in the DB)
//   getRemaining(kind)  -> remaining           read-only, for "📊 נותרו היום: N הצעות מחיר"
//
// kind is "quote" or "receipt". Both call the service_role-only RPCs consume_daily_quota /
// get_daily_quota_remaining (supabase-quotes-telegram.sql §5): global across chats, reset at
// midnight Asia/Jerusalem. voiceCorrections is a per-quote cap kept on
// telegram_pending_quotes.voice_corrections, not a daily quota, so it has a limit here but no RPC.
//
// LIMITS are the planned 15 / 20 / 3. The Gemini key is on a PAID Tier 1 project (AI Studio shows
// ~10K requests/day per model), so Google's quota is far above this; what actually bounds usage is
// the owner's monthly spend cap. These limits keep a runaway loop or abuse from eating that cap.
// If the cap is reached (or Google rate-limits), Gemini calls fail as ai_busy and the bot shows
// its friendly "busy" message.
//
// Errors: a DB/network failure throws QuotaError("quota_unavailable"); callers fail closed.
// Tests must never consume the live quota: pass opts.fetch (a mock).
"use strict";

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const LIMITS = Object.freeze({ quote: 15, receipt: 20, voiceCorrections: 3 });
const DAILY_KINDS = ["quote", "receipt"];
const FETCH_TIMEOUT_MS = 8000;

class QuotaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "QuotaError";
    this.code = code; // "invalid_kind" | "quota_unavailable"
  }
}

function checkKind(kind) {
  if (DAILY_KINDS.indexOf(kind) === -1) throw new QuotaError("invalid_kind", "not a daily quota kind: " + kind);
}

async function rpc(name, kind, opts) {
  var key = (opts && opts.serviceKey) || process.env.SUPABASE_SERVICE_ROLE_KEY;
  var doFetch = (opts && opts.fetch) || fetch;
  if (!key) throw new QuotaError("quota_unavailable", "missing SUPABASE_SERVICE_ROLE_KEY");
  var res;
  try {
    res = await doFetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_kind: kind, p_limit: LIMITS[kind] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    console.error("[quota] " + name + " network error");
    throw new QuotaError("quota_unavailable", name + " unreachable");
  }
  if (!res.ok) {
    console.error("[quota] " + name + " HTTP " + res.status); // status only, never the body
    throw new QuotaError("quota_unavailable", name + " HTTP " + res.status);
  }
  var value = await res.json().catch(function () { return null; });
  if (typeof value !== "number" || !isFinite(value)) throw new QuotaError("quota_unavailable", name + " bad response");
  return value;
}

// remaining is what's left AFTER this use; ok:false (remaining 0) when the limit was already reached.
async function consumeQuota(kind, opts) {
  checkKind(kind);
  var v = await rpc("consume_daily_quota", kind, opts);
  return v < 0 ? { ok: false, remaining: 0 } : { ok: true, remaining: v };
}

async function getRemaining(kind, opts) {
  checkKind(kind);
  return Math.max(0, await rpc("get_daily_quota_remaining", kind, opts));
}

module.exports = { LIMITS: LIMITS, consumeQuota: consumeQuota, getRemaining: getRemaining, QuotaError: QuotaError };
