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
