// Composition root. Load → classify → (new game | load | recovery), then the map-first
// shell over observer projections of the committed state.
//
//   FRESH         → create a world automatically (geography entry, then save, then commit)
//   OK            → load (current save revision only)
//   OUTDATED      → recovery screen: the save is from an earlier build; there is no migration (S-43)
//   ORPHAN /
//   INCONSISTENT  → recovery screen; stored records are preserved untouched
//
// The scheduler (S-01/S-20/S-29) ticks the runtime at 2 Hz while the tab is visible.
import { createShell } from './ui/shell.js';
import { createRecoveryScreen } from './ui/recovery.js';
import { createScheduler } from './ui/scheduler.js';
import { downloadJson, exportFilename } from './ui/download.js';
import { SCENES } from './content/scenes.js';
import { CONTENT } from './content/index.js';
import { SCHEDULING, BATTERY_CUE, TREND } from './content/provisional.js';
import { createWorld, STATE_VERSION } from './core/state.js';
import { createRuntime } from './core/runtime.js';
import { createPersistence, newWorldRecords } from './core/persistence.js';
import { validateGeography, validateState } from './core/validate.js';
import { newSeed } from './core/rng.js';
import { createObserver } from './observe/observer.js';

const recordOf = rec => ({ worldId: rec.worldId, geoHash: rec.save.geoHash, geography: rec.geoEntry.geography, state: rec.save.state });

/**
 * @param root     container element
 * @param options  {storage, seed, confirm, download, clock} — injectable for tests;
 *                 clock:false leaves the scheduler stopped (tests drive app.advance)
 * @returns app handle {shell, runtime, status, persistence, newGame, exportSave, advance, destroy}
 */
export function startApp(root = document.getElementById('app'), {
  storage = globalThis.localStorage,
  seed,
  confirm = msg => window.confirm(msg),
  download = downloadJson,
  clock = true
} = {}) {
  const persistence = createPersistence(storage);
  const validators = {
    validateGeography: g => validateGeography(g, CONTENT),
    validateState: (s, g) => validateState(s, g, CONTENT),
    revision: STATE_VERSION
  };
  let shell = null, runtime = null, recovery = null, status = null, observer = null;
  const scheduler = createScheduler({ tick: dt => advance(dt), maxCatchUp: SCHEDULING.value.maxCatchUpSeconds, suspendAfter: SCHEDULING.value.suspendAfterSeconds });

  /**
   * One simulation tick through the runtime pipeline, then the shell. The scheduler calls
   * this; tests may call it directly. Only observer-made notices reach the shell.
   */
  function advance(dt) {
    if (!runtime) return { ok: false, error: 'No running game.' };
    const rt = runtime;
    const prev = rt.state;
    const r = rt.tick(dt);
    // The prior committed state lets the observer report what the character perceives locally (OB-02).
    const result = r.ok ? { ok: true, notices: observer.projectNotices(rt.state, rt.geography, r.observed, prev), cues: observer.projectCues(prev, rt.state) } : { ok: false, paused: r.paused, error: r.error };
    shell?.applySimulation(result);
    return result;
  }

  // A fresh world carries the start room's first look around (S-47), shown once after it mounts.
  let opening = null;
  const makeWorld = () => {
    const { geography, state, observed } = createWorld(CONTENT, seed ?? newSeed());
    opening = observed;
    return newWorldRecords(geography, state);
  };
  function showOpening() {
    if (!opening || !shell) return;
    for (const text of observer.projectNotices(runtime.state, runtime.geography, opening)) shell.strip.pushNarrative(text);
    opening = null;
  }
  const exportSave = () => download(exportFilename(), persistence.exportRaw());

  function unmount() {
    scheduler.stop();
    shell?.destroy(); shell = null; runtime = null; observer = null;
    recovery?.destroy(); recovery = null;
  }

  function mount(record) {
    unmount();
    runtime = createRuntime({ content: CONTENT, persistence, record });
    observer = createObserver(CONTENT);
    const rt = runtime, obs = observer;
    const projection = {
      projectMap: () => obs.projectMap(rt.state, rt.geography),
      projectContext: id => obs.projectContext(rt.state, rt.geography, id),
      projectHud: () => {
        const hud = obs.projectHud(rt.state, rt.geography);
        return rt.status.error ? { ...hud, alerts: [rt.status.error, ...hud.alerts] } : hud;
      },
      projectScene: (id, perspective) => obs.projectScene(rt.state, rt.geography, id, perspective),
      projectWorkspace: ws => obs.projectWorkspace(rt.state, rt.geography, ws),
      projectJournal: () => obs.projectJournal(rt.state, rt.geography),
      projectPowerSample: () => obs.projectPowerSample(rt.state, rt.geography),
      previewExperiment: (methodId, samples) => obs.projectExperimentPreview(rt.state, rt.geography, { methodId, samples }),
      dispatch: request => {
        const prev = rt.state;
        const { observed, ...res } = rt.dispatch(obs.toCommand(rt.state, request));
        return res.ok ? { ...res, notices: obs.projectNotices(rt.state, rt.geography, observed), cues: obs.projectCues(prev, rt.state) } : res;
      }
    };
    shell = createShell(root, { projection, sceneDefinitions: SCENES, session: { exportSave, newGame, confirm }, cueTiming: BATTERY_CUE.value, trendConfig: TREND.value });
    status = 'OK';
    if (clock) scheduler.start();
  }

  function showRecovery(kind, reason) {
    unmount();
    status = kind;
    recovery = createRecoveryScreen(root, {
      status: kind, reason, confirm,
      onExport: exportSave,
      onRetry: boot,
      onReset() {
        try {
          const rec = makeWorld();
          persistence.resetFromRecovery(rec);
          mount(recordOf(rec));
          showOpening();
          return null;
        } catch (e) {
          boot();   // whatever is stored now is classified again; nothing new is lost
          return `Reset failed: ${e.message}`;
        }
      }
    });
  }

  /** New game from a running world: export offered first, explicit confirmation, old save kept until the switch. */
  function newGame() {
    if (!runtime) return { ok: false, error: 'No running game.' };
    if (confirm('Export the current world before starting a new one? (Recommended)')) exportSave();
    if (!confirm('Start a new game? The current world will be replaced.')) return { ok: false, error: 'Cancelled.' };
    try {
      const rec = makeWorld();
      persistence.replaceWorld(runtime.worldId, rec);
      mount(recordOf(rec));
      shell.strip.pushNarrative('A new world has been created.');
      showOpening();
      return { ok: true };
    } catch (e) {
      shell?.strip.setReceipt({ ok: false, text: `New game failed; your current game is unchanged. ${e.message}` });
      return { ok: false, error: e.message };
    }
  }

  function boot() {
    const loaded = persistence.load(validators);
    if (loaded.status === 'OK') return mount(loaded.record);
    if (loaded.status === 'FRESH') {
      try {
        const rec = makeWorld();
        persistence.createWorld(rec);
        mount(recordOf(rec));
        return showOpening();
      } catch (e) {
        return showRecovery('CREATE_FAILED', e.message);
      }
    }
    return showRecovery(loaded.status, loaded.reason);
  }

  boot();
  return {
    get shell() { return shell; },
    get runtime() { return runtime; },
    get status() { return status; },
    get recovery() { return recovery; },
    get scheduler() { return scheduler; },
    persistence, newGame, exportSave, advance,
    destroy: unmount
  };
}
