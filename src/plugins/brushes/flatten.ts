import type { Brush, BrushApplyArgs } from '../../lib/brushes'

// Flatten brush: moves heights within radius toward a target elevation.
// Target elevation is the raycast hit Y (provided by viewports as args.hitY).
// If hitY is missing, it falls back to current height at the nearest grid vertex.
// Strength is a blend factor [0..1] controlling how quickly it approaches the target.
// Falloff is a smooth curve from center (1) to radius (0).
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function smoothFalloff01(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

function pickTargetY(a: BrushApplyArgs): number {
  if (Number.isFinite(a.hitY as number)) return a.hitY as number
  // Fallback: sample from nearest grid vertex at center
  const halfW = a.widthWorld * 0.5
  const halfL = a.lengthWorld * 0.5
  const stepX = a.widthWorld / Math.max(1, a.gridW - 1)
  const stepZ = a.lengthWorld / Math.max(1, a.gridL - 1)
  const ix = clamp(Math.round((a.centerX + halfW) / stepX), 0, a.gridW - 1)
  const iz = clamp(Math.round((a.centerZ + halfL) / stepZ), 0, a.gridL - 1)
  return a.heights[iz * a.gridW + ix] ?? 0
}

const flatten: Brush = {
  id: 'flatten',
  label: 'Flatten (toward target elevation)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out

    const halfW = a.widthWorld * 0.5
    const halfL = a.lengthWorld * 0.5
    const stepX = a.widthWorld / (a.gridW - 1)
    const stepZ = a.lengthWorld / (a.gridL - 1)
    const r = Math.max(1e-6, a.radiusWorld)
    const r2 = r * r
    const s = clamp(a.strength, 0, 1)
    const targetY = pickTargetY(a)

    const minX = clamp(Math.floor((a.centerX - r + halfW) / stepX), 0, a.gridW - 1)
    const maxX = clamp(Math.ceil((a.centerX + r + halfW) / stepX), 0, a.gridW - 1)
    const minZ = clamp(Math.floor((a.centerZ - r + halfL) / stepZ), 0, a.gridL - 1)
    const maxZ = clamp(Math.ceil((a.centerZ + r + halfL) / stepZ), 0, a.gridL - 1)

    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ
      const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX
        const dx = x - a.centerX
        const d2 = dx * dx + dz * dz
        if (d2 > r2) continue
        const d = Math.sqrt(d2)
        const t = 1 - d / r // 1 at center, 0 at radius
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        // Blend toward target: h' = h*(1-w) + target*w
        out[idx] = h * (1 - w) + targetY * w
      }
    }

    return out
  },
}

export default flatten
