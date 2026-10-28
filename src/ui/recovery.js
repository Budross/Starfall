// Recovery screen for stored records the game will not load or overwrite on its own
// (Stage 2 plan §1): ORPHAN, INCONSISTENT, OUTDATED (an earlier build's save; S-43), or a
// failed new-game write. It never
// touches storage itself; export reads raw records and reset needs explicit confirmation.
const COPY = {
  ORPHAN: { title: 'Saved data needs attention', body: 'World geography is stored, but there is no saved game to go with it. Nothing has been changed.' },
  INCONSISTENT: { title: 'Saved data needs attention', body: 'The stored game could not be loaded safely. Nothing has been changed or overwritten.' },
  CREATE_FAILED: { title: 'Could not start a new game', body: 'The new world could not be saved. No game was created.' },
  OUTDATED: { title: 'Saved game from an earlier build', body: 'This save is from an earlier build and can no longer be loaded. Nothing has been changed. You can export it, or start a new world.' }
};
/** Statuses offering only Retry (and Export where something is stored): there is nothing to reset. */
const RETRY_ONLY = new Set(['CREATE_FAILED']);

export function createRecoveryScreen(root, { status, reason, onExport, onReset, onRetry, confirm }) {
  const copy = COPY[status] ?? COPY.INCONSISTENT;
  root.classList.add('sf-recovery-root');
  root.innerHTML = `
    <section class="sf-recovery" role="alertdialog" aria-labelledby="sf-rec-title" aria-describedby="sf-rec-body">
      <h1 id="sf-rec-title" class="sf-h" tabindex="-1"></h1>
      <p id="sf-rec-body"></p>
      <p class="sf-muted" data-r="reason"></p>
      <div class="sf-recovery-actions">
        <button type="button" class="sf-btn sf-btn-primary" data-r="export">Export raw records</button>
        <button type="button" class="sf-btn" data-r="reset">Reset and start a new world…</button>
        <button type="button" class="sf-btn" data-r="retry" hidden>Try again</button>
      </div>
      <p class="sf-muted" role="status" data-r="status"></p>
    </section>`;
  const f = Object.fromEntries([...root.querySelectorAll('[data-r]')].map(n => [n.dataset.r, n]));
  root.querySelector('#sf-rec-title').textContent = copy.title;
  root.querySelector('#sf-rec-body').textContent = copy.body;
  f.reason.textContent = reason || '';
  f.reset.hidden = RETRY_ONLY.has(status);
  f.export.hidden = status === 'CREATE_FAILED';   // nothing stored to export
  f.retry.hidden = !RETRY_ONLY.has(status);

  f.export.addEventListener('click', () => { onExport(); f.status.textContent = 'Exported both raw records.'; });
  f.retry.addEventListener('click', () => onRetry?.());
  f.reset.addEventListener('click', () => {
    if (confirm('Export the stored records before resetting? (Recommended)')) onExport();
    if (!confirm('Reset permanently discards the stored world and saved game shown here and starts a new world. Continue?')) {
      f.status.textContent = 'Reset cancelled. Nothing was changed.';
      return;
    }
    const err = onReset();
    if (err) f.status.textContent = err;
  });
  root.querySelector('#sf-rec-title').focus();
  return {
    elements: f,
    destroy() { root.replaceChildren(); root.classList.remove('sf-recovery-root'); }
  };
}
