// Scene coordinator — a small shell responsibility (Habitat05_04 §3.1), not a domain,
// scheduler or event bus. It presents scenes for already-committed results, suspends
// map input while a scene is open, and routes scene action *requests* back to the
// shell. Scenes sit beside the context panel and workspace (S-34) and are modal only
// while their transition plays. Animation progress is never persisted.
import { TacticalFeedOverlay } from '../scenes/TacticalFeedOverlay.js';

export function createSceneCoordinator({ host, map, definitions, onActionRequest, onClosed = () => {} }) {
  let open = null; // { sceneId, subjectId }

  const overlay = new TacticalFeedOverlay({
    container: host,
    onActionRequest: request => onActionRequest(request),
    onCloseRequest: () => { close(); }
  });

  function transitionFor(view) {
    const def = definitions[view.sceneId];
    if (!def) throw new Error(`Unknown scene ${view.sceneId}`);
    // First visit to a docking location: whole cinematic. Later visits: brief animate-in.
    return { def, transition: view.visit === 'first' ? def.transitions.first : def.transitions.repeat };
  }

  /** Present a scene for a committed result. Refuses uncommitted or failed results. */
  function present({ receipt, view }) {
    if (!receipt || receipt.committed !== true) throw new Error('Scenes may only present committed results');
    if (!view) return Promise.resolve(null);
    return show(view);
  }

  /**
   * Present the compartment the character currently occupies (walkthrough step 2). It
   * depicts present committed state, not an event, so no receipt is involved — but only
   * an observer view built for the character's own location, seen physically, is accepted.
   */
  function presentLocation(view) {
    if (!view || view.basis !== 'current-location' || view.perspective !== 'physical') {
      throw new Error('Location scenes need a physical view of the character\'s current location');
    }
    // Already showing this location (it shares the stage with the panels): focus it, don't replay.
    if (open && open.sceneId === view.sceneId && open.subjectId === view.subjectId) { overlay.focus(); return Promise.resolve(null); }
    return show(view);
  }

  function show(view) {
    const { def, transition } = transitionFor(view);
    open = { sceneId: view.sceneId, subjectId: view.subjectId };
    host.hidden = false;
    map.setInteractive(false); // modal: map input paused; simulation policy unchanged
    return overlay.showScene({ ...view, skin: { ...def.skin, ...(view.skin || {}) } }, { transition });
  }

  /** Re-project after any commit. A null view (context lost) closes the scene. */
  function refresh(view) {
    if (!open) return;
    if (!view) { close(); return; }
    const { def } = transitionFor(view);
    overlay.updateScene({ ...view, skin: { ...def.skin, ...(view.skin || {}) } });
  }

  /**
   * A requested action was answered (committed or rejected): re-enable controls. Needed even
   * after a commit, because an unchanged view is never re-sent through refresh().
   */
  function clearPending() { overlay.clearPending(); }

  async function close() {
    if (!open) return;
    const closing = open;
    await overlay.closeScene();
    open = null;
    host.hidden = true;
    map.setInteractive(true);
    onClosed(closing);
  }

  return {
    present, presentLocation, refresh, clearPending, close,
    focus: () => overlay.focus(),
    isOpen: () => !!open,
    current: () => open && { ...open },
    get state() { return overlay.state; },
    skip: () => overlay.skipTransition(),
    destroy: () => { overlay.destroy(); open = null; map.setInteractive(true); }
  };
}
