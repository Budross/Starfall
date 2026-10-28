// Save a JSON object as a file in the browser (export of raw save records, P-06).
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const exportFilename = () => `habitat05-save-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
