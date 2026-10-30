/**
 * Browser download helpers for plan exports.
 *
 * A `Blob` + `<a download>` works on the plain-HTTP LAN deployment. The File System
 * Access API does not: `showSaveFilePicker` requires a secure context, which an
 * http:// origin on the LAN is not.
 */

/** Downloads `data` as pretty-printed JSON under `filename`. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Downloads already-serialized text (used when the caller validated the bytes). */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
