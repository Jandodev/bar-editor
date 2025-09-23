import type { Brush, BrushApplyArgs } from '../../lib/brushes'
import { applySmooth } from '../../lib/terrain-edit'

// VoxelSniper-style terrain brush pack for heightmaps.
// Brushes included: blend, level, erode, dilate, fill, drain, terrace, noise, sharpen
// Semantics per brush are documented inline. All brushes:
// - operate within a circular radius in world units
// - use a smooth falloff from center (1) to radius (0)
// - blend effect strength by falloff * user strength (unless noted)
// - return a NEW Float32Array for reactivity

// Utilities
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)) }
function smoothFalloff01(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x) // cubic smoothstep
}

function computeAffectedBounds(
  gridW: number, gridL: number,
  widthWorld: number, lengthWorld: number,
  centerX: number, centerZ: number, radiusWorld: number
) {
  const halfW = widthWorld * 0.5
  const halfL = lengthWorld * 0.5
  const stepX = widthWorld / Math.max(1, gridW - 1)
  const stepZ = lengthWorld / Math.max(1, gridL - 1)
  const r = Math.max(1e-6, radiusWorld)
  const minX = clamp(Math.floor((centerX - r + halfW) / stepX), 0, gridW - 1)
  const maxX = clamp(Math.ceil((centerX + r + halfW) / stepX), 0, gridW - 1)
  const minZ = clamp(Math.floor((centerZ - r + halfL) / stepZ), 0, gridL - 1)
  const maxZ = clamp(Math.ceil((centerZ + r + halfL) / stepZ), 0, gridL - 1)
  return { halfW, halfL, stepX, stepZ, r, r2: r * r, minX, maxX, minZ, maxZ }
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

function neighborMinMaxAvg(heights: Float32Array, gridW: number, gridL: number, ix: number, iz: number) {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  let count = 0
  for (let oz = -1; oz <= 1; oz++) {
    const z2 = iz + oz
    if (z2 < 0 || z2 >= gridL) continue
    for (let ox = -1; ox <= 1; ox++) {
      const x2 = ix + ox
      if (x2 < 0 || x2 >= gridW) continue
      const v = heights[z2 * gridW + x2]
      if (v < min) min = v
      if (v > max) max = v
      sum += v
      count++
    }
  }
  const avg = count > 0 ? sum / count : 0
  return { min, max, avg }
}

// 1) Blend (multi-pass smooth): approximates Gaussian-like blur by two passes.
//    strength in [0..1] acts like per-pass blend factor; effect stays within brush radius.
const blend: Brush = {
  id: 'blend',
  label: 'Blend (two-pass smooth)',
  apply: (a) => {
    const s = clamp(a.strength, 0, 1)
    if (s <= 0) return new Float32Array(a.heights)
    const pass1 = applySmooth(
      a.heights, a.gridW, a.gridL, a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ, a.radiusWorld, s
    )
    const pass2 = applySmooth(
      pass1, a.gridW, a.gridL, a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ, a.radiusWorld, s
    )
    return pass2
  },
}

// 2) Level (hard set toward target elevation): like Flatten but defaults to strong set.
//    target elevation uses hitY or nearest grid vertex; strength∈[0..1] controls blend.
const level: Brush = {
  id: 'level',
  label: 'Level (toward target elevation)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const targetY = pickTargetY(a)
    const s = clamp(a.strength <= 0 ? 1 : a.strength, 0, 1)
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        out[idx] = h * (1 - w) + targetY * w
      }
    }
    return out
  },
}

// 3) Erode: reduce peaks by moving heights toward local min. strength∈[0..1].
const erode: Brush = {
  id: 'erode',
  label: 'Erode (reduce peaks)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const s = clamp(a.strength, 0, 1)
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const { min } = neighborMinMaxAvg(a.heights, a.gridW, a.gridL, ix, iz)
        out[idx] = h * (1 - w) + min * w
      }
    }
    return out
  },
}

// 4) Dilate: fill pits by moving heights toward local max. strength∈[0..1].
const dilate: Brush = {
  id: 'dilate',
  label: 'Dilate (fill pits)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const s = clamp(a.strength, 0, 1)
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const { max } = neighborMinMaxAvg(a.heights, a.gridW, a.gridL, ix, iz)
        out[idx] = h * (1 - w) + max * w
      }
    }
    return out
  },
}

// 5) Fill: raise toward target Y but never lower. strength∈[0..1] as blend factor.
const fill: Brush = {
  id: 'fill',
  label: 'Fill (raise up to target)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const targetY = pickTargetY(a)
    const s = clamp(a.strength, 0, 1)
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const tgt = Math.max(h, targetY) // never lower
        out[idx] = h * (1 - w) + tgt * w
      }
    }
    return out
  },
}

// 6) Drain: lower toward target Y but never raise. strength∈[0..1] as blend factor.
const drain: Brush = {
  id: 'drain',
  label: 'Drain (lower down to target)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const targetY = pickTargetY(a)
    const s = clamp(a.strength, 0, 1)
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) * s
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const tgt = Math.min(h, targetY) // never raise
        out[idx] = h * (1 - w) + tgt * w
      }
    }
    return out
  },
}

// 7) Terrace: quantize heights to steps of size "strength" (world units).
//    If strength <= 0, defaults to 8.0. Blends by falloff (not by strength).
//    This lets the UI use strength to control step size distinctly.
const terrace: Brush = {
  id: 'terrace',
  label: 'Terrace (quantize by step size = strength)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const step = a.strength > 0 ? a.strength : 8.0
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t) // step size is separate; blend by falloff only
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const quant = Math.round(h / step) * step
        out[idx] = h * (1 - w) + quant * w
      }
    }
    return out
  },
}

// 8) Noise: adds band-limited procedural noise scaled by strength (world units).
//    Deterministic hash noise based on grid coords + stroke center to avoid full randomness.
function hash32(x: number) {
  // Robert Jenkins' 32 bit integer hash variation
  x = (x + 0x7ed55d16) + (x << 12)
  x = (x ^ 0xc761c23c) ^ (x >>> 19)
  x = (x + 0x165667b1) + (x << 5)
  x = (x + 0xd3a2646c) ^ (x << 9)
  x = (x + 0xfd7046c5) + (x << 3)
  x = (x ^ 0xb55a4f09) ^ (x >>> 16)
  return x >>> 0
}
function noise2(ix: number, iz: number, seed: number) {
  const h = hash32(hash32(ix + seed) ^ hash32(iz - seed))
  return (h / 0xffffffff) * 2 - 1 // [-1, 1]
}
const noise: Brush = {
  id: 'noise',
  label: 'Noise (add random variation)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const amp = Math.abs(a.strength) // world units
    if (amp <= 0) return out
    const seed = (Math.floor(a.centerX * 123.456) ^ Math.floor(a.centerZ * 987.654)) | 0
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t)
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const n = noise2(ix, iz, seed) * amp
        out[idx] = h + n * w
      }
    }
    return out
  },
}

// 9) Sharpen: unsharp mask on heights. amount=strength in [0..1] (clamped).
//    h' = h + amount * (h - avg) blended by falloff.
const sharpen: Brush = {
  id: 'sharpen',
  label: 'Sharpen (unsharp mask)',
  apply: (a) => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out
    const { halfW, halfL, stepX, stepZ, r, r2, minX, maxX, minZ, maxZ } =
      computeAffectedBounds(a.gridW, a.gridL, a.widthWorld, a.lengthWorld, a.centerX, a.centerZ, a.radiusWorld)
    const amount = clamp(a.strength, 0, 1)
    if (amount <= 0) return out
    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ; const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX; const dx = x - a.centerX
        const d2 = dx * dx + dz * dz; if (d2 > r2) continue
        const t = 1 - Math.sqrt(d2) / r
        const w = smoothFalloff01(t)
        const idx = iz * a.gridW + ix
        const h = a.heights[idx]
        const { avg } = neighborMinMaxAvg(a.heights, a.gridW, a.gridL, ix, iz)
        const detail = h - avg
        out[idx] = h + detail * amount * w
      }
    }
    return out
  },
}

export default [blend, level, erode, dilate, fill, drain, terrace, noise, sharpen]
