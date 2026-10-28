// Contextual workspace host. A workspace is anchored to an entity and a context action,
// never a global tab (Habitat05_03 §8.3). Closing returns to the map with selection intact.
// Its body renders the observer's workspace projection (ui/workspaces.js); a projection
// without workspace content (the Stage 1 fixture) shows the workspace notice.
import { createWorkspaceRenderer } from './workspaces.js';

export function createWorkspaceHost(el, { onClose, onAction = () => {}, preview = () => null, confirm = () => false }) {
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.innerHTML = `
    <header class="sf-ws-head">
      <h2 class="sf-h" data-w="title" tabindex="-1"></h2>
      <button type="button" class="sf-btn" data-w="close">Close <kbd>Esc</kbd></button>
    </header>
    <div class="sf-ws-body" data-w="body"></div>`;
  const f = Object.fromEntries([...el.querySelectorAll('[data-w]')].map(n => [n.dataset.w, n]));
  let current = null;
  const renderer = createWorkspaceRenderer(f.body, { onAction: a => onAction(a), preview: (m, s) => preview(m, s), confirm: m => confirm(m) });
  f.close.addEventListener('click', () => onClose());
  return {
    open(ws) {
      current = { ...ws };
      el.hidden = false;
      el.setAttribute('aria-label', ws.title);
      f.title.textContent = ws.title;
      renderer.reset();
      renderer.render(null, ws.notice || 'Fixture workspace — no simulation is connected.');
      f.title.focus({ preventScroll: true });
    },
    /** Re-render the open workspace from a fresh projection (null when unavailable). */
    render(model) { if (current) renderer.render(model, current.notice); },
    close() { current = null; el.hidden = true; renderer.reset(); },
    current: () => current && { ...current },
    isOpen: () => !!current
  };
}
