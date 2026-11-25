// Phone features the iOS and Android apps add on top of the web quiz. In a browser every call
// quietly falls back (share sheet, clipboard) or does nothing, so the web app is unchanged.

const CAP = window.Capacitor;
const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
const PLUGINS = (CAP && CAP.Plugins) || {};

// Where the web app lives. Inside the app the page address is capacitor://localhost, so links
// that other people open (watch links, sign-up and password emails) must point here instead.
const WEB_URL = 'https://familyquiz.app/';

const quietly = (fn) => { try { const p = fn(); if (p && p.catch) p.catch(() => {}); } catch { /* plugin missing */ } };

// The address of this page as other people should see it.
function publicPageUrl() {
  return NATIVE ? WEB_URL : location.origin + location.pathname;
}

// A short vibration: 'right' and 'wrong' after the quiz master marks an answer, 'tap' for small things.
function buzz(kind) {
  if (!NATIVE || !PLUGINS.Haptics) return;
  if (kind === 'tap') quietly(() => PLUGINS.Haptics.impact({ style: 'LIGHT' }));
  else quietly(() => PLUGINS.Haptics.notification({ type: kind === 'right' ? 'SUCCESS' : 'ERROR' }));
}

// Keeps the screen on while a game is running, so the phone doesn't lock as it is passed round.
let awake = false;
function keepAwake(on) {
  if (!NATIVE || !PLUGINS.KeepAwake || on === awake) return;
  awake = on;
  quietly(() => (on ? PLUGINS.KeepAwake.keepAwake() : PLUGINS.KeepAwake.allowSleep()));
}

// Opens the share sheet. Returns false when there is none, so the caller can copy the link instead.
async function shareLink(title, url) {
  if (NATIVE && PLUGINS.Share) {
    try { await PLUGINS.Share.share({ title, url }); } catch { /* sheet closed */ }
    return true;
  }
  if (navigator.share) {
    try { await navigator.share({ title, url }); } catch { /* sheet closed */ }
    return true;
  }
  return false;
}

// One-time setup: hide the splash screen, dark status bar text, and Android's back button goes
// to the home screen before it closes the app.
function startNative() {
  if (!NATIVE) return;
  document.documentElement.classList.add('native');
  if (PLUGINS.StatusBar) quietly(() => PLUGINS.StatusBar.setStyle({ style: 'LIGHT' }));
  if (PLUGINS.SplashScreen) quietly(() => PLUGINS.SplashScreen.hide());
  if (PLUGINS.App) {
    quietly(() => PLUGINS.App.addListener('backButton', () => {
      if (typeof state !== 'undefined' && state.screen !== 'home') {
        state.screen = 'home';
        render();
      } else {
        quietly(() => PLUGINS.App.exitApp());
      }
    }));
  }
}
