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
// LIMITS were lowered from the planned 15 / 20 / 3: on the Gemini FREE tier, gemini-3.5-flash
// allows about 20 requests per day per Google Cloud project (measured by others; Google no longer
// publishes the number, see telegram-quotes-plan.md "Phase 4b notes"). Receipt scans and quote
// extraction share that same 20, and a quote can cost more than one call (shorten, voice
// corrections). Budget: 5 quotes × up to 2 calls + 8 receipts = 18, plus 2 corrections per quote
// eat into the margin; a Gemini 429 still fails gracefully (ai_busy). Raise these if the project
// moves to a paid tier or the quota page in AI Studio shows a higher limit.
//
// Errors: a DB/network failure throws QuotaError("quota_unavailable"); callers fail closed.
// Tests must never consume the live quota: pass opts.fetch (a mock).
"use strict";

const SUPABASE_URL = "https://mmognkxkglkotzkuxzly.supabase.co";
const LIMITS = Object.freeze({ quote: 5, receipt: 8, voiceCorrections: 2 });
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
