-- Family Quiz: database schema for Supabase.
--
-- Applied to the Family Quiz project (fpgrghfzlpfxoshlamjo) on 2026-10-24 through the Supabase connector.
-- To rebuild elsewhere: SQL Editor → New query → paste this whole file → Run.
-- It is safe to run again: it only creates what is missing and replaces functions and policies.
--
-- Tables
--   questions      every question: the built-in bank, the family's own, and later picture/music ones
--   profiles       a player: either a signed-in person, or a child profile a parent manages
--   games          one quiz session, joined with a share code
--   game_players   who is playing in a game, their difficulty, score and streak
--   game_questions the questions dealt in a game, in order, and whose turn each one is
--   answers        each player's answer to a dealt question, and the points it earned
--   game_events    streaks, bonus rounds, challenges, steals and mini-game results
--   seen_questions which questions a profile has already had, so they don't repeat
--
-- Watchers follow a game through watch_game(watch_key) without signing in.
--   profile_devices  kids' own devices linked to their child profile
--   device_requests  a device asking to play as a child, waiting for the parent or host

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Questions
-- ---------------------------------------------------------------------------

create table if not exists public.questions (
  id          bigint generated always as identity primary key,
  source      text not null default 'family' check (source in ('bank', 'family')),
  topic       text not null default 'General knowledge',
  age_band    text not null default '',          -- '6-7' … '16-17', 'adult', '10', '16+', or '' for everyone
  age_min     smallint not null default 0,
  age_max     smallint not null default 999,
  grade       smallint not null default 3 check (grade between 1 and 5),
  question    text not null check (length(trim(question)) > 0),
  answer      text not null check (length(trim(answer)) > 0),
  wrong       text[] not null default '{}',      -- up to three wrong choices
  kind        text not null default 'text' check (kind in ('text', 'picture', 'music')),
  media_url   text,                              -- picture or 30-second preview
  media       jsonb not null default '{}',       -- e.g. {"reveal":"zoom"} or {"provider":"deezer","track":123,"mode":"intro"}
  active      boolean not null default true,
  created_by  uuid references auth.users on delete set null,
  created_at  timestamptz not null default now()
);

-- The same question can't appear twice for the same age band and source; imports update in place.
create unique index if not exists questions_unique
  on public.questions (source, age_band, lower(question));
create index if not exists questions_pick on public.questions (age_min, age_max, grade) where active;
create index if not exists questions_topic on public.questions (topic) where active;

-- Turns an age setting into a range of years, the same way the app does.
create or replace function public.age_range(band text, out age_min smallint, out age_max smallint)
language plpgsql immutable set search_path = '' as $$
declare
  v text := lower(trim(coalesce(band, '')));
  m text[];
begin
  age_min := 0; age_max := 999;
  if v in ('', 'all', 'any') then return; end if;
  if v like 'adult%' then age_min := 18; return; end if;
  m := regexp_match(v, '^(\d+)\s*[-–]\s*(\d+)$');
  if m is not null then age_min := m[1]::smallint; age_max := m[2]::smallint; return; end if;
  m := regexp_match(v, '^(\d+)\s*\+$');
  if m is not null then age_min := m[1]::smallint; return; end if;
  m := regexp_match(v, '^(\d+)$');
  if m is not null then age_min := m[1]::smallint; age_max := m[1]::smallint; end if;
end $$;

create or replace function public.questions_set_age() returns trigger
language plpgsql set search_path = '' as $$
begin
  select r.age_min, r.age_max into new.age_min, new.age_max from public.age_range(new.age_band) r;
  return new;
end $$;

create or replace trigger questions_set_age before insert or update of age_band on public.questions
  for each row execute function public.questions_set_age();

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

-- A profile with user_id is a person who signs in. A profile without one is a child
-- the owner manages (so kids can play without their own email). The owner is whoever
-- created it; for a signed-in person, owner_id = user_id.
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users on delete cascade,
  owner_id      uuid not null default auth.uid() references auth.users on delete cascade,
  display_name  text not null check (length(trim(display_name)) between 1 and 30),
  age           text not null default 'adult',   -- '6' … '17' or 'adult', as in the app
  grade_pref    smallint check (grade_pref between 1 and 5),
  colour        text,
  avatar        text,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_owner on public.profiles (owner_id);

-- Every new sign-up (Google or email) gets a profile named from their account.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, owner_id, display_name)
  values (new.id, new.id, left(coalesce(new.raw_user_meta_data->>'full_name',
                                         new.raw_user_meta_data->>'name',
                                         split_part(new.email, '@', 1), 'Player'), 30))
  on conflict (user_id) do nothing;
  return new;
end $$;

create or replace trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------------

create table if not exists public.games (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,               -- share code, e.g. 'KQ7P'
  host_id          uuid not null default auth.uid() references auth.users on delete cascade,
  status           text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  -- topic, difficulty, seconds, per_player, streak_length, steals, challenges … as the host chose them
  settings         jsonb not null default '{}',
  current_seq      int not null default 0,              -- game_questions.seq on screen now
  active_player_id uuid,                                -- game_players.id who has control
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);

create table if not exists public.game_players (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games on delete cascade,
  profile_id  uuid not null references public.profiles on delete cascade,
  seat        smallint not null default 0,              -- turn order
  grade_pref  smallint check (grade_pref between 1 and 5), -- blank = game level
  score       int not null default 0,
  streak      int not null default 0,
  best_streak int not null default 0,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  unique (game_id, profile_id)
);
create index if not exists game_players_profile on public.game_players (profile_id);

alter table public.games drop constraint if exists games_active_player_fk;
alter table public.games add constraint games_active_player_fk
  foreign key (active_player_id) references public.game_players on delete set null;

create table if not exists public.game_questions (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games on delete cascade,
  seq          int not null,
  round_no     int not null default 1,
  kind         text not null default 'normal'
               check (kind in ('normal', 'bonus', 'picture', 'music', 'challenge')),
  question_id  bigint not null references public.questions on delete cascade,
  player_id    uuid references public.game_players on delete cascade,  -- whose question; null = everyone
  opponent_id  uuid references public.game_players on delete cascade,  -- 1v1 challenge opponent
  asked_at     timestamptz,
  revealed_at  timestamptz,
  unique (game_id, seq)
);

create table if not exists public.answers (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references public.games on delete cascade,
  game_question_id  uuid not null references public.game_questions on delete cascade,
  player_id         uuid not null references public.game_players on delete cascade,
  response          text,
  used_choices      boolean not null default false,
  is_correct        boolean not null,
  points            smallint not null default 0,       -- 2 straight, 1 with choices, or steal/bonus points
  stolen_from       uuid references public.game_players on delete set null,
  answered_at       timestamptz not null default now(),
  unique (game_question_id, player_id)
);
create index if not exists answers_game on public.answers (game_id);

create table if not exists public.game_events (
  id          bigint generated always as identity primary key,
  game_id     uuid not null references public.games on delete cascade,
  player_id   uuid references public.game_players on delete cascade,
  type        text not null,     -- 'streak', 'bonus_round', 'challenge', 'steal', 'minigame', 'join', 'leave' …
  points      smallint not null default 0,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists game_events_game on public.game_events (game_id, id);

create table if not exists public.seen_questions (
  profile_id   uuid not null references public.profiles on delete cascade,
  question_id  bigint not null references public.questions on delete cascade,
  seen_at      timestamptz not null default now(),
  primary key (profile_id, question_id)
);

-- Keep each player's score and streak in step with their answers and event points.
-- Streaks: every 3 correct answers in a row (3, 6, 9 …) the player earns a bonus mini-game, picked at random.
-- settings.streak_every can change the 3.
create or replace function public.apply_answer() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  new_streak int;
  every int;
begin
  update public.game_players gp set
    score       = gp.score + new.points,
    streak      = case when new.is_correct then gp.streak + 1 else 0 end,
    best_streak = greatest(gp.best_streak, case when new.is_correct then gp.streak + 1 else 0 end)
  where gp.id = new.player_id
  returning streak into new_streak;
  if new.stolen_from is not null and new.points > 0 then
    update public.game_players set score = greatest(0, score - new.points) where id = new.stolen_from;
  end if;
  select greatest(2, coalesce((settings->>'streak_every')::int, 3)) into every
  from public.games where id = new.game_id;
  if new.is_correct and new_streak > 0 and new_streak % every = 0 then
    insert into public.game_events (game_id, player_id, type, payload)
    values (new.game_id, new.player_id, 'streak', jsonb_build_object(
      'streak', new_streak, 'game_question_id', new.game_question_id,
      'game', (array['penalties', 'hoops', 'moles', 'wheel'])[1 + floor(random() * 4)::int]));
  end if;
  return new;
end $$;

create or replace trigger answers_apply after insert on public.answers
  for each row execute function public.apply_answer();

create or replace function public.apply_event_points() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.player_id is not null and new.points <> 0 then
    update public.game_players set score = score + new.points where id = new.player_id;
  end if;
  return new;
end $$;

create or replace trigger game_events_apply after insert on public.game_events
  for each row execute function public.apply_event_points();

-- ---------------------------------------------------------------------------
-- Helpers for the security rules
-- ---------------------------------------------------------------------------

-- Profiles the signed-in person may act as: their own and the children they manage.
create or replace function public.my_profile_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where owner_id = auth.uid() or user_id = auth.uid()
$$;

create or replace function public.is_game_host(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.games where id = g and host_id = auth.uid())
$$;

create or replace function public.is_game_member(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_game_host(g) or exists (
    select 1 from public.game_players
    where game_id = g and profile_id in (select public.my_profile_ids()))
$$;

-- ---------------------------------------------------------------------------
-- Game actions (called from the app with supabase.rpc)
-- ---------------------------------------------------------------------------

-- Host creates a game and gets back its share code.
create or replace function public.create_game(p_settings jsonb default '{}')
returns public.games
language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.games;
  letters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O or 1/I
  c text;
begin
  if auth.uid() is null then raise exception 'Sign in to host a game'; end if;
  loop
    c := '';
    for i in 1..4 loop
      c := c || substr(letters, 1 + floor(random() * length(letters))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = c and status <> 'finished');
  end loop;
  insert into public.games (code, host_id, settings) values (c, auth.uid(), coalesce(p_settings, '{}'))
  returning * into g;
  return g;
end $$;

-- A player (or a parent for their child) joins a game by its share code.
create or replace function public.join_game(p_code text, p_profile_id uuid)
returns public.game_players
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  p public.game_players;
begin
  if p_profile_id is null or not exists (select 1 from public.my_profile_ids() m where m = p_profile_id) then
    raise exception 'That profile is not yours';
  end if;
  select * into g from public.games
  where code = upper(trim(p_code)) and status <> 'finished'
  order by created_at desc limit 1;
  if g.id is null then raise exception 'No game with code %', upper(trim(p_code)); end if;
  insert into public.game_players (game_id, profile_id, seat)
  values (g.id, p_profile_id, (select count(*) from public.game_players where game_id = g.id))
  on conflict (game_id, profile_id) do update set left_at = null
  returning * into p;
  insert into public.game_events (game_id, player_id, type) values (g.id, p.id, 'join');
  return p;
end $$;

-- Records an answer. The host (quiz master) marks spoken answers for anyone. A player can answer
-- their own question (or one for everyone) by sending the choice they picked, and the database
-- checks it, so nobody can mark themselves right.
create or replace function public.submit_answer(
  p_game_question_id uuid, p_player_id uuid, p_is_correct boolean,
  p_used_choices boolean default false, p_response text default null, p_steal_from uuid default null)
returns public.answers
language plpgsql security definer set search_path = public as $$
declare
  gq public.game_questions;
  a public.answers;
  pts smallint;
  correct boolean := p_is_correct;
begin
  select * into gq from public.game_questions where id = p_game_question_id;
  if gq.id is null then raise exception 'Unknown question'; end if;
  if not exists (select 1 from public.game_players where id = p_player_id and game_id = gq.game_id) then
    raise exception 'That player is not in this game';
  end if;
  if p_steal_from is not null and (p_steal_from = p_player_id
      or p_steal_from is distinct from coalesce(gq.opponent_id, gq.player_id)
         and p_steal_from is distinct from gq.player_id) then
    raise exception 'Can only steal from the player whose question it is';
  end if;
  if not public.is_game_host(gq.game_id) then
    if not exists (select 1 from public.game_players
                   where id = p_player_id and profile_id in (select public.my_profile_ids())) then
      raise exception 'Not allowed to answer for that player';
    end if;
    if gq.player_id is not null and p_player_id not in (gq.player_id, coalesce(gq.opponent_id, gq.player_id)) then
      raise exception 'It is not your question';
    end if;
    if p_response is null then raise exception 'Pick an answer'; end if;
    select lower(trim(p_response)) = lower(trim(q.answer)) into correct
    from public.questions q where q.id = gq.question_id;
  end if;
  pts := case when not correct then 0
              when p_steal_from is not null then 2
              when p_used_choices then 1 else 2 end;
  insert into public.answers (game_id, game_question_id, player_id, response, used_choices,
                              is_correct, points, stolen_from)
  values (gq.game_id, gq.id, p_player_id, p_response, p_used_choices, correct, pts, p_steal_from)
  returning * into a;
  insert into public.seen_questions (profile_id, question_id)
  select profile_id, gq.question_id from public.game_players where id = p_player_id
  on conflict do nothing;
  return a;
end $$;

-- Only signed-in people can call the game actions; trigger functions aren't callable at all.
revoke execute on function public.create_game(jsonb), public.join_game(text, uuid),
  public.submit_answer(uuid, uuid, boolean, boolean, text, uuid) from public, anon;
grant execute on function public.create_game(jsonb), public.join_game(text, uuid),
  public.submit_answer(uuid, uuid, boolean, boolean, text, uuid) to authenticated;
revoke execute on function public.handle_new_user(), public.apply_answer(),
  public.apply_event_points() from public, anon, authenticated;
revoke execute on function public.my_profile_ids(), public.is_game_host(uuid),
  public.is_game_member(uuid) from public, anon;
grant execute on function public.my_profile_ids(), public.is_game_host(uuid),
  public.is_game_member(uuid) to authenticated;

-- Watchers: anyone with a game's watch link can follow it live in a browser, without signing in.
-- The watch key is separate from the join code, so a watch link can't be used to join as a player.
alter table public.games add column if not exists watch_key text not null
  default replace(replace(encode(extensions.gen_random_bytes(9), 'base64'), '/', '_'), '+', '-');
create unique index if not exists games_watch_key on public.games (watch_key);

-- Everything a watcher's screen needs, in one call. The answer stays hidden until the host reveals it.
-- The host can turn watching off with settings.watchers = false.
create or replace function public.watch_game(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'code', g.code,
    'status', g.status,
    'topic', g.settings->'topic',
    'current_seq', g.current_seq,
    'active_player_id', g.active_player_id,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', gp.id, 'name', p.display_name, 'colour', p.colour,
                                          'avatar', p.avatar, 'score', gp.score, 'streak', gp.streak,
                                          'seat', gp.seat) order by gp.seat)
      from public.game_players gp join public.profiles p on p.id = gp.profile_id
      where gp.game_id = g.id and gp.left_at is null), '[]'),
    'question', (
      select jsonb_build_object('seq', gq.seq, 'round', gq.round_no, 'kind', gq.kind,
                                'player_id', gq.player_id, 'opponent_id', gq.opponent_id,
                                'topic', q.topic, 'text', coalesce(q.media->>'prompt', q.question), 'media_url', q.media_url,
                                'media', q.media, 'asked_at', gq.asked_at,
                                'revealed', gq.revealed_at is not null
                                  or exists (select 1 from public.answers a where a.game_question_id = gq.id),
                                'answer', case when gq.revealed_at is not null
                                  or exists (select 1 from public.answers a where a.game_question_id = gq.id) then q.answer end)
      from public.game_questions gq join public.questions q on q.id = gq.question_id
      where gq.game_id = g.id and gq.seq = g.current_seq),
    'events', coalesce((
      select jsonb_agg(e order by e.id) from (
        select id, player_id, type, points, payload, created_at from public.game_events
        where game_id = g.id and type <> 'join' order by id desc limit 10) e), '[]'),
    'bonus', public.current_bonus(g.id),
    'challenge', public.current_challenge(g.id))
  from public.games g
  where g.watch_key = p_key and coalesce((g.settings->>'watchers')::boolean, true)
$$;

grant execute on function public.watch_game(text) to anon, authenticated;

-- Kids on their own devices: the device signs in anonymously, the child taps their name from the
-- host's family list, and the parent (or host) approves once. The device then acts as that child
-- in every game until the parent removes it.
create table if not exists public.profile_devices (
  profile_id  uuid not null references public.profiles on delete cascade,
  user_id     uuid not null references auth.users on delete cascade,
  approved_by uuid references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  primary key (profile_id, user_id)
);
create index if not exists profile_devices_user on public.profile_devices (user_id);

create table if not exists public.device_requests (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games on delete cascade,
  profile_id  uuid not null references public.profiles on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create unique index if not exists device_requests_pending
  on public.device_requests (game_id, profile_id, user_id) where status = 'pending';

alter table public.profile_devices enable row level security;
alter table public.device_requests enable row level security;

-- A linked device counts as one of the child's own profiles.
create or replace function public.my_profile_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where owner_id = auth.uid() or user_id = auth.uid()
  union
  select profile_id from public.profile_devices where user_id = auth.uid()
$$;

-- The child profiles a device can pick from: those managed by the host or anyone already in the game.
create or replace function public.family_profiles(p_code text)
returns table (id uuid, display_name text, age text, colour text, avatar text)
language sql stable security definer set search_path = public as $$
  select distinct p.id, p.display_name, p.age, p.colour, p.avatar
  from public.games g
  join public.profiles p on p.user_id is null
   and (p.owner_id = g.host_id or p.owner_id in (
        select o.owner_id from public.game_players gp join public.profiles o on o.id = gp.profile_id
        where gp.game_id = g.id))
  where g.code = upper(trim(p_code)) and g.status <> 'finished' and auth.uid() is not null
$$;

-- A device asks to play as a child. Returns the request, which the parent or host then approves.
create or replace function public.request_device(p_code text, p_profile_id uuid)
returns public.device_requests
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  r public.device_requests;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from public.games
  where code = upper(trim(p_code)) and status <> 'finished' order by created_at desc limit 1;
  if g.id is null then raise exception 'No game with code %', upper(trim(p_code)); end if;
  if not exists (select 1 from public.family_profiles(p_code) f where f.id = p_profile_id) then
    raise exception 'That name is not in this game''s family';
  end if;
  insert into public.device_requests (game_id, profile_id, user_id) values (g.id, p_profile_id, auth.uid())
  on conflict (game_id, profile_id, user_id) where status = 'pending' do update set created_at = now()
  returning * into r;
  return r;
end $$;

-- The child's parent or the host says yes or no. Yes links the device and puts the child in the game.
create or replace function public.decide_device(p_request_id uuid, p_approve boolean)
returns public.device_requests
language plpgsql security definer set search_path = public as $$
declare
  r public.device_requests;
begin
  select * into r from public.device_requests where id = p_request_id and status = 'pending';
  if r.id is null then raise exception 'No pending request'; end if;
  if not (public.is_game_host(r.game_id)
          or exists (select 1 from public.profiles where id = r.profile_id and owner_id = auth.uid())) then
    raise exception 'Only the parent or host can approve';
  end if;
  update public.device_requests set status = case when p_approve then 'approved' else 'declined' end,
    decided_at = now() where id = r.id returning * into r;
  if p_approve then
    insert into public.profile_devices (profile_id, user_id, approved_by)
    values (r.profile_id, r.user_id, auth.uid()) on conflict do nothing;
    insert into public.game_players (game_id, profile_id, seat)
    values (r.game_id, r.profile_id, (select count(*) from public.game_players where game_id = r.game_id))
    on conflict (game_id, profile_id) do update set left_at = null;
  end if;
  return r;
end $$;

revoke execute on function public.family_profiles(text), public.request_device(text, uuid),
  public.decide_device(uuid, boolean) from public, anon;
grant execute on function public.family_profiles(text), public.request_device(text, uuid),
  public.decide_device(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Security rules (row level security)
-- ---------------------------------------------------------------------------

alter table public.questions      enable row level security;
alter table public.profiles       enable row level security;
alter table public.games          enable row level security;
alter table public.game_players   enable row level security;
alter table public.game_questions enable row level security;
alter table public.answers        enable row level security;
alter table public.game_events    enable row level security;
alter table public.seen_questions enable row level security;

-- Questions: anyone can read (the pass-the-phone game works without signing in).
-- Signed-in people can add family questions and edit the ones they added.
drop policy if exists "read questions" on public.questions;
create policy "read questions" on public.questions for select using (active or created_by = auth.uid());
drop policy if exists "add family questions" on public.questions;
create policy "add family questions" on public.questions for insert to authenticated
  with check (source = 'family' and created_by = auth.uid());
drop policy if exists "edit own questions" on public.questions;
create policy "edit own questions" on public.questions for update to authenticated
  using (created_by = auth.uid()) with check (source = 'family' and created_by = auth.uid());
drop policy if exists "delete own questions" on public.questions;
create policy "delete own questions" on public.questions for delete to authenticated
  using (created_by = auth.uid());

-- Profiles: you see your own, your children's, and everyone in a game with you.
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated using (
  owner_id = auth.uid() or user_id = auth.uid()
  or exists (select 1 from public.game_players gp
             where gp.profile_id = profiles.id and public.is_game_member(gp.game_id)));
drop policy if exists "add child profiles" on public.profiles;
create policy "add child profiles" on public.profiles for insert to authenticated
  with check (owner_id = auth.uid() and (user_id is null or user_id = auth.uid()));
drop policy if exists "edit my profiles" on public.profiles;
create policy "edit my profiles" on public.profiles for update to authenticated
  using (owner_id = auth.uid() or user_id = auth.uid())
  with check (owner_id = auth.uid() or user_id = auth.uid());
drop policy if exists "delete child profiles" on public.profiles;
create policy "delete child profiles" on public.profiles for delete to authenticated
  using (owner_id = auth.uid() and user_id is null);

-- Games: members can see them; only the host changes them. Joining goes through join_game().
drop policy if exists "read games" on public.games;
create policy "read games" on public.games for select to authenticated using (public.is_game_member(id));
drop policy if exists "host edits game" on public.games;
create policy "host edits game" on public.games for update to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());
drop policy if exists "host deletes game" on public.games;
create policy "host deletes game" on public.games for delete to authenticated using (host_id = auth.uid());

drop policy if exists "read players" on public.game_players;
create policy "read players" on public.game_players for select to authenticated using (public.is_game_member(game_id));
drop policy if exists "host or self edits player" on public.game_players;
create policy "host or self edits player" on public.game_players for update to authenticated
  using (public.is_game_host(game_id) or profile_id in (select public.my_profile_ids()))
  with check (public.is_game_host(game_id) or profile_id in (select public.my_profile_ids()));
drop policy if exists "host removes player" on public.game_players;
create policy "host removes player" on public.game_players for delete to authenticated
  using (public.is_game_host(game_id));

drop policy if exists "read dealt questions" on public.game_questions;
create policy "read dealt questions" on public.game_questions for select to authenticated using (public.is_game_member(game_id));
drop policy if exists "host deals questions" on public.game_questions;
create policy "host deals questions" on public.game_questions for all to authenticated
  using (public.is_game_host(game_id)) with check (public.is_game_host(game_id));

-- Answers are written only through submit_answer(), so scores can't be faked.
drop policy if exists "read answers" on public.answers;
create policy "read answers" on public.answers for select to authenticated using (public.is_game_member(game_id));

drop policy if exists "read events" on public.game_events;
create policy "read events" on public.game_events for select to authenticated using (public.is_game_member(game_id));
drop policy if exists "members add events" on public.game_events;
create policy "members add events" on public.game_events for insert to authenticated with check (
  public.is_game_host(game_id) or (points = 0 and public.is_game_member(game_id)));

drop policy if exists "my seen questions" on public.seen_questions;
create policy "my seen questions" on public.seen_questions for all to authenticated
  using (profile_id in (select public.my_profile_ids()))
  with check (profile_id in (select public.my_profile_ids()));

drop policy if exists "read device requests" on public.device_requests;
create policy "read device requests" on public.device_requests for select to authenticated using (
  user_id = auth.uid() or public.is_game_host(game_id)
  or exists (select 1 from public.profiles p where p.id = profile_id and p.owner_id = auth.uid()));

drop policy if exists "parents see linked devices" on public.profile_devices;
create policy "parents see linked devices" on public.profile_devices for select to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = profile_id and p.owner_id = auth.uid()));
drop policy if exists "parents remove devices" on public.profile_devices;
create policy "parents remove devices" on public.profile_devices for delete to authenticated using (
  exists (select 1 from public.profiles p where p.id = profile_id and p.owner_id = auth.uid()));

-- Anonymous sign-ins (kids' devices) can play, but can't host, add questions or make profiles.
create or replace function public.is_full_account() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
$$;

alter policy "add family questions" on public.questions
  with check (source = 'family' and created_by = auth.uid() and public.is_full_account());
alter policy "add child profiles" on public.profiles
  with check (owner_id = auth.uid() and (user_id is null or user_id = auth.uid()) and public.is_full_account());

create or replace function public.create_game(p_settings jsonb default '{}')
returns public.games
language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.games;
  letters constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- no 0/O or 1/I
  c text;
begin
  if not public.is_full_account() then raise exception 'Sign in to host a game'; end if;
  loop
    c := '';
    for i in 1..4 loop
      c := c || substr(letters, 1 + floor(random() * length(letters))::int, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = c and status <> 'finished');
  end loop;
  insert into public.games (code, host_id, settings) values (c, auth.uid(), coalesce(p_settings, '{}'))
  returning * into g;
  return g;
end $$;

-- Anonymous sign-ups don't get a profile of their own; they play as the child they're linked to.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.is_anonymous, false) then return new; end if;
  insert into public.profiles (user_id, owner_id, display_name)
  values (new.id, new.id, left(coalesce(new.raw_user_meta_data->>'full_name',
                                         new.raw_user_meta_data->>'name',
                                         split_part(new.email, '@', 1), 'Player'), 30))
  on conflict (user_id) do nothing;
  return new;
end $$;

-- Multiplayer game flow. The host's phone drives the game through these functions, and every
-- phone in the game reads game_state() whenever something changes.

-- A player's own difficulty as a list of grades; null = the game's difficulty.
alter table public.game_players add column if not exists grades smallint[];

-- Years for an age setting ('6'..'17' or 'adult').
create or replace function public.age_years(age text) returns smallint
language sql immutable set search_path = '' as $$
  select case when lower(coalesce(age, '')) like 'adult%' or coalesce(age, '') !~ '^\d+$' then 18
              else age::smallint end
$$;

-- Deals questions for everyone and starts the game. Each player gets questions for their own age
-- and difficulty they haven't had before (repeats only when the pool runs dry), easiest first, and
-- turns go round the table: everyone's question 1, then everyone's question 2, and so on.
-- settings: {"topic": "", "grades": [1,2,3,4,5], "per_player": 10, "seconds": 20}
create or replace function public.start_game(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  n int;
  v_topic text;
  game_grades smallint[];
  every int;
begin
  select * into g from public.games where id = p_game_id for update;
  if g.id is null or g.host_id <> auth.uid() then raise exception 'Only the host can start the game'; end if;
  if g.status <> 'lobby' then raise exception 'This game has already started'; end if;
  if not exists (select 1 from public.game_players where game_id = g.id and left_at is null) then
    raise exception 'Nobody has joined yet';
  end if;
  n := least(50, greatest(1, coalesce((g.settings->>'per_player')::int, 10)));
  v_topic := nullif(g.settings->>'topic', '');
  game_grades := coalesce(
    (select array_agg(x::smallint) from jsonb_array_elements_text(g.settings->'grades') x), '{1,2,3,4,5}');

  -- Every picture_every-th question of each player's is a picture (flags …); 0 turns them off.
  every := coalesce((g.settings->>'picture_every')::int, 4);
  every := case when every < 2 then 0 else every end;
  with players as (
    select gp.id, gp.seat, gp.profile_id, public.age_years(p.age) as years,
           coalesce(gp.grades, game_grades) as grades,
           row_number() over (order by gp.seat, gp.joined_at) - 1 as turn
    from public.game_players gp join public.profiles p on p.id = gp.profile_id
    where gp.game_id = g.id and gp.left_at is null
  ),
  picked as (
    select pl.id as player_id, pl.turn, q.id as question_id, q.grade, q.kind
    from players pl
    cross join lateral (
      select q.id, q.grade, q.kind from public.questions q
      where q.active and q.kind = 'text'
        and pl.years between q.age_min and q.age_max
        and q.grade = any (pl.grades)
        and (v_topic is null or q.topic = v_topic)
      order by exists (select 1 from public.seen_questions s
                       where s.profile_id = pl.profile_id and s.question_id = q.id),
               random()
      limit n - case when every > 0 then n / every else 0 end
    ) q
    union all
    select pl.id, pl.turn, q.id, q.grade, q.kind
    from players pl
    cross join lateral (
      select q.id, q.grade, q.kind from public.questions q
      where every > 0 and q.active and q.kind = 'picture'
        and pl.years between q.age_min and q.age_max
        and q.grade = any (pl.grades)
        and (v_topic is null or q.topic = v_topic)
      order by exists (select 1 from public.seen_questions s
                       where s.profile_id = pl.profile_id and s.question_id = q.id),
               random()
      limit case when every > 0 then n / every else 0 end
    ) q
  ),
  ranked as (
    select *, row_number() over (partition by player_id, kind order by grade, random()) as r from picked
  ),
  ordered as (
    select *, case when kind = 'picture' then r * every else r + (r - 1) / greatest(every - 1, 1) * (every > 0)::int end as k
    from ranked
  )
  insert into public.game_questions (game_id, seq, question_id, player_id, kind)
  select g.id, row_number() over (order by k, turn), question_id, player_id,
         case when kind = 'picture' then 'picture' else 'normal' end from ordered;

  if not exists (select 1 from public.game_questions where game_id = g.id) then
    raise exception 'No questions match these players, topic and difficulty';
  end if;

  update public.game_questions set asked_at = now() where game_id = g.id and seq = 1;
  update public.games set status = 'playing', current_seq = 1, started_at = now(),
    active_player_id = (select player_id from public.game_questions where game_id = g.id and seq = 1)
  where id = g.id returning * into g;
  return g;
end $$;

-- Host shows the answer to everyone.
create or replace function public.reveal_answer(p_game_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_game_host(p_game_id) then raise exception 'Only the host can do that'; end if;
  update public.game_questions gq set revealed_at = coalesce(gq.revealed_at, now())
  from public.games g where g.id = p_game_id and gq.game_id = g.id and gq.seq = g.current_seq;
end $$;

-- Host moves on to the next question, or finishes the game after the last one.
create or replace function public.next_question(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  nxt public.game_questions;
begin
  select * into g from public.games where id = p_game_id for update;
  if g.id is null or g.host_id <> auth.uid() then raise exception 'Only the host can do that'; end if;
  if g.status <> 'playing' then return g; end if;
  if exists (select 1 from public.challenges where game_id = g.id and status = 'playing') then
    raise exception 'Finish or call off the duel first';
  end if;
  -- Make sure the question just played counts as seen, even if nobody answered it.
  insert into public.seen_questions (profile_id, question_id)
  select gp.profile_id, gq.question_id from public.game_questions gq
  join public.game_players gp on gp.id = gq.player_id
  where gq.game_id = g.id and gq.seq = g.current_seq
  on conflict do nothing;
  select * into nxt from public.game_questions where game_id = g.id and seq = g.current_seq + 1;
  if nxt.id is null then
    update public.challenges set status = 'cancelled', finished_at = now() where game_id = g.id and status = 'pending';
    update public.games set status = 'finished', finished_at = now(), active_player_id = null
    where id = g.id returning * into g;
  else
    update public.game_questions set asked_at = now() where id = nxt.id;
    update public.games set current_seq = nxt.seq, active_player_id = nxt.player_id
    where id = g.id returning * into g;
  end if;
  return g;
end $$;

-- Everything a player's or host's phone needs, in one call. Only for people in the game.
create or replace function public.game_state(p_game_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  g public.games;
  is_host boolean;
  result jsonb;
begin
  select * into g from public.games where id = p_game_id;
  if g.id is null or not public.is_game_member(g.id) then raise exception 'You are not in this game'; end if;
  is_host := g.host_id = auth.uid();
  select jsonb_build_object(
    'id', g.id, 'code', g.code, 'watch_key', case when is_host then g.watch_key end,
    'status', g.status, 'settings', g.settings, 'current_seq', g.current_seq,
    'total', (select count(*) from public.game_questions where game_id = g.id),
    'is_host', is_host,
    'host_name', (select display_name from public.profiles where user_id = g.host_id),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', gp.id, 'profile_id', gp.profile_id, 'name', p.display_name, 'age', p.age,
        'score', gp.score, 'streak', gp.streak, 'seat', gp.seat,
        'mine', gp.profile_id in (select public.my_profile_ids())) order by gp.seat, gp.joined_at)
      from public.game_players gp join public.profiles p on p.id = gp.profile_id
      where gp.game_id = g.id and gp.left_at is null), '[]'),
    'question', (
      select jsonb_build_object(
        'id', gq.id, 'seq', gq.seq, 'player_id', gq.player_id, 'kind', gq.kind,
        'topic', q.topic, 'grade', q.grade, 'text', coalesce(q.media->>'prompt', q.question),
        'media_url', q.media_url, 'media', q.media,
        'asked_at', gq.asked_at, 'revealed', gq.revealed_at is not null,
        -- The host sees the answer to judge it, except on questions for players on their own phone.
        'answer', case when (is_host and gq.player_id not in (
                              select id from public.game_players
                              where game_id = g.id and profile_id in (select public.my_profile_ids())))
                       or gq.revealed_at is not null
                       or exists (select 1 from public.answers a where a.game_question_id = gq.id) then q.answer end,
        -- The same shuffled order on every phone.
        'choices', case when cardinality(q.wrong) > 0 then (
          select jsonb_agg(c order by md5(gq.id::text || c))
          from unnest(array_append(q.wrong, q.answer)) c) end,
        'choices_shown', exists (select 1 from public.game_events e
                                 where e.game_id = g.id and e.type = 'choices'
                                   and (e.payload->>'game_question_id')::uuid = gq.id),
        'answers', coalesce((
          select jsonb_agg(jsonb_build_object('player_id', a.player_id, 'response', a.response,
                                              'used_choices', a.used_choices, 'is_correct', a.is_correct,
                                              'points', a.points))
          from public.answers a where a.game_question_id = gq.id), '[]'))
      from public.game_questions gq join public.questions q on q.id = gq.question_id
      where gq.game_id = g.id and gq.seq = g.current_seq),
    'requests', case when is_host then coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', p.display_name, 'age', p.age) order by r.created_at)
      from public.device_requests r join public.profiles p on p.id = r.profile_id
      where r.game_id = g.id and r.status = 'pending'), '[]') else '[]' end,
    'bonus', public.current_bonus(g.id),
    'challenge', public.current_challenge(g.id),
    'cards_used', coalesce((select jsonb_agg(challenger_id) from public.challenges
                            where game_id = g.id and status <> 'cancelled'), '[]')
  ) into result;
  return result;
end $$;

-- The active player tells everyone they've opened the multiple choice (worth 1 point instead of 2).
create or replace function public.show_choices(p_game_question_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  gq public.game_questions;
begin
  select * into gq from public.game_questions where id = p_game_question_id;
  if gq.id is null or not public.is_game_member(gq.game_id) then raise exception 'Not in this game'; end if;
  if not exists (select 1 from public.game_events where game_id = gq.game_id and type = 'choices'
                 and (payload->>'game_question_id')::uuid = gq.id) then
    insert into public.game_events (game_id, player_id, type, payload)
    values (gq.game_id, gq.player_id, 'choices', jsonb_build_object('game_question_id', gq.id));
  end if;
end $$;

revoke execute on function public.start_game(uuid), public.reveal_answer(uuid), public.next_question(uuid),
  public.game_state(uuid), public.show_choices(uuid) from public, anon;
grant execute on function public.start_game(uuid), public.reveal_answer(uuid), public.next_question(uuid),
  public.game_state(uuid), public.show_choices(uuid) to authenticated;

-- Ends a bonus mini-game. Points are the goals scored in the kicks recorded for it (at most 3),
-- awarded once, by the player's own phone or the host.
create or replace function public.finish_bonus(p_streak_event_id bigint)
returns int
language plpgsql security definer set search_path = public as $$
declare
  ev public.game_events;
  pts int;
begin
  select * into ev from public.game_events where id = p_streak_event_id and type = 'streak';
  if ev.id is null then raise exception 'No such bonus'; end if;
  if not (public.is_game_host(ev.game_id) or exists (
      select 1 from public.game_players where id = ev.player_id and profile_id in (select public.my_profile_ids()))) then
    raise exception 'Not your bonus';
  end if;
  if exists (select 1 from public.game_events where type = 'bonus' and (payload->>'streak_event_id')::bigint = ev.id) then
    return 0;
  end if;
  select least(3, count(*)) into pts from public.game_events
  where game_id = ev.game_id and type = 'bonus_kick'
    and (payload->>'streak_event_id')::bigint = ev.id and (payload->>'goal')::boolean;
  insert into public.game_events (game_id, player_id, type, points, payload)
  values (ev.game_id, ev.player_id, 'bonus', pts, jsonb_build_object('streak_event_id', ev.id, 'game', ev.payload->>'game'));
  return pts;
end $$;

revoke execute on function public.finish_bonus(bigint) from public, anon;
grant execute on function public.finish_bonus(bigint) to authenticated;

-- The bonus for the question on screen, if the last answer earned one.
create or replace function public.current_bonus(p_game_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', ev.id, 'player_id', ev.player_id, 'streak', (ev.payload->>'streak')::int, 'game', ev.payload->>'game',
    'kicks', coalesce((select jsonb_agg(k.payload order by k.id) from public.game_events k
                       where k.game_id = ev.game_id and k.type = 'bonus_kick'
                         and (k.payload->>'streak_event_id')::bigint = ev.id), '[]'),
    'points', (select b.points from public.game_events b
               where b.game_id = ev.game_id and b.type = 'bonus' and (b.payload->>'streak_event_id')::bigint = ev.id))
  from public.games g
  join public.game_questions gq on gq.game_id = g.id and gq.seq = g.current_seq
  join public.game_events ev on ev.game_id = g.id and ev.type = 'streak'
   and (ev.payload->>'game_question_id')::uuid = gq.id
  where g.id = p_game_id
  order by ev.id desc limit 1
$$;
revoke execute on function public.current_bonus(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- Live updates: phones in a game subscribe to these tables
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['games', 'game_players', 'game_questions', 'answers', 'game_events', 'device_requests'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1v1 challenges: each player has one Challenge card per game and picks who to challenge and how:
--   'buzzer': 3 rounds. Each round both players get their own multiple choice question (at their own
--             level) at the same moment. First to tap the right answer wins the round; a wrong tap
--             locks you out of that round. Best of 3.
--   'game':   both play the same silly mini-game (picked at random); the higher score wins.
-- The winner steals 2 points. settings.challenge_refuse: 'costs' (default: refusing costs the
-- challenged player 1 point), 'never' (must accept) or 'free'.
-- ---------------------------------------------------------------------------

create table if not exists public.challenges (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references public.games on delete cascade,
  challenger_id  uuid not null references public.game_players on delete cascade,
  opponent_id    uuid not null references public.game_players on delete cascade,
  status         text not null default 'pending'
                 check (status in ('pending', 'refused', 'playing', 'finished', 'cancelled')),
  winner_id      uuid references public.game_players on delete set null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
create index if not exists challenges_game on public.challenges (game_id, created_at);
alter table public.challenges add column if not exists mode text not null default 'buzzer';
alter table public.challenges add column if not exists minigame text;

create table if not exists public.challenge_questions (
  challenge_id  uuid not null references public.challenges on delete cascade,
  game_id       uuid not null references public.games on delete cascade,
  player_id     uuid not null references public.game_players on delete cascade,
  idx           smallint not null,     -- the round
  question_id   bigint not null references public.questions on delete cascade,
  response      text,
  is_correct    boolean,
  answered_at   timestamptz,
  primary key (challenge_id, player_id, idx)
);

-- Silly game scores.
create table if not exists public.challenge_scores (
  challenge_id  uuid not null references public.challenges on delete cascade,
  game_id       uuid not null references public.games on delete cascade,
  player_id     uuid not null references public.game_players on delete cascade,
  score         int not null,
  created_at    timestamptz not null default now(),
  primary key (challenge_id, player_id)
);

alter table public.challenges enable row level security;
alter table public.challenge_questions enable row level security;
alter table public.challenge_scores enable row level security;
-- Players read the duel through game_state(); all changes go through the functions below.
drop policy if exists "read challenges" on public.challenges;
create policy "read challenges" on public.challenges for select to authenticated using (public.is_game_member(game_id));
drop policy if exists "read challenge questions" on public.challenge_questions;
create policy "read challenge questions" on public.challenge_questions for select to authenticated
  using (public.is_game_member(game_id));
drop policy if exists "read challenge scores" on public.challenge_scores;
create policy "read challenge scores" on public.challenge_scores for select to authenticated
  using (public.is_game_member(game_id));

-- True when this phone plays as that game player.
create or replace function public.controls_player(p_player_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.game_players
                 where id = p_player_id and profile_id in (select public.my_profile_ids()))
$$;

create or replace function public.start_challenge(p_challenger_id uuid, p_opponent_id uuid, p_mode text)
returns public.challenges
language plpgsql security definer set search_path = public as $$
declare
  me public.game_players;
  g public.games;
  c public.challenges;
begin
  if p_mode not in ('buzzer', 'game') then raise exception 'Pick questions or a silly game'; end if;
  select * into me from public.game_players where id = p_challenger_id;
  if me.id is null or not public.controls_player(me.id) then raise exception 'Not your player'; end if;
  select * into g from public.games where id = me.game_id for update;
  if g.status <> 'playing' then raise exception 'Challenges are for during the game'; end if;
  if p_opponent_id = me.id or not exists (select 1 from public.game_players
      where id = p_opponent_id and game_id = g.id and left_at is null) then
    raise exception 'Pick someone else in the game';
  end if;
  if exists (select 1 from public.challenges where challenger_id = me.id and status <> 'cancelled') then
    raise exception 'You have already used your Challenge card';
  end if;
  if exists (select 1 from public.challenges where game_id = g.id and status in ('pending', 'playing')) then
    raise exception 'Another challenge is already on';
  end if;
  insert into public.challenges (game_id, challenger_id, opponent_id, mode, minigame)
  values (g.id, me.id, p_opponent_id, p_mode,
          case when p_mode = 'game' then (array['penalties', 'hoops', 'moles', 'wheel'])[1 + floor(random() * 4)::int] end)
  returning * into c;
  return c;
end $$;

-- Older app versions.
create or replace function public.issue_challenge(p_challenger_id uuid, p_opponent_id uuid)
returns public.challenges
language sql security definer set search_path = public as $$
  select * from public.start_challenge(p_challenger_id, p_opponent_id, 'buzzer')
$$;

-- The challenged player (or the host) accepts or refuses. Accepting a buzzer race deals the questions.
create or replace function public.answer_challenge(p_challenge_id uuid, p_accept boolean)
returns public.challenges
language plpgsql security definer set search_path = public as $$
declare
  c public.challenges;
  g public.games;
  rule text;
  n constant int := 3;
  game_grades smallint[];
begin
  select * into c from public.challenges where id = p_challenge_id for update;
  if c.id is null or c.status <> 'pending' then raise exception 'That challenge is over'; end if;
  if not (public.controls_player(c.opponent_id) or public.is_game_host(c.game_id)) then
    raise exception 'Only the challenged player can answer';
  end if;
  select * into g from public.games where id = c.game_id;
  rule := coalesce(g.settings->>'challenge_refuse', 'costs');
  if not p_accept then
    if rule = 'never' then raise exception 'Challenges can''t be refused in this game'; end if;
    update public.challenges set status = 'refused', finished_at = now() where id = c.id returning * into c;
    insert into public.game_events (game_id, player_id, type, points, payload)
    select c.game_id, c.opponent_id, 'challenge_refused', case when rule = 'costs' then -least(1, gp.score) else 0 end,
           jsonb_build_object('challenge_id', c.id, 'challenger_id', c.challenger_id)
    from public.game_players gp where gp.id = c.opponent_id;
    return c;
  end if;

  if c.mode = 'buzzer' then
    game_grades := coalesce(
      (select array_agg(x::smallint) from jsonb_array_elements_text(g.settings->'grades') x), '{1,2,3,4,5}');
    insert into public.challenge_questions (challenge_id, game_id, player_id, idx, question_id)
    select c.id, c.game_id, pl.id, row_number() over (partition by pl.id order by q.grade, random()), q.id
    from (select gp.id, gp.profile_id, public.age_years(p.age) as years, coalesce(gp.grades, game_grades) as grades
          from public.game_players gp join public.profiles p on p.id = gp.profile_id
          where gp.id in (c.challenger_id, c.opponent_id)) pl
    cross join lateral (
      select q.id, q.grade from public.questions q
      where q.active and q.kind = 'text' and cardinality(q.wrong) > 0
        and pl.years between q.age_min and q.age_max and q.grade = any (pl.grades)
        and not exists (select 1 from public.game_questions gq where gq.game_id = c.game_id and gq.question_id = q.id)
      order by exists (select 1 from public.seen_questions s where s.profile_id = pl.profile_id and s.question_id = q.id),
               random()
      limit n
    ) q;
    if (select count(*) from public.challenge_questions where challenge_id = c.id) < 2 * n then
      raise exception 'Not enough questions for this duel';
    end if;
  end if;
  update public.challenges set status = 'playing', started_at = now() where id = c.id returning * into c;
  return c;
end $$;

-- Ends a duel; the winner (if any) steals 2 points.
create or replace function public.end_challenge(p_challenge_id uuid, p_winner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.challenges;
  loser uuid;
  loser_score int;
begin
  update public.challenges set status = 'finished', finished_at = now(), winner_id = p_winner
  where id = p_challenge_id and status = 'playing' returning * into c;
  if c.id is null or p_winner is null then return; end if;
  loser := case when p_winner = c.challenger_id then c.opponent_id else c.challenger_id end;
  select score into loser_score from public.game_players where id = loser;
  insert into public.game_events (game_id, player_id, type, points, payload) values
    (c.game_id, p_winner, 'challenge_won', 2, jsonb_build_object('challenge_id', c.id, 'from', loser)),
    (c.game_id, loser, 'challenge_lost', -least(2, loser_score), jsonb_build_object('challenge_id', c.id, 'to', p_winner));
end $$;

-- Rounds of a buzzer race: who won each, and whether it's over.
create or replace function public.buzzer_rounds(p_challenge_id uuid)
returns table (idx smallint, winner uuid, resolved boolean)
language sql stable security definer set search_path = public as $$
  select cq.idx,
         (array_agg(cq.player_id) filter (where cq.is_correct))[1],
         bool_or(coalesce(cq.is_correct, false)) or count(cq.answered_at) = 2
  from public.challenge_questions cq where cq.challenge_id = p_challenge_id
  group by cq.idx order by cq.idx
$$;

-- A buzz in a buzzer race. An empty response means time ran out. Returns whether it was right.
create or replace function public.challenge_answer(p_challenge_id uuid, p_player_id uuid, p_idx int, p_response text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  c public.challenges;
  cq public.challenge_questions;
  correct boolean;
  round int;
  a_wins int; b_wins int; open_rounds int;
begin
  select * into c from public.challenges where id = p_challenge_id for update;
  if c.id is null or c.status <> 'playing' or c.mode <> 'buzzer' then raise exception 'That duel is over'; end if;
  if p_player_id not in (c.challenger_id, c.opponent_id) or not public.controls_player(p_player_id) then
    raise exception 'Not your duel';
  end if;
  select min(r.idx) into round from public.buzzer_rounds(c.id) r where not r.resolved;
  if round is null or p_idx <> round then return null; end if;  -- that round is already decided
  select * into cq from public.challenge_questions
  where challenge_id = c.id and player_id = p_player_id and idx = p_idx;
  if cq.question_id is null then raise exception 'No such duel question'; end if;
  if cq.answered_at is not null then return cq.is_correct; end if;
  select coalesce(p_response, '') <> '' and lower(trim(p_response)) = lower(trim(q.answer)) into correct
  from public.questions q where q.id = cq.question_id;
  update public.challenge_questions set response = nullif(p_response, ''), is_correct = correct, answered_at = now()
  where challenge_id = c.id and player_id = p_player_id and idx = p_idx;
  insert into public.seen_questions (profile_id, question_id)
  select profile_id, cq.question_id from public.game_players where id = p_player_id
  on conflict do nothing;

  select count(*) filter (where r.winner = c.challenger_id), count(*) filter (where r.winner = c.opponent_id),
         count(*) filter (where not r.resolved)
  into a_wins, b_wins, open_rounds from public.buzzer_rounds(c.id) r;
  if a_wins >= 2 or b_wins >= 2 or open_rounds = 0 then
    perform public.end_challenge(c.id, case when a_wins > b_wins then c.challenger_id
                                            when b_wins > a_wins then c.opponent_id end);
  end if;
  return correct;
end $$;

-- A player's score in a silly game face-off. When both are in, the higher score wins.
create or replace function public.challenge_game_score(p_challenge_id uuid, p_player_id uuid, p_score int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.challenges;
  a int; b int;
begin
  select * into c from public.challenges where id = p_challenge_id for update;
  if c.id is null or c.status <> 'playing' or c.mode <> 'game' then raise exception 'That duel is over'; end if;
  if p_player_id not in (c.challenger_id, c.opponent_id) or not public.controls_player(p_player_id) then
    raise exception 'Not your duel';
  end if;
  insert into public.challenge_scores (challenge_id, game_id, player_id, score)
  values (c.id, c.game_id, p_player_id, greatest(0, least(p_score, 100)))
  on conflict do nothing;
  select score into a from public.challenge_scores where challenge_id = c.id and player_id = c.challenger_id;
  select score into b from public.challenge_scores where challenge_id = c.id and player_id = c.opponent_id;
  if a is not null and b is not null then
    perform public.end_challenge(c.id, case when a > b then c.challenger_id when b > a then c.opponent_id end);
  end if;
end $$;

-- The host can call off a duel (say a phone went quiet). The card isn't used up.
create or replace function public.cancel_challenge(p_challenge_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.challenges;
begin
  select * into c from public.challenges where id = p_challenge_id;
  if c.id is null then raise exception 'No such challenge'; end if;
  if not (public.is_game_host(c.game_id) or (c.status = 'pending' and public.controls_player(c.challenger_id))) then
    raise exception 'Only the host can call off a duel';
  end if;
  update public.challenges set status = 'cancelled', finished_at = now()
  where id = c.id and status in ('pending', 'playing');
end $$;

-- The challenge to show now: one that's on, or one that ended since this question came up.
-- A buzzer question's answer shows once its round is decided.
create or replace function public.current_challenge(p_game_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', c.id, 'challenger_id', c.challenger_id, 'opponent_id', c.opponent_id, 'status', c.status,
    'mode', c.mode, 'minigame', c.minigame, 'winner_id', c.winner_id, 'started_at', c.started_at,
    'rounds', coalesce((select jsonb_agg(jsonb_build_object('idx', r.idx, 'winner', r.winner, 'resolved', r.resolved))
                        from public.buzzer_rounds(c.id) r), '[]'),
    'scores', coalesce((select jsonb_object_agg(s.player_id, s.score) from public.challenge_scores s
                        where s.challenge_id = c.id), '{}'),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'player_id', cq.player_id, 'idx', cq.idx, 'topic', q.topic, 'text', q.question,
        'choices', (select jsonb_agg(x order by md5(c.id::text || x)) from unnest(array_append(q.wrong, q.answer)) x),
        'answered', cq.answered_at is not null, 'response', cq.response, 'is_correct', cq.is_correct,
        'answer', case when cq.answered_at is not null or c.status <> 'playing'
                         or exists (select 1 from public.buzzer_rounds(c.id) r where r.idx = cq.idx and r.resolved)
                       then q.answer end) order by cq.idx, cq.player_id)
      from public.challenge_questions cq join public.questions q on q.id = cq.question_id
      where cq.challenge_id = c.id), '[]'))
  from public.challenges c
  join public.games g on g.id = c.game_id
  left join public.game_questions gq on gq.game_id = g.id and gq.seq = g.current_seq
  where c.game_id = p_game_id
    and (c.status in ('pending', 'playing') or (c.status in ('finished', 'refused') and c.finished_at >= gq.asked_at))
  order by c.created_at desc limit 1
$$;

revoke execute on function public.controls_player(uuid), public.start_challenge(uuid, uuid, text),
  public.issue_challenge(uuid, uuid), public.answer_challenge(uuid, boolean), public.end_challenge(uuid, uuid),
  public.buzzer_rounds(uuid), public.challenge_answer(uuid, uuid, int, text),
  public.challenge_game_score(uuid, uuid, int), public.cancel_challenge(uuid), public.current_challenge(uuid)
  from public, anon;
grant execute on function public.start_challenge(uuid, uuid, text), public.issue_challenge(uuid, uuid),
  public.answer_challenge(uuid, boolean), public.challenge_answer(uuid, uuid, int, text),
  public.challenge_game_score(uuid, uuid, int), public.cancel_challenge(uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['challenges', 'challenge_questions', 'challenge_scores'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
