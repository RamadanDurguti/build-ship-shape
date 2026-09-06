-- Dwell: state for the MCP server.
--
-- Both tables have RLS on and deliberately no policies. Nothing reaches them
-- except the Edge Function, which holds the service role key. The publishable
-- key that ships in the web client cannot read or write a single row; every
-- read and write goes through an MCP tool call.

create table if not exists public.dwell_job (
  code          text primary key,
  procedure_id  text        not null,
  title         text        not null,
  -- The hours the person is free, as [{start, end}] ISO strings.
  windows       jsonb       not null default '[]'::jsonb,
  conditions    jsonb       not null default '{}'::jsonb,
  -- {stepId: the moment it actually became ready}. The real times, not the
  -- ones the first plan predicted -- which is the whole point of resuming.
  done          jsonb       not null default '{}'::jsonb,
  skipped       jsonb       not null default '[]'::jsonb,
  area_m2       numeric,
  have          jsonb       not null default '{}'::jsonb,
  -- Everything the plan says out loud is a time of day, so the job has to
  -- know which clock it is on. Per job, not per session: the room is in one
  -- place even if you ask about it from another.
  tz            text        not null default 'Europe/Belgrade',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.dwell_session (
  id            text primary key,
  protocol      text        not null,
  client        jsonb       not null default '{}'::jsonb,
  -- Which job this conversation is about. This is what lets someone come
  -- back three days later and say "where was I" without naming anything.
  job_code      text        references public.dwell_job(code) on delete set null,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

create index if not exists dwell_job_updated_idx on public.dwell_job (updated_at desc);
create index if not exists dwell_session_seen_idx on public.dwell_session (last_seen desc);

alter table public.dwell_job     enable row level security;
alter table public.dwell_session enable row level security;
