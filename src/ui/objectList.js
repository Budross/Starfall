// Keyboard/list alternative to picking tiny map targets (Habitat05_02 §11). Mirrors the
// objects eligible in the map's current view, as a carousel in the bottom strip that a
// button opens and closes. Items are keyed and patched in place so a focused item survives updates.
export function createObjectList(el, { onPick }) {
  el.innerHTML = `
    <button type="button" class="sf-btn sf-objects-toggle" data-o="toggle" aria-expanded="false">Objects in view <span data-o="count">0</span></button>
    <div class="sf-carousel" data-o="carousel" hidden>
      <button type="button" class="sf-btn sf-carousel-nav" data-o="prev" aria-label="Previous objects">◀</button>
      <ul class="sf-objects-list" data-o="list" aria-label="Objects in view"></ul>
      <button type="button" class="sf-btn sf-carousel-nav" data-o="next" aria-label="Next objects">▶</button>
    </div>`;
  const o = Object.fromEntries([...el.querySelectorAll('[data-o]')].map(n => [n.dataset.o, n]));
  const list = o.list;
  let lastSelected = null;
  const updateNav = () => {
    o.prev.disabled = list.scrollLeft <= 0;
    o.next.disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  };
  o.toggle.addEventListener('click', () => {
    const open = o.carousel.hidden;
    o.carousel.hidden = !open;
    o.toggle.setAttribute('aria-expanded', String(open));
    if (open) updateNav();
  });
  const page = dir => list.scrollBy({ left: dir * Math.max(120, list.clientWidth * 0.8), behavior: 'smooth' });
  o.prev.addEventListener('click', () => page(-1));
  o.next.addEventListener('click', () => page(1));
  list.addEventListener('scroll', updateNav, { passive: true });
  list.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) onPick(b.dataset.id);
  });
  return {
    render(items, selectedId) {
      const existing = new Map([...list.children].map(li => [li.dataset.id, li]));
      const keep = new Set();
      const wanted = new Set(items.map(i => i.id));
      for (const [id, li] of existing) if (!wanted.has(id)) li.remove();
      items.forEach((item, index) => {
        let li = existing.get(item.id);
        if (!li) {
          li = document.createElement('li');
          li.dataset.id = item.id;
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sf-obj';
          b.dataset.id = item.id;
          li.appendChild(b);
        }
        const b = li.firstChild;
        b.textContent = `${item.label}`;
        b.dataset.kind = item.kind;
        b.setAttribute('aria-label', `${item.label}, ${item.kindLabel}`);
        if (item.id === selectedId) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
        if (list.children[index] !== li) list.insertBefore(li, list.children[index] || null); // keep focus on unmoved items
        keep.add(item.id);
      });
      for (const [id, li] of existing) if (!keep.has(id)) li.remove();
      o.count.textContent = String(items.length);
      // Bring a newly selected object into view once; not on every refresh, so manual scrolling isn't fought.
      if (selectedId !== lastSelected) {
        lastSelected = selectedId;
        if (!o.carousel.hidden) list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      if (!o.carousel.hidden) updateNav();
    },
    ids: () => [...list.children].map(li => li.dataset.id)
  };
}
