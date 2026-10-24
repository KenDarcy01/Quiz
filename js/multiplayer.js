// Multiplayer: the host's phone runs the game, everyone else plays on their own phone.
// Every phone reads the whole game from game_state() whenever the database says something changed.

const MP_KEY = 'fq.mp.v1';
const MP_POLL_MS = 4000; // safety net in case a live update is missed

const mp = {
  gameId: null,    // set from storage by resumeMp()
  game: null,      // the latest game_state()
  code: '',        // join screen: the code typed in
  family: null,    // join screen: names to pick from
  requestId: null, // waiting for a parent or host to approve this device
  busy: false,
  error: '',
  channel: null,
  poll: null,
  timer: null,
};

function mpError(e) {
  const m = (e && e.message) || String(e);
  if (/failed to fetch|network/i.test(m)) return 'No connection. Try again when you have signal.';
  return m;
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

// Runs a step with the busy flag and error handling, then redraws.
async function mpStep(fn) {
  mp.busy = true;
  mp.error = '';
  render();
  try {
    await fn();
  } catch (e) {
    mp.error = mpError(e);
  }
  mp.busy = false;
  render();
}

function isFullAccount() {
  return Boolean(auth.user && !auth.user.is_anonymous);
}

// ---------- Following a game ----------

async function refreshGame() {
  if (!mp.gameId) return;
  try {
    mp.game = await rpc('game_state', { p_game_id: mp.gameId });
    mp.error = '';
  } catch (e) {
    if (/not in this game/i.test(e.message || '')) { leaveGame(); return; }
    mp.error = mpError(e);
  }
  if (state.screen === 'mp') render();
}

let refreshQueued = null;
function queueRefresh() {
  clearTimeout(refreshQueued);
  refreshQueued = setTimeout(refreshGame, 150);
}

function followGame(id) {
  stopFollowing();
  mp.gameId = id;
  save(MP_KEY, id);
  const filter = `game_id=eq.${id}`;
  mp.channel = sb.channel(`game:${id}`);
  ['game_players', 'game_questions', 'answers', 'game_events', 'device_requests', 'challenges', 'challenge_questions'].forEach((table) => {
    mp.channel.on('postgres_changes', { event: '*', schema: 'public', table, filter }, queueRefresh);
  });
  mp.channel.on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${id}` }, queueRefresh);
  mp.channel.subscribe();
  mp.poll = setInterval(refreshGame, MP_POLL_MS);
  mp.timer = setInterval(tickMp, 250);
  state.screen = 'mp';
  return refreshGame();
}

function stopFollowing() {
  if (mp.channel) sb.removeChannel(mp.channel);
  mp.channel = null;
  clearInterval(mp.poll);
  clearInterval(mp.timer);
}

function leaveGame() {
  stopFollowing();
  mp.gameId = null;
  mp.game = null;
  mp.requestId = null;
  save(MP_KEY, null);
  state.screen = 'home';
  render();
}

// ---------- Hosting ----------

function hostGame() {
  if (!isFullAccount()) { auth.message = 'Sign in to host a game.'; state.screen = 'account'; render(); return; }
  mpStep(async () => {
    const s = state.settings;
    const g = await rpc('create_game', {
      p_settings: {
        topic: s.topic || '',
        grades: difficulty().grades,
        per_player: Number(s.perPlayer) || 10,
        seconds: Number(s.seconds) || 0,
      },
    });
    await followGame(g.id);
  });
}

function addFromThisPhone(profileId) {
  mpStep(async () => {
    await rpc('join_game', { p_code: mp.game.code, p_profile_id: profileId });
    await refreshGame();
  });
}

function decideRequest(id, approve) {
  mpStep(async () => {
    await rpc('decide_device', { p_request_id: id, p_approve: approve });
    await refreshGame();
  });
}

function startMpGame() {
  mpStep(async () => {
    await rpc('start_game', { p_game_id: mp.gameId });
    await refreshGame();
  });
}

function hostMark(right) {
  const q = mp.game.question;
  mpStep(async () => {
    await rpc('submit_answer', {
      p_game_question_id: q.id, p_player_id: q.player_id, p_is_correct: right, p_used_choices: false,
    });
    await refreshGame();
  });
}

function revealMp() {
  mpStep(async () => { await rpc('reveal_answer', { p_game_id: mp.gameId }); await refreshGame(); });
}

function nextMp() {
  mpStep(async () => { await rpc('next_question', { p_game_id: mp.gameId }); await refreshGame(); });
}

// ---------- Playing ----------

function showChoicesMp() {
  mpStep(async () => { await rpc('show_choices', { p_game_question_id: mp.game.question.id }); await refreshGame(); });
}

function pickMp(choice) {
  const q = mp.game.question;
  mpStep(async () => {
    await rpc('submit_answer', {
      p_game_question_id: q.id, p_player_id: q.player_id, p_is_correct: false,
      p_used_choices: true, p_response: choice,
    });
    await refreshGame();
  });
}

// ---------- Streak bonus mini-games ----------
// Each game is up to 3 tries, a bonus point for each hit. The database picks the game at random.
// Every try is a 'bonus_kick' event with goal true/false, so everyone's phone can follow along.

const KICKS = 3;
const ZONES = ['left', 'middle', 'right'];
const BONUS_GAMES = {
  penalties: { name: 'Penalty shootout', icon: '⚽', hit: '⚽', miss: '🧤', watching: 'is taking penalties…' },
  hoops: { name: 'Basketball', icon: '🏀', hit: '🏀', miss: '❌', watching: 'is shooting hoops…' },
  moles: { name: 'Whack-a-mole', icon: '🔨', hit: '🐹', miss: '○', watching: 'is whacking moles…' },
  wheel: { name: 'Prize wheel', icon: '🎡', hit: '⭐', miss: '○', watching: 'is spinning the wheel…' },
};
const HOOP_MS = 1400;        // one sweep of the basketball aim, left to right
const MOLE_SECONDS = 10;
const MOLES_PER_POINT = 4;
const WHEEL = [0, 1, 2, 1, 3, 0, 2, 1];  // points on each slice

function bonusGame(b) {
  return BONUS_GAMES[b.game] || BONUS_GAMES.penalties;
}

// Records tries (true = hit) for the bonus on screen, then scores it once all are in.
function recordTries(results, extra = () => ({})) {
  const b = mp.game.bonus;
  if (!b || b.points != null) return Promise.resolve();
  return mpStep(async () => {
    const rows = results.map((goal, i) => ({
      game_id: mp.gameId, player_id: b.player_id, type: 'bonus_kick',
      payload: { streak_event_id: b.id, n: b.kicks.length + i + 1, goal, ...extra(i) },
    }));
    const { error } = await sb.from('game_events').insert(rows);
    if (error) throw error;
    await refreshGame();
    if (mp.game.bonus && mp.game.bonus.kicks.length >= KICKS && mp.game.bonus.points == null) {
      await rpc('finish_bonus', { p_streak_event_id: b.id });
      await refreshGame();
    }
  });
}

// Penalties: the keeper dives a random way, and it's a goal unless they guess the same side.
function kick(zone) {
  const b = mp.game.bonus;
  if (!b || mp.busy || b.kicks.length >= KICKS) return;
  const dive = ZONES[Math.floor(Math.random() * ZONES.length)];
  mp.lastKick = { zone, dive, goal: dive !== zone };
  recordTries([dive !== zone], () => ({ zone, dive }));
}

// Basketball: the aim sweeps back and forth; shoot while it's in the green middle.
function hoopAim() {
  const t = ((Date.now() - (mp.hoopStart || 0)) % (HOOP_MS * 2)) / HOOP_MS;
  return t <= 1 ? t : 2 - t;  // 0..1..0
}

function shoot() {
  const b = mp.game.bonus;
  if (!b || mp.busy || b.kicks.length >= KICKS) return;
  const aim = hoopAim();
  const goal = Math.abs(aim - 0.5) <= 0.14;
  mp.lastShot = { aim, goal };
  recordTries([goal], () => ({ aim: Math.round(aim * 100) }));
}

// Whack-a-mole: moles pop up for a few seconds; every few whacked is a bonus point.
function startMoles() {
  if (mp.moles) return;
  mp.moles = { hits: 0, cell: -1, endsAt: Date.now() + MOLE_SECONDS * 1000, next: 0 };
  render();
}

function whack(cell) {
  const m = mp.moles;
  if (!m || Number(cell) !== m.cell) return;
  m.hits += 1;
  m.cell = -1;
  m.next = Date.now() + 250;
  drawMoles();
}

function tickMoles() {
  const m = mp.moles;
  if (!m || m.done) return;
  const now = Date.now();
  if (now >= m.endsAt) {
    m.done = true;
    m.cell = -1;
    const points = Math.min(KICKS, Math.floor(m.hits / MOLES_PER_POINT));
    recordTries(Array.from({ length: KICKS }, (_, i) => i < points), () => ({ hits: m.hits }));
    return;
  }
  if (now >= m.next) {
    let cell;
    do { cell = Math.floor(Math.random() * 9); } while (cell === m.cell);
    m.cell = cell;
    m.next = now + 650 + Math.random() * 300;
  }
  drawMoles();
}

function drawMoles() {
  const m = mp.moles;
  document.querySelectorAll('.mole-hole').forEach((el) => el.classList.toggle('up', m && Number(el.dataset.cell) === m.cell));
  const hits = document.getElementById('mole-hits');
  if (hits && m) hits.textContent = m.hits;
  const left = document.getElementById('mole-left');
  if (left && m) left.textContent = Math.max(0, Math.ceil((m.endsAt - Date.now()) / 1000));
}

// Prize wheel: one spin lands on 0 to 3 bonus points.
function spinWheel() {
  const b = mp.game.bonus;
  if (!b || mp.busy || mp.wheel) return;
  const slice = Math.floor(Math.random() * WHEEL.length);
  mp.wheel = { slice, turn: 5 * 360 + 360 - (slice + 0.5) * (360 / WHEEL.length), shown: false };
  render();
  // Turn the wheel on the next frame so the browser animates it.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    mp.wheel.shown = true;
    const el = document.querySelector('.wheel');
    if (el) el.style.transform = `rotate(${mp.wheel.turn}deg)`;
  }));
  setTimeout(() => {
    const points = WHEEL[slice];
    recordTries(Array.from({ length: KICKS }, (_, i) => i < points), () => ({ slice }));
  }, 3200);
}

function skipBonus() {
  mpStep(async () => { await rpc('finish_bonus', { p_streak_event_id: mp.game.bonus.id }); await refreshGame(); });
}

function kickTally(kicks, game = BONUS_GAMES.penalties) {
  return `<p class="kick-tally" aria-label="Tries">${Array.from({ length: KICKS }, (_, i) => {
    const k = kicks[i];
    return `<span>${k ? (k.goal ? game.hit : game.miss) : '○'}</span>`;
  }).join('')}</p>`;
}

function penaltiesPlay(b) {
  const last = b.kicks[b.kicks.length - 1];
  const k = mp.lastKick && last && last.zone === mp.lastKick.zone ? last : null;
  return `
    <p style="font-weight:700">Tap where to shoot. Beat the keeper for a bonus point each time.</p>
    <div class="goal" role="group" aria-label="Pick where to shoot">
      ${ZONES.map((z) => `<button class="goal-zone ${k && k.dive === z ? 'keeper' : ''} ${k && k.zone === z ? (k.goal ? 'scored' : 'saved') : ''}"
        data-action="kick" data-zone="${z}" ${mp.busy ? 'disabled' : ''} aria-label="Shoot ${z}">
        ${k && k.dive === z ? '🧤' : ''}${k && k.zone === z && k.goal ? '⚽' : ''}</button>`).join('')}
    </div>
    ${k ? `<p style="font-family:var(--display);font-size:26px">${k.goal ? 'GOAL!' : 'Saved!'}</p>` : ''}`;
}

// Moves the basketball smoothly while it's on screen.
function animateHoop() {
  const ball = document.getElementById('hoop-ball');
  if (!ball) { mp.hoopFrame = null; return; }
  ball.style.left = `${hoopAim() * 100}%`;
  mp.hoopFrame = requestAnimationFrame(animateHoop);
}

function hoopsPlay(b) {
  if (!mp.hoopStart) mp.hoopStart = Date.now();
  if (!mp.hoopFrame) mp.hoopFrame = requestAnimationFrame(animateHoop);
  const last = b.kicks[b.kicks.length - 1];
  const s = mp.lastShot && last ? mp.lastShot : null;
  return `
    <p style="font-weight:700">Tap Shoot when the ball is in the green. Each basket is a bonus point.</p>
    <div class="hoop-bar" aria-hidden="true"><span class="hoop-zone"></span><span id="hoop-ball" class="hoop-ball" style="left:${hoopAim() * 100}%">🏀</span></div>
    <button class="btn" data-action="shoot" ${mp.busy ? 'disabled' : ''}>Shoot!</button>
    ${s ? `<p style="font-family:var(--display);font-size:26px">${s.goal ? 'SWISH!' : 'Missed!'}</p>` : ''}`;
}

function molesPlay() {
  const m = mp.moles;
  if (!m) {
    return `<p style="font-weight:700">Whack as many moles as you can in ${MOLE_SECONDS} seconds. Every ${MOLES_PER_POINT} is a bonus point (up to ${KICKS}).</p>
      <button class="btn" data-action="startMoles">Start!</button>`;
  }
  return `
    <div class="row" style="justify-content:space-between;font-weight:800">
      <span>Whacked: <span id="mole-hits">${m.hits}</span></span><span><span id="mole-left">${Math.max(0, Math.ceil((m.endsAt - Date.now()) / 1000))}</span>s</span>
    </div>
    <div class="moles" role="group" aria-label="Moles">
      ${Array.from({ length: 9 }, (_, i) => `<button class="mole-hole ${i === m.cell ? 'up' : ''}" data-action="whack" data-cell="${i}" aria-label="Hole ${i + 1}"><span>🐹</span></button>`).join('')}
    </div>
    ${m.done ? `<p style="font-family:var(--display);font-size:24px">${m.hits} moles!</p>` : ''}`;
}

function wheelPlay() {
  const w = mp.wheel;
  const slice = 360 / WHEEL.length;
  const colours = ['var(--cyan)', 'var(--pink)', 'var(--lime)', 'var(--orange)'];
  const bg = WHEEL.map((_, i) => `${colours[i % 4]} ${i * slice}deg ${(i + 1) * slice}deg`).join(',');
  return `
    <p style="font-weight:700">Spin the wheel for up to ${KICKS} bonus points.</p>
    <div class="wheel-wrap">
      <span class="wheel-pointer" aria-hidden="true">▼</span>
      <div class="wheel" style="background:conic-gradient(${bg});transform:rotate(${w && w.shown ? w.turn : 0}deg)">
        ${WHEEL.map((p, i) => `<span style="transform:rotate(${(i + 0.5) * slice}deg) translateY(-92px)">${p}</span>`).join('')}
      </div>
    </div>
    <button class="btn" data-action="spinWheel" ${w || mp.busy ? 'disabled' : ''}>${w ? 'Spinning…' : 'Spin!'}</button>`;
}

function bonusPanel(g, player) {
  const b = g.bonus;
  const game = bonusGame(b);
  const done = b.points != null;
  const last = b.kicks[b.kicks.length - 1];
  const head = `<p class="sticker" style="align-self:flex-start;background:var(--orange);font-size:24px;transform:rotate(-2deg)">🔥 ${b.streak} in a row!</p>`;
  // Forget the last mini-game's local state when a new bonus comes up.
  if (mp.bonusId !== b.id) {
    mp.bonusId = b.id;
    mp.lastKick = mp.lastShot = mp.moles = mp.wheel = null;
    mp.hoopStart = 0;
  }
  if (done) {
    return `${head}<div class="card stack" style="gap:6px">
      <span class="eyebrow">${game.icon} ${game.name}</span>
      ${kickTally(b.kicks, game)}
      <p style="font-weight:800">${esc(player.name)} got ${b.points} of ${KICKS}: +${b.points} bonus point${b.points === 1 ? '' : 's'}</p>
    </div>`;
  }
  if (!player.mine) {
    return `${head}<div class="card stack" style="gap:6px">
      <span class="eyebrow">${game.icon} ${game.name}</span>
      <p style="font-weight:800">${esc(player.name)} ${game.watching}</p>
      ${kickTally(b.kicks, game)}
      ${last && b.game === 'penalties' ? `<p class="muted" style="font-weight:700">${last.goal ? 'GOAL!' : 'Saved!'}</p>` : ''}
    </div>`;
  }
  const play = { penalties: penaltiesPlay, hoops: hoopsPlay, moles: molesPlay, wheel: wheelPlay }[b.game] || penaltiesPlay;
  const triesLeft = KICKS - b.kicks.length;
  return `${head}
    <div class="card stack" style="gap:10px">
      <span class="eyebrow">${game.icon} ${game.name}${['penalties', 'hoops'].includes(b.game || 'penalties') ? ` · ${triesLeft} ${triesLeft === 1 ? 'go' : 'goes'} left` : ''}</span>
      ${play(b)}
      ${kickTally(b.kicks, game)}
    </div>`;
}

// ---------- 1v1 challenges ----------

const DUEL_SECONDS = 10;

function openChallenge(playerId) {
  mp.challengeFrom = mp.challengeFrom === playerId ? null : playerId;
  render();
}

function issueChallenge(opponentId) {
  const from = mp.challengeFrom;
  mp.challengeFrom = null;
  mpStep(async () => {
    await rpc('issue_challenge', { p_challenger_id: from, p_opponent_id: opponentId });
    await refreshGame();
  });
}

function answerChallenge(accept) {
  mpStep(async () => {
    await rpc('answer_challenge', { p_challenge_id: mp.game.challenge.id, p_accept: accept });
    await refreshGame();
  });
}

function cancelChallenge() {
  mpStep(async () => { await rpc('cancel_challenge', { p_challenge_id: mp.game.challenge.id }); await refreshGame(); });
}

// The next duel question this phone has to answer: the challenger's first if both are on this phone.
function myDuelQuestion(ch) {
  const order = [ch.challenger_id, ch.opponent_id].filter((id) => (mpPlayer(id) || {}).mine);
  for (const id of order) {
    const q = ch.questions.find((x) => x.player_id === id && !x.answered);
    if (q) return q;
  }
  return null;
}

function duelKey(q) {
  return `${mp.game.challenge.id}:${q.player_id}:${q.idx}`;
}

function duelSecondsLeft(q) {
  const key = duelKey(q);
  if (!mp.duelShown || mp.duelShown.key !== key) mp.duelShown = { key, at: Date.now() };
  return Math.max(0, Math.ceil(DUEL_SECONDS - (Date.now() - mp.duelShown.at) / 1000));
}

function duelPick(choice) {
  const ch = mp.game.challenge;
  const q = ch && myDuelQuestion(ch);
  if (!q || mp.busy) return;
  mpStep(async () => {
    await rpc('challenge_answer', { p_challenge_id: ch.id, p_player_id: q.player_id, p_idx: q.idx, p_response: choice || '' });
    await refreshGame();
  });
}

function duelTally(ch, playerId) {
  return ch.questions.filter((q) => q.player_id === playerId)
    .map((q) => `<span>${!q.answered ? '○' : q.is_correct ? '✅' : '❌'}</span>`).join('');
}

function duelScores(ch) {
  const a = mpPlayer(ch.challenger_id) || {};
  const b = mpPlayer(ch.opponent_id) || {};
  return `<div class="duel-vs">
    <div><span class="player-name">${esc(a.name)}</span><p class="kick-tally">${duelTally(ch, ch.challenger_id)}</p></div>
    <span class="duel-x" aria-hidden="true">VS</span>
    <div><span class="player-name">${esc(b.name)}</span><p class="kick-tally">${duelTally(ch, ch.opponent_id)}</p></div>
  </div>`;
}

// What everyone sees about a challenge above the question: the dare, or how it ended.
function challengePanel(g) {
  const ch = g.challenge;
  if (!ch || ch.status === 'playing') return '';
  const a = mpPlayer(ch.challenger_id) || {};
  const b = mpPlayer(ch.opponent_id) || {};
  if (ch.status === 'pending') {
    const canAnswer = b.mine;
    return `<div class="card stack duel-card" style="gap:10px">
      <span class="eyebrow">⚔️ Challenge</span>
      <p style="font-family:var(--display);font-size:24px">${esc(a.name)} challenges ${esc(b.name)}!</p>
      <p style="font-weight:700">${DUEL_SECONDS}-second rapid fire, 3 questions each. The winner steals 2 points.</p>
      ${canAnswer ? `<div class="row">
          <button class="btn good" style="flex:1" data-action="acceptChallenge" ${mp.busy ? 'disabled' : ''}>Bring it on</button>
          <button class="btn secondary" style="flex:1" data-action="refuseChallenge" ${mp.busy ? 'disabled' : ''}>Chicken out</button>
        </div>
        <p class="muted" style="font-size:14px;margin:0">Chickening out costs ${esc(b.name)} 1 point.</p>`
        : `<p class="muted" style="font-weight:700">Waiting for ${esc(b.name)} to answer…</p>`}
      ${a.mine || g.is_host ? '<button class="link-btn" data-action="cancelChallenge" style="align-self:center">Call it off</button>' : ''}
    </div>`;
  }
  if (ch.status === 'refused') {
    return `<p class="notice">🐔 ${esc(b.name)} chickened out of ${esc(a.name)}'s challenge and loses 1 point.</p>`;
  }
  const w = mpPlayer(ch.winner_id);
  return `<div class="card stack duel-card" style="gap:6px">
    <span class="eyebrow">⚔️ Duel result</span>
    ${duelScores(ch)}
    <p style="font-weight:800">${w ? `${esc(w.name)} wins and steals 2 points from ${esc(w.id === a.id ? b.name : a.name)}!` : "It's a draw. Nobody steals anything."}</p>
  </div>`;
}

// The Challenge card: each player can play it once a game, when no other challenge is on.
function challengeCards(g) {
  if (g.challenge && ['pending', 'playing'].includes(g.challenge.status)) return '';
  const used = new Set(g.cards_used || []);
  const mine = g.players.filter((p) => p.mine && !used.has(p.id));
  if (!mine.length || g.players.length < 2) return '';
  const from = mpPlayer(mp.challengeFrom);
  if (from && mine.some((p) => p.id === from.id)) {
    return `<div class="card stack" style="gap:8px">
      <span class="eyebrow">⚔️ Who does ${esc(from.name)} challenge?</span>
      <div class="row" style="flex-wrap:wrap">
        ${g.players.filter((p) => p.id !== from.id).map((p) => `<button class="btn secondary" style="width:auto;padding:0 14px;min-height:44px;font-size:18px" data-action="issueChallenge" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
      </div>
      <button class="link-btn" data-action="openChallenge" data-id="${esc(from.id)}" style="align-self:center">Not now</button>
    </div>`;
  }
  return `<div class="row" style="flex-wrap:wrap;gap:8px">
    ${mine.map((p) => `<button class="chip challenge-chip" data-action="openChallenge" data-id="${esc(p.id)}">⚔️ ${mine.length > 1 || g.is_host ? `${esc(p.name)}'s ` : ''}Challenge card</button>`).join('')}
  </div>`;
}

// While a duel is on, it takes over every phone: the two players answer, everyone else watches.
function duelScreen(g) {
  const ch = g.challenge;
  const a = mpPlayer(ch.challenger_id) || {};
  const b = mpPlayer(ch.opponent_id) || {};
  const q = myDuelQuestion(ch);
  const who = q && mpPlayer(q.player_id);
  const both = a.mine && b.mine;
  let body;
  if (q) {
    const left = duelSecondsLeft(q);
    body = `
      <div class="row" style="justify-content:space-between">
        <p style="font-family:var(--display);font-size:22px">${both ? `${esc(who.name)} · ` : ''}Question ${q.idx} of 3</p>
        <div id="duel-timer" class="timer ${left <= 3 ? 'low' : ''}" role="timer" aria-label="Seconds left">${left}</div>
      </div>
      <p class="muted" style="font-weight:700;margin:0">${esc(q.topic)}</p>
      <h1 class="question">${esc(q.text)}</h1>
      <div class="choices" role="group" aria-label="Answers">
        ${q.choices.map((c) => `<button class="choice" data-action="duelPick" data-value="${esc(c)}" ${mp.busy ? 'disabled' : ''}>${esc(c)}</button>`).join('')}
      </div>`;
  } else {
    const mineDone = a.mine || b.mine;
    body = `<p class="muted" style="font-weight:700;text-align:center">${mineDone ? 'Done! Waiting for the other player…' : `${esc(a.name)} and ${esc(b.name)} are battling it out…`}</p>`;
  }
  return `
    <div class="topbar"><span class="chip duel-chip">⚔️ Duel</span></div>
    ${duelScores(ch)}
    ${body}
    ${mpNotes()}
    ${g.is_host ? '<button class="link-btn" data-action="cancelChallenge" style="align-self:center">Call off the duel</button>' : ''}
    <div class="spacer"></div>
    <details><summary class="eyebrow" style="cursor:pointer">Scores</summary>${scoreboard(g.players)}</details>
  `;
}

// ---------- Joining ----------

function openJoin() {
  mp.code = '';
  mp.family = null;
  mp.error = '';
  state.screen = 'join';
  render();
}

// Finds the names this phone can play as: your own profiles if signed in, otherwise the game's family.
function findGame(code) {
  mp.code = code.trim().toUpperCase();
  mpStep(async () => {
    if (!auth.user) {
      const { data, error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      auth.user = data.user;
    }
    const family = await rpc('family_profiles', { p_code: mp.code });
    if (isFullAccount()) {
      mp.family = [auth.profile, ...auth.kids].filter(Boolean)
        .map((p) => ({ id: p.id, display_name: p.display_name, age: p.age, own: true }));
      if (!family.length && !mp.family.length) throw new Error('No names to pick from.');
    } else {
      if (!family.length) throw new Error(`No game with code ${mp.code}, or nobody to pick in it yet.`);
      mp.family = family;
    }
  });
}

function joinAs(profileId) {
  mpStep(async () => {
    const own = (mp.family || []).find((p) => p.id === profileId && p.own);
    if (own) {
      await rpc('join_game', { p_code: mp.code, p_profile_id: profileId });
    } else {
      // A device the parent approved before can go straight in.
      const { data: linked } = await sb.from('profile_devices').select('profile_id')
        .eq('profile_id', profileId).eq('user_id', auth.user.id);
      if (linked && linked.length) {
        await rpc('join_game', { p_code: mp.code, p_profile_id: profileId });
      } else {
        const r = await rpc('request_device', { p_code: mp.code, p_profile_id: profileId });
        mp.requestId = r.id;
        waitForApproval(r);
        return;
      }
    }
    const { data: player } = await sb.from('game_players').select('game_id').eq('profile_id', profileId)
      .order('joined_at', { ascending: false }).limit(1);
    await followGame(player[0].game_id);
  });
}

function waitForApproval(request) {
  state.screen = 'waiting';
  const check = async () => {
    const { data } = await sb.from('device_requests').select('status, game_id').eq('id', request.id).single();
    if (!data || state.screen !== 'waiting') { clearInterval(timer); return; }
    if (data.status === 'approved') { clearInterval(timer); mp.requestId = null; followGame(data.game_id); }
    if (data.status === 'declined') {
      clearInterval(timer);
      mp.requestId = null;
      mp.error = 'The quiz master said no this time.';
      state.screen = 'join';
      render();
    }
  };
  const timer = setInterval(check, 2000);
}

// ---------- Screens ----------

function mpPlayer(id) {
  return (mp.game.players || []).find((p) => p.id === id);
}

function mpSecondsLeft() {
  const g = mp.game;
  const seconds = Number(g && g.settings && g.settings.seconds) || 0;
  if (!seconds || !g.question || !g.question.asked_at) return null;
  return Math.max(0, Math.ceil(seconds - (Date.now() - new Date(g.question.asked_at).getTime()) / 1000));
}

function tickMp() {
  tickMoles();
  const duel = document.getElementById('duel-timer');
  const ch = mp.game && mp.game.challenge;
  const dq = duel && ch && ch.status === 'playing' && myDuelQuestion(ch);
  if (dq) {
    const left = duelSecondsLeft(dq);
    duel.textContent = left;
    duel.classList.toggle('low', left <= 3);
    if (left === 0 && !mp.busy && mp.duelTimedOut !== duelKey(dq)) {
      mp.duelTimedOut = duelKey(dq);
      duelPick('');
    }
  }
  const el = document.getElementById('mp-timer');
  const left = mpSecondsLeft();
  if (!el || left === null) return;
  el.textContent = left;
  el.classList.toggle('low', left <= 5);
}

function scoreboard(players, highlight) {
  const sorted = players.slice().sort((a, b) => b.score - a.score);
  return `<ol class="stack" style="list-style:none;margin:0;padding:0;gap:8px">
    ${sorted.map((p, i) => `
      <li class="card leader ${i === 0 && p.score > 0 ? 'first' : ''}" style="padding:8px 12px${p.id === highlight ? ';background:var(--lime)' : ''}">
        <span class="rank">${i + 1}</span>
        ${badge(players.indexOf(p))}
        <span class="player-name">${esc(p.name)}${p.streak >= 3 ? ` <span class="muted" style="font-size:13px">🔥 ${p.streak}</span>` : ''}</span>
        <span class="score">${p.score}</span>
      </li>`).join('')}
  </ol>`;
}

function mpNotes() {
  return mp.error ? `<p class="notice error" role="alert">${esc(mp.error)}</p>` : '';
}

function joinScreen() {
  return `
    <div class="topbar"><h1 style="font-size:36px">Join a game</h1><button class="link-btn" data-action="cancel">Back</button></div>
    ${mpNotes()}
    ${mp.family ? `
      <p class="eyebrow">Game ${esc(mp.code)} · Who are you?</p>
      <div class="stack">
        ${mp.family.map((p, i) => `
          <button class="card row" data-action="joinAs" data-id="${esc(p.id)}" ${mp.busy ? 'disabled' : ''} style="text-align:left;width:100%">
            ${badge(i)}
            <span class="player-main"><span class="player-name">${esc(p.display_name)}</span><br>
            <span class="muted player-age">${esc(ageLabel(p.age))}</span></span>
          </button>`).join('')}
      </div>
      ${!isFullAccount() ? '<p class="muted" style="font-size:15px">The quiz master will be asked to say it\'s you.</p>' : ''}
    ` : `
      <form id="join" class="stack" style="gap:14px">
        <label for="join-code">Game code</label>
        <input id="join-code" name="code" value="${esc(mp.code)}" maxlength="4" autocapitalize="characters" autocomplete="off"
          style="font-family:var(--display);font-size:36px;letter-spacing:8px;text-align:center;text-transform:uppercase" required>
        <button class="btn" type="submit" ${mp.busy ? 'disabled' : ''}>${mp.busy ? 'Looking…' : 'Find game'}</button>
      </form>`}
  `;
}

function waitingScreen() {
  return `
    <div class="pass">
      <p class="eyebrow">Game ${esc(mp.code)}</p>
      <h1>Waiting for the quiz master</h1>
      <p style="font-weight:700">They'll get a message to say it's you.</p>
    </div>
    <button class="btn secondary" data-action="leaveMp">Cancel</button>
  `;
}

function lobbyScreen(g) {
  const inGame = new Set(g.players.map((p) => p.profile_id));
  const mine = isFullAccount() ? [auth.profile, ...auth.kids].filter((p) => p && !inGame.has(p.id)) : [];
  const watchUrl = g.watch_key ? `${location.origin}${location.pathname.replace(/[^/]*$/, '')}watch.html?k=${encodeURIComponent(g.watch_key)}` : '';
  return `
    <div class="topbar"><span class="eyebrow">Lobby</span><button class="link-btn" data-action="leaveMp">Leave</button></div>
    <div class="pass" style="gap:6px">
      <p class="eyebrow">Game code</p>
      <h1 class="sticker" style="background:var(--orange);font-size:56px;letter-spacing:6px;transform:rotate(-2deg)">${esc(g.code)}</h1>
      <p style="font-weight:700">${g.is_host ? 'Everyone opens the app, taps Join a game and types this code.' : `Waiting for ${esc(g.host_name || 'the quiz master')} to start.`}</p>
    </div>
    ${mpNotes()}
    ${g.requests.length ? `<section class="stack">
      <h2 class="eyebrow" style="font-family:var(--body)">Waiting to join</h2>
      ${g.requests.map((r) => `
        <div class="card row">
          <span class="player-main"><span class="player-name">${esc(r.name)}</span><br><span class="muted player-age">on their own device</span></span>
          <button class="btn good" style="width:auto;padding:0 14px;min-height:44px;font-size:18px" data-action="approve" data-id="${esc(r.id)}">Let in</button>
          <button class="link-btn" data-action="decline" data-id="${esc(r.id)}">No</button>
        </div>`).join('')}
    </section>` : ''}
    <section class="stack">
      <h2 class="eyebrow" style="font-family:var(--body)">Players (${g.players.length})</h2>
      ${g.players.map((p, i) => `<div class="card row">${badge(i)}<span class="player-main"><span class="player-name">${esc(p.name)}</span><br><span class="muted player-age">${esc(ageLabel(p.age))}</span></span></div>`).join('') || '<p class="muted">Nobody yet.</p>'}
    </section>
    ${mine.length ? `<section class="stack" style="gap:8px">
      <h2 class="eyebrow" style="font-family:var(--body)">Playing on this phone</h2>
      <div class="row" style="flex-wrap:wrap">
        ${mine.map((p) => `<button class="btn secondary" style="width:auto;padding:0 14px;min-height:44px;font-size:18px" data-action="addHere" data-id="${esc(p.id)}">+ ${esc(p.display_name)}</button>`).join('')}
      </div>
    </section>` : ''}
    ${watchUrl ? `<button class="btn secondary" data-action="shareWatch" data-url="${esc(watchUrl)}">Share watch link</button>
      <p class="muted" style="font-size:14px;margin-top:-10px">For anyone who wants to follow along without playing. No app needed.</p>` : ''}
    <div class="spacer"></div>
    ${g.is_host ? `<button class="btn" data-action="startMp" ${mp.busy || !g.players.length ? 'disabled' : ''}>Start the quiz</button>` : ''}
  `;
}

function playScreen(g) {
  const q = g.question;
  if (!q) return '<p>Loading…</p>';
  if (g.challenge && g.challenge.status === 'playing') return duelScreen(g);
  const player = mpPlayer(q.player_id) || { name: 'Everyone' };
  const answer = q.answers.find((a) => a.player_id === q.player_id);
  const myTurn = player.mine;
  const left = mpSecondsLeft();
  const isLast = q.seq >= g.total;

  let body = '';
  if (answer) {
    const msg = answer.is_correct ? `Correct! +${answer.points}` : 'Not this time';
    body = `
      <div class="card stack" style="gap:4px"><span class="eyebrow">Answer</span><span class="answer-reveal">${esc(q.answer || '')}</span></div>
      ${answer.response ? `<p class="muted" style="font-weight:700">${esc(player.name)} picked ${esc(answer.response)}</p>` : ''}
      <p class="sticker" style="align-self:flex-start;background:${answer.is_correct ? 'var(--lime)' : 'var(--wrong)'};font-size:26px;transform:rotate(-2deg)">${msg}</p>`;
  } else if (q.choices_shown && q.choices) {
    body = `<div class="choices" role="group" aria-label="Answers">
      ${q.choices.map((c) => `<button class="choice" data-action="pickMp" data-value="${esc(c)}" ${myTurn && !mp.busy ? '' : 'disabled'}>${esc(c)}</button>`).join('')}
    </div>
    ${!myTurn ? `<p class="muted" style="font-weight:700">${esc(player.name)} is choosing…</p>` : ''}`;
  } else if (q.answer) {
    // The host judging someone else's question, or anyone once the answer is shown.
    body = `<div class="card stack" style="gap:4px"><span class="eyebrow">${q.revealed ? 'Answer' : 'Answer (only you can see this)'}</span><span class="answer-reveal">${esc(q.answer)}</span></div>
      ${q.revealed ? '' : `<p class="muted" style="font-weight:700">${esc(player.name)} says their answer out loud.</p>`}`;
  } else {
    body = `<p class="muted" style="font-weight:700">${myTurn ? `Say your answer out loud for ${POINTS_STRAIGHT} points.` : `${esc(player.name)} is answering out loud.`}</p>`;
  }

  const bonus = answer && g.bonus && g.bonus.player_id === q.player_id ? g.bonus : null;
  if (bonus) body += bonusPanel(g, player);

  let footer = '';
  if (answer) {
    if (g.is_host && bonus && bonus.points == null) {
      footer = `<p class="muted" style="font-weight:700;text-align:center">Waiting for ${esc(player.name)}'s bonus game…</p>
        <button class="link-btn" data-action="skipBonus" style="align-self:center">Skip the bonus</button>`;
    } else if (g.is_host) {
      footer = `<button class="btn" data-action="nextMp" ${mp.busy ? 'disabled' : ''}>${isLast ? 'See final scores' : 'Next question'}</button>`;
    }
  } else {
    if (myTurn && !q.choices_shown && q.choices) {
      footer += `<button class="btn secondary" data-action="choicesMp" ${mp.busy ? 'disabled' : ''}>Show choices (${POINTS_CHOICES} point)</button>`;
    }
    if (g.is_host && !q.choices_shown) {
      // On a question for someone on the host's own phone, the answer stays hidden until they've said theirs.
      footer += q.answer
        ? judgeButtons(player.name, 'markRight', 'markWrong', mp.busy)
        : `<button class="btn" data-action="revealMp" ${mp.busy ? 'disabled' : ''}>Show answer</button>`;
    }
    if (g.is_host) footer += `<button class="link-btn" data-action="nextMp" style="align-self:center">Skip this question</button>`;
  }

  return `
    <div class="topbar">
      <span class="chip" style="background:${COLOURS[g.players.indexOf(player) % 4] || 'var(--card)'}">${myTurn ? 'Your turn' : esc(player.name)}</span>
      ${left !== null && !answer ? `<div id="mp-timer" class="timer ${left <= 5 ? 'low' : ''}" role="timer" aria-label="Seconds left">${left}</div>` : ''}
    </div>
    <div class="row" style="justify-content:space-between">
      <p style="font-family:var(--display);font-size:22px">Q${q.seq} <span class="muted" style="font-family:var(--body);font-weight:700;font-size:16px">of ${g.total} · ${esc(q.topic)}</span></p>
      ${gradeDots(q.grade)}
    </div>
    ${challengePanel(g)}
    <h1 class="question">${esc(q.text)}</h1>
    ${body}
    ${mpNotes()}
    ${footer}
    ${challengeCards(g)}
    <div class="spacer"></div>
    <details><summary class="eyebrow" style="cursor:pointer">Scores</summary>${scoreboard(g.players, q.player_id)}</details>
  `;
}

function finishedScreen(g) {
  return `
    <div class="stack" style="align-items:flex-start;gap:8px">
      <span class="eyebrow">Game ${esc(g.code)}</span>
      <h1 class="sticker" style="background:var(--cyan);font-size:36px;transform:rotate(-2deg)">FINAL SCORES</h1>
    </div>
    ${scoreboard(g.players)}
    <div class="spacer"></div>
    <button class="btn" data-action="leaveMp">Back to start</button>
  `;
}

function mpScreen() {
  const g = mp.game;
  if (!g) return `<div class="pass"><h1>Loading game…</h1></div>${mpNotes()}<button class="btn secondary" data-action="leaveMp">Leave</button>`;
  if (g.status === 'lobby') return lobbyScreen(g);
  if (g.status === 'finished') return finishedScreen(g);
  return playScreen(g);
}


// Picks up a game this phone was in before the app was closed.
function resumeMp() {
  mp.gameId = load(MP_KEY);
  if (sb && mp.gameId) {
    followGame(mp.gameId);
    render();
  }
}

// Shares the watch link with the phone's share sheet, or copies it where sharing isn't available.
async function shareWatch(url, el) {
  try {
    if (navigator.share) await navigator.share({ title: 'Watch our Family Quiz', url });
    else { await navigator.clipboard.writeText(url); el.textContent = 'Link copied'; }
  } catch { /* share sheet closed */ }
}
