// Talks to the WISP backend. POSTs JSON as text/plain (no CORS preflight). Results are classified so the
// caller can decide: ok → speak; server → speak the error; network → queue and retry; unauthorized → setup.
// The token is attached here and never logged.

/**
 * @param {{url:string, getToken:()=>string|null, fetchFn:typeof fetch, timeoutMs:number, user?:string}} opts
 */
/** Browse-screen changes: answer with the fresh snapshot and the server's timing (ADR-011). */
export const FRESH = Object.freeze({ return_view: true, timing: true });

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
    /** One chunk of a spoken list; `location` is the place carried from earlier chunks (or null). */
    list: (transcript, location, requestId) => post({ transcript, list: { location: location ?? null }, request_id: requestId }),
    answer: (transcript, pending, clarify, requestId) => post({ transcript, pending, clarify, request_id: requestId }),
    /** Undo exactly these saved transactions, all or none (ADR-010). There is deliberately no untargeted undo from the app. */
    undo: (requestId, txnIds, extra = {}) => {
      const ids = (Array.isArray(txnIds) ? txnIds : [txnIds]).filter(Boolean);
      return ids.length
        ? post({ actions: ids.map((id) => ({ intent: 'undo', txn_id: id })), request_id: requestId, ...extra })
        : Promise.resolve({ kind: 'server', error: 'no_txn', data: { reply: "There's nothing to undo." } });
    },
    /** Structured actions from the browse screens' buttons (ADR-011). Never queued offline. */
    actions: (actions, requestId) => post({ actions, request_id: requestId, ...FRESH }),
    /** Read-only snapshot for the browse screens (ADR-011). */
    view: () => post({ view: true }),
    /** Harmless check that the token works (dry-run query: writes nothing). */
    check: () => post({ dry_run: true, actions: [{ intent: 'query', query: { scope: 'all' } }] }),
  };
}
