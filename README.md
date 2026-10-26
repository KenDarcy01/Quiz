# Family Quiz

A pass-the-phone family quiz, built as a Progressive Web App (PWA). Each player gets questions graded for their own age (6 to adult), everyone answers question 1, then question 2, and so on, and a leaderboard closes each round.

It is plain HTML, CSS and JavaScript with no build step. Questions come from the Supabase database (see [`supabase/`](supabase/README.md)) plus a Google Sheet, with a bundled copy for offline play.

## Run it locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or HTTPS, so opening `index.html` straight from the file system won't work.

## Put it online with GitHub Pages

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
3. After a minute the app is live at `https://familyquiz.app` (the custom domain is set in **Settings → Pages** and in the `CNAME` file; name.com DNS has the four GitHub Pages A records plus a `www` CNAME to `kendarcy01.github.io`). The old `https://kendarcy01.github.io/Quiz/` address redirects there.
4. Supabase **Authentication → URL Configuration** must list `https://familyquiz.app` as the Site URL so sign-up and password-reset emails link back to the app.
5. On a phone, open that link and choose **Add to Home Screen** (Safari: Share menu; Chrome: ⋮ menu). It then opens full screen like an app and works offline.

## Questions

The app combines two sources:

1. **The question bank** in Supabase. When the database can't be reached, the app uses the bundled copy, [`questions/questions.csv`](questions/questions.csv). Both are built by `python3 questions/build.py` from `questions/src/`, and the database is refreshed with `select * from public.import_bank_questions();` after each push. New batches go into `questions/src/band_*.py`. The build checks every question has four different options and makes sense without the choices, and it prints how many questions each age band has at each grade.
2. **The family's own questions** from a Google Sheet (`DEFAULT_SHEET_URL` in `js/questions.js`, or a link pasted into **Edit players → Google Sheet link**). The sheet must be shared as **Anyone with the link → Viewer**. The app keeps a copy of the last sheet it loaded, so a quiz still runs without signal.

Both use the same columns:

| topic | age | grade | question | answer | wrong1 | wrong2 | wrong3 |
|---|---|---|---|---|---|---|---|

- `topic`: any name, such as Geography. Topics appear in the home screen's topic picker.
- `age`: who the question suits, as a band (`6-7`, `8-9` … `16-17`), one age (`10`), `16+`, `adult`, or blank for everyone.
- `grade`: difficulty from 1 (easiest) to 5 (hardest) for that age.
- `wrong1`–`wrong3`: optional. With them, a stuck player can tap **Show choices**.

## How a round works

Pick a topic (or mixed) and a difficulty, then each player is dealt questions that suit their age, easiest first. The app remembers which questions each player has had, so they don't repeat until the pool runs out (Settings has a button to start fresh).

- **2 points** for answering out loud straight away. The quiz master taps **Show answer**, then **Right** or **Wrong**.
- **1 point** if the player taps **Show choices** and picks the right one.

## Files

| Path | What it does |
|---|---|
| `index.html` | App page |
| `styles.css` | Sticker Pop theme |
| `js/app.js` | Screens and game flow |
| `js/questions.js` | Loads questions and picks them by age, grade and topic |
| `js/supabase.js` | Supabase address, public key and question loading |
| `js/multiplayer.js` | Hosting and joining games on everyone's phones |
| `watch.html` | Follow a game live in any browser, no app or account |
| `js/account.js` | Sign-in, profiles, kids' profiles and account deletion (Supabase Auth) |
| `js/vendor/supabase.js` | Supabase client library 2.45.4, kept in the repo so it works offline |
| `js/csv.js` | CSV parser |
| `sw.js` | Offline caching |
| `manifest.webmanifest`, `icons/` | Install as an app |
| `questions/questions.csv` | Bundled copy of the questions |

## Later

Scores live only on the device for now. Questions and results are moving to Supabase (see [`supabase/`](supabase/README.md)), then native apps once the look and feel is settled.
