export type CollectedFile = { path: string; file: File };

/**
 * Opens a folder picker (File System Access API) and recursively collects all files.
 * Returns a flat list of files with their virtual path relative to the picked directory.
 * Note: Only works in browsers that support window.showDirectoryPicker (Chromium-based).
 */
export async function pickDirectoryAndCollectFiles(): Promise<CollectedFile[]> {
  const w = window as any;
  if (!w.showDirectoryPicker) {
    throw new Error('This browser does not support the Directory Picker API. Use "Load map folder" instead.');
  }
  const dirHandle = await w.showDirectoryPicker({ mode: 'read' });
  return await collectFromDirectory(dirHandle, '');
}

async function collectFromDirectory(dirHandle: any, prefix: string): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  for await (const [name, handle] of (dirHandle as any).entries()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const path = prefix ? `${prefix}/${name}` : name;
      out.push({ path, file });
    } else if (handle.kind === 'directory') {
      const subPrefix = prefix ? `${prefix}/${name}` : name;
      const nested = await collectFromDirectory(handle, subPrefix);
      out.push(...nested);
    }
  }
  return out;
}
