// Scene definitions — presentation content only (Habitat05_04 §5.1).
// No gameplay logic, no callbacks. Which committed gameplay event opens which
// scene (S-19h) is wired at the first witnessed docking (Stage 6). A remote NPC docking
// the character cannot see opens no scene.
//
// transitions.first  — first visit to a docking location: the whole cinematic (S-19a/S-19d, approved).
// transitions.repeat — later visits: quick ≈1 s animate-in, then the settled interactive state.
export const SCENES = Object.freeze({
  'station-airlock': Object.freeze({
    renderer: 'tactical-feed',
    transitions: Object.freeze({ first: 'full', repeat: 'brief' }),
    perspectives: Object.freeze(['physical', 'remote-feed', 'recording']),
    skin: Object.freeze({ bayLabel: 'DOCKING RING' })
  }),
  // The compartment the character currently occupies (walkthrough step 2). Not an event
  // depiction, so there is no entry cinematic: it always animates in briefly.
  'place-interior': Object.freeze({
    renderer: 'tactical-feed',
    transitions: Object.freeze({ first: 'brief', repeat: 'brief' }),
    perspectives: Object.freeze(['physical']),
    skin: Object.freeze({ bayLabel: 'INTERIOR' })
  })
});
