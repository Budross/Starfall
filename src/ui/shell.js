// Map-first application shell (Habitat05_03 §2, §8.1). One persistent spatial viewport;
// HUD, selection context, workspaces, narrative strip and scenes arranged around it.
// No global gameplay tabs. The shell only renders projections and forwards requests;
// it never decides gameplay outcomes.
import { DysonSwarmCentralMap } from '../map/DysonSwarmCentralMap.js';
import { createHud } from './hud.js';
import { createContextPanel } from './context.js';
import { createStrip } from './strip.js';
import { createObjectList } from './objectList.js';
import { createWorkspaceHost } from './workspaceHost.js';
import { createSceneCoordinator } from './sceneCoordinator.js';
import { VIEW_CONFIG } from './viewConfig.js';
import { createTrendBuffer } from './trend.js';

const KIND_LABEL = { station: 'station', asteroid: 'asteroid', ship: 'vessel', megastructure: 'structure', factory: 'facility', wreck: 'wreck' };

const lerp = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });

/**
 * @param projection  {projectMap, projectContext, projectHud, projectScene, dispatch, fixture?}
 *                    dispatch results may carry `notices` (observer-made text only) and `cues`
 *                    (observer-made presentation hints, e.g. 'battery', S-40)
 * @param session     optional {exportSave(), newGame()} — shown as the HUD menu
 * @param cueTiming   {pulses, pulseSeconds} for presentation cues (S-40; from the composition root)
 * @param trendConfig {sampleSeconds, limit, gapSeconds} for the session-only power trend (S-54)
 */
export function createShell(root, { projection, sceneDefinitions, session, cueTiming = { pulses: 4, pulseSeconds: 2 }, trendConfig = { sampleSeconds: 5, limit: 120, gapSeconds: 5 } }) {
  root.classList.add('sf-shell');
  root.innerHTML = `
    <header class="sf-hud" data-x="hud"></header>
    <div class="sf-body">
      <aside class="sf-narrative" data-x="narrative" aria-label="Narrative"></aside>
      <main class="sf-stage" data-x="stage">
        <div class="sf-map" data-x="map"></div>
        <aside class="sf-context" data-x="context"></aside>
        <section class="sf-workspace" data-x="workspace"></section>
        <div class="sf-scene-layer" data-x="scene" hidden></div>
      </main>
    </div>
    <footer class="sf-strip" data-x="strip">
      <div class="sf-receipt" data-x="receipt"></div>
      <nav class="sf-objects" data-x="objects" aria-label="Objects in view"></nav>
    </footer>`;
  const x = Object.fromEntries([...root.querySelectorAll('[data-x]')].map(n => [n.dataset.x, n]));

  let selectedId = null;
  let worldById = new Map();
  let raf = null, lastListAt = 0;
  // Ship glyph motion: glide between the last two committed observations (presentation only).
  let motion = new Map(), liveShips = new Set();
  let lastSceneJson = null;
  const listeners = [];
  const listen = (t, type, fn) => { t.addEventListener(type, fn); listeners.push(() => t.removeEventListener(type, fn)); };

  // The journal is a global utility (R-09), offered only when the projection can build it.
  const hud = createHud(x.hud, { session, onJournal: projection.projectJournal ? () => openJournal() : null });
  // Power trend (A-03): session-only samples of committed states; never saved, gone on reload.
  const trend = createTrendBuffer(trendConfig);
  const wallSeconds = () => performance.now() / 1000;
  const strip = createStrip({ receipt: x.receipt, narrative: x.narrative });
  const map = new DysonSwarmCentralMap(x.map, {
    uiMode: 'embedded',
    overlays: ['physical', 'navigation'],
    localRadius: VIEW_CONFIG.localRadius,
    localCameraDistance: VIEW_CONFIG.localCameraDistance,
    onSelect: sel => select(sel ? sel.id : null),
    onViewChange: () => { renderHud(); renderObjectList(); }
  });
  // UI scale (S-35): large windows zoom the shell's bands (CSS `zoom`, see shell.css). The map
  // corrects its own pointer maths and canvas resolution for the zoom.
  let uiScale = 0;
  function applyUiScale() {
    const s = VIEW_CONFIG.uiScale(root.clientWidth, root.clientHeight);
    if (s === uiScale) return;
    uiScale = s;
    root.style.setProperty('--sf-ui-scale', String(s));
    map.resize();
  }
  applyUiScale();
  const scaleObserver = new ResizeObserver(applyUiScale);
  scaleObserver.observe(root);
  const context = createContextPanel(x.context, { onAction: handleAction, onView: handleView });
  const objectList = createObjectList(x.objects, { onPick: id => { map.select(id, { notify: false }); select(id); context.focus(); } });
  const workspace = createWorkspaceHost(x.workspace, {
    onClose: closeWorkspace,
    onAction: handleWorkspaceAction,
    preview: (methodId, samples) => projection.previewExperiment?.(methodId, samples) ?? null,
    confirm: msg => (session?.confirm ?? (m => window.confirm(m)))(msg)
  });
  const scenes = createSceneCoordinator({
    host: x.scene, map, definitions: sceneDefinitions,
    onActionRequest: handleSceneAction,
    onClosed: () => { lastSceneJson = null; renderHud(); }   // the next scene starts with no stale comparison
  });

  function renderHud() { hud.render(projection.projectHud(), map.getView()); }

  function renderObjectList() {
    const items = map.viewIds().map(id => worldById.get(id)).filter(Boolean)
      .map(e => ({ id: e.id, label: e.label || KIND_LABEL[e.type] || 'contact', kind: e.type, kindLabel: KIND_LABEL[e.type] || 'object' }));
    objectList.render(items, selectedId);
  }

  function select(id) {
    selectedId = id && worldById.has(id) ? id : null;
    context.render(selectedId ? projection.projectContext(selectedId) : null);
    renderObjectList();
  }

  function handleView(cmd) {
    if (cmd === 'inspect' && selectedId) map.inspect(selectedId);
    else if (cmd === 'local' && selectedId) map.enterLocal(selectedId);
    else if (cmd === 'swarm') map.returnToSwarm();
    else if (cmd === 'dismiss') { map.select(null); map.canvas.focus({ preventScroll: true }); }
  }

  /** Open a contextual workspace anchored to a host and the context action that opened it (U-02). */
  function openWorkspace(hostId, action) {
    workspace.open({ ...action.workspace, hostId, actionId: action.id });
    x.stage.dataset.workspace = 'open'; // widens the right column so an open scene sits beside it (S-34)
    renderWorkspace();
  }

  /** The journal: a global, read-only utility workspace (no host or opening action to lose). */
  function openJournal() {
    workspace.open({ kind: 'journal', title: 'Journal', global: true });
    x.stage.dataset.workspace = 'open';
    renderWorkspace();
  }

  function handleAction(action) {
    if (!action || action.enabled === false) return;
    if (action.kind === 'workspace') { openWorkspace(selectedId, action); return; }
    if (action.kind === 'scene') {
      // The character's current compartment: a contextual workspace, not an event depiction.
      const view = projection.projectScene(selectedId, 'physical');
      if (!view) { strip.setReceipt({ ok: false, text: 'You can only look around where you are.' }); return; }
      scenes.presentLocation(view);
      return;
    }
    const res = projection.dispatch({ type: action.kind === 'fixture-scene' ? 'fixture-scene' : 'contextAction', targetId: selectedId, actionId: action.id });
    strip.setReceipt({ ok: res.ok, text: res.ok ? res.receipt.message : res.error });
    if (!res.ok) return;
    pushNotices(res.notices);
    applyCues(res.cues);
    refresh();
    const view = sceneForReceipt(res.receipt);
    if (view) scenes.present({ receipt: res.receipt, view });
  }

  // Committed receipt → scene. The gameplay-event mapping (S-19h, Doc 04 step E) is wired at
  // the first docking the player or a bay camera can witness (Stage 6); none exists yet.
  function sceneForReceipt(receipt) {
    if (receipt.kind === 'FIXTURE_SCENE') return projection.projectScene(receipt.subjectId);
    return null;
  }

  /** A request from an open workspace: same command path as context actions, anchored to the workspace's host. */
  function handleWorkspaceAction(action) {
    const ws = workspace.current();
    if (!ws || !action || action.enabled === false) return;
    if (action.kind === 'workspace') { openWorkspace(ws.hostId, action); return; }   // e.g. a machine's controls from Systems
    const res = projection.dispatch({ type: 'contextAction', targetId: ws.hostId, actionId: action.id });
    strip.setReceipt({ ok: res.ok, text: res.ok ? res.receipt.message : res.error });
    if (!res.ok) { renderWorkspace(); return; }
    pushNotices(res.notices);
    applyCues(res.cues);
    refresh();
  }

  function renderWorkspace() {
    const ws = workspace.current();
    if (!ws) return;
    const model = projection.projectWorkspace?.(ws) ?? null;
    workspace.render(model && model.kind === 'facility-systems' && projection.projectPowerSample ? { ...model, trend: trend.view(wallSeconds()) } : model);
  }

  function handleSceneAction({ subjectId, actionId }) {
    // A machine's Controls in the scene open its workspace through the host's context opener.
    if (actionId.startsWith('open-machine:')) {
      const opener = projection.projectContext(subjectId)?.actions.find(a => a.id === actionId && a.kind === 'workspace');
      if (opener) openWorkspace(subjectId, opener);
      scenes.clearPending();
      return;
    }
    const res = projection.dispatch({ type: 'sceneAction', targetId: subjectId, actionId });
    strip.setReceipt({ ok: res.ok, text: res.ok ? res.receipt.message : res.error });
    if (res.ok) { pushNotices(res.notices); applyCues(res.cues); refresh(); }
    scenes.clearPending(); // answered either way; an unchanged view skips updateScene
  }

  /** Observer-made notices only (never ledger entries or raw simulation events). */
  function pushNotices(notices) { for (const text of notices || []) strip.pushNarrative(text); }

  // Presentation cues (S-40): a slow outline pulse on every element marked as a cue target, for
  // the authored number of pulses. Not persisted: a reload never replays a cue.
  let cueTimer = null;
  function applyCues(cues) {
    if (!cues?.includes('battery')) return;
    const { pulses, pulseSeconds } = cueTiming;
    root.style.setProperty('--sf-cue-pulse', `${pulseSeconds}s`);
    root.style.setProperty('--sf-cue-count', String(pulses));
    root.classList.remove('sf-cue-battery');
    void root.offsetWidth;   // restart the animation if a cue is already showing
    root.classList.add('sf-cue-battery');
    clearTimeout(cueTimer);
    cueTimer = setTimeout(() => root.classList.remove('sf-cue-battery'), pulses * pulseSeconds * 1000);
  }

  /**
   * A committed simulation tick: show what the character observed, then re-project.
   * Ticks never present scenes (S-19c/S-19h are wired at the first witnessed docking).
   */
  function applySimulation(result) {
    if (result?.ok) { pushNotices(result.notices); applyCues(result.cues); refresh(); }
    else renderHud();
  }

  function closeWorkspace() {
    if (!workspace.isOpen()) return;
    workspace.close();
    delete x.stage.dataset.workspace;
    focusStage();
  }

  /** Return focus to what fills the stage: the open scene, else the map. */
  function focusStage() {
    if (scenes.isOpen()) scenes.focus();
    else map.canvas.focus({ preventScroll: true });
  }

  /** Re-project everything after any committed change. */
  function refresh() {
    const world = projection.projectMap();
    worldById = new Map(world.entities.map(e => [e.id, e]));
    // Where each live ship is drawn right now, before the new projection replaces it.
    const drawn = new Map();
    for (const e of world.entities) if (e.type === 'ship' && liveShips.has(e.id) && map.entities.get(e.id)) drawn.set(e.id, { ...map.entities.get(e.id).position });
    map.setWorld(world);
    const at = performance.now();
    motion = new Map();
    liveShips = new Set();
    for (const e of world.entities) {
      if (e.type !== 'ship' || e.presentation?.stale) continue;
      liveShips.add(e.id);
      const from = drawn.get(e.id);
      if (from) { motion.set(e.id, { from, to: { ...e.position }, at }); map.updateEntity(e.id, { position: from }); }
    }
    if (selectedId && !worldById.has(selectedId)) selectedId = null;
    context.render(selectedId ? projection.projectContext(selectedId) : null);
    // Each committed state is one trend sample (A-03: committed states only).
    if (projection.projectPowerSample) trend.push(projection.projectPowerSample(), wallSeconds());
    // Workspaces restrict/close when their access disappears (U-02); a global utility has none to lose.
    const ws = workspace.current();
    if (ws?.global) renderWorkspace();
    else if (ws) {
      const ctx = projection.projectContext(ws.hostId);
      if (!ctx || !ctx.actions.some(a => a.id === ws.actionId && a.enabled !== false)) {
        closeWorkspace();
        strip.setReceipt({ ok: false, text: 'Workspace closed: access changed.' });
      } else renderWorkspace();
    }
    const open = scenes.current();
    if (open) {
      const view = projection.projectScene(open.subjectId, 'physical');
      const json = JSON.stringify(view);
      if (json !== lastSceneJson) { lastSceneJson = json; scenes.refresh(view); }
    } else lastSceneJson = null;
    renderHud();
    renderObjectList();
  }

  function frame(now) {
    for (const [id, m] of motion) {
      const f = Math.min(1, Math.max(0, (now - m.at) / VIEW_CONFIG.motionInterpolationMs));
      map.updateEntity(id, { position: lerp(m.from, m.to, f) });
      if (f >= 1) motion.delete(id);
    }
    if (selectedId && !x.context.hidden) {
      // Docked in the right column while a scene covers the map; otherwise beside the object.
      // Stage size in its own (UI-scaled) px, the same units as the map's screen positions.
      context.anchor(scenes.isOpen() ? null : map.screenPositionOf(selectedId), { width: x.stage.clientWidth, height: x.stage.clientHeight });
    }
    if (now - lastListAt > 250) { lastListAt = now; renderObjectList(); }
    raf = requestAnimationFrame(frame);
  }

  listen(root, 'keydown', e => {
    if (e.key !== 'Escape') return;
    if (x.scene.contains(e.target)) return;           // open scenes handle their own Escape
    if (e.target === map.canvas) return;              // the map handles Escape (deselect)
    if (workspace.isOpen()) { e.preventDefault(); closeWorkspace(); return; }
    if (x.context.contains(e.target) || x.objects.contains(e.target) || x.narrative.contains(e.target)) { e.preventDefault(); focusStage(); }
  });

  refresh();
  // Play starts in Local View around the character's current location (Habitat05_03 §3.2.1).
  const startId = projection.projectMap().playerLocationId;
  if (startId && worldById.has(startId)) { map.enterLocal(startId); map.select(null); }
  strip.pushNarrative(projection.fixture ? 'Fixture shell loaded. No simulation is running.' : 'Systems online.');
  raf = requestAnimationFrame(frame);

  return {
    map, scenes, strip, workspace, objectList, hud,
    elements: x,
    get selectedId() { return selectedId; },
    select: id => { map.select(id, { notify: false }); select(id); },
    refresh, handleAction, closeWorkspace, applySimulation, openJournal,
    trendView: () => trend.view(wallSeconds()),
    get cueActive() { return root.classList.contains('sf-cue-battery'); },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(cueTimer);
      root.classList.remove('sf-cue-battery');
      scaleObserver.disconnect();
      root.style.removeProperty('--sf-ui-scale');
      for (const off of listeners) off();
      scenes.destroy();
      map.destroy();
      root.replaceChildren();
      root.classList.remove('sf-shell');
    }
  };
}
