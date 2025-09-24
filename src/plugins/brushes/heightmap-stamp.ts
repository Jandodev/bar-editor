import type { Brush, BrushApplyArgs, BrushParamDef } from '../../lib/brushes'
import { ensureHeightmap, getHeightmap, keyFromSource, sampleBilinear, type TileMode } from '../../lib/heightmaps'

function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)) }
function smoothFalloff01(t: number, power = 2): number {
  const x = clamp(t, 0, 1)
  const s = x * x * (3 - 2 * x)
  const p = Math.max(0.01, Number(power) || 2)
  return Math.pow(s, p)
}

type SourceType = 'url' | 'asset' | 'upload' | 'ambientcg'

const params: BrushParamDef[] = [
  { key: 'sourceType', label: 'Source', type: 'select', default: 'url', options: [
    { label: 'URL', value: 'url' },
    { label: 'Asset (bar-editor-assets)', value: 'asset' },
    { label: 'Uploaded', value: 'upload' },
    { label: 'ambientCG Search', value: 'ambientcg' },
  ]},
  { key: 'url', label: 'Image URL', type: 'text', default: '', placeholder: 'https://example.com/height.png' },
  { key: 'assetId', label: 'Asset ID/Path', type: 'text', default: '', placeholder: 'myStamp or myfolder/myStamp.png' },
  { key: 'uploadPath', label: 'Uploaded Path', type: 'text', default: '', placeholder: '(optional) match uploaded path' },
  { key: 'ambientQuery', label: 'ambientCG Query', type: 'text', default: 'terrain', placeholder: 'e.g., dunes, canyon, mountain' },

  { key: 'heightScale', label: 'Height Scale (m)', type: 'number', default: 20, min: -10000, max: 10000, step: 1 },
  { key: 'falloffPower', label: 'Falloff Power', type: 'number', default: 2, min: 0.25, max: 8, step: 0.25 },
  { key: 'rotationDeg', label: 'Rotation (deg)', type: 'number', default: 0, min: -180, max: 180, step: 15 },
  { key: 'uvScale', label: 'UV Scale', type: 'number', default: 1, min: 0.1, max: 16, step: 0.1 },
  { key: 'tiling', label: 'Tiling', type: 'select', default: 'clamp', options: [
    { label: 'Clamp', value: 'clamp' },
    { label: 'Repeat', value: 'repeat' },
  ]},
  { key: 'centered', label: 'Centered (-0.5..+0.5)', type: 'boolean', default: false },
  { key: 'useFalloff', label: 'Use Radial Falloff', type: 'boolean', default: true },
]

function pickSourceKeyAndEnsure(params: Record<string, any>) {
  const sourceType: SourceType = String(params?.sourceType || 'url') as any
  if (sourceType === 'url') {
    const url = String(params?.url || '')
    if (url) {
      const src = { type: 'url' as const, url }
      ensureHeightmap(src)
      return keyFromSource(src)
    }
  } else if (sourceType === 'asset') {
    const assetId = String(params?.assetId || '')
    if (assetId) {
      const src = { type: 'asset' as const, assetId }
      ensureHeightmap(src)
      return keyFromSource(src)
    }
  } else if (sourceType === 'upload') {
    const uploadPath = String(params?.uploadPath || '')
    const src = { type: 'upload' as const, uploadPath: uploadPath || undefined }
    ensureHeightmap(src)
    return keyFromSource(src)
  } else if (sourceType === 'ambientcg') {
    const query = String(params?.ambientQuery || 'terrain')
    const src = { type: 'ambientcg' as const, query }
    ensureHeightmap(src)
    return keyFromSource(src)
  }
  return null
}

/**
 * Heightmap Stamp: samples a grayscale image as a height stamp and applies it within brush radius.
 * - UV mapping: the image unit square (0..1) spans the full brush diameter by default (uvScale=1).
 *               Increase uvScale to zoom the image (tiles if tiling=repeat).
 * - Strength (HUD): treated as a blend factor [0..1] controlling the stamp's intensity.
 * - heightScale: amplitude in world meters applied at center before falloff and strength.
 */
const heightmapStamp: Brush = {
  id: 'heightmap-stamp',
  label: 'Heightmap Stamp',
  params,
  apply: (a: BrushApplyArgs): Float32Array => {
    const out = new Float32Array(a.heights)
    if (!(a.gridW > 1 && a.gridL > 1)) return out

    const key = pickSourceKeyAndEnsure((a.params as any) || {})
    if (!key) {
      // No source yet; return unchanged
      return out
    }
    const hm = getHeightmap(key)
    if (!hm) {
      // Still loading; return unchanged (UI/preview can re-apply when cache fills)
      return out
    }

    const useFalloff = !!((a.params as any)?.useFalloff ?? true)
    const falloffPower = Number((a.params as any)?.falloffPower ?? 2)
    const heightScale = Number((a.params as any)?.heightScale ?? 20)
    const centered = !!((a.params as any)?.centered ?? false)
    const rotationDeg = Number((a.params as any)?.rotationDeg ?? 0)
    const tiling = (String((a.params as any)?.tiling || 'clamp') as TileMode)
    const uvScale = Math.max(0.0001, Number((a.params as any)?.uvScale ?? 1))

    const r = Math.max(1e-6, a.radiusWorld)
    const s = clamp(a.strength, 0, 1)

    const halfW = a.widthWorld * 0.5
    const halfL = a.lengthWorld * 0.5
    const stepX = a.widthWorld / (a.gridW - 1)
    const stepZ = a.lengthWorld / (a.gridL - 1)

    const minX = clamp(Math.floor((a.centerX - r + halfW) / stepX), 0, a.gridW - 1)
    const maxX = clamp(Math.ceil((a.centerX + r + halfW) / stepX), 0, a.gridW - 1)
    const minZ = clamp(Math.floor((a.centerZ - r + halfL) / stepZ), 0, a.gridL - 1)
    const maxZ = clamp(Math.ceil((a.centerZ + r + halfL) / stepZ), 0, a.gridL - 1)

    const ang = (rotationDeg * Math.PI) / 180
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)

    for (let iz = minZ; iz <= maxZ; iz++) {
      const z = -halfL + iz * stepZ
      const dz = z - a.centerZ
      for (let ix = minX; ix <= maxX; ix++) {
        const x = -halfW + ix * stepX
        const dx = x - a.centerX

        const d2 = dx * dx + dz * dz
        if (d2 > r * r) continue

        // Rotate local coords around center
        const xr = dx * cos - dz * sin
        const zr = dx * sin + dz * cos

        // Map to UV. Without scaling: -r..+r maps to 0..1
        // Apply uvScale multiplier (zoom): >1 zooms in (more tiling/less image coverage)
        const u = 0.5 + (xr / (2 * r)) * uvScale
        const v = 0.5 + (zr / (2 * r)) * uvScale

        const hNorm = sampleBilinear(hm, u, v, tiling)
        const stamp = centered ? (hNorm - 0.5) : hNorm

        const idx = iz * a.gridW + ix
        const fall = useFalloff ? smoothFalloff01(1 - Math.sqrt(d2) / r, falloffPower) : 1
        const delta = stamp * heightScale * s * fall
        out[idx] = out[idx] + delta
      }
    }

    return out
  },
}

export default heightmapStamp
