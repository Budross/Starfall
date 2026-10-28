// Research (Stage 4; Habitat05_03 §3.2.4, reference js/research/*). Sole writer of `research`.
//
//   research{discoveries{id:{at, via}}, insight{id:units}, credits{discovery/rule/variant: uses},
//            contracts{id: string}, exposure{family: 0..100}, attemptCount, attempts[≤100],
//            studyReceipts{studyId/bankId: {at, processId, issuedBy, revision}},
//            studies{studyId: {at, hostId, placeId, bankId, model}}}
//
// Engineering studies (Stage 5, S-51; reference study.js): a study turns a qualifying operation
// the character ordered on an installed machine into a study-only design discovery. One
// predicate, qualifyingOperation, decides admission (a receipt is recorded in the transaction
// that completes the run), eligibility and validation (PF-10/B04). It depends only on the run's
// persisted provenance — issuedBy, machine origin, process and bank — never on whether its
// order still exists. Studying is instant, consumes nothing and runs no effects.
//
// Players experiment with what they hold and understand; they never choose a technology.
// An accepted experiment (a method plus 1–3 distinct samples) is evaluated against every
// eligible undiscovered discovery: within each evidence rule only the highest-priority
// matching variant applies (no fallback when it is exhausted); credits are keyed by
// discovery/rule/variant, so reordering, padding or switching methods never resets them;
// repeats award [100, 40, 10] % and `once` rules 100 % once. Research is deterministic: there
// is no chance bonus and no random stream (S-33 D-3), so the same experiment on the same
// knowledge always gives the same result. Eligibility is captured before the experiment changes
// anything. Previews and the useful-sample query are pure. An uninformative setup spends
// nothing. Discoveries are the one discovery store (fragments stay in knowledge, S-25);
// completion effects run once, only on experimental completion.
import { check, isObj, isSafeId, has, CommandError, ValidationError } from '../core/shape.js';
import { requireSlice } from '../core/state.js';
import { compile, evaluate, references } from '../rules/conditions.js';
import { compileEffects, preflightEffects, applyEffects } from '../rules/effects.js';
import { conditionQueries, siteOf } from './world.js';
import { heldQty, withdraw, quantityKind } from './inventory.js';
import { leaseOf } from './work.js';
import { isOperational } from './equipment.js';
import { PLAYER } from './entities.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';

export const INSIGHT_SCALE = 100;
export const JOURNAL_LIMIT = 100;
export const EXPOSURE_LIMIT = 100;
const VIA = Object.freeze(['experiment', 'effect', 'study']);
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
const int = (v, min, max = 1_000_000) => Number.isSafeInteger(v) && v >= min && v <= max;

// ---------------------------------------------------------------- catalog (compiled once per content)

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
const stableJson = v => JSON.stringify(stable(v));

const catalogs = new WeakMap();

/** The compiled research catalog for a content bundle. Throws ValidationError on invalid content. */
export function researchCatalog(content) {
  const src = content.research;
  let cat = catalogs.get(src);
  if (!cat) { cat = compileCatalog(content); catalogs.set(src, cat); }
  return cat;
}

function compileCatalog(content) {
  const src = content.research;
  const bad = m => { throw new ValidationError(`research: ${m}`); };
  const keys = (o, allowed, path) => { if (!isObj(o)) bad(`${path} must be an object`); for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown field ${k} at ${path}`); };
  keys(src, ['repetition', 'families', 'affinities', 'methods', 'discoveries', 'studies'], 'root');
  const rep = src.repetition;
  if (!(Array.isArray(rep) && rep.length && rep.length <= 10 && rep[0] === 100 && rep.every((n, i) => int(n, 1, 100) && (!i || n <= rep[i - 1])))) bad('repetition percentages');

  const tags = new Set(Object.values(content.items).flatMap(i => i.tags ?? []));
  const capabilities = new Set(Object.values(content.equipment ?? {}).flatMap(m => m.capabilities ?? []));
  const discoveryIds = new Set(Object.keys(src.discoveries ?? {}));
  const cond = (c, path) => {
    if (c === undefined) return null;
    let ast;
    try { ast = compile(c, { mode: 'requires' }); } catch (e) { bad(`${path}: ${e.message}`); }
    for (const r of references(ast)) {
      if (r.predicate === 'met') bad(`${path} uses met, which requires the NPC owner (Stage 7)`);
      if (r.predicate === 'discovery' && !discoveryIds.has(r.value)) bad(`${path} references unknown discovery ${r.value}`);
      if (r.predicate === 'fragment' && !has(content.fragments, r.value)) bad(`${path} references unknown fragment ${r.value}`);
      if (r.predicate === 'capability' && !capabilities.has(r.value)) bad(`${path} references unknown capability ${r.value}`);
      if (r.predicate === 'holds' && !has(content.items, r.value.itemId)) bad(`${path} references unknown item ${r.value.itemId}`);
    }
    return ast;
  };
  const samples = (v = {}, path, child = false) => {
    keys(v, ['items', 'allTags', 'anyTags', 'excludeTags', 'minSamples', 'maxSamples', ...(child ? [] : ['distinct'])], path);
    for (const k of ['items', 'allTags', 'anyTags', 'excludeTags']) if (v[k] !== undefined) {
      if (!(Array.isArray(v[k]) && v[k].length && new Set(v[k]).size === v[k].length && v[k].every(id => k === 'items' ? has(content.items, id) : tags.has(id)))) bad(`unknown or duplicate ${k} at ${path}`);
    }
    for (const k of ['minSamples', 'maxSamples']) if (v[k] !== undefined && !int(v[k], 1, 3)) bad(`${k} at ${path}`);
    if ((v.minSamples ?? 1) > (v.maxSamples ?? 3)) bad(`sample limits at ${path}`);
    if (v.distinct !== undefined) {
      if (!(Array.isArray(v.distinct) && v.distinct.length && v.distinct.length <= 3)) bad(`distinct samples at ${path}`);
      v.distinct.forEach((d, i) => samples(d, `${path}/${i}`, true));
    }
    return v;
  };

  if (!isObj(src.families) || !Object.keys(src.families).length) bad('families');
  for (const [id, f] of Object.entries(src.families)) { keys(f, ['name', 'description'], `family ${id}`); if (!isSafeId(id) || !text(f.name)) bad(`family ${id}`); }
  if (!Array.isArray(src.affinities)) bad('affinities');
  for (const a of src.affinities) {
    keys(a, ['tags', 'weights'], 'affinity');
    if (!(Array.isArray(a.tags) && a.tags.length && a.tags.every(t => tags.has(t)) && isObj(a.weights))) bad('affinity tags/weights');
    if (!Object.entries(a.weights).every(([f, w]) => has(src.families, f) && int(w, 0, 100))) bad('affinity family weight');
  }

  const methods = {};
  if (!isObj(src.methods) || !Object.keys(src.methods).length) bad('methods');
  for (const [id, m] of Object.entries(src.methods)) {
    keys(m, ['name', 'minSamples', 'maxSamples', 'cost', 'conditions', 'blockedReason', 'retired'], `method ${id}`);
    if (!(isSafeId(id) && text(m.name) && text(m.blockedReason) && int(m.minSamples, 1, 3) && int(m.maxSamples, m.minSamples, 3))) bad(`method ${id}`);
    if (m.retired !== undefined && typeof m.retired !== 'boolean') bad(`method ${id} retired`);
    // Operating costs need a one-off draw from Power, which does not exist yet.
    if (m.cost !== undefined && !(isObj(m.cost) && Object.keys(m.cost).length === 0)) bad(`method ${id}: operating costs are not supported yet`);
    methods[id] = { id, name: m.name, minSamples: m.minSamples, maxSamples: m.maxSamples, blockedReason: m.blockedReason, retired: m.retired === true, predicate: cond(m.conditions, `method ${id}`) };
  }

  const discoveries = {}, contracts = {}, credits = {}, warnings = [];
  for (const [id, d] of Object.entries(src.discoveries ?? {})) {
    keys(d, ['name', 'description', 'families', 'eligibility', 'threshold', 'evidence', 'effects', 'retired', 'classification', 'studyOnly'], `discovery ${id}`);
    if (!(isSafeId(id) && !id.includes('/') && text(d.name) && text(d.description) && int(d.threshold, 1))) bad(`discovery ${id}`);
    if (!(Array.isArray(d.families) && d.families.length && d.families.every(f => has(src.families, f)))) bad(`families of ${id}`);
    if (d.studyOnly !== undefined && d.studyOnly !== true) bad(`studyOnly of ${id}`);
    if (d.classification !== undefined && !['principle', 'design'].includes(d.classification)) bad(`classification of ${id}`);
    if (d.retired !== undefined && typeof d.retired !== 'boolean') bad(`retired of ${id}`);
    let effects;
    try { effects = compileEffects(d.effects ?? []); } catch (e) { bad(`discovery ${id} effects: ${e.message}`); }
    if (!Array.isArray(d.evidence) || (d.studyOnly ? d.evidence.length !== 0 || effects.length !== 0 : d.evidence.length === 0)) bad(`evidence of ${id}`);
    const seen = new Set();
    let potential = 0;
    const rules = d.evidence.map(rule => {
      keys(rule, ['id', 'samples', 'conditions', 'insight', 'observation', 'once', 'variants', 'methods'], `evidence of ${id}`);
      if (!isSafeId(rule.id) || rule.id.includes('/') || seen.has(rule.id)) bad(`duplicate or invalid evidence ${id}/${rule.id}`);
      seen.add(rule.id);
      const base = `${id}/${rule.id}`;
      if (rule.methods !== undefined && !(Array.isArray(rule.methods) && rule.methods.length && rule.methods.every(m => has(methods, m)))) bad(`methods of ${base}`);
      if (!(int(rule.insight, 1) && text(rule.observation) && (rule.once === undefined || typeof rule.once === 'boolean'))) bad(`evidence award ${base}`);
      const ruleSamples = samples(rule.samples, base);
      const authoredVariants = rule.variants ?? [{ id: 'base', priority: 0 }];
      if (!(Array.isArray(authoredVariants) && authoredVariants.length && authoredVariants.length <= 16)) bad(`variants of ${base}`);
      const vIds = new Set(), prios = new Set();
      const variants = authoredVariants.map(v => {
        // Method restrictions are rule-level only, as in the reference (no `methods` on variants).
        keys(v, ['id', 'priority', 'samples', 'conditions', 'insight', 'observation'], `variant of ${base}`);
        if (!(isSafeId(v.id) && !v.id.includes('/') && !vIds.has(v.id) && int(v.priority, 0, 1000) && !prios.has(v.priority))) bad(`variant identity/priority ${base}`);
        vIds.add(v.id); prios.add(v.priority);
        const insight = v.insight ?? rule.insight, observation = v.observation ?? rule.observation;
        if (!(int(insight, 1) && text(observation))) bad(`variant award ${base}/${v.id}`);
        const discounts = rule.once ? [100] : [...rep];
        const key = `${base}/${v.id}`;
        credits[key] = { discoveryId: id, limit: discounts.length };
        potential += discounts.reduce((s, p) => s + insight * p / 100, 0);
        return { id: v.id, key, priority: v.priority, samples: v.samples ? samples(v.samples, `${base}/${v.id}`) : ruleSamples,
          predicate: cond(v.conditions, `variant ${base}/${v.id}`), insightUnits: insight * INSIGHT_SCALE, observation, discounts,
          contract: { id: v.id, priority: v.priority, conditions: v.conditions ?? {}, samples: v.samples ?? ruleSamples, insight, discounts } };
      }).sort((a, b) => b.priority - a.priority);
      return { id: rule.id, methods: rule.methods ? [...rule.methods] : null, samples: ruleSamples, predicate: cond(rule.conditions, `rule ${base}`), variants,
        contract: { id: rule.id, conditions: rule.conditions ?? {}, methods: rule.methods ? [...rule.methods].sort() : null, samples: ruleSamples, variants: variants.map(v => v.contract) } };
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!d.studyOnly && potential < d.threshold) warnings.push(`${id}: total baseline evidence cannot reach its threshold`);
    discoveries[id] = { id, name: d.name, description: d.description, families: [...d.families], retired: d.retired === true, studyOnly: d.studyOnly === true,
      classification: d.classification ?? null, thresholdUnits: d.threshold * INSIGHT_SCALE, eligibility: cond(d.eligibility, `eligibility ${id}`), effects, evidence: rules };
    contracts[id] = stableJson({ threshold: d.threshold, eligibility: d.eligibility ?? {}, effects: d.effects ?? [], evidence: rules.map(r => r.contract) });
  }
  // Conservative prerequisite audit: an eligibility referencing only reachable discoveries is reachable.
  const reachable = new Set();
  for (let pass = 0; pass <= discoveryIds.size; pass++) for (const d of Object.values(discoveries)) {
    if (d.retired || reachable.has(d.id)) continue;
    const needs = d.eligibility ? references(d.eligibility).filter(r => r.predicate === 'discovery').map(r => r.value) : [];
    if (needs.every(n => reachable.has(n))) reachable.add(d.id);
  }
  for (const d of Object.values(discoveries)) if (!d.retired && !reachable.has(d.id)) warnings.push(`${d.id}: prerequisite cycle or missing entry route`);
  const ordered = Object.values(discoveries).sort((a, b) => (a.id < b.id ? -1 : 1));

  // Engineering studies (S-51): each grants one study-only design discovery from a machine model.
  const studies = {};
  if (src.studies !== undefined && !isObj(src.studies)) bad('studies');
  for (const [id, s] of Object.entries(src.studies ?? {})) {
    keys(s, ['name', 'revision', 'model', 'processes', 'discovery', 'principles'], `study ${id}`);
    if (!(isSafeId(id) && !id.includes('/') && text(s.name) && int(s.revision, 1))) bad(`study ${id}`);
    const model = content.equipment?.[s.model];
    if (!model?.processes) bad(`study ${id} model must be a machine with processes`);
    if (!(Array.isArray(s.processes) && s.processes.length && new Set(s.processes).size === s.processes.length && s.processes.every(p => has(model.processes, p)))) bad(`study ${id} processes`);
    if (!discoveries[s.discovery]?.studyOnly) bad(`study ${id} must grant a study-only discovery`);
    if (!(Array.isArray(s.principles) && s.principles.every(p => discoveries[p] && !discoveries[p].studyOnly))) bad(`study ${id} principles`);
    studies[id] = { id, name: s.name, revision: s.revision, model: s.model, processes: [...s.processes], discovery: s.discovery, principles: [...s.principles] };
  }
  for (const d of ordered) if (d.studyOnly && !d.retired && !Object.values(studies).some(s => s.discovery === d.id)) warnings.push(`${d.id}: study-only discovery has no study`);
  const studyOrder = Object.values(studies).sort((a, b) => (a.id < b.id ? -1 : 1));
  return { methods, discoveries, ordered, contracts, credits, warnings, studies, studyOrder, families: src.families, affinities: src.affinities };
}

/**
 * Additive content edits keep saved progress compatible (reference isAdditiveContract): the
 * threshold, eligibility and effects are unchanged, and every saved rule and variant still
 * exists unchanged; only new rules or variants may appear.
 */
export function isAdditiveContract(previous, current) {
  if (previous === current) return true;
  try {
    const a = JSON.parse(previous), b = JSON.parse(current);
    if (a.threshold !== b.threshold || stableJson(a.eligibility) !== stableJson(b.eligibility) || stableJson(a.effects) !== stableJson(b.effects)) return false;
    return a.evidence.every(rule => {
      const next = b.evidence.find(r => r.id === rule.id);
      if (!next) return false;
      const { variants, ...base } = rule, { variants: nextVariants, ...nextBase } = next;
      return stableJson(base) === stableJson(nextBase) && variants.every(v => nextVariants.some(n => stableJson(n) === stableJson(v)));
    });
  } catch { return false; }
}

// ---------------------------------------------------------------- samples and profiles

/** Consumed per accepted experiment: the item-authored bulk sample, or one counted item. */
export const sampleCost = (content, itemId) => quantityKind(content, itemId) === 'bulk' ? content.items[itemId].researchSampleCm3 : 1;

/** Sorted samples, the union of their tags, and family affinity weights (once per experiment). */
export function buildProfile(content, catalog, itemIds) {
  const samples = itemIds.map(id => ({ id, tags: [...(content.items[id].tags ?? [])] })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const tags = [...new Set(samples.flatMap(s => s.tags))].sort();
  const families = {};
  for (const a of catalog.affinities) if (a.tags.every(t => tags.includes(t))) for (const [f, w] of Object.entries(a.weights)) families[f] = (families[f] ?? 0) + w;
  return { samples, tags, families };
}

function matchesSet(samples, p) {
  const tags = new Set(samples.flatMap(s => s.tags));
  return (p.items ?? []).every(id => samples.some(s => s.id === id)) &&
    (p.allTags ?? []).every(t => tags.has(t)) &&
    (!(p.anyTags?.length) || p.anyTags.some(t => tags.has(t))) &&
    !(p.excludeTags ?? []).some(t => tags.has(t)) &&
    samples.length >= (p.minSamples ?? 0) && samples.length <= (p.maxSamples ?? Infinity);
}

/** Set predicates over the whole profile; each `distinct` requirement takes a different physical sample. */
export function matchesSamples(profile, p = {}) {
  if (!matchesSet(profile.samples, p)) return false;
  const need = p.distinct ?? [];
  const allocate = (i, remaining) => i === need.length ||
    remaining.some((s, j) => matchesSet([s], need[i]) && allocate(i + 1, remaining.filter((_, k) => k !== j)));
  return allocate(0, profile.samples);
}

// ---------------------------------------------------------------- evidence (pure)

/**
 * Every award this setup would make, in deterministic order (discovery id, rule id). The
 * state given is the pre-experiment state: eligibility and conditions are captured from it.
 */
export function collectEvidence(state, ctx, methodId, profile) {
  const catalog = researchCatalog(ctx.content);
  const q = conditionQueries(state, ctx.geography, ctx.content);
  const holds = ast => ast === null || evaluate(ast, q).ok;
  const known = state.research.discoveries, credits = state.research.credits;
  const out = [];
  for (const d of catalog.ordered) {
    if (d.retired || d.studyOnly || has(known, d.id) || !holds(d.eligibility)) continue;
    for (const rule of d.evidence) {
      if ((rule.methods && !rule.methods.includes(methodId)) || !holds(rule.predicate) || !matchesSamples(profile, rule.samples)) continue;
      // The most informative matching variant applies even when exhausted: no fallback to weaker evidence.
      const variant = rule.variants.find(v => holds(v.predicate) && matchesSamples(profile, v.samples));
      if (!variant) continue;
      const uses = credits[variant.key] ?? 0;
      const discount = variant.discounts[uses] ?? 0;
      if (!discount) continue;
      out.push({ discoveryId: d.id, key: variant.key, uses: uses + 1, baseline: Math.max(1, Math.floor(variant.insightUnits * discount / 100)), observation: variant.observation });
    }
  }
  return out;
}

// ---------------------------------------------------------------- preview (pure)

const reject = (category, reason, extra = {}) => ({ ok: false, category, reason, cost: {}, tendencies: {}, ...extra });

/**
 * Whether this method and sample set can be performed now and would yield new evidence.
 * Never mutates. Reasons never name an undiscovered discovery.
 */
export function previewExperiment(state, ctx, { methodId, samples }) {
  const { content } = ctx;
  const catalog = researchCatalog(content);
  const { hostId } = state.actor;
  const denied = permissionReason(state, ctx.actorId, hostId, 'useFacilities');
  if (denied) return reject('access', denied);
  const method = has(catalog.methods, methodId) ? catalog.methods[methodId] : null;
  if (!method || method.retired) return reject('request', 'Choose an available experiment method.');
  if (method.predicate && !evaluate(method.predicate, conditionQueries(state, ctx.geography, content)).ok) return reject('access', method.blockedReason);
  if (leaseOf(state, ctx.actorId)) return reject('timing', 'You are busy with other work. Finish or cancel it first.');
  if (!Array.isArray(samples) || samples.length < method.minSamples || samples.length > method.maxSamples ||
    samples.some(id => typeof id !== 'string' || !has(content.items, id)) || new Set(samples).size !== samples.length) {
    return reject('request', `Choose ${method.minSamples}–${method.maxSamples} distinct samples you hold.`);
  }
  const cost = {};
  for (const id of samples) cost[id] = sampleCost(content, id);
  const profile = buildProfile(content, catalog, samples);
  const tendencies = { ...profile.families };
  if (Object.entries(cost).some(([id, q]) => heldQty(state, hostId, id) < q)) return reject('materials', 'The selected experiment needs more of these samples than you hold here. Nothing was spent.', { cost, tendencies });
  if (!collectEvidence(state, ctx, methodId, profile).length) {
    return reject('research', 'This setup offers no new evidence. Related setups share their evidence limit. Change materials or use a relevant new clue or capability. Nothing was spent.', { cost, tendencies });
  }
  return { ok: true, cost, tendencies };
}

/**
 * Held items that can contribute new evidence in some setup with this method, including items
 * useful only in combination (reference usefulResearchSamples). An item is useful if removing
 * it from an informative setup loses an evidence key or breaks the method's minimum.
 */
export function usefulSamples(state, ctx, methodId) {
  const { content } = ctx;
  const catalog = researchCatalog(content);
  const method = catalog.methods[methodId];
  const { hostId } = state.actor;
  if (!method || method.retired || permissionReason(state, ctx.actorId, hostId, 'useFacilities')) return new Set();
  if (method.predicate && !evaluate(method.predicate, conditionQueries(state, ctx.geography, content)).ok) return new Set();
  const items = Object.keys(state.inventory?.holds?.[hostId] ?? {}).filter(id => heldQty(state, hostId, id) >= sampleCost(content, id)).sort();
  const cache = new Map();
  const evidence = ids => {
    const k = ids.join('\u0000');
    if (!cache.has(k)) cache.set(k, collectEvidence(state, ctx, methodId, buildProfile(content, catalog, ids)));
    return cache.get(k);
  };
  const useful = new Set();
  const visit = (ids, start) => {
    if (ids.length >= method.minSamples) {
      const matches = evidence(ids);
      if (matches.length) ids.forEach((id, i) => {
        if (useful.has(id)) return;
        const without = ids.filter((_, j) => j !== i);
        if (without.length < method.minSamples || matches.some(m => !evidence(without).some(o => o.key === m.key))) useful.add(id);
      });
    }
    if (ids.length === method.maxSamples || useful.size === items.length) return;
    for (let i = start; i < items.length; i++) visit([...ids, items[i]], i + 1);
  };
  visit([], 0);
  return useful;
}

// ---------------------------------------------------------------- writers

/** Record a discovery (the only discovery store). Never runs experimental effects or fabricates insight. */
export function grantDiscovery(candidate, discoveryId, via) {
  check(VIA.includes(via), `unknown discovery source ${via}`);
  if (has(candidate.research.discoveries, discoveryId)) return false;
  candidate.research.discoveries[discoveryId] = { at: candidate.meta.simulationTime, via };
  append(candidate, 'DISCOVERY_MADE', { discoveryId, via });
  return true;
}

/** Perform an accepted experiment: one transaction pays samples, awards evidence, records history. */
export function runExperiment(candidate, ctx, { methodId, samples }) {
  const { content } = ctx;
  const p = previewExperiment(candidate, ctx, { methodId, samples });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const catalog = researchCatalog(content);
  const profile = buildProfile(content, catalog, samples);
  const matches = collectEvidence(candidate, ctx, methodId, profile);   // eligibility captured before any change
  const r = candidate.research;
  const insight = {}, observations = [];
  for (const m of matches) {
    const d = catalog.discoveries[m.discoveryId];
    insight[d.id] = Math.min(d.thresholdUnits, (insight[d.id] ?? r.insight[d.id] ?? 0) + m.baseline);
    if (!observations.includes(m.observation)) observations.push(m.observation);
  }
  const learned = Object.keys(insight).filter(id => insight[id] >= catalog.discoveries[id].thresholdUnits && !has(r.discoveries, id)).sort();
  const effectCtx = { ...ctx, sourceRef: null };
  for (const id of learned) preflightEffects(candidate, catalog.discoveries[id].effects, effectCtx);
  check(r.attemptCount < Number.MAX_SAFE_INTEGER, 'research attempt counter is full');

  withdraw(candidate, candidate.actor.hostId, p.cost);
  Object.assign(r.insight, insight);
  for (const m of matches) r.credits[m.key] = m.uses;
  for (const id of Object.keys(insight)) r.contracts[id] = catalog.contracts[id];
  for (const [f, w] of Object.entries(profile.families)) r.exposure[f] = Math.min(EXPOSURE_LIMIT, (r.exposure[f] ?? 0) + w);
  r.attemptCount += 1;
  r.attempts.push({ id: r.attemptCount, time: candidate.meta.simulationTime, hostId: candidate.actor.hostId, placeId: candidate.actor.placeId,
    methodId, inputs: profile.samples.map(s => s.id), observations: observations.slice(0, 32), discoveries: [...learned] });
  if (r.attempts.length > JOURNAL_LIMIT) r.attempts.splice(0, r.attempts.length - JOURNAL_LIMIT);
  append(candidate, 'EXPERIMENT_PERFORMED', { attemptId: r.attemptCount, methodId });
  // Grant the whole result first, then run each newly learned discovery's effects once, in id order.
  for (const id of learned) grantDiscovery(candidate, id, 'experiment');
  for (const id of learned) applyEffects(candidate, catalog.discoveries[id].effects, effectCtx);
  const names = learned.map(id => catalog.discoveries[id].name);
  const message = [...observations.slice(0, 3), names.length ? `Discovered: ${names.join(', ')}.` : 'Observations recorded. Your research has advanced.'].join(' ');
  return { kind: 'EXPERIMENT_PERFORMED', message, changes: { spent: p.cost, discoveries: learned } };
}

// ---------------------------------------------------------------- engineering studies (S-51)

/**
 * The one qualifying-operation predicate (PF-10/B04), shared by receipt admission, study
 * eligibility and validation. `op` is a completed run or a stored receipt; `bank` is the
 * machine it ran on. It depends only on persisted provenance: the machine model, the process,
 * the issuer and — for a run — the machine origin and the bank. Whether the run's order still
 * exists does not matter. Pure.
 */
export function qualifyingOperation(study, op, bank, bankId, actorId) {
  if (!bank || bank.model !== study.model || !study.processes.includes(op.processId) || op.issuedBy !== actorId) return false;
  if ('origin' in op) return op.origin === 'machine' && op.bankId === bankId;
  return true;
}

const receiptKey = (studyId, bankId) => `${studyId}/${bankId}`;

/**
 * Admission: record a receipt for every completed run that qualifies for a study not yet done
 * (same transaction as the completion; the latest receipt per study and machine is kept).
 */
export function recordStudyOperations(candidate, ctx, done) {
  const catalog = researchCatalog(ctx.content);
  if (!catalog.studyOrder.length) return;
  const r = candidate.research;
  for (const { run } of done) {
    if (run.origin !== 'machine') continue;
    const bank = candidate.equipment.banks[run.bankId];
    for (const study of catalog.studyOrder) {
      if (has(r.studies, study.id) || has(r.discoveries, study.discovery)) continue;
      if (!qualifyingOperation(study, run, bank, run.bankId, PLAYER)) continue;
      r.studyReceipts[receiptKey(study.id, run.bankId)] = { at: candidate.meta.simulationTime, processId: run.processId, issuedBy: run.issuedBy, revision: study.revision };
    }
  }
}

/**
 * Whether the character can study this machine for this study now (pure; the observer shows the
 * action only when this is ok, so no undiscovered branch is hinted at). Reasons never name the
 * study's discovery.
 */
export function studyPreview(state, ctx, { studyId, bankId }) {
  const catalog = researchCatalog(ctx.content);
  const study = has(catalog.studies, studyId) ? catalog.studies[studyId] : null;
  const bank = state.equipment?.banks?.[bankId];
  const r = state.research;
  if (!study || !bank || bank.model !== study.model || has(r.studies, studyId) || has(r.discoveries, study.discovery)) return reject('request', 'There is nothing to study here.');
  const { hostId, placeId } = state.actor;
  if (bank.hostId !== hostId) return reject('request', 'There is nothing to study here.');
  const denied = permissionReason(state, ctx.actorId, hostId, 'useFacilities');
  if (denied) return reject('access', denied);
  if (bank.placeId !== placeId) return reject('access', 'You need to be in the machine\'s room to study it.');
  if (!isOperational(bank)) return reject('access', 'The machine must be operational to study it.');
  if (leaseOf(state, ctx.actorId)) return reject('timing', 'You are busy with other work. Finish or cancel it first.');
  if (!study.principles.every(p => has(r.discoveries, p))) return reject('research', 'You do not yet understand enough to study this machine.');
  const d = catalog.discoveries[study.discovery];
  if (d.eligibility && !evaluate(d.eligibility, conditionQueries(state, ctx.geography, ctx.content)).ok) return reject('research', 'You do not yet understand enough to study this machine.');
  const receipt = r.studyReceipts[receiptKey(studyId, bankId)];
  if (!receipt || receipt.revision !== study.revision || !qualifyingOperation(study, receipt, bank, bankId, ctx.actorId)) return reject('research', 'Operate the machine first, then study how it works.');
  return { ok: true, study };
}

/** Study a machine (instant; consumes nothing; grants the study's design discovery once). */
export function studyEquipment(candidate, ctx, { studyId, bankId }) {
  const p = studyPreview(candidate, ctx, { studyId, bankId });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const { study } = p;
  const r = candidate.research, bank = candidate.equipment.banks[bankId];
  grantDiscovery(candidate, study.discovery, 'study');
  r.studies[studyId] = { at: candidate.meta.simulationTime, hostId: bank.hostId, placeId: bank.placeId, bankId, model: bank.model };
  for (const key of Object.keys(r.studyReceipts)) if (key.startsWith(`${studyId}/`)) delete r.studyReceipts[key];
  append(candidate, 'DESIGN_STUDIED', { studyId, bankId, discoveryId: study.discovery });
  const catalog = researchCatalog(ctx.content);
  const label = ctx.content.equipment[bank.model].label.toLowerCase();
  return { kind: 'DESIGN_STUDIED', message: `You study the ${label} at work. Discovered: ${catalog.discoveries[study.discovery].name}.`, changes: { discoveries: [study.discovery] } };
}

/** Create the research record (world creation only). */
export function initializeResearch(candidate) {
  check(!has(candidate, 'research'), 'research already exists');
  candidate.research = { discoveries: {}, insight: {}, credits: {}, contracts: {}, exposure: {}, attemptCount: 0, attempts: [], studyReceipts: {}, studies: {} };
  requireSlice(candidate, 'research');
}

// ---------------------------------------------------------------- validation

const RESEARCH_KEYS = 'attemptCount,attempts,contracts,credits,discoveries,exposure,insight,studies,studyReceipts';
const RECEIPT_KEYS = 'at,issuedBy,processId,revision';
const STUDY_KEYS = 'at,bankId,hostId,model,placeId';
const ATTEMPT_KEYS = 'discoveries,hostId,id,inputs,methodId,observations,placeId,time';

export function validateResearch(state, geography, content) {
  const catalog = researchCatalog(content);
  const r = state.research, now = state.meta.simulationTime;
  check(isObj(r) && Object.keys(r).sort().join() === RESEARCH_KEYS, `research must be exactly {${RESEARCH_KEYS}}`);
  for (const k of ['discoveries', 'insight', 'credits', 'contracts', 'exposure']) check(isObj(r[k]), `research.${k} must be an object`);
  check(Number.isSafeInteger(r.attemptCount) && r.attemptCount >= 0, 'research.attemptCount invalid');
  const compatible = id => has(r.contracts, id) && isAdditiveContract(r.contracts[id], catalog.contracts[id]);
  for (const [id, d] of Object.entries(r.discoveries)) {
    check(has(catalog.discoveries, id), `unknown discovery ${id}`);
    check(isObj(d) && Object.keys(d).sort().join() === 'at,via' && Number.isFinite(d.at) && d.at >= 0 && d.at <= now && VIA.includes(d.via), `discovery record ${id} invalid`);
  }
  for (const [id, units] of Object.entries(r.insight)) {
    const d = catalog.discoveries[id];
    check(d && Number.isSafeInteger(units) && units > 0 && units <= d.thresholdUnits, `insight ${id} invalid`);
    check(units < d.thresholdUnits || has(r.discoveries, id), `insight ${id} reached its threshold without a discovery`);
    check(compatible(id), `research content for ${id} changed incompatibly; an explicit migration is required`);
  }
  for (const [key, uses] of Object.entries(r.credits)) {
    const c = catalog.credits[key];
    check(c && Number.isSafeInteger(uses) && uses >= 1 && uses <= c.limit && uses <= r.attemptCount, `evidence credit ${key} invalid`);
    check((r.insight[c.discoveryId] ?? 0) > 0, `evidence credit ${key} has no insight`);
  }
  for (const id of Object.keys(r.contracts)) check(has(r.insight, id), `contract ${id} has no insight`);
  for (const [f, v] of Object.entries(r.exposure)) check(has(catalog.families, f) && Number.isSafeInteger(v) && v >= 0 && v <= EXPOSURE_LIMIT, `family exposure ${f} invalid`);
  check(Array.isArray(r.attempts) && r.attempts.length === Math.min(r.attemptCount, JOURNAL_LIMIT), 'research journal length invalid');
  let lastTime = 0;
  r.attempts.forEach((a, i) => {
    check(isObj(a) && Object.keys(a).sort().join() === ATTEMPT_KEYS, 'research attempt fields invalid');
    check(a.id === r.attemptCount - r.attempts.length + i + 1, 'research journal sequence invalid');
    check(has(catalog.methods, a.methodId), `attempt ${a.id} method unknown`);
    check(has(siteOf(state, geography, a.hostId)?.places ?? {}, a.placeId), `attempt ${a.id} location does not resolve`);
    check(Number.isFinite(a.time) && a.time >= lastTime && a.time <= now, `attempt ${a.id} time invalid`);
    lastTime = a.time;
    check(Array.isArray(a.inputs) && a.inputs.length >= 1 && a.inputs.length <= 3 && new Set(a.inputs).size === a.inputs.length && a.inputs.every(id => has(content.items, id)), `attempt ${a.id} inputs invalid`);
    check(Array.isArray(a.observations) && a.observations.length >= 1 && a.observations.length <= 32 && a.observations.every(text), `attempt ${a.id} observations invalid`);
    check(Array.isArray(a.discoveries) && new Set(a.discoveries).size === a.discoveries.length && a.discoveries.every(id => has(r.discoveries, id)), `attempt ${a.id} discoveries invalid`);
  });
  // Studies (S-51): every receipt still satisfies the shared qualifying-operation predicate.
  check(isObj(r.studyReceipts) && isObj(r.studies), 'research study records must be objects');
  for (const [key, rec] of Object.entries(r.studyReceipts)) {
    const [studyId, bankId, extra] = key.split('/');
    const study = catalog.studies[studyId], bank = state.equipment?.banks?.[bankId];
    check(study && bank && extra === undefined, `study receipt ${key} does not resolve`);
    check(!has(r.studies, studyId), `study receipt ${key} outlived its completed study`);
    check(isObj(rec) && Object.keys(rec).sort().join() === RECEIPT_KEYS && Number.isFinite(rec.at) && rec.at >= 0 && rec.at <= now && int(rec.revision, 1), `study receipt ${key} invalid`);
    check(qualifyingOperation(study, rec, bank, bankId, PLAYER), `study receipt ${key} is not a qualifying operation`);
  }
  for (const [studyId, s] of Object.entries(r.studies)) {
    const study = catalog.studies[studyId];
    check(study, `unknown study ${studyId}`);
    check(isObj(s) && Object.keys(s).sort().join() === STUDY_KEYS && Number.isFinite(s.at) && s.at >= 0 && s.at <= now && s.model === study.model, `study record ${studyId} invalid`);
    check(has(siteOf(state, geography, s.hostId)?.places ?? {}, s.placeId), `study record ${studyId} location does not resolve`);
    check(r.discoveries[study.discovery]?.via === 'study', `study ${studyId} has no study-granted discovery`);
  }
}
