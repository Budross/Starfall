// State v1 (rev 3 §B): world creation and the `meta` slice. Sole writer of `meta`
// (ids, clock, required-slice list). Every other slice is seeded by its owner's
// initial…() function, so creation keeps one writer per slice.
import { check, deepFreeze, has } from './shape.js';
import { generateArea } from '../domain/worldgen.js';
import { initialEntities } from '../domain/entities.js';
import { initialSites } from '../domain/sites.js';
import { initialActor, initialNpcs } from '../domain/movement.js';
import { initialKnowledge, notice } from '../domain/knowledge.js';
import { initialFlags } from '../domain/flags.js';
import { initialLedger, append } from '../rules/ledger.js';
import { initializeVessels } from '../domain/vessels.js';
import { initializeInventory, initializeDeposits } from '../domain/inventory.js';
import { initializeEquipment } from '../domain/equipment.js';
import { initializePower } from '../domain/power.js';
import { initializeWork } from '../domain/work.js';
import { initializeResearch } from '../domain/research.js';
import { initializeOrders } from '../domain/orders.js';
import { validateGeography, validateState, validateContent } from './validate.js';

/**
 * Save-schema revision (S-46). 5 = Stage 5: room observation memory replaces inspection
 * snapshots, item knowledge, engineering studies (receipts and completion records) and run
 * provenance (`issuedBy`). Revision 4 was the industrial stage (S-43). There is no migration:
 * a save of any other revision is OUTDATED and goes to recovery (export or a confirmed reset).
 */
export const STATE_VERSION = 5;
/** Slices every Stage 2+ save must contain. Later stages append to meta.requiredSlices when they create a slice. */
export const BASE_SLICES = Object.freeze(['meta', 'entities', 'sites', 'actor', 'npcs', 'knowledge', 'flags', 'ledger']);

export function initialMeta(seed) {
  return { version: STATE_VERSION, seed, simulationTime: 0, nextId: 1, requiredSlices: [...BASE_SLICES] };
}

/** Allocate a new runtime id (e.g. `site.7`). */
export function allocateId(candidate, prefix) {
  const id = `${prefix}.${candidate.meta.nextId}`;
  candidate.meta.nextId += 1;
  return id;
}

/** The only place simulation time moves (called by sim/integrator): an absolute snap. */
export function advanceClockTo(candidate, t) {
  check(Number.isFinite(t) && t >= candidate.meta.simulationTime, 'clock must move to a finite time that is not in the past');
  candidate.meta.simulationTime = t;
}

/** Record that a slice now exists and must never silently disappear (S-26). */
export function requireSlice(candidate, name) {
  if (!candidate.meta.requiredSlices.includes(name)) candidate.meta.requiredSlices.push(name);
}

/** Frozen geography: authored anchors + seeded procedural bodies for every Area. */
export function buildGeography(content, seed) {
  check(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'seed must be a uint32');
  const w = content.world, profile = content.worldgen;
  const anchors = {}, sites = {}, megastructures = {}, areas = {}, bodies = {};
  for (const [key, s] of Object.entries(w.sites)) {
    anchors[key] = key;
    sites[key] = {
      authoredId: key, kind: s.kind, position: { ...s.position }, areaId: s.areaId,
      entryPlace: s.entryPlace, berths: [...s.berths],
      places: Object.fromEntries(Object.entries(s.places).map(([pk, p]) => [pk, { connections: [...p.connections], subjects: Object.keys(p.subjects) }])),
      deposits: Object.fromEntries(Object.entries(s.deposits).map(([itemId, d]) => [`${key}.${itemId}`, { itemId: d.itemId, initial: d.initial }]))
    };
  }
  for (const [key, m] of Object.entries(w.megastructures)) {
    anchors[key] = key;
    megastructures[key] = { authoredId: key, position: { ...m.position }, footprint: structuredClone(m.footprint), accessPoints: structuredClone(m.accessPoints), conspicuous: !!m.conspicuous };
  }
  for (const [areaId, a] of Object.entries(w.areas)) {
    const center = a.center ? { ...a.center } : { ...sites[a.centerSite].position };
    const inArea = Object.entries(sites).filter(([, s]) => s.areaId === areaId).map(([id, s]) => ({ id, position: s.position }));
    const { bodies: generated, attempt } = generateArea(profile, { id: areaId, center, radius: a.radius }, seed, inArea);
    areas[areaId] = { center, radius: a.radius, ...(a.centerSite ? { centerSite: a.centerSite } : {}), attempt };
    Object.assign(bodies, generated);
  }
  return { generatorRevision: profile.generatorRevision, seed, areas, sites, bodies, megastructures, anchors };
}

/**
 * The world-creation transaction's candidate: geography (validated, then frozen) and
 * the initial dynamic state, with initial visibility and the start room admitted by
 * knowledge.notice as a first arrival. `observed` is that notice's delta, so a fresh world
 * can show its opening room once. Persisting and committing it is the caller's job
 * (app → persistence.createWorld).
 */
export function createWorld(content, seed) {
  validateContent(content);
  const geography = buildGeography(content, seed);
  validateGeography(geography, content);
  deepFreeze(geography);
  const state = {
    meta: initialMeta(seed),
    entities: initialEntities(content, geography),
    sites: initialSites(),
    actor: initialActor(content),
    npcs: initialNpcs(),
    knowledge: initialKnowledge(content, geography),
    flags: initialFlags(),
    ledger: initialLedger()
  };
  append(state, 'WORLD_CREATED', { seed, generatorRevision: geography.generatorRevision });
  initializeVessels(state, { geography, content });
  initializeFacilitySlices(state, { geography, content });
  const observed = notice(state, geography, content, { previous: null, completed: [] });
  validateState(state, geography, content);
  return { geography, state, observed };
}

/** The facility slices, each created by its owner's one initializer, at world creation only. */
export function initializeFacilitySlices(candidate, ctx) {
  initializeInventory(candidate);
  initializeDeposits(candidate, ctx);
  initializeEquipment(candidate, ctx);
  initializePower(candidate, ctx);
  initializeWork(candidate);
  initializeResearch(candidate);
  initializeOrders(candidate);
}

export const isRequired = (state, name) => has(state, 'meta') && state.meta.requiredSlices?.includes(name);
