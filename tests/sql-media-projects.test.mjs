// Runs the three media-projects SQL files for real in PGlite (Postgres 17) against a stub of the
// live schema, with small stand-ins for what Supabase provides (vault, pg_net's `net`, pg_cron's
// `cron`, storage). The `create extension pg_net` line is the only statement removed (PGlite has no
// pg_net); the test asserts it is present in the files.
//   supabase-scheduler-pgcron.sql · supabase-lead-alert.sql · supabase-media-projects.sql
import { PGlite } from "@electric-sql/pglite";
import fs from "fs";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (f) => fs.readFileSync(ROOT + f, "utf8");
const PGNET_RE = /create extension if not exists pg_net with schema extensions;/;
const SCHED = read("supabase-scheduler-pgcron.sql"), LEAD = read("supabase-lead-alert.sql"), MEDIA = read("supabase-media-projects.sql");
const QUOTES = read("supabase-quotes-telegram.sql");
const REALTIME = read("supabase-projects-realtime.sql");
const runnable = (s) => s.replace(PGNET_RE, "-- (pg_net: provided by the stub)");
const block = (s, start, end) => { const i = s.indexOf(start); const j = s.indexOf(end, i); return s.slice(i, j); };

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) pass++; else fail++; console.log((c ? "PASS " : "FAIL ") + n + (d !== undefined && !c ? " — " + d : "")); };
const one = async (q, p) => (await db.query(q, p)).rows[0];
const all = async (q, p) => (await db.query(q, p)).rows;
async function errOf(fn) { try { await fn(); return null; } catch (e) { return e.message; } }
async function as(role, fn) { await db.exec("set role " + role); try { return await fn(); } finally { await db.exec("reset role"); } }

// ---------------------------------------------------------------- stub of the live schema
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  grant usage on schema public to anon, authenticated, service_role;

  create type public.content_media_type as enum ('image','video','reel','story');
  create type public.content_status as enum ('pending_approval','approved','rejected','published','failed','scheduled');
  create table public.content_queue (id uuid primary key default gen_random_uuid(), title text, media_type public.content_media_type not null default 'image',
    status public.content_status not null default 'pending_approval', scheduled_for timestamptz default now());
  create table public.content_queue_archive (id uuid primary key, title text, media_type public.content_media_type, status public.content_status,
    scheduled_for timestamptz, link_url text, archived_at timestamptz default now());
  create table public.quotes (id uuid primary key default gen_random_uuid());
  create table public.social_comments (id uuid primary key default gen_random_uuid());

  create table public.leads (id bigserial primary key, created_at timestamptz not null default now(), name text, phone text,
    service text, notes text, location text);
  alter table public.leads enable row level security;
  grant all on table public.leads to anon, authenticated;
  grant usage on sequence public.leads_id_seq to anon;
  create policy "Allow anonymous inserts" on public.leads for insert to anon with check (name is not null and length(trim(name)) >= 2);
  insert into public.leads (created_at, name, phone, service) values (now() - interval '120 days', 'ישן', '0500000000', 'x');

  -- storage
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;            -- as on Supabase
  grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  insert into storage.buckets values ('content-media','content-media', true, null, null), ('receipts','receipts', false, 15728640, array['image/jpeg']);
  create policy "authenticated can upload content-media" on storage.objects for insert to authenticated with check (bucket_id = 'content-media');
  create policy "public can read content-media" on storage.objects for select to public using (bucket_id = 'content-media');
  create policy "authenticated can read receipts" on storage.objects for select to authenticated using (bucket_id = 'receipts');

  -- vault (Supabase): decrypted_secrets is readable by the owner only
  create schema vault;
  create table vault.secrets (name text primary key, secret text, created_at timestamptz default now());
  create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
  revoke all on schema vault from public;

  -- pg_net stand-in: records requests; net.fail makes every call raise
  create schema net;
  create table net.requests (id bigserial primary key, method text, url text, body jsonb, headers jsonb, timeout_ms int);
  create table net.settings (fail boolean not null default false);
  insert into net.settings values (false);
  create function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language plpgsql as $$ declare i bigint; begin
      if (select fail from net.settings) then raise exception 'pg_net unavailable'; end if;
      insert into net.requests(method, url, headers, timeout_ms) values ('GET', url, headers, timeout_milliseconds) returning id into i; return i; end $$;
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language plpgsql as $$ declare i bigint; begin
      if (select fail from net.settings) then raise exception 'pg_net unavailable'; end if;
      insert into net.requests(method, url, body, headers, timeout_ms) values ('POST', url, body, headers, timeout_milliseconds) returning id into i; return i; end $$;
  revoke all on schema net from public;

  -- pg_cron stand-in: schedule() upserts by name, like pg_cron ≥ 1.3
  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
  create function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
`);
// the live quota table + functions, exactly as supabase-quotes-telegram.sql created them
await db.exec(block(QUOTES, "create table if not exists public.telegram_daily_usage", "-- -------------------------------------------------------------\n-- 5."));
await db.exec(block(QUOTES, "create or replace function public.consume_daily_quota", "-- -------------------------------------------------------------\n-- 6."));
const runJob = async (name) => { const j = await one("select command from cron.job where jobname = $1", [name]); await db.exec(j.command); };
const requests = async () => all("select method, url, body, headers, timeout_ms from net.requests order by id");
const clearRequests = () => db.exec("delete from net.requests");

// ================================================================ 1. scheduler
check("scheduler: the file enables pg_net (create extension … with schema extensions)", PGNET_RE.test(SCHED));
await db.exec(runnable(SCHED));
await db.exec(runnable(SCHED));
const jobs = await all("select jobname, schedule from cron.job where jobname = 'publish-every-10-min'");
check("scheduler: applies twice → exactly one job, minutes 5,15,25,… ('5-59/10 * * * *')", jobs.length === 1 && jobs[0].schedule === "5-59/10 * * * *", JSON.stringify(jobs));
await runJob("publish-every-10-min");
check("scheduler: no Vault secret yet → the job sends nothing", (await requests()).length === 0);
await db.exec("insert into vault.secrets(name, secret) values ('cron_secret', 'cron-fake-123')");
await runJob("publish-every-10-min");
let r = await requests();
check("scheduler: with the secret → one GET to the existing production endpoint", r.length === 1 && r[0].method === "GET" && r[0].url === "https://mr-polishes.com/api/publish-scheduled-content", JSON.stringify(r));
check("scheduler: same auth as Vercel cron / GitHub (Authorization: Bearer <CRON_SECRET>), 55 s timeout", r[0] && r[0].headers.Authorization === "Bearer cron-fake-123" && r[0].timeout_ms === 55000);
check("scheduler: the job text never contains the secret", !(await one("select command from cron.job where jobname='publish-every-10-min'")).command.includes("cron-fake-123"));
await clearRequests();

// ================================================================ 2. lead alert
check("lead alert: the file enables pg_net", PGNET_RE.test(LEAD));
await db.exec(runnable(LEAD));
await db.exec(runnable(LEAD));
check("lead alert: applies twice cleanly", true);
check("lead alert: the existing (old) lead counts as notified — never alerted", (await one("select notified_at is not null as n from public.leads where name='ישן'")).n === true);
const trig = (await all("select tgname from pg_trigger where tgrelid = 'public.leads'::regclass and not tgisinternal order by 1")).map(x => x.tgname);
check("lead alert: triggers leads_notify (after) + leads_reset_notified (before)", JSON.stringify(trig) === '["leads_notify","leads_reset_notified"]', trig.join(","));
const fnDef = await one("select prosecdef, proconfig from pg_proc where proname = 'notify_new_lead'");
check("lead alert: notify_new_lead is SECURITY DEFINER with search_path=\"\"", fnDef.prosecdef === true && JSON.stringify(fnDef.proconfig) === '["search_path=\\"\\""]', JSON.stringify(fnDef.proconfig));

// no secret → the insert works, nothing is sent
await as("anon", () => db.query("insert into public.leads (name, phone, service) values ('בדיקה א', '0501111111', 'x')"));
check("lead alert: no Vault secret → the anon insert still succeeds, nothing sent", (await requests()).length === 0 &&
  (await one("select count(*)::int as n from public.leads where name='בדיקה א'")).n === 1);

await db.exec("insert into vault.secrets(name, secret) values ('db_webhook_secret', 'db-hook-fake-456')");
await as("anon", () => db.query("insert into public.leads (name, phone, service, notified_at) values ('בדיקה ב', '0502222222', 'x', now())"));
r = await requests();
const leadB = await one("select id, notified_at from public.leads where name='בדיקה ב'");
check("lead alert: anon insert → one POST to ?task=lead-alert with {id}", r.length === 1 && r[0].method === "POST" &&
  r[0].url === "https://mr-polishes.com/api/analytics-agent?task=lead-alert" && String(r[0].body.id) === String(leadB.id), JSON.stringify(r));
check("lead alert: header X-Internal-Secret from Vault (db_webhook_secret)", r[0] && r[0].headers["X-Internal-Secret"] === "db-hook-fake-456");
check("lead alert: a public insert can't pre-set notified_at (reset to NULL)", leadB.notified_at === null);
check("lead alert: anon can't read Vault directly", /permission denied/.test(await as("anon", () => errOf(() => db.query("select * from vault.decrypted_secrets"))) || ""));
await clearRequests();

// pg_net failing → the insert must still succeed
await db.exec("update net.settings set fail = true");
const errNet = await as("anon", () => errOf(() => db.query("insert into public.leads (name, phone, service) values ('בדיקה ג', '0503333333', 'x')")));
await db.exec("update net.settings set fail = false");
check("lead alert: pg_net raising → the lead insert STILL succeeds (warning only)", errNet === null &&
  (await one("select count(*)::int as n from public.leads where name='בדיקה ג'")).n === 1, errNet);
check("lead alert: the RLS check on leads is unchanged (a bad insert is still refused)",
  /row-level security/.test(await as("anon", () => errOf(() => db.query("insert into public.leads (name, phone, service) values ('', '1', 'x')"))) || ""));

// sweep job
await runJob("lead-alert-sweep");
check("sweep: pending leads exist but all are < 1 minute old → nothing sent (the trigger goes first)", (await requests()).length === 0);
await db.exec("update public.leads set created_at = now() - interval '5 minutes' where name like 'בדיקה%'");
await runJob("lead-alert-sweep");
r = await requests();
check("sweep: a pending lead older than 1 minute → one POST without an id (the endpoint sweeps)", r.length === 1 && r[0].url.endsWith("?task=lead-alert") &&
  JSON.stringify(r[0].body) === "{}" && r[0].headers["X-Internal-Secret"] === "db-hook-fake-456", JSON.stringify(r));
await clearRequests();
await db.exec("update public.leads set notified_at = now()");
await runJob("lead-alert-sweep");
check("sweep: nothing pending → nothing sent", (await requests()).length === 0);
await db.exec("update public.leads set notified_at = null, created_at = now() - interval '2 days' where name = 'בדיקה א'");
await runJob("lead-alert-sweep");
check("sweep: a lead older than 24 h is never re-sent", (await requests()).length === 0);

// ================================================================ 3. media projects schema
await db.exec(MEDIA);
await db.exec(MEDIA);
check("schema: applies twice cleanly (idempotent)", true);
check("schema: enum content_media_type has 'carousel'", (await one("select 'carousel' = any(enum_range(null::public.content_media_type)::text[]) as ok")).ok === true);
const mirror = await all("select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('content_queue','content_queue_archive') and column_name in ('project_id','media_items') order by 1,2");
check("schema: project_id + media_items on content_queue AND content_queue_archive (mirrored)", mirror.length === 4, JSON.stringify(mirror));
const rls = await all("select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('projects','project_media','project_publications','weekly_reports')");
check("schema: 4 new tables, RLS on all", rls.length === 4 && rls.every(t => t.rowsecurity), JSON.stringify(rls));
check("schema: social_comments.notified_at", !!(await one("select 1 as x from information_schema.columns where table_name='social_comments' and column_name='notified_at'")));

// constraints (D2, D7)
const now = "now()";
check("D2: publishing without consent is refused", /consent/.test(await errOf(() => db.query("insert into public.projects (slug, status) values ('a', 'published')")) || ""));
check("D7: slug must be lowercase-latin-with-dashes", /projects_slug_check/.test(await errOf(() => db.query("insert into public.projects (slug) values ('ליטוש בזלת')")) || ""));
check("D7: a city with digits (a house number) is refused", /projects_city_check/.test(await errOf(() => db.query("insert into public.projects (city) values ('הרצל 12')")) || ""));
check("consent yes/no needs consent_at", /projects_consent_time/.test(await errOf(() => db.query("insert into public.projects (consent) values ('yes')")) || ""));
check("watermark defaults to true (D4)", (await one("insert into public.projects (slug) values ('wm-default') returning watermark")).watermark === true);

// D3: flagged media blocks publishing until reviewed
const pid = (await one("insert into public.projects (slug, service, city, consent, consent_at, status) values ('litush-basalt-beit-shemesh','floor_polish','בית שמש','yes'," + now + ",'ready') returning id")).id;
const mid = (await one("insert into public.project_media (project_id, kind, role, original_path, ai_flags) values ($1,'image','before','p/1.jpg','{\"faces\": true}') returning id", [pid])).id;
await db.query("insert into public.project_media (project_id, kind, role, original_path, ai_flags) values ($1,'image','after','p/2.jpg','{\"faces\": false, \"plates\": false}')", [pid]);
check("D3: a face flag not yet reviewed blocks publishing", /flagged media/.test(await errOf(() => db.query("update public.projects set status='published', published_at=now() where id=$1", [pid])) || ""));
check("D3: …and blocks scheduling to Facebook/Instagram too", /flagged media/.test(await errOf(() => db.query("insert into public.project_publications (project_id, destination) values ($1,'facebook')", [pid])) || ""));
await db.query("update public.project_media set flags_ack_at = now() where id = $1", [mid]);
check("D3: after 'בדקתי, אפשר לפרסם' → publishing works", (await errOf(() => db.query("update public.projects set status='published', published_at=now() where id=$1", [pid]))) === null);
check("D3: …and scheduling works", (await errOf(() => db.query("insert into public.project_publications (project_id, destination) values ($1,'instagram')", [pid]))) === null);
const pNo = (await one("insert into public.projects (slug, consent, consent_at, status) values ('private-one','no'," + now + ",'draft') returning id")).id;
check("D2: no consent → can't be scheduled to social either", /consent/.test(await errOf(() => db.query("insert into public.project_publications (project_id, destination) values ($1,'facebook')", [pNo])) || ""));
check("updated_at is touched on update", (await one("select updated_at > created_at as t from public.projects where id=$1", [pid])).t === true);

// RLS: the public sees only published + consented
await db.query("insert into public.project_media (project_id, kind, original_path) values ($1,'image','p/x.jpg')", [pNo]);
const anonProjects = await as("anon", () => all("select slug from public.projects order by slug"));
check("RLS: anon sees ONLY the published + consented project", JSON.stringify(anonProjects.map(p => p.slug)) === '["litush-basalt-beit-shemesh"]', JSON.stringify(anonProjects));
const anonMedia = await as("anon", () => all("select project_id from public.project_media"));
check("RLS: anon sees only that project's media (2 of 3 rows)", anonMedia.length === 2 && anonMedia.every(m => m.project_id === pid), anonMedia.length);
check("RLS: anon can't write projects", /permission denied/.test(await as("anon", () => errOf(() => db.query("insert into public.projects (slug) values ('x')"))) || ""));
check("RLS: anon can't read publications", /permission denied/.test(await as("anon", () => errOf(() => db.query("select * from public.project_publications"))) || ""));
check("RLS: weekly_reports is service-only (authenticated denied)", /permission denied/.test(await as("authenticated", () => errOf(() => db.query("select * from public.weekly_reports"))) || ""));

// quota kinds
check("quota: 'quote' still works exactly as before (15 → 14 left)", (await one("select public.consume_daily_quota('quote', 15) as n")).n === 14);
check("quota: new kind 'media_ai' (30 → 29 left)", (await one("select public.consume_daily_quota('media_ai', 30) as n")).n === 29);
await db.query("select public.consume_daily_quota('media_file', 60)");
check("quota: new kind 'media_file' + get_daily_quota_remaining", (await one("select public.get_daily_quota_remaining('media_file', 60) as b")).b === 59);
check("quota: an unknown kind is still refused (22023)", /invalid kind/.test(await errOf(() => db.query("select public.consume_daily_quota('bogus', 5)")) || ""));
check("quota: the table check accepts only the 4 kinds", /telegram_daily_usage_kind_check/.test(await errOf(() => db.query("insert into public.telegram_daily_usage(day, kind, count) values (current_date, 'bogus', 1)")) || ""));
const qg = (await all("select grantee from information_schema.routine_privileges where routine_name='consume_daily_quota' and privilege_type='EXECUTE'")).map(x => x.grantee);
check("quota: EXECUTE still service_role only (not anon/authenticated/PUBLIC)", qg.includes("service_role") && !qg.some(g => ["anon", "authenticated", "PUBLIC"].includes(g)), qg.join(","));

// storage
const b = Object.fromEntries((await all("select id, public, file_size_limit, allowed_mime_types from storage.buckets")).map(x => [x.id, x]));
check("storage: project-originals is PRIVATE, 50 MB, images + video", b["project-originals"] && b["project-originals"].public === false && Number(b["project-originals"].file_size_limit) === 52428800 &&
  b["project-originals"].allowed_mime_types.includes("video/mp4"));
check("storage: project-media is public by URL, 50 MB, jpeg/webp/mp4", b["project-media"] && b["project-media"].public === true && JSON.stringify(b["project-media"].allowed_mime_types) === '["image/jpeg","image/webp","video/mp4"]');
check("storage: content-media now has limits (50 MB, images + video)", b["content-media"] && Number(b["content-media"].file_size_limit) === 52428800 && b["content-media"].allowed_mime_types.length === 5);
const pol = (await all("select policyname from pg_policies where schemaname='storage' order by 1")).map(x => x.policyname);
check("storage: no public LISTING policy for content-media or project-media", !pol.includes("public can read content-media") && !pol.some(p => /project-media|project media/.test(p)), pol.join(" | "));
check("storage: 3 policies for project-originals (authenticated insert/select/delete), others untouched", ["auth uploads project originals", "auth reads project originals", "auth deletes project originals",
  "authenticated can read receipts", "authenticated can upload content-media"].every(p => pol.includes(p)), pol.join(" | "));
await db.exec("insert into storage.objects (bucket_id, name) values ('project-originals','p/a.jpg'), ('content-media','old.jpg')");
check("storage: anon can't list project-originals or content-media", (await as("anon", () => all("select name from storage.objects"))).length === 0);
check("storage: authenticated can list project-originals (the panel's previews)", (await as("authenticated", () => all("select name from storage.objects where bucket_id='project-originals'"))).length === 1);

// realtime (command 4): projects + project_media join the publication; idempotent
await db.exec("create publication supabase_realtime");
await db.exec("alter publication supabase_realtime add table public.quotes");
await db.exec(REALTIME); await db.exec(REALTIME);
const pubTables = (await all("select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1")).map(r => r.tablename);
check("realtime: projects + project_media added, quotes kept, applied twice without error", JSON.stringify(pubTables) === JSON.stringify(["project_media", "projects", "quotes"]), pubTables.join(","));

// parked album photos for the bot (command 5): service_role only, constraints, retention job; idempotent
const PARKED = read("supabase-telegram-parked-media.sql");
await db.exec(PARKED); await db.exec(PARKED);
check("parked media: applied twice, RLS on, anon/authenticated have no access",
  (await one("select relrowsecurity r from pg_class where oid = 'public.telegram_parked_media'::regclass")).r === true &&
  !(await one("select has_table_privilege('anon', 'public.telegram_parked_media', 'select') a")).a &&
  !(await one("select has_table_privilege('authenticated', 'public.telegram_parked_media', 'insert') a")).a);
const parkRow = (gid, uid, extra) => db.query("insert into public.telegram_parked_media (chat_id, media_group_id, message_id, kind, file_id, file_unique_id" + (extra ? ", created_at" : "") +
  ") values (600, $1, 5, 'photo', 'AgACfake', $2" + (extra ? ", now() - interval '25 hours'" : "") + ")", [gid, uid]);
await parkRow("1351234567890", "AQADuniq1");
check("parked media: the same file twice in one album → refused (unique)", /duplicate key/.test(await errOf(() => parkRow("1351234567890", "AQADuniq1"))));
check("parked media: a bad media_group_id / file_unique_id / kind → refused (checks)",
  !!(await errOf(() => parkRow("a b;drop", "AQADuniq2"))) && !!(await errOf(() => parkRow("135", "../x"))) &&
  !!(await errOf(() => db.query("insert into public.telegram_parked_media (chat_id, media_group_id, message_id, kind, file_id, file_unique_id) values (600,'g',1,'audio','f','u')"))));
check("parked media: ONE nightly retention job (applied twice)", (await all("select schedule from cron.job where jobname = 'telegram-parked-media-retention'")).length === 1);
await parkRow("old-album", "AQADold", true);
await runJob("telegram-parked-media-retention");
check("parked media: the job deletes rows older than 24 h, keeps fresh ones", (await all("select media_group_id from public.telegram_parked_media order by 1")).map(r => r.media_group_id).join() === "1351234567890");

// command 7: additive only, applied twice; new tables service_role only; archive mirrors content_queue
const C7 = read("supabase-command7.sql");
check("command 7 file: no DELETE / DROP / UPDATE / INSERT statements outside comments",
  !/^\s*(delete|drop|update|insert|truncate)\b/im.test(C7.split("\n").filter(l => !/^\s*--/.test(l)).join("\n")));
const cqBefore = (await one("select count(*)::int n from public.content_queue")).n;
await db.exec(C7); await db.exec(C7);
const colsOf = async (t) => (await all("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [t])).map(r => r.column_name);
const qCols = await colsOf("quotes"), cqCols = await colsOf("content_queue"), arCols = await colsOf("content_queue_archive");
check("command 7: quotes job_done_at / review_requested_at / review_request_count",
  ["job_done_at", "review_requested_at", "review_request_count"].every(c => qCols.includes(c)));
check("command 7: ig_container_* on content_queue AND content_queue_archive (mirrored)",
  ["ig_container_id", "ig_container_status", "ig_container_created_at", "ig_container_checked_at"].every(c => cqCols.includes(c) && arCols.includes(c)));
check("command 7: project_media.file_deleted_at", (await colsOf("project_media")).includes("file_deleted_at"));
check("command 7: weekly_reports claim columns + status check",
  ["status", "claimed_at", "attempts", "error"].every(c => (async () => 0) && true) &&
  (await colsOf("weekly_reports")).join() === "week_start,sent_at,status,claimed_at,attempts,error" &&
  !!(await errOf(() => db.query("insert into public.weekly_reports (week_start, status) values ('2026-11-01', 'bogus')"))));
await db.query("insert into public.weekly_reports (week_start, status) values ('2026-11-01', 'sending')");
check("command 7: weekly_reports — a second claim for the same week is refused (once per week)",
  /duplicate key/.test(await errOf(() => db.query("insert into public.weekly_reports (week_start, status) values ('2026-11-01', 'sending')"))));
check("command 7: social_comment_seen + scheduler_state: RLS on, no policies, anon/authenticated no access",
  (await all("select relname from pg_class where relname in ('social_comment_seen','scheduler_state') and relrowsecurity")).length === 2 &&
  (await one("select count(*)::int n from pg_policies where tablename in ('social_comment_seen','scheduler_state')")).n === 0 &&
  ["anon", "authenticated"].every(r => true) &&
  !(await one("select has_table_privilege('anon', 'public.social_comment_seen', 'select') a")).a &&
  !(await one("select has_table_privilege('authenticated', 'public.scheduler_state', 'select') a")).a);
check("command 7: social_comment_seen refuses an unknown platform, dedupes by (platform, comment_id)",
  !!(await errOf(() => db.query("insert into public.social_comment_seen (platform, comment_id) values ('tiktok','1')"))) &&
  (await db.query("insert into public.social_comment_seen (platform, comment_id) values ('facebook','1_2') on conflict do nothing"), true) &&
  /duplicate key/.test(await errOf(() => db.query("insert into public.social_comment_seen (platform, comment_id) values ('facebook','1_2')"))));
check("command 7: existing content_queue rows untouched", (await one("select count(*)::int n from public.content_queue")).n === cqBefore);
await db.exec("delete from public.weekly_reports; delete from public.social_comment_seen");

// files: status lines present
check("files say their status (scheduler: SAFE NOW, lead alert: AT MERGE, schema: SAFE NOW)",
  /STATUS: SAFE TO APPLY NOW/.test(SCHED) && /STATUS: APPLY AT MERGE/.test(LEAD) && /STATUS: SAFE TO APPLY NOW/.test(MEDIA) && /SAFE TO APPLY NOW/.test(REALTIME));
check("files have VERIFY + ROLLBACK sections", [SCHED, LEAD, MEDIA, REALTIME, PARKED].every(s => /VERIFY/.test(s) && /ROLLBACK/.test(s)) && /STATUS: SAFE TO APPLY NOW/.test(PARKED));

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exitCode = fail ? 1 : 0;
