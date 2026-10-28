// Runs supabase-quotes-idempotency.sql for real in PGlite (Postgres 17) against a stub of the live
// schema (quotes + counter + the ORIGINAL create_quote from supabase-quotes-telegram.sql + roles).
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const orig = fs.readFileSync(ROOT + "supabase-quotes-telegram.sql", "utf8");
const fix = fs.readFileSync(ROOT + "supabase-quotes-idempotency.sql", "utf8");
const block = (s, start, end) => { const i = s.indexOf(start); const j = s.indexOf(end, i); return s.slice(i, j); };

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else fail++; console.log((c ? "PASS " : "FAIL ") + n + (d !== undefined ? " — " + d : "")); };
const one = async (q, p) => (await db.query(q, p)).rows[0];
async function asService(fn) { await db.exec("begin; select set_config('role','service_role',true); select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true);"); try { return await fn(); } finally { await db.exec("commit;"); } }

// --- stub of the live schema (Phase 3b state) ---
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.quotes (id uuid primary key default gen_random_uuid(), number int not null, quote_date text not null,
    client_name text not null, address text, description text, total numeric(10,2) not null default 0, created_at timestamptz default now(),
    source text not null default 'panel', vat_mode text not null default 'exempt', pdf_path text, telegram_chat_id bigint, updated_at timestamptz not null default now());
  create unique index quotes_number_idx on public.quotes(number);
  create table public.telegram_pending_receipts (id uuid primary key default gen_random_uuid(), chat_id bigint not null);
  alter table public.telegram_pending_receipts enable row level security;
  grant all on table public.telegram_pending_receipts to anon, authenticated;
  grant all on all tables in schema public to service_role;
`);
await db.exec(block(orig, "create table if not exists public.quote_counter", "-- create_quote(p jsonb)"));
await db.exec(block(orig, "create or replace function public.create_quote(p jsonb)", "-- ----") );
for (let n = 6; n <= 13; n++) await db.query("insert into public.quotes(number, quote_date, client_name) values ($1, $2, $3)", [n, n + ".10.2026", "לקוח " + n]);

// --- the OLD function ignores client_ref (code works before the SQL is applied) ---
await db.exec("begin;");
const pre = await one("select (public.create_quote(jsonb_build_object('client_name','x','quote_date','1.1.2026','total',1,'client_ref','abc'))).number as n");
await db.exec("rollback;");
check("BEFORE the fix: the old create_quote accepts and ignores client_ref", pre.n === 14);

// --- apply the fix, twice (idempotent) ---
await db.exec(fix);
await db.exec(fix);
check("the file applies cleanly, and again (idempotent)", true);
check("quotes.client_ref exists", !!(await one("select 1 as x from information_schema.columns where table_name='quotes' and column_name='client_ref'")));
check("unique partial index quotes_client_ref_key exists", /UNIQUE .* WHERE \(client_ref IS NOT NULL\)/i.test((await one("select indexdef from pg_indexes where indexname='quotes_client_ref_key'")).indexdef));
const fn = await one("select prosecdef, proconfig from pg_proc where oid = 'public.create_quote(jsonb)'::regprocedure");
check("create_quote still SECURITY DEFINER with search_path=\"\"", fn.prosecdef === true && JSON.stringify(fn.proconfig) === JSON.stringify(['search_path=""']), JSON.stringify(fn.proconfig));
const grants = (await db.query("select grantee from information_schema.routine_privileges where routine_name='create_quote' and privilege_type='EXECUTE'")).rows.map(r => r.grantee).sort();
check("create_quote EXECUTE: authenticated + service_role (+ owner), not anon/public", grants.includes("authenticated") && grants.includes("service_role") && !grants.includes("anon") && !grants.includes("PUBLIC"), grants.join(","));

// --- idempotency (panel caller = not service) ---
const counter = async () => (await one("select floor_next from public.quote_counter")).floor_next;
const a = await one("select * from public.create_quote(jsonb_build_object('client_name','דני','quote_date','01.01.2026','total',100,'client_ref','ref-A'))");
const f1 = await counter();
const b = await one("select * from public.create_quote(jsonb_build_object('client_name','שונה','quote_date','02.02.2026','total',999,'client_ref','ref-A'))");
const f2 = await counter();
check("first call with client_ref -> new quote 014", a.number === 14 && a.client_ref === "ref-A");
check("retry with the SAME client_ref -> the SAME row (id + number), stored fields unchanged", b.id === a.id && b.number === 14 && b.client_name === "דני" && Number(b.total) === 100);
check("…and the counter did not move on the retry", f2 === f1 && f1 === 15, "f1=" + f1 + " f2=" + f2);
check("still exactly one row for ref-A", (await one("select count(*)::int as n from public.quotes where client_ref='ref-A'")).n === 1);
const c = await one("select * from public.create_quote(jsonb_build_object('client_name','רינה','quote_date','01.01.2026','total',5,'client_ref','ref-B'))");
check("a different client_ref -> a new number (015)", c.number === 15);
const d = await one("select * from public.create_quote(jsonb_build_object('client_name','ללא','quote_date','01.01.2026','total',5))");
const e = await one("select * from public.create_quote(jsonb_build_object('client_name','ללא','quote_date','01.01.2026','total',5,'client_ref','  '))");
check("no client_ref (or blank) -> behaves exactly as before: a new number each time, client_ref NULL", d.number === 16 && e.number === 17 && d.client_ref === null && e.client_ref === null);
let tooLong = null; try { await db.query("select public.create_quote(jsonb_build_object('client_name','x','quote_date','1.1.2026','client_ref', repeat('x',101)))"); } catch (err) { tooLong = err.message; }
check("client_ref > 100 chars -> 22023 'client_ref is too long'", /client_ref is too long/.test(tooLong || ""));

// --- the bot (service_role) path still validated + honored ---
const t = await asService(() => one("select * from public.create_quote(jsonb_build_object('client_name','בוט','quote_date','01.01.2026','total',4500,'source','telegram','telegram_chat_id',123,'client_ref','draft-uuid-1'))"));
const t2 = await asService(() => one("select * from public.create_quote(jsonb_build_object('client_name','בוט','quote_date','01.01.2026','total',4500,'source','telegram','telegram_chat_id',123,'client_ref','draft-uuid-1'))"));
check("bot: source telegram + chat id honored, retry returns the same quote", t.source === "telegram" && t.telegram_chat_id === 123n || t.telegram_chat_id === 123 || String(t.telegram_chat_id) === "123");
check("bot: retry with the draft id -> same id/number", t2.id === t.id && t2.number === t.number);
let zero = null; try { await asService(() => db.query("select public.create_quote(jsonb_build_object('client_name','בוט','quote_date','1.1.2026','total',0,'source','telegram','telegram_chat_id',1,'client_ref','z'))")); } catch (err) { zero = err.message; await db.exec("rollback;").catch(() => {}); }
check("bot: total 0 still refused (validation unchanged)", /total must be greater than 0/.test(zero || ""));
const panelTg = await one("select * from public.create_quote(jsonb_build_object('client_name','פאנל','quote_date','1.1.2026','total',1,'source','telegram','telegram_chat_id',9,'client_ref','p-1'))");
check("panel caller can't set source/chat (unchanged)", panelTg.source === "panel" && panelTg.telegram_chat_id === null);

// --- the unique index is the last guard ---
let dup = null; try { await db.query("insert into public.quotes(number, quote_date, client_name, client_ref) values (999, 'x', 'x', 'ref-A')"); } catch (err) { dup = err.message; }
check("a direct second row with the same client_ref is rejected by the unique index", /duplicate key|unique/i.test(dup || ""));

// --- L7 ---
const rg = (await db.query("select grantee from information_schema.role_table_grants where table_name='telegram_pending_receipts' and grantee in ('anon','authenticated')")).rows;
check("L7: no anon/authenticated grants left on telegram_pending_receipts", rg.length === 0);
const sg = (await db.query("select count(*)::int as n from information_schema.role_table_grants where table_name='telegram_pending_receipts' and grantee='service_role'")).rows[0].n;
check("L7: service_role keeps its access", sg > 0);

console.log("\n" + pass + "/" + (pass + fail) + " passed");
if (fail) process.exitCode = 1;
