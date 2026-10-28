// Character and NPC presence (rev 3 §F). Sole writer of the `actor` and `npcs` slices.
// On-foot movement between Local Places of the occupied host arrives in Stage 4 (S-31);
// board and disembark arrive with character travel in Stage 6. Selection, inspection,
// camera changes and every vessel operation never touch these slices (K-05, V-05).
import { check, isObj, isSafeId, CommandError } from '../core/shape.js';
import { siteOf, authoredSite } from './world.js';
import { leaseOf, runLabel } from './work.js';

export function initialActor(content) {
  const { hostId, placeId } = content.world.start;
  return { hostId, placeId };
}

export function initialNpcs() { return {}; }

/**
 * Why the character cannot walk to a place on the occupied host now, or ''. Requires a
 * geography connection from the current place, an active host, and no personal-work lease
 * (L-01, I-05). Sealed or destroyed places need a place-condition owner, which arrives with
 * the first content that seals a place.
 */
export function moveBlocker(state, ctx, placeId) {
  const a = state.actor;
  const host = siteOf(state, ctx.geography, a.hostId);
  if (!host || !Object.hasOwn(host.places, placeId)) return { category: 'request', reason: 'There is no such place here.' };
  if (placeId === a.placeId) return { category: 'request', reason: 'You are already there.' };
  if (!host.places[a.placeId].connections.includes(placeId)) return { category: 'access', reason: 'There is no passage from here to there.' };
  if (state.entities[a.hostId]?.lifecycle !== 'active') return { category: 'access', reason: 'This location is not operational.' };
  const lease = leaseOf(state, ctx.actorId);
  if (lease) return { category: 'timing', reason: `You are busy: ${runLabel(state, ctx.content, lease.run).toLowerCase()}. Finish or cancel it first.` };
  return null;
}

/** Walk to a connected Local Place on the occupied host. Takes no time; changes only the place. */
export function moveToPlace(candidate, ctx, { placeId }) {
  const blocked = moveBlocker(candidate, ctx, placeId);
  if (blocked) throw new CommandError(blocked.reason, blocked.category);
  candidate.actor.placeId = placeId;
  const label = authoredSite(candidate, ctx.content, candidate.actor.hostId)?.places?.[placeId]?.label ?? 'the next compartment';
  return { kind: 'MOVED_TO_PLACE', message: `You go to the ${label.toLowerCase()}.`, changes: { placeId } };
}

export function validatePresence(state, geography) {
  const a = state.actor;
  check(isObj(a) && Object.keys(a).sort().join() === 'hostId,placeId', 'actor must be exactly {hostId, placeId}');
  const host = siteOf(state, geography, a.hostId);
  check(host, `actor host ${a.hostId} is not a site`);
  check(state.entities[a.hostId]?.lifecycle === 'active', 'actor host must be an active entity');
  check(Object.hasOwn(host.places, a.placeId), `actor place ${a.placeId} does not exist at its host`);
  check(isObj(state.npcs), 'npcs must be an object');
  for (const [id, n] of Object.entries(state.npcs)) {
    check(isSafeId(id) && isObj(n) && siteOf(state, geography, n.hostId) && Object.hasOwn(siteOf(state, geography, n.hostId).places, n.placeId), `npc ${id} presence invalid`);
  }
}
