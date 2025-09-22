// Terrain editing primitives for heightmap-based SMF terrain.
// We operate on the displayed downsampled grid (gridW x gridL) in world X/Z.
// Brushes:
// - add/remove: raise/lower with smooth falloff
// - smooth: blend toward neighbor average within radius
//
// Note: For performance we return a NEW Float32Array so upstream watchers see a reference change.

export type BrushMode = 'off' | 'add' | 'remove' | 'smooth'

export interface EditConfig {
  mode: BrushMode
  // Brush radius in WORLD units (same units as widthWorld/lengthWorld)
  radius: number
  // Strength:
  //  - add/remove: height delta (world units) applied at center, multiplied by falloff in [0,1]
  //  - smooth: 0..1 blend factor toward neighbors (e.g. 0.2)
  strength: number
}

// Utility clamp
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// Quintic smoothstep-like falloff (t in [0,1])
function smoothFalloff01(t: number): number {
  // s-curve for nicer brush edges; keep simple cubic smoothstep
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/**
 * Compute a new height field after applying an add/remove brush.
 * @param heights current height field (Float32Array, length gridW*gridL)
 * @param gridW number of vertices along X
 * @param gridL number of vertices along Z
 * @param widthWorld world width (X)
 * @param lengthWorld world length (Z)
 * @param centerX world X coordinate of brush center
 * @param centerZ world Z coordinate of brush center
 * @param radiusWorld brush radius in world units
 * @param deltaHeight center delta height (positive to raise, negative to lower)
 * @param minHeight clamp lower bound (optional)
 * @param maxHeight clamp upper bound (optional)
 */
export function applyAddRemove(
  heights: Float32Array,
  gridW: number,
  gridL: number,
  widthWorld: number,
  lengthWorld: number,
  centerX: number,
  centerZ: number,
  radiusWorld: number,
  deltaHeight: number,
  minHeight?: number,
  maxHeight?: number
): Float32Array {
  const out = new Float32Array(heights)
  if (!(gridW > 1 && gridL > 1)) return out
  const halfW = widthWorld * 0.5
  const halfL = lengthWorld * 0.5
  const stepX = widthWorld / (gridW - 1)
  const stepZ = lengthWorld / (gridL - 1)
  const r = Math.max(1e-6, radiusWorld)
  const r2 = r * r

  // Compute affected index range to limit loops
  const minX = clamp(Math.floor((centerX - r + halfW) / stepX), 0, gridW - 1)
  const maxX = clamp(Math.ceil((centerX + r + halfW) / stepX), 0, gridW - 1)
  const minZ = clamp(Math.floor((centerZ - r + halfL) / stepZ), 0, gridL - 1)
  const maxZ = clamp(Math.ceil((centerZ + r + halfL) / stepZ), 0, gridL - 1)

  for (let iz = minZ; iz <= maxZ; iz++) {
    const z = -halfL + iz * stepZ
    const dz = z - centerZ
    for (let ix = minX; ix <= maxX; ix++) {
      const x = -halfW + ix * stepX
      const dx = x - centerX
      const d2 = dx * dx + dz * dz
      if (d2 > r2) continue
      const d = Math.sqrt(d2)
      const t = 1 - d / r // 1 at center, 0 at radius
      const w = smoothFalloff01(t)
      const idx = iz * gridW + ix
      let h = out[idx] + deltaHeight * w
      if (minHeight !== undefined) h = Math.max(minHeight, h)
      if (maxHeight !== undefined) h = Math.min(maxHeight, h)
      out[idx] = h
    }
  }
  return out
}

/**
 * Smooth brush: blends heights within radius toward their local average.
 * @param strength blend factor [0..1], e.g. 0.2 = move 20% toward average
 */
export function applySmooth(
  heights: Float32Array,
  gridW: number,
  gridL: number,
  widthWorld: number,
  lengthWorld: number,
  centerX: number,
  centerZ: number,
  radiusWorld: number,
  strength: number,
  minHeight?: number,
  maxHeight?: number
): Float32Array {
  const out = new Float32Array(heights)
  if (!(gridW > 1 && gridL > 1)) return out
  const halfW = widthWorld * 0.5
  const halfL = lengthWorld * 0.5
  const stepX = widthWorld / (gridW - 1)
  const stepZ = lengthWorld / (gridL - 1)
  const r = Math.max(1e-6, radiusWorld)
  const r2 = r * r
  const s = clamp(strength, 0, 1)

  const minX = clamp(Math.floor((centerX - r + halfW) / stepX), 0, gridW - 1)
  const maxX = clamp(Math.ceil((centerX + r + halfW) / stepX), 0, gridW - 1)
  const minZ = clamp(Math.floor((centerZ - r + halfL) / stepZ), 0, gridL - 1)
  const maxZ = clamp(Math.ceil((centerZ + r + halfL) / stepZ), 0, gridL - 1)

  // Simple average of 8-neighborhood (or fewer at borders)
  const neighbor = (ix: number, iz: number) => heights[iz * gridW + ix]

  for (let iz = minZ; iz <= maxZ; iz++) {
    const z = -halfL + iz * stepZ
    const dz = z - centerZ
    for (let ix = minX; ix <= maxX; ix++) {
      const x = -halfW + ix * stepX
      const dx = x - centerX
      const d2 = dx * dx + dz * dz
      if (d2 > r2) continue

      // Collect neighbors including self
      let sum = 0
      let count = 0
      for (let oz = -1; oz <= 1; oz++) {
        const z2 = iz + oz
        if (z2 < 0 || z2 >= gridL) continue
        for (let ox = -1; ox <= 1; ox++) {
          const x2 = ix + ox
          if (x2 < 0 || x2 >= gridW) continue
          sum += neighbor(x2, z2)
          count++
        }
      }
      if (count <= 0) continue
      const avg = sum / count
      const idx = iz * gridW + ix
      let h = heights[idx] * (1 - s) + avg * s
      if (minHeight !== undefined) h = Math.max(minHeight, h)
      if (maxHeight !== undefined) h = Math.min(maxHeight, h)
      out[idx] = h
    }
  }
  return out
}
