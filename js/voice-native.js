// Speech in/out inside the Android app (ADR-015): the phone's own recognizer and voice, through Capacitor plugins
// (@capacitor-community/speech-recognition, @capacitor-community/text-to-speech). Same interface as voice.js, so
// the dialog and cues don't know which one they have. (Inside an app, the web view has no Web Speech API.)
//
// plugins: { SpeechRecognition, TextToSpeech } — the registered Capacitor plugin proxies (fakes in tests).

const STOP_QUIETLY = (p) => p?.catch?.(() => {});

export function createNativeVoice({ plugins, log = () => {}, onInterim = () => {} }) {
  const SR = plugins.SpeechRecognition;
  const TTS = plugins.TextToSpeech;
  let active = null; // the listen in progress: {stop, abort}
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
   * @returns {Promise<{type:"heard", text}|{type:"silence", speech}|{type:"error", error}>}
   */
  async function listen({ timeoutMs }) {
    if (!(await ensurePermission())) return { type: 'error', error: 'not-allowed' };
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let handle = null;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        STOP_QUIETLY(handle?.remove?.());
        active = null;
        resolve(res);
      };
      const timer = setTimeout(() => {
        if (started) return;
        log('listen: no speech, giving up');
        STOP_QUIETLY(SR.stop());
        done({ type: 'silence', speech: false });
      }, timeoutMs);
      active = {
        stop: () => STOP_QUIETLY(SR.stop()), // "I'm done talking": the recognizer finishes with what it has
        abort: () => {
          STOP_QUIETLY(SR.stop());
          done({ type: 'silence', speech: started });
        },
      };
      Promise.resolve(SR.addListener('listeningState', (d) => {
        if (d?.status === 'started' && !started) {
          started = true;
          log('speech start');
        }
      })).then((h) => {
        handle = h;
        if (settled) STOP_QUIETLY(h?.remove?.());
      }).catch(() => {});
      log(`listening (${timeoutMs} ms)`);
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
          const msg = String(e?.message ?? e);
          log(`recognition error: ${msg}`);
          if (/no match|no speech/i.test(msg)) done({ type: 'silence', speech: started });
          else if (/permission/i.test(msg)) done({ type: 'error', error: 'not-allowed' });
          else done({ type: 'error', error: msg });
        });
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
