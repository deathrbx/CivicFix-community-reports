-- CivicFix report storage and row-level security.
-- Run this once in the Supabase SQL Editor for your project.

create extension if not exists pgcrypto;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  title text not null check (char_length(trim(title)) between 5 and 120),
  description text not null check (char_length(trim(description)) between 10 and 2000),
  category text not null check (
    category in ('waste', 'roads', 'streetlights', 'water', 'safety', 'facilities', 'environment', 'other')
  ),
  location text check (location is null or char_length(location) <= 180),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high')),
  status text not null default 'reported'
    check (status in ('reported', 'in_progress', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reports_user_id_idx on public.reports (user_id);
create index if not exists reports_status_idx on public.reports (status);
create index if not exists reports_created_at_idx on public.reports (created_at desc);

create or replace function public.set_report_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists reports_updated_at on public.reports;
create trigger reports_updated_at
before update on public.reports
for each row execute function public.set_report_updated_at();

alter table public.reports enable row level security;

drop policy if exists "Authenticated users can read community reports" on public.reports;
create policy "Authenticated users can read community reports"
on public.reports for select to authenticated
using (auth.uid() is not null);

drop policy if exists "Users can create their own reports" on public.reports;
create policy "Users can create their own reports"
on public.reports for insert to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update their own reports" on public.reports;
create policy "Users can update their own reports"
on public.reports for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete their own reports" on public.reports;
create policy "Users can delete their own reports"
on public.reports for delete to authenticated
using (user_id = auth.uid());

create or replace function public.civicfix_impact()
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select count(distinct user_id)
  from public.reports;
$$;

revoke all on function public.civicfix_impact() from public;
grant execute on function public.civicfix_impact() to authenticated;

grant select, insert, update, delete on public.reports to authenticated;