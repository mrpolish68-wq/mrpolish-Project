-- =============================================================
--  Mr. Polish — Phase 1: Smart Receipt & Business Expense Scanner
--  Run this once in the Supabase SQL Editor, AFTER supabase-business-expenses.sql.
--
--  What this does:
--  1. Migrates business_expense_category from the old 4 vendor-name values
--     to a new 6-value expense-type taxonomy (existing rows are remapped,
--     not dropped).
--  2. Adds receipt/OCR-related columns to business_expenses.
--  3. Creates a private "receipts" Storage bucket + RLS policies
--     (authenticated-only, same posture as the table itself — this is
--     private financial data, no anon access anywhere).
-- =============================================================

-- -------------------------------------------------------------
--  1. Category taxonomy migration
--     Postgres enums can't have values renamed/removed in place, so this
--     creates a new type, moves the column onto it with an explicit
--     old->new mapping, then drops the old type and renames the new one
--     into its place. Existing rows are remapped, not lost:
--       'סעדון יבוא שיווק והדברה בע"מ' -> 'חומרי עבודה/פוליש' (materials/polish supplier)
--       'אשלי כלי יהלומים בע"מ'        -> 'ציוד ותחזוקה'      (diamond tools = polishing equipment)
--       'דלק'                          -> 'דלק/רכב'
--       'שונות'                        -> 'שונות'
-- -------------------------------------------------------------

-- Guarded top-to-bottom: if 'דלק/רכב' is already a valid label on the live
-- business_expense_category type, the migration already ran — skip entirely.
-- Without this guard, re-running the script would recreate a *_new type, then
-- the old->new CASE mapping (which only matches the OLD 4 vendor-name values)
-- would silently fall through to 'שונות' for every already-migrated row.
do $$
begin
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'business_expense_category' and e.enumlabel = 'דלק/רכב'
  ) then
    raise notice 'business_expense_category already migrated to the 6-value taxonomy — skipping.';
    return;
  end if;

  if not exists (select 1 from pg_type where typname = 'business_expense_category_new') then
    create type public.business_expense_category_new as enum (
      'חומרי עבודה/פוליש',
      'דלק/רכב',
      'שיווק/פרסום',
      'ציוד ותחזוקה',
      'הוצאות משרד',
      'שונות'
    );
  end if;

  alter table public.business_expenses
    alter column category type public.business_expense_category_new
    using (
      case category::text
        when 'סעדון יבוא שיווק והדברה בע"מ' then 'חומרי עבודה/פוליש'
        when 'אשלי כלי יהלומים בע"מ'        then 'ציוד ותחזוקה'
        when 'דלק'                          then 'דלק/רכב'
        when 'שונות'                        then 'שונות'
        else 'שונות'
      end
    )::public.business_expense_category_new;

  drop type if exists public.business_expense_category;
  alter type public.business_expense_category_new rename to business_expense_category;
end $$;

-- -------------------------------------------------------------
--  2. New columns for OCR-extracted / receipt metadata
--     All nullable — every existing manual-entry row simply has these
--     null, and the manual-entry modal keeps working exactly as before.
-- -------------------------------------------------------------

alter table public.business_expenses
  add column if not exists vendor_name          text,
  add column if not exists invoice_number        text,
  add column if not exists vat_amount            numeric(10,2),
  add column if not exists amount_before_vat      numeric(10,2),
  add column if not exists receipt_url            text,   -- Storage OBJECT PATH in the "receipts" bucket, not a public URL
  add column if not exists source                 text not null default 'manual',
  add column if not exists ocr_confidence_notes    text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_expenses_source_check'
  ) then
    alter table public.business_expenses
      add constraint business_expenses_source_check check (source in ('manual', 'ocr'));
  end if;
end $$;

-- -------------------------------------------------------------
--  3. Storage bucket + policies
--     Private bucket (public = false) — receipts are private financial
--     documents, same reasoning as business_expenses' own RLS comment.
--     SELECT policy is required even though the bucket is private:
--     generating a signed URL client-side (sb.storage...createSignedUrl)
--     still checks the caller's SELECT permission on storage.objects.
-- -------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "authenticated can upload receipts" on storage.objects;
create policy "authenticated can upload receipts"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'receipts');

drop policy if exists "authenticated can read receipts" on storage.objects;
create policy "authenticated can read receipts"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'receipts');
