// Selection context panel. Shows only what the projection permits; selecting is always
// safe and never mutates state. View controls change the camera only — never the character.
export function createContextPanel(el, { onAction, onView }) {
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Selected object');
  el.innerHTML = `
    <div class="sf-ctx-kind" data-c="kind"></div>
    <h2 class="sf-ctx-title" data-c="title" tabindex="-1"></h2>
    <div class="sf-ctx-badges"><span class="sf-badge" data-c="knowledge"></span><span class="sf-badge sf-badge-access" data-c="access"></span></div>
    <p class="sf-ctx-desc" data-c="desc"></p>
    <section class="sf-ctx-claims" data-c="claims" hidden><h3 class="sf-k">WHAT YOU KNOW</h3><ul data-c="claimList"></ul></section>
    <div class="sf-ctx-actions" data-c="actions" role="group" aria-label="Actions"></div>
    <div class="sf-ctx-view" role="group" aria-label="View — camera only, does not move you">
      <span class="sf-k">VIEW</span>
      <button type="button" class="sf-btn" data-view="inspect">Focus</button>
      <button type="button" class="sf-btn" data-view="local">Local view</button>
      <button type="button" class="sf-btn" data-view="swarm">Swarm view</button>
      <button type="button" class="sf-btn" data-view="dismiss">Dismiss</button>
    </div>`;
  const f = Object.fromEntries([...el.querySelectorAll('[data-c]')].map(n => [n.dataset.c, n]));
  let actions = [];
  el.addEventListener('click', e => {
    const v = e.target.closest('button[data-view]');
    if (v) { onView(v.dataset.view); return; }
    const a = e.target.closest('button[data-action]');
    if (a && !a.disabled) onAction(actions.find(x => x.id === a.dataset.action));
  });

  function renderActions(list) {
    actions = list;
    const host = f.actions;
    const existing = new Map([...host.children].map(c => [c.dataset.key, c]));
    const keep = new Set();
    const wanted = new Set(list.map(a => a.id));
    for (const [k, n] of existing) if (!wanted.has(k)) n.remove();
    list.forEach((a, index) => {
      let wrap = existing.get(a.id);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'sf-action';
        wrap.dataset.key = a.id;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sf-btn sf-btn-primary';
        b.dataset.action = a.id;
        const r = document.createElement('span');
        r.className = 'sf-reason';
        r.id = `sf-reason-${a.id}`;
        wrap.append(b, r);
      }
      const b = wrap.firstChild, r = wrap.lastChild;
      b.textContent = a.label;
      if (a.tone) b.dataset.tone = a.tone; else delete b.dataset.tone;
      b.disabled = a.enabled === false;
      r.textContent = a.enabled === false && a.reason ? a.reason : '';
      r.hidden = !r.textContent;
      if (r.textContent) b.setAttribute('aria-describedby', r.id); else b.removeAttribute('aria-describedby');
      if (host.children[index] !== wrap) host.insertBefore(wrap, host.children[index] || null); // never re-insert a focused node needlessly
      keep.add(a.id);
    });
    for (const [k, n] of existing) if (!keep.has(k)) n.remove();
    host.hidden = !list.length;
  }

  return {
    render(ctx) {
      el.hidden = !ctx;
      if (!ctx) return;
      f.kind.textContent = ctx.kind;
      f.title.textContent = ctx.title;
      f.knowledge.textContent = ctx.knowledge;
      f.access.textContent = ctx.access;
      f.desc.textContent = ctx.description || '';
      f.desc.hidden = !ctx.description;
      // Known claims (S-56): sourced, qualified knowledge that never names a hidden identity.
      const claims = ctx.claims ?? [];
      f.claims.hidden = !claims.length;
      f.claimList.replaceChildren(...claims.map(c => {
        const li = document.createElement('li');
        const p = document.createElement('p'), s = document.createElement('small');
        p.textContent = c.text; s.textContent = c.source; s.className = 'sf-muted';
        li.append(p, s);
        return li;
      }));
      renderActions(ctx.actions || []);
    },
    focus() { f.title.focus({ preventScroll: true }); },
    /** Anchor next to a screen point (CSS px within the stage), or null to dock. */
    anchor(point, stage) {
      if (!point || matchMedia('(max-width: 700px)').matches) { el.style.left = el.style.top = ''; el.dataset.anchored = 'false'; return; }
      const w = el.offsetWidth, h = el.offsetHeight, pad = 12;
      let x = point.x + 28, y = point.y - 24;
      if (x + w > stage.width - pad) x = point.x - 28 - w;
      x = Math.max(pad, Math.min(stage.width - w - pad, x));
      y = Math.max(pad, Math.min(stage.height - h - pad, y));
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.dataset.anchored = 'true';
    }
  };
}
