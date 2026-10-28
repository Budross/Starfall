// Narrative sidebar + action receipt: separate channels so an action receipt is never
// overwritten by ambient narrative (UX audit F6). The narrative is a persistent, short
// in-session log (newest last) in the left-hand column.
export function createStrip({ receipt, narrative }) {
  receipt.innerHTML = `<span class="sf-k">RESULT</span> <span data-s="receiptText">—</span>`;
  receipt.setAttribute('role', 'status');
  receipt.setAttribute('aria-live', 'polite');
  narrative.innerHTML = `<h2 class="sf-h">Narrative</h2><ol class="sf-log" data-s="log" role="log" aria-live="polite" aria-label="Narrative"></ol>`;
  const f = {
    receiptText: receipt.querySelector('[data-s="receiptText"]'),
    log: narrative.querySelector('[data-s="log"]')
  };
  return {
    setReceipt({ ok, text }) {
      f.receiptText.textContent = text;
      receipt.dataset.ok = String(!!ok);
    },
    pushNarrative(text) {
      const li = document.createElement('li');
      li.textContent = text;
      f.log.appendChild(li);
      while (f.log.children.length > 50) f.log.firstChild.remove();
      narrative.scrollTop = narrative.scrollHeight;   // keep the newest entry in view
    },
    get receiptText() { return f.receiptText.textContent; }
  };
}
