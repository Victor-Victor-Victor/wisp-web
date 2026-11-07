// Phone setup: the shared token arrives once via a link like …/wisp-web/#setup=<token> (from the QR code on
// the PC). The part after # is never sent to any server. It is stored in localStorage and removed from the URL.
const KEY = 'wisp.token';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** "#setup=abc…" → "abc…" when it looks like a token; otherwise null. */
export function readSetupHash(hash) {
  const m = /^#setup=([^&]+)$/.exec(String(hash ?? ''));
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  return TOKEN_RE.test(token) ? token : null;
}

export function isPlausibleToken(token) {
  return TOKEN_RE.test(String(token ?? '').trim());
}

/** localStorage wrapper that never throws (private mode, blocked storage). */
export function createTokenStore(storage) {
  return {
    get() {
      try { return storage?.getItem(KEY) || null; } catch { return null; }
    },
    set(token) {
      try { storage?.setItem(KEY, token); return true; } catch { return false; }
    },
    clear() {
      try { storage?.removeItem(KEY); } catch { /* ignore */ }
    },
  };
}

/**
 * If the page was opened with a setup link: store the token and strip it from the address bar/history.
 * @returns {"stored"|"invalid"|null}
 */
export function consumeSetupHash(location, history, store) {
  if (!String(location.hash ?? '').startsWith('#setup=')) return null;
  const token = readSetupHash(location.hash);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  if (!token) return 'invalid';
  return store.set(token) ? 'stored' : 'invalid';
}
