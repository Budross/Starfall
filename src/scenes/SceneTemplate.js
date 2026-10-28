// SceneTemplate.js — backdrop scenes for TacticalFeedOverlay (presentation only).
//
// Composition zones, in the overlay's 1000×1000 viewBox:
//   full canvas 0..1000      visible only while zoomed out; outside the aperture it is a dark fill.
//   aperture cx/cy 500 r 258 the settled view frames 240..760 on both axes.
//   focal zone x 280..720, y 280..550  stays clear of the deck, which covers y ≈ 560..758 once INTERACTIVE.
const SVGNS = 'http://www.w3.org/2000/svg';

/** Shared tactical color palette matching TacticalFeedOverlay */
export const PALETTE = Object.freeze({
  bgDeep: '#040a12',
  bgPanel: '#09131d',
  bgFloor: '#0d1626',
  lineDim: '#1d3045',
  lineMid: '#2b4a5c',
  lineBright: '#3c6a7a',
  steel: '#5f7286',
  steelLight: '#b9c6d3',
  cyan: '#70d7dd',
  cyanDim: '#4fc4cc',
  green: '#42d7a3',
  gold: '#f3bd65',
  red: '#e2685f'
});

const REGISTRY = new Map();

/**
 * Register a room scene template.
 * @param {string} type - Identifier used in `sceneView.skin.scene`
 * @param {(ctx: object) => void | string} renderer - Builder function or raw SVG markup string
 */
export function registerSceneTemplate(type, renderer) {
  REGISTRY.set(type, renderer);
}

export function getSceneTemplate(type) {
  return REGISTRY.get(type) || REGISTRY.get('docking-ring');
}

export function listSceneTemplates() {
  return [...REGISTRY.keys()];
}

/** Helper context passed to every procedural scene builder */
function createDrawContext(rootGroup, uid, rnd) {
  const el = (tag, attrs = {}, parent = rootGroup) => {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) node.setAttribute(k, v);
    }
    parent.appendChild(node);
    return node;
  };

  return {
    uid,
    rnd,
    P: PALETTE,
    el,
    group: (attrs = {}, parent = rootGroup) => el('g', attrs, parent),
    rect: (x, y, width, height, attrs = {}, parent) =>
      el('rect', { x, y, width, height, ...attrs }, parent),
    circle: (cx, cy, r, attrs = {}, parent) =>
      el('circle', { cx, cy, r, ...attrs }, parent),
    line: (x1, y1, x2, y2, attrs = {}, parent) =>
      el('line', { x1, y1, x2, y2, ...attrs }, parent),
    path: (d, attrs = {}, parent) =>
      el('path', { d, ...attrs }, parent),
    poly: (points, attrs = {}, parent) =>
      el('polygon', { points: Array.isArray(points) ? points.join(' ') : points, ...attrs }, parent),
    range: (min, max) => min + rnd() * (max - min),
    int: (min, max) => Math.floor(min + rnd() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(rnd() * arr.length)]
  };
}

/**
 * Renders a scene into `<g data-r="backdrop">`, clipped cleanly to the iris aperture.
 */
export function renderSceneBackdrop({ host, type = 'docking-ring', uid, rnd }) {
  host.replaceChildren();

  // Outer dark fill for zoomed-out corners + clipped inner group for the room scene
  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', '1000');
  bg.setAttribute('height', '1000');
  bg.setAttribute('fill', PALETTE.bgDeep);
  host.appendChild(bg);

  const clipped = document.createElementNS(SVGNS, 'g');
  clipped.setAttribute('clip-path', `url(#${uid}-aperture)`);
  host.appendChild(clipped);

  const template = getSceneTemplate(type);
  if (typeof template === 'string') {
    clipped.innerHTML = template;
    return;
  }

  const ctx = createDrawContext(clipped, uid, rnd);
  const result = template(ctx);
  if (typeof result === 'string') {
    clipped.insertAdjacentHTML('beforeend', result);
  }
}

/* ==========================================================================
 * 1. DOCKING RING (External approach & collar bulkhead)
 * ========================================================================== */
registerSceneTemplate('docking-ring', (c) => {
  const { P, uid, rnd } = c;
  c.rect(240, 240, 520, 520, { fill: `url(#${uid}-sky)` });

  // Seeded starfield
  for (let i = 0; i < 90; i++) {
    c.rect(
      c.range(245, 755).toFixed(1),
      c.range(245, 550).toFixed(1),
      1.8, 1.8,
      { fill: '#d8e6f2', opacity: c.range(0.3, 0.9).toFixed(2) }
    );
  }

  // Approach deck & alignment chevrons
  c.path('M 220 760 L 780 760 L 680 555 L 320 555 Z', {
    fill: P.bgFloor, stroke: P.lineDim, 'stroke-width': 2
  });
  for (let y = 585; y < 755; y += 42) {
    const p = (y - 565) / 200;
    c.path(`M ${500 - 110 * p} ${y} L 500 ${y - 12 * p} L ${500 + 110 * p} ${y}`, {
      fill: 'none', stroke: P.cyanDim, 'stroke-width': 2.5, opacity: (0.35 + 0.5 * p).toFixed(2)
    });
  }

  // Bulkhead structure & collar frame
  c.rect(330, 375, 340, 180, { fill: '#060e17', stroke: P.lineMid, 'stroke-width': 3 });
  c.line(330, 420, 670, 420, { stroke: P.lineDim, 'stroke-width': 1.5 });
  c.line(390, 375, 390, 555, { stroke: P.lineDim, 'stroke-width': 1.5 });
  c.line(610, 375, 610, 555, { stroke: P.lineDim, 'stroke-width': 1.5 });

  // Inner airlock door & locking mechanism
  c.rect(455, 435, 90, 120, { fill: P.bgPanel, stroke: P.lineBright, 'stroke-width': 2.5 });
  c.circle(500, 485, 18, { fill: '#050b13', stroke: P.cyanDim, 'stroke-width': 2 });
  c.line(482, 485, 518, 485, { stroke: P.cyanDim, 'stroke-width': 2 });

  // Seeded docking guide lights
  const lights = c.int(3, 5);
  for (let i = 0; i < lights; i++) {
    const x = 350 + (i + 0.5) * (300 / lights);
    c.rect(x - 9, 545, 18, 5, { fill: P.gold, opacity: 0.85 });
  }
  c.circle(500, 400, 4, { fill: rnd() > 0.2 ? P.green : P.gold });
});

/* ==========================================================================
 * 2. SERVICE BAY (Overhead gantry crane, fluid manifolds, maintenance pit)
 * ========================================================================== */
registerSceneTemplate('service-bay', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#060d16' });

  // Recessed bay wall panels
  c.rect(280, 310, 440, 245, { fill: P.bgPanel, stroke: P.lineDim, 'stroke-width': 2 });
  c.line(360, 310, 360, 555, { stroke: P.lineDim, 'stroke-width': 2 });
  c.line(640, 310, 640, 555, { stroke: P.lineDim, 'stroke-width': 2 });

  // Left & right vertical fluid/power conduits
  for (const x of [305, 325, 675, 695]) {
    c.line(x, 290, x, 555, { stroke: P.lineMid, 'stroke-width': 6 });
    c.rect(x - 6, 410, 12, 18, { fill: P.bgFloor, stroke: P.lineBright, 'stroke-width': 1.5 });
  }

  // Overhead gantry rail & diagonal trusses
  c.rect(250, 295, 500, 22, { fill: P.bgFloor, stroke: P.lineBright, 'stroke-width': 2 });
  for (let x = 270; x < 730; x += 40) {
    c.line(x, 295, x + 20, 317, { stroke: P.lineMid, 'stroke-width': 1.5 });
  }

  // Seeded gantry trolley & hoist claw
  const craneX = Math.round(c.range(445, 555));
  c.rect(craneX - 28, 312, 56, 20, { fill: '#132636', stroke: P.cyanDim, 'stroke-width': 2 });
  c.line(craneX - 12, 332, craneX - 12, 395, { stroke: P.steelLight, 'stroke-width': 2, 'stroke-dasharray': '4 2' });
  c.line(craneX + 12, 332, craneX + 12, 395, { stroke: P.steelLight, 'stroke-width': 2, 'stroke-dasharray': '4 2' });
  c.path(`M ${craneX - 24} 415 L ${craneX - 14} 395 L ${craneX + 14} 395 L ${craneX + 24} 415`, {
    fill: 'none', stroke: P.gold, 'stroke-width': 3
  });

  // Service cradle & modular sub-assembly on deck
  c.path('M 415 555 L 435 515 L 565 515 L 585 555 Z', {
    fill: '#0b1824', stroke: P.lineBright, 'stroke-width': 2
  });
  // Pod / unit being serviced
  c.rect(440, 445, 120, 70, { rx: 8, fill: '#0e202e', stroke: P.cyanDim, 'stroke-width': 2 });
  c.rect(460, 462, 50, 28, { fill: '#050b12', stroke: P.lineMid, 'stroke-width': 1.5 });
  c.circle(535, 476, 8, { fill: 'none', stroke: P.green, 'stroke-width': 2 });
  c.circle(535, 476, 2.5, { fill: P.green });

  // Service bay floor & maintenance pit with hazard strip
  c.path('M 240 760 L 760 760 L 700 555 L 300 555 Z', {
    fill: P.bgFloor, stroke: P.lineMid, 'stroke-width': 2
  });
  c.rect(340, 555, 320, 8, { fill: '#1b2836' });
  for (let x = 345; x < 650; x += 24) {
    c.poly(`${x},555 ${x + 12},555 ${x + 6},563 ${x - 6},563`, { fill: P.gold, opacity: 0.8 });
  }
  // Recessed pit grating
  c.path('M 365 650 L 635 650 L 610 580 L 390 580 Z', {
    fill: '#050a10', stroke: P.lineMid, 'stroke-width': 2
  });
  for (let x = 415; x < 595; x += 30) {
    c.line(x, 580, x + (x - 500) * 0.15, 650, { stroke: P.lineDim, 'stroke-width': 1.5 });
  }
});

/* ==========================================================================
 * 2b. ARRAY MOUNTS (Exterior gantry: open space, mounting rails, panel frames)
 * ========================================================================== */
registerSceneTemplate('array-mounts', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#03070d' });

  // Open space beyond the hull: seeded star field
  const stars = c.int(26, 38);
  for (let i = 0; i < stars; i++) {
    c.circle(Math.round(c.range(250, 750)), Math.round(c.range(250, 470)), c.range(0.6, 1.6), { fill: P.steelLight, opacity: c.range(0.25, 0.8) });
  }

  // Hull edge and the gantry walkway the character stands on
  c.path('M 240 760 L 760 760 L 720 600 L 280 600 Z', { fill: P.bgFloor, stroke: P.lineMid, 'stroke-width': 2 });
  for (let x = 300; x < 720; x += 30) c.line(x, 600, x - (x - 500) * 0.2, 760, { stroke: P.lineDim, 'stroke-width': 1.5 });
  c.rect(280, 588, 440, 12, { fill: '#1b2836', stroke: P.lineBright, 'stroke-width': 1.5 });

  // Mounting rails running out from the hull
  for (const y of [420, 500]) {
    c.rect(270, y, 460, 10, { fill: '#0b1824', stroke: P.lineBright, 'stroke-width': 1.5 });
    for (let x = 290; x < 720; x += 46) c.line(x, y + 10, x + 23, y + 60, { stroke: P.lineMid, 'stroke-width': 1.2 });
  }

  // Panel frames on the rails: a seeded number are fitted, the rest are empty mounts
  const fitted = c.int(1, 2);
  for (let i = 0; i < 4; i++) {
    const x = 300 + i * 105;
    const filled = i < fitted;
    c.rect(x, 330, 90, 82, { fill: filled ? '#0e2236' : 'none', stroke: filled ? P.cyanDim : P.lineDim, 'stroke-width': 2, 'stroke-dasharray': filled ? 'none' : '6 4' });
    if (filled) for (let k = 1; k < 4; k++) c.line(x + k * 22.5, 330, x + k * 22.5, 412, { stroke: P.lineMid, 'stroke-width': 1 });
    c.line(x + 45, 412, x + 45, 420, { stroke: P.lineBright, 'stroke-width': 2 });
  }

  // Tether point and status lamp
  c.circle(312, 570, 9, { fill: 'none', stroke: P.gold, 'stroke-width': 2.5 });
  c.circle(690, 570, 4, { fill: c.range(0, 1) > 0.3 ? P.green : P.gold });
});

/* ==========================================================================
 * 3. WORKBENCH COMPARTMENT (Diagnostic CRT, articulated arm, tool rack, bins)
 * ========================================================================== */
registerSceneTemplate('workbench', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#060c14' });

  // Back bulkhead & perforated tool pegboard
  c.rect(295, 315, 410, 205, { fill: P.bgPanel, stroke: P.lineMid, 'stroke-width': 2.5 });
  for (let y = 335; y <= 495; y += 20) {
    for (let x = 460; x <= 575; x += 20) {
      c.circle(x, y, 1.5, { fill: P.lineMid });
    }
  }

  // Overhead task light fixture & light cone
  c.poly('370,295 630,295 690,520 310,520', { fill: P.cyan, opacity: 0.035 });
  c.rect(410, 282, 180, 14, { rx: 3, fill: P.bgFloor, stroke: P.lineBright, 'stroke-width': 2 });
  c.line(425, 296, 575, 296, { stroke: P.cyan, 'stroke-width': 3 });

  // Left: Diagnostic Oscilloscope / Telemetry Monitor
  c.rect(318, 365, 125, 92, { rx: 4, fill: '#04080e', stroke: P.lineBright, 'stroke-width': 2.5 });
  c.rect(326, 373, 109, 64, { fill: '#071722', stroke: P.lineDim, 'stroke-width': 1 });
  // Seeded waveform on screen
  const pts = [];
  for (let x = 330; x <= 430; x += 10) {
    const y = 405 + Math.sin(x * 0.15 + c.range(0, 6)) * c.range(6, 20);
    pts.push(`${x === 330 ? 'M' : 'L'} ${x} ${y.toFixed(1)}`);
  }
  c.path(pts.join(' '), { fill: 'none', stroke: P.green, 'stroke-width': 2 });
  c.circle(336, 447, 3, { fill: P.green });
  c.circle(348, 447, 3, { fill: P.gold });
  c.rect(395, 457, 24, 22, { fill: P.bgFloor, stroke: P.lineMid, 'stroke-width': 2 });

  // Center: Articulated precision lamp/arm & component on mat
  const jointX = Math.round(c.range(485, 535));
  const jointY = Math.round(c.range(345, 375));
  c.line(530, 495, jointX, jointY, { stroke: P.steel, 'stroke-width': 5 });
  c.line(jointX, jointY, 495, 425, { stroke: P.steel, 'stroke-width': 4 });
  c.circle(jointX, jointY, 6, { fill: P.bgFloor, stroke: P.cyanDim, 'stroke-width': 2 });
  c.poly('482,425 508,425 516,437 474,437', { fill: P.bgFloor, stroke: P.gold, 'stroke-width': 2 });
  // Component module on work mat
  c.rect(455, 508, 95, 12, { fill: '#0b292e', stroke: P.cyanDim, 'stroke-width': 1.5 });
  c.rect(475, 480, 52, 28, { rx: 3, fill: '#112230', stroke: P.steelLight, 'stroke-width': 1.5 });
  c.line(485, 494, 517, 494, { stroke: P.gold, 'stroke-width': 2 });

  // Right: Modular parts bins
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 2; col++) {
      const bx = 595 + col * 44;
      const by = 360 + row * 34;
      const active = c.rnd() > 0.72;
      c.rect(bx, by, 38, 26, {
        rx: 2,
        fill: active ? '#1b2d38' : '#0b1622',
        stroke: active ? P.gold : P.lineMid,
        'stroke-width': 1.5
      });
      c.line(bx + 10, by + 10, bx + 28, by + 10, {
        stroke: active ? P.gold : P.lineBright, 'stroke-width': 2
      });
    }
  }

  // Workbench surface & lower tool cabinets
  c.poly('270,520 730,520 755,550 245,550', {
    fill: '#132434', stroke: P.cyanDim, 'stroke-width': 2
  });
  c.rect(275, 550, 450, 195, { fill: '#08111b', stroke: P.lineMid, 'stroke-width': 2 });
  // Drawer stack left & right, knee well center
  c.rect(295, 565, 130, 150, { fill: P.bgPanel, stroke: P.lineDim, 'stroke-width': 1.5 });
  for (let y = 595; y <= 685; y += 30) {
    c.line(295, y, 425, y, { stroke: P.lineMid, 'stroke-width': 1.5 });
    c.line(345, y - 15, 375, y - 15, { stroke: P.steel, 'stroke-width': 2 });
  }
  c.rect(440, 565, 130, 150, { fill: '#04080e', stroke: P.lineDim, 'stroke-width': 1.5 });
  c.rect(585, 565, 120, 150, { fill: P.bgPanel, stroke: P.lineDim, 'stroke-width': 1.5 });
});

/* ==========================================================================
 * 4. CORRIDOR / TRANSIT JUNCTION (Template for hallways, airlocks, connectors)
 * ========================================================================== */
registerSceneTemplate('corridor', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#050b12' });

  // Perspective corner stringers converging toward distant bulkhead
  const corners = [
    [250, 250, 420, 365], [750, 250, 580, 365],
    [250, 750, 420, 545], [750, 750, 580, 545]
  ];
  for (const [x1, y1, x2, y2] of corners) {
    c.line(x1, y1, x2, y2, { stroke: P.lineMid, 'stroke-width': 2 });
  }

  // Octagonal structural ribs
  const ribs = [
    { s: 220, cy: 490, stroke: P.lineBright, w: 3 },
    { s: 155, cy: 472, stroke: P.lineMid, w: 2.5 },
    { s: 105, cy: 458, stroke: P.lineMid, w: 2 }
  ];
  for (const { s, cy, stroke, w } of ribs) {
    const k = s * 0.58;
    c.poly([
      `${500 - k},${cy - s}`, `${500 + k},${cy - s}`,
      `${500 + s},${cy - k}`, `${500 + s},${cy + k}`,
      `${500 + k},${cy + s}`, `${500 - k},${cy + s}`,
      `${500 - s},${cy + k}`, `${500 - s},${cy - k}`
    ], { fill: 'none', stroke, 'stroke-width': w });
  }

  // Distant bulkhead wall & pressure hatch
  c.poly('438,368 562,368 605,410 605,506 562,548 438,548 395,506 395,410', {
    fill: P.bgPanel, stroke: P.lineBright, 'stroke-width': 2.5
  });
  c.rect(456, 396, 88, 152, { rx: 6, fill: '#0b1825', stroke: P.cyanDim, 'stroke-width': 2 });
  c.circle(500, 462, 22, { fill: '#060d15', stroke: P.steel, 'stroke-width': 2.5 });
  c.line(484, 462, 516, 462, { stroke: P.cyan, 'stroke-width': 2 });
  c.line(500, 446, 500, 478, { stroke: P.cyan, 'stroke-width': 2 });

  // Status beacon above hatch
  const openReady = c.rnd() > 0.3;
  c.rect(482, 378, 36, 8, { rx: 2, fill: openReady ? P.green : P.gold });

  // Deck walkway grating
  c.poly('340,755 660,755 562,548 438,548', {
    fill: P.bgFloor, stroke: P.lineBright, 'stroke-width': 2
  });
  for (let y = 575; y < 745; y += 32) {
    const span = 62 + ((y - 548) / 207) * 90;
    c.line(500 - span, y, 500 + span, y, { stroke: P.cyanDim, 'stroke-width': 2, opacity: 0.55 });
  }
});

/* ==========================================================================
 * 5. UTILITY CORE (Template for Engineering, Reactor, Life Support, Scrubbers)
 * ========================================================================== */
registerSceneTemplate('utility-core', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#040a12' });

  // Curved coolant manifolds feeding the core
  c.path('M 280 330 Q 380 330 440 380 L 440 490 Q 380 540 280 540', {
    fill: 'none', stroke: P.lineMid, 'stroke-width': 14
  });
  c.path('M 720 330 Q 620 330 560 380 L 560 490 Q 620 540 720 540', {
    fill: 'none', stroke: P.lineMid, 'stroke-width': 14
  });

  // Left & Right wall telemetry gauge banks
  for (const bx of [305, 625]) {
    c.rect(bx, 375, 70, 120, { rx: 3, fill: P.bgPanel, stroke: P.lineBright, 'stroke-width': 2 });
    for (let i = 0; i < 3; i++) {
      const gx = bx + 12 + i * 20;
      const h = Math.round(c.range(25, 80));
      c.rect(gx, 392, 10, 86, { fill: '#04080e', stroke: P.lineDim, 'stroke-width': 1 });
      c.rect(gx + 1, 392 + (86 - h), 8, h, { fill: h > 68 ? P.gold : P.cyanDim });
    }
  }

  // Central containment column
  c.rect(442, 250, 116, 430, { fill: '#081521', stroke: P.lineBright, 'stroke-width': 3 });
  const coreColor = c.rnd() > 0.25 ? P.cyan : P.green;
  for (let y = 310; y <= 510; y += 48) {
    c.rect(454, y, 92, 26, { rx: 4, fill: '#040c14', stroke: P.lineMid, 'stroke-width': 1.5 });
    c.rect(462, y + 6, 76, 14, { rx: 2, fill: coreColor, opacity: c.range(0.55, 0.9).toFixed(2) });
    // Containment clamp collars
    c.rect(436, y - 10, 128, 8, { fill: P.bgFloor, stroke: P.steel, 'stroke-width': 1.5 });
  }

  // Foreground catwalk & safety railing
  c.rect(250, 545, 500, 16, { fill: P.bgFloor, stroke: P.lineBright, 'stroke-width': 2 });
  c.line(250, 505, 750, 505, { stroke: P.steelLight, 'stroke-width': 2.5 });
  c.line(250, 525, 750, 525, { stroke: P.steel, 'stroke-width': 1.5 });
  for (let x = 280; x <= 720; x += 55) {
    c.line(x, 505, x, 545, { stroke: P.steel, 'stroke-width': 2 });
  }
});

/* ==========================================================================
 * 6. OPS NODE (Template for Command, Comms, Sensor Array, Server Room)
 * ========================================================================== */
registerSceneTemplate('ops-node', (c) => {
  const { P } = c;
  c.rect(240, 240, 520, 520, { fill: '#050b14' });

  // Flanking server blade racks with seeded LED arrays
  for (const rx of [275, 655]) {
    c.rect(rx, 310, 70, 235, { fill: P.bgPanel, stroke: P.lineMid, 'stroke-width': 2 });
    for (let y = 325; y <= 525; y += 22) {
      c.line(rx + 6, y, rx + 64, y, { stroke: P.lineDim, 'stroke-width': 2 });
      for (let b = 0; b < 4; b++) {
        if (c.rnd() > 0.25) {
          const col = c.rnd() > 0.82 ? P.gold : (c.rnd() > 0.4 ? P.cyan : P.green);
          c.circle(rx + 14 + b * 12, y - 7, 2.2, { fill: col });
        }
      }
    }
  }

  // Central panoramic tactical display
  c.rect(360, 295, 280, 155, { rx: 4, fill: '#030810', stroke: P.lineBright, 'stroke-width': 2.5 });
  // Radar / sector plot inside screen
  c.circle(500, 372, 58, { fill: 'none', stroke: P.lineMid, 'stroke-width': 1.5 });
  c.circle(500, 372, 32, { fill: 'none', stroke: P.lineDim, 'stroke-width': 1, 'stroke-dasharray': '4 3' });
  c.line(430, 372, 570, 372, { stroke: P.lineDim, 'stroke-width': 1 });
  c.line(500, 308, 500, 436, { stroke: P.lineDim, 'stroke-width': 1 });
  const angle = c.range(0, Math.PI * 2);
  c.line(500, 372, (500 + Math.cos(angle) * 58).toFixed(1), (372 + Math.sin(angle) * 58).toFixed(1), {
    stroke: P.cyan, 'stroke-width': 2
  });
  // Seeded contact blips
  for (let i = 0; i < 3; i++) {
    const bx = c.range(455, 545).toFixed(1);
    const by = c.range(330, 415).toFixed(1);
    c.circle(bx, by, 3, { fill: i === 0 ? P.gold : P.green });
  }

  // Lower operator holotable / console
  c.poly('385,515 615,515 650,555 350,555', {
    fill: '#0d1e2d', stroke: P.cyanDim, 'stroke-width': 2
  });
  c.el('ellipse', { cx: 500, cy: 532, rx: 85, ry: 12, fill: '#06131e', stroke: P.cyan, 'stroke-width': 1.5 });
  // Projected wireframe above holotable
  c.poly('500,462 538,492 500,510 462,492', {
    fill: P.cyan, 'fill-opacity': 0.12, stroke: P.cyan, 'stroke-width': 1.5
  });
  c.line(500, 462, 500, 510, { stroke: P.cyanDim, 'stroke-width': 1, 'stroke-dasharray': '3 2' });
  c.poly('350,555 650,555 620,690 380,690', {
    fill: P.bgFloor, stroke: P.lineMid, 'stroke-width': 2
  });
});