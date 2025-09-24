import { applyAddRemove, applySmooth } from '../terrain-edit'
import flattenPlugin from '../../plugins/brushes/flatten'
import terrainPack from '../../plugins/brushes/terrain-pack'
import shapeVariants from '../../plugins/brushes/shape-variants'
import heightmapStamp from '../../plugins/brushes/heightmap-stamp'

// Brush plugin system for heightmap editing (VoxelSniper-inspired)
// - Each brush is a module implementing Brush, registered with the BrushRegistry
// - Built-ins: raise, lower, smooth
// - External plugins auto-loaded from src/plugins/brushes/**/*.{ts,js}
// - Viewports call brush.apply(...) with world-space center and brush params

export type BrushId = string

export interface BrushApplyArgs {
  // Current terrain
  heights: Float32Array
  gridW: number
  gridL: number
  widthWorld: number
  lengthWorld: number

  // Brush placement
  centerX: number
  centerZ: number
  radiusWorld: number

  // Brush strength semantics depend on brush:
  //  - raise/lower: world-units delta magnitude
  //  - smooth: blend factor [0..1]
  //  - custom plugins: free to interpret (document in brush.label/docs)
  strength: number

  // Optional additional context (e.g., flatten target elevation under cursor)
  hitY?: number

  // Optional free-form parameters specific to each brush
  // Values are validated/interpreted by the brush itself
  params?: Record<string, any>

  // Optional mode string for brushes that support multiple sub-modes
  // (kept for backward-compat; prefer separate brushes instead)
  mode?: string
}

/** Declarative parameter definitions for dynamic UI generation. */
export type BrushParamDef =
  | {
      key: string
      label: string
      type: 'number'
      default: number
      min?: number
      max?: number
      step?: number
      unit?: string
    }
  | {
      key: string
      label: string
      type: 'boolean'
      default: boolean
    }
  | {
      key: string
      label: string
      type: 'select'
      default: string
      options: { label: string; value: string }[]
    }
  | {
      key: string
      label: string
      type: 'text'
      default: string
      placeholder?: string
    }

export interface Brush {
  id: BrushId
  label: string
  /** Optional param schema to drive adaptive HUD controls */
  params?: BrushParamDef[]
  // Must return a NEW Float32Array so upstream watchers see a reference change
  apply(args: BrushApplyArgs): Float32Array
}

export class BrushRegistry {
  private brushes = new Map<BrushId, Brush>()

  register(brush: Brush): void {
    if (this.brushes.has(brush.id)) {
      console.warn(`BrushRegistry: brush already registered: ${brush.id}, overriding.`)
    }
    this.brushes.set(brush.id, brush)
  }

  get(id: BrushId): Brush | undefined {
    return this.brushes.get(id)
  }

  list(): Brush[] {
    return Array.from(this.brushes.values())
  }
}

export const brushRegistry = new BrushRegistry()

// ----------------------
// Built-in brushes
// ----------------------

const raiseBrush: Brush = {
  id: 'raise',
  label: 'Raise (add/remove wrapper +)',
  apply: (a) => {
    const delta = Math.abs(a.strength)
    return applyAddRemove(
      a.heights,
      a.gridW, a.gridL,
      a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ,
      a.radiusWorld,
      +delta
    )
  },
}

const lowerBrush: Brush = {
  id: 'lower',
  label: 'Lower (add/remove wrapper -)',
  apply: (a) => {
    const delta = Math.abs(a.strength)
    return applyAddRemove(
      a.heights,
      a.gridW, a.gridL,
      a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ,
      a.radiusWorld,
      -delta
    )
  },
}

const smoothBrush: Brush = {
  id: 'smooth',
  label: 'Smooth (neighbor average blend)',
  apply: (a) => {
    const s = Math.max(0, Math.min(1, a.strength))
    return applySmooth(
      a.heights,
      a.gridW, a.gridL,
      a.widthWorld, a.lengthWorld,
      a.centerX, a.centerZ,
      a.radiusWorld,
      s
    )
  },
}

// Register built-ins
brushRegistry.register(raiseBrush)
brushRegistry.register(lowerBrush)
brushRegistry.register(smoothBrush)

// Explicit fallback registration for core plugin pack (works even if glob is pruned by tooling)
try {
  registerFromUnknown(flattenPlugin as unknown)
} catch {}
try {
  registerFromUnknown(terrainPack as unknown)
} catch {}
try {
  registerFromUnknown(shapeVariants as unknown)
} catch {}
try {
  registerFromUnknown(heightmapStamp as unknown)
} catch {}

// ----------------------
// External plugin auto-loader (Vite import.meta.glob)
// ----------------------
// Any file under src/plugins/brushes/**/*.{ts,js} can export either:
//   - default Brush
//   - default Brush[]
//   - { default?: Brush | Brush[]; register?: (reg: BrushRegistry) => void }
// Example:
//   export default { id: 'flatten', label: 'Flatten', apply: (args) => { /*...*/ } }
// or
//   export default [ brushA, brushB ]
// or
//   export function register(reg) { reg.register(myBrush) }
//
type MaybeModule = {
  default?: unknown
  register?: (reg: BrushRegistry) => void
}

function registerFromUnknown(val: unknown) {
  if (!val) return
  if (typeof (val as any).apply === 'function' && typeof (val as any).id === 'string') {
    brushRegistry.register(val as Brush)
    return
  }
  if (Array.isArray(val)) {
    for (const b of val) {
      if (b && typeof (b as any).apply === 'function' && typeof (b as any).id === 'string') {
        brushRegistry.register(b as Brush)
      }
    }
    return
  }
  if (typeof val === 'object') {
    const maybe = val as MaybeModule
    if (typeof maybe.register === 'function') {
      try { maybe.register(brushRegistry) } catch (e) {
        console.warn('Brush plugin register() failed:', e)
      }
    } else if (maybe.default) {
      registerFromUnknown(maybe.default as unknown)
    }
  }
}

try {
  // Prefer Vite glob if available; fall back gracefully in non-Vite contexts.
  const modulesAny =
    (import.meta as any).glob?.('../../plugins/brushes/**/*.{ts,js}', { eager: true }) ||
    (import.meta as any).glob?.('/src/plugins/brushes/**/*.{ts,js}', { eager: true }) ||
    (import.meta as any).glob?.('../**/plugins/brushes/**/*.{ts,js}', { eager: true }) ||
    {}

  const modules = modulesAny as Record<string, MaybeModule>

  for (const modPath in modules) {
    const mod = modules[modPath]
    if (!mod) continue
    if (typeof mod.register === 'function') {
      try { mod.register(brushRegistry) } catch (e) { console.warn('Brush plugin register() error:', modPath, e) }
    }
    if ((mod as any).default) {
      registerFromUnknown((mod as any).default as unknown)
    }
  }
} catch (e) {
  // Glob not available; explicit fallback registration above ensures core plugins are present.
}
