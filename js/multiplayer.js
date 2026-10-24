// Multiplayer: the host's phone runs the game, everyone else plays on their own phone.
// Every phone reads the whole game from game_state() whenever the database says something changed.

const MP_KEY = 'fq.mp.v1';
const MP_POLL_MS = 4000; // safety net in case a live update is missed

const mp = {
  gameId: null,    // set from storage by resumeMp()
  game: null,      // the latest game_state()
  code: '',        // join screen: the code typed in
  family: null,    // join screen: names to pick from
  requestId: null, // waiting for a parent or the game's creator to approve this device
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
  ['game_players', 'game_questions', 'answers', 'game_events', 'device_requests', 'challenges', 'challenge_questions', 'challenge_scores'].forEach((table) => {
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
  stopClip();
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
  if (!isFullAccount()) { auth.message = 'Sign in to set up a game.'; state.screen = 'account'; render(); return; }
  mpStep(async () => {
    const s = state.settings;
    const g = await rpc('create_game', {
      p_settings: {
        topic: s.topic || '',
        grades: difficulty().grades,
        per_player: Number(s.perPlayer) || 10,
        seconds: Number(s.seconds) || 0,
        song_clips: SONG_CLIPS_ALLOWED && s.songClips !== false,
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

// ---------- Song clips ----------
// The host's phone is the speaker. The preview is looked up as soon as the question comes up, so a
// tap can start it straight away (phones only play sound straight from a tap). First tap plays the
// intro, the next carries on.

const CLIP_INTRO_SECONDS = 8;

function itunesSearch(term) {
  return new Promise((resolve, reject) => {
    const cb = `itunes${Date.now()}`;
    const script = document.createElement('script');
    const done = () => { delete window[cb]; script.remove(); };
    window[cb] = (data) => { done(); resolve((data.results || [])[0] || null); };
    script.onerror = () => { done(); reject(new Error("Couldn't load the song clip.")); };
    script.src = `https://itunes.apple.com/search?entity=song&limit=1&country=ie&term=${encodeURIComponent(term)}&callback=${cb}`;
    document.head.appendChild(script);
  });
}

function prepareClip(q) {
  if (mp.clip && mp.clip.qid === q.id) return;
  stopClip();
  mp.clip = { qid: q.id, status: 'loading' };
  itunesSearch(q.media.search).then((t) => {
    if (!mp.clip || mp.clip.qid !== q.id) return;
    mp.clip = t && t.previewUrl
      ? { qid: q.id, status: 'ready', url: t.previewUrl, link: t.trackViewUrl, audio: null, played: 0 }
      : { qid: q.id, status: 'missing' };
    render();
  }).catch(() => { if (mp.clip && mp.clip.qid === q.id) { mp.clip.status = 'missing'; render(); } });
}

function playClip() {
  const c = mp.clip;
  if (!c || c.status !== 'ready') return;
  if (!c.audio) c.audio = new Audio(c.url);
  const a = c.audio;
  if (!a.paused) { a.pause(); render(); return; }
  c.played += 1;
  a.play().catch(() => {});
  clearTimeout(c.stopAt);
  if (c.played === 1) c.stopAt = setTimeout(() => { a.pause(); render(); }, CLIP_INTRO_SECONDS * 1000);
  a.onended = () => render();
  render();
}

function stopClip() {
  if (mp.clip && mp.clip.audio) mp.clip.audio.pause();
  if (mp.clip) clearTimeout(mp.clip.stopAt);
  mp.clip = null;
}

function clipPanel(g, q, done) {
  if (!g.is_host) return `<p class="muted" style="font-weight:700">🎧 Listen to the clip on ${esc(g.host_name || 'the main')}'s phone.</p>`;
  prepareClip(q);
  const c = mp.clip;
  if (c.status === 'loading') return '<p class="muted" style="font-weight:700">Loading the clip…</p>';
  if (c.status === 'missing') return '<p class="notice">This clip isn\'t available. Skip it, or hum it yourself!</p>';
  const playing = c.audio && !c.audio.paused;
  const label = playing ? '⏸ Pause' : c.played === 0 ? `▶ Play the intro (${CLIP_INTRO_SECONDS}s)` : done ? '▶ Play the song' : '▶ Keep playing';
  return `<button class="btn secondary" data-action="playClip">${label}</button>
    <a class="muted" style="font-size:13px;align-self:center" href="${esc(c.link || 'https://music.apple.com')}" target="_blank" rel="noopener">Preview from Apple Music</a>`;
}

function humGuess(guesserId) {
  mpStep(async () => {
    await rpc('judge_hum', { p_game_question_id: mp.game.question.id, p_guesser_id: guesserId || null });
    await refreshGame();
  });
}

function endMp() {
  if (!confirm('End the game for everyone and show the final scores?')) return;
  mpStep(async () => { await rpc('end_game', { p_game_id: mp.gameId }); await refreshGame(); });
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

// ---------- Silly mini-games ----------
// Used for streak bonuses and for silly game challenges. Each game is up to 3 tries; a hit is worth
// a point (whack-a-mole counts every mole in a challenge). The game being played is mp.mini:
// { key, game, tries, record(results, extra) }, set when its panel is drawn.

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

function bonusGame(name) {
  return BONUS_GAMES[name] || BONUS_GAMES.penalties;
}

// Points at the mini-game about to be drawn, and forgets the last one's local state when it changes.
function useMini(key, game, tries, record) {
  if (!mp.mini || mp.mini.key !== key) {
    mp.lastKick = mp.lastShot = mp.moles = mp.wheel = null;
    mp.hoopStart = 0;
  }
  mp.mini = { key, game, tries, record };
  return mp.mini;
}

function miniOpen() {
  const m = mp.mini;
  return m && !mp.busy && m.tries.length < KICKS ? m : null;
}

// Streak bonus: every try is a 'bonus_kick' event so everyone's phone can follow, then it's scored once.
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
  const m = miniOpen();
  if (!m) return;
  const dive = ZONES[Math.floor(Math.random() * ZONES.length)];
  mp.lastKick = { zone, dive, goal: dive !== zone };
  m.record([dive !== zone], () => ({ zone, dive }));
}

// Basketball: the aim sweeps back and forth; shoot while it's in the green middle.
function hoopAim() {
  const t = ((Date.now() - (mp.hoopStart || 0)) % (HOOP_MS * 2)) / HOOP_MS;
  return t <= 1 ? t : 2 - t;  // 0..1..0
}

function shoot() {
  const m = miniOpen();
  if (!m) return;
  const aim = hoopAim();
  const goal = Math.abs(aim - 0.5) <= 0.14;
  mp.lastShot = { aim, goal };
  m.record([goal], () => ({ aim: Math.round(aim * 100) }));
}

// Whack-a-mole: moles pop up for a few seconds; every few whacked is a bonus point.
function startMoles() {
  if (mp.moles || !miniOpen()) return;
  mp.moles = { hits: 0, cell: -1, endsAt: Date.now() + MOLE_SECONDS * 1000, next: 0 };
  render();
}

function whack(cell) {
  const m = mp.moles;
  if (!m || m.done || Number(cell) !== m.cell) return;
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
    if (mp.mini) mp.mini.record(Array.from({ length: KICKS }, (_, i) => i < points), () => ({ hits: m.hits }));
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

// Prize wheel: one spin lands on 0 to 3 points.
function spinWheel() {
  const m = miniOpen();
  if (!m || mp.wheel) return;
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
    m.record(Array.from({ length: KICKS }, (_, i) => i < points), () => ({ slice }));
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

function penaltiesPlay(m) {
  const last = m.tries[m.tries.length - 1];
  const k = mp.lastKick && last ? mp.lastKick : null;
  return `
    <p style="font-weight:700">Tap where to shoot. Beat the keeper to score.</p>
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

function hoopsPlay(m) {
  if (!mp.hoopStart) mp.hoopStart = Date.now();
  if (!mp.hoopFrame) mp.hoopFrame = requestAnimationFrame(animateHoop);
  const s = mp.lastShot && m.tries.length ? mp.lastShot : null;
  return `
    <p style="font-weight:700">Tap Shoot when the ball is in the green.</p>
    <div class="hoop-bar" aria-hidden="true"><span class="hoop-zone"></span><span id="hoop-ball" class="hoop-ball" style="left:${hoopAim() * 100}%">🏀</span></div>
    <button class="btn" data-action="shoot" ${mp.busy ? 'disabled' : ''}>Shoot!</button>
    ${s ? `<p style="font-family:var(--display);font-size:26px">${s.goal ? 'SWISH!' : 'Missed!'}</p>` : ''}`;
}

function molesPlay(m, duel) {
  const mo = mp.moles;
  if (!mo) {
    return `<p style="font-weight:700">Whack as many moles as you can in ${MOLE_SECONDS} seconds.${duel ? ' Most moles wins.' : ` Every ${MOLES_PER_POINT} is a bonus point (up to ${KICKS}).`}</p>
      <button class="btn" data-action="startMoles">Start!</button>`;
  }
  return `
    <div class="row" style="justify-content:space-between;font-weight:800">
      <span>Whacked: <span id="mole-hits">${mo.hits}</span></span><span><span id="mole-left">${Math.max(0, Math.ceil((mo.endsAt - Date.now()) / 1000))}</span>s</span>
    </div>
    <div class="moles" role="group" aria-label="Moles">
      ${Array.from({ length: 9 }, (_, i) => `<button class="mole-hole ${i === mo.cell ? 'up' : ''}" data-action="whack" data-cell="${i}" aria-label="Hole ${i + 1}"><span>🐹</span></button>`).join('')}
    </div>
    ${mo.done ? `<p style="font-family:var(--display);font-size:24px">${mo.hits} moles!</p>` : ''}`;
}

function wheelPlay() {
  const w = mp.wheel;
  const slice = 360 / WHEEL.length;
  const colours = ['var(--cyan)', 'var(--pink)', 'var(--lime)', 'var(--orange)'];
  const bg = WHEEL.map((_, i) => `${colours[i % 4]} ${i * slice}deg ${(i + 1) * slice}deg`).join(',');
  return `
    <p style="font-weight:700">Spin the wheel for up to ${KICKS} points.</p>
    <div class="wheel-wrap">
      <span class="wheel-pointer" aria-hidden="true">▼</span>
      <div class="wheel" style="background:conic-gradient(${bg});transform:rotate(${w && w.shown ? w.turn : 0}deg)">
        ${WHEEL.map((p, i) => `<span style="transform:rotate(${(i + 0.5) * slice}deg) translateY(-92px)">${p}</span>`).join('')}
      </div>
    </div>
    <button class="btn" data-action="spinWheel" ${w || mp.busy ? 'disabled' : ''}>${w ? 'Spinning…' : 'Spin!'}</button>`;
}

// The playable part of a mini-game, with its tries so far.
function miniPlay(m, duel = false) {
  const game = bonusGame(m.game);
  const play = { penalties: penaltiesPlay, hoops: hoopsPlay, moles: molesPlay, wheel: wheelPlay }[m.game] || penaltiesPlay;
  const left = KICKS - m.tries.length;
  return `
    <span class="eyebrow">${game.icon} ${game.name}${['penalties', 'hoops'].includes(m.game) ? ` · ${left} ${left === 1 ? 'go' : 'goes'} left` : ''}</span>
    ${play(m, duel)}
    ${kickTally(m.tries, game)}`;
}

function bonusPanel(g, player) {
  const b = g.bonus;
  const game = bonusGame(b.game);
  const head = `<p class="sticker" style="align-self:flex-start;background:var(--orange);font-size:24px;transform:rotate(-2deg)">🔥 ${b.streak} in a row!</p>`;
  if (b.points != null) {
    return `${head}<div class="card stack" style="gap:6px">
      <span class="eyebrow">${game.icon} ${game.name}</span>
      ${kickTally(b.kicks, game)}
      <p style="font-weight:800">${esc(player.name)} got ${b.points} of ${KICKS}: +${b.points} bonus point${b.points === 1 ? '' : 's'}</p>
    </div>`;
  }
  if (!player.mine) {
    const last = b.kicks[b.kicks.length - 1];
    return `${head}<div class="card stack" style="gap:6px">
      <span class="eyebrow">${game.icon} ${game.name}</span>
      <p style="font-weight:800">${esc(player.name)} ${game.watching}</p>
      ${kickTally(b.kicks, game)}
      ${last && b.game === 'penalties' ? `<p class="muted" style="font-weight:700">${last.goal ? 'GOAL!' : 'Saved!'}</p>` : ''}
    </div>`;
  }
  const m = useMini(`bonus:${b.id}`, b.game || 'penalties', b.kicks, recordTries);
  return `${head}<div class="card stack" style="gap:10px">${miniPlay(m)}</div>`;
}

// ---------- 1v1 challenges ----------
// The challenger picks an opponent and how: a buzzer race (each round both get their own multiple
// choice question at once; first right answer wins the round, best of 3) or a silly game face-off.

const BUZZ_SECONDS = 15;

function openChallenge(playerId) {
  mp.challengeFrom = mp.challengeFrom === playerId ? null : playerId;
  mp.challengeTo = null;
  render();
}

function pickOpponent(opponentId) {
  mp.challengeTo = opponentId;
  render();
}

function issueChallenge(mode) {
  const from = mp.challengeFrom;
  const to = mp.challengeTo;
  mp.challengeFrom = mp.challengeTo = null;
  mpStep(async () => {
    await rpc('start_challenge', { p_challenger_id: from, p_opponent_id: to, p_mode: mode });
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

function duelists(ch) {
  return [ch.challenger_id, ch.opponent_id];
}

// The buzzer round being played: the first one nobody has won and not everyone has missed.
function buzzRound(ch) {
  const r = (ch.rounds || []).find((x) => !x.resolved);
  return r ? r.idx : null;
}

function buzzQuestion(ch, playerId, idx) {
  return ch.questions.find((q) => q.player_id === playerId && q.idx === idx);
}

function buzzSecondsLeft(ch) {
  const key = `${ch.id}:${buzzRound(ch)}`;
  if (!mp.buzzShown || mp.buzzShown.key !== key) mp.buzzShown = { key, at: Date.now() };
  return Math.max(0, Math.ceil(BUZZ_SECONDS - (Date.now() - mp.buzzShown.at) / 1000));
}

function buzz(playerId, choice) {
  const ch = mp.game.challenge;
  const idx = ch && buzzRound(ch);
  if (!idx || mp.busy) return;
  mpStep(async () => {
    await rpc('challenge_answer', { p_challenge_id: ch.id, p_player_id: playerId, p_idx: idx, p_response: choice || '' });
    await refreshGame();
  });
}

// Out of time: anyone on this phone who hasn't buzzed this round misses it.
function buzzTimeout(ch) {
  const idx = buzzRound(ch);
  const key = `${ch.id}:${idx}`;
  if (mp.buzzTimedOut === key) return;
  mp.buzzTimedOut = key;
  const mine = duelists(ch).filter((id) => (mpPlayer(id) || {}).mine && !buzzQuestion(ch, id, idx).answered);
  mpStep(async () => {
    for (const id of mine) {
      await rpc('challenge_answer', { p_challenge_id: ch.id, p_player_id: id, p_idx: idx, p_response: '' });
    }
    await refreshGame();
  });
}

function roundWins(ch, playerId) {
  return (ch.rounds || []).filter((r) => r.winner === playerId).length;
}

// Silly game face-off: tries stay on this phone, then the score goes in.
function duelGamePlayer(ch) {
  return duelists(ch).find((id) => (mpPlayer(id) || {}).mine && ch.scores[id] == null);
}

function duelRecord(results, extra = () => ({})) {
  const ch = mp.game.challenge;
  const m = mp.mini;
  results.forEach((goal, i) => m.tries.push({ goal, ...extra(i) }));
  if (m.tries.length < KICKS) { render(); return Promise.resolve(); }
  const hits = m.tries.reduce((n, t) => Math.max(n, t.hits || 0), 0);
  const score = m.game === 'moles' ? hits : m.tries.filter((t) => t.goal).length;
  return mpStep(async () => {
    await rpc('challenge_game_score', { p_challenge_id: ch.id, p_player_id: m.player, p_score: score });
    await refreshGame();
  });
}

function duelScore(ch, id) {
  if (ch.mode === 'game') {
    const s = ch.scores[id];
    return s == null ? '<span class="muted">playing…</span>' : `<span class="duel-score">${s}</span>`;
  }
  return `<span class="kick-tally">${(ch.rounds || []).map((r) => `<span>${r.winner === id ? '🏆' : r.resolved ? '✗' : '○'}</span>`).join('')}</span>`;
}

function duelScores(ch) {
  const a = mpPlayer(ch.challenger_id) || {};
  const b = mpPlayer(ch.opponent_id) || {};
  return `<div class="duel-vs">
    <div><span class="player-name">${esc(a.name)}</span>${duelScore(ch, ch.challenger_id)}</div>
    <span class="duel-x" aria-hidden="true">VS</span>
    <div><span class="player-name">${esc(b.name)}</span>${duelScore(ch, ch.opponent_id)}</div>
  </div>`;
}

function duelKind(ch) {
  return ch.mode === 'game' ? `${bonusGame(ch.minigame).icon} ${bonusGame(ch.minigame).name} face-off` : '🔔 Buzzer race';
}

// What everyone sees about a challenge above the question: the dare, or how it ended.
function challengePanel(g) {
  const ch = g.challenge;
  if (!ch || ch.status === 'playing') return '';
  const a = mpPlayer(ch.challenger_id) || {};
  const b = mpPlayer(ch.opponent_id) || {};
  if (ch.status === 'pending') {
    const how = ch.mode === 'game'
      ? `A ${bonusGame(ch.minigame).name.toLowerCase()} face-off. Higher score wins and steals 2 points.`
      : 'First to the buzzer on 3 multiple choice questions. Best of 3 steals 2 points.';
    return `<div class="card stack duel-card" style="gap:10px">
      <span class="eyebrow">⚔️ Challenge · ${duelKind(ch)}</span>
      <p style="font-family:var(--display);font-size:24px">${esc(a.name)} challenges ${esc(b.name)}!</p>
      <p style="font-weight:700">${how}</p>
      ${b.mine ? `<div class="row">
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
    <span class="eyebrow">⚔️ ${duelKind(ch)} result</span>
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
  const small = 'style="width:auto;padding:0 14px;min-height:44px;font-size:18px"';
  if (from && mine.some((p) => p.id === from.id)) {
    const to = mpPlayer(mp.challengeTo);
    return `<div class="card stack" style="gap:8px">
      ${to ? `
        <span class="eyebrow">⚔️ How does ${esc(from.name)} take on ${esc(to.name)}?</span>
        <button class="btn" data-action="issueChallenge" data-mode="buzzer">🔔 Questions: first to the buzzer</button>
        <button class="btn secondary" data-action="issueChallenge" data-mode="game">🎲 Silly game</button>
      ` : `
        <span class="eyebrow">⚔️ Who does ${esc(from.name)} challenge?</span>
        <div class="row" style="flex-wrap:wrap">
          ${g.players.filter((p) => p.id !== from.id).map((p) => `<button class="btn secondary" ${small} data-action="pickOpponent" data-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')}
        </div>`}
      <button class="link-btn" data-action="openChallenge" data-id="${esc(from.id)}" style="align-self:center">Not now</button>
    </div>`;
  }
  return `<div class="row" style="flex-wrap:wrap;gap:8px">
    ${mine.map((p) => `<button class="chip challenge-chip" data-action="openChallenge" data-id="${esc(p.id)}">⚔️ ${mine.length > 1 || g.is_host ? `${esc(p.name)}'s ` : ''}Challenge card</button>`).join('')}
  </div>`;
}

function buzzerBody(ch) {
  const idx = buzzRound(ch);
  const mine = duelists(ch).filter((id) => (mpPlayer(id) || {}).mine);
  const last = (ch.rounds || []).filter((r) => r.resolved).pop();
  const lastLine = last ? `<p class="notice">Round ${last.idx}: ${last.winner ? `${esc(mpPlayer(last.winner).name)} buzzed in first! 🔔` : 'nobody got it.'}</p>` : '';
  if (!idx) return lastLine;
  const left = buzzSecondsLeft(ch);
  const blocks = mine.map((id) => {
    const q = buzzQuestion(ch, id, idx);
    const p = mpPlayer(id);
    if (q.answered) {
      return `<p class="sticker" style="align-self:flex-start;background:var(--wrong);font-size:22px;transform:rotate(-2deg)">${mine.length > 1 ? `${esc(p.name)}: ` : ''}Wrong! Locked out this round</p>`;
    }
    return `
      ${mine.length > 1 ? `<span class="eyebrow">${esc(p.name)}'s question</span>` : ''}
      <p class="muted" style="font-weight:700;margin:0">${esc(q.topic)}</p>
      <h1 class="question">${esc(q.text)}</h1>
      <div class="choices" role="group" aria-label="Answers">
        ${q.choices.map((c) => `<button class="choice" data-action="buzz" data-id="${esc(id)}" data-value="${esc(c)}" ${mp.busy ? 'disabled' : ''}>${esc(c)}</button>`).join('')}
      </div>`;
  }).join('');
  return `
    ${lastLine}
    <div class="row" style="justify-content:space-between">
      <p style="font-family:var(--display);font-size:22px">Round ${idx} of 3</p>
      <div id="buzz-timer" class="timer ${left <= 5 ? 'low' : ''}" role="timer" aria-label="Seconds left">${left}</div>
    </div>
    ${blocks || `<p class="muted" style="font-weight:700;text-align:center">Both are racing to answer…</p>`}`;
}

function duelGameBody(ch) {
  const id = duelGamePlayer(ch);
  if (!id) {
    const playing = duelists(ch).some((x) => (mpPlayer(x) || {}).mine);
    return `<p class="muted" style="font-weight:700;text-align:center">${playing ? 'Done! Waiting for the other player…' : 'Both are playing…'}</p>`;
  }
  const p = mpPlayer(id);
  const key = `duel:${ch.id}:${id}`;
  const m = useMini(key, ch.minigame, mp.mini && mp.mini.key === key ? mp.mini.tries : [], duelRecord);
  m.player = id;
  return `<div class="card stack" style="gap:10px">
    ${duelists(ch).every((x) => (mpPlayer(x) || {}).mine) ? `<span class="eyebrow">${esc(p.name)}'s turn</span>` : ''}
    ${miniPlay(m, true)}
  </div>`;
}

// While a duel is on, it takes over every phone: the two players play, everyone else watches.
function duelScreen(g) {
  const ch = g.challenge;
  return `
    <div class="topbar"><span class="chip duel-chip">⚔️ ${duelKind(ch)}</span></div>
    ${duelScores(ch)}
    ${ch.mode === 'game' ? duelGameBody(ch) : buzzerBody(ch)}
    ${mpNotes()}
    ${g.is_host ? '<button class="link-btn" data-action="cancelChallenge" style="align-self:center">Call off the duel</button>' : ''}
    <div class="spacer"></div>
    <details><summary class="eyebrow" style="cursor:pointer">Scores</summary>${scoreboard(g.players)}</details>
    ${endLink(g)}
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
      mp.error = 'Not this time. Ask a grown-up to try again.';
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

// Picture questions start zoomed in or blurred and come clear over PIC_REVEAL_MS, the same on every
// phone because it runs from when the question was asked.
const PIC_REVEAL_MS = 20000;

function picStyle(q, done) {
  const p = done ? 1 : Math.min(1, Math.max(0, (Date.now() - new Date(q.asked_at).getTime()) / PIC_REVEAL_MS));
  if ((q.media || {}).reveal === 'blur') return `filter:blur(${(18 * (1 - p)).toFixed(1)}px)`;
  const n = parseInt(String(q.id).replace(/[^0-9a-f]/gi, '').slice(0, 4), 16) || 0;
  return `transform:scale(${(4 - 3 * p).toFixed(3)});transform-origin:${30 + (n % 41)}% ${30 + ((n >> 6) % 41)}%`;
}

function picture(q, done) {
  return `<div class="pic"><img id="mp-pic" src="${esc(q.media_url)}" alt="" style="${picStyle(q, done)}"></div>`;
}

function tickMp() {
  tickMoles();
  const pic = document.getElementById('mp-pic');
  const pq = mp.game && mp.game.question;
  if (pic && pq && !pq.revealed && !pq.answers.length) pic.setAttribute('style', picStyle(pq, false));
  const ch = mp.game && mp.game.challenge;
  const buzzEl = document.getElementById('buzz-timer');
  if (buzzEl && ch && ch.status === 'playing' && ch.mode === 'buzzer' && buzzRound(ch)) {
    const left = buzzSecondsLeft(ch);
    buzzEl.textContent = left;
    buzzEl.classList.toggle('low', left <= 5);
    if (left === 0 && !mp.busy) buzzTimeout(ch);
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
      ${!isFullAccount() ? '<p class="muted" style="font-size:15px">A grown-up in the game will be asked to say it\'s you.</p>' : ''}
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
      <h1>Waiting for a grown-up to let you in</h1>
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
      <p style="font-weight:700">${g.is_host ? 'Everyone opens the app, taps Join a game and types this code.' : `Waiting for ${esc(g.host_name || 'the game')} to start.`}</p>
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
  if (mp.clip && mp.clip.qid !== q.id) stopClip();
  if (g.challenge && g.challenge.status === 'playing') return duelScreen(g);
  const player = mpPlayer(q.player_id) || { name: 'Everyone' };
  const answer = q.answers.find((a) => a.player_id === q.player_id);
  const myTurn = player.mine;
  const left = mpSecondsLeft();
  const isLast = q.seq >= g.total;

  const hum = (q.media || {}).mode === 'hum';
  const song = hum && q.answer ? `${esc(q.answer)}${q.media.by ? ` <span class="muted" style="font-size:18px">· ${esc(q.media.by)}</span>` : ''}` : '';
  let body = '';
  if (hum && answer) {
    const guesser = mpPlayer((q.answers.find((a) => a.player_id !== q.player_id && a.is_correct) || {}).player_id);
    body = `
      <div class="card stack" style="gap:4px"><span class="eyebrow">The song was</span><span class="answer-reveal">${song}</span></div>
      <p class="sticker" style="align-self:flex-start;background:${guesser ? 'var(--lime)' : 'var(--wrong)'};font-size:24px;transform:rotate(-2deg)">${guesser ? `${esc(guesser.name)} got it! +2, and ${esc(player.name)} +1` : 'Nobody got it'}</p>`;
  } else if (hum) {
    body = myTurn
      ? `<div class="card stack hum-card" style="gap:6px"><span class="eyebrow">🎵 Hum this song (only you can see it)</span>
          <span class="answer-reveal">${song}</span>
          <p style="font-weight:700;margin:0">No words! Everyone else shouts their guess.</p></div>`
      : `${q.answer ? `<div class="card stack" style="gap:4px"><span class="eyebrow">Song (only you can see this)</span><span class="answer-reveal">${song}</span></div>` : ''}
        <p style="font-family:var(--display);font-size:24px">🎵 ${esc(player.name)} is humming… shout your guess!</p>`;
  } else if (answer) {
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
    body = `<div class="card stack" style="gap:4px"><span class="eyebrow">${q.revealed ? 'Answer' : `Answer (${esc(player.name)} can't see this)`}</span><span class="answer-reveal">${esc(q.answer)}</span></div>
      ${q.revealed ? '' : `<p class="muted" style="font-weight:700">${esc(player.name)} says their answer out loud.</p>`}`;
  } else {
    body = `<p class="muted" style="font-weight:700">${myTurn ? `Say your answer out loud for ${POINTS_STRAIGHT} points.` : `${esc(player.name)} is answering out loud.`}</p>`;
  }

  const bonus = answer && g.bonus && g.bonus.player_id === q.player_id ? g.bonus : null;
  if (bonus) body += bonusPanel(g, player);

  let footer = '';
  if (hum && !answer) {
    if (q.can_judge) {
      footer = `<p class="judge-q">Who guessed it?</p>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${g.players.filter((p) => p.id !== q.player_id).map((p) => `<button class="btn good" style="width:auto;padding:0 16px;min-height:48px;font-size:20px" data-action="humGuess" data-id="${esc(p.id)}" ${mp.busy ? 'disabled' : ''}>${esc(p.name)}</button>`).join('')}
        </div>
        <button class="btn secondary" data-action="humGuess" data-id="" ${mp.busy ? 'disabled' : ''}>Nobody got it</button>`;
    }
  } else if (answer) {
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
    if (!q.choices_shown) {
      // Anyone on another phone marks a spoken answer. With everyone on one phone, show the answer and
      // mark it there.
      if (q.can_judge) footer += judgeButtons(player.name, 'markRight', 'markWrong', mp.busy);
      else if (g.is_host && !q.others_can_judge) footer += `<button class="btn" data-action="revealMp" ${mp.busy ? 'disabled' : ''}>Show answer</button>`;
      else if (myTurn) footer += '<p class="muted" style="font-weight:700;text-align:center">Someone else will mark your answer.</p>';
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
    ${q.media_url ? picture(q, Boolean(answer || q.revealed)) : ''}
    ${(q.media || {}).mode === 'clip' ? clipPanel(g, q, Boolean(answer || q.revealed)) : ''}
    ${body}
    ${mpNotes()}
    ${footer}
    ${challengeCards(g)}
    <div class="spacer"></div>
    <details><summary class="eyebrow" style="cursor:pointer">Scores</summary>${scoreboard(g.players, q.player_id)}</details>
    ${endLink(g)}
  `;
}

// Anyone playing on their own account can end the game for everyone; kids' devices can leave.
function endLink(g) {
  return g.is_host || isFullAccount()
    ? '<button class="link-btn" data-action="endMp" style="align-self:center">End game</button>'
    : '<button class="link-btn" data-action="leaveMp" style="align-self:center">Leave game</button>';
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
