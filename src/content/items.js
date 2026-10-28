// Item catalog and hand-made recipes. Categories follow the reference hierarchy: Resources
// are bulk (integer cm³) and carry an authored research sample size; Components and
// Products are counted and carry a unit volume. Products that install declare the
// equipment model they become (`installs`). Tags are physical properties that research
// evidence rules match. Items may carry authored `notes` with a `learnWhen` policy (S-52).
// Values: S-15 approved; S-32, S-38, S-50 PENDING.
import { OPENING, SAMPLE_SIZES, WORK_RULES, INDUSTRY, FLYWHEEL } from './provisional.js';

function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }
const S = SAMPLE_SIZES.value, I = INDUSTRY.value, V = INDUSTRY.value.unitVolumes;

// Discovery sets that recipes and items are unlocked by (each lists every discovery its
// ingredients need, so the unlock lint stays clean).
const STRUCTURAL = { discovery: 'structural-fabrication' };
const CONDUCTION = { discovery: 'electrical-conduction' };
const CIRCUIT = { discovery: 'circuit-assembly' };
const PHOTOVOLTAIC = { discovery: 'photovoltaic-fabrication' };
// The flywheel store has two routes (S-49, S-51): the Rotational dynamics principle, or the
// design learned by studying a salvage recovery unit. The outer `all` keeps the C-03 lint clean.
const FLYWHEEL_ROUTES = { any: [{ discovery: 'rotational-dynamics' }, { discovery: 'flywheel-energy-store' }] };
const all = (...c) => ({ all: c });

export const ITEMS = deepFreeze({
  'scrap-metal':        { category: 'resource', label: 'Scrap metal', tags: ['metal'], researchSampleCm3: S['scrap-metal'] },
  'electronic-salvage': { category: 'resource', label: 'Electronic salvage', tags: ['electrical'], researchSampleCm3: S['electronic-salvage'] },
  'silicate-minerals':  { category: 'resource', label: 'Silicate minerals', tags: ['mineral', 'silicon'], researchSampleCm3: S['silicate-minerals'] },
  'iron-ore':           { category: 'resource', label: 'Iron ore', tags: ['mineral'], researchSampleCm3: S['iron-ore'] },
  'water-ice':          { category: 'resource', label: 'Water ice', tags: ['ice'], researchSampleCm3: S['water-ice'] },
  'refined-iron':       { category: 'resource', label: 'Refined iron', tags: ['metal'], researchSampleCm3: I.bulkSamples['refined-iron'], unlock: STRUCTURAL },
  'mineral-residue':    { category: 'resource', label: 'Mineral residue', tags: [], researchSampleCm3: I.bulkSamples['mineral-residue'], unlock: STRUCTURAL },
  'iron-structural-part': {
    category: 'component', label: 'Iron structural part', tags: ['metal', 'rigid'],
    unitVolumeCm3: WORK_RULES.value.ironPartUnitVolumeCm3, unlock: STRUCTURAL
  },
  'conductive-part':  { category: 'component', label: 'Conductive part', tags: ['conductive'], unitVolumeCm3: V['conductive-part'], unlock: CONDUCTION },
  'electronic-part':  { category: 'component', label: 'Electronic part', tags: ['electronic'], unitVolumeCm3: V['electronic-part'], unlock: CIRCUIT },
  'motor-assembly':   { category: 'component', label: 'Motor assembly', tags: [], unitVolumeCm3: V['motor-assembly'], unlock: all(STRUCTURAL, CONDUCTION),
    notes: { 'balanced-rotor': { title: 'Balanced rotor', text: 'The rotor is balanced with small drilled holes; spun by hand it turns smoothly and keeps turning.', learnWhen: { onEncounter: true } } } },
  'power-controller': { category: 'component', label: 'Power controller', tags: [], unitVolumeCm3: V['power-controller'], unlock: all(CONDUCTION, CIRCUIT) },
  'thermal-chamber':  { category: 'component', label: 'Thermal chamber', tags: [], unitVolumeCm3: V['thermal-chamber'], unlock: all(STRUCTURAL, CONDUCTION, CIRCUIT) },
  'solar-cell':       { category: 'component', label: 'Solar cell', tags: [], unitVolumeCm3: V['solar-cell'], unlock: all(PHOTOVOLTAIC, CIRCUIT) },
  'salvage-recovery-unit': {
    category: 'product', label: 'Salvage recovery unit', tags: ['industrial'], unitVolumeCm3: V['salvage-recovery-unit'],
    installs: 'salvage-recovery-unit', unlock: all(STRUCTURAL, CONDUCTION, CIRCUIT)
  },
  'blast-furnace': {
    category: 'product', label: 'Blast Furnace', tags: ['industrial'], unitVolumeCm3: V['blast-furnace'],
    installs: 'blast-furnace', unlock: all(STRUCTURAL, CONDUCTION, CIRCUIT)
  },
  'solar-panel': {
    category: 'product', label: 'Solar panel', tags: [], unitVolumeCm3: V['solar-panel'],
    installs: 'solar-array', unlock: all(STRUCTURAL, CONDUCTION, CIRCUIT, PHOTOVOLTAIC)
  },
  'battery-bank': {
    category: 'product', label: 'Battery bank', tags: [], unitVolumeCm3: V['battery-bank'],
    installs: 'battery-bank', unlock: all(STRUCTURAL, CONDUCTION, CIRCUIT)
  },
  // Stage 5 (S-50): the same storage capability as the battery bank, from scrap-heavy parts.
  'flywheel-store': {
    category: 'product', label: 'Flywheel store', tags: [], unitVolumeCm3: FLYWHEEL.value.unitVolumeCm3,
    installs: 'flywheel-store', unlock: all(STRUCTURAL, CONDUCTION, FLYWHEEL_ROUTES),
    notes: { 'stored-motion': { title: 'Stored motion', text: 'Energy goes in as speed and comes back out as current; a heavier, faster rotor holds more.',
      learnWhen: { conditions: FLYWHEEL_ROUTES } } }
  }
});

const part = (label, output, inputs, unlock) => ({ label, output, qty: 1, inputs, duration: I.partDuration, tool: 'fabrication', unlock });
const assembly = (label, output, inputs, unlock) => ({ label, output, qty: 1, inputs, duration: I.assemblyDuration, tool: null, unlock });
const bulk = m => Object.entries(m).map(([item, qty]) => ({ item, qty }));

/**
 * Hand-made recipes, keyed by recipe id. The operation follows the output category:
 * component → fabricate, product → assemble. A resource output is never a recipe: refining
 * is machine-only. `tool` is the capability the place must provide (the workbench's
 * `fabrication`), or null for work done by hand. Nothing made this way draws power (S-32).
 * Inputs are `{item, qty}` or `{anyOf: [items], qty}` (approved alternatives).
 */
export const RECIPES = deepFreeze({
  'iron-structural-part': {
    label: 'Fabricate iron structural part',
    output: 'iron-structural-part', qty: 1,
    inputs: [{ item: 'scrap-metal', qty: OPENING.value.ironPart.scrapCm3 }],
    duration: OPENING.value.ironPart.duration,
    tool: 'fabrication',
    unlock: STRUCTURAL
  },
  'iron-structural-part-refined': part('Form iron structural part from refined iron', 'iron-structural-part', bulk(I.recipes.ironFromRefined), STRUCTURAL),
  'conductive-part':  part('Fabricate conductive part', 'conductive-part', bulk(I.recipes.conductivePart), CONDUCTION),
  'electronic-part':  part('Fabricate electronic part', 'electronic-part', bulk(I.recipes.electronicPart), CIRCUIT),
  'motor-assembly':   part('Build motor assembly', 'motor-assembly',
    [{ item: 'iron-structural-part', qty: 2 }, { item: 'conductive-part', qty: 1 }], all(STRUCTURAL, CONDUCTION)),
  'power-controller': part('Build power controller', 'power-controller',
    [{ item: 'conductive-part', qty: 2 }, { item: 'electronic-part', qty: 1 }], all(CONDUCTION, CIRCUIT)),
  'thermal-chamber':  part('Build thermal chamber', 'thermal-chamber',
    [{ item: 'iron-structural-part', qty: 3 }, { item: 'conductive-part', qty: 2 }, { item: 'electronic-part', qty: 1 }], all(STRUCTURAL, CONDUCTION, CIRCUIT)),
  'solar-cell':       part('Fabricate solar cell', 'solar-cell',
    [...bulk(I.recipes.solarCell), { item: 'electronic-part', qty: 1 }], all(PHOTOVOLTAIC, CIRCUIT)),
  'salvage-recovery-unit': assembly('Assemble salvage recovery unit', 'salvage-recovery-unit',
    [{ item: 'iron-structural-part', qty: 8 }, { item: 'conductive-part', qty: 2 }, { item: 'electronic-part', qty: 1 }, { item: 'motor-assembly', qty: 2 }],
    all(STRUCTURAL, CONDUCTION, CIRCUIT)),
  'blast-furnace': assembly('Assemble Blast Furnace', 'blast-furnace',
    [{ item: 'iron-structural-part', qty: 12 }, { item: 'thermal-chamber', qty: 2 }, { item: 'conductive-part', qty: 4 },
      { item: 'power-controller', qty: 2 }, { item: 'electronic-part', qty: 2 }],
    all(STRUCTURAL, CONDUCTION, CIRCUIT)),
  'solar-panel': assembly('Assemble solar panel', 'solar-panel',
    [{ item: 'iron-structural-part', qty: 4 }, { item: 'conductive-part', qty: 2 }, { item: 'solar-cell', qty: 6 }, { item: 'power-controller', qty: 1 }],
    all(STRUCTURAL, CONDUCTION, CIRCUIT, PHOTOVOLTAIC)),
  'battery-bank': assembly('Assemble battery bank', 'battery-bank',
    [{ item: 'iron-structural-part', qty: 4 }, { item: 'conductive-part', qty: 4 }, { item: 'power-controller', qty: 1 }],
    all(STRUCTURAL, CONDUCTION, CIRCUIT)),
  'flywheel-store': assembly('Assemble flywheel store', 'flywheel-store',
    [{ item: 'iron-structural-part', qty: FLYWHEEL.value.recipe.ironParts }, { item: 'motor-assembly', qty: FLYWHEEL.value.recipe.motors }],
    all(STRUCTURAL, CONDUCTION, FLYWHEEL_ROUTES))
});
