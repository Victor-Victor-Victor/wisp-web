// Phone-only data (ADR-014): the same requests and responses as backend.js, answered on the phone by the shared core
// (web/js/core) and saved in IndexedDB. No server, no token, no AI: anything the rules can't read gets a polite
// "I didn't catch…", and anything new is asked about ("I heard: … Right?").
import { applyRequest } from './core/engine.js';
import { runList } from './core/list.js';
import { parseRules, answerRules } from './core/rules.js';
import { mergeAnswer } from './core/answer.js';
import { mergeChanges, nextState } from './core/state.js';
import { buildView } from './core/view.js';

export const EMPTY = Object.freeze({ items: [], locations: [], lots: [], ledger: [] });
const CANCELLED = 'Okay, cancelled. Nothing saved.';
const FORMAT = 1;

const hasChanges = (c) => c.items.add.length + (c.items.update?.length ?? 0) + c.locations.add.length
  + (c.locations.update?.length ?? 0) + c.lots.add.length + c.lots.update.length + c.ledger.add.length
  + c.ledger.markUndone.length > 0;
const fresh = () => ({ items: [], locations: [], lots: [], ledger: [], config: {} });

/** A state that looks like WISP's: four arrays of objects with ids. */
export function isInventory(s) {
  const rows = (a, id) => Array.isArray(a) && a.every((r) => r && typeof r === 'object' && typeof r[id] === 'string');
  return Boolean(s && rows(s.items, 'item_id') && rows(s.locations, 'location_id') && rows(s.lots, 'lot_id') && rows(s.ledger, 'txn_id'));
}

/**
 * @param store {load(): Promise<state|null>, save(state): Promise}
 * @param now   () => ISO time; clock () => ms
 */
export function createLocalBackend({ store, now = () => new Date().toISOString(), clock = () => Date.now(), user = 'phone' }) {
  let state = null;
  let chain = Promise.resolve();
  const replies = new Map(); // request_id → response (the last 100), like the server's request log

  const load = async () => {
    if (!state) {
      const saved = await store.load();
      state = isInventory(saved) ? { ...saved, config: {} } : fresh();
    }
    return state;
  };
  /** One request at a time (a list chunk and a tap never interleave). */
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const remember = (id, response) => {
    if (!id) return;
    replies.set(id, response);
    if (replies.size > 100) replies.delete(replies.keys().next().value);
  };
  const save = async (next, timing) => {
    const t0 = clock();
    await store.save(strip(next));
    state = next;
    timing.save = clock() - t0;
  };
  const ok = (data, timing, started) => ({ kind: 'ok', data: { ok: true, version: 'local', ...data, timing: { ...timing, total: clock() - started } } });

  async function handle(requestId, fn) {
    return serial(async () => {
      if (requestId && replies.has(requestId)) return { kind: 'ok', data: { ...replies.get(requestId), replayed: true } };
      try {
        const out = await fn(await load());
        if (out.kind === 'ok') remember(requestId, out.data);
        return out;
      } catch (err) {
        return { kind: 'server', error: 'internal', data: { reply: 'Something went wrong on this phone. Nothing was saved.', message: String(err?.message ?? err) } };
      }
    });
  }

  /** Engine actions → response (+ save), the server's actions/transcript path. */
  async function applyActions(st, actions, transcript, timing, started, extra = {}) {
    let t0 = clock();
    const result = applyRequest(st, { actions, transcript }, { now: now(), user });
    timing.engine = clock() - t0;
    let after = st;
    if (result.status === 'ok' && hasChanges(result.changes)) {
      after = nextState(st, result.changes);
      await save(after, timing);
    }
    const { changes, ...rest } = result;
    const summary = result.status === 'ok' && changes.ledger.add.length
      ? { summary: changes.ledger.add.map((r) => r.details?.summary).filter(Boolean).join(' and ') || null } : {};
    t0 = clock();
    const view = extra.returnView ? { view: buildView(after, { user }), fetched_at: now() } : {};
    return ok({ ...rest, ...summary, ...view, parser: extra.parser ?? undefined }, timing, started);
  }

  const parsePhrase = (st, transcript, opts) => parseRules(st, { transcript, ...opts, allowNew: true });

  return {
    /** One piece of a spoken list (and every single command: the app always talks in list mode). */
    list: (transcript, location, requestId, { confirmed = false } = {}) => handle(requestId, async (st) => {
      const started = clock();
      const timing = {};
      let t0 = clock();
      const listLocation = location?.name ? location : null; // may be a new place named earlier in this list
      const p = parsePhrase(st, transcript, { listLocation, list: true })
        ?? { actions: [{ intent: 'unknown' }], answer: null, clarify: null, confidence: 0 };
      timing.rules = clock() - t0;
      const toWrite = [];
      t0 = clock();
      const out = runList(st, p, {
        transcript, listLocation, now: now(), user, confirmed,
        commit: (s, changes) => {
          if (hasChanges(changes)) toWrite.push(changes);
          return nextState(s, changes);
        },
      });
      timing.engine = clock() - t0;
      if (toWrite.length) await save(nextState(st, mergeChanges(toWrite)), timing);
      const errors = p.problem ? [...out.errors, { reply: p.problem }] : out.errors;
      return ok({
        status: 'list', applied: out.applied, held: out.held, errors, location: out.location, reply: out.reply,
        ...(out.data.length ? { data: out.data.length === 1 ? out.data[0] : out.data } : {}),
        txn_id: out.applied.length ? out.applied[out.applied.length - 1].txn_id : null, parser: 'rules',
      }, timing, started);
    }),

    /** An answer to WISP's question. */
    answer: (transcript, pending, clarify, requestId) => handle(requestId, async (st) => {
      const started = clock();
      const timing = {};
      const t0 = clock();
      const parsed = answerRules(st, { transcript, pending, clarify, allowNew: true }) ?? { actions: [], answer: null };
      timing.rules = clock() - t0;
      const merged = mergeAnswer(pending, clarify, parsed);
      if (merged.status === 'cancelled') return ok({ status: 'cancelled', reply: CANCELLED }, timing, started);
      if (merged.status === 'reask') return ok({ status: 'clarify', reply: clarify.question, clarify, pending }, timing, started);
      return applyActions(st, merged.actions, transcript, timing, started, { parser: 'rules' });
    }),

    /** A whole command outside list mode (kept for parity with the server). */
    command: (transcript, requestId) => handle(requestId, async (st) => {
      const started = clock();
      const p = parsePhrase(st, transcript, {});
      if (!p) return ok({ status: 'ok', reply: `I didn't catch "${transcript}".` }, {}, started);
      if (p.actions.every((a) => a.intent === 'cancel')) return ok({ status: 'cancelled', reply: CANCELLED }, {}, started);
      return applyActions(st, p.actions, transcript, {}, started, { parser: 'rules' });
    }),

    /** Structured actions from the browse screens (with the fresh view). */
    actions: (actions, requestId) => handle(requestId, (st) => applyActions(st, actions, '', {}, clock(), { returnView: true })),

    /** Undo exactly these transactions, all or none. */
    undo: (requestId, txnIds, extra = {}) => {
      const ids = (Array.isArray(txnIds) ? txnIds : [txnIds]).filter(Boolean);
      if (!ids.length) return Promise.resolve({ kind: 'server', error: 'no_txn', data: { reply: "There's nothing to undo." } });
      return handle(requestId, (st) => applyActions(st, ids.map((id) => ({ intent: 'undo', txn_id: id })), '', {}, clock(), { returnView: extra.return_view === true }));
    },

    view: () => serial(async () => ({ kind: 'ok', data: { ok: true, status: 'view', view: buildView(await load(), { user }), fetched_at: now() } })),
    check: () => Promise.resolve({ kind: 'ok', data: { ok: true } }),

    // ---------- backup files (⚙ → Data) ----------
    /** The whole inventory as a backup file's text. */
    exportData: () => serial(async () => JSON.stringify({ app: 'wisp', format: FORMAT, exported_at: now(), inventory: strip(await load()) })),
    /** Replace everything with a backup file's contents. Throws a plain-language Error if the file isn't one. */
    importData: (text) => serial(async () => {
      let data;
      try { data = JSON.parse(text); } catch { throw new Error("That file isn't a WISP backup."); }
      if (data?.app !== 'wisp' || !isInventory(data.inventory)) throw new Error("That file isn't a WISP backup.");
      if (data.format > FORMAT) throw new Error('That backup is from a newer WISP. Update the app first.');
      await save({ ...data.inventory, config: {} }, {});
      return { items: data.inventory.items.length, places: data.inventory.locations.length };
    }),
    erase: () => serial(async () => { await save(fresh(), {}); }),
    counts: () => serial(async () => {
      const s = await load();
      return { items: s.items.length, places: s.locations.length, changes: s.ledger.length };
    }),
  };
}

/** Only the four inventory lists are stored. */
function strip(s) {
  return { items: s.items, locations: s.locations, lots: s.lots, ledger: s.ledger };
}

/** In-memory store (tests, and a fallback when IndexedDB is unavailable). */
export function memoryStore(initial = null) {
  let saved = initial ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    load: async () => (saved ? JSON.parse(JSON.stringify(saved)) : null),
    save: async (s) => { saved = JSON.parse(JSON.stringify(s)); },
  };
}

/** IndexedDB store: database "wisp-data", one record for the whole inventory. Asks the browser to keep it. */
export function idbStore(idb, nav = globalThis.navigator) {
  if (!idb) return memoryStore();
  let dbPromise = null;
  const db = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = idb.open('wisp-data', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  let asked = false;
  const persist = () => {
    if (asked) return;
    asked = true;
    nav?.storage?.persist?.().catch(() => {});
  };
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    load: () => tx('readonly', (s) => s.get('inventory')).then((v) => v ?? null),
    save: (state) => {
      persist();
      return tx('readwrite', (s) => s.put(state, 'inventory'));
    },
  };
}
