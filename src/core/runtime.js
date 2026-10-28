// Runtime (rev 3 §C): the one state-mutating boundary.
//
//   command: structuredClone → handler (actor is always the player) → settle facilities (power, order admission)
//            → knowledge.notice → validate → persist → commit → receipt
//   tick:    structuredClone → integrator → notice → validate → persist → commit
//
// Any failure commits nothing: live state and the stored record stay byte-identical
// (T-01). A tick failure pauses simulation and is reported; the next successful command
// resumes it (T-06). Committed state is deep-frozen so nothing can mutate it in place.
//
// Results carry `observed`, the knowledge delta notice() wrote in that transaction. It is
// the only system-to-player channel and is turned into text by the observer; ledger
// entries and vessel events never leave the runtime as notifications.
import { deepFreeze, CommandError } from './shape.js';
import { handle } from './commands.js';
import { validateState } from './validate.js';
import { STATE_VERSION } from './state.js';
import { notice, emptyDelta } from '../domain/knowledge.js';
import { advance, settleFacilities } from '../sim/integrator.js';
import { PLAYER } from '../domain/entities.js';
import { RECORD_VERSION } from './persistence.js';

/**
 * @param record       {worldId, geoHash, geography, state} — a committed (persisted) world
 *                     at the current save revision (there is no migration, S-43)
 * @param persistence  createPersistence(...) instance
 */
export function createRuntime({ content, persistence, record }) {
  const { worldId, geoHash } = record;
  if (record.state?.meta?.version !== STATE_VERSION) throw new Error(`The runtime needs a revision ${STATE_VERSION} save.`);
  const geography = deepFreeze(record.geography);
  let state = deepFreeze(record.state);
  let paused = false, error = null;

  /** `completed`: every run the transaction completed (ticks; commands complete none). */
  function commit(candidate, completed = []) {
    // Arrival is detected against the previous committed actor; nothing else is stored for it.
    const observed = notice(candidate, geography, content, { previous: state.actor, completed });
    validateState(candidate, geography, content);
    persistence.saveDynamic({ worldId, version: RECORD_VERSION, geoHash, savedAt: Date.now(), state: candidate });
    state = deepFreeze(candidate);
    return observed;
  }

  return {
    get state() { return state; },
    get geography() { return geography; },
    get worldId() { return worldId; },
    get status() { return { paused, error }; },

    /** Execute a player request. Returns {ok, receipt, observed} or {ok:false, error, category}. */
    dispatch(request) {
      try {
        if (!request || typeof request !== 'object' || typeof request.type !== 'string') throw new CommandError('Malformed request.', 'request');
        // Requests never choose the actor (T-05): the actor is always the player.
        if ('actor' in request || 'actorId' in request) throw new CommandError('Requests cannot choose who acts.', 'access');
        const candidate = structuredClone(state);
        const ctx = { actorId: PLAYER, geography, content };
        const result = handle(candidate, request, ctx);
        // A command that changes demand, generation, stock or space re-allocates power and admits
        // order batches in the same transaction (PW-03, industrial plan §8.3).
        settleFacilities(candidate, ctx);
        const observed = commit(candidate);
        paused = false; error = null;
        return { ok: true, receipt: { committed: true, kind: result.kind, message: result.message, changes: result.changes ?? {} }, observed };
      } catch (e) {
        const known = e instanceof CommandError;
        return { ok: false, error: known ? e.message : `Not saved: ${e.message}`, category: known ? e.category : 'internal' };
      }
    },

    /** Advance simulation by dt seconds through the full pipeline. Returns {ok, observed} or {ok:false, paused, error}. */
    tick(dt) {
      if (paused) return { ok: false, paused: true, error };
      if (!(Number.isFinite(dt) && dt > 0)) return { ok: true, skipped: true, observed: emptyDelta() };
      try {
        const candidate = structuredClone(state);
        const completed = advance(candidate, dt, { geography, content });
        return { ok: true, observed: commit(candidate, completed) };
      } catch (e) {
        paused = true; error = `Simulation paused: ${e.message}`;
        return { ok: false, paused: true, error };
      }
    }
  };
}
