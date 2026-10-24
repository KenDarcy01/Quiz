// Sign-in and profiles with Supabase Auth. Signing in is optional: the pass-the-phone game works without it.

const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const auth = {
  user: null,     // the signed-in Supabase user, or null
  profile: null,  // their own profile row
  kids: [],       // child profiles they manage
  mode: 'signin', // signed-out form: 'signin' | 'signup' | 'reset'
  busy: false,
  message: '',    // a note for the person, such as "Check your email"
  error: '',
  confirmDelete: false,
  form: { name: '', email: '' }, // kept so a failed attempt doesn't wipe what was typed
};

function friendlyAuthError(e) {
  const m = (e && e.message) || String(e);
  if (/invalid login credentials/i.test(m)) return 'That email and password don\'t match.';
  if (/email not confirmed/i.test(m)) return 'Tap the link in your confirmation email first.';
  if (/already registered/i.test(m)) return 'There\'s already an account with that email. Sign in instead.';
  if (/password should be at least/i.test(m)) return 'Use at least 6 characters for the password.';
  if (/load failed|failed to fetch|network/i.test(m)) return 'Couldn\'t reach the sign-in service. Check your connection and try again.';
  return m;
}

async function loadAccount() {
  if (!sb || !auth.user || auth.user.is_anonymous) {
    auth.profile = null;
    auth.kids = [];
    return;
  }
  const { data, error } = await sb.from('profiles')
    .select('id, user_id, owner_id, display_name, age, created_at')
    .eq('owner_id', auth.user.id)
    .order('created_at');
  if (error) { auth.error = friendlyAuthError(error); return; }
  auth.profile = data.find((p) => p.user_id === auth.user.id) || null;
  auth.kids = data.filter((p) => !p.user_id);
}

const isNetworkError = (e) => /load failed|failed to fetch|network/i.test((e && e.message) || String(e));

// Runs an auth action with the busy flag and error handling, then redraws.
// A dropped connection gets one quiet retry before the person sees an error.
async function authStep(fn) {
  auth.busy = true;
  auth.error = '';
  auth.message = '';
  render();
  try {
    try {
      await fn();
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      await fn();
    }
  } catch (e) {
    auth.error = friendlyAuthError(e);
  }
  auth.busy = false;
  render();
}

function signIn(email, password) {
  return authStep(async () => {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  });
}

function signUp(name, email, password) {
  return authStep(async () => {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { full_name: name }, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
    if (!data.session) {
      auth.mode = 'signin';
      auth.message = `Nearly there: tap the link we sent to ${email}, then sign in.`;
    }
  });
}

function sendReset(email) {
  return authStep(async () => {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) throw error;
    auth.mode = 'signin';
    auth.message = `We sent a link to ${email} to set a new password.`;
  });
}

function setNewPassword(password) {
  return authStep(async () => {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
    auth.message = 'Password changed.';
    state.screen = 'account';
  });
}

function signOut() {
  return authStep(async () => {
    await sb.auth.signOut();
    auth.confirmDelete = false;
  });
}

function saveProfile(name, age) {
  return authStep(async () => {
    const { error } = await sb.from('profiles').update({ display_name: name, age }).eq('id', auth.profile.id);
    if (error) throw error;
    await loadAccount();
    auth.message = 'Saved.';
  });
}

function addKid(name, age) {
  return authStep(async () => {
    const { error } = await sb.from('profiles').insert({ display_name: name, age, owner_id: auth.user.id });
    if (error) throw error;
    await loadAccount();
  });
}

function removeKid(id) {
  return authStep(async () => {
    const { error } = await sb.from('profiles').delete().eq('id', id);
    if (error) throw error;
    await loadAccount();
  });
}

function deleteAccount() {
  return authStep(async () => {
    const { error } = await sb.functions.invoke('delete-account', { method: 'POST' });
    if (error) throw error;
    await sb.auth.signOut();
    auth.confirmDelete = false;
    auth.message = 'Your account and everything in it has been deleted.';
  });
}

function startAuth() {
  if (!sb) return;
  sb.auth.onAuthStateChange((event, session) => {
    auth.user = session ? session.user : null;
    if (event === 'PASSWORD_RECOVERY') state.screen = 'newPassword';
    // Supabase calls this inside its own lock, so load the profile afterwards.
    setTimeout(async () => {
      await loadAccount();
      render();
    }, 0);
  });
}
