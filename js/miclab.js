// Mic lab (ADR-016, Android app only): runs WISP's own speech module by itself and logs every event with a timestamp,
// so we can measure on the phone how a continuous session behaves — phrases (segments), mic starts ("ready" ≈ the
// beep), restarts, errors — and whether WISP's own "Okay" is heard by the open mic (echo). Everything goes into the
// diagnostics log, so Copy report carries it.

export function createMicLab({ plugin, log, sayOkay, playOkay, root }) {
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
  const btn = (text, onclick) => el('button', { className: 'btn small', type: 'button', textContent: text, onclick });

  let t0 = 0;
  let counts = null;
  let handles = [];
  const stamp = () => `${String(Math.round(performance.now() - t0)).padStart(6)}ms`;
  const lab = (msg) => log(`lab ${stamp()} ${msg}`);

  async function listenAll() {
    for (const h of handles) h?.remove?.();
    handles = [];
    const on = async (event, fn) => handles.push(await plugin.addListener(event, fn));
    await on('ready', () => { counts.ready += 1; lab('mic ready (≈ beep)'); });
    await on('speechStart', () => lab('speech start'));
    await on('partial', (d) => lab(`partial: ${d.text}`));
    await on('segment', (d) => { counts.segments += 1; lab(`SEGMENT ${counts.segments}: "${d.text}"`); });
    await on('error', (d) => { counts.errors.push(d.name); lab(`error ${d.code} ${d.name}`); });
    await on('restart', (d) => { counts.restarts += 1; lab(`restart (${d.reason})`); });
    await on('ended', (d) => { lab(`ended (${d.reason})`); summary(); });
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
        return;
      }
    }
    if (counts) await stop(true);
    counts = { segments: 0, ready: 0, restarts: 0, errors: [] };
    t0 = performance.now();
    await listenAll();
    const opts = {
      language: 'en-US',
      mode: root.querySelector('#lab-mode').value,
      engine: root.querySelector('#lab-engine').value,
      silenceMs: Number(root.querySelector('#lab-silence').value),
    };
    try {
      const r = await plugin.startSession(opts);
      lab(`started: asked ${opts.mode}/${opts.engine}/${opts.silenceMs} ms → got ${r.mode}${r.onDevice ? ' on-device' : ''}`);
    } catch (e) {
      lab(`start failed: ${e?.message ?? e}`);
      counts = null;
    }
  }

  async function stop(cancel = false) {
    try {
      await (cancel ? plugin.cancelSession() : plugin.stopSession());
      lab(cancel ? 'cancel pressed' : 'stop pressed');
    } catch (e) {
      lab(`stop failed: ${e?.message ?? e}`);
    }
  }

  const panel = el('div', { className: 'miclab' },
    el('h3', { textContent: 'Mic lab (app only)' }),
    el('p', { className: 'hint', textContent: 'Tests WISP\'s own microphone module by itself. Follow the steps Claude gave you; everything is logged above.' }),
    pick('Mode', 'lab-mode', [['continuous', 'Continuous (one session)'], ['single', 'Single (phrase by phrase)']], 'continuous'),
    pick('Recognizer', 'lab-engine', [['auto', 'Auto'], ['device', 'On this phone'], ['default', 'Google default']], 'auto'),
    pick('Pause that ends a phrase', 'lab-silence', [['1000', '1 s'], ['1500', '1.5 s'], ['2000', '2 s']], '1500'),
    el('div', { className: 'actions' },
      btn('Start', start),
      btn('Play "Okay" clip', () => { lab('playing the Okay clip'); playOkay(); }),
      btn('Say "Okay" (phone voice)', () => { lab('phone voice says Okay'); sayOkay(); }),
      btn('Stop', () => stop(false)),
      btn('Cancel', () => stop(true))));
  root.replaceChildren(panel);

  plugin.capabilities?.().then((c) => log(`lab capabilities: sdk ${c.sdk}, available ${c.available}, on-device ${c.onDevice}, continuous ${c.continuous}, mic ${c.microphone}`))
    .catch((e) => log(`lab capabilities failed: ${e?.message ?? e}`));
}
