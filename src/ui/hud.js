// Slim persistent HUD: character host and place · power · work · alerts · time · view.
// Read-only, except for the Journal utility (opens the read-only journal, R-09) and the optional
// session menu (export / new game), which only forward requests. Power text comes from the observer's powerStatus projection (A-02).
const VIEW_LABEL = { swarm: 'SWARM VIEW', inspect: 'FOCUSED INSPECTION', local: 'LOCAL VIEW' };

export function createHud(el, { session, onJournal } = {}) {
  el.innerHTML = `
    <span class="sf-brand">HABITAT <b>05</b></span>
    <span class="sf-hud-item"><span class="sf-k">HOST</span> <span data-h="host">—</span></span>
    <span class="sf-hud-item" data-cue-target="battery"><span class="sf-k">POWER</span> <span data-h="power">—</span></span>
    <span class="sf-hud-item" data-h="workItem" hidden><span class="sf-k">WORK</span> <span data-h="work">—</span></span>
    <span class="sf-hud-item"><span class="sf-k">ALERTS</span> <span data-h="alerts">0</span></span>
    <span class="sf-hud-item"><span class="sf-k">TIME</span> <span data-h="time">—</span></span>
    <span class="sf-hud-item"><span class="sf-k">VIEW</span> <span data-h="view">—</span></span>
    <span class="sf-hud-alert" data-h="alert" role="alert" hidden></span>
    <span class="sf-fixture" data-h="fixture" hidden>FIXTURE DATA · NO SIMULATION</span>
    <button type="button" class="sf-btn sf-hud-journal" data-h="journal" hidden>Journal</button>
    <span class="sf-hud-menu" data-h="menu" hidden>
      <button type="button" class="sf-btn" data-h="export">Export save</button>
      <button type="button" class="sf-btn" data-h="newgame">New game…</button>
    </span>`;
  const f = Object.fromEntries([...el.querySelectorAll('[data-h]')].map(n => [n.dataset.h, n]));
  if (onJournal) {
    f.journal.hidden = false;
    f.journal.addEventListener('click', () => onJournal());
  }
  if (session) {
    f.menu.hidden = false;
    f.export.addEventListener('click', () => session.exportSave());
    f.newgame.addEventListener('click', () => session.newGame());
  }
  return {
    render(hud, view) {
      f.host.textContent = hud.place ? `${hud.host} · ${hud.place}` : hud.host;
      f.power.textContent = hud.power.label;
      f.power.dataset.state = hud.power.state;
      const w = hud.work;
      f.workItem.hidden = !w;
      if (w) {
        f.work.textContent = `${w.label} · ${Math.round(w.fraction * 100)} %${w.paused ? ' · paused: no power' : w.slowed ? ' · slowed' : w.secondsLeft !== null ? ` · ${w.secondsLeft} s` : ''}`;
        f.work.dataset.state = w.paused ? 'paused' : w.slowed ? 'slowed' : 'running';
      }
      f.alerts.textContent = String(hud.alerts.length);
      f.alert.textContent = hud.alerts[0] || '';
      f.alert.hidden = !hud.alerts.length;
      f.time.textContent = hud.time;
      f.view.textContent = VIEW_LABEL[view.mode] || view.mode;
      f.fixture.hidden = !hud.fixture;
    }
  };
}
