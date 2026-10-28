// Persistence (S-03, Stage 2 plan §1). Two localStorage keys, crash-consistent without a
// transaction manager:
//
//   geo key  : {version:1, worlds:{[worldId]:{geoHash, geography}}}   frozen geography per world
//   save key : {worldId, version:1, geoHash, savedAt, state}           THE COMMIT MARKER
//
// Ordinary commits write only the save key. World writes never destroy the only valid
// pair before its replacement is committed, and load() never writes anything.
import { hashString, newWorldId } from './rng.js';
import { isObj, has } from './shape.js';

export const KEYS = Object.freeze({ geo: 'starfall.h05.geo.v1', save: 'starfall.h05.save.v1' });
export const RECORD_VERSION = 1;

export class PersistenceError extends Error {
  constructor(message, { step, cause } = {}) { super(message); this.name = 'PersistenceError'; this.step = step; this.cause = cause; }
}

export const geoHashOf = geography => hashString(JSON.stringify(geography));

/** Records for a newly created world. */
export function newWorldRecords(geography, state, worldId = newWorldId()) {
  const geoHash = geoHashOf(geography);
  return {
    worldId,
    geoEntry: { geoHash, geography },
    save: { worldId, version: RECORD_VERSION, geoHash, savedAt: Date.now(), state }
  };
}

function parse(raw) {
  if (raw === null || raw === undefined) return { present: false };
  try { return { present: true, value: JSON.parse(raw) }; } catch { return { present: true, malformed: true }; }
}
const isContainer = v => isObj(v) && v.version === RECORD_VERSION && isObj(v.worlds)
  && Object.values(v.worlds).every(e => isObj(e) && typeof e.geoHash === 'string' && isObj(e.geography));
const isSaveRecord = v => isObj(v) && v.version === RECORD_VERSION && typeof v.worldId === 'string' && typeof v.geoHash === 'string' && isObj(v.state);

/**
 * @param storage  {getItem, setItem, removeItem} — localStorage or a test double
 */
export function createPersistence(storage) {
  const write = (key, value, step) => {
    try { storage.setItem(key, JSON.stringify(value)); }
    catch (e) { throw new PersistenceError(`Could not save (${step}): ${e?.message || e}`, { step, cause: e }); }
  };
  const readContainer = () => {
    const g = parse(storage.getItem(KEYS.geo));
    return g.present && !g.malformed && isContainer(g.value) ? g.value : null;
  };

  return {
    /**
     * Classify what is stored (read-only). Validators receive parsed records and throw
     * on invalid content: {validateGeography(geography), validateState(state, geography)}.
     * With `revision`, a save whose state is another save-schema revision is OUTDATED (from an
     * earlier build; S-43): it is reported before validation and never touched.
     * Returns {status: 'FRESH'|'OK'|'OUTDATED'|'ORPHAN'|'INCONSISTENT', reason?, record?, extraWorlds?}.
     */
    load({ validateGeography, validateState, revision } = {}) {
      const g = parse(storage.getItem(KEYS.geo));
      const s = parse(storage.getItem(KEYS.save));
      const container = g.present && !g.malformed && isContainer(g.value) ? g.value : null;
      if (!s.present) {
        if (!g.present) return { status: 'FRESH' };
        if (container && Object.keys(container.worlds).length === 0) return { status: 'FRESH' };
        if (container) return { status: 'ORPHAN', reason: 'Geography is stored without a saved game.' };
        return { status: 'INCONSISTENT', reason: 'Stored geography is malformed and there is no saved game.' };
      }
      if (s.malformed || !isSaveRecord(s.value)) return { status: 'INCONSISTENT', reason: 'The saved game is malformed or from an unsupported version.' };
      if (!container) return { status: 'INCONSISTENT', reason: g.present ? 'Stored geography is malformed.' : 'The saved game has no stored geography.' };
      const save = s.value;
      const entry = container.worlds[save.worldId];
      if (!entry) return { status: 'INCONSISTENT', reason: 'The saved game\'s world is not in stored geography.' };
      if (entry.geoHash !== save.geoHash || geoHashOf(entry.geography) !== entry.geoHash) return { status: 'INCONSISTENT', reason: 'The saved game and its geography do not match.' };
      if (revision !== undefined && save.state?.meta?.version !== revision) {
        return { status: 'OUTDATED', reason: `The saved game uses save revision ${save.state?.meta?.version ?? 'unknown'}; this build needs revision ${revision}.` };
      }
      try {
        validateGeography?.(entry.geography);
        validateState?.(save.state, entry.geography);
      } catch (e) {
        return { status: 'INCONSISTENT', reason: `The saved game failed validation: ${e.message}` };
      }
      const extraWorlds = Object.keys(container.worlds).filter(id => id !== save.worldId);
      return { status: 'OK', record: { worldId: save.worldId, geoHash: save.geoHash, geography: entry.geography, state: save.state, savedAt: save.savedAt }, extraWorlds };
    },

    /**
     * New world on FRESH storage: (i) geography entry, (ii) save. If (ii) fails the
     * entry is removed again (and the key, when it empties), so the next load is FRESH.
     */
    createWorld({ worldId, geoEntry, save }) {
      const existing = readContainer();
      const worlds = existing ? { ...existing.worlds } : {};
      if (existing && Object.keys(worlds).length) throw new PersistenceError('createWorld requires empty storage', { step: 'precondition' });
      write(KEYS.geo, { version: RECORD_VERSION, worlds: { ...worlds, [worldId]: geoEntry } }, 'geography');
      try { write(KEYS.save, save, 'save'); }
      catch (e) {
        try { storage.removeItem(KEYS.geo); } catch { /* compensation failed: next load is ORPHAN → recovery */ }
        throw e;
      }
    },

    /**
     * Replace a valid world (New game): (i) container with old + new entries, (ii) the
     * new save — the single switch, (iii) cleanup to the new entry only. A failure at
     * (i) or (ii) leaves the old pair loadable; a failure at (iii) is harmless.
     */
    replaceWorld(currentWorldId, { worldId, geoEntry, save }) {
      const existing = readContainer();
      if (!existing || !has(existing.worlds, currentWorldId)) throw new PersistenceError('The current world is not stored; use recovery instead.', { step: 'precondition' });
      write(KEYS.geo, { version: RECORD_VERSION, worlds: { [currentWorldId]: existing.worlds[currentWorldId], [worldId]: geoEntry } }, 'geography');
      write(KEYS.save, save, 'save');
      try { write(KEYS.geo, { version: RECORD_VERSION, worlds: { [worldId]: geoEntry } }, 'cleanup'); return { cleanupPending: false }; }
      catch { return { cleanupPending: true }; }
    },

    /** Reset from ORPHAN/INCONSISTENT after the player confirmed losing the stored records. */
    resetFromRecovery({ worldId, geoEntry, save }) {
      write(KEYS.geo, { version: RECORD_VERSION, worlds: { [worldId]: geoEntry } }, 'geography');
      write(KEYS.save, save, 'save');
    },

    /** Ordinary commit write: the dynamic record only. */
    saveDynamic(record) { write(KEYS.save, record, 'save'); },

    /** Both raw records, untouched, for export (P-06). */
    exportRaw() {
      return { format: 'starfall.h05.export.v1', exportedAt: new Date().toISOString(), keys: { [KEYS.geo]: storage.getItem(KEYS.geo), [KEYS.save]: storage.getItem(KEYS.save) } };
    }
  };
}

/** In-memory storage with injectable failures, for tests and the bench. */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const fail = { setItem: null, removeItem: null };
  return {
    data, fail,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem(k, v) { if (fail.setItem?.(k, v)) throw new Error(`injected setItem failure for ${k}`); data.set(k, String(v)); },
    removeItem(k) { if (fail.removeItem?.(k)) throw new Error(`injected removeItem failure for ${k}`); data.delete(k); },
    snapshot: () => Object.fromEntries(data)
  };
}
