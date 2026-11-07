// Mic lab (Phase 3c spike): how does Android's recogniser behave across pauses? Each run logs every recognition
// event with a timestamp so the phone report shows whether one session survives pauses, how often it restarts
// (each start plays Android's own sound, which a web app can't silence), and whether WISP's spoken "Okay" is heard
// back. Runs are diagnostic only: nothing is sent to the backend. Lab runs log the words heard (test phrases only).
//   a — continuous session      b — continuous + spoken "Okay" after each phrase      c — phrase by phrase (today)

export const LAB_RUNS = {
  a: { label: 'A: one long session', continuous: true, sayOkay: false },
  b: { label: 'B: long session + "Okay"', continuous: true, sayOkay: true },
  c: { label: 'C: phrase by phrase', continuous: false, sayOkay: false },
};

export function createMicLab({ win = window, log = () => {}, onState = () => {} } = {}) {
  const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
  let run = null;

  function stop(reason = 'stopped') {
    if (!run) return;
    const r = run;
    run = null;
    clearTimeout(r.timer);
    try { r.rec?.abort(); } catch { /* not running */ }
    try { win.speechSynthesis?.cancel(); } catch { /* ignore */ }
    log(`lab ${r.key}: ${reason} — ${r.starts} start(s), ${r.finals} phrase(s), ${r.echoes} "okay" heard back`);
    onState(null);
  }

  function start(key, { durationMs = 60000 } = {}) {
    stop('replaced');
    const cfg = LAB_RUNS[key];
    if (!cfg || !SR) { log(`lab: ${SR ? 'unknown run' : 'speech recognition unsupported'}`); return; }
    const t0 = win.performance.now();
    const at = () => `+${((win.performance.now() - t0) / 1000).toFixed(1)}s`;
    const r = { key, starts: 0, finals: 0, echoes: 0, rec: null, timer: null, speaking: false };
    run = r;
    onState(key);
    log(`lab ${key}: ${cfg.label} for ${durationMs / 1000}s`);
    r.timer = setTimeout(() => stop('time up'), durationMs);

    const sayOkay = () => {
      const synth = win.speechSynthesis;
      if (!synth) return;
      const u = new win.SpeechSynthesisUtterance('Okay.');
      u.lang = 'en-US';
      u.onstart = () => { r.speaking = true; log(`lab ${at()} said "Okay" (start)`); };
      u.onend = () => { r.speaking = false; log(`lab ${at()} said "Okay" (end)`); };
      synth.speak(u);
    };

    const open = () => {
      if (run !== r) return;
      const rec = new SR();
      r.rec = rec;
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = cfg.continuous;
      rec.maxAlternatives = 1;
      const ev = (name) => () => { if (run === r) log(`lab ${at()} ${name}`); };
      rec.onstart = () => { r.starts += 1; if (run === r) log(`lab ${at()} start #${r.starts}`); };
      rec.onaudiostart = ev('audio start');
      rec.onspeechstart = ev('speech start');
      rec.onspeechend = ev('speech end');
      rec.onaudioend = ev('audio end');
      rec.onresult = (e) => {
        if (run !== r) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue;
          const text = e.results[i][0].transcript.trim();
          r.finals += 1;
          const echo = /\bokay\b|\bok\b/i.test(text);
          if (echo) r.echoes += 1;
          log(`lab ${at()} final: "${text}"${r.speaking ? ' (while WISP spoke)' : ''}`);
          if (cfg.sayOkay) setTimeout(() => { if (run === r) sayOkay(); }, 300);
        }
      };
      rec.onerror = (e) => { if (run === r) log(`lab ${at()} error: ${e.error}`); };
      rec.onend = () => {
        if (run !== r) return;
        log(`lab ${at()} end`);
        if (r.starts >= 40) { stop('too many restarts'); return; }
        open(); // keep listening until the run's time is up: each restart is one more Android start sound
      };
      try { rec.start(); } catch (e) { log(`lab ${at()} start failed: ${e.name}`); stop('failed'); }
    };
    open();
  }

  return { start, stop, running: () => run?.key ?? null };
}
