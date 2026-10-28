// Authored world content (Habitat05_01 §3): a deliberately small set of anchors.
// Names, descriptions, subjects and evidence text are PLACEHOLDERS pending S-17
// (working fiction). Coordinates are provisional (S-24). Procedural bodies come
// from the WORLDGEN profile, not from here.
import { SCALE, BERTHS, PLACEMENT, OPENING_DEPOSITS, TRAFFIC, OPENING, SLOTS } from './provisional.js';

const sph = ({ az, el, r }) => {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  return { x: Math.sin(a) * Math.cos(e) * r, y: Math.sin(e) * r, z: Math.cos(a) * Math.cos(e) * r };
};
const P = PLACEMENT.value;
const habitatPos = sph(P.habitat);
const az = P.habitat.az * Math.PI / 180;
const right = { x: Math.cos(az), z: -Math.sin(az) }, forward = { x: Math.sin(az), z: Math.cos(az) };
const off = P.secondStationOffset;
const secondPos = {
  x: habitatPos.x + right.x * off.right + forward.x * off.forward,
  y: habitatPos.y + off.up,
  z: habitatPos.z + right.z * off.right + forward.z * off.forward
};
const O = OPENING.value;
const SL = SLOTS.value.habitat;
// Habitat 05's local deposits: frozen geography holds identity and amounts; the place where
// each is physically worked and the per-collection amount are content (S-31, S-15).
const DEPOSIT_LABEL = { 'scrap-metal': 'stripped machinery racks', 'electronic-salvage': 'loose wiring and boards', 'silicate-minerals': 'exposed mineral seam' };
const habitatDeposits = Object.fromEntries(Object.entries(OPENING_DEPOSITS.value.habitat).map(([itemId, initial]) =>
  [itemId, { itemId, initial, placeKey: 'service-bay', label: DEPOSIT_LABEL[itemId], collect: { ...O.collection[itemId] } }]));
const berths = n => Array.from({ length: n }, (_, i) => `berth-${String.fromCharCode(97 + i)}`);
// The tender starts beyond the second station, on the far side from Habitat 05 (S-27).
const T = TRAFFIC.value;
const away = (() => {
  const d = { x: secondPos.x - habitatPos.x, y: secondPos.y - habitatPos.y, z: secondPos.z - habitatPos.z };
  const n = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / n, y: d.y / n, z: d.z / n };
})();
const tenderStart = {
  x: secondPos.x + away.x * T.tenderStartBeyondStation,
  y: secondPos.y + away.y * T.tenderStartBeyondStation,
  z: secondPos.z + away.z * T.tenderStartBeyondStation
};

function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }

export const WORLD = deepFreeze({
  principals: {
    'station-operator': { label: 'Station operator' }                    // placeholder (S-17)
  },
  areas: {
    'habitat-reach': { centerSite: 'habitat-05', radius: SCALE.value.areaRadius }
  },
  sites: {
    'habitat-05': {
      kind: 'station', areaId: 'habitat-reach', position: habitatPos,
      label: 'Habitat 05',
      description: 'A deteriorating habitat at the edge of an unfinished industrial corridor.',
      owner: 'player', controller: 'player', access: { public: [], grants: {} },
      entryPlace: 'docking-ring',
      berths: berths(BERTHS.value.habitat),
      deposits: habitatDeposits,
      hold: { capacityCm3: O.holdCapacityCm3 },
      // Facility power (Stage 4): life support is a mandatory load, not a bank (PF-13).
      power: { initialReserve: O.initialReserve, mandatoryLoad: O.lifeSupportLoad, mandatoryLabel: 'Life support' },
      // Starting installed banks (S-31). Bank ids are allocated at creation; places are frozen geography keys.
      // Each place carries plain installation slots and an exterior flag (placement eligibility, S-36).
      equipment: [
        { model: 'solar-array', placeId: 'array-mounts', quantity: 1, health: O.solarStartingHealth },
        { model: 'battery-bank', placeId: 'service-bay', quantity: 1, health: 1 },
        { model: 'workbench', placeId: 'workbench-compartment', quantity: 1, health: 1 }
      ],
      places: {
        'docking-ring': {
          label: 'Docking ring',
          description: 'A curved corridor of scuffed panels around the habitat\'s two berths.',
          scene: 'docking-ring',                                                // backdrop template (presentation only)
          exterior: false, slots: SL['docking-ring'],
          connections: ['workbench-compartment', 'service-bay'],
          subjects: {
            // The fitting clue (S-15): examining it records a narrative fragment that research
            // evidence can read. It is never a discovery by itself.
            'seal-assembly':   { kind: 'evidence', label: 'worn seal assembly', condition: 'worn',
              reading: 'The seal ring is held by a formed metal bracket. Its bends and rivet spacing show how the original support carried the load.',
              effects: [{ grantFragment: 'seal-assembly-joints' }] },
            'maintenance-log': { kind: 'evidence', label: 'maintenance log panel', condition: 'flickering',
              reading: 'The last entries describe a hatch behind the berth-B panels, sealed "until the relay crews return".',
              effects: [{ grantFragment: 'docking-ring-maintenance-log' }] },
            'service-hatch':   { kind: 'feature', label: 'sealed service hatch', condition: 'sealed',
              perceivedWhen: { fragment: 'docking-ring-maintenance-log' } }
          }
        },
        'workbench-compartment': {
          label: 'Workbench compartment',
          description: 'A cramped compartment with a scarred bench and empty tool clips.',
          scene: 'workbench',
          exterior: false, slots: SL['workbench-compartment'],
          connections: ['docking-ring'], subjects: {}
        },
        'service-bay': {
          label: 'Service bay',
          description: 'Cold machinery bays behind a pressure door.',
          scene: 'service-bay',
          exterior: false, slots: SL['service-bay'],
          connections: ['docking-ring', 'array-mounts'],
          subjects: {
            // The conduction and circuit clue (S-39): replaces the reference's NPC advice.
            'junction-box': { kind: 'evidence', label: 'burnt-out junction box', condition: 'scorched',
              reading: 'Scorch marks run along one bus bar. The contacts that survived are bright where they were clamped clean, and pitted where they were not.',
              effects: [{ grantFragment: 'junction-box-contacts' }] }
          }
        },
        'array-mounts': {
          label: 'Array mounts',
          description: 'An exposed gantry outside the hull, with mounting rails for solar panels.',
          scene: 'array-mounts',
          exterior: true, slots: SL['array-mounts'],
          connections: ['service-bay'],
          subjects: {
            // The photovoltaic hardware clue (S-39).
            'array-cells': { kind: 'evidence', label: 'cracked array cells', condition: 'cracked',
              reading: 'Under the cracked cover glass, each cell is a thin layered wafer with fine metal collector lines printed across its face.',
              effects: [{ grantFragment: 'solar-hardware' }] }
          }
        }
      }
    },
    'second-station': {
      kind: 'station', areaId: 'habitat-reach', position: secondPos,
      label: 'Service station',                                               // placeholder (S-17)
      description: 'An aging service platform charted in the habitat\'s records.',
      owner: 'station-operator', controller: 'station-operator', access: { public: ['dock'], grants: {} },
      entryPlace: 'docking-ring',
      berths: berths(BERTHS.value.secondStation),
      deposits: {},
      places: {
        'docking-ring': { label: 'Docking ring', description: 'A service ring with an automated transponder.', scene: 'docking-ring', connections: ['archive'], subjects: {} },
        'archive':      { label: 'Archive', description: 'A records room.', scene: 'ops-node', connections: ['docking-ring'], subjects: {} }
      }
    }
  },
  megastructures: {
    'structure-arc': {
      // SECRET until identified: the label and description below must never reach a projection (K-01).
      label: 'The Long Collector',                                              // placeholder (S-17)
      description: 'A stellar collector arc built to feed the swarm\'s industrial corridor.',
      conspicuous: true,
      position: sph(P.megastructure.marker),
      footprint: P.megastructure.footprint,
      accessPoints: []
    }
  },
  // Mobile vessels (Stage 3). Identity is SECRET until identified: label and description
  // never reach a projection from a visual sighting alone.
  vessels: {
    'operator-tender': {
      label: 'Service tender',                                                   // placeholder (S-17)
      description: 'A small station tender on a supply run.',                      // placeholder (S-17)
      owner: 'station-operator', controller: 'station-operator',
      propulsion: T.tenderPropulsion,
      initialEnergy: T.tenderInitialEnergy,
      approachStandoff: T.approachStandoff,
      start: tenderStart,
      initialJourney: { to: 'second-station', dockOnArrival: true }
    }
  },
  // What the character knows at the start, and why (S-22). Everything else is learned.
  priorRecords: [
    { subject: 'habitat-05', facet: 'identified' },
    { place: ['habitat-05', 'docking-ring'] },
    { place: ['habitat-05', 'workbench-compartment'] },
    { place: ['habitat-05', 'service-bay'] },
    { place: ['habitat-05', 'array-mounts'] },
    { subject: 'second-station', facet: 'identified' }
  ],
  start: { hostId: 'habitat-05', placeId: 'docking-ring' },
  opening: { minimumDeposits: OPENING_DEPOSITS.value.minimums }
});

/** Narrative fragments: what was read, heard or seen (never research discoveries). */
export const FRAGMENTS = deepFreeze({
  'seal-assembly-joints': {
    title: 'Seal assembly — formed bracket',
    text: 'The seal ring is held by a formed metal bracket. Its bends and rivet spacing show how the original support carried the load.'
  },
  'docking-ring-maintenance-log': {
    title: 'Maintenance log — docking ring',
    text: 'The last entries describe a hatch behind the berth-B panels, sealed "until the relay crews return".'
  },
  'junction-box-contacts': {
    title: 'Junction box — clean contacts',
    text: 'Scorch marks run along one bus bar. The contacts that survived are bright where they were clamped clean, and pitted where they were not.'
  },
  'solar-hardware': {
    title: 'Array cells — layered wafers',
    text: 'Under the cracked cover glass, each cell is a thin layered wafer with fine metal collector lines printed across its face.'
  }
});
