// Speech in/out inside the Android app (ADR-015, ADR-016). Same interface as voice.js, so the dialog and cues don't
// know which one they have. (Inside an app, the web view has no Web Speech API.)
//
// Listening uses WISP's own speech module (WispSpeech, android/…/WispSpeechPlugin.java): ONE microphone session stays
// open across listens, so there's no restart beep and no clipped first words between phrases. WISP records the mic
// itself (with echo cancelling) and feeds the phone's recognizer; the module sends one "segment" per phrase (a pause
// of PAUSE_MS ends it). listen() takes the next phrase — one said while WISP was busy waits in a short queue — so
// people can keep talking through the "Okay". The session closes when WISP stops listening for IDLE_CLOSE_MS.
// Echo guard: a phrase that starts while WISP is speaking (or within ECHO_TAIL_MS after) is WISP hearing itself — dropped.
// Speaking uses @capacitor-community/text-to-speech.
//
// plugins: { WispSpeech, TextToSpeech } — the registered Capacitor plugin proxies (fakes in tests).

const QUIET = (p) => p?.catch?.(() => {});
export const SESSION = {
  language: 'en-US', mode: 'single', engine: 'auto', mic: 'app', echoCancel: true, phraseEnd: 'watch', silenceMs: 1500,
};
const IDLE_CLOSE_MS = 1500; // no listen (and no speech) this long: close the mic
const ECHO_TAIL_MS = 400;
const WORDS_GRACE_MS = 4000; // words arrived but no phrase yet: wait this long after the last word before giving up
const QUEUE_MAX = 4;
const QUEUE_MAX_AGE_MS = 15000;

/** onOpen: the mic just opened (once per session) — the app plays its start sound (there's no Android beep). */
export function createNativeVoice({ plugins, log = () => {}, onInterim = () => {}, onOpen = () => {}, now = () => Date.now() }) {
  const SP = plugins.WispSpeech;
  const TTS = plugins.TextToSpeech;
  let permitted = null; // Promise<boolean>, asked once
  let listeners = null; // Promise, added once
  let session = null; // Promise<boolean> while open (or opening)
  let sessionId = null; // the open session's id (events from an earlier one are ignored)
  let stoppingId = null; // a session we asked to stop: its last phrase still counts
  const ours = (id) => id !== undefined && id !== null && (id === sessionId || id === stoppingId);
  let waiter = null; // the listen in progress
  let queue = []; // phrases heard with nobody listening: {text, at}
  let words = false; // partial words of a phrase in progress
  let lastWordAt = 0;
  let phraseEcho = false; // the phrase in progress began while WISP was speaking
  let speaking = 0; // speak() calls in progress
  let spokeUntil = -Infinity; // end of the echo tail after the last speech
  let idleTimer = null;

  const echoing = () => speaking > 0 || now() < spokeUntil;

  function ensurePermission() {
    permitted ??= (async () => {
      try {
        const st = await SP.checkPermissions();
        if (st?.microphone === 'granted') return true;
        const asked = await SP.requestPermissions();
        return asked?.microphone === 'granted';
      } catch (e) {
        log(`permission check failed: ${e?.message ?? e}`);
        return false;
      }
    })();
    return permitted.then((ok) => {
      if (!ok) permitted = null; // ask again next time (the person may change it in Settings)
      return ok;
    });
  }

  function addListeners() {
    listeners ??= Promise.all([
      SP.addListener('partial', ({ text, session: id }) => {
        const t = String(text ?? '').trim();
        if (!t || !ours(id)) return;
        if (!words) phraseEcho = echoing(); // the first words decide: ours or theirs
        words = true;
        lastWordAt = now();
        if (!phraseEcho) onInterim(t);
      }),
      SP.addListener('segment', ({ text, via, session: id }) => {
        if (!ours(id)) return; // e.g. the mic lab's session
        const t = String(text ?? '').trim();
        const echo = words ? phraseEcho : echoing();
        words = false;
        phraseEcho = false;
        if (!t) return;
        if (echo) {
          log(`dropped (heard while speaking): ${t.length} chars`);
          return;
        }
        log(`phrase${via ? ` (${via})` : ''}`);
        onInterim(t);
        if (waiter) waiter.done({ type: 'heard', text: t });
        else {
          queue.push({ text: t, at: now() });
          if (queue.length > QUEUE_MAX) queue.shift();
        }
      }),
      SP.addListener('error', ({ code, name }) => {
        if (name !== 'no-match' && name !== 'no-speech') log(`mic error ${code} ${name}`);
      }),
      SP.addListener('ended', ({ reason, session: id }) => {
        if (id !== sessionId) return; // an earlier session we already let go
        log(`mic closed (${reason})`);
        session = null;
        sessionId = null;
        words = false;
        queue = [];
        const failed = reason && !['stopped', 'cancelled', 'paused', 'destroyed'].includes(reason);
        waiter?.done(failed ? { type: 'error', error: reason } : { type: 'silence', speech: false });
      }),
      SP.addListener('note', ({ text }) => {
        if (/could not|failed|error/i.test(text ?? '')) log(`mic: ${text}`);
      }),
    ]).catch((e) => log(`mic listeners failed: ${e?.message ?? e}`));
    return listeners;
  }

  function openSession() {
    session ??= (async () => {
      await addListeners();
      try {
        const r = await SP.startSession(SESSION);
        sessionId = r?.session ?? null;
        stoppingId = null;
        onOpen();
        log(`mic open (${r?.mode ?? '?'}${r?.mic === 'app' ? ', own mic' : ''}${r?.echoCancel ? ', echo cancel' : ''}${r?.onDevice ? ', on-device' : ''})`);
        return true;
      } catch (e) {
        log(`mic start failed: ${e?.message ?? e}`);
        session = null;
        return false;
      }
    })();
    return session;
  }

  function closeSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (waiter || speaking || !session) return;
      release();
      QUIET(SP.cancelSession());
    }, IDLE_CLOSE_MS);
  }

  /**
   * The next phrase. Gives up (silence) when no words start within timeoutMs; once words have started, waits for the
   * phrase to end.
   * @returns {Promise<{type:"heard", text}|{type:"silence", speech}|{type:"error", error}>}
   */
  async function listen({ timeoutMs }) {
    waiter?.done({ type: 'silence', speech: false }); // never two at once
    clearTimeout(idleTimer);
    const mine = {};
    waiter = mine;
    if (!(await ensurePermission())) {
      if (waiter === mine) waiter = null;
      return { type: 'error', error: 'not-allowed' };
    }
    if (waiter !== mine) return { type: 'silence', speech: false }; // replaced while asking
    if (!(await openSession())) {
      if (waiter === mine) waiter = null;
      return { type: 'error', error: 'mic-start-failed' };
    }
    if (waiter !== mine) return { type: 'silence', speech: false };
    queue = queue.filter((q) => now() - q.at < QUEUE_MAX_AGE_MS);
    if (queue.length) {
      const { text } = queue.shift();
      waiter = null;
      log('heard (said while WISP was busy)');
      closeSoon();
      return { type: 'heard', text };
    }
    log(`listening (${timeoutMs} ms)`);
    return new Promise((resolve) => {
      let timer = null;
      mine.done = (res) => {
        if (mine.settled) return;
        mine.settled = true;
        clearTimeout(timer);
        if (waiter === mine) waiter = null;
        closeSoon();
        resolve(res);
      };
      const check = () => {
        if (mine.settled) return;
        if (words && !phraseEcho && now() - lastWordAt < WORDS_GRACE_MS) {
          timer = setTimeout(check, 500); // someone is mid-phrase: let them finish
          return;
        }
        if (words && !phraseEcho) log('words but no phrase; giving up');
        else log('listen: no speech, giving up');
        mine.done({ type: 'silence', speech: words && !phraseEcho });
      };
      timer = setTimeout(check, timeoutMs);
    });
  }

  /** Forget the open session (we're closing it ourselves). */
  function release() {
    session = null;
    sessionId = null;
    words = false;
    queue = [];
  }

  /** "I'm done talking": the phrase in progress ends now (it still arrives), then the mic closes. */
  function stop() {
    if (!session) return;
    if (!words || phraseEcho) {
      abort(); // nothing being said: done now
      return;
    }
    stoppingId = sessionId;
    session = null;
    sessionId = null;
    QUIET(SP.stopSession()); // the module sends the phrase so far as a segment, then closes
  }

  /** Stop listening now; nothing more arrives. */
  function abort() {
    waiter?.done({ type: 'silence', speech: false });
    const open = session;
    release();
    if (open) QUIET(SP.cancelSession());
  }

  /** Speak text with the phone's voice; always resolves (when done, on error, or after a safety timeout). */
  function speak(text) {
    if (!text) return Promise.resolve();
    speaking += 1;
    clearTimeout(idleTimer);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearTimeout(safety);
        speaking -= 1;
        spokeUntil = now() + ECHO_TAIL_MS;
        if (session && !waiter) closeSoon();
        log(`speech ${why}`);
        resolve();
      };
      const safety = setTimeout(() => finish('timeout'), 5000 + text.length * 90);
      Promise.resolve(TTS.speak({ text, lang: 'en-US', rate: 1.0, pitch: 1.0, volume: 1.0, queueStrategy: 0 }))
        .then(() => finish('end'))
        .catch((e) => finish(`error ${e?.message ?? e}`));
    });
  }

  return {
    supported: true,
    native: true,
    chime: () => Promise.resolve(false),
    listen,
    stop,
    abort,
    speak,
    cancelSpeech: () => QUIET(TTS.stop()),
  };
}
