// Every tunable value in the slice, each carrying its sign-off tag (docs/SIGNOFF.md).
// Values tagged PENDING are proposed defaults, not approved design; Z-02 enforces the tags.
// Changing a value here must never require an engine change.
const tag = (signoff, value) => Object.freeze({ signoff, value: deepFreeze(value) });
function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }

/** World coordinate scale, in abstract world units (wu). */
export const SCALE = tag('APPROVED S-04', {
  swarmShell: [460, 610],   // distance band of habitats and megastructures from the star
  areaRadius: 200,          // Area neighbourhood radius
  localSpacing: [10, 60]    // typical spacing between local sites
});

/** Persistence performance objectives (objectives, not limits). */
export const PERFORMANCE = tag('APPROVED S-18', {
  tickP95Ms: 25,
  dynamicStateBytes: 100_000
});

/** Docking berths per authored site. */
export const BERTHS = tag('APPROVED S-07', { habitat: 2, secondStation: 2 });

/** Geometric visibility: stationary objects within this distance of the character's host are seen. */
export const VISIBILITY = tag('APPROVED S-22', { visualRange: 120 });

/** Procedural generation profile (one Area in the slice). Deposit amounts are integer cm³. */
export const WORLDGEN = tag('PENDING S-23', {
  generatorRevision: 'h05-gen-1',
  bodies: 24,
  fill: 0.92,               // bodies are placed within fill × area radius
  verticalSquash: 0.45,     // fields are flattened discs rather than spheres
  minSpacing: 10,
  anchorClearance: 14,
  placementTries: 40,
  maxAttempts: 8,
  scale: [1.6, 4.4],
  emptyBelow: 0.12,         // field strength below which a body carries no deposits
  minShare: 0.18,           // composition share needed for a deposit node
  maxNodes: 3,
  maxNodeCm3: 40_000_000,   // 40 m³ at full field strength
  quantumCm3: 10_000,       // deposits are whole multiples of 0.01 m³
  resources: {
    'iron-ore':          { clusters: 2, sigma: 42, richness: [0.35, 1] },
    'silicate-minerals': { clusters: 3, sigma: 55, richness: [0.25, 0.9] },
    'water-ice':         { clusters: 1, sigma: 38, richness: [0.4, 1] }
  },
  opportunity: { minDepositCm3: 5_000_000, maxDistance: 150 }
});

/** Anchor placement (spherical: azimuth°, elevation°, radius wu; offsets in wu). */
export const PLACEMENT = tag('PENDING S-24', {
  habitat: { az: 26, el: -8, r: 460 },
  secondStationOffset: { right: 44, up: 8, forward: 14 },   // ≈ 47 wu from Habitat 05
  secondStationDistance: [40, 60],
  megastructure: { marker: { az: 16, el: 14, r: 610 },
    footprint: { azStart: -17, azEnd: 47, elevation: 6, height: 21, radius: 580, gaps: [[0.19, 0.25], [0.51, 0.56], [0.8, 0.83]] } },
  minAnchorSeparation: 20
});

/**
 * Minimal nearby traffic (Stage 3): one station-operator tender on an authored inbound
 * journey to the second station. Its energy-only drive is this vessel's own propulsion
 * capability, not a rule for vessels in general.
 */
export const TRAFFIC = tag('PENDING S-27', {
  tenderStartBeyondStation: 140,   // wu past the second station, on the far side from Habitat 05
  tenderPropulsion: { kind: 'energy-drive', speed: 1.5, energyPerWu: 0.2, capacity: 120 },   // wu/s, U/wu, U
  tenderInitialEnergy: 90,         // U
  approachStandoff: 4              // wu: holding point off a station, toward the approach origin
});

/**
 * Simulation scheduling (S-29, changed 2026-10-25): a late tick while visible catches up by at
 * most 5 s; a gap over 30 s is suspension (e.g. unreported sleep) and is discarded.
 */
export const SCHEDULING = tag('APPROVED S-29', { maxCatchUpSeconds: 5, suspendAfterSeconds: 30 });

/** Habitat 05's authored local deposits (cm³) and the opening minimums they must meet. */
export const OPENING_DEPOSITS = tag('APPROVED S-15', {
  habitat: { 'scrap-metal': 12_000_000, 'electronic-salvage': 3_000_000, 'silicate-minerals': 72_000_000 },
  minimums: { 'scrap-metal': 1_000_000, 'electronic-salvage': 500_000 }
});

/**
 * Opening physical values (Stage 4; reference `locationContent.js`, `content.js`). Amounts in
 * integer cm³ for bulk resources, U and U/s for power, seconds for work.
 */
export const OPENING = tag('APPROVED S-15', {
  holdCapacityCm3: 128_000_000,                 // Habitat 05 hold: 128 m³
  initialReserve: 60,                           // U
  batteryStorage: 200,                          // U per battery bank
  lifeSupportLoad: 0.2,                         // U/s mandatory load
  solarGeneration: 0.4,                         // U/s per array at full health
  solarStartingHealth: 0.2,                     // → 0.08 U/s at start; net −0.12 U/s
  collection: {                                 // per manual collection (2 s each; reference 6 s)
    'scrap-metal': { amount: 50_000, duration: 2 },
    'electronic-salvage': { amount: 25_000, duration: 2 },
    'silicate-minerals': { amount: 100_000, duration: 2 }
  },
  ironPart: { scrapCm3: 20_000, duration: 4 },  // 0.02 m³ scrap → 1 part, 4 s
  arrayRepairParts: 2
});

/** Research sample sizes per accepted experiment (item-authored; reference `researchSampleM3`). */
export const SAMPLE_SIZES = tag('APPROVED S-15', {
  'scrap-metal': 10_000, 'electronic-salvage': 5_000, 'silicate-minerals': 10_000, 'iron-ore': 10_000, 'water-ice': 10_000
});

/**
 * Research award policy (reference `researchDefinitions`): repeat discounts. There is no
 * chance bonus: research is deterministic (S-33 D-3, decided 2026-10-26).
 */
export const RESEARCH_POLICY = tag('APPROVED S-15', {
  repetition: [100, 40, 10],
  structuralFabrication: { threshold: 8, metalTest: 6, fittingClue: 2 }
});

/**
 * Industrial-stage research values (reference `researchContent.js`; the NPC advice rules are
 * replaced by authored clue sources). Thresholds and insight per evidence rule.
 */
export const RESEARCH_INDUSTRIAL = tag('PENDING S-39', {
  electricalConduction: { threshold: 10, salvageTest: 6, metalContact: 4, junctionClue: 4 },
  circuitAssembly: { threshold: 10, circuitTest: 6, preparedContacts: 10, grounding: 4, junctionClue: 4 },
  semiconductorBehavior: { threshold: 8, mineralTest: 6, electricalProbe: 2 },
  photovoltaicFabrication: { threshold: 10, rawContact: 4, controlledContact: 6, hardwareClue: 2 }
});

/** Remaining Stage 4 work rule under review: the iron structural part's unit volume. */
export const WORK_RULES = tag('PENDING S-32', {
  ironPartUnitVolumeCm3: 10_000
});

/** Installation slots per place (S-36): plain capacity, one slot per installed unit. */
export const SLOTS = tag('PENDING S-36', {
  habitat: { 'docking-ring': 0, 'workbench-compartment': 2, 'service-bay': 4, 'array-mounts': 4 }
});

/**
 * Industrial values (S-38): component and product volumes (cm³), recipe times (s), machine
 * processes (amounts in cm³, durations in s, power in U/s) and baseline draw per unit.
 * Nothing made by hand or at the workbench draws power.
 */
export const INDUSTRY = tag('PENDING S-38', {
  unitVolumes: {
    'conductive-part': 12_000, 'electronic-part': 4_000, 'motor-assembly': 50_000, 'power-controller': 40_000,
    'thermal-chamber': 160_000, 'solar-cell': 40_000,
    'salvage-recovery-unit': 1_200_000, 'blast-furnace': 2_500_000, 'solar-panel': 700_000, 'battery-bank': 600_000
  },
  bulkSamples: { 'refined-iron': 1_000, 'mineral-residue': 1_000 },
  partDuration: 4,
  assemblyDuration: 8,
  recipes: {
    ironFromRefined: { 'refined-iron': 2_800 },
    conductivePart: { 'scrap-metal': 12_000, 'electronic-salvage': 6_000 },
    electronicPart: { 'electronic-salvage': 6_000 },
    solarCell: { 'silicate-minerals': 20_000 }
  },
  salvageUnit: {
    baseline: 0.02,
    recoverScrap: { amount: 50_000, duration: 3, powerRate: 0.5 },
    recoverElectronics: { amount: 25_000, duration: 3, powerRate: 0.5 }
  },
  blastFurnace: {
    baseline: 0.02,
    smeltScrap: { input: 250_000, refinedIron: 30_000, residue: 50_000, duration: 20, powerRate: 1.2 },
    smeltOre: { input: 250_000, refinedIron: 35_000, residue: 130_000, duration: 20, powerRate: 1.2 }
  }
});

/** The battery cue (S-40): a slow outline pulse on the battery targets. */
export const BATTERY_CUE = tag('PENDING S-40', { pulses: 4, pulseSeconds: 2 });

/**
 * Room observation memory (S-47, S-48): bounds of the remembered rooms, the arrival-sentence
 * budget, and the deposit wording threshold (at or below this fraction of the initial amount a
 * deposit reads as 'low'; at 0 'depleted').
 */
export const OBSERVATION = tag('PENDING S-47', {
  placeLimit: 128, topicLimit: 64,
  baselineItems: 3, arrivalClauses: 2,
  depositLowFraction: 0.1
});

/** Stage 5 research values (S-49): the Rotational dynamics principle. */
export const RESEARCH_STAGE5 = tag('PENDING S-49', {
  rotationalDynamics: { threshold: 10, motorSpin: 6, balancedRotor: 4 }
});

/** The flywheel store (S-50): the storage alternative to the battery bank. Volume in cm³, storage in U. */
export const FLYWHEEL = tag('PENDING S-50', {
  storage: 120, unitVolumeCm3: 900_000,
  recipe: { ironParts: 6, motors: 2 }
});

/** Journal wording (S-53): family familiarity words by exposure (0..100). Reference: emerging < 15, developing < 40, familiar. */
export const JOURNAL = tag('PENDING S-53', {
  exposureWords: [{ below: 25, word: 'slight' }, { below: 60, word: 'growing' }, { below: Infinity, word: 'strong' }]
});

/** Power trend chart (S-54): session-only samples of committed states. */
export const TREND = tag('PENDING S-54', { sampleSeconds: 5, limit: 120, gapSeconds: 5 });

/**
 * The story path (S-55): what every world must be able to reach from its guaranteed starting
 * conditions (Habitat 05's authored materials and equipment), independent of world generation.
 */
export const STORY_PATH = tag('PENDING S-55', [
  { discovery: 'structural-fabrication' }, { item: 'iron-structural-part' },
  { discovery: 'electrical-conduction' }, { discovery: 'circuit-assembly' },
  { item: 'salvage-recovery-unit' }, { item: 'solar-panel' }
]);
