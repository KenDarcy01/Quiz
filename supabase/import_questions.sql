-- Loads the built-in question bank (questions/questions.json in this repo) into Supabase.
--
-- Run in the Supabase SQL Editor after schema.sql, and again whenever a new batch of
-- questions is pushed. It fetches the file straight from GitHub, adds new questions,
-- updates changed ones, and hides bank questions that were removed from the file
-- (they stay in the database so old games still make sense).

create extension if not exists http with schema extensions;

create or replace function public.import_bank_questions(
  url text default 'https://raw.githubusercontent.com/KenDarcy01/Quiz/main/questions/questions.json')
returns table (added int, updated int, hidden int)
language plpgsql security definer set search_path = public, extensions as $$
declare
  res extensions.http_response;
  rows jsonb;
begin
  res := extensions.http_get(url);
  if res.status <> 200 then raise exception 'Could not fetch % (status %)', url, res.status; end if;
  rows := res.content::jsonb;

  create temp table incoming on commit drop as
  select r->>'topic' as topic, coalesce(r->>'age', '') as age_band, (r->>'grade')::smallint as grade,
         r->>'question' as question, r->>'answer' as answer,
         array(select jsonb_array_elements_text(r->'wrong')) as wrong
  from jsonb_array_elements(rows) r;

  with up as (
    insert into public.questions as q (source, topic, age_band, grade, question, answer, wrong)
    select 'bank', topic, age_band, grade, question, answer, wrong from incoming
    on conflict (source, age_band, lower(question)) do update
      set topic = excluded.topic, grade = excluded.grade, answer = excluded.answer,
          wrong = excluded.wrong, active = true
      where (q.topic, q.grade, q.answer, q.wrong, q.active)
            is distinct from (excluded.topic, excluded.grade, excluded.answer, excluded.wrong, true)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;

  with gone as (
    update public.questions q set active = false
    where q.source = 'bank' and q.active
      and not exists (select 1 from incoming i
                      where i.age_band = q.age_band and lower(i.question) = lower(q.question))
    returning 1
  )
  select count(*) into hidden from gone;

  return next;
end $$;

revoke all on function public.import_bank_questions(text) from public, anon, authenticated;

select * from public.import_bank_questions();
