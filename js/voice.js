// Speech in/out for WISP, wrapped as promises: Web Speech recognition, speechSynthesis, and a WebAudio chime.
// (Proven on the Pixel in the Phase 0 spike: installed, it listens and speaks with no tap.)

export function createVoice({ win = window, log = () => {}, onInterim = () => {} } = {}) {
  const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
  let rec = null;
  let audioCtx = null;

  /** Short two-note chime. Resolves once it has (mostly) played so the mic doesn't hear it. */
  function chime() {
    try {
      audioCtx ??= new win.AudioContext();
      if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
      if (audioCtx.state !== 'running') return Promise.resolve(false);
      const t = audioCtx.currentTime + 0.01;
      for (const [freq, at, dur] of [[880, 0, 0.12], [1320, 0.07, 0.14]]) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t + at);
        osc.stop(t + at + dur + 0.02);
      }
      return new Promise((r) => setTimeout(() => r(true), 250));
    } catch (e) {
      log(`chime error: ${e.name}`);
      return Promise.resolve(false);
    }
  }

  /**
   * Listen for one utterance.
   * @returns {Promise<{type:"heard", text}|{type:"silence"}|{type:"error", error}>}
   * Gives up with "silence" if no speech *starts* within timeoutMs.
   */
  function listen({ timeoutMs }) {
    return new Promise((resolve) => {
      if (!SR) {
        resolve({ type: 'error', error: 'unsupported' });
        return;
      }
      const r = new SR();
      rec = r;
      r.lang = 'en-US';
      r.interimResults = true;
      r.continuous = false;
      r.maxAlternatives = 1;
      let finalText = '';
      let started = false;
      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (rec === r) rec = null;
        resolve(res);
      };
      const timer = setTimeout(() => {
        if (started) return;
        log('listen: no speech, giving up');
        try { r.abort(); } catch { /* already stopped */ }
        done({ type: 'silence' });
      }, timeoutMs);
      r.onspeechstart = () => {
        started = true;
        log('speech start');
      };
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        onInterim(finalText + interim);
      };
      r.onerror = (e) => {
        log(`recognition error: ${e.error}`);
        if (e.error === 'no-speech' || e.error === 'aborted') done({ type: 'silence' });
        else done({ type: 'error', error: e.error });
      };
      r.onend = () => done(finalText.trim() ? { type: 'heard', text: finalText.trim() } : { type: 'silence' });
      try {
        r.start();
        log(`listening (${timeoutMs} ms)`);
      } catch (e) {
        done({ type: 'error', error: e.name });
      }
    });
  }

  /** Speak text; always resolves (on end, error, or a safety timeout if speech never starts). */
  function speak(text) {
    return new Promise((resolve) => {
      const synth = win.speechSynthesis;
      if (!synth || !text) {
        resolve();
        return;
      }
      if (synth.speaking || synth.pending) synth.cancel();
      const u = new win.SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearTimeout(safety);
        log(`speech ${why}`);
        resolve();
      };
      const safety = setTimeout(() => finish('timeout'), 5000 + text.length * 90);
      u.onend = () => finish('end');
      u.onerror = (e) => finish(`error ${e.error}`);
      synth.speak(u);
    });
  }

  return {
    supported: Boolean(SR),
    chime,
    listen,
    stop: () => { try { rec?.stop(); } catch { /* not running */ } },
    abort: () => { try { rec?.abort(); } catch { /* not running */ } },
    speak,
    cancelSpeech: () => { try { win.speechSynthesis?.cancel(); } catch { /* ignore */ } },
  };
}
