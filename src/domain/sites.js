// Runtime-created stationary sites (emergent outposts, rev 3 §B). Sole writer of the
// dynamic `sites` slice, so emergent locations never require writing to frozen
// geography. The slice creates none; this exists so the boundary is real and tested (G-02).
import { check, isObj, isSafeId, isVec3, isFiniteNum, has } from '../core/shape.js';
import { allocateId } from '../core/state.js';
import { createEntity } from './entities.js';
import { append } from '../rules/ledger.js';
import { validatePlaces } from '../core/validate.js';

export function initialSites() { return {}; }

/** Create a persistent stationary site; its position is fixed at creation. Returns the new id. */
export function createSite(candidate, geography, { position, areaId, places, entryPlace, berths = [], owner = null, label }) {
  check(isVec3(position), 'site position must be finite');
  check(has(geography.areas, areaId), `unknown area ${areaId}`);
  const id = allocateId(candidate, 'site');
  candidate.sites[id] = { position: { ...position }, areaId, places: structuredClone(places), entryPlace, berths: [...berths], createdAt: candidate.meta.simulationTime };
  createEntity(candidate, id, { kind: 'site', owner, controller: owner, label });
  append(candidate, 'SITE_CREATED', { siteId: id });
  return id;
}

export function validateSites(state, geography) {
  check(isObj(state.sites), 'sites must be an object');
  for (const [id, s] of Object.entries(state.sites)) {
    check(isSafeId(id) && !has(geography.sites, id) && !has(geography.bodies, id) && !has(geography.megastructures, id), `runtime site id ${id} collides with geography`);
    check(isObj(s) && isVec3(s.position), `site ${id} position must be finite`);
    check(has(geography.areas, s.areaId), `site ${id} has unknown area`);
    check(isFiniteNum(s.createdAt) && s.createdAt <= state.meta.simulationTime, `site ${id} createdAt invalid`);
    check(state.entities[id]?.kind === 'site', `site ${id} has no entity record`);
    validatePlaces(id, s);
  }
}
