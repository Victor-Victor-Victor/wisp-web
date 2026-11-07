// Talks to the WISP backend. POSTs JSON as text/plain (no CORS preflight). Results are classified so the
// caller can decide: ok → speak; server → speak the error; network → queue and retry; unauthorized → setup.
// The token is attached here and never logged.

/**
 * @param {{url:string, getToken:()=>string|null, fetchFn:typeof fetch, timeoutMs:number, user?:string}} opts
 */
export function createBackend({ url, getToken, fetchFn, timeoutMs, user = 'phone' }) {
  async function post(body) {
    const token = getToken();
    if (!token) return { kind: 'unauthorized', error: 'no_token' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...body, token, user }),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { kind: 'server', error: 'bad_response', data: { reply: 'The inventory sent a reply I could not read. Nothing was saved.' } };
      }
      if (data.ok) return { kind: 'ok', data };
      if (data.error === 'unauthorized' || data.error === 'server_not_configured') return { kind: 'unauthorized', error: data.error, data };
      return { kind: 'server', error: data.error, data };
    } catch (err) {
      return { kind: 'network', error: err?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    command: (transcript, requestId) => post({ transcript, request_id: requestId }),
    answer: (transcript, pending, clarify, requestId) => post({ transcript, pending, clarify, request_id: requestId }),
    undo: (requestId) => post({ actions: [{ intent: 'undo' }], request_id: requestId }),
    /** Harmless check that the token works (dry-run query: writes nothing). */
    check: () => post({ dry_run: true, actions: [{ intent: 'query', query: { scope: 'all' } }] }),
  };
}
