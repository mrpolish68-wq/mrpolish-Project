-- =============================================================
--  Mr. Polish — "business_expenses" table for the dashboard's
--  "הוצאות עסק" (Business Expenses) tab + accountant Excel export.
--  Run this once in the Supabase SQL Editor.
--
--  Flow: Ori logs expenses from the admin dashboard (authenticated
--  session only). This is private financial data, not public like
--  reviews, so no anon policy is created — the public site has
--  zero access to this table.
-- =============================================================

create extension if not exists "pgcrypto";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'business_expense_category') then
    create type public.business_expense_category as enum (
      'סעדון יבוא שיווק והדברה בע"מ',
      'אשלי כלי יהלומים בע"מ',
      'דלק',
      'שונות'
    );
  end if;
end $$;

create table if not exists public.business_expenses (
  id          uuid primary key default gen_random_uuid(),
  date        date not null default current_date,
  category    public.business_expense_category not null,
  amount      numeric(10,2) not null check (amount > 0),
  description text,
  created_at  timestamptz not null default now()
);

-- Fast lookup for the newest-first list + date-range filters the dashboard uses.
create index if not exists business_expenses_date_idx
  on public.business_expenses (date desc);

-- -------------------------------------------------------------
--  Row-Level Security
--  Only the authenticated admin (Ori, via login.html) may read
--  or write. No "anon" policy exists for this table.
-- -------------------------------------------------------------
alter table public.business_expenses enable row level security;

drop policy if exists "authenticated can manage business expenses" on public.business_expenses;
create policy "authenticated can manage business expenses"
  on public.business_expenses
  for all
  to authenticated
  using (true)
  with check (true);
