-- =====================================================================
-- Lab Paper Portal — Supabase schema
-- Run once in Supabase Dashboard → SQL Editor (safe to re-run).
-- All tables are protected by Row Level Security: only users whose
-- email is on the allowlist (role 'member' or 'admin') can read/write.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- People & access control
-- ---------------------------------------------------------------------
create table if not exists public.allowlist (
  email       text primary key check (email = lower(email)),
  role        text not null default 'member' check (role in ('admin','member')),
  added_by    uuid,
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  avatar_url  text,
  role        text not null default 'pending' check (role in ('admin','member','pending')),
  created_at  timestamptz not null default now()
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role in ('admin','member'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'admin');
$$;

-- New sign-up → profile; role taken from allowlist, otherwise 'pending'.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, role)
  values (
    new.id,
    coalesce(lower(new.email), ''),
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             new.raw_user_meta_data->>'user_name'),
    new.raw_user_meta_data->>'avatar_url',
    coalesce((select a.role from public.allowlist a where a.email = lower(new.email)), 'pending')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Allowlist changes propagate to existing profiles.
create or replace function public.sync_allowlist() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles set role = 'pending' where email = old.email;
    return old;
  end if;
  update public.profiles set role = new.role where email = new.email;
  return new;
end $$;

drop trigger if exists allowlist_sync on public.allowlist;
create trigger allowlist_sync
  after insert or update or delete on public.allowlist
  for each row execute function public.sync_allowlist();

-- Users may edit their own name/avatar but never their own role.
create or replace function public.guard_profile_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null           -- SQL editor / triggers run with no JWT
     and not public.is_admin()
     and pg_trigger_depth() = 1 then      -- allow changes cascaded from allowlist trigger
    raise exception 'Only admins can change roles';
  end if;
  if new.email is distinct from old.email and auth.uid() is not null then
    raise exception 'Email cannot be changed here';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------
-- Papers
-- ---------------------------------------------------------------------
create table if not exists public.papers (
  id          uuid primary key default gen_random_uuid(),
  doi         text unique check (doi is null or doi = lower(doi)),
  pmid        text unique,
  arxiv_id    text unique,
  title       text not null,
  authors     text,                     -- "Family, Given; Family, Given"
  journal     text,
  year        int,
  abstract    text,
  url         text,
  pdf_url     text,
  bibtex_key  text,
  entry_type  text not null default 'article',
  tags        text[] not null default '{}',
  added_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  search      tsvector generated always as (
                to_tsvector('english',
                  coalesce(title,'') || ' ' || coalesce(authors,'') || ' ' ||
                  coalesce(journal,'') || ' ' || coalesce(abstract,''))
              ) stored
);
create index if not exists papers_search_idx on public.papers using gin (search);
create index if not exists papers_tags_idx   on public.papers using gin (tags);
create index if not exists papers_created_idx on public.papers (created_at desc);

-- One note per member per paper; visible to the whole lab.
create table if not exists public.paper_notes (
  id             uuid primary key default gen_random_uuid(),
  paper_id       uuid not null references public.papers(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  body           text not null default '',
  rating         smallint check (rating between 1 and 5),
  reading_status text not null default 'to_read' check (reading_status in ('to_read','reading','read')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (paper_id, user_id)
);
create index if not exists paper_notes_paper_idx on public.paper_notes (paper_id);

-- ---------------------------------------------------------------------
-- Projects (evolving ideas) with automatic version history
-- ---------------------------------------------------------------------
create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  status           text not null default 'idea'
                   check (status in ('idea','exploring','pilot','active','paused','completed','archived')),
  summary          text not null default '',
  hypothesis       text not null default '',
  rationale        text not null default '',
  aims             text not null default '',
  open_questions   text not null default '',
  next_steps       text not null default '',
  tags             text[] not null default '{}',
  owner_id         uuid references public.profiles(id) on delete set null default auth.uid(),
  collaborators    uuid[] not null default '{}',
  version          int not null default 1,
  last_change_note text,
  last_edited_by   uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists projects_tags_idx on public.projects using gin (tags);

create table if not exists public.project_versions (
  id          bigserial primary key,
  project_id  uuid not null references public.projects(id) on delete cascade,
  version     int not null,
  snapshot    jsonb not null,
  change_note text,
  edited_by   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (project_id, version)
);

create table if not exists public.project_papers (
  project_id  uuid not null references public.projects(id) on delete cascade,
  paper_id    uuid not null references public.papers(id) on delete cascade,
  relation    text not null default 'background'
              check (relation in ('background','supports','contradicts','method','dataset','inspiration')),
  note        text,
  added_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  primary key (project_id, paper_id)
);
create index if not exists project_papers_paper_idx on public.project_papers (paper_id);

-- Dated log entries (results, discussions, decisions) on a project.
create table if not exists public.project_updates (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null default auth.uid(),
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists project_updates_project_idx on public.project_updates (project_id, created_at desc);

-- Version bookkeeping ---------------------------------------------------
create or replace function public.project_before_update() returns trigger
language plpgsql as $$
begin
  if (new.title, new.status, new.summary, new.hypothesis, new.rationale, new.aims,
      new.open_questions, new.next_steps, new.tags, new.collaborators, new.owner_id)
     is distinct from
     (old.title, old.status, old.summary, old.hypothesis, old.rationale, old.aims,
      old.open_questions, old.next_steps, old.tags, old.collaborators, old.owner_id) then
    new.version    := old.version + 1;
    new.updated_at := now();
    new.last_edited_by := coalesce(auth.uid(), new.last_edited_by);
  else
    new.version := old.version;   -- clients cannot bump version without a content change
  end if;
  return new;
end $$;

create or replace function public.project_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.version <> old.version then
    insert into public.project_versions (project_id, version, snapshot, change_note, edited_by)
    values (new.id, new.version,
            to_jsonb(new) - 'last_change_note' - 'version' - 'created_at' - 'updated_at' - 'last_edited_by',
            coalesce(new.last_change_note, case when tg_op = 'INSERT' then 'Created' end),
            coalesce(auth.uid(), new.last_edited_by));
  end if;
  return new;
end $$;

drop trigger if exists projects_before_update on public.projects;
create trigger projects_before_update before update on public.projects
  for each row execute function public.project_before_update();

drop trigger if exists projects_snapshot on public.projects;
create trigger projects_snapshot after insert or update on public.projects
  for each row execute function public.project_snapshot();

-- updated_at for papers / notes -------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists papers_touch on public.papers;
create trigger papers_touch before update on public.papers
  for each row execute function public.touch_updated_at();
drop trigger if exists notes_touch on public.paper_notes;
create trigger notes_touch before update on public.paper_notes
  for each row execute function public.touch_updated_at();

-- Tag usage counts (papers + projects)
create or replace view public.tag_counts with (security_invoker = true) as
  select tag, sum(n_papers)::int as n_papers, sum(n_projects)::int as n_projects
  from (
    select unnest(tags) as tag, 1 as n_papers, 0 as n_projects from public.papers
    union all
    select unnest(tags), 0, 1 from public.projects
  ) t
  group by tag;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.allowlist        enable row level security;
alter table public.profiles         enable row level security;
alter table public.papers           enable row level security;
alter table public.paper_notes      enable row level security;
alter table public.projects         enable row level security;
alter table public.project_versions enable row level security;
alter table public.project_papers   enable row level security;
alter table public.project_updates  enable row level security;

-- Nothing is readable by anonymous visitors.
revoke all on all tables in schema public from anon;

do $$
declare p record;
begin
  -- drop this portal's existing policies so this file can be re-run (other tables untouched)
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('allowlist','profiles','papers','paper_notes','projects',
                               'project_versions','project_papers','project_updates') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- allowlist: admins only
create policy allowlist_admin on public.allowlist for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- profiles
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_member() or id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- papers
create policy papers_read   on public.papers for select to authenticated using (public.is_member());
create policy papers_insert on public.papers for insert to authenticated with check (public.is_member());
create policy papers_update on public.papers for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy papers_delete on public.papers for delete to authenticated
  using (public.is_admin() or (public.is_member() and added_by = auth.uid()));

-- notes: all members read; each member writes only their own
create policy notes_read  on public.paper_notes for select to authenticated using (public.is_member());
create policy notes_write on public.paper_notes for all to authenticated
  using (public.is_member() and user_id = auth.uid())
  with check (public.is_member() and user_id = auth.uid());

-- projects: whole lab can read & edit (history is kept); delete by owner/admin
create policy projects_read   on public.projects for select to authenticated using (public.is_member());
create policy projects_insert on public.projects for insert to authenticated with check (public.is_member());
create policy projects_update on public.projects for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy projects_delete on public.projects for delete to authenticated
  using (public.is_admin() or (public.is_member() and owner_id = auth.uid()));

create policy versions_read on public.project_versions for select to authenticated using (public.is_member());

create policy pp_read   on public.project_papers for select to authenticated using (public.is_member());
create policy pp_write  on public.project_papers for all to authenticated
  using (public.is_member()) with check (public.is_member());

create policy updates_read   on public.project_updates for select to authenticated using (public.is_member());
create policy updates_insert on public.project_updates for insert to authenticated
  with check (public.is_member() and author_id = auth.uid());
create policy updates_modify on public.project_updates for update to authenticated
  using (public.is_member() and author_id = auth.uid()) with check (author_id = auth.uid());
create policy updates_delete on public.project_updates for delete to authenticated
  using (public.is_admin() or (public.is_member() and author_id = auth.uid()));

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke insert, update, delete on public.project_versions from authenticated;

-- ---------------------------------------------------------------------
-- First admin — EDIT this email, then run. Others can be added in the
-- portal's Admin page afterwards.
-- ---------------------------------------------------------------------
-- insert into public.allowlist (email, role) values ('pi@example.ac.uk', 'admin')
--   on conflict (email) do update set role = 'admin';
