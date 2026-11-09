// Mic lab (ADR-016, Android app only): runs WISP's own speech module by itself and logs every event with a timestamp,
// so we can measure on the phone how a continuous session behaves — phrases (segments), mic starts ("ready" ≈ the
// beep), restarts, errors — and whether WISP's own "Okay" is heard by the open mic (echo). Everything goes into the
// diagnostics log, so Copy report carries it.

export function createMicLab({ plugin, log, sayOkay, playOkay, playListening, root }) {
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    n.append(...kids);
    return n;
  };
  const pick = (label, id, options, value) => {
    const s = el('select', { id });
    for (const [v, t] of options) s.append(el('option', { value: v, textContent: t }));
    s.value = value;
    return el('label', { className: 'pick' }, label, s);
  };
  // every tap flashes the button, so you can see it went through
  const btn = (text, fn) => el('button', {
    className: 'btn small', type: 'button', textContent: text,
    onclick: (e) => {
      const b = e.currentTarget;
      b.classList.remove('tapped');
      void b.offsetWidth; // restart the flash
      b.classList.add('tapped');
      fn();
    },
  });
  const status = el('p', { className: 'lab-status', textContent: 'Not listening.' });
  const heard = el('p', { className: 'lab-heard', textContent: '' });
  const show = (text, live = false) => {
    status.textContent = text;
    status.classList.toggle('live', live);
  };

  let t0 = 0;
  let counts = null;
  let handles = [];
  let ownMic = false;
  let phrases = [];
  const stamp = () => `${String(Math.round(performance.now() - t0)).padStart(6)}ms`;
  const lab = (msg) => log(`lab ${stamp()} ${msg}`);

  async function listenAll() {
    for (const h of handles) h?.remove?.();
    handles = [];
    const on = async (event, fn) => handles.push(await plugin.addListener(event, fn));
    const live = () => counts && show(`Listening… ${counts.segments} phrases, ${counts.ready} mic starts`, true);
    await on('ready', () => {
      if (!counts) return;
      counts.ready += 1;
      lab(`mic ready${ownMic ? '' : ' (≈ beep)'}`);
      if (counts.ready === 1) playListening?.(); // WISP's own "go ahead" sound
      live();
    });
    await on('speechStart', () => lab('speech start'));
    await on('partial', (d) => {
      lab(`partial: ${d.text}`);
      heard.textContent = [...phrases.map((p) => `• ${p}`), `… ${d.text.trim()}`].join('\n');
    });
    await on('segment', (d) => {
      if (counts) counts.segments += 1;
      lab(`SEGMENT ${counts?.segments ?? '?'}${d.via ? ` (${d.via})` : ''}: "${d.text}"`);
      phrases.push(d.text);
      heard.textContent = phrases.map((p) => `• ${p}`).join('\n');
      live();
    });
    await on('error', (d) => { counts?.errors.push(d.name); lab(`error ${d.code} ${d.name}`); });
    await on('restart', (d) => { if (counts) counts.restarts += 1; lab(`restart (${d.reason})`); });
    await on('note', (d) => lab(`note: ${d.text}`));
    await on('ended', (d) => {
      lab(`ended (${d.reason})`);
      const c = counts;
      summary();
      show(c ? `Stopped (${d.reason}): ${c.segments} phrases, ${c.ready} mic starts.` : `Stopped (${d.reason}).`);
    });
  }

  function summary() {
    if (!counts) return;
    log(`lab summary: ${counts.segments} segments, ${counts.ready} mic starts (≈ beeps), ${counts.restarts} restarts, errors: ${counts.errors.join(', ') || 'none'}`);
    counts = null;
  }

  async function start() {
    const perm = await plugin.checkPermissions().catch(() => ({}));
    if (perm.microphone !== 'granted') {
      const asked = await plugin.requestPermissions().catch(() => ({}));
      if (asked.microphone !== 'granted') {
        log('lab: microphone not allowed');
        show('Microphone not allowed.');
        return;
      }
    }
    if (counts) await stop(true);
    show('Starting…', true);
    heard.textContent = '';
    phrases = [];
    counts = { segments: 0, ready: 0, restarts: 0, errors: [] };
    t0 = performance.now();
    await listenAll();
    const opts = {
      language: 'en-US',
      mode: root.querySelector('#lab-mode').value,
      engine: root.querySelector('#lab-engine').value,
      silenceMs: Number(root.querySelector('#lab-silence').value),
      segmentBy: root.querySelector('#lab-segment').value,
      muteBeep: root.querySelector('#lab-mute').value === 'on',
      mic: root.querySelector('#lab-mic').value,
      echoCancel: root.querySelector('#lab-aec').value === 'on',
      phraseEnd: root.querySelector('#lab-end').value,
    };
    ownMic = opts.mic === 'app';
    try {
      const r = await plugin.startSession(opts);
      ownMic = r.mic === 'app';
      lab(`started: asked ${opts.mode}/${opts.engine}/${opts.silenceMs} ms/end by ${opts.segmentBy}/mute ${opts.muteBeep ? 'on' : 'off'}/mic ${opts.mic}/echo ${opts.echoCancel ? 'on' : 'off'}/phrase end ${opts.phraseEnd}`
        + ` → got ${r.mode}${r.onDevice ? ' on-device' : ' Google default'}, mic ${r.mic}${r.echoCancel ? ', echo cancel' : ''}`);
      show(`Listening (${r.mode}${r.onDevice ? ', on this phone' : ', Google default'})… speak now.`, true);
    } catch (e) {
      lab(`start failed: ${e?.message ?? e}`);
      show(`Could not start: ${e?.message ?? e}`);
      counts = null;
    }
  }

  async function stop(cancel = false) {
    try {
      await (cancel ? plugin.cancelSession() : plugin.stopSession());
      lab(cancel ? 'cancel pressed' : 'stop pressed');
      if (counts) show(cancel ? 'Cancelling…' : 'Stopping…');
    } catch (e) {
      lab(`stop failed: ${e?.message ?? e}`);
    }
  }

  const panel = el('div', { className: 'miclab' },
    el('h3', { textContent: 'Mic lab (app only)' }),
    el('p', { className: 'hint', textContent: 'Tests WISP\'s own microphone module by itself. Follow the steps Claude gave you; everything is logged above.' }),
    pick('Who opens the mic', 'lab-mic', [['app', 'WISP (own mic)'], ['recognizer', 'The recognizer']], 'app'),
    pick('Echo cancel (own mic)', 'lab-aec', [['off', 'Off'], ['on', 'On']], 'on'),
    pick('Phrase end (own mic)', 'lab-end', [['close', 'A: end input after the pause'], ['watch', 'B: watch the words']], 'close'),
    pick('Mode', 'lab-mode', [['continuous', 'Continuous (one session)'], ['single', 'Single (phrase by phrase)']], 'single'),
    pick('Recognizer', 'lab-engine', [['auto', 'Auto'], ['device', 'On this phone'], ['default', 'Google default']], 'device'),
    pick('Pause that ends a phrase', 'lab-silence', [['1000', '1 s'], ['1500', '1.5 s'], ['2000', '2 s']], '1500'),
    pick('Continuous ends after', 'lab-segment', [['length', '10 minutes'], ['silence', '15 s of quiet']], 'length'),
    pick('Mute the start beep', 'lab-mute', [['off', 'Off'], ['on', 'On']], 'off'),
    el('div', { className: 'actions' },
      btn('Start', start),
      btn('Play "Okay" clip', () => { lab('playing the Okay clip'); playOkay(); }),
      btn('Say "Okay" (phone voice)', () => { lab('phone voice says Okay'); sayOkay(); }),
      btn('Stop', () => stop(false)),
      btn('Cancel', () => stop(true))),
    status, heard);
  root.replaceChildren(panel);

  plugin.capabilities?.().then((c) => log(`lab capabilities: sdk ${c.sdk}, available ${c.available}, on-device ${c.onDevice}, continuous ${c.continuous}, mic ${c.microphone}`))
    .catch((e) => log(`lab capabilities failed: ${e?.message ?? e}`));
}
