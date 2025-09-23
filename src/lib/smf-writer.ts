/* SMF writer (minimal) for generating a flat Spring Map File in the browser.
   Format based on the parser in ./smf.ts. We emit only the header + heightmap.
   Offsets for optional sections (type/tileIndex/miniMap/metal/features) are set to 0 (absent).

   Header layout (after 16-byte magic):
   - 4 int  : version (1)
   - 4 uint : id
   - 4 int  : width (squares)
   - 4 int  : length (squares)
   - 4 int  : squareSize
   - 4 int  : texelsPerSquare
   - 4 int  : tileSize
   - 4 float: minHeight
   - 4 float: maxHeight
   - 4 int  : ofsHeightMap
   - 4 int  : ofsTypeMap
   - 4 int  : ofsTileIndex
   - 4 int  : ofsMiniMap
   - 4 int  : ofsMetalMap
   - 4 int  : ofsFeatures
   - 4 int  : numExtraHeaders
*/

export type FlatSMFOptions = {
  width: number;          // map squares (X)
  length: number;         // map squares (Z)
  squareSize?: number;    // default 8
  texelsPerSquare?: number; // default 8
  tileSize?: number;        // default 32
  minHeight?: number;     // default 0
  maxHeight?: number;     // default 1
  flatHeightU16?: number; // default 0 (0..65535). If provided, all height samples set to this
  id?: number;            // default random uint32
};

/** Build a minimal SMF buffer with a flat heightmap. */
export function buildFlatSMFBuffer(opts: FlatSMFOptions): ArrayBuffer {
  const width = Math.max(1, Math.floor(opts.width));
  const length = Math.max(1, Math.floor(opts.length));
  const squareSize = Math.floor(opts.squareSize ?? 8);
  const texelsPerSquare = Math.floor(opts.texelsPerSquare ?? 8);
  const tileSize = Math.floor(opts.tileSize ?? 32);
  const minHeight = Number.isFinite(opts.minHeight) ? (opts.minHeight as number) : 0;
  const maxHeight = Number.isFinite(opts.maxHeight) ? (opts.maxHeight as number) : 1;
  const flatU16 = clampU16(opts.flatHeightU16 ?? 0);
  const id = toUint32(opts.id ?? Math.floor(Math.random() * 0xffffffff));

  // Dimensions
  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  const hmBytes = hmCount * 2;

  // Layout sizes
  const MAGIC_LEN = 16; // "spring map file\0"
  const HEADER_FIELDS = 16; // after magic
  const HEADER_BYTES = MAGIC_LEN + HEADER_FIELDS * 4;
  const ofsHeightMap = HEADER_BYTES;

  // Total file size: header + heightmap
  const totalBytes = ofsHeightMap + hmBytes;

  const buf = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const le = true;

  // Magic (16 bytes) - write "spring map file\0" and pad with zeros
  writeCString(u8, 0, "spring map file\u0000", MAGIC_LEN);

  let off = MAGIC_LEN;
  dv.setInt32(off, 1, le); off += 4;           // version
  dv.setUint32(off, id, le); off += 4;         // id
  dv.setInt32(off, width, le); off += 4;       // width
  dv.setInt32(off, length, le); off += 4;      // length
  dv.setInt32(off, squareSize, le); off += 4;  // squareSize
  dv.setInt32(off, texelsPerSquare, le); off += 4; // texelsPerSquare
  dv.setInt32(off, tileSize, le); off += 4;    // tileSize
  dv.setFloat32(off, minHeight, le); off += 4; // minHeight
  dv.setFloat32(off, maxHeight, le); off += 4; // maxHeight

  dv.setInt32(off, ofsHeightMap, le); off += 4;  // ofsHeightMap
  dv.setInt32(off, 0, le); off += 4;             // ofsTypeMap (absent)
  dv.setInt32(off, 0, le); off += 4;             // ofsTileIndex (absent)
  dv.setInt32(off, 0, le); off += 4;             // ofsMiniMap (absent)
  dv.setInt32(off, 0, le); off += 4;             // ofsMetalMap (absent)
  dv.setInt32(off, 0, le); off += 4;             // ofsFeatures (absent)
  dv.setInt32(off, 0, le); off += 4;             // numExtraHeaders

  // Heightmap: fill with flatU16
  const hmU16 = new Uint16Array(buf, ofsHeightMap, hmCount);
  hmU16.fill(flatU16);

  return buf;
}

/** Build an SMF buffer like buildSMFFromFloatHeights, but include minimal stub sections
    for type map, metal map, and features header so external loaders that expect these
    sections present won't misinterpret offsets.
    Layout:
    [Header][HeightMap][TypeMap zeros][MetalMap zeros][Features header (0 features, 0 types)]
*/
export function buildSMFFromFloatHeightsWithStubs(opts: {
  width: number;
  length: number;
  squareSize?: number;
  texelsPerSquare?: number;
  tileSize?: number;
  heights: Float32Array;     // row-major: (length+1) rows, (width+1) cols
  minHeight?: number;
  maxHeight?: number;
  id?: number;
}): ArrayBuffer {
  const width = Math.max(1, Math.floor(opts.width));
  const length = Math.max(1, Math.floor(opts.length));
  const squareSize = Math.floor(opts.squareSize ?? 8);
  const texelsPerSquare = Math.floor(opts.texelsPerSquare ?? 8);
  const tileSize = Math.floor(opts.tileSize ?? 32);
  const id = toUint32(opts.id ?? Math.floor(Math.random() * 0xffffffff));
  const heights = opts.heights;

  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  if (!(heights instanceof Float32Array) || heights.length !== hmCount) {
    throw new Error(`buildSMFFromFloatHeightsWithStubs: heights length ${heights?.length ?? 'n/a'} != expected ${hmCount} (${hmWidth}x${hmLength})`);
  }

  // Compute min/max if not provided
  let minH = (typeof opts.minHeight === 'number') ? opts.minHeight! : Infinity;
  let maxH = (typeof opts.maxHeight === 'number') ? opts.maxHeight! : -Infinity;
  if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
    minH = Infinity; maxH = -Infinity;
    for (let i = 0; i < hmCount; i++) {
      const v = heights[i];
      if (!Number.isFinite(v)) continue;
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
      minH = 0; maxH = 1;
    }
  }

  // Sizes
  const MAGIC_LEN = 16;
  const HEADER_FIELDS = 16;
  const HEADER_BYTES = MAGIC_LEN + HEADER_FIELDS * 4;

  const heightMapBytes = hmCount * 2; // uint16
  const typeMapW = Math.floor(width / 2);
  const typeMapL = Math.floor(length / 2);
  const typeMapBytes = Math.max(0, typeMapW * typeMapL); // uint8 per entry

  const metalMapW = Math.floor(width / 2);
  const metalMapL = Math.floor(length / 2);
  const metalMapBytes = Math.max(0, metalMapW * metalMapL); // uint8 per entry

  const featuresHeaderBytes = 8; // two int32: numFeatures, numFeatureTypes

  // Offsets
  const ofsHeightMap = HEADER_BYTES;
  const ofsTypeMap = ofsHeightMap + heightMapBytes;

  // SMF stores a full 1024x1024 DXT1 minimap with mip pyramid; total size is 699048 bytes
  const miniMapBytes = 699048;
  const ofsMiniMap = ofsTypeMap + typeMapBytes;

  const ofsMetalMap = ofsMiniMap + miniMapBytes;
  const ofsFeatures = ofsMetalMap + metalMapBytes;

  const totalBytes = ofsFeatures + featuresHeaderBytes;

  const buf = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const le = true;

  // Magic
  writeCString(u8, 0, "spring map file\u0000", MAGIC_LEN);
  let off = MAGIC_LEN;

  // Header fields
  dv.setInt32(off, 1, le); off += 4;               // version
  dv.setUint32(off, id, le); off += 4;             // id
  dv.setInt32(off, width, le); off += 4;           // width
  dv.setInt32(off, length, le); off += 4;          // length
  dv.setInt32(off, squareSize, le); off += 4;      // squareSize
  dv.setInt32(off, texelsPerSquare, le); off += 4; // texelsPerSquare
  dv.setInt32(off, tileSize, le); off += 4;        // tileSize
  dv.setFloat32(off, minH, le); off += 4;          // minHeight
  dv.setFloat32(off, maxH, le); off += 4;          // maxHeight

  dv.setInt32(off, ofsHeightMap, le); off += 4;    // ofsHeightMap
  dv.setInt32(off, ofsTypeMap > HEADER_BYTES ? ofsTypeMap : 0, le); off += 4;       // ofsTypeMap
  dv.setInt32(off, 0, le); off += 4;               // ofsTileIndex (absent)
  dv.setInt32(off, ofsMiniMap > HEADER_BYTES ? ofsMiniMap : 0, le); off += 4;       // ofsMiniMap
  dv.setInt32(off, ofsMetalMap > HEADER_BYTES ? ofsMetalMap : 0, le); off += 4;     // ofsMetalMap
  dv.setInt32(off, ofsFeatures > HEADER_BYTES ? ofsFeatures : 0, le); off += 4;     // ofsFeatures
  dv.setInt32(off, 0, le); off += 4;               // numExtraHeaders

  // Heightmap u16
  const hmU16 = new Uint16Array(buf, ofsHeightMap, hmCount);
  const scale = 65535.0 / Math.max(1e-6, (maxH - minH));
  for (let i = 0; i < hmCount; i++) {
    const f = heights[i];
    const u = Math.round((f - minH) * scale);
    hmU16[i] = clampU16(u);
  }

  // Type map (zeros)
  if (typeMapBytes > 0) {
    u8.fill(0, ofsTypeMap, ofsTypeMap + typeMapBytes);
  }
  // MiniMap (zeros) - raw DXT1 mips blob
  u8.fill(0, ofsMiniMap, ofsMiniMap + miniMapBytes);

  // Metal map (zeros)
  if (metalMapBytes > 0) {
    u8.fill(0, ofsMetalMap, ofsMetalMap + metalMapBytes);
  }
  // Features header (two zeros)
  dv.setInt32(ofsFeatures + 0, 0, le); // numFeatures
  dv.setInt32(ofsFeatures + 4, 0, le); // numFeatureTypes

  return buf;
}

function clampU16(v: number): number {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(65535, v));
}

function toUint32(v: number): number {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return 0;
  return v >>> 0;
}

function writeCString(dst: Uint8Array, offset: number, s: string, maxLen: number) {
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  const n = Math.min(bytes.length, maxLen);
  dst.set(bytes.subarray(0, n), offset);
  for (let i = n; i < maxLen; i++) dst[offset + i] = 0;
}

/** Patch an existing SMF buffer's heightmap in-place (returns a new ArrayBuffer copy).
    - Preserves ALL other sections (type map, minimap, tile index, metal, features, extra headers)
    - Keeps original header minHeight/maxHeight so world scale stays consistent
    - Expects heightFloat length to equal (width+1)*(length+1)
*/
export function patchSMFHeightsInBuffer(orig: ArrayBuffer, heightFloat: Float32Array): ArrayBuffer {
  // Make a copy to avoid mutating the original buffer
  const outBuf = orig.slice(0);
  const dv = new DataView(outBuf);
  const u8 = new Uint8Array(outBuf);
  const le = true;

  // Validate magic
  const magicBytes = u8.subarray(0, 16);
  const magic = new TextDecoder().decode(magicBytes).replace(/\0+$/, '');
  if (magic !== 'spring map file') {
    // Some files include trailing nulls; compare prefix
    if (!'spring map file\u0000'.startsWith(new TextDecoder().decode(magicBytes))) {
      throw new Error('patchSMFHeightsInBuffer: invalid SMF magic');
    }
  }

  let off = 16;
  const version = dv.getInt32(off, le); off += 4;
  if (version !== 1) {
    // Proceed, but warn in console context if available
    try { console.warn?.('SMF patch: version != 1 (got', version, ') proceeding'); } catch {}
  }
  /* id */                       off += 4;
  const width = dv.getInt32(off, le); off += 4;
  const length = dv.getInt32(off, le); off += 4;
  /* squareSize */               off += 4;
  /* texelsPerSquare */          off += 4;
  /* tileSize */                 off += 4;
  const minHeight = dv.getFloat32(off, le); off += 4;
  const maxHeight = dv.getFloat32(off, le); off += 4;

  const ofsHeightMap = dv.getInt32(off, le); off += 4;
  /* ofsTypeMap */               off += 4;
  /* ofsTileIndex */             off += 4;
  /* ofsMiniMap */               off += 4;
  /* ofsMetalMap */              off += 4;
  /* ofsFeatures */              off += 4;
  /* numExtraHeaders */          off += 4;

  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  if (!(heightFloat instanceof Float32Array) || heightFloat.length !== hmCount) {
    throw new Error(`patchSMFHeightsInBuffer: height length ${heightFloat?.length ?? 'n/a'} != expected ${hmCount}`);
  }

  // Encode float heights -> uint16 using original [minHeight, maxHeight]
  const scale = 65535.0 / Math.max(1e-6, (maxHeight - minHeight));
  // Write with DataView to be safe on odd offsets
  for (let i = 0; i < hmCount; i++) {
    const f = heightFloat[i];
    const u = clampU16(Math.round((f - minHeight) * scale));
    // each entry is 2 bytes at ofsHeightMap + i*2
    dv.setUint16(ofsHeightMap + i * 2, u, le);
  }

  return outBuf;
}

/** Build an SMF buffer from a float height field (downsampled or native).
    - width/length are squares (so heights length must be (width+1)*(length+1))
    - minHeight/maxHeight control scaling to uint16
    - Only header + heightmap are emitted; other sections omitted (offsets=0)
*/
/** Patch an existing SMF buffer's heightmap and update header min/max in-place (returns a new ArrayBuffer copy).
    - Preserves ALL other sections (type map, minimap, tile index, metal, features, extra headers)
    - Recomputes or accepts minHeight/maxHeight and writes them into the header
    - Re-encodes heightmap using the new [minHeight, maxHeight] range
    - Expects heightFloat length to equal (width+1)*(length+1)
*/
export function patchSMFHeightsAndHeaderInBuffer(
  orig: ArrayBuffer,
  heightFloat: Float32Array,
  opts?: { minHeight?: number; maxHeight?: number }
): ArrayBuffer {
  // Make a copy to avoid mutating the original buffer
  const outBuf = orig.slice(0);
  const dv = new DataView(outBuf);
  const u8 = new Uint8Array(outBuf);
  const le = true;

  // Validate magic
  const magicBytes = u8.subarray(0, 16);
  const magicStr = new TextDecoder().decode(magicBytes);
  if (!magicStr.startsWith('spring map file')) {
    throw new Error('patchSMFHeightsAndHeaderInBuffer: invalid SMF magic');
  }

  let off = 16;
  const version = dv.getInt32(off, le); off += 4;
  if (version !== 1) {
    try { console.warn?.('SMF patch (with header): version != 1 (got', version, ') proceeding'); } catch {}
  }
  /* id */                       off += 4;
  const width = dv.getInt32(off, le); off += 4;
  const length = dv.getInt32(off, le); off += 4;
  /* squareSize */               off += 4;
  /* texelsPerSquare */          off += 4;
  /* tileSize */                 off += 4;

  // Capture positions of header min/max so we can overwrite
  const posMin = off;            /* minHeight */      off += 4;
  const posMax = off;            /* maxHeight */      off += 4;

  const ofsHeightMap = dv.getInt32(off, le); off += 4;
  /* ofsTypeMap */               off += 4;
  /* ofsTileIndex */             off += 4;
  /* ofsMiniMap */               off += 4;
  /* ofsMetalMap */              off += 4;
  /* ofsFeatures */              off += 4;
  /* numExtraHeaders */          off += 4;

  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  if (!(heightFloat instanceof Float32Array) || heightFloat.length !== hmCount) {
    throw new Error(`patchSMFHeightsAndHeaderInBuffer: height length ${heightFloat?.length ?? 'n/a'} != expected ${hmCount}`);
  }

  // Determine new min/max from opts or data
  let minH = (opts && typeof opts.minHeight === 'number') ? opts.minHeight : Infinity;
  let maxH = (opts && typeof opts.maxHeight === 'number') ? opts.maxHeight : -Infinity;
  if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
    minH = Infinity; maxH = -Infinity;
    for (let i = 0; i < hmCount; i++) {
      const v = heightFloat[i];
      if (!Number.isFinite(v)) continue;
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
      minH = 0; maxH = 1;
    }
  }

  // Write new min/max into header
  dv.setFloat32(posMin, minH, le);
  dv.setFloat32(posMax, maxH, le);

  // Encode float heights -> uint16 using new [minH, maxH]
  const scale = 65535.0 / Math.max(1e-6, (maxH - minH));
  for (let i = 0; i < hmCount; i++) {
    const f = heightFloat[i];
    const u = clampU16(Math.round((f - minH) * scale));
    dv.setUint16(ofsHeightMap + i * 2, u, le);
  }

  return outBuf;
}

export function buildSMFFromFloatHeights(opts: {
  width: number;
  length: number;
  squareSize?: number;
  texelsPerSquare?: number;
  tileSize?: number;
  heights: Float32Array;     // row-major: (length+1) rows, (width+1) cols
  minHeight?: number;
  maxHeight?: number;
  id?: number;
}): ArrayBuffer {
  const width = Math.max(1, Math.floor(opts.width));
  const length = Math.max(1, Math.floor(opts.length));
  const squareSize = Math.floor(opts.squareSize ?? 8);
  const texelsPerSquare = Math.floor(opts.texelsPerSquare ?? 8);
  const tileSize = Math.floor(opts.tileSize ?? 32);
  const id = toUint32(opts.id ?? Math.floor(Math.random() * 0xffffffff));
  const heights = opts.heights;

  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  if (!(heights instanceof Float32Array) || heights.length !== hmCount) {
    throw new Error(`buildSMFFromFloatHeights: heights length ${heights?.length ?? 'n/a'} != expected ${hmCount} (${hmWidth}x${hmLength})`);
  }

  // Compute min/max if not provided
  let minH = (typeof opts.minHeight === 'number') ? opts.minHeight! : Infinity;
  let maxH = (typeof opts.maxHeight === 'number') ? opts.maxHeight! : -Infinity;
  if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
    minH = Infinity; maxH = -Infinity;
    for (let i = 0; i < hmCount; i++) {
      const v = heights[i];
      if (!Number.isFinite(v)) continue;
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH) || maxH <= minH) {
      minH = 0; maxH = 1;
    }
  }

  // Prepare layout
  const MAGIC_LEN = 16;
  const HEADER_FIELDS = 16;
  const HEADER_BYTES = MAGIC_LEN + HEADER_FIELDS * 4;
  const ofsHeightMap = HEADER_BYTES;
  const hmBytes = hmCount * 2;
  const totalBytes = ofsHeightMap + hmBytes;

  const buf = new ArrayBuffer(totalBytes);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const le = true;

  // Magic
  writeCString(u8, 0, "spring map file\u0000", MAGIC_LEN);

  let off = MAGIC_LEN;
  dv.setInt32(off, 1, le); off += 4;                 // version
  dv.setUint32(off, id, le); off += 4;               // id
  dv.setInt32(off, width, le); off += 4;             // width
  dv.setInt32(off, length, le); off += 4;            // length
  dv.setInt32(off, squareSize, le); off += 4;        // squareSize
  dv.setInt32(off, texelsPerSquare, le); off += 4;   // texelsPerSquare
  dv.setInt32(off, tileSize, le); off += 4;          // tileSize
  dv.setFloat32(off, minH, le); off += 4;            // minHeight
  dv.setFloat32(off, maxH, le); off += 4;            // maxHeight
  dv.setInt32(off, ofsHeightMap, le); off += 4;      // ofsHeightMap
  dv.setInt32(off, 0, le); off += 4;                 // ofsTypeMap
  dv.setInt32(off, 0, le); off += 4;                 // ofsTileIndex
  dv.setInt32(off, 0, le); off += 4;                 // ofsMiniMap
  dv.setInt32(off, 0, le); off += 4;                 // ofsMetalMap
  dv.setInt32(off, 0, le); off += 4;                 // ofsFeatures
  dv.setInt32(off, 0, le); off += 4;                 // numExtraHeaders

  // Scale floats -> uint16
  const scale = 65535.0 / Math.max(1e-6, (maxH - minH));
  const hmU16 = new Uint16Array(buf, ofsHeightMap, hmCount);
  for (let i = 0; i < hmCount; i++) {
    const f = heights[i];
    const u = Math.round((f - minH) * scale);
    hmU16[i] = clampU16(u);
  }

  return buf;
}
