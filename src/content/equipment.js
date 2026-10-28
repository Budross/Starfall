// Installed equipment models: each is a capability profile. A model describes what one
// operational unit provides; a host's capabilities are always derived from its installed
// banks, never stored (the first-level composition contract). Capability never implies
// authorization. Values: S-15 approved; S-32, S-36, S-38 PENDING.
//
//   provides     numeric capabilities, combined across banks by their PROVISIONS rule
//   capabilities boolean capabilities (set union)
//   item         the product the model installs from (absent: not installable)
//   placement    {exterior, deposit?} — which places may hold it, separately from slot capacity
//   baseline     U/s drawn per online unit (whole units, S-44)
//   toggleable   may be enabled or disabled by the player
//   processes    machine processes: extract (from a deposit at its place) or refine (cargo → cargo)
//   repair       instant repair cost (S-32), at the bank's place
import { OPENING, INDUSTRY, FLYWHEEL } from './provisional.js';

function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }
const I = INDUSTRY.value;
const STRUCTURAL = { discovery: 'structural-fabrication' };

/**
 * Aggregation rules for numeric capabilities (authored; the engine knows only `sum`). A
 * contribution is per-unit value × quantity, × health when `scaleByHealth`.
 */
export const PROVISIONS = deepFreeze({
  generation: { unit: 'U/s', combine: 'sum', scaleByHealth: true },
  storage:    { unit: 'U',   combine: 'sum', scaleByHealth: false }
});

export const EQUIPMENT = deepFreeze({
  'solar-array': {
    label: 'Solar array',
    item: 'solar-panel',
    provides: { generation: OPENING.value.solarGeneration },   // U/s per unit at full health
    placement: { exterior: true },
    repair: {
      inputs: { 'iron-structural-part': OPENING.value.arrayRepairParts },
      unlock: STRUCTURAL
    }
  },
  'battery-bank': {
    label: 'Battery bank',
    item: 'battery-bank',
    provides: { storage: OPENING.value.batteryStorage },
    placement: { exterior: false }
  },
  // Stage 5 (S-50): the same canonical storage capability as the battery bank, summed by
  // PROVISIONS.storage — no model-specific code anywhere.
  'flywheel-store': {
    label: 'Flywheel store',
    item: 'flywheel-store',
    provides: { storage: FLYWHEEL.value.storage },
    placement: { exterior: false }
  },
  'workbench': { label: 'Workbench', capabilities: ['fabrication', 'bench-analysis'], placement: { exterior: false } },
  'salvage-recovery-unit': {
    label: 'Salvage recovery unit',
    item: 'salvage-recovery-unit',
    placement: { exterior: false, deposit: true },
    baseline: I.salvageUnit.baseline,
    toggleable: true,
    processes: {
      'recover-scrap': {
        label: 'Recover scrap metal', kind: 'extract', deposit: 'scrap-metal',
        amount: I.salvageUnit.recoverScrap.amount, duration: I.salvageUnit.recoverScrap.duration, powerRate: I.salvageUnit.recoverScrap.powerRate,
        unlock: { all: [STRUCTURAL, { discovery: 'electrical-conduction' }] }
      },
      'recover-electronics': {
        label: 'Recover electronic salvage', kind: 'extract', deposit: 'electronic-salvage',
        amount: I.salvageUnit.recoverElectronics.amount, duration: I.salvageUnit.recoverElectronics.duration, powerRate: I.salvageUnit.recoverElectronics.powerRate,
        unlock: { all: [STRUCTURAL, { discovery: 'electrical-conduction' }] }
      }
    }
  },
  'blast-furnace': {
    label: 'Blast Furnace',
    item: 'blast-furnace',
    placement: { exterior: false },
    baseline: I.blastFurnace.baseline,
    toggleable: true,
    processes: {
      'smelt-scrap': {
        label: 'Smelt scrap into refined iron', kind: 'refine',
        inputs: { 'scrap-metal': I.blastFurnace.smeltScrap.input },
        outputs: { 'refined-iron': I.blastFurnace.smeltScrap.refinedIron, 'mineral-residue': I.blastFurnace.smeltScrap.residue },
        duration: I.blastFurnace.smeltScrap.duration, powerRate: I.blastFurnace.smeltScrap.powerRate,
        unlock: STRUCTURAL
      },
      'smelt-ore': {
        label: 'Smelt iron ore into refined iron', kind: 'refine',
        inputs: { 'iron-ore': I.blastFurnace.smeltOre.input },
        outputs: { 'refined-iron': I.blastFurnace.smeltOre.refinedIron, 'mineral-residue': I.blastFurnace.smeltOre.residue },
        duration: I.blastFurnace.smeltOre.duration, powerRate: I.blastFurnace.smeltOre.powerRate,
        unlock: STRUCTURAL
      }
    }
  }
});
