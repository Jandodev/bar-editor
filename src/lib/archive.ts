import JSZip from 'jszip';
import { parseMapinfoLua } from './mapinfo';

export interface ResolvedImage {
  path: string;
  blobUrl: string;
  isDDS: boolean;
}

export interface ResolvedPackage {
  smfPath: string;
  smfBuffer: ArrayBuffer;
  mapinfoPath?: string;
  mapinfoText?: string;
  images: ResolvedImage[];
  // All non-directory entries inside the archive (full relative paths)
  filePaths: string[];
}

/**
 * Resolve a Spring map package from a .sdz/.zip file:
 * - Finds maps/*.smf (or any .smf if not under maps/)
 * - Finds mapinfo.lua (root or any subdir)
 * - Collects image assets (png/jpg/webp/bmp/tga/dds) and returns blob URLs
 */
export async function resolveMapPackageFromZip(file: File): Promise<ResolvedPackage> {
  const zip = await JSZip.loadAsync(file);

  // Gather non-directory entries with stable names
  const filePaths: string[] = [];
  zip.forEach((relativePath, fileEntry) => {
    if (!fileEntry.dir) filePaths.push(relativePath);
  });

  // Will be populated if mapinfo.lua exists
  let mapinfoText: string | undefined;

  // Helpers
  const isSMF = (p: string) => p.toLowerCase().endsWith('.smf');
  const isUnderMaps = (p: string) => /^maps\/.+\.smf$/i.test(p);
  const isMapInfo = (p: string) => /(^|\/)mapinfo\.lua$/i.test(p);
  const isImage = (p: string) => /\.(png|jpe?g|webp|bmp|tga|dds)$/i.test(p);

  // Mapinfo.lua (optional)
  const mapinfoPath = filePaths.find(isMapInfo);

  // Choose SMF, prefer the one specified in mapinfo.mapfile if present; otherwise prefer under maps/
  const smfCandidates = filePaths.filter(isSMF);
  const smfMaps = smfCandidates.filter(isUnderMaps);
  let smfPath = smfMaps[0] ?? smfCandidates[0];

  if (mapinfoPath) {
    const mf = zip.file(mapinfoPath);
    if (mf) {
      try {
        const txt = await mf.async('string');
        mapinfoText = txt;
        const mi = parseMapinfoLua(txt);
        const mfPath: unknown = mi?.mapfile;
        if (typeof mfPath === 'string' && mfPath.trim()) {
          // Normalize and try to find a matching entry in the archive (case-insensitive, suffix match)
          const wanted = mfPath.replace(/^[./\\]+/, '').toLowerCase();
          const matched = filePaths.find(p => p.toLowerCase().endsWith(wanted));
          if (matched && isSMF(matched)) {
            smfPath = matched;
          }
        }
      } catch (e) {
        console.warn('Failed to parse mapinfo.lua in archive, falling back to default SMF selection:', e);
      }
    }
  }

  if (!smfPath) {
    throw new Error('No .smf file found inside archive. Expected e.g. maps/<mapname>.smf');
  }

  // Images
  const imageKeys = filePaths.filter(isImage);

  // Load SMF buffer
  const smfFile = zip.file(smfPath);
  if (!smfFile) {
    throw new Error(`SMF entry not found: ${smfPath}`);
  }
  const smfBuffer = await smfFile.async('arraybuffer');

  // Load mapinfo text (optional) if not already loaded above
  if (!mapinfoText && mapinfoPath) {
    const mf = zip.file(mapinfoPath);
    if (mf) {
      mapinfoText = await mf.async('string');
    }
  }

  // Produce blob URLs for images
  const images: ResolvedImage[] = [];
  for (const k of imageKeys) {
    const f = zip.file(k);
    if (!f) continue;
    const blob = await f.async('blob');
    const url = URL.createObjectURL(blob);
    images.push({
      path: k,
      blobUrl: url,
      isDDS: /\.dds$/i.test(k),
    });
  }

  return {
    smfPath,
    smfBuffer,
    mapinfoPath,
    mapinfoText,
    images,
    filePaths,
  };
}
