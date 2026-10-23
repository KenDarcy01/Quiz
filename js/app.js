// Family Quiz: a pass-the-phone quiz where each player gets questions for their age group.

const SETTINGS_KEY = 'fq.settings.v1';
const GAME_KEY = 'fq.game.v1';
const COLOURS = ['var(--cyan)', 'var(--pink)', 'var(--lime)', 'var(--orange)'];
const AGE_LABELS = { 10: 'Age 10', 13: 'Age 13', 14: 'Age 14', adult: 'Adult' };

const DEFAULT_SETTINGS = {
  quizMaster: 'Ken',
  sheetUrl: '',
  seconds: 20,
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
  settings: load(SETTINGS_KEY) || structuredClone(DEFAULT_SETTINGS),
  bank: null,          // { questions, source, error }
  loading: true,
  round: null,
  game: load(GAME_KEY), // { round, turns: [{ player, question }], at, scores, choices, picked, revealed, verdict }
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

function badge(pi, extra = '') {
  return `<div class="badge tilt-${pi % 4} ${extra}" style="background:${COLOURS[pi % 4]}" aria-hidden="true">${pi + 1}</div>`;
}

// ---------- Data ----------

async function refreshQuestions() {
  state.loading = true;
  render();
  try {
    state.bank = await loadQuestions(state.settings.sheetUrl);
  } catch (e) {
    state.bank = { questions: [], source: 'none', error: e.message || String(e) };
  }
  const rounds = roundsIn(state.bank.questions);
  if (!rounds.includes(state.round)) state.round = rounds[0] || null;
  state.loading = false;
  render();
}

// ---------- Game flow ----------

function startRound() {
  const { players } = state.settings;
  const sets = players.map((p) => questionsFor(state.bank.questions, state.round, p.age));
  const longest = Math.max(0, ...sets.map((s) => s.length));
  const turns = [];
  // Interleave: everyone answers question 1, then everyone answers question 2, and so on.
  for (let qi = 0; qi < longest; qi++) {
    sets.forEach((set, pi) => { if (set[qi]) turns.push({ player: pi, question: set[qi], of: set.length }); });
  }
  if (!turns.length) return;
  state.game = { round: state.round, turns, at: 0, scores: players.map(() => 0) };
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
  g.picked = null;
  g.revealed = false;
  g.verdict = null; // true, false, or null while undecided
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
  if (g.verdict !== null || g.revealed) return;
  g.revealed = true;
  if (g.choices) g.verdict = false; // multiple choice: no answer counts as wrong
  persist();
  render();
}

function pick(choice) {
  const g = state.game;
  if (g.verdict !== null) return;
  stopTimer();
  g.picked = choice;
  g.revealed = true;
  g.verdict = choice === currentTurn().question.answer;
  if (g.verdict) g.scores[currentTurn().player] += 1;
  persist();
  render();
}

function reveal() {
  stopTimer();
  state.game.revealed = true;
  persist();
  render();
}

function judge(right) {
  const g = state.game;
  if (g.verdict !== null) return;
  g.verdict = right;
  if (right) g.scores[currentTurn().player] += 1;
  persist();
  render();
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

function homeScreen() {
  const { players, quizMaster } = state.settings;
  const rounds = state.bank ? roundsIn(state.bank.questions) : [];
  const counts = state.bank && state.round
    ? players.map((p) => questionsFor(state.bank.questions, state.round, p.age).length)
    : players.map(() => 0);
  const canStart = !state.loading && counts.some((c) => c > 0);
  const resume = state.game && state.game.at < state.game.turns.length;

  return `
    <div class="wordmark" role="img" aria-label="Family Quiz">
      <span class="sticker a">FAMILY</span>
      <span class="sticker b">QUIZ!</span>
    </div>
    ${roundPicker(rounds)}
    <section class="stack" aria-labelledby="players-h">
      <div class="row" style="justify-content:space-between">
        <h2 id="players-h" class="eyebrow" style="font-family:var(--body)">Who's in?</h2>
        <button class="link-btn" data-action="settings">Edit players</button>
      </div>
      ${players.map((p, i) => `
        <div class="card row">
          ${badge(i)}
          <div class="player-name">${esc(p.name)}</div>
          <div class="age-pill">${esc(AGE_LABELS[p.age] || p.age)}</div>
        </div>
        ${state.bank && !state.loading && !counts[i] ? `<p class="muted" style="font-size:14px;margin-top:-4px">No ${esc(AGE_LABELS[p.age] || p.age)} questions in this round.</p>` : ''}
      `).join('')}
    </section>
    ${sourceNotice()}
    <div class="spacer"></div>
    ${resume ? `<button class="btn good" data-action="resume">Carry on round ${esc(state.game.round)}</button>` : ''}
    <button class="btn" data-action="start" ${canStart ? '' : 'disabled'}>${state.loading ? 'Loading…' : "Let's go"}</button>
    <p class="muted" style="text-align:center;font-size:14px;font-weight:700">Quiz master: ${esc(quizMaster)}</p>
  `;
}

function roundPicker(rounds) {
  if (rounds.length <= 1) {
    return `<p style="font-weight:700">${rounds.length ? `Round ${esc(rounds[0])}` : 'No rounds yet'} · General knowledge</p>`;
  }
  return `
    <div class="stack" style="gap:6px">
      <label for="round">Round</label>
      <select id="round" data-change="round">
        ${rounds.map((r) => `<option value="${esc(r)}" ${r === state.round ? 'selected' : ''}>Round ${esc(r)}</option>`).join('')}
      </select>
    </div>`;
}

function sourceNotice() {
  const b = state.bank;
  if (!b || state.loading) return '';
  if (b.source === 'sheet') return '';
  if (b.source === 'cache') return `<p class="notice">Using the last copy of your sheet. ${esc(b.error)}</p>`;
  if (b.error) return `<p class="notice">${esc(b.error)} Playing the sample round instead.</p>`;
  return `<p class="notice">Playing the built-in sample round. Add your Google Sheet in <b>Edit players</b> to use your own questions.</p>`;
}

function passScreen() {
  const g = state.game;
  const turn = currentTurn();
  const p = state.settings.players[turn.player];
  const qNumber = turn.question.number;
  return `
    <div class="topbar">
      <span class="eyebrow">Round ${esc(g.round)}</span>
      <button class="link-btn" data-action="quit">End round</button>
    </div>
    <div class="pass">
      ${badge(turn.player)}
      <p class="eyebrow">Pass the phone to</p>
      <h1>${esc(p.name)}</h1>
      <p style="font-weight:700">Question ${qNumber} of ${turn.of} · ${esc(AGE_LABELS[p.age] || p.age)}</p>
    </div>
    <button class="btn" data-action="ready">I'm ready</button>
  `;
}

function questionScreen() {
  const g = state.game;
  const turn = currentTurn();
  const q = turn.question;
  const p = state.settings.players[turn.player];
  const seconds = Number(state.settings.seconds) || 0;
  const left = state.timer ? secondsLeft() : (g.revealed ? 0 : seconds);
  const isLast = g.at === g.turns.length - 1;
  const next = isLast ? 'See scores' : `Pass to ${esc(state.settings.players[g.turns[g.at + 1].player].name)}`;

  let body;
  if (g.choices) {
    body = `<div class="choices" role="group" aria-label="Answers">
      ${g.choices.map((c) => {
        let cls = '';
        if (g.revealed) cls = c === q.answer ? 'correct' : (c === g.picked ? 'wrong' : '');
        return `<button class="choice ${cls}" data-action="pick" data-value="${esc(c)}" ${g.revealed ? 'disabled' : ''}>${esc(c)}</button>`;
      }).join('')}
    </div>`;
  } else if (!g.revealed) {
    body = `<p class="muted" style="font-weight:700">Say your answer out loud, then ${esc(state.settings.quizMaster)} shows the answer.</p>`;
  } else {
    body = `<div class="card stack" style="gap:4px"><span class="eyebrow">Answer</span><span class="answer-reveal">${esc(q.answer)}</span></div>`;
  }

  let footer;
  if (g.verdict !== null) {
    footer = `
      <p class="sticker" style="align-self:flex-start;background:${g.verdict ? 'var(--lime)' : 'var(--wrong)'};font-size:26px;transform:rotate(-2deg)">
        ${g.verdict ? 'Correct!' : (g.choices && !g.picked ? "Time's up" : 'Not this time')}
      </p>
      <button class="btn" data-action="next">${next}</button>`;
  } else if (!g.choices && g.revealed) {
    footer = `<div class="row">
      <button class="btn good" data-action="right">Right</button>
      <button class="btn bad" data-action="wrong">Wrong</button>
    </div>`;
  } else if (!g.choices) {
    footer = `<button class="btn" data-action="reveal">Show answer</button>`;
  } else {
    footer = '';
  }

  return `
    <div class="topbar">
      <span class="chip" style="background:${COLOURS[turn.player % 4]}">${esc(p.name)} · ${esc(AGE_LABELS[p.age] || p.age)}</span>
      ${seconds && !g.revealed ? `<div id="timer" class="timer ${left <= 5 ? 'low' : ''}" role="timer" aria-label="Seconds left">${left}</div>` : ''}
    </div>
    <p style="font-family:var(--display);font-size:22px">Q${q.number} <span class="muted" style="font-family:var(--body);font-weight:700;font-size:16px">of ${turn.of}</span></p>
    <h1 class="question">${esc(q.question)}</h1>
    ${body}
    <div class="spacer"></div>
    ${footer}
  `;
}

function scoresScreen() {
  const g = state.game;
  const { players } = state.settings;
  const totals = players.map((p, i) => ({
    i, p, score: g.scores[i],
    of: g.turns.filter((t) => t.player === i).length,
  })).filter((r) => r.of > 0).sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = null;
  totals.forEach((r, n) => { if (r.score !== prev) { rank = n + 1; prev = r.score; } r.rank = rank; });

  return `
    <div class="stack" style="align-items:flex-start;gap:8px">
      <span class="eyebrow">After round ${esc(g.round)}</span>
      <h1 class="sticker" style="background:var(--cyan);font-size:36px;transform:rotate(-2deg)">LEADERBOARD</h1>
    </div>
    <ol class="stack" style="list-style:none;margin:6px 0 0;padding:0">
      ${totals.map((r) => `
        <li class="card leader ${r.rank === 1 ? 'first' : ''}">
          <span class="rank">${r.rank}</span>
          ${badge(r.i)}
          <span class="player-name">${esc(r.p.name)}</span>
          <span class="score">${r.score}<span class="muted" style="font-family:var(--body);font-size:15px;font-weight:700">/${r.of}</span></span>
        </li>`).join('')}
    </ol>
    <div class="spacer"></div>
    <button class="btn" data-action="done">Back to start</button>
  `;
}

function settingsScreen() {
  const s = state.settings;
  const ageOptions = (age) => Object.entries(AGE_LABELS)
    .map(([v, l]) => `<option value="${v}" ${v === age ? 'selected' : ''}>${l}</option>`).join('');
  return `
    <h1 style="font-size:36px">Settings</h1>
    <form id="settings" class="stack" style="gap:18px">
      <fieldset class="stack" style="border:none;padding:0;margin:0">
        <legend class="eyebrow" style="margin-bottom:10px">Players</legend>
        ${s.players.map((p, i) => `
          <div class="player-edit">
            ${badge(i)}
            <input id="name-${i}" name="name-${i}" value="${esc(p.name)}" aria-label="Player ${i + 1} name" maxlength="20" required>
            <select id="age-${i}" name="age-${i}" aria-label="Player ${i + 1} age group">${ageOptions(p.age)}</select>
          </div>`).join('')}
      </fieldset>
      <div class="stack" style="gap:6px">
        <label for="quizMaster">Quiz master</label>
        <input id="quizMaster" name="quizMaster" value="${esc(s.quizMaster)}" maxlength="20">
      </div>
      <div class="stack" style="gap:6px">
        <label for="seconds">Seconds per question (0 for no timer)</label>
        <input id="seconds" name="seconds" type="number" min="0" max="120" step="1" value="${esc(s.seconds)}">
      </div>
      <div class="stack" style="gap:6px">
        <label for="sheetUrl">Google Sheet link</label>
        <input id="sheetUrl" name="sheetUrl" type="url" inputmode="url" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(s.sheetUrl)}">
        <p class="muted" style="font-size:14px">Share the sheet as "Anyone with the link can view". Leave empty to play the sample round.</p>
      </div>
      <button class="btn" type="submit">Save</button>
      <button class="btn secondary" type="button" data-action="cancel">Cancel</button>
    </form>
  `;
}

function render() {
  const screens = { home: homeScreen, settings: settingsScreen, pass: passScreen, question: questionScreen, scores: scoresScreen };
  app.innerHTML = screens[state.screen]();
}

// ---------- Events ----------

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const actions = {
    settings: () => { state.screen = 'settings'; render(); },
    cancel: () => { state.screen = 'home'; render(); },
    start: startRound,
    resume: () => { state.screen = state.game.verdict === null && !state.game.revealed ? 'pass' : 'question'; render(); },
    ready: showQuestion,
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
  if (e.target.dataset.change === 'round') {
    state.round = e.target.value;
    render();
  }
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const s = state.settings;
  const oldUrl = s.sheetUrl;
  s.players = s.players.map((p, i) => ({
    name: String(f.get(`name-${i}`) || '').trim() || `Player ${i + 1}`,
    age: String(f.get(`age-${i}`) || p.age),
  }));
  s.quizMaster = String(f.get('quizMaster') || '').trim() || 'Quiz master';
  s.seconds = Math.max(0, Math.min(120, Number(f.get('seconds')) || 0));
  s.sheetUrl = String(f.get('sheetUrl') || '').trim();
  save(SETTINGS_KEY, s);
  state.screen = 'home';
  if (s.sheetUrl !== oldUrl) refreshQuestions();
  else render();
});

render();
refreshQuestions();
