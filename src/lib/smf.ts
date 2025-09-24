/* SMF (Spring Map File) parser for browser (little-endian)
   References (summarized):
   - 16 bytes: magic "spring map file\0"
   - 4  int:   version (1)
   - 4  uint:  id
   - 4  int:   width (squares)
   - 4  int:   length (squares)
   - 4  int:   squareSize (world units per square, usually 8)
   - 4  int:   texelsPerSquare (usually 8)
   - 4  int:   tileSize (usually 32)
   - 4  float: minHeight
   - 4  float: maxHeight
   - 4  int:   ofsHeightMap
   - 4  int:   ofsTypeMap
   - 4  int:   ofsTileIndex
   - 4  int:   ofsMiniMap
   - 4  int:   ofsMetalMap
   - 4  int:   ofsFeatures
   - 4  int:   numExtraHeaders
   - Height map: (width+1)*(length+1) uint16[]
   - Metal map: (width/2)*(length/2) uint8[]
*/

export interface SMFHeader {
  magic: string;
  version: number;
  id: number;
  width: number;
  length: number;
  squareSize: number;
  texelsPerSquare: number;
  tileSize: number;
  minHeight: number;
  maxHeight: number;
  ofsHeightMap: number;
  ofsTypeMap: number;
  ofsTileIndex: number;
  ofsMiniMap: number;
  ofsMetalMap: number;
  ofsFeatures: number;
  numExtraHeaders: number;
}

export interface SMFFeature {
  type: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  relativeSize: number;
}

export interface SMFParsed {
  header: SMFHeader;
  // Raw height data from file (uint16)
  heightU16: Uint16Array;
  // Height in world units (float), scaled into [minHeight, maxHeight]
  heightFloat: Float32Array;

  // Optional metal density map (width/2 x length/2), values 0..255
  metalU8?: Uint8Array;
  metalWidth?: number;
  metalLength?: number;

  // Optional type map (width/2 x length/2), values 0..255
  typeU8?: Uint8Array;
  typeWidth?: number;
  typeLength?: number;

  // Optional minimap raw DXT1+MM bytes (1024x1024, with mipmaps, total 699048 bytes)
  miniMapBytes?: Uint8Array;

  // Optional features
  featureTypes?: string[];
  features?: SMFFeature[];

  // Optional grass map (width/4 x length/4), values 0..255
  grassU8?: Uint8Array;
  grassWidth?: number;
  grassLength?: number;

  // Optional tile index (width/4 x length/4), int32 indices into SMT tiles
  tileIndex?: Int32Array;
  tileIndexWidth?: number;
  tileIndexLength?: number;
}

/** Reads a null-terminated C string from a fixed-length byte array. */
function cStringFromBytes(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Safe check for byte range */
function expectRange(name: string, begin: number, size: number, total: number) {
  if (begin < 0 || size <= 0 || begin + size > total) {
    throw new Error(`Out of range: ${name} (begin=${begin}, size=${size}, total=${total})`);
  }
}

/** Parse SMF buffer (ArrayBuffer from FileReader or fetch). */
export function parseSMF(buffer: ArrayBuffer): SMFParsed {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  const total = buffer.byteLength;
  const le = true;

  // Magic
  const magicBytes = u8.subarray(0, 16);
  const magic = cStringFromBytes(magicBytes);
  if (magic !== "spring map file") {
    // Some files include the trailing \0 in the 16 bytes; our cStringFromBytes trims it.
    // Accept if prefix matches.
    if (!"spring map file\0".startsWith(magic)) {
      throw new Error(`Invalid SMF magic: "${magic}"`);
    }
  }

  let off = 16;

  const version = dv.getInt32(off, le); off += 4;
  const id = dv.getUint32(off, le); off += 4;
  const width = dv.getInt32(off, le); off += 4;
  const length = dv.getInt32(off, le); off += 4;
  const squareSize = dv.getInt32(off, le); off += 4;
  const texelsPerSquare = dv.getInt32(off, le); off += 4;
  const tileSize = dv.getInt32(off, le); off += 4;
  const minHeight = dv.getFloat32(off, le); off += 4;
  const maxHeight = dv.getFloat32(off, le); off += 4;

  const ofsHeightMap = dv.getInt32(off, le); off += 4;
  const ofsTypeMap = dv.getInt32(off, le); off += 4;
  const ofsTileIndex = dv.getInt32(off, le); off += 4;
  const ofsMiniMap = dv.getInt32(off, le); off += 4;
  const ofsMetalMap = dv.getInt32(off, le); off += 4;
  const ofsFeatures = dv.getInt32(off, le); off += 4;
  const numExtraHeaders = dv.getInt32(off, le); off += 4;

  const header: SMFHeader = {
    magic,
    version,
    id,
    width,
    length,
    squareSize,
    texelsPerSquare,
    tileSize,
    minHeight,
    maxHeight,
    ofsHeightMap,
    ofsTypeMap,
    ofsTileIndex,
    ofsMiniMap,
    ofsMetalMap,
    ofsFeatures,
    numExtraHeaders,
  };

  if (version !== 1) {
    console.warn(`SMF: Unexpected version ${version} (expected 1). Proceeding anyway.`);
  }

  // Validate basic dims
  if (width <= 0 || length <= 0) {
    throw new Error(`Invalid map size: ${width}x${length}`);
  }

  // Heightmap reading
  const hmWidth = width + 1;
  const hmLength = length + 1;
  const hmCount = hmWidth * hmLength;
  const hmBytes = hmCount * 2;

  expectRange("heightmap", ofsHeightMap, hmBytes, total);

  // Read as Uint16Array from the underlying buffer.
  // Ensure the offset is aligned to 2 bytes; if not, copy.
  let heightU16: Uint16Array;
  if ((ofsHeightMap % 2) === 0) {
    heightU16 = new Uint16Array(buffer, ofsHeightMap, hmCount);
  } else {
    // Unaligned: copy to a temp buffer
    const tmp = u8.subarray(ofsHeightMap, ofsHeightMap + hmBytes);
    const copy = new Uint8Array(hmBytes);
    copy.set(tmp);
    heightU16 = new Uint16Array(copy.buffer);
  }

  // Scale to world units in [minHeight, maxHeight]
  const heightFloat = new Float32Array(hmCount);
  const scale = (maxHeight - minHeight) / 65535.0;
  for (let i = 0; i < hmCount; i++) {
    const h = heightU16[i] ?? 0;
    heightFloat[i] = minHeight + h * scale;
  }

  // Optional: Metal map reading
  let metalU8: Uint8Array | undefined;
  let metalWidth: number | undefined;
  let metalLength: number | undefined;

  if (ofsMetalMap > 0) {
    metalWidth = Math.floor(width / 2);
    metalLength = Math.floor(length / 2);
    const metalCount = metalWidth * metalLength;
    const metalBytes = metalCount; // uint8 per entry
    expectRange("metalmap", ofsMetalMap, metalBytes, total);
    metalU8 = new Uint8Array(buffer, ofsMetalMap, metalCount);
  }

  // Optional: Type map reading
  let typeU8: Uint8Array | undefined;
  let typeWidth: number | undefined;
  let typeLength: number | undefined;
  if (ofsTypeMap > 0) {
    typeWidth = Math.floor(width / 2);
    typeLength = Math.floor(length / 2);
    const typeCount = typeWidth * typeLength;
    const typeBytes = typeCount; // uint8 per entry
    expectRange("typemap", ofsTypeMap, typeBytes, total);
    typeU8 = new Uint8Array(buffer, ofsTypeMap, typeCount);
  }

  // Optional: Mini map (raw DXT1 with mipmaps, 1024x1024, fixed size 699048 bytes)
  let miniMapBytes: Uint8Array | undefined;
  if (ofsMiniMap > 0) {
    const MINI_SIZE = 699048;
    expectRange("minimap", ofsMiniMap, MINI_SIZE, total);
    miniMapBytes = new Uint8Array(buffer, ofsMiniMap, MINI_SIZE);
  }

  // Optional: Tile index array (int32 per 4x4-squares block)
  let tileIndex: Int32Array | undefined;
  let tileIndexWidth: number | undefined;
  let tileIndexLength: number | undefined;
  if (ofsTileIndex > 0) {
    tileIndexWidth = Math.floor(width / 4);
    tileIndexLength = Math.floor(length / 4);
    const tiCount = tileIndexWidth * tileIndexLength;
    const tiBytes = tiCount * 4;
    expectRange("tileIndex", ofsTileIndex, tiBytes, total);
    if ((ofsTileIndex % 4) === 0) {
      tileIndex = new Int32Array(buffer, ofsTileIndex, tiCount);
    } else {
      // Unaligned: copy
      const tmp = u8.subarray(ofsTileIndex, ofsTileIndex + tiBytes);
      const copy = new Uint8Array(tiBytes);
      copy.set(tmp);
      tileIndex = new Int32Array(copy.buffer);
    }
  }

  // Optional: parse extra headers to discover grass offset (header type 1)
  let grassOffset = 0;
  try {
    let extraOff = off;
    for (let i = 0; i < numExtraHeaders; i++) {
      const extSize = dv.getInt32(extraOff, le);
      const extType = dv.getInt32(extraOff + 4, le);
      if (extType === 1) {
        // Grass extra header
        grassOffset = dv.getInt32(extraOff + 8, le);
      }
      // defensive: avoid infinite loop on bad size
      extraOff += Math.max(8, extSize);
    }
  } catch {}

  // Optional: Grass map reading
  let grassU8: Uint8Array | undefined;
  let grassWidth: number | undefined;
  let grassLength: number | undefined;
  if (grassOffset > 0) {
    grassWidth = Math.floor(width / 4);
    grassLength = Math.floor(length / 4);
    const grassCount = grassWidth * grassLength;
    expectRange("grassmap", grassOffset, grassCount, total);
    grassU8 = new Uint8Array(buffer, grassOffset, grassCount);
  }

  // Optional: Features
  let featureTypes: string[] | undefined;
  let features: SMFFeature[] | undefined;
  if (ofsFeatures > 0) {
    expectRange("features header", ofsFeatures, 8, total);
    const fNumFeatures = dv.getInt32(ofsFeatures + 0, le);
    const fNumTypes = dv.getInt32(ofsFeatures + 4, le);

    // read fNumTypes null-terminated strings
    featureTypes = [];
    let p = ofsFeatures + 8;
    try {
      for (let i = 0; i < fNumTypes; i++) {
        let end = p;
        while (end < total && u8[end] !== 0) end++;
        const name = cStringFromBytes(u8.subarray(p, end));
        featureTypes.push(name);
        p = end + 1; // skip null
      }
    } catch {
      // ignore malformed names section
    }

    // read features (robust to truncated data)
    features = [];
    const entrySize = 4 + 4 * 5; // int + 5 floats
    const bytesAvail = Math.max(0, total - p);
    const maxFeatures = Math.floor(bytesAvail / entrySize);
    const hdrCount = Math.max(0, fNumFeatures);
    const readCount = Math.max(0, Math.min(hdrCount, maxFeatures));
    if (readCount < hdrCount) {
      console.warn(`SMF: features truncated or malformed (header=${hdrCount}, canRead=${readCount}, availBytes=${bytesAvail})`);
    }
    for (let i = 0; i < readCount; i++) {
      const base = p + i * entrySize;
      const type = dv.getInt32(base + 0, le);
      const x = dv.getFloat32(base + 4, le);
      const y = dv.getFloat32(base + 8, le);
      const z = dv.getFloat32(base + 12, le);
      const rotation = dv.getFloat32(base + 16, le);
      const relativeSize = dv.getFloat32(base + 20, le);
      features.push({ type, x, y, z, rotation, relativeSize });
    }
  }

  return {
    header,
    heightU16,
    heightFloat,
    metalU8,
    metalWidth,
    metalLength,
    typeU8,
    typeWidth,
    typeLength,
    miniMapBytes,
    featureTypes,
    features,
    grassU8,
    grassWidth,
    grassLength,
    tileIndex,
    tileIndexWidth,
    tileIndexLength,
  };
}

/** Compute world extents in map units */
export function computeWorldSize(header: SMFHeader) {
  return {
    widthWorld: header.width * header.squareSize,
    lengthWorld: header.length * header.squareSize,
  };
}

/** Compute metal map resolution (width/2 x length/2). */
export function computeMetalSize(header: SMFHeader) {
  return {
    metalWidth: Math.floor(header.width / 2),
    metalLength: Math.floor(header.length / 2),
  };
}

/** Utility to choose a downsample stride given a target maximum segments per side. */
export function chooseStride(segments: number, maxSegments = 512): number {
  if (segments <= maxSegments) return 1;
  return Math.ceil(segments / maxSegments);
}

/** Extract a downsampled height field with the given stride.
    Returns data in row-major order (z rows, x columns):
    - outWidth = floor(width/stride) + 1
    - outLength = floor(length/stride) + 1
*/
export function downsampleHeightField(
  height: Float32Array,
  width: number,
  length: number,
  stride: number
) {
  const outW = Math.floor(width / stride) + 1;
  const outL = Math.floor(length / stride) + 1;
  const out = new Float32Array(outW * outL);
  for (let z = 0; z < outL; z++) {
    const srcZ = z * stride;
    for (let x = 0; x < outW; x++) {
      const srcX = x * stride;
      const idx = srcZ * (width + 1) + srcX;
      out[z * outW + x] = height[idx] ?? 0;
    }
  }
  return { out, outW, outL };
}

/** Recompute float heights from uint16 heightmap with a given [min, max] range. */
export function u16ToFloatHeights(
  heightU16: Uint16Array,
  minHeight: number,
  maxHeight: number
): Float32Array {
  const count = heightU16.length;
  const out = new Float32Array(count);
  const scale = (maxHeight - minHeight) / 65535.0;
  for (let i = 0; i < count; i++) {
    const h = heightU16[i] ?? 0;
    out[i] = minHeight + h * scale;
  }
  return out;
}
