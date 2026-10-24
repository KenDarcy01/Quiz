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
  ['game_players', 'game_questions', 'answers', 'game_events', 'device_requests'].forEach((table) => {
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
  } else if (g.is_host && q.answer) {
    body = `<div class="card stack" style="gap:4px"><span class="eyebrow">Answer (only you can see this)</span><span class="answer-reveal">${esc(q.answer)}</span></div>
      <p class="muted" style="font-weight:700">${esc(player.name)} says their answer out loud.</p>`;
  } else {
    body = `<p class="muted" style="font-weight:700">${myTurn ? `Say your answer out loud for ${POINTS_STRAIGHT} points.` : `${esc(player.name)} is answering out loud.`}</p>`;
  }

  let footer = '';
  if (answer) {
    if (g.is_host) footer = `<button class="btn" data-action="nextMp" ${mp.busy ? 'disabled' : ''}>${isLast ? 'See final scores' : 'Next question'}</button>`;
  } else {
    if (myTurn && !q.choices_shown && q.choices) {
      footer += `<button class="btn secondary" data-action="choicesMp" ${mp.busy ? 'disabled' : ''}>Show choices (${POINTS_CHOICES} point)</button>`;
    }
    if (g.is_host && !q.choices_shown) {
      footer += judgeButtons(player.name, 'markRight', 'markWrong', mp.busy);
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
    <h1 class="question">${esc(q.text)}</h1>
    ${body}
    ${mpNotes()}
    ${footer}
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
