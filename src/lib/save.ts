/** Simple save helpers for the browser. Attempts File System Access API first, then falls back to a download. */
function toBlob(data: ArrayBuffer | Uint8Array | Blob, mime = 'application/octet-stream'): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof Uint8Array) {
    // Copy into a fresh ArrayBuffer to avoid SharedArrayBuffer typing issues
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new Blob([copy.buffer], { type: mime });
  }
  // ArrayBuffer: copy into a fresh buffer via a view
  const view = new Uint8Array(data as ArrayBuffer);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Blob([copy.buffer], { type: mime });
}

export async function saveBytesDialog(suggestedName: string, data: ArrayBuffer | Uint8Array | Blob, mime = 'application/octet-stream'): Promise<void> {
  const blob = toBlob(data, mime);
  try {
    const supportsPicker = typeof (window as any).showSaveFilePicker === 'function';
    if (supportsPicker) {
      const ext = (suggestedName.split('.').pop() || 'bin');
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Binary file', accept: { [mime]: ['.' + ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
  } catch (err) {
    console.warn('saveBytesDialog: File System Access API failed, falling back to download:', err);
  }
  // Fallback: download
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveTextDialog(suggestedName: string, text: string, mime = 'text/plain'): Promise<void> {
  const blob = new Blob([text], { type: mime });
  try {
    const supportsPicker = typeof (window as any).showSaveFilePicker === 'function';
    if (supportsPicker) {
      const ext = (suggestedName.split('.').pop() || 'txt');
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Text file', accept: { [mime]: ['.' + ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
  } catch (err) {
    console.warn('saveTextDialog: File System Access API failed, falling back to download:', err);
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
