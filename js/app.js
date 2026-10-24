// Family Quiz: a pass-the-phone quiz where each player gets questions for their age.

const SETTINGS_KEY = 'fq.settings.v1';
const GAME_KEY = 'fq.game.v2';
const SEEN_KEY = 'fq.seen.v1';
const COLOURS = ['var(--cyan)', 'var(--pink)', 'var(--lime)', 'var(--orange)'];
const AGES = ['6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', 'adult'];
const POINTS_STRAIGHT = 2; // answered without seeing the choices
const POINTS_CHOICES = 1;  // answered from the multiple choice
const DIFFICULTIES = [
  { id: 'mixed', label: 'Mixed (1–5)', grades: [1, 2, 3, 4, 5] },
  { id: 'easy', label: 'Easy (1–2)', grades: [1, 2] },
  { id: 'medium', label: 'Medium (2–4)', grades: [2, 3, 4] },
  { id: 'hard', label: 'Hard (4–5)', grades: [4, 5] },
];

const DEFAULT_SETTINGS = {
  sheetUrl: '',
  seconds: 20,
  perPlayer: 10,
  topic: '',
  difficulty: 'mixed',
  players: [
    { name: 'Player 1', age: '10' },
    { name: 'Player 2', age: '13' },
    { name: 'Player 3', age: '14' },
    { name: 'Player 4', age: 'adult' },
  ],
};

const app = document.getElementById('app');
const state = {
  screen: 'home',
  settings: { ...DEFAULT_SETTINGS, ...(load(SETTINGS_KEY) || {}) },
  bank: null, // { questions, source, error }
  loading: true,
  game: load(GAME_KEY),
  timer: null,
  deadline: 0,
};

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: the app still works for this session */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ageLabel(age) {
  return age === 'adult' ? 'Adult' : `Age ${age}`;
}

function difficulty() {
  return DIFFICULTIES.find((d) => d.id === state.settings.difficulty) || DIFFICULTIES[0];
}

// A player's own level, or the game's difficulty when they haven't been given one.
function difficultyFor(p) {
  return DIFFICULTIES.find((d) => d.id === p.difficulty) || difficulty();
}

function sheetUrl() {
  return state.settings.sheetUrl || DEFAULT_SHEET_URL;
}

function badge(pi, extra = '') {
  return `<div class="badge tilt-${pi % 4} ${extra}" style="background:${COLOURS[pi % 4]}" aria-hidden="true">${pi + 1}</div>`;
}

// ---------- Data ----------

async function refreshQuestions() {
  state.loading = true;
  render();
  try {
    state.bank = await loadQuestions(sheetUrl());
  } catch (e) {
    state.bank = { questions: [], source: 'none', error: e.message || String(e) };
  }
  if (state.settings.topic && !topicsIn(state.bank.questions).includes(state.settings.topic)) {
    state.settings.topic = '';
  }
  state.loading = false;
  render();
}

function poolForPlayer(p) {
  return state.bank ? poolFor(state.bank.questions, p.age, state.settings.topic, difficultyFor(p).grades) : [];
}

// Deals round the topics in turn so one game doesn't bunch up on a single topic.
function spreadTopics(list) {
  const byTopic = new Map();
  shuffle(list).forEach((q) => byTopic.set(q.topic, [...(byTopic.get(q.topic) || []), q]));
  const piles = shuffle([...byTopic.values()]);
  const out = [];
  while (out.length < list.length) piles.forEach((pile) => { if (pile.length) out.push(pile.shift()); });
  return out;
}

// Picks questions this player hasn't had yet, spread over the topics. When the pool runs dry it
// tops up with the ones they had longest ago. Questions already dealt to someone else this game
// (taken) are left out unless the pool is too small.
function deal(p, seen, taken = new Set()) {
  const key = p.name.trim().toLowerCase();
  const had = seen[key] || [];
  const when = new Map(had.map((id, i) => [id, i]));
  const all = poolForPlayer(p);
  const free = all.filter((q) => !taken.has(q.id));
  const pool = free.length >= state.settings.perPlayer ? free : all;
  const fresh = spreadTopics(pool.filter((q) => !when.has(q.id)));
  const repeats = pool.filter((q) => when.has(q.id)).sort((a, b) => when.get(a.id) - when.get(b.id));
  const picked = fresh.concat(repeats).slice(0, state.settings.perPlayer);
  picked.forEach((q) => taken.add(q.id));
  return picked.sort((a, b) => a.grade - b.grade); // easier questions first
}

// Everyone at the table hears every question, so it counts as had for anyone it suits.
function markHeard(players, sets, seen) {
  const asked = sets.flat();
  players.forEach((p) => {
    const key = p.name.trim().toLowerCase();
    const years = playerAge(p.age);
    const heard = new Set(asked.filter((q) => years >= q.age.min && years <= q.age.max).map((q) => q.id));
    seen[key] = [...(seen[key] || []).filter((id) => !heard.has(id)), ...heard];
  });
}

// ---------- Game flow ----------

function startRound() {
  const { players } = state.settings;
  const seen = load(SEEN_KEY) || {};
  const taken = new Set();
  const sets = players.map((p) => deal(p, seen, taken));
  const longest = Math.max(0, ...sets.map((s) => s.length));
  const turns = [];
  // Interleave: everyone answers question 1, then everyone answers question 2, and so on.
  for (let qi = 0; qi < longest; qi++) {
    sets.forEach((set, pi) => {
      if (set[qi]) turns.push({ player: pi, question: set[qi], n: qi + 1, of: set.length });
    });
  }
  if (!turns.length) return;
  markHeard(players, sets, seen);
  save(SEEN_KEY, seen);
  state.game = {
    topic: state.settings.topic || 'Mixed topics',
    difficulty: difficulty().label,
    turns,
    at: 0,
    scores: players.map(() => 0),
    correct: players.map(() => 0),
  };
  beginTurn();
  state.screen = 'pass';
  persist();
  render();
}

function currentTurn() {
  return state.game.turns[state.game.at];
}

function beginTurn() {
  const g = state.game;
  const q = currentTurn().question;
  g.choices = q.wrong.length ? shuffle([q.answer, ...q.wrong]) : null;
  g.mode = 'open';  // open → (choices | revealed)
  g.picked = null;
  g.verdict = null; // true, false, or null while undecided
  g.points = 0;
}

function showQuestion() {
  state.screen = 'question';
  startTimer();
  render();
}

function startTimer() {
  stopTimer();
  const seconds = Number(state.settings.seconds) || 0;
  if (!seconds) return;
  state.deadline = Date.now() + seconds * 1000;
  state.timer = setInterval(tick, 250);
}
function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}
function secondsLeft() {
  return Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
}
function tick() {
  const el = document.getElementById('timer');
  const left = secondsLeft();
  if (el) {
    el.textContent = left;
    el.classList.toggle('low', left <= 5);
  }
  if (left <= 0) {
    stopTimer();
    timeUp();
  }
}

function timeUp() {
  const g = state.game;
  if (g.verdict !== null) return;
  if (g.mode === 'choices') settle(false, 0);
  else { g.mode = 'revealed'; persist(); render(); } // someone still judges the spoken answer
}

function settle(right, points) {
  const g = state.game;
  const p = currentTurn().player;
  stopTimer();
  g.verdict = right;
  g.points = right ? points : 0;
  g.scores[p] += g.points;
  if (right) g.correct[p] += 1;
  persist();
  render();
}

function showChoices() {
  state.game.mode = 'choices';
  persist();
  render();
}

function pick(choice) {
  const g = state.game;
  if (g.verdict !== null) return;
  g.picked = choice;
  settle(choice === currentTurn().question.answer, POINTS_CHOICES);
}

function reveal() {
  stopTimer();
  state.game.mode = 'revealed';
  persist();
  render();
}

function judge(right) {
  if (state.game.verdict !== null) return;
  settle(right, POINTS_STRAIGHT);
}

function nextTurn() {
  const g = state.game;
  g.at += 1;
  if (g.at >= g.turns.length) {
    state.screen = 'scores';
  } else {
    beginTurn();
    state.screen = 'pass';
  }
  persist();
  render();
}

function persist() {
  save(GAME_KEY, state.game);
}

function endGame() {
  stopTimer();
  state.game = null;
  persist();
  state.screen = 'home';
  render();
}

// ---------- Screens ----------

function wordmark() {
  return `<div class="wordmark" role="img" aria-label="Family Quiz">
      <span class="sticker a">FAMILY</span>
      <span class="sticker b">QUIZ!</span>
    </div>`;
}

function roundInProgress() {
  return Boolean(state.game && state.game.at < state.game.turns.length);
}

// The first screen: pick how to play. A round already under way opens straight back up.
function homeScreen() {
  const mode = (action, colour, title, text, disabled = false) => `
    <button class="card mode" data-action="${action}" ${disabled ? 'disabled' : ''}>
      <span class="mode-dot" style="background:${colour}" aria-hidden="true"></span>
      <span><span class="mode-title">${title}</span><br><span class="muted mode-text">${text}</span></span>
    </button>`;
  return `
    ${accountLink()}
    ${wordmark()}
    ${roundInProgress() ? `<button class="btn good" data-action="resume">Carry on this round</button>` : ''}
    <section class="stack" aria-label="How do you want to play?">
      <h2 class="eyebrow" style="font-family:var(--body)">How do you want to play?</h2>
      ${mode('local', 'var(--cyan)', 'One phone', 'Pass the phone round the table. No sign-in needed.')}
      ${sb ? mode('hostSetup', 'var(--orange)', 'Everyone on their own phone', 'You run the quiz, everyone joins with a code.') : ''}
      ${sb ? mode('joinMp', 'var(--lime)', 'Join a game', 'Got a game code? Type it in.') : ''}
    </section>
    ${sourceNotice()}
  `;
}

// Setting up a one-phone round: topic, difficulty and who's playing.
function localScreen() {
  const { players } = state.settings;
  const counts = players.map((p) => poolForPlayer(p).length);
  const canStart = !state.loading && counts.some((c) => c > 0);

  return `
    <div class="topbar"><h1 style="font-size:36px">One phone</h1><button class="link-btn" data-action="cancel">Back</button></div>
    ${roundSetup()}
    <section class="stack" aria-labelledby="players-h">
      <div class="row" style="justify-content:space-between">
        <h2 id="players-h" class="eyebrow" style="font-family:var(--body)">Who's in?</h2>
        <button class="link-btn" data-action="settings">Edit players</button>
      </div>
      ${players.map((p, i) => `
        <div class="card row">
          ${badge(i)}
          <div class="player-main">
            <div class="player-name">${esc(p.name)}</div>
            <div class="muted player-age">${esc(ageLabel(p.age))}</div>
          </div>
          <select class="level-select" data-change="level" data-player="${i}" aria-label="${esc(p.name)}'s level">
            <option value="">Game level</option>
            ${DIFFICULTIES.map((d) => `<option value="${d.id}" ${d.id === p.difficulty ? 'selected' : ''}>${d.label.split(' ')[0]}</option>`).join('')}
          </select>
        </div>
        ${state.bank && !state.loading && counts[i] < state.settings.perPlayer
          ? `<p class="muted" style="font-size:14px;margin-top:-4px">${counts[i] ? `Only ${counts[i]} questions` : 'No questions'} for ${esc(ageLabel(p.age).toLowerCase())} with this topic and difficulty.</p>` : ''}
      `).join('')}
    </section>
    <div class="spacer"></div>
    <button class="btn" data-action="start" ${canStart ? '' : 'disabled'}>${state.loading ? 'Loading…' : "Let's go"}</button>
  `;
}

function roundSetup() {
  const topics = state.bank ? topicsIn(state.bank.questions) : [];
  return `
    <div class="setup">
      <div class="stack" style="gap:6px">
        <label for="topic">Topic</label>
        <select id="topic" data-change="topic">
          <option value="">Mixed topics</option>
          ${topics.map((t) => `<option value="${esc(t)}" ${t === state.settings.topic ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>
      </div>
      <div class="stack" style="gap:6px">
        <label for="difficulty">Difficulty</label>
        <select id="difficulty" data-change="difficulty">
          ${DIFFICULTIES.map((d) => `<option value="${d.id}" ${d.id === difficulty().id ? 'selected' : ''}>${d.label}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

// Setting up a game on everyone's phones. Players join in the lobby, so there's no player list here.
function hostSetupScreen() {
  const s = state.settings;
  if (!isFullAccount()) {
    return `
      <div class="topbar"><h1 style="font-size:36px">Everyone's phones</h1><button class="link-btn" data-action="cancel">Back</button></div>
      <p>To run a quiz on everyone's phones, sign in first. It keeps the game and scores together.</p>
      <p class="muted">Players joining with a code don't need to sign in.</p>
      <div class="spacer"></div>
      <button class="btn" data-action="account">Sign in or create an account</button>`;
  }
  return `
    <div class="topbar"><h1 style="font-size:36px">Everyone's phones</h1><button class="link-btn" data-action="cancel">Back</button></div>
    <p class="muted" style="margin-top:-8px">Pick the questions, then everyone joins with a code. Each player gets questions for their own age.</p>
    ${roundSetup()}
    <form id="hostSetup" class="stack" style="gap:18px">
      <div class="stack" style="gap:6px">
        <label for="host-perPlayer">Questions per player</label>
        <input id="host-perPlayer" name="perPlayer" type="number" min="1" max="50" step="1" value="${esc(s.perPlayer)}">
      </div>
      <div class="stack" style="gap:6px">
        <label for="host-seconds">Seconds per question (0 for no timer)</label>
        <input id="host-seconds" name="seconds" type="number" min="0" max="120" step="1" value="${esc(s.seconds)}">
      </div>
      ${SONG_CLIPS_ALLOWED ? `<label class="check-row"><input type="checkbox" name="songClips" ${s.songClips !== false ? 'checked' : ''}>
        <span>Song clips<br><span class="muted" style="font-size:14px;font-weight:600">Name-that-song rounds, played on your phone</span></span></label>` : ''}
      ${mpNotes()}
      <div class="spacer"></div>
      <button class="btn" type="submit" ${mp.busy ? 'disabled' : ''}>${mp.busy ? 'Setting up…' : 'Create game'}</button>
    </form>`;
}

function sourceNotice() {
  const b = state.bank;
  if (!b || state.loading || b.source === 'sheet') return '';
  if (b.source === 'cache') return `<p class="notice">Using the last copy of your sheet. ${esc(b.error)}</p>`;
  if (b.error) return `<p class="notice">${esc(b.error)} Playing with the built-in questions for now.</p>`;
  return '';
}

function passScreen() {
  const turn = currentTurn();
  const p = state.settings.players[turn.player];
  return `
    <div class="topbar">
      <span class="eyebrow">${esc(state.game.topic)}</span>
      <button class="link-btn" data-action="quit">End round</button>
    </div>
    <div class="pass">
      ${badge(turn.player)}
      <p class="eyebrow">Pass the phone to</p>
      <h1>${esc(p.name)}</h1>
      <p style="font-weight:700">Question ${turn.n} of ${turn.of} · ${esc(ageLabel(p.age))}${p.difficulty ? ` · ${esc(difficultyFor(p).label)}` : ''}</p>
    </div>
    <button class="btn" data-action="ready">I'm ready</button>
  `;
}

function gradeDots(grade) {
  return `<span class="grade" aria-label="Grade ${grade} of 5">${[1, 2, 3, 4, 5].map((n) => `<i class="${n <= grade ? 'on' : ''}"></i>`).join('')}</span>`;
}

function questionScreen() {
  const g = state.game;
  const turn = currentTurn();
  const q = turn.question;
  const p = state.settings.players[turn.player];
  const seconds = Number(state.settings.seconds) || 0;
  const done = g.verdict !== null;
  const timerOn = seconds && !done && g.mode !== 'revealed';
  const left = state.timer ? secondsLeft() : seconds;
  const isLast = g.at === g.turns.length - 1;
  const next = isLast ? 'See scores' : `Pass to ${esc(state.settings.players[g.turns[g.at + 1].player].name)}`;

  let body = '';
  if (g.mode === 'choices') {
    body = `<div class="choices" role="group" aria-label="Answers">
      ${g.choices.map((c) => {
        let cls = '';
        if (done) cls = c === q.answer ? 'correct' : (c === g.picked ? 'wrong' : '');
        return `<button class="choice ${cls}" data-action="pick" data-value="${esc(c)}" ${done ? 'disabled' : ''}>${esc(c)}</button>`;
      }).join('')}
    </div>`;
  } else if (g.mode === 'revealed') {
    body = `<div class="card stack" style="gap:4px"><span class="eyebrow">Answer</span><span class="answer-reveal">${esc(q.answer)}</span></div>`;
  } else {
    body = `<p class="muted" style="font-weight:700">Say your answer out loud for ${POINTS_STRAIGHT} points.${g.choices ? ` Stuck? Show the choices for ${POINTS_CHOICES} point.` : ''}</p>`;
  }

  let footer;
  if (done) {
    const msg = g.verdict ? `Correct! +${g.points}` : (g.mode === 'choices' && !g.picked ? "Time's up" : 'Not this time');
    footer = `
      <p class="sticker" style="align-self:flex-start;background:${g.verdict ? 'var(--lime)' : 'var(--wrong)'};font-size:26px;transform:rotate(-2deg)">${msg}</p>
      <button class="btn" data-action="next">${next}</button>`;
  } else if (g.mode === 'revealed') {
    footer = judgeButtons(p.name, 'right', 'wrong');
  } else if (g.mode === 'open') {
    footer = `
      ${g.choices ? `<button class="btn secondary" data-action="choices">Show choices (${POINTS_CHOICES} point)</button>` : ''}
      <button class="btn" data-action="reveal">Show answer</button>`;
  } else {
    footer = '';
  }

  return `
    <div class="topbar">
      <span class="chip" style="background:${COLOURS[turn.player % 4]}">${esc(p.name)} · ${esc(ageLabel(p.age))}</span>
      ${timerOn ? `<div id="timer" class="timer ${left <= 5 ? 'low' : ''}" role="timer" aria-label="Seconds left">${left}</div>` : ''}
    </div>
    <div class="row" style="justify-content:space-between">
      <p style="font-family:var(--display);font-size:22px">Q${turn.n} <span class="muted" style="font-family:var(--body);font-weight:700;font-size:16px">of ${turn.of} · ${esc(q.topic)}</span></p>
      ${gradeDots(q.grade)}
    </div>
    <h1 class="question">${esc(q.question)}</h1>
    ${body}
    <div class="spacer"></div>
    ${footer}
  `;
}

// Big, unmistakable Correct / Wrong buttons for judging a spoken answer.
function judgeButtons(name, yesAction, noAction, disabled = false) {
  return `
    <p class="judge-q">Did ${esc(name)} get it right?</p>
    <div class="judge">
      <button class="judge-btn yes" data-action="${yesAction}" ${disabled ? 'disabled' : ''}>
        <span class="judge-icon" aria-hidden="true">✓</span>Correct<small>+${POINTS_STRAIGHT} points</small>
      </button>
      <button class="judge-btn no" data-action="${noAction}" ${disabled ? 'disabled' : ''}>
        <span class="judge-icon" aria-hidden="true">✗</span>Wrong<small>no points</small>
      </button>
    </div>`;
}

function scoresScreen() {
  const g = state.game;
  const { players } = state.settings;
  const totals = players.map((p, i) => ({
    i, p, score: g.scores[i], correct: g.correct[i],
    of: g.turns.filter((t) => t.player === i).length,
  })).filter((r) => r.of > 0).sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = null;
  totals.forEach((r, n) => { if (r.score !== prev) { rank = n + 1; prev = r.score; } r.rank = rank; });

  return `
    <div class="stack" style="align-items:flex-start;gap:8px">
      <span class="eyebrow">${esc(g.topic)} · ${esc(g.difficulty)}</span>
      <h1 class="sticker" style="background:var(--cyan);font-size:36px;transform:rotate(-2deg)">LEADERBOARD</h1>
    </div>
    <ol class="stack" style="list-style:none;margin:6px 0 0;padding:0">
      ${totals.map((r) => `
        <li class="card leader ${r.rank === 1 ? 'first' : ''}">
          <span class="rank">${r.rank}</span>
          ${badge(r.i)}
          <span class="player-name">${esc(r.p.name)}<br><span class="muted" style="font-size:13px;font-weight:700">${r.correct} of ${r.of} right</span></span>
          <span class="score">${r.score}<span class="muted" style="font-family:var(--body);font-size:14px;font-weight:700"> pts</span></span>
        </li>`).join('')}
    </ol>
    <p class="muted" style="font-size:14px">${POINTS_STRAIGHT} points for a straight answer, ${POINTS_CHOICES} for an answer from the choices.</p>
    <div class="spacer"></div>
    <button class="btn" data-action="done">Back to start</button>
  `;
}

function settingsScreen() {
  const s = state.settings;
  const ageOptions = (age) => AGES.map((a) => `<option value="${a}" ${a === age ? 'selected' : ''}>${ageLabel(a)}</option>`).join('');
  return `
    <h1 style="font-size:36px">Settings</h1>
    <form id="settings" class="stack" style="gap:18px">
      <fieldset class="stack" style="border:none;padding:0;margin:0">
        <legend class="eyebrow" style="margin-bottom:10px">Players</legend>
        ${s.players.map((p, i) => `
          <div class="player-edit">
            ${badge(i)}
            <input id="name-${i}" name="name-${i}" value="${esc(p.name)}" aria-label="Player ${i + 1} name" maxlength="20" required>
            <select id="age-${i}" name="age-${i}" aria-label="Player ${i + 1} age">${ageOptions(p.age)}</select>
          </div>`).join('')}
      </fieldset>
      <div class="stack" style="gap:6px">
        <label for="perPlayer">Questions per player each round</label>
        <input id="perPlayer" name="perPlayer" type="number" min="1" max="50" step="1" value="${esc(s.perPlayer)}">
      </div>
      <div class="stack" style="gap:6px">
        <label for="seconds">Seconds per question (0 for no timer)</label>
        <input id="seconds" name="seconds" type="number" min="0" max="120" step="1" value="${esc(s.seconds)}">
      </div>
      <div class="stack" style="gap:6px">
        <label for="sheetUrl">Google Sheet link</label>
        <input id="sheetUrl" name="sheetUrl" type="url" inputmode="url" placeholder="Using the family sheet" value="${esc(s.sheetUrl)}">
        <p class="muted" style="font-size:14px">Leave empty to use the family question sheet.</p>
      </div>
      <button class="btn" type="submit">Save</button>
      <button class="btn secondary" type="button" data-action="forget">Forget questions already asked</button>
      <button class="btn secondary" type="button" data-action="toLocal">Cancel</button>
    </form>
  `;
}

// ---------- Account ----------

function accountLink() {
  if (!sb) return '';
  const label = auth.user && !auth.user.is_anonymous
    ? esc((auth.profile && auth.profile.display_name) || 'My account')
    : 'Sign in';
  return `<div class="topbar" style="justify-content:flex-end;margin-bottom:-12px">
    <button class="link-btn" data-action="account">${label}</button>
  </div>`;
}

function authNotes() {
  return `${auth.message ? `<p class="notice">${esc(auth.message)}</p>` : ''}
    ${auth.error ? `<p class="notice error" role="alert">${esc(auth.error)}</p>` : ''}`;
}

function ageSelect(id, age) {
  return `<select id="${id}" name="age" aria-label="Age">${AGES.map((a) => `<option value="${a}" ${a === age ? 'selected' : ''}>${ageLabel(a)}</option>`).join('')}</select>`;
}

function signedOutScreen() {
  const m = auth.mode;
  const title = { signin: 'Sign in', signup: 'Create account', reset: 'Forgot password' }[m];
  return `
    <div class="topbar"><h1 style="font-size:36px">${title}</h1><button class="link-btn" data-action="cancel">Back</button></div>
    <p class="muted">An account lets you set up games on everyone's phones and keep scores. You don't need one to play pass-the-phone.</p>
    ${authNotes()}
    <form id="auth" class="stack" style="gap:14px">
      ${m === 'signup' ? `<div class="stack" style="gap:6px"><label for="auth-name">Your name</label>
        <input id="auth-name" name="name" value="${esc(auth.form.name)}" maxlength="30" autocomplete="name" required></div>` : ''}
      <div class="stack" style="gap:6px"><label for="auth-email">Email</label>
        <input id="auth-email" name="email" type="email" inputmode="email" autocomplete="email" value="${esc(auth.form.email)}" required></div>
      ${m !== 'reset' ? `<div class="stack" style="gap:6px"><label for="auth-password">Password</label>
        <input id="auth-password" name="password" type="password" minlength="6"
          autocomplete="${m === 'signup' ? 'new-password' : 'current-password'}" required></div>` : ''}
      ${m === 'signup' ? `<div class="stack" style="gap:6px"><label for="auth-password2">Type the password again</label>
        <input id="auth-password2" name="password2" type="password" minlength="6" autocomplete="new-password" required></div>` : ''}
      <button class="btn" type="submit" ${auth.busy ? 'disabled' : ''}>${auth.busy ? 'One moment…' : { signin: 'Sign in', signup: 'Create account', reset: 'Send reset link' }[m]}</button>
    </form>
    <div class="stack" style="gap:8px;align-items:center">
      ${m !== 'signup' ? '<button class="link-btn" data-action="authMode" data-mode="signup">New here? Create an account</button>' : ''}
      ${m !== 'signin' ? '<button class="link-btn" data-action="authMode" data-mode="signin">Already have an account? Sign in</button>' : ''}
      ${m === 'signin' ? '<button class="link-btn" data-action="authMode" data-mode="reset">Forgot your password?</button>' : ''}
    </div>
  `;
}

function accountScreen() {
  if (!auth.user || auth.user.is_anonymous) return signedOutScreen();
  const p = auth.profile;
  return `
    <div class="topbar"><h1 style="font-size:36px">My account</h1><button class="link-btn" data-action="cancel">Back</button></div>
    <p class="muted" style="margin-top:-12px">${esc(auth.user.email || '')}</p>
    ${authNotes()}
    ${p ? `<form id="profile" class="stack" style="gap:6px">
      <label for="profile-name">Your name</label>
      <div class="field-row">
        <input id="profile-name" name="name" value="${esc(p.display_name)}" maxlength="30" required>
        ${ageSelect('profile-age', p.age)}
      </div>
      <button class="btn secondary" type="submit" ${auth.busy ? 'disabled' : ''}>Save</button>
    </form>` : ''}
    <section class="stack" aria-labelledby="kids-h">
      <h2 id="kids-h" class="eyebrow" style="font-family:var(--body)">Kids' profiles</h2>
      <p class="muted" style="font-size:15px">Kids don't need an email. On their own device they type the game code, tap their name, and you approve them.</p>
      ${auth.kids.map((k) => `
        <div class="card row">
          <div class="player-main">
            <div class="player-name">${esc(k.display_name)}</div>
            <div class="muted player-age">${esc(ageLabel(k.age))}</div>
          </div>
          <button class="link-btn" data-action="removeKid" data-id="${esc(k.id)}" ${auth.busy ? 'disabled' : ''}>Remove</button>
        </div>`).join('')}
      <form id="kid" class="field-row">
        <input id="kid-name" name="name" placeholder="Child's name" maxlength="30" aria-label="Child's name" required>
        ${ageSelect('kid-age', '10')}
        <button class="btn secondary" type="submit" style="width:auto;padding:0 16px" ${auth.busy ? 'disabled' : ''}>Add</button>
      </form>
    </section>
    <div class="spacer"></div>
    <button class="btn secondary" data-action="signOut" ${auth.busy ? 'disabled' : ''}>Sign out</button>
    ${auth.confirmDelete ? `
      <div class="card stack">
        <p style="font-weight:700">Delete your account, your kids' profiles and your games? This can't be undone.</p>
        <div class="row">
          <button class="btn bad" data-action="deleteYes" ${auth.busy ? 'disabled' : ''}>Delete</button>
          <button class="btn secondary" data-action="deleteNo">Keep it</button>
        </div>
      </div>` : '<button class="link-btn" data-action="deleteAsk" style="align-self:center">Delete my account</button>'}
  `;
}

function newPasswordScreen() {
  return `
    <h1 style="font-size:36px">New password</h1>
    ${authNotes()}
    <form id="newPassword" class="stack" style="gap:14px">
      <div class="stack" style="gap:6px"><label for="new-password">Choose a new password</label>
        <input id="new-password" name="password" type="password" minlength="6" autocomplete="new-password" required></div>
      <button class="btn" type="submit" ${auth.busy ? 'disabled' : ''}>Save password</button>
    </form>
  `;
}

function render() {
  const screens = {
    home: homeScreen, settings: settingsScreen, pass: passScreen, question: questionScreen, scores: scoresScreen,
    local: localScreen, hostSetup: hostSetupScreen,
    account: accountScreen, newPassword: newPasswordScreen,
    join: joinScreen, waiting: waitingScreen, mp: mpScreen,
  };
  app.innerHTML = screens[state.screen]();
}

// ---------- Events ----------

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const actions = {
    settings: () => { state.screen = 'settings'; render(); },
    cancel: () => { state.screen = 'home'; render(); },
    account: () => { auth.message = ''; auth.error = ''; state.screen = 'account'; render(); },
    authMode: () => { auth.mode = el.dataset.mode; auth.message = ''; auth.error = ''; render(); },
    signOut,
    removeKid: () => { if (confirm('Remove this child\'s profile?')) removeKid(el.dataset.id); },
    deleteAsk: () => { auth.confirmDelete = true; render(); },
    deleteNo: () => { auth.confirmDelete = false; render(); },
    deleteYes: deleteAccount,
    local: () => { state.screen = 'local'; render(); },
    hostSetup: () => { mp.error = ''; state.screen = 'hostSetup'; render(); },
    toLocal: () => { state.screen = 'local'; render(); },
    joinMp: openJoin,
    joinAs: () => joinAs(el.dataset.id),
    leaveMp: leaveGame,
    addHere: () => addFromThisPhone(el.dataset.id),
    approve: () => decideRequest(el.dataset.id, true),
    decline: () => decideRequest(el.dataset.id, false),
    startMp: startMpGame,
    markRight: () => hostMark(true),
    markWrong: () => hostMark(false),
    choicesMp: showChoicesMp,
    pickMp: () => pickMp(el.dataset.value),
    nextMp,
    revealMp,
    kick: () => kick(el.dataset.zone),
    skipBonus,
    humGuess: () => humGuess(el.dataset.id),
    playClip,
    endMp,
    changeMark: () => changeMark(Boolean(el.dataset.right)),
    shoot,
    startMoles,
    whack: () => whack(el.dataset.cell),
    spinWheel,
    openChallenge: () => openChallenge(el.dataset.id),
    pickOpponent: () => pickOpponent(el.dataset.id),
    issueChallenge: () => issueChallenge(el.dataset.mode),
    buzz: () => buzz(el.dataset.id, el.dataset.value),
    acceptChallenge: () => answerChallenge(true),
    refuseChallenge: () => answerChallenge(false),
    cancelChallenge,
    shareWatch: () => shareWatch(el.dataset.url, el),
    forget: () => { save(SEEN_KEY, null); el.textContent = 'Done: everyone starts fresh'; el.disabled = true; },
    start: startRound,
    resume: () => { state.screen = state.game.mode === 'open' && state.game.verdict === null ? 'pass' : 'question'; render(); },
    ready: showQuestion,
    choices: showChoices,
    pick: () => pick(el.dataset.value),
    reveal,
    right: () => judge(true),
    wrong: () => judge(false),
    next: nextTurn,
    quit: endGame,
    done: endGame,
  };
  actions[el.dataset.action]?.();
});

app.addEventListener('change', (e) => {
  const field = e.target.dataset.change;
  if (field === 'topic' || field === 'difficulty') {
    state.settings[field] = e.target.value;
  } else if (field === 'level') {
    state.settings.players[Number(e.target.dataset.player)].difficulty = e.target.value;
  } else {
    return;
  }
  save(SETTINGS_KEY, state.settings);
  render();
});

const forms = {
  auth: (f) => {
    const email = String(f.get('email') || '').trim();
    const password = String(f.get('password') || '');
    auth.form = { name: String(f.get('name') || '').trim(), email };
    if (auth.mode === 'signup') {
      if (password !== String(f.get('password2') || '')) {
        auth.error = 'The two passwords don\'t match. Try again.';
        auth.message = '';
        render();
        return null;
      }
      return signUp(auth.form.name, email, password);
    }
    if (auth.mode === 'reset') return sendReset(email);
    return signIn(email, password);
  },
  profile: (f) => saveProfile(String(f.get('name') || '').trim(), String(f.get('age'))),
  kid: (f) => addKid(String(f.get('name') || '').trim(), String(f.get('age'))),
  newPassword: (f) => setNewPassword(String(f.get('password') || '')),
  settings: saveSettings,
  join: (f) => findGame(String(f.get('code') || '')),
  hostSetup: (f) => {
    const s = state.settings;
    s.perPlayer = Math.max(1, Math.min(50, Number(f.get('perPlayer')) || 10));
    s.seconds = Math.max(0, Math.min(120, Number(f.get('seconds')) || 0));
    s.songClips = SONG_CLIPS_ALLOWED && f.get('songClips') === 'on';
    save(SETTINGS_KEY, s);
    hostGame();
  },
};

app.addEventListener('submit', (e) => {
  e.preventDefault();
  forms[e.target.id]?.(new FormData(e.target));
});

function saveSettings(f) {
  const s = state.settings;
  const oldUrl = s.sheetUrl;
  s.players = s.players.map((p, i) => ({
    name: String(f.get(`name-${i}`) || '').trim() || `Player ${i + 1}`,
    age: String(f.get(`age-${i}`) || p.age),
    difficulty: p.difficulty || '',
  }));
  s.perPlayer = Math.max(1, Math.min(50, Number(f.get('perPlayer')) || 10));
  s.seconds = Math.max(0, Math.min(120, Number(f.get('seconds')) || 0));
  s.sheetUrl = String(f.get('sheetUrl') || '').trim();
  save(SETTINGS_KEY, s);
  state.screen = 'local';
  if (s.sheetUrl !== oldUrl) refreshQuestions();
  else render();
}

render();
refreshQuestions();
startAuth();
resumeMp();
