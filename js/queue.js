// Offline queue (spec §9): commands that couldn't reach the backend are kept and retried later, in order.
// Each keeps its original request id, so if the first attempt actually reached the server, the retry is
// answered from the server's request log instead of being applied twice.

/** @param store {getAll():Promise<object[]>, put(item):Promise, remove(id):Promise} */
export function createQueue(store) {
  let draining = false;
  return {
    async enqueue({ transcript, requestId, location = null }, now = Date.now()) {
      const item = { id: requestId, transcript, location, at: now };
      await store.put(item);
      return item;
    },
    async size() {
      return (await store.getAll()).length;
    },
    /**
     * Send queued commands oldest-first. Stops at the first network failure (still offline).
     * @param send  (item) => backend result ({kind, data})
     * @returns {Promise<Array<{item, result}>>} results for the items that left the queue
     */
    async drain(send) {
      if (draining) return [];
      draining = true;
      const done = [];
      try {
        const items = (await store.getAll()).sort((a, b) => a.at - b.at);
        for (const item of items) {
          const result = await send(item);
          if (result.kind === 'network') break;
          await store.remove(item.id);
          done.push({ item, result });
        }
      } finally {
        draining = false;
      }
      return done;
    },
  };
}

/**
 * What to show for a drained item: "saved" notices and things that need the user's attention.
 * Handles list replies (applied / held / errors) and plain replies.
 * @returns {Array<{kind:"saved", text} | {kind:"attention", transcript, text}>}
 */
export function describeDrained({ item, result }) {
  const d = result.data ?? {};
  const attention = (text) => ({ kind: 'attention', transcript: item.transcript, text });
  if (result.kind === 'ok' && d.status === 'list') {
    return [
      ...(d.applied ?? []).map((a) => ({ kind: 'saved', text: `Saved earlier: ${a.summary ?? a.reply}` })),
      ...(d.held ?? []).map((h) => attention(`WISP needs to ask: ${h.question}`)),
      ...(d.errors ?? []).map((e) => attention(e.reply)),
    ];
  }
  if (result.kind === 'ok' && d.status === 'ok') return [{ kind: 'saved', text: `Saved earlier: ${d.reply}` }];
  if (d.status === 'clarify') return [attention(`WISP needs to ask: ${d.reply}`)];
  return [attention(d.reply || (result.kind === 'unauthorized' ? "This phone isn't set up." : 'Something went wrong.'))];
}

export function memoryStore() {
  const map = new Map();
  return {
    async getAll() { return [...map.values()]; },
    async put(item) { map.set(item.id, item); },
    async remove(id) { map.delete(id); },
  };
}

/** IndexedDB-backed store ("wisp" db, "queue" object store). Falls back to memory if IndexedDB is unavailable. */
export function indexedDbStore(idb) {
  if (!idb) return memoryStore();
  let dbPromise = null;
  const db = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = idb.open('wisp', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('queue', mode);
      const r = fn(t.objectStore('queue'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    getAll: () => tx('readonly', (s) => s.getAll()),
    put: (item) => tx('readwrite', (s) => s.put(item)),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),
  };
}
