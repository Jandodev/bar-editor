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
    heightFloat[i] = minHeight + heightU16[i] * scale;
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

  return { header, heightU16, heightFloat, metalU8, metalWidth, metalLength };
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
      out[z * outW + x] = height[srcZ * (width + 1) + srcX];
    }
  }
  return { out, outW, outL };
}
