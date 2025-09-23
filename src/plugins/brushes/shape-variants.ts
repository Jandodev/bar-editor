import type { Brush } from '../../lib/brushes'

// Shape variants for common operations (square/Chebyshev footprint).
// Provides:
//  - raise-square: raise terrain within a square footprint with smooth falloff (Chebyshev distance)
//  - lower-square: lower terrain within a square footprint with smooth falloff (Chebyshev distance)
//
// Strength semantics: world-units height delta at center (same as 'raise'/'lower').
// Falloff: cubic smoothstep on Chebyshev distance (max(|dx|, |dz|)) from center.
// Returns a NEW Float32Array for reactivity.

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function smoothFalloff01(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}
function computeBounds(gridW: number, gridL: number, widthWorld: number, lengthWorld: number, cx: number, cz: number, rWorld: number) {
  const halfW = widthWorld * 0.5
  const halfL = lengthWorld * 0.5
  const stepX = widthWorld / Math.max(1, gridW - 1)
  const stepZ = lengthWorld / Math.max(1, gridL - 1)
  const r = Math.max(1e-6, rWorld)
  const minX = clamp(Math.floor((cx - r + halfW) / stepX), 0, gridW - 1)
  const maxX = clamp(Math.ceil((cx + r + halfW) / stepX), 0, gridW - 1)
  const minZ = clamp(Math.floor((cz - r + halfL) / stepZ), 0, gridL - 1)
  const maxZ = clamp(Math.ceil((cz + r + halfL) / stepZ), 0, gridL - 1)
  return { halfW, halfL, stepX, stepZ, r, minX, maxX, minZ, maxZ }
}

function applySquareDelta(
  heights: Float32Array,
  gridW: number,
  gridL: number,
  widthWorld: number,
  lengthWorld: number,
  centerX: number,
  centerZ: number,
  radiusWorld: number,
  deltaAtCenter: number
): Float32Array {
  const out = new Float32Array(heights)
  if (!(gridW > 1 && gridL > 1)) return out
  const { halfW, halfL, stepX, stepZ, r, minX, maxX, minZ, maxZ } = computeBounds(gridW, gridL, widthWorld, lengthWorld, centerX, centerZ, radiusWorld)

  for (let iz = minZ; iz <= maxZ; iz++) {
    const z = -halfL + iz * stepZ
    const dz = Math.abs(z - centerZ)
    for (let ix = minX; ix <= maxX; ix++) {
      const x = -halfW + ix * stepX
      const dx = Math.abs(x - centerX)
      // Chebyshev distance for square footprint
      const d = Math.max(dx, dz)
      if (d > r) continue
      const t = 1 - d / r // 1 at center, 0 at edge (square)
      const w = smoothFalloff01(t)
      const idx = iz * gridW + ix
      out[idx] = out[idx] + deltaAtCenter * w
    }
  }
  return out
}

const raiseSquare: Brush = {
  id: 'raise-square',
  label: 'Raise (square footprint)',
  apply: (a) => {
    const delta = Math.abs(a.strength)
    return applySquareDelta(
      a.heights, a.gridW, a.gridL,
      a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ,
      a.radiusWorld,
      +delta
    )
  },
}

const lowerSquare: Brush = {
  id: 'lower-square',
  label: 'Lower (square footprint)',
  apply: (a) => {
    const delta = Math.abs(a.strength)
    return applySquareDelta(
      a.heights, a.gridW, a.gridL,
      a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ,
      a.radiusWorld,
      -delta
    )
  },
}

export default [raiseSquare, lowerSquare]
