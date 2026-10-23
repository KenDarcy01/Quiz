# Family Quiz

A pass-the-phone family quiz, built as a Progressive Web App (PWA). Each player gets questions for their own age group (10, 13, 14 or adult), everyone answers question 1, then question 2, and so on, and a leaderboard closes each round.

It is plain HTML, CSS and JavaScript with no build step. Questions come from a Google Sheet, with a sample round built in.

## Run it locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. A service worker needs `localhost` or HTTPS, so opening `index.html` straight from the file system won't work.

## Put it online with GitHub Pages

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
3. After a minute the app is live at `https://kendarcy01.github.io/Quiz/`.
4. On a phone, open that link and choose **Add to Home Screen** (Safari: Share menu; Chrome: ⋮ menu). It then opens full screen like an app and works offline.

## Questions in a Google Sheet

1. Create a Google Sheet with these column headings in row 1:

   | round | age | number | question | answer | wrong1 | wrong2 | wrong3 |
   |---|---|---|---|---|---|---|---|

   - `age` is one of `10`, `13`, `14` or `adult`.
   - `wrong1`–`wrong3` are optional. With them, the player sees multiple choice. Without them, the player says the answer out loud and the quiz master taps **Show answer**, then **Right** or **Wrong**.
   - `number` is optional and sets the order within a round.

   The quickest start is **File → Import** on [`questions/sample.csv`](questions/sample.csv), which is round 1 in this format.
2. Click **Share** and set **General access** to **Anyone with the link → Viewer**.
3. In the app, tap **Edit players**, paste the sheet's link into **Google Sheet link**, and save.

The app keeps a copy of the last sheet it loaded, so a quiz still runs without signal. Add more rounds by adding rows with `round` set to 2, 3 and so on. A round picker appears on the home screen.

## Files

| Path | What it does |
|---|---|
| `index.html` | App page |
| `styles.css` | Sticker Pop theme |
| `js/app.js` | Screens and game flow |
| `js/questions.js` | Loads and groups questions from the sheet or the sample |
| `js/csv.js` | CSV parser |
| `sw.js` | Offline caching |
| `manifest.webmanifest`, `icons/` | Install as an app |
| `questions/sample.csv` | Built-in sample round |

## Later

Scores live only on the device for now. The plan is to move questions and results to Supabase, then build native apps once the look and feel is settled.
