// Entities (E-01, E-02): persistent identities with lifecycles and authority.
// Sole writer of the `entities` slice. There is no hard deletion: terminal entities
// keep a retained label for history.
import { check, isObj, isSafeId, isFiniteNum, has, CommandError } from '../core/shape.js';
import { validateAccess, PERMISSIONS } from '../rules/authority.js';
import { append } from '../rules/ledger.js';

export const PLAYER = 'player';
export const KINDS = Object.freeze(['principal', 'site', 'megastructure', 'vessel']);
export const LIFECYCLES = Object.freeze(['active', 'inactive', 'retired', 'destroyed']);
const TERMINAL = new Set(['retired', 'destroyed']);
const noAccess = () => ({ public: [], grants: {} });

export function initialEntities(content, geography) {
  const w = content.world;
  const e = { [PLAYER]: { kind: 'principal', lifecycle: 'active', owner: null, controller: null, access: noAccess(), createdAt: 0 } };
  for (const key of Object.keys(w.principals)) e[key] = { kind: 'principal', authoredId: key, lifecycle: 'active', owner: null, controller: null, access: noAccess(), createdAt: 0 };
  for (const [key, id] of Object.entries(geography.anchors)) {
    const site = w.sites[key], mega = w.megastructures[key];
    if (site) e[id] = { kind: 'site', authoredId: key, lifecycle: 'active', owner: site.owner ?? null, controller: site.controller ?? null, access: structuredClone(site.access ?? noAccess()), createdAt: 0 };
    else if (mega) e[id] = { kind: 'megastructure', authoredId: key, lifecycle: 'active', owner: null, controller: null, access: noAccess(), createdAt: 0 };
  }
  return e;
}

/** Register a new entity (a runtime-created site, an authored vessel). Called by the owning domain. */
export function createEntity(candidate, id, { kind, owner = null, controller = null, label, authoredId }) {
  check(isSafeId(id) && !has(candidate.entities, id), `entity id ${id} is invalid or already used`);
  check(KINDS.includes(kind) && kind !== 'principal', `cannot create entity of kind ${kind}`);
  candidate.entities[id] = { kind, ...(authoredId ? { authoredId } : {}), lifecycle: 'active', owner, controller, access: noAccess(), createdAt: candidate.meta.simulationTime, ...(label ? { label } : {}) };
}

export function transition(candidate, id, to, { retainedLabel } = {}) {
  const ent = candidate.entities[id];
  if (!ent) throw new CommandError('Unknown entity.', 'request');
  if (id === PLAYER) throw new CommandError('The character\'s lifecycle cannot be changed this way.', 'access');
  if (!LIFECYCLES.includes(to)) throw new CommandError(`Unknown lifecycle ${to}.`, 'request');
  if (TERMINAL.has(ent.lifecycle)) throw new CommandError('A retired or destroyed entity cannot change state.', 'access');
  if (ent.lifecycle === to) throw new CommandError('No change.', 'request');
  if (TERMINAL.has(to)) {
    if (typeof retainedLabel !== 'string' || !retainedLabel) throw new CommandError('Terminal transitions must retain a label.', 'request');
    ent.retained = { label: retainedLabel };
  }
  const from = ent.lifecycle;
  ent.lifecycle = to;
  ent.lifecycleChangedAt = candidate.meta.simulationTime;
  append(candidate, 'ENTITY_LIFECYCLE_CHANGED', { entityId: id, from, to });
}

/** Effect target: grant one permission on a target to a principal. */
export function grantAccess(candidate, targetId, principalId, permission) {
  const ent = candidate.entities[targetId];
  check(ent && candidate.entities[principalId]?.kind === 'principal' && PERMISSIONS.includes(permission), 'invalid access grant');
  const list = ent.access.grants[principalId] ??= [];
  if (list.includes(permission)) return false;
  list.push(permission);
  append(candidate, 'AUTHORITY_CHANGED', { entityId: targetId, change: `grant:${principalId}:${permission}` });
  return true;
}

/** Effect target: transfer owner and/or controller. */
export function setAuthority(candidate, targetId, { owner, controller }) {
  const ent = candidate.entities[targetId];
  check(ent && ent.kind !== 'principal', 'invalid authority target');
  for (const p of [owner, controller]) check(p === undefined || p === null || candidate.entities[p]?.kind === 'principal', 'authority must name a principal');
  if (owner !== undefined) ent.owner = owner;
  if (controller !== undefined) ent.controller = controller;
  append(candidate, 'AUTHORITY_CHANGED', { entityId: targetId, change: `owner:${ent.owner ?? '-'}:controller:${ent.controller ?? '-'}` });
}

export function validateEntities(entities, simulationTime) {
  check(isObj(entities), 'entities must be an object');
  const principals = new Set(Object.entries(entities).filter(([, e]) => e?.kind === 'principal').map(([id]) => id));
  check(entities[PLAYER]?.kind === 'principal' && entities[PLAYER].lifecycle === 'active', 'the player principal must exist and be active');
  for (const [id, e] of Object.entries(entities)) {
    check(isSafeId(id), `invalid entity id ${id}`);
    check(isObj(e) && KINDS.includes(e.kind), `entity ${id} has invalid kind`);
    check(LIFECYCLES.includes(e.lifecycle), `entity ${id} has invalid lifecycle`);
    check(isFiniteNum(e.createdAt) && e.createdAt >= 0 && e.createdAt <= simulationTime, `entity ${id} createdAt invalid`);
    if (e.lifecycleChangedAt !== undefined) check(isFiniteNum(e.lifecycleChangedAt) && e.lifecycleChangedAt >= e.createdAt && e.lifecycleChangedAt <= simulationTime, `entity ${id} lifecycleChangedAt invalid`);
    if (TERMINAL.has(e.lifecycle)) check(isObj(e.retained) && typeof e.retained.label === 'string' && e.retained.label, `terminal entity ${id} must retain a label`);
    for (const role of ['owner', 'controller']) {
      check(e[role] === null || principals.has(e[role]), `entity ${id} ${role} must be null or a principal`);
      if (e.kind === 'principal') check(e[role] === null, `principal ${id} cannot have an ${role}`);
      check(e[role] !== id, `entity ${id} cannot own or control itself`);
    }
    validateAccess(e.access, principals);
  }
}
