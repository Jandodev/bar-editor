import JSZip from 'jszip';

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

  // Helpers
  const isSMF = (p: string) => p.toLowerCase().endsWith('.smf');
  const isUnderMaps = (p: string) => /^maps\/.+\.smf$/i.test(p);
  const isMapInfo = (p: string) => /(^|\/)mapinfo\.lua$/i.test(p);
  const isImage = (p: string) => /\.(png|jpe?g|webp|bmp|tga|dds)$/i.test(p);

  // Choose SMF: prefer under maps/
  const smfCandidates = filePaths.filter(isSMF);
  const smfMaps = smfCandidates.filter(isUnderMaps);
  const smfPath = smfMaps[0] ?? smfCandidates[0];

  if (!smfPath) {
    throw new Error('No .smf file found inside archive. Expected e.g. maps/<mapname>.smf');
  }

  // Mapinfo.lua (optional)
  const mapinfoPath = filePaths.find(isMapInfo);

  // Images
  const imageKeys = filePaths.filter(isImage);

  // Load SMF buffer
  const smfFile = zip.file(smfPath);
  if (!smfFile) {
    throw new Error(`SMF entry not found: ${smfPath}`);
  }
  const smfBuffer = await smfFile.async('arraybuffer');

  // Load mapinfo text (optional)
  let mapinfoText: string | undefined;
  if (mapinfoPath) {
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
  };
}
