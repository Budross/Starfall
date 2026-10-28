// Technology layer (Stage 5, S-55; SIGNOFF "Research and technology direction"). Principles are
// research discoveries; technologies are ways to provide a capability; capabilities are the
// authored vocabulary of `provides` and `capabilities`. Technologies are DERIVED from content —
// an installable equipment model, its product's recipes and the knowledge those unlock — and are
// never stored. This module is pure content analysis: it names no content id (Z-01).
//
//   technologies(content)          every installable model as a technology with a trade-off profile
//   reachability(content, seeds)   what can be obtained and learned from a set of physical sources
//   worldSeeds / guaranteedSeeds   sources in some world (grounding) / in every world (story path)
//   auditTechnology(content)       {errors, warnings}: grounding and story path are errors,
//                                  strict dominance is a warning (rules 1, 3 and 7)
import { has, isObj } from './shape.js';
import { compile, evaluate, references } from '../rules/conditions.js';
import { researchCatalog, buildProfile, matchesSamples } from '../domain/research.js';

const cache = new WeakMap();
const memo = (content, key, fn) => {
  let c = cache.get(content);
  if (!c) { c = {}; cache.set(content, c); }
  if (!has(c, key)) c[key] = fn();
  return c[key];
};
const asts = new WeakMap();
const ast = (cond, mode = 'requires') => {
  let byMode = asts.get(cond);
  if (!byMode) { byMode = {}; asts.set(cond, byMode); }
  return byMode[mode] ??= compile(cond, { mode });
};

/** The recipe used to cost an item: the one whose id equals the item, else the first by id. */
function defaultRecipe(content, itemId) {
  if (content.recipes[itemId]?.output === itemId) return content.recipes[itemId];
  const ids = Object.keys(content.recipes).filter(id => content.recipes[id].output === itemId).sort();
  return ids.length ? content.recipes[ids[0]] : null;
}

/** Raw resources (cm³) one unit of an item costs through default recipes; unmade parts count as themselves. */
function rawCost(content, itemId, qty, out = {}, depth = 0) {
  const r = content.items[itemId].category === 'resource' || depth > 16 ? null : defaultRecipe(content, itemId);
  if (!r) { out[itemId] = (out[itemId] ?? 0) + qty; return out; }
  for (const slot of r.inputs) rawCost(content, slot.item ?? slot.anyOf[0], slot.qty * qty / r.qty, out, depth + 1);
  return out;
}

/** Every installable model as a technology: {id, product, provides, capabilities, recipes, knowledge, profile}. */
export function technologies(content) {
  return memo(content, 'technologies', () => Object.entries(content.equipment).filter(([, m]) => m.item).map(([id, m]) => {
    const recipes = Object.keys(content.recipes).filter(rid => content.recipes[rid].output === m.item).sort();
    const knowledge = new Set();
    for (const cond of [content.items[m.item].unlock, ...recipes.map(rid => content.recipes[rid].unlock)]) {
      if (cond) for (const r of references(ast(cond, 'unlock'))) if (r.predicate === 'discovery') knowledge.add(r.value);
    }
    return {
      id, product: m.item, provides: { ...(m.provides ?? {}) }, capabilities: [...(m.capabilities ?? [])], recipes, knowledge: [...knowledge].sort(),
      profile: {
        capacity: { ...(m.provides ?? {}) },
        volumeCm3: content.items[m.item].unitVolumeCm3,
        baseline: m.baseline ?? 0,
        resources: rawCost(content, m.item, 1),
        upkeep: Object.values(m.repair?.inputs ?? {}).reduce((a, b) => a + b, 0)
      }
    };
  }));
}

// ---------------------------------------------------------------- reachability

/** Sources in some world: every authored deposit, every generated resource, starting equipment and authored evidence. */
export function worldSeeds(content) {
  const w = content.world;
  return seedsFrom(content, Object.keys(w.sites), Object.keys(content.worldgen.resources));
}

/** Sources in every world: the start site's authored deposits, starting equipment and evidence only. */
export function guaranteedSeeds(content) {
  return seedsFrom(content, [content.world.start.hostId], []);
}

function seedsFrom(content, siteKeys, extraItems) {
  const items = new Set(extraItems), models = new Set(), subjects = [];
  for (const key of siteKeys) {
    const s = content.world.sites[key];
    for (const d of Object.values(s.deposits ?? {})) items.add(d.itemId);
    for (const e of s.equipment ?? []) models.add(e.model);
    for (const p of Object.values(s.places)) for (const sub of Object.values(p.subjects)) if (sub.kind === 'evidence') subjects.push(sub);
  }
  // Manufactured equipment is never a seed: it becomes reachable through its production prerequisites.
  return { items, models, subjects };
}

const tagsOf = (content, id) => content.items[id].tags ?? [];

/** Whether some set of at most `max` obtainable items matches every spec (one physical profile). */
function sampleable(content, catalog, specs, items, min, max) {
  const needed = new Set();
  const collect = p => {
    if (!p) return;
    for (const k of ['allTags', 'anyTags']) (p[k] ?? []).forEach(t => needed.add(`t:${t}`));
    (p.items ?? []).forEach(i => needed.add(`i:${i}`));
    (p.distinct ?? []).forEach(collect);
  };
  specs.forEach(collect);
  const excluded = new Set(specs.flatMap(p => p?.excludeTags ?? []));
  const pool = [...items].filter(id => !tagsOf(content, id).some(t => excluded.has(t))).sort();
  const relevant = pool.filter(id => needed.has(`i:${id}`) || tagsOf(content, id).some(t => needed.has(`t:${t}`)));
  const candidates = [...relevant, ...pool.filter(id => !relevant.includes(id)).slice(0, 2)];
  const visit = (chosen, start) => {
    if (chosen.length >= min) {
      const profile = buildProfile(content, catalog, chosen);
      if (specs.every(p => matchesSamples(profile, p ?? {}))) return true;
    }
    if (chosen.length === max) return false;
    for (let i = start; i < candidates.length; i++) if (visit([...chosen, candidates[i]], i + 1)) return true;
    return false;
  };
  return visit([], 0);
}

/**
 * What can be obtained and learned from `seeds`, ignoring quantities (a fixpoint over authored
 * content). Returns {items, models, capabilities, discoveries, fragments} as Sets.
 */
export function reachability(content, seeds) {
  const catalog = researchCatalog(content);
  const items = new Set(seeds.items), models = new Set(seeds.models), discoveries = new Set(), fragments = new Set();
  const capabilities = () => new Set([...models].flatMap(m => content.equipment[m].capabilities ?? []));
  const queries = caps => ({
    discovery: id => discoveries.has(id), fragment: id => fragments.has(id), flag: () => false, met: () => false,
    capability: id => caps.has(id), atHost: () => true, atPlace: () => true, holds: ({ itemId }) => items.has(itemId)
  });
  const holds = (cond, q, mode = 'requires') => !cond || evaluate(ast(cond, mode), q).ok;
  for (let changed = true; changed;) {
    changed = false;
    const add = (set, v) => { if (!set.has(v)) { set.add(v); changed = true; } };
    const caps = capabilities(), q = queries(caps);
    for (const sub of seeds.subjects) {
      if (!holds(sub.perceivedWhen, q, 'unlock')) continue;
      for (const e of sub.effects ?? []) if (isObj(e) && e.grantFragment) add(fragments, e.grantFragment);
    }
    for (const r of Object.values(content.recipes)) {
      if (!holds(r.unlock, q, 'unlock') || (r.tool !== null && !caps.has(r.tool))) continue;
      if (r.inputs.every(slot => (slot.item ? [slot.item] : slot.anyOf).some(o => items.has(o)))) add(items, r.output);
    }
    for (const id of [...items]) { const m = content.items[id].installs; if (m) add(models, m); }
    for (const m of [...models]) {
      for (const p of Object.values(content.equipment[m].processes ?? {})) {
        if (!holds(p.unlock, q, 'unlock')) continue;
        if (p.kind === 'extract') continue;   // extraction yields only deposit items, which are already sources
        if (Object.keys(p.inputs).every(i => items.has(i))) for (const o of Object.keys(p.outputs)) add(items, o);
      }
    }
    const samplePool = [...items];
    for (const d of catalog.ordered) {
      if (d.retired || d.studyOnly || discoveries.has(d.id) || (d.eligibility && !evaluate(d.eligibility, q).ok)) continue;
      let potential = 0;
      for (const rule of d.evidence) {
        if (rule.predicate && !evaluate(rule.predicate, q).ok) continue;
        const methods = Object.values(catalog.methods).filter(mt => !mt.retired && (!rule.methods || rule.methods.includes(mt.id)) && (!mt.predicate || evaluate(mt.predicate, q).ok));
        // The strongest variant this world could ever apply for the rule.
        const best = rule.variants.filter(v => !v.predicate || evaluate(v.predicate, q).ok)
          .filter(v => methods.some(mt => sampleable(content, catalog, [rule.samples, v.samples], samplePool, mt.minSamples, mt.maxSamples)))
          .reduce((top, v) => Math.max(top, v.discounts.reduce((s, p) => s + v.insightUnits * p / 100, 0)), 0);
        potential += best;
      }
      if (potential >= d.thresholdUnits) add(discoveries, d.id);
    }
    for (const s of catalog.studyOrder) {
      if (discoveries.has(s.discovery) || !models.has(s.model) || !s.principles.every(p => discoveries.has(p))) continue;
      const d = catalog.discoveries[s.discovery];
      if (d.eligibility && !evaluate(d.eligibility, q).ok) continue;
      if (s.processes.some(pid => holds(content.equipment[s.model].processes[pid].unlock, q, 'unlock'))) add(discoveries, s.discovery);
    }
  }
  return { items, models, capabilities: capabilities(), discoveries, fragments };
}

// ---------------------------------------------------------------- audit

/** Whether profile a strictly dominates b: at least as good on every axis and better on one. */
function dominates(a, b, key) {
  const axes = [[a.capacity[key] ?? 0, b.capacity[key] ?? 0, 1], [a.volumeCm3, b.volumeCm3, -1], [a.baseline, b.baseline, -1], [a.upkeep, b.upkeep, -1]];
  for (const r of new Set([...Object.keys(a.resources), ...Object.keys(b.resources)])) axes.push([a.resources[r] ?? 0, b.resources[r] ?? 0, -1]);
  let better = false;
  for (const [x, y, sign] of axes) {
    const d = (x - y) * sign;
    if (d < -1e-9) return false;
    if (d > 1e-9) better = true;
  }
  return better;
}

/**
 * Content audit (S-55): (a) every discovery and every technology's product has a physically
 * grounded route in some world — exploration materials count, so optional technology is not
 * limited to the starting habitat; (b) no technology strictly dominates another providing the same
 * capability (a warning); (c) every story-path entry is reachable from the guaranteed start.
 */
export function auditTechnology(content) {
  return memo(content, 'audit', () => {
    const errors = [], warnings = [];
    const world = reachability(content, worldSeeds(content));
    const catalog = researchCatalog(content);
    for (const d of catalog.ordered) if (!d.retired && !world.discoveries.has(d.id)) errors.push(`discovery ${d.id} has no physically grounded route`);
    const techs = technologies(content);
    for (const t of techs) if (!world.items.has(t.product)) errors.push(`technology ${t.id} (${t.product}) has no physically grounded route`);
    for (const key of Object.keys(content.provisions)) {
      const group = techs.filter(t => (t.provides[key] ?? 0) > 0);
      for (const a of group) for (const b of group) if (a !== b && dominates(a.profile, b.profile, key)) warnings.push(`technology ${a.id} strictly dominates ${b.id} for ${key}`);
    }
    const start = reachability(content, guaranteedSeeds(content));
    for (const e of content.storyPath ?? []) {
      if (e.discovery !== undefined && !start.discoveries.has(e.discovery)) errors.push(`story path: discovery ${e.discovery} is not reachable from the guaranteed start`);
      if (e.item !== undefined && !start.items.has(e.item)) errors.push(`story path: item ${e.item} is not reachable from the guaranteed start`);
    }
    return { errors, warnings };
  });
}
