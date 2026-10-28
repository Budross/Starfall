// Pure world queries over committed state + frozen geography. No writer lives here.
import { has, dist } from '../core/shape.js';
import { compile, evaluate } from '../rules/conditions.js';

// ---- composite persistent references (S-25: authored keys are site-local) ----
export const placeRef = (hostId, placeKey) => `${hostId}/${placeKey}`;
export const subjectRef = (hostId, placeKey, subjectKey) => `${hostId}/${placeKey}/${subjectKey}`;
export function parseRef(ref) {
  const parts = typeof ref === 'string' ? ref.split('/') : [];
  if (parts.length === 2) return { hostId: parts[0], placeKey: parts[1] };
  if (parts.length === 3) return { hostId: parts[0], placeKey: parts[1], subjectKey: parts[2] };
  return null;
}

/** Stationary site record (authored/generated geography or runtime-created). */
export function siteOf(state, geography, id) {
  if (has(geography.sites, id)) return geography.sites[id];
  if (has(state.sites, id)) return state.sites[id];
  return null;
}

/** Content definition behind an entity (authored anchors only), or null. */
export function authoredSite(state, content, id) {
  const key = state.entities[id]?.authoredId;
  return key ? content.world.sites[key] ?? null : null;
}

/**
 * Canonical position (rev 3 §B spatial rule): stationary sites and bodies are fixed at
 * creation; vessels are derived from their committed movement state; characters and
 * NPCs take their host's position.
 */
export function positionOf(state, geography, id) {
  if (has(geography.sites, id)) return geography.sites[id].position;
  if (has(geography.bodies, id)) return geography.bodies[id].position;
  if (has(geography.megastructures, id)) return geography.megastructures[id].position;
  if (has(state.sites, id)) return state.sites[id].position;
  if (state.vessels && has(state.vessels, id)) return vesselPositionAt(state, geography, state.vessels[id], state.meta.simulationTime);
  if (id === 'player') return positionOf(state, geography, state.actor.hostId);
  if (has(state.npcs, id)) return positionOf(state, geography, state.npcs[id].hostId);
  return null;
}

const lerp = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });

/**
 * A vessel's position at simulation time t, derived from its committed record: a journey
 * interpolates from → to.pos (the approach point fixed at departure); holding uses holdPos;
 * docked takes the host's position.
 */
export function vesselPositionAt(state, geography, v, t) {
  if (v.status === 'transit') {
    const j = v.journey;
    const f = (t - j.departAt) / (j.arriveAt - j.departAt);
    if (f >= 1) return { ...j.to.pos };
    return lerp(j.from, j.to.pos, Math.max(0, f));
  }
  if (v.status === 'holding') return { ...v.holdPos };
  return { ...siteOf(state, geography, v.hostId).position };
}

/** Unit direction of travel for a vessel in transit, else null. */
export function vesselDirection(v) {
  if (v.status !== 'transit') return null;
  const { from, to } = v.journey;
  const d = { x: to.pos.x - from.x, y: to.pos.y - from.y, z: to.pos.z - from.z };
  const n = Math.hypot(d.x, d.y, d.z);
  return n > 0 ? { x: d.x / n, y: d.y / n, z: d.z / n } : null;
}

export const vesselIds = state => Object.keys(state.vessels ?? {});

export function areaOf(state, geography, id) {
  return geography.sites[id]?.areaId ?? geography.bodies[id]?.areaId ?? state.sites[id]?.areaId ?? null;
}

/** Every stationary object id: geography sites, bodies, megastructures and runtime sites. */
export function stationaryIds(state, geography) {
  return [...Object.keys(geography.sites), ...Object.keys(geography.bodies), ...Object.keys(geography.megastructures), ...Object.keys(state.sites)];
}

/**
 * What the character can physically see right now (S-22, derived, never stored):
 * stationary objects and vessels within visualRange of the host, plus conspicuous
 * megastructures.
 */
export function visibleNow(state, geography, content) {
  const here = positionOf(state, geography, state.actor.hostId);
  const range = content.visibility.visualRange;
  const out = new Set();
  for (const id of [...stationaryIds(state, geography), ...vesselIds(state)]) {
    if (has(geography.megastructures, id) && geography.megastructures[id].conspicuous) { out.add(id); continue; }
    const p = positionOf(state, geography, id);
    if (p && here && dist(p, here) <= range) out.add(id);
  }
  return out;
}

/** Knowledge-predicate queries over the committed state. */
export function knowledgeQueries(state) {
  return {
    fragment: id => has(state.knowledge.fragments, id),
    flag: name => state.flags[name] === true,
    // Research discoveries are the only discovery store (S-25).
    discovery: id => has(state.research?.discoveries ?? {}, id),
    // The NPC owner arrives in Stage 7; content using `met` is rejected until then.
    met: () => false
  };
}

/**
 * Knowledge plus operational queries for the character's current situation: capabilities of
 * operational banks at the character's place, presence, and stock at the occupied host.
 */
export function conditionQueries(state, geography, content) {
  const { hostId, placeId } = state.actor;
  return {
    ...knowledgeQueries(state),
    capability: id => Object.values(state.equipment?.banks ?? {}).some(b => b.hostId === hostId && b.placeId === placeId &&
      b.quantity > 0 && b.enabled === true && b.health > 0 && (content.equipment[b.model].capabilities ?? []).includes(id)),
    atHost: key => hostId === (geography.anchors[key] ?? key),
    atPlace: key => placeId === key,
    holds: ({ itemId, qty }) => (state.inventory?.holds?.[hostId]?.[itemId] ?? 0) >= qty
  };
}

const compiled = { unlock: new WeakMap(), requires: new WeakMap() };
export function compiledCondition(cond, mode = 'unlock') {
  let ast = compiled[mode].get(cond);
  if (!ast) { ast = compile(cond, { mode }); compiled[mode].set(cond, ast); }
  return ast;
}

/** Whether an authored condition holds now (absent = always). `unlock` mode reads knowledge only. */
export function conditionHolds(state, geography, content, cond, mode = 'unlock') {
  if (!cond) return true;
  const q = mode === 'unlock' ? knowledgeQueries(state) : conditionQueries(state, geography, content);
  return evaluate(compiledCondition(cond, mode), q).ok;
}

/**
 * Subjects the character can perceive at a place right now, with their current
 * observable condition (S-25). Later stages feed dynamic conditions through here.
 * Returns [] when the place has no authored definition.
 */
export function observablesAt(state, geography, content, hostId, placeKey) {
  const site = siteOf(state, geography, hostId);
  const def = authoredSite(state, content, hostId);
  const place = site?.places?.[placeKey], placeDef = def?.places?.[placeKey];
  if (!place || !placeDef) return [];
  const q = knowledgeQueries(state);
  const out = [];
  for (const key of place.subjects) {
    const s = placeDef.subjects[key];
    if (!s) continue;
    if (s.perceivedWhen && !evaluate(compiledCondition(s.perceivedWhen), q).ok) continue;
    out.push({ key, ref: subjectRef(hostId, placeKey, key), kind: s.kind, label: s.label, condition: s.condition ?? null });
  }
  return out;
}
