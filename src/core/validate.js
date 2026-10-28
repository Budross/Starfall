// Validation for content, frozen geography and dynamic state. Every commit runs
// validateState (T-04). Malformed records are never repaired here — a failure is
// reported and the caller keeps (or refuses) the record unchanged.
import { check, isObj, isSafeId, isVec3, isFiniteNum, has, ValidationError } from './shape.js';
import { compile, references } from '../rules/conditions.js';
import { compileEffects } from '../rules/effects.js';
import { validateEntities } from '../domain/entities.js';
import { validateSites } from '../domain/sites.js';
import { validatePresence } from '../domain/movement.js';
import { validateKnowledge } from '../domain/knowledge.js';
import { validateFlags } from '../domain/flags.js';
import { validateLedger } from '../rules/ledger.js';
import { validateVessels, propulsionQuote, approachPoint } from '../domain/vessels.js';
import { validateInventory } from '../domain/inventory.js';
import { validateEquipment, placementReason } from '../domain/equipment.js';
import { validatePower, allocation } from '../domain/power.js';
import { validateWork } from '../domain/work.js';
import { validateResearch, researchCatalog } from '../domain/research.js';
import { validateOrders } from '../domain/orders.js';
import { STATE_VERSION } from './state.js';
import { auditTechnology } from './technology.js';

/** Slices revision 5 (Stage 5) understands. */
const SUPPORTED_SLICES = new Set(['meta', 'entities', 'sites', 'actor', 'npcs', 'knowledge', 'flags', 'ledger', 'deposits', 'vessels', 'inventory', 'equipment', 'power', 'work', 'research', 'orders']);
/** Slices every current-revision state must contain, independent of meta.requiredSlices (S-43). */
const MANDATORY_SLICES = Object.freeze(['vessels', 'inventory', 'deposits', 'equipment', 'power', 'work', 'research', 'orders']);

/** Predicates whose owning domain does not exist yet. Content using them is rejected (no interim stores). */
const PREDICATE_OWNER_PENDING = Object.freeze({ met: 'the NPC owner (Stage 7)' });

// ---------------------------------------------------------------- content

export function validateContent(content) {
  const w = content.world;
  check(isObj(w) && isObj(w.sites) && isObj(w.areas) && isObj(w.megastructures), 'content.world is incomplete');
  for (const [key, a] of Object.entries(w.areas)) {
    check(isSafeId(key) && isFiniteNum(a.radius) && a.radius > 0, `area ${key} invalid`);
    check(a.center ? isVec3(a.center) : has(w.sites, a.centerSite), `area ${key} needs a center or a centerSite`);
  }
  for (const [key, s] of Object.entries(w.sites)) {
    check(isSafeId(key) && !key.includes('/'), `site key ${key} invalid`);
    check(has(w.areas, s.areaId), `site ${key} has unknown area`);
    for (const [pk, p] of Object.entries(s.places)) {
      check(isSafeId(pk), `place key ${pk} invalid`);
      check(p.exterior === undefined || typeof p.exterior === 'boolean', `place ${key}/${pk} exterior must be boolean`);
      check(p.slots === undefined || (Number.isSafeInteger(p.slots) && p.slots >= 0), `place ${key}/${pk} slots must be a non-negative integer`);
      for (const [sk, sub] of Object.entries(p.subjects)) {
        const where = `${key}/${pk}/${sk}`;
        check(isSafeId(sk), `subject key ${where} invalid`);
        check(['feature', 'evidence', 'fitting', 'deposit'].includes(sub.kind), `subject ${where} has unknown kind`);
        if (sub.perceivedWhen) {
          let ast;
          try { ast = compile(sub.perceivedWhen, { mode: 'unlock' }); } catch (e) { throw new ValidationError(`subject ${where} perceivedWhen: ${e.message}`); }
          for (const r of references(ast)) {
            check(!has(PREDICATE_OWNER_PENDING, r.predicate), `subject ${where} uses ${r.predicate}, which requires ${PREDICATE_OWNER_PENDING[r.predicate]}`);
            if (r.predicate === 'fragment') check(has(content.fragments, r.value), `subject ${where} references unknown fragment ${r.value}`);
            if (r.predicate === 'discovery') check(has(content.research.discoveries, r.value), `subject ${where} references unknown discovery ${r.value}`);
          }
        }
        if (sub.effects) {
          check(sub.kind === 'evidence', `subject ${where}: only evidence sources carry one-time effects`);
          let effects;
          try { effects = compileEffects(sub.effects); } catch (e) { throw new ValidationError(`subject ${where} effects: ${e.message}`); }
          for (const e of effects) if (e.op === 'grantFragment') check(has(content.fragments, e.args), `subject ${where} grants unknown fragment ${e.args}`);
        }
      }
    }
    for (const d of Object.values(s.deposits)) {
      check(has(content.items, d.itemId) && Number.isSafeInteger(d.initial) && d.initial > 0, `site ${key} has an invalid deposit`);
      if (d.placeKey !== undefined) check(has(s.places, d.placeKey), `site ${key} deposit ${d.itemId} place ${d.placeKey} does not exist`);
      if (d.collect !== undefined) {
        check(d.placeKey !== undefined, `site ${key} deposit ${d.itemId} can be collected only at a place`);
        check(content.items[d.itemId].category === 'resource' && Number.isSafeInteger(d.collect.amount) && d.collect.amount > 0 && isFiniteNum(d.collect.duration) && d.collect.duration > 0, `site ${key} deposit ${d.itemId} collection invalid`);
      }
    }
    validateSiteFacilities(key, s, content);
  }
  validateCatalogs(content);
  for (const r of w.priorRecords) {
    if (r.subject) check(has(w.sites, r.subject) || has(w.megastructures, r.subject), `prior record names unknown subject ${r.subject}`);
    else check(Array.isArray(r.place) && w.sites[r.place[0]]?.places?.[r.place[1]], `prior record names unknown place ${r.place}`);
  }
  check(w.sites[w.start.hostId]?.places?.[w.start.placeId], 'start presence does not resolve');
  // Authored opening support (S-23): the start host's own deposits meet the declared minimums.
  const startDeposits = w.sites[w.start.hostId].deposits;
  for (const [itemId, min] of Object.entries(w.opening.minimumDeposits)) {
    check((startDeposits[itemId]?.initial ?? 0) >= min, `opening needs ≥ ${min} cm³ of ${itemId} at the start site`);
  }
  for (const itemId of Object.keys(content.worldgen.resources)) check(has(content.items, itemId), `worldgen resource ${itemId} is not an item`);
  validateStageFiveContent(content);
  for (const [key, v] of Object.entries(w.vessels ?? {})) {
    check(isSafeId(key) && !has(w.sites, key) && !has(w.megastructures, key) && !has(w.principals, key) && key !== 'player', `vessel key ${key} invalid or collides`);
    for (const role of ['owner', 'controller']) check(v[role] === undefined || v[role] === null || v[role] === 'player' || has(w.principals, v[role]), `vessel ${key} ${role} must be a principal`);
    check(isVec3(v.start), `vessel ${key} start must be finite`);
    check(isFiniteNum(v.approachStandoff) && v.approachStandoff >= 0, `vessel ${key} approachStandoff invalid`);
    check(isObj(v.propulsion) && typeof v.propulsion.kind === 'string', `vessel ${key} needs a propulsion capability`);
    if (v.propulsion.kind === 'energy-drive') {
      check(isFiniteNum(v.propulsion.capacity) && v.propulsion.capacity > 0, `vessel ${key} drive capacity invalid`);
      check(isFiniteNum(v.initialEnergy) && v.initialEnergy >= 0 && v.initialEnergy <= v.propulsion.capacity, `vessel ${key} initial energy must be 0..capacity`);
    }
    if (v.initialJourney) {
      const target = w.sites[v.initialJourney.to];
      check(target && target.berths.length > 0, `vessel ${key} initial journey needs a site with berths`);
      // Affordability uses the same propulsion contract as the runtime quote.
      const approach = approachPoint(target.position, v.start, v.approachStandoff);
      const leg = propulsionQuote(v.propulsion, Math.hypot(approach.x - v.start.x, approach.y - v.start.y, approach.z - v.start.z));
      check(leg.ok, `vessel ${key} initial journey: ${leg.reason}`);
      if (v.propulsion.kind === 'energy-drive') check(leg.cost.energy <= v.initialEnergy, `vessel ${key} cannot afford its initial journey`);
    }
  }
}

/**
 * Stage 5 content: observation bounds (S-47), journal wording (S-53), megastructure claims on
 * fragments (S-56), the story path, and the technology audit (S-55: grounding and story path
 * are errors; dominance is a warning reported by contentWarnings).
 */
function validateStageFiveContent(content) {
  const o = content.observation;
  check(isObj(o) && ['placeLimit', 'topicLimit', 'baselineItems', 'arrivalClauses'].every(k => Number.isSafeInteger(o[k]) && o[k] >= 1) &&
    isFiniteNum(o.depositLowFraction) && o.depositLowFraction > 0 && o.depositLowFraction < 1, 'content.observation is invalid');
  const words = content.journal?.exposureWords;
  check(Array.isArray(words) && words.length > 0 && words.every((w, i) => typeof w.word === 'string' && w.word && typeof w.below === 'number' && (!i || w.below > words[i - 1].below)), 'content.journal exposure words are invalid');
  for (const [id, frag] of Object.entries(content.fragments)) {
    check(isObj(frag) && typeof frag.title === 'string' && typeof frag.text === 'string', `fragment ${id} invalid`);
    if (frag.reveals === undefined) continue;
    const r = frag.reveals, mega = content.world.megastructures[r?.megastructure];
    check(isObj(r) && Object.keys(r).sort().join() === 'claim,megastructure' && mega, `fragment ${id} reveals an unknown megastructure`);
    check(typeof r.claim === 'string' && r.claim.trim() && r.claim.length <= 280, `fragment ${id} claim must be 1–280 characters`);
    // A claim is a qualified observation, never the structure's secret identity (K-01).
    check(!r.claim.toLowerCase().includes(mega.label.toLowerCase()), `fragment ${id} claim reveals the megastructure's identity`);
  }
  check(Array.isArray(content.storyPath ?? []), 'content.storyPath must be a list');
  for (const e of content.storyPath ?? []) {
    check(isObj(e) && Object.keys(e).length === 1 && (has(content.research.discoveries, e.discovery) || has(content.items, e.item)), `story path entry ${JSON.stringify(e)} does not resolve`);
  }
  const audit = auditTechnology(content);
  check(!audit.errors.length, `technology audit: ${audit.errors.join('; ')}`);
}

/** Facility content on an authored site: hold, facility power and starting banks (slots and placement, S-36). */
function validateSiteFacilities(key, s, content) {
  if (s.hold !== undefined) check(isObj(s.hold) && Number.isSafeInteger(s.hold.capacityCm3) && s.hold.capacityCm3 > 0, `site ${key} hold invalid`);
  if (s.power !== undefined) check(isObj(s.power) && isFiniteNum(s.power.initialReserve) && s.power.initialReserve >= 0 && isFiniteNum(s.power.mandatoryLoad) && s.power.mandatoryLoad >= 0, `site ${key} power invalid`);
  let storage = 0;
  const used = {};
  for (const e of s.equipment ?? []) {
    check(has(content.equipment, e.model), `site ${key} bank model ${e.model} unknown`);
    check(has(s.places, e.placeId), `site ${key} bank place ${e.placeId} does not exist`);
    check(Number.isSafeInteger(e.quantity) && e.quantity >= 1 && isFiniteNum(e.health) && e.health > 0 && e.health <= 1, `site ${key} bank ${e.model} quantity/health invalid`);
    const why = placementReason(content, s, e.placeId, e.model);
    check(!why, `site ${key} bank ${e.model} at ${e.placeId}: ${why}`);
    used[e.placeId] = (used[e.placeId] ?? 0) + e.quantity;
    storage += (content.equipment[e.model].provides?.storage ?? 0) * e.quantity;
  }
  for (const [placeId, n] of Object.entries(used)) check(n <= (s.places[placeId].slots ?? 0), `site ${key} place ${placeId} has more starting units (${n}) than slots`);
  if (s.power) check(s.power.initialReserve <= storage, `site ${key} initial reserve exceeds its battery storage`);
  check(!((s.equipment?.length || s.power) && !s.hold), `site ${key} has facilities but no hold`);
}

/** Item, recipe, equipment and research catalogs (I-11, I-15, PF-16; reference category rules). */
function validateCatalogs(content) {
  const capabilities = new Set();
  const isItemMap = (m, category) => isObj(m) && Object.keys(m).length > 0 && Object.entries(m).every(([id, q]) => content.items[id]?.category === category && Number.isSafeInteger(q) && q > 0);
  for (const [id, item] of Object.entries(content.items)) {
    check(isSafeId(id) && isObj(item) && ['resource', 'component', 'product'].includes(item.category) && typeof item.label === 'string' && item.label, `item ${id} invalid`);
    check(Array.isArray(item.tags ?? []) && (item.tags ?? []).every(isSafeId), `item ${id} tags invalid`);
    if (item.category === 'resource') {
      check(item.unitVolumeCm3 === undefined, `bulk item ${id} cannot define unitVolumeCm3`);
      check(Number.isSafeInteger(item.researchSampleCm3) && item.researchSampleCm3 > 0, `bulk item ${id} needs a positive integer researchSampleCm3`);
    } else {
      check(item.researchSampleCm3 === undefined, `counted item ${id} uses one research sample`);
      check(Number.isSafeInteger(item.unitVolumeCm3) && item.unitVolumeCm3 > 0, `counted item ${id} needs a positive integer unitVolumeCm3`);
    }
    if (item.installs !== undefined) {
      check(item.category === 'product', `item ${id}: only products install (machines are products)`);
      check(content.equipment[item.installs]?.item === id, `item ${id} installs model ${item.installs}, which does not install from it`);
    }
    if (item.unlock !== undefined) compileChecked(item.unlock, 'unlock', `item ${id} unlock`, content);
    // Authored item notes (S-52): learned on encounter or when a knowledge condition holds.
    check(item.notes === undefined || isObj(item.notes), `item ${id} notes must be an object`);
    for (const [noteId, n] of Object.entries(item.notes ?? {})) {
      const where = `item ${id} note ${noteId}`;
      check(isSafeId(noteId) && isObj(n) && typeof n.title === 'string' && n.title && typeof n.text === 'string' && n.text, `${where} invalid`);
      const when = n.learnWhen;
      check(when === undefined || (isObj(when) && Object.keys(when).every(k => ['onEncounter', 'conditions'].includes(k)) &&
        (when.onEncounter === undefined || when.onEncounter === true) && (when.onEncounter === true || when.conditions !== undefined)), `${where} learnWhen must be {onEncounter?: true, conditions?}`);
      if (when?.conditions !== undefined) compileChecked(when.conditions, 'unlock', `${where} learnWhen`, content);
    }
  }
  check(isObj(content.provisions), 'content.provisions must be an object');
  for (const [key, rule] of Object.entries(content.provisions)) {
    check(isSafeId(key) && isObj(rule) && typeof rule.unit === 'string' && rule.combine === 'sum' && typeof rule.scaleByHealth === 'boolean', `provision rule ${key} invalid (only "sum" is supported)`);
  }
  for (const [id, m] of Object.entries(content.equipment)) {
    check(isSafeId(id) && isObj(m) && typeof m.label === 'string', `equipment model ${id} invalid`);
    check(m.provides === undefined || isObj(m.provides), `equipment model ${id} provides must be an object`);
    for (const [key, v] of Object.entries(m.provides ?? {})) check(has(content.provisions, key) && isFiniteNum(v) && v >= 0, `equipment model ${id} provides unknown or invalid ${key}`);
    check(Array.isArray(m.capabilities ?? []) && (m.capabilities ?? []).every(isSafeId), `equipment model ${id} capabilities invalid`);
    (m.capabilities ?? []).forEach(c => capabilities.add(c));
    check(isObj(m.placement) && typeof m.placement.exterior === 'boolean' && (m.placement.deposit === undefined || m.placement.deposit === true), `equipment model ${id} placement must be {exterior, deposit?}`);
    if (m.item !== undefined) check(content.items[m.item]?.installs === id, `equipment model ${id} installs from ${m.item}, which does not install it`);
    check(m.baseline === undefined || (isFiniteNum(m.baseline) && m.baseline >= 0), `equipment model ${id} baseline invalid`);
    check(m.toggleable === undefined || typeof m.toggleable === 'boolean', `equipment model ${id} toggleable invalid`);
    const processes = Object.entries(m.processes ?? {});
    if (m.processes !== undefined) {
      check(isObj(m.processes) && processes.length > 0, `equipment model ${id} processes invalid`);
      check(isFiniteNum(m.baseline) && m.toggleable === true, `equipment model ${id}: machines with processes need a baseline and must be toggleable`);
    }
    for (const [pid, p] of processes) {
      const where = `equipment model ${id} process ${pid}`;
      check(isSafeId(pid) && isObj(p) && typeof p.label === 'string' && p.label, `${where} invalid`);
      check(isFiniteNum(p.duration) && p.duration > 0 && isFiniteNum(p.powerRate) && p.powerRate >= 0, `${where} timing invalid`);
      if (p.kind === 'extract') {
        check(content.items[p.deposit]?.category === 'resource' && Number.isSafeInteger(p.amount) && p.amount > 0 && p.inputs === undefined && p.outputs === undefined, `${where}: extraction takes a deposit item and a positive amount`);
      } else {
        check(p.kind === 'refine', `${where} kind must be extract or refine`);
        check(isItemMap(p.inputs, 'resource') && isItemMap(p.outputs, 'resource'), `${where}: refining turns resources into resources`);
      }
      if (p.unlock !== undefined) compileChecked(p.unlock, 'unlock', `${where} unlock`, content);
    }
    if (m.placement.deposit) check(processes.some(([, p]) => p.kind === 'extract'), `equipment model ${id}: only extracting machines may require a deposit`);
    if (m.repair) {
      check(isObj(m.repair) && Object.keys(m.repair).every(k => ['inputs', 'unlock'].includes(k)), `equipment model ${id} repair has unknown fields (repair is instant)`);
      check(isObj(m.repair.inputs) && Object.keys(m.repair.inputs).length > 0, `equipment model ${id} repair needs inputs`);
      for (const [itemId, q] of Object.entries(m.repair.inputs)) check(content.items[itemId]?.category === 'component' && Number.isSafeInteger(q) && q > 0, `equipment model ${id} repair costs must be components`);
      if (m.repair.unlock !== undefined) compileChecked(m.repair.unlock, 'unlock', `equipment model ${id} repair unlock`, content);
    }
  }
  for (const [id, r] of Object.entries(content.recipes)) {
    const out = content.items[r.output];
    check(isSafeId(id) && out, `recipe ${id} output invalid`);
    check(out.category !== 'resource', `recipe ${id}: refining (resource output) is machine-only`);
    check(r.powerRate === undefined, `recipe ${id}: nothing made by hand or at a workbench draws power`);
    check(Number.isSafeInteger(r.qty) && r.qty > 0 && isFiniteNum(r.duration) && r.duration > 0, `recipe ${id} amounts invalid`);
    check(r.tool === null || capabilities.has(r.tool), `recipe ${id} tool must be null (by hand) or an existing capability`);
    check(Array.isArray(r.inputs) && r.inputs.length > 0, `recipe ${id} needs inputs`);
    for (const slot of r.inputs) {
      const options = slot.item !== undefined ? [slot.item] : slot.anyOf;
      check((slot.item === undefined) !== (slot.anyOf === undefined) && Array.isArray(options) && options.length > 0 && Number.isSafeInteger(slot.qty) && slot.qty > 0, `recipe ${id} input slot invalid`);
      for (const o of options) check(has(content.items, o) && content.items[o].category !== 'product', `recipe ${id}: products are never ingredients`);
    }
    if (r.unlock !== undefined) compileChecked(r.unlock, 'unlock', `recipe ${id} unlock`, content);
  }
  researchCatalog(content);   // throws on invalid research content
}

function compileChecked(cond, mode, where, content) {
  let ast;
  try { ast = compile(cond, { mode }); } catch (e) { throw new ValidationError(`${where}: ${e.message}`); }
  for (const r of references(ast)) {
    check(!has(PREDICATE_OWNER_PENDING, r.predicate), `${where} uses ${r.predicate}, which requires ${PREDICATE_OWNER_PENDING[r.predicate]}`);
    if (r.predicate === 'discovery') check(has(content.research.discoveries, r.value), `${where} references unknown discovery ${r.value}`);
    if (r.predicate === 'fragment') check(has(content.fragments, r.value), `${where} references unknown fragment ${r.value}`);
  }
  return ast;
}

/**
 * Content warnings that do not block play (C-03, PF-16; research reachability): an ingredient
 * whose unlock is not implied by the consuming recipe's unlock, and research that cannot reach
 * a threshold or has no entry route.
 */
export function contentWarnings(content) {
  const out = [...researchCatalog(content).warnings, ...auditTechnology(content).warnings];
  const refs = cond => cond ? references(compile(cond, { mode: 'unlock' })).map(r => `${r.predicate}:${r.value}`) : [];
  for (const [id, r] of Object.entries(content.recipes)) {
    const have = new Set(refs(r.unlock));
    for (const slot of r.inputs) for (const o of slot.item !== undefined ? [slot.item] : slot.anyOf) {
      const missing = refs(content.items[o].unlock).filter(x => !have.has(x));
      if (missing.length) out.push(`recipe ${id}: ingredient ${o} needs ${missing.join(', ')}, which the recipe's unlock does not imply`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- geography

export function validatePlaces(id, site) {
  check(isObj(site.places) && Object.keys(site.places).length > 0, `site ${id} needs places`);
  check(has(site.places, site.entryPlace), `site ${id} entry place does not exist`);
  for (const [pk, p] of Object.entries(site.places)) {
    check(isSafeId(pk), `site ${id} place key ${pk} invalid`);
    check(Array.isArray(p.connections) && new Set(p.connections).size === p.connections.length, `site ${id} place ${pk} connections invalid`);
    for (const c of p.connections) check(c !== pk && has(site.places, c), `site ${id} place ${pk} connects to unknown place ${c}`);
    check(Array.isArray(p.subjects) && p.subjects.every(isSafeId) && new Set(p.subjects).size === p.subjects.length, `site ${id} place ${pk} subjects invalid`);
  }
  check(Array.isArray(site.berths) && site.berths.every(isSafeId) && new Set(site.berths).size === site.berths.length, `site ${id} berths invalid`);
}

function validateDepositMap(owner, deposits, items) {
  check(isObj(deposits), `${owner} deposits must be an object`);
  for (const [n, d] of Object.entries(deposits)) {
    check(isSafeId(n), `deposit id ${n} invalid`);
    check(isObj(d) && has(items, d.itemId) && Number.isSafeInteger(d.initial) && d.initial > 0, `deposit ${n} invalid`);
  }
}

export function validateGeography(g, content) {
  check(isObj(g), 'geography must be an object');
  check(Object.keys(g).sort().join() === 'anchors,areas,bodies,generatorRevision,megastructures,seed,sites', 'geography has unexpected fields');
  check(typeof g.generatorRevision === 'string' && g.generatorRevision, 'generatorRevision required');
  check(Number.isInteger(g.seed) && g.seed >= 0 && g.seed <= 0xffffffff, 'geography seed must be a uint32');
  for (const [id, a] of Object.entries(g.areas)) check(isSafeId(id) && isVec3(a.center) && isFiniteNum(a.radius) && a.radius > 0, `area ${id} invalid`);
  const ids = new Set();
  const unique = id => { check(isSafeId(id) && !id.includes('/') && !ids.has(id), `duplicate or invalid geography id ${id}`); ids.add(id); };
  for (const [id, s] of Object.entries(g.sites)) {
    unique(id);
    check(isVec3(s.position) && has(g.areas, s.areaId), `site ${id} position/area invalid`);
    validatePlaces(id, s);
    validateDepositMap(`site ${id}`, s.deposits, content.items);
  }
  for (const [id, b] of Object.entries(g.bodies)) {
    unique(id);
    check(isVec3(b.position) && has(g.areas, b.areaId) && isFiniteNum(b.scale) && b.scale > 0, `body ${id} invalid`);
    validateDepositMap(`body ${id}`, b.deposits, content.items);
  }
  for (const [id, m] of Object.entries(g.megastructures)) {
    unique(id);
    check(isVec3(m.position) && isObj(m.footprint) && Array.isArray(m.accessPoints), `megastructure ${id} invalid`);
  }
  for (const [key, id] of Object.entries(g.anchors)) check(has(g.sites, id) || has(g.megastructures, id), `anchor ${key} does not resolve`);
  const nodes = new Set();
  for (const n of allDepositNodes(g)) { check(!nodes.has(n.nodeId), `duplicate deposit node ${n.nodeId}`); nodes.add(n.nodeId); }
}

/** Every deposit node in geography: [{nodeId, itemId, initial}]. */
export function allDepositNodes(g) {
  const out = [];
  for (const holder of [...Object.values(g.sites), ...Object.values(g.bodies)]) {
    for (const [nodeId, d] of Object.entries(holder.deposits)) out.push({ nodeId, itemId: d.itemId, initial: d.initial });
  }
  return out;
}

// ---------------------------------------------------------------- dynamic state

/**
 * S-26 deposit contract. `deposits` may be absent only while it was never created; once
 * it is in meta.requiredSlices it must exist, densely covering every geography node.
 * Loading can therefore never re-initialize (refill) or silently drop depletion.
 */
export function validateDeposits(state, geography) {
  const required = state.meta.requiredSlices.includes('deposits');
  if (!has(state, 'deposits')) { check(!required, 'deposits slice is required but missing (it may not be re-initialized)'); return; }
  check(required, 'deposits slice present but not recorded as required');
  const d = state.deposits;
  check(isObj(d) && Object.keys(d).sort().join() === 'initializedAt,remaining', 'deposits must be exactly {initializedAt, remaining}');
  check(isFiniteNum(d.initializedAt) && d.initializedAt >= 0 && d.initializedAt <= state.meta.simulationTime, 'deposits.initializedAt invalid');
  check(isObj(d.remaining), 'deposits.remaining must be an object');
  const nodes = allDepositNodes(geography);
  check(Object.keys(d.remaining).length === nodes.length, `deposits.remaining must have exactly ${nodes.length} entries`);
  for (const n of nodes) {
    check(has(d.remaining, n.nodeId), `deposit node ${n.nodeId} is missing`);
    const r = d.remaining[n.nodeId];
    check(Number.isSafeInteger(r) && r >= 0 && r <= n.initial, `deposit node ${n.nodeId} remaining must be 0..${n.initial}`);
  }
}

/**
 * The current revision (5). Every commit runs this. Every facility slice is mandatory: a state
 * that lacks one is rejected (→ recovery), never re-created (S-43). Work speeds must equal
 * Power's allocation for the committed state.
 */
export function validateState(state, geography, content) {
  check(isObj(state) && isObj(state.meta) && state.meta.version === STATE_VERSION, `meta.version must be ${STATE_VERSION}`);
  for (const s of MANDATORY_SLICES) check(has(state, s), `state is missing its ${s} slice`);
  for (const key of Object.keys(state)) check(SUPPORTED_SLICES.has(key), `state slice ${key} is not supported by save revision ${STATE_VERSION}`);
  const m = state.meta;
  check(m.seed === geography.seed, 'meta.seed does not match geography');
  check(isFiniteNum(m.simulationTime) && m.simulationTime >= 0, 'meta.simulationTime invalid');
  check(Number.isSafeInteger(m.nextId) && m.nextId >= 1, 'meta.nextId invalid');
  check(Array.isArray(m.requiredSlices) && new Set(m.requiredSlices).size === m.requiredSlices.length, 'meta.requiredSlices invalid');
  for (const s of m.requiredSlices) check(SUPPORTED_SLICES.has(s), `required slice ${s} is not supported by save revision ${STATE_VERSION}`);
  for (const s of ['meta', 'entities', 'sites', 'actor', 'npcs', 'knowledge', 'flags', 'ledger']) check(m.requiredSlices.includes(s), `meta.requiredSlices must include ${s}`);
  for (const s of m.requiredSlices) check(has(state, s), `required slice ${s} is missing`);
  validateEntities(state.entities, m.simulationTime);
  for (const id of Object.keys(geography.anchors).map(k => geography.anchors[k])) check(state.entities[id], `anchor ${id} has no entity record`);
  validateSites(state, geography);
  validatePresence(state, geography);
  validateKnowledge(state, geography, content);
  validateFlags(state.flags);
  validateLedger(state.ledger, m.simulationTime);
  validateDeposits(state, geography);
  validateVessels(state, geography, content);
  validateInventory(state, geography, content);
  validateEquipment(state, geography, content);
  validatePower(state, geography, content);
  validateWork(state, geography, content);
  validateResearch(state, geography, content);
  validateOrders(state, geography, content);
  const speeds = allocation(state, geography, content);
  for (const [runId, r] of Object.entries(state.work.runs)) check(speeds[runId] === r.speed, `run ${runId} speed ${r.speed} does not match the power allocation ${speeds[runId]}`);
}
