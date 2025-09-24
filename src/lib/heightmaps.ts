// Heightmap loader + cache for brush plugins
// - Supports sources: url | asset (from /bar-editor-assets) | upload (from filesState) | ambientcg (API search)
// - Decodes PNG/JPG in-browser to Float32Array [0..1]
// - Caches by a stable key; async loading is kicked off by ensureHeightmap(...)
// - Synchronous brush apply() can poll getHeightmap(key) and no-op while loading

import { filesState } from '../state/files'
import type { UploadedEntry } from '../state/files'

export type HeightmapData = {
  width: number
  height: number
  data: Float32Array // normalized 0..1 grayscale
}

export type HeightmapSource =
  | { type: 'url'; url: string }
  | { type: 'asset'; assetId: string }            // id or path; looked up via manifest.json or used directly if it looks like a path
  | { type: 'upload'; uploadPath?: string }       // match filesState.uploadedFiles.path; if missing, first image is used
  | { type: 'ambientcg'; query: string }          // use ambientCG API to find a height/displacement map

/** Optional stamp entry discovered under /bar-editor-assets/stamps */
export type StampEntry = {
  id?: string
  label?: string
  path: string      // uploaded: original relative path in package; public: /bar-editor-assets/stamps/...
  url?: string      // resolved URL (blob: or absolute) for preview/loading
  isUploaded?: boolean // true if discovered from uploaded map files (filesState)
}

const cache = new Map<string, HeightmapData>()
const pending = new Map<string, Promise<HeightmapData>>()

export function keyFromSource(src: HeightmapSource): string {
  switch (src.type) {
    case 'url': return `url:${src.url}`
    case 'asset': return `asset:${src.assetId}`
    case 'upload': return `upload:${src.uploadPath || 'first'}`
    case 'ambientcg': return `ambientcg:${src.query}`
  }
}

export function getHeightmap(key: string): HeightmapData | undefined {
  return cache.get(key)
}

export function isLoading(key: string): boolean {
  return pending.has(key)
}

export function ensureHeightmap(src: HeightmapSource): void {
  const key = keyFromSource(src)
  if (cache.has(key) || pending.has(key)) return
  const p = resolveAndLoad(src)
    .then((hm) => {
      cache.set(key, hm)
      return hm
    })
    .finally(() => {
      pending.delete(key)
    })
  pending.set(key, p)
}

// -------------------------
// Source resolvers
// -------------------------

async function resolveAndLoad(src: HeightmapSource): Promise<HeightmapData> {
  if (src.type === 'url') {
    return loadImageToHeightmap(src.url)
  }
  if (src.type === 'asset') {
    const url = await resolveAssetUrl(src.assetId)
    return loadImageToHeightmap(url)
  }
  if (src.type === 'upload') {
    const url = resolveUploadUrl(src.uploadPath)
    if (!url) throw new Error('No uploaded image found for uploadPath=' + (src.uploadPath ?? 'first'))
    return loadImageToHeightmap(url)
  }
  if (src.type === 'ambientcg') {
    const url = await resolveAmbientCGUrl(src.query)
    return loadImageToHeightmap(url)
  }
  throw new Error('Unknown source')
}

// /public/bar-editor-assets/manifest.json structure:
// { "assets": [ { "id": "demo", "label": "Demo", "path": "/bar-editor-assets/demo.png" } ] }
type AssetManifest = { assets?: { id: string; label?: string; path: string }[] }

async function resolveAssetUrl(assetIdOrPath: string): Promise<string> {
  // If it looks like a direct path (has '/' or ends with an image extension), use it directly.
  if (/[\\/]/.test(assetIdOrPath) || /\.(png|jpg|jpeg|webp)$/i.test(assetIdOrPath)) {
    // Allow both with or without leading '/bar-editor-assets'
    if (assetIdOrPath.startsWith('http')) return assetIdOrPath
    if (assetIdOrPath.startsWith('/')) return assetIdOrPath
    return `/bar-editor-assets/${assetIdOrPath}`
  }
  // Otherwise, look up in manifest
  try {
    const res = await fetch('/bar-editor-assets/manifest.json', { cache: 'no-cache' })
    if (!res.ok) throw new Error('manifest fetch failed')
    const man = (await res.json()) as AssetManifest
    const match = (man.assets || []).find(a => a.id === assetIdOrPath)
    if (!match) throw new Error('asset id not found in manifest: ' + assetIdOrPath)
    return match.path
  } catch (e) {
    // Fallback to default path convention
    return `/bar-editor-assets/${assetIdOrPath}.png`
  }
}

function resolveUploadUrl(uploadPath?: string): string | null {
  // Prefer exact match by path
  if (uploadPath) {
    const found = filesState.uploadedFiles.find((f: UploadedEntry) => f.path === uploadPath || (f.url && f.url.includes(uploadPath)))
    if (found?.url) return found.url
  }
  // Else pick first image
  const first = filesState.uploadedFiles.find((f: UploadedEntry) => f.isImage && f.url)
  return first?.url || null
}

/**
 * List available stamp images from /bar-editor-assets/stamps.
 * Priority:
 *  1) /bar-editor-assets/stamps/index.json -> { stamps: [{ id, label, path }] }
 *  2) /bar-editor-assets/manifest.json assets filtered to stamps/
 * Returns entries with resolved absolute URLs.
 */
export async function listStamps(): Promise<StampEntry[]> {
  // 1) Try explicit index under stamps/
  try {
    const r = await fetch('/bar-editor-assets/stamps/index.json', { cache: 'no-cache' })
    if (r.ok) {
      const json: any = await r.json()
      const stamps = Array.isArray(json?.stamps) ? json.stamps : []
      return stamps
        .filter((s: any) => typeof s?.path === 'string' && s.path)
        .map((s: any) => {
          const path = String(s.path)
          const url = path.startsWith('/') ? path : `/bar-editor-assets/stamps/${path}`
          return { id: s.id, label: s.label, path: url, url }
        })
    }
  } catch {}
  // 2) Fallback to manifest.json assets filtered by path
  try {
    const r = await fetch('/bar-editor-assets/manifest.json', { cache: 'no-cache' })
    if (r.ok) {
      const man = await r.json()
      const assets: any[] = Array.isArray(man?.assets) ? man.assets : []
      const out: StampEntry[] = []
      for (const a of assets) {
        const p = String(a?.path || '')
        if (p.includes('/bar-editor-assets/stamps/') && /\.(png|jpe?g|webp)$/i.test(p)) {
          out.push({ id: a?.id, label: a?.label, path: p, url: p })
        }
      }
      return out
    }
  } catch {}
  return []
}

/**
 * Find stamps inside the uploaded map files (not public), e.g. .../bar-editor-assets/stamps/*.png
 * Scans filesState.uploadedFiles and returns entries with previewable URLs.
 */
export function listUploadedStamps(): StampEntry[] {
  const out: StampEntry[] = []
  try {
    const entries = Array.isArray(filesState.uploadedFiles) ? filesState.uploadedFiles : []
    for (const e of entries) {
      const p = String((e as any).path || '')
      const u = (e as any).url as string | undefined
      if (!p) continue
      // Match any case and either slash
      if (/(^|[\\/])bar-editor-assets[\\/]+stamps[\\/]+/i.test(p) && /\.(png|jpe?g|webp)$/i.test(p)) {
        const base = p.split(/[\\/]/).pop() || p
        const id = base.replace(/\.(png|jpe?g|webp)$/i, '')
        out.push({
          id,
          label: id,
          path: p,     // keep the original uploaded relative path
          url: u,      // blob: URL for preview
          isUploaded: true,
        })
      }
    }
  } catch {}
  return out
}

export function buildAmbientSearchUrl(query: string, limit = 50) {
  return `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(query)}&sort=popular&limit=${Math.max(1, Math.min(250, limit))}&include=previewData,labelData`
}
export function buildAmbientByIdUrl(assetId: string) {
  return `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(assetId)}&include=downloadData,previewData,mapData,labelData`
}

/** Resolve a single AmbientCG asset id to a direct height/displacement image when possible (fallback to preview). */
export async function resolveAmbientByIdToImage(assetId: string): Promise<string | undefined> {
  const byIdUrl = buildAmbientByIdUrl(assetId)
  const r = await fetch(byIdUrl)
  if (!r.ok) return undefined
  const j: any = await r.json()
  const items: any[] =
    Array.isArray(j) ? j :
    Array.isArray(j?.results) ? j.results :
    Array.isArray(j?.assets) ? j.assets :
    Array.isArray(j?.foundAssets) ? j.foundAssets :
    Object.values(j || {}).filter((v: any) => v && typeof v === 'object')

  const pickPreviewFromDict = (dict: any): string | undefined => {
    if (!dict || typeof dict !== 'object') return undefined
    const keys = [
      '2048-PNG','2048-JPG-FFFFFF','2048-JPG-242424',
      '1024-PNG','1024-JPG-FFFFFF','1024-JPG-242424',
      '512-PNG','512-JPG-FFFFFF','512-JPG-242424',
      '256-PNG','256-JPG-FFFFFF','256-JPG-242424',
      '128-PNG','128-JPG-FFFFFF','128-JPG-242424',
      '64-PNG','64-JPG-FFFFFF','64-JPG-242424'
    ]
    for (const k of keys) {
      const u = dict[k]
      if (typeof u === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(u)) return u
    }
    return undefined
  }

  for (const it of items) {
    const dl = Array.isArray(it?.downloadData) ? it.downloadData : Object.values(it?.downloadData || {})
    for (const e of dl) {
      const link = e?.rawLink || e?.downloadLink || e?.link || ''
      const name = (e?.fileName || e?.name || link || '').toLowerCase()
      const map = (e?.map || e?.type || '').toLowerCase()
      const isImg = /\.(png|jpg|jpeg|webp)$/i.test(link)
      const looksHeight = /height|displ|disp|heightmap|height-map/.test(name) || /height|displ/.test(map)
      if (isImg && looksHeight) return link
    }
    const prevUrl = pickPreviewFromDict(it?.previewImage || it?.previewData)
    if (prevUrl) return prevUrl
  }
  return undefined
}

async function resolveAmbientCGUrl(query: string): Promise<string> {
  // API docs: https://ambientcg.com/api/v2/full_json
  // Strategy:
  // 1) Perform a broad search by query (q=...) and parse foundAssets (v2 format).
  // 2) For the first few assets, fetch by id with include=downloadData to get direct height/displacement images.
  // 3) Fallback to previewImage if no height/displacement map is exposed.
  const searchUrl = buildAmbientSearchUrl(query, 50)
  const res = await fetch(searchUrl)
  if (!res.ok) throw new Error(`ambientCG search error: ${res.status}`)
  const root: any = await res.json()

  const found: any[] = Array.isArray(root?.foundAssets) ? root.foundAssets : []
  // Helper: choose best preview URL from previewImage dict
  const pickPreviewFromDict = (dict: any): string | undefined => {
    if (!dict || typeof dict !== 'object') return undefined
    const keys = [
      '2048-PNG','2048-JPG-FFFFFF','2048-JPG-242424',
      '1024-PNG','1024-JPG-FFFFFF','1024-JPG-242424',
      '512-PNG','512-JPG-FFFFFF','512-JPG-242424',
      '256-PNG','256-JPG-FFFFFF','256-JPG-242424',
      '128-PNG','128-JPG-FFFFFF','128-JPG-242424',
      '64-PNG','64-JPG-FFFFFF','64-JPG-242424'
    ]
    for (const k of keys) {
      const u = dict[k]
      if (typeof u === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(u)) return u
    }
    return undefined
  }

  // Probe first few assets more deeply for download links
  const probeCount = Math.min(8, found.length || 0)
  for (let i = 0; i < probeCount; i++) {
    const fa = found[i]
    const assetId = String(fa?.assetId || '')
    if (!assetId) continue
    const byIdUrl = buildAmbientByIdUrl(assetId)
    try {
      const r = await fetch(byIdUrl)
      if (!r.ok) continue
      const j: any = await r.json()
      const items: any[] =
        Array.isArray(j) ? j :
        Array.isArray(j?.results) ? j.results :
        Array.isArray(j?.assets) ? j.assets :
        Array.isArray(j?.foundAssets) ? j.foundAssets :
        Object.values(j || {}).filter((v: any) => v && typeof v === 'object')

      for (const it of items) {
        const dl = Array.isArray(it?.downloadData) ? it.downloadData : Object.values(it?.downloadData || {})
        const candidates: string[] = []
        for (const e of dl) {
          const link = e?.rawLink || e?.downloadLink || e?.link || ''
          const name = (e?.fileName || e?.name || link || '').toLowerCase()
          const map = (e?.map || e?.type || '').toLowerCase()
          const isImg = /\.(png|jpg|jpeg|webp)$/i.test(link)
          const looksHeight = /height|displ|disp|heightmap|height-map/.test(name) || /height|displ/.test(map)
          if (isImg && looksHeight) candidates.push(link)
        }
        if (candidates.length) return candidates[0]
        // Fallback to preview image if present
        const prevUrl = pickPreviewFromDict(it?.previewImage || it?.previewData)
        if (prevUrl) return prevUrl
      }
    } catch {
      // ignore asset fetch errors and continue
    }
  }

  // If nothing found via by-id, fallback to first preview from the search itself
  for (const fa of found) {
    const prevUrl = pickPreviewFromDict(fa?.previewImage)
    if (prevUrl) return prevUrl
  }
  throw new Error('ambientCG: no suitable image found for query=' + query)
}

// -------------------------
// Image decode
// -------------------------

function needsCrossOrigin(u: string): boolean {
  try {
    const url = new URL(u, window.location.href)
    return url.origin !== window.location.origin && !u.startsWith('blob:')
  } catch {
    return false
  }
}

async function loadImageToHeightmap(src: string): Promise<HeightmapData> {
  const img = await loadHTMLImage(src)
  const { width, height } = img
  // Use OffscreenCanvas when available, fallback to regular canvas
  const useOffscreen = typeof (window as any).OffscreenCanvas === 'function'
  if (useOffscreen) {
    const canvas = new (window as any).OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    ctx.drawImage(img, 0, 0, width, height)
    const imgData = ctx.getImageData(0, 0, width, height)
    return imageDataToHeightmap(imgData)
  } else {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(img, 0, 0, width, height)
    const imgData = ctx.getImageData(0, 0, width, height)
    return imageDataToHeightmap(imgData)
  }
}

function loadHTMLImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (needsCrossOrigin(src)) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(new Error('Image load error: ' + src))
    img.decoding = 'async'
    img.src = src
  })
}

function imageDataToHeightmap(img: ImageData): HeightmapData {
  const { width, height, data } = img
  const out = new Float32Array(width * height)
  // Luminance conversion. Prefer single-channel if present (rare in canvas), else standard luma.
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    // standard luma (Rec. 601)
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    out[j] = Math.min(1, Math.max(0, y))
  }
  return { width, height, data: out }
}

// -------------------------
// Sampling helpers
// -------------------------

export type TileMode = 'clamp' | 'repeat'

export function sampleBilinear(hm: HeightmapData, u: number, v: number, tiling: TileMode = 'clamp'): number {
  // u,v in [0,1] ideally; apply tiling then sample
  let x = u * (hm.width - 1)
  let y = v * (hm.height - 1)

  if (tiling === 'repeat') {
    x = wrapRepeat(x, hm.width - 1)
    y = wrapRepeat(y, hm.height - 1)
  } else {
    x = clamp(x, 0, hm.width - 1)
    y = clamp(y, 0, hm.height - 1)
  }

  const x0 = Math.floor(x)
  const x1 = Math.min(hm.width - 1, x0 + 1)
  const y0 = Math.floor(y)
  const y1 = Math.min(hm.height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0

  const i00 = y0 * hm.width + x0
  const i10 = y0 * hm.width + x1
  const i01 = y1 * hm.width + x0
  const i11 = y1 * hm.width + x1

  const a = lerp(hm.data[i00], hm.data[i10], tx)
  const b = lerp(hm.data[i01], hm.data[i11], tx)
  return lerp(a, b, ty)
}

function wrapRepeat(x: number, max: number): number {
  // Wrap x into [0,max]
  const m = max > 0 ? max : 1
  const t = x % m
  return t < 0 ? t + m : t
}

function lerp(a: number, b: number, t: number) { return a * (1 - t) + b * t }
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)) }

/** AmbientCG search result for UI display. */
export type AmbientSearchResult = {
  id: string
  title: string
  previewUrl: string
  heightUrl?: string
}

/**
 * Search ambientCG Terrain assets and return a list of candidates with preview + height/displacement image if available.
 * This is intended for showing a popup UI of results.
 */
export async function searchAmbientCG(query: string, limit = 24): Promise<AmbientSearchResult[]> {
  // Use query-only search which returns foundAssets with previewImage dict
  const url = buildAmbientSearchUrl(query, Math.max(1, Math.min(250, limit)))
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ambientCG API error: ${res.status}`)
  const json: any = await res.json()

  const found: any[] =
    Array.isArray(json?.foundAssets) ? json.foundAssets :
    Array.isArray(json?.results) ? json.results :
    Array.isArray(json?.assets) ? json.assets :
    []

  const pickPreviewFromDict = (dict: any): string | undefined => {
    if (!dict || typeof dict !== 'object') return undefined
    const keys = [
      '2048-PNG','2048-JPG-FFFFFF','2048-JPG-242424',
      '1024-PNG','1024-JPG-FFFFFF','1024-JPG-242424',
      '512-PNG','512-JPG-FFFFFF','512-JPG-242424',
      '256-PNG','256-JPG-FFFFFF','256-JPG-242424',
      '128-PNG','128-JPG-FFFFFF','128-JPG-242424',
      '64-PNG','64-JPG-FFFFFF','64-JPG-242424'
    ]
    for (const k of keys) {
      const u = dict[k]
      if (typeof u === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(u)) return u
    }
    return undefined
  }

  const out: AmbientSearchResult[] = []
  for (const item of found) {
    const id = String(item?.assetId || item?.id || '')
    const title = String(item?.displayName || id || 'asset')
    const previewUrl = pickPreviewFromDict(item?.previewImage) || ''
    // Height URL requires a second fetch by id; the popup will still be useful with preview only.
    out.push({ id, title, previewUrl, heightUrl: undefined })
  }
  return out
}
