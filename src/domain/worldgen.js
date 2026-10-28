// Seeded procedural generation for one Area (S-23). Pure: the same (profile, area, seed)
// always yields the same bodies, and every draw is keyed by area id, so adding Areas
// later never changes existing ones. Output is validated finite before it is frozen
// into geography by the world-creation transaction (PF-12).
//
// Resource fields are clustered (rich / marginal / empty regions, Habitat05_01 §3).
// Composition shares use max-subtract normalization so no accepted profile can
// underflow to NaN.
import { keyed } from '../core/rng.js';
import { dist, isVec3 } from '../core/shape.js';

export class WorldgenError extends Error { constructor(m) { super(m); this.name = 'WorldgenError'; } }

/** Uniform point in a vertically squashed ball. */
function pointInBall(r, center, radius, squash) {
  for (let i = 0; i < 16; i++) {
    const x = r(i, 'x') * 2 - 1, y = r(i, 'y') * 2 - 1, z = r(i, 'z') * 2 - 1;
    if (x * x + y * y + z * z <= 1) return { x: center.x + x * radius, y: center.y + y * radius * squash, z: center.z + z * radius };
  }
  return { ...center };
}

/**
 * Generate the bodies of one Area. Viability (the procedural guarantee): at least one
 * body holds a deposit ≥ opportunity.minDepositCm3 within opportunity.maxDistance of
 * the Area centre. Opening resources are NOT required here; they are authored.
 *
 * @param profile  WORLDGEN profile
 * @param area     {id, center, radius}
 * @param seed     uint32 world seed
 * @param anchors  [{id, position}] stationary anchors to keep clear of
 * @returns {bodies: {id: {areaId, position, scale, deposits{nodeId: {itemId, initial}}}}, attempt}
 */
export function generateArea(profile, area, seed, anchors = [], { bodies: count = profile.bodies } = {}) {
  let lastReason = 'no attempts';
  for (let attempt = 0; attempt < profile.maxAttempts; attempt++) {
    const bodies = attemptArea(profile, area, seed, anchors, attempt, count);
    lastReason = viabilityProblem(profile, area, bodies);
    if (!lastReason) return { bodies, attempt };
  }
  throw new WorldgenError(`Area ${area.id} is not viable after ${profile.maxAttempts} attempts: ${lastReason}`);
}

function attemptArea(profile, area, seed, anchors, attempt, count) {
  const rev = profile.generatorRevision;
  const k = (...keys) => keyed(seed, rev, area.id, attempt, ...keys);

  // Resource fields: a few clusters per resource, each with a centre and richness.
  const fields = Object.entries(profile.resources).map(([itemId, spec]) => ({
    itemId, sigma: spec.sigma,
    clusters: Array.from({ length: spec.clusters }, (_, c) => ({
      center: pointInBall((i, ax) => k('field', itemId, c, i, ax), area.center, area.radius * profile.fill, profile.verticalSquash),
      logRich: Math.log(spec.richness[0] + (spec.richness[1] - spec.richness[0]) * k('rich', itemId, c))
    }))
  }));

  const placed = [];
  const out = {};
  for (let i = 0; i < count; i++) {
    let pos = null;
    for (let t = 0; t < profile.placementTries && !pos; t++) {
      const p = pointInBall((j, ax) => k('pos', i, t, j, ax), area.center, area.radius * profile.fill, profile.verticalSquash);
      if (placed.some(q => dist(p, q) < profile.minSpacing)) continue;
      if (anchors.some(a => dist(p, a.position) < profile.anchorClearance)) continue;
      pos = p;
    }
    if (!pos) continue;   // deterministic skip when the area is crowded
    placed.push(pos);

    // Log field strength per resource (max over clusters), then max-subtract shares.
    const logs = fields.map(f => Math.max(...f.clusters.map(c => c.logRich - dist(pos, c.center) ** 2 / (2 * f.sigma * f.sigma))));
    const top = Math.max(...logs);
    const strength = Math.exp(top);                       // ∈ (0, 1]
    const weights = logs.map(l => Math.exp(l - top));     // max-subtract: largest weight is exactly 1
    const total = weights.reduce((a, b) => a + b, 0);
    const id = `b.${area.id}.${i}`;
    const deposits = {};
    if (strength >= profile.emptyBelow) {
      const ranked = fields.map((f, j) => ({ itemId: f.itemId, share: weights[j] / total }))
        .filter(r => r.share >= profile.minShare).sort((a, b) => b.share - a.share || (a.itemId < b.itemId ? -1 : 1))
        .slice(0, profile.maxNodes);
      ranked.forEach((r, n) => {
        const q = Math.floor(strength * r.share * profile.maxNodeCm3 / profile.quantumCm3) * profile.quantumCm3;
        if (q >= profile.quantumCm3) deposits[`${id}.n${n}`] = { itemId: r.itemId, initial: q };
      });
    }
    const scale = profile.scale[0] + (profile.scale[1] - profile.scale[0]) * k('scale', i);
    out[id] = { areaId: area.id, position: pos, scale: Math.round(scale * 100) / 100, deposits };
  }
  assertFinite(out);
  return out;
}

function assertFinite(bodies) {
  for (const [id, b] of Object.entries(bodies)) {
    if (!isVec3(b.position) || !Number.isFinite(b.scale)) throw new WorldgenError(`body ${id} is not finite`);
    for (const [n, d] of Object.entries(b.deposits)) {
      if (!Number.isSafeInteger(d.initial) || d.initial <= 0) throw new WorldgenError(`deposit ${n} is not a positive integer`);
    }
  }
}

function viabilityProblem(profile, area, bodies) {
  const { minDepositCm3, maxDistance } = profile.opportunity;
  const ok = Object.values(bodies).some(b => dist(b.position, area.center) <= maxDistance
    && Object.values(b.deposits).some(d => d.initial >= minDepositCm3));
  return ok ? null : `no external deposit ≥ ${minDepositCm3} cm³ within ${maxDistance} wu`;
}
