// Speech in/out inside the Android app (ADR-015): the phone's own recognizer and voice, through Capacitor plugins
// (@capacitor-community/speech-recognition, @capacitor-community/text-to-speech). Same interface as voice.js, so
// the dialog and cues don't know which one they have. (Inside an app, the web view has no Web Speech API.)
//
// plugins: { SpeechRecognition, TextToSpeech } — the registered Capacitor plugin proxies (fakes in tests).

const STOP_QUIETLY = (p) => p?.catch?.(() => {});
const FAST_FAIL_MS = 600; // a failure this soon after start, before any speech, means the mic wasn't ready
const RETRY_MS = 300;
const RETRIES = 3; // attempts per listen
const SETTLE_MS = 250; // gap after one listen ends before the next starts
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function createNativeVoice({ plugins, log = () => {}, onInterim = () => {}, now = () => Date.now() }) {
  const SR = plugins.SpeechRecognition;
  const TTS = plugins.TextToSpeech;
  let active = null; // the listen in progress: {stop, abort}
  let seq = 0; // the newest listen() — an older one still waiting gives way
  let lastEnd = -Infinity; // when the last listen finished (ms)
  let permitted = null; // Promise<boolean>, asked once

  /** Microphone permission: checked, then asked for once. */
  function ensurePermission() {
    permitted ??= (async () => {
      try {
        const now = await SR.checkPermissions();
        if (now?.speechRecognition === 'granted') return true;
        const asked = await SR.requestPermissions();
        return asked?.speechRecognition === 'granted';
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

  /**
   * Listen for one utterance (the final result only: the plugin can't report errors once it streams partial words).
   * 0.7.3 (first app test): the plugin builds a fresh Android recognizer on every start, and on Android 17 a start
   * right after the previous one often fails within milliseconds ("Didn't understand…"). Such a fast failure — before
   * any speech — isn't silence: wait a moment and start again (up to RETRIES times), so lists don't end by themselves.
   * A new listen also ends one still running, so two never overlap.
   * @returns {Promise<{type:"heard", text}|{type:"silence", speech}|{type:"error", error}>}
   */
  async function listen({ timeoutMs }) {
    active?.abort(); // never two at once (e.g. a resume while the permission box was up)
    const mine = ++seq;
    if (!(await ensurePermission())) return { type: 'error', error: 'not-allowed' };
    if (mine !== seq) return { type: 'silence', speech: false }; // replaced while asking for permission
    const rest = SETTLE_MS - (now() - lastEnd);
    if (rest > 0) await wait(rest); // let the last recognizer finish shutting down
    if (mine !== seq) return { type: 'silence', speech: false };
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let handle = null;
      let attempt = 0;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        STOP_QUIETLY(handle?.remove?.());
        if (active === me) active = null;
        lastEnd = now();
        resolve(res);
      };
      const timer = setTimeout(() => {
        if (started) return;
        log('listen: no speech, giving up');
        STOP_QUIETLY(SR.stop());
        done({ type: 'silence', speech: false });
      }, timeoutMs);
      const me = {
        stop: () => STOP_QUIETLY(SR.stop()), // "I'm done talking": the recognizer finishes with what it has
        abort: () => {
          STOP_QUIETLY(SR.stop());
          done({ type: 'silence', speech: started });
        },
      };
      active = me;
      Promise.resolve(SR.addListener('listeningState', (d) => {
        if (d?.status === 'started' && !started && !settled) {
          started = true;
          log('speech start');
        }
      })).then((h) => {
        handle = h;
        if (settled) STOP_QUIETLY(h?.remove?.());
      }).catch(() => {});
      log(`listening (${timeoutMs} ms)`);

      const begin = () => {
        attempt += 1;
        const at = now();
        SR.start({ language: 'en-US', maxResults: 1, partialResults: false, popup: false })
          .then((r) => {
            const text = String(r?.matches?.[0] ?? '').trim();
            if (text) {
              onInterim(text);
              done({ type: 'heard', text });
            } else {
              done({ type: 'silence', speech: started });
            }
          })
          .catch((e) => {
            if (settled) return;
            const msg = String(e?.message ?? e);
            if (/permission/i.test(msg)) {
              log(`recognition error: ${msg}`);
              done({ type: 'error', error: 'not-allowed' });
              return;
            }
            const fast = now() - at < FAST_FAIL_MS && !started;
            if (fast && attempt < RETRIES) {
              log(`mic not ready (${msg}); retrying`);
              setTimeout(() => { if (!settled) begin(); }, RETRY_MS);
              return;
            }
            log(`recognition error: ${msg}`);
            if (/no match|no speech/i.test(msg) || fast) done({ type: 'silence', speech: started });
            else done({ type: 'error', error: msg });
          });
      };
      begin();
    });
  }

  /** Speak text with the phone's voice; always resolves (when done, on error, or after a safety timeout). */
  function speak(text) {
    if (!text) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearTimeout(safety);
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
    stop: () => active?.stop(),
    abort: () => active?.abort(),
    speak,
    cancelSpeech: () => STOP_QUIETLY(TTS.stop()),
  };
}
