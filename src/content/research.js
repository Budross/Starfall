// Research content (one method; the opening principle, the industrial-stage principles, and the
// Stage 5 Rotational dynamics principle with the flywheel design reached by an engineering study).
// The schema follows the reference research catalog: methods are authored data; discoveries
// carry eligibility, a hidden threshold and evidence rules with optional `methods` (rule-level
// only) and prioritized variants. Players never see thresholds or insight. Every principle is
// grounded in materials and objects the player can physically encounter; nothing is random.
// S-15 approved; S-33, S-39, S-49, S-51 PENDING.
import { RESEARCH_POLICY, RESEARCH_INDUSTRIAL, RESEARCH_STAGE5 } from './provisional.js';

function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }
const P = RESEARCH_POLICY.value;
const Q = RESEARCH_INDUSTRIAL.value;
const R5 = RESEARCH_STAGE5.value;

export const RESEARCH = deepFreeze({
  repetition: P.repetition,
  families: {
    materials: { name: 'Materials' },
    mechanics: { name: 'Mechanics' },
    energy: { name: 'Energy' },
    computation: { name: 'Computation' },
    navigation: { name: 'Navigation' }
  },
  affinities: [
    { tags: ['metal'], weights: { materials: 3, mechanics: 2 } },
    { tags: ['electrical'], weights: { energy: 3, computation: 1 } },
    { tags: ['silicon'], weights: { materials: 3, computation: 2 } }
  ],
  methods: {
    'bench-inspection': {
      name: 'Bench inspection', minSamples: 1, maxSamples: 3, cost: {},
      conditions: { capability: 'bench-analysis' },
      blockedReason: 'Requires an operational bench in this compartment.'
    }
  },
  discoveries: {
    'structural-fabrication': {
      name: 'Structural fabrication',
      description: 'Form salvaged metal into load-bearing parts for repairs and assemblies.',
      families: ['materials', 'mechanics'],
      threshold: P.structuralFabrication.threshold,
      evidence: [
        { id: 'metal-test', samples: { allTags: ['metal'] }, insight: P.structuralFabrication.metalTest,
          observation: 'The metal holds its shape after forming. Repeated loading reveals where a support needs reinforcement.' },
        { id: 'fitting-clue', samples: { allTags: ['metal'] }, conditions: { fragment: 'seal-assembly-joints' },
          insight: P.structuralFabrication.fittingClue, once: true,
          observation: 'The worn seal assembly provides a useful reference for a replacement support.' }
      ]
    },
    'electrical-conduction': {
      name: 'Electrical conduction',
      description: 'Prepare dependable conductors from salvaged electrical material and metal.',
      families: ['energy', 'materials'],
      threshold: Q.electricalConduction.threshold,
      evidence: [
        { id: 'salvage-test', samples: { allTags: ['electrical'] }, insight: Q.electricalConduction.salvageTest,
          observation: 'Some paths through the salvage carry current more consistently than others.' },
        { id: 'metal-contact', samples: { allTags: ['metal', 'electrical'] }, insight: Q.electricalConduction.metalContact,
          observation: 'A clean metal contact reduces the resistance in the recovered wiring.' },
        { id: 'junction-clue', samples: { allTags: ['electrical'] }, conditions: { fragment: 'junction-box-contacts' },
          insight: Q.electricalConduction.junctionClue, once: true,
          observation: 'The junction box shows the difference between a poor contact and a damaged conductor.' }
      ]
    },
    'circuit-assembly': {
      name: 'Circuit assembly',
      description: 'Fabricate reusable electronic circuitry for power and communications equipment.',
      families: ['computation', 'energy'],
      eligibility: { discovery: 'electrical-conduction' },
      threshold: Q.circuitAssembly.threshold,
      evidence: [
        { id: 'circuit-test', samples: { allTags: ['electrical'] }, insight: Q.circuitAssembly.circuitTest,
          observation: 'You trace a repeatable switching pattern through the salvaged circuit.',
          variants: [
            { id: 'basic', priority: 0 },
            { id: 'prepared-contacts', priority: 10, samples: { allTags: ['electrical', 'conductive'] }, insight: Q.circuitAssembly.preparedContacts,
              observation: 'Prepared conductors isolate the connections needed to reproduce a working circuit.' }
          ] },
        { id: 'grounding', samples: { allTags: ['metal', 'electrical'] }, insight: Q.circuitAssembly.grounding,
          observation: "A stable metal reference separates the circuit's signal from electrical noise." },
        { id: 'junction-clue', samples: { allTags: ['electrical'] }, conditions: { fragment: 'junction-box-contacts' },
          insight: Q.circuitAssembly.junctionClue, once: true,
          observation: "The junction box's surviving contacts make the circuit's layout easier to follow." }
      ]
    },
    'semiconductor-behavior': {
      name: 'Semiconductor behaviour',
      description: 'Recognize and investigate the electrical behaviour of silicon-bearing material.',
      families: ['materials', 'computation'],
      threshold: Q.semiconductorBehavior.threshold,
      evidence: [
        { id: 'mineral-test', samples: { allTags: ['silicon'] }, insight: Q.semiconductorBehavior.mineralTest,
          observation: "The mineral's response varies with the contact and illumination; it is neither a simple conductor nor an insulator." },
        { id: 'electrical-probe', samples: { allTags: ['silicon', 'electrical'] }, insight: Q.semiconductorBehavior.electricalProbe,
          observation: "Recovered electrical contacts make the mineral's directional response clearer." }
      ]
    },
    'photovoltaic-fabrication': {
      name: 'Photovoltaic fabrication',
      description: 'Process silicon into photovoltaic cells and assemble additional solar panels.',
      families: ['energy', 'materials'],
      eligibility: { any: [{ fragment: 'solar-hardware' }, { discovery: 'semiconductor-behavior' }] },
      threshold: Q.photovoltaicFabrication.threshold,
      evidence: [
        { id: 'raw-contact', samples: { allTags: ['silicon', 'electrical'] }, insight: Q.photovoltaicFabrication.rawContact,
          observation: 'An illuminated mineral sample produces a small but repeatable electrical response.' },
        { id: 'controlled-contact', samples: { allTags: ['silicon', 'electronic'] }, insight: Q.photovoltaicFabrication.controlledContact,
          observation: "Prepared circuitry measures the sample's response well enough to guide cell fabrication." },
        { id: 'hardware-clue', samples: { allTags: ['silicon'] }, conditions: { fragment: 'solar-hardware' },
          insight: Q.photovoltaicFabrication.hardwareClue, once: true,
          observation: "The damaged cell's layered structure explains how to collect the sample's output." }
      ]
    },
    // Stage 5 (S-49): grounded in a motor the player built, before circuit assembly.
    'rotational-dynamics': {
      name: 'Rotational dynamics',
      description: 'Store and recover energy in a spinning mass, and keep it balanced at speed.',
      families: ['mechanics', 'energy'],
      classification: 'principle',
      eligibility: { all: [{ discovery: 'structural-fabrication' }, { discovery: 'electrical-conduction' }] },
      threshold: R5.rotationalDynamics.threshold,
      evidence: [
        { id: 'motor-spin', samples: { items: ['motor-assembly'] }, insight: R5.rotationalDynamics.motorSpin,
          observation: 'Spun up and left to coast, the motor keeps turning long after the current is cut.' },
        { id: 'balanced-rotor', samples: { items: ['motor-assembly'], allTags: ['metal'] }, insight: R5.rotationalDynamics.balancedRotor,
          observation: 'A metal ring fixed to the shaft stores far more motion, as long as its weight is evenly spread.' }
      ]
    },
    // Stage 5 (S-51): a design learned only by studying a working salvage recovery unit.
    'flywheel-energy-store': {
      name: 'Flywheel energy store',
      description: 'A heavy rotor on a motor-generator stores energy as motion, as the recovery unit\'s drive does between batches.',
      families: ['mechanics', 'energy'],
      classification: 'design',
      studyOnly: true,
      threshold: 1,
      evidence: []
    }
  },
  // Engineering studies (S-51; reference study.js). Studying needs a qualifying operation the
  // character ordered on the machine, presence in its room and the listed principles.
  studies: {
    'recovery-unit-drive': {
      name: 'Recovery unit drive',
      revision: 1,
      model: 'salvage-recovery-unit',
      processes: ['recover-scrap', 'recover-electronics'],
      discovery: 'flywheel-energy-store',
      principles: ['structural-fabrication', 'electrical-conduction']
    }
  }
});
