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

## Kids on their own devices

A child's phone or tablet signs in anonymously (Supabase **Allow anonymous sign-ins** must be on), types the game code and taps their name from `family_profiles(code)`, which lists the child profiles of the host and the families already in the game. `request_device(code, profile_id)` sends the request, and the parent or host approves it with `decide_device(request_id, true)`. That links the device in `profile_devices` and puts the child in the game. The device then counts as the child in every later game, until the parent removes it. Older kids can sign up with their own email instead.

Anonymous sign-ins can only play: `is_full_account()` stops them hosting games, adding questions or creating profiles, and they don't get a profile of their own.

## Deleting an account

Both app stores require in-app account deletion. The app calls the `delete-account` Edge Function ([`functions/delete-account`](functions/delete-account/index.ts)) with the user's session. It deletes the sign-in, and the database's foreign keys remove their profile, child profiles, hosted games and linked devices.

## Watching without playing

Anyone with a game's watch link can follow it live in a browser, without the app or a login. The link uses the game's `watch_key`, which is separate from the join code, so it can't be used to join as a player. `watch_game(watch_key)` returns the scoreboard, the question on screen (the answer only after the host reveals it) and recent events like streaks and steals. The watch page will load that, then listen on a Realtime broadcast channel for the host's updates. The host can switch watching off with `settings.watchers = false`.

## Security

Row level security is on for every table. Anyone can read questions, so the pass-the-phone game still works without signing in. Games, players and answers are visible only to people in that game. Only the host changes a game, and answers go through `submit_answer` so nobody can give themselves points. The app uses the public anon key only; the service_role key must never go in the app.

## Next steps

1. Load the Supabase client in the app and read questions from the database, keeping the bundled CSV as the offline copy.
2. Move the family's Google Sheet questions into `questions` as `family` questions, and add an "Add a question" screen.
3. Sign-in (Google and email), profiles and child profiles.
4. Multiplayer: create/join with a code, lobby, live questions, scoreboard, then streaks, challenges, picture and music rounds.
5. Watch page: a browser link for people who want to follow along without playing.
