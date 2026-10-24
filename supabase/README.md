# Supabase

The app is moving from the bundled CSV + Google Sheet to a Supabase database, so that families can sign in, play together on their own phones, and keep scores.

Project: `https://fpgrghfzlpfxoshlamjo.supabase.co`

## Set up the database

Done on 2026-10-24: the schema is applied and all 2,258 bank questions are loaded. Claude makes database changes through the Supabase connector. To set up a fresh project by hand, open **SQL Editor → New query**, then:

1. Paste all of [`schema.sql`](schema.sql) and press **Run**. It creates the tables, security rules and game functions. It is safe to run again after it changes.
2. Paste all of [`import_questions.sql`](import_questions.sql) and press **Run**. It fetches `questions/questions.json` from GitHub and loads it. The result shows how many questions were added, updated and hidden. Rerun just the last line, `select * from public.import_bank_questions();`, after each new batch of questions.

## Tables

| Table | Holds |
|---|---|
| `questions` | Every question. `source` is `bank` (from this repo) or `family` (added in the app). `kind` is `text`, `picture` or `music`, with `media_url` and `media` for the picture or 30-second preview and how it is revealed. |
| `profiles` | A player. With `user_id` it is a person who signs in (made automatically at sign-up). Without one it is a child profile the `owner_id` manages, so kids can play without their own login. |
| `games` | One quiz: share `code`, host, `status` (lobby, playing, finished), the host's `settings`, which question is on screen and who has control. |
| `game_players` | Who is in a game, seat order, their own difficulty, score and streak. |
| `game_questions` | The questions dealt, in order, with whose turn each is. `kind` covers normal, bonus, picture, music and 1v1 challenge (with `opponent_id`). |
| `answers` | Each answer, whether choices were shown, and the points. Scores and streaks update automatically. |
| `game_events` | Streaks, bonus rounds, challenges, steals and mini-game results (such as the penalty shootout), with any points they award. |
| `seen_questions` | Questions each profile has had, so they don't repeat on any device. |

## Game functions

Called from the app with `supabase.rpc(...)`:

- `create_game(settings)` makes a game and a four-letter share code (no 0/O or 1/I).
- `join_game(code, profile_id)` adds a player. A parent can join their child's profile.
- `submit_answer(game_question_id, player_id, is_correct, used_choices, response, steal_from)` records an answer: 2 points straight, 1 with choices, 2 for a steal (taken from the other player). The host marks spoken answers. A player can only answer their own question by sending the choice they picked, and the database checks it.
- `start_game(game_id)` deals each player questions for their own age and difficulty that they haven't had before, easiest first, taking turns round the table.
- `show_choices(game_question_id)` tells everyone the player opened the multiple choice (1 point instead of 2).
- `reveal_answer(game_id)` and `next_question(game_id)` let the host move the game on; after the last question the game is finished.
- `game_state(game_id)` returns everything a phone in the game needs. Phones call it whenever Realtime reports a change, and every few seconds as a safety net.

## Streak bonuses and challenges

- Every 3 correct answers in a row (3, 6, 9 …) a player earns a bonus mini-game, a 3-kick penalty shootout worth a point a goal. `finish_bonus(streak_event_id)` scores it once.
- Every streak bonus is a random silly game: penalties, basketball, whack-a-mole or prize wheel.
- Each player has one Challenge card per game. `start_challenge(challenger, opponent, mode)` dares another player, and the challenger picks how: `buzzer` (3 rounds; each round both players get their own multiple choice question at their own level at the same moment, first to tap the right answer wins the round, a wrong tap locks you out of it, best of 3) or `game` (both play the same random silly game; higher score wins). The challenged player accepts or refuses with `answer_challenge(id, accept)`; refusing costs them 1 point (`settings.challenge_refuse` can be `never` or `free` instead). Buzzes go through `challenge_answer(id, player, round, response)`, game scores through `challenge_game_score(id, player, score)`. The winner steals 2 points. The host can call it off with `cancel_challenge(id)`, which gives the card back. The game can't move on mid-duel.

## Kids on their own devices

A child's phone or tablet signs in anonymously (Supabase **Allow anonymous sign-ins** must be on), types the game code and taps their name from `family_profiles(code)`, which lists the child profiles of the host and the families already in the game. `request_device(code, profile_id)` sends the request, and the parent or host approves it with `decide_device(request_id, true)`. That links the device in `profile_devices` and puts the child in the game. The device then counts as the child in every later game, until the parent removes it. Older kids can sign up with their own email instead.

Anonymous sign-ins can only play: `is_full_account()` stops them hosting games, adding questions or creating profiles, and they don't get a profile of their own.

## Deleting an account

Both app stores require in-app account deletion. The app calls the `delete-account` Edge Function ([`functions/delete-account`](functions/delete-account/index.ts)) with the user's session. It deletes the sign-in, and the database's foreign keys remove their profile, child profiles, hosted games and linked devices.

## Watching without playing

Anyone with a game's watch link can follow it live in a browser, without the app or a login. The link uses the game's `watch_key`, which is separate from the join code, so it can't be used to join as a player. `watch_game(watch_key)` returns the scoreboard, the question on screen (the answer only after the host reveals it) and recent events like streaks and steals. The watch page ([`watch.html`](../watch.html)) checks it every two seconds. The host can switch watching off with `settings.watchers = false`.

## Security

Row level security is on for every table. Anyone can read questions, so the pass-the-phone game still works without signing in. Games, players and answers are visible only to people in that game. Only the host changes a game, and answers go through `submit_answer` so nobody can give themselves points. The app uses the public anon key only; the service_role key must never go in the app.

## Next steps

Done: questions from the database, email sign-in with kids' profiles, account deletion, multiplayer (host, join with a code, lobby, live questions, scores), the watch page, streak bonuses and 1v1 challenges.

1. An "Add a question" screen for the family's own questions (to replace the Google Sheet).
2. Google sign-in, with Sign in with Apple alongside it for the App Store.
3. More streak mini-games, picture and music rounds.
