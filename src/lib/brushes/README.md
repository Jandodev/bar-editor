# Brush Plugin System (VoxelSniper-inspired)

This subsystem provides a modular, plugin-friendly way to add new editing brushes for the heightmap-based terrain editor. Each brush is its own module and is auto-discovered at build time. Viewports call into the BrushRegistry by brush id, passing world-space placement and parameters. The brush returns a new Float32Array of heights.

Highlights:
- Simple Brush interface with a focused apply() contract
- Built-in brushes: raise, lower, smooth
- Auto-load any custom brushes under src/plugins/brushes
- Backward compatible with existing edit modes ('add' -> raise, 'remove' -> lower)
- Example plugins provided: Flatten + Terrain Pack (Blend, Level, Erode, Dilate, Fill, Drain, Terrace, Noise, Sharpen)
- Shape variants: Raise/Lower with square footprint

## Files
- src/lib/brushes/index.ts — Core types, registry, built-in brushes, and auto-loader.
- src/plugins/brushes/flatten.ts — Example brush plugin.
- src/plugins/brushes/terrain-pack.ts — Multiple VoxelSniper-style terrain brushes.
- src/plugins/brushes/shape-variants.ts — Square footprint variants for raise/lower.

## Brush Interface

```ts
export interface BrushApplyArgs {
  // Current terrain
  heights: Float32Array
  gridW: number
  gridL: number
  widthWorld: number
  lengthWorld: number

  // Brush placement (world-space)
  centerX: number
  centerZ: number
  radiusWorld: number

  // Strength semantics are brush defined:
  //  - raise/lower: world units of delta
  //  - smooth: blend factor [0..1]
  //  - custom: define and document
  strength: number

  // Optional extras
  hitY?: number   // Y at mouse hit (viewport provides this)
  mode?: string   // Sub-mode if needed (prefer separate ids)
}

export interface Brush {
  id: string
  label: string
  // MUST return a NEW Float32Array so reactivity/observers see a change
  apply(args: BrushApplyArgs): Float32Array
}
```

## Registry and Auto-loading

The registry registers built-ins and then auto-loads plugins from `src/plugins/brushes/**/*.{ts,js}` via Vite `import.meta.glob` (with a safe any-cast for TS). Any module in that folder can export one of:
- `export default Brush`
- `export default Brush[]`
- `export function register(reg: BrushRegistry)`

Example:
```ts
// src/plugins/brushes/my-brush.ts
import type { Brush } from '../../lib/brushes'

const myBrush: Brush = {
  id: 'my-brush',
  label: 'My Custom Brush',
  apply: (a) => {
    // ... compute and return new Float32Array based on a.heights ...
    return new Float32Array(a.heights)
  },
}

export default myBrush
```

Alternatively:
```ts
import type { Brush, BrushRegistry } from '../../lib/brushes'
export function register(reg: BrushRegistry) {
  reg.register({
    id: 'foo',
    label: 'Foo Brush',
    apply: (a) => new Float32Array(a.heights),
  })
}
```

Auto-loading runs as soon as anything imports `brushRegistry` from `src/lib/brushes`. The viewports import the registry, so plugins are discovered automatically on app load in dev/prod.

## Built-in Brushes

- raise — Raises terrain (positive delta). Strength = world units per stroke sample.
- lower — Lowers terrain (negative delta). Strength = world units per stroke sample.
- smooth — Blends toward neighbor average. Strength in [0..1] as blend factor.

These map from the existing modes for backward compatibility:
- 'add' -> 'raise'
- 'remove' -> 'lower'
- 'smooth' -> 'smooth'

## Additional Brushes (VoxelSniper-style)

From `src/plugins/brushes/`:

- flatten — Move heights within radius toward target elevation (from hitY or nearest vertex). Strength in [0..1] as blend factor.
- blend — Two-pass smooth approximating a Gaussian-like blur. Strength in [0..1] is per-pass blend factor.
- level — Level toward target elevation (like flatten; strength=1 gives a hard set). Strength in [0..1].
- erode — Reduce peaks by moving toward local min. Strength in [0..1].
- dilate — Fill pits by moving toward local max. Strength in [0..1].
- fill — Raise up toward target elevation, never lower. Strength in [0..1].
- drain — Lower down toward target elevation, never raise. Strength in [0..1].
- terrace — Quantize heights to steps of size = strength (world units). If strength<=0 defaults to 8.0. Blends by falloff.
- noise — Add band-limited noise. Strength = amplitude in world units.
- sharpen — Unsharp mask on heights. Strength in [0..1] = amount.
- raise-square — Raise using a square (Chebyshev) footprint with smooth falloff.
- lower-square — Lower using a square (Chebyshev) footprint with smooth falloff.

Notes:
- All brushes respect world-space radius and use a smooth cubic falloff from center to edge (unless otherwise stated).
- All return a new Float32Array, touching only the affected sub-rectangle for performance.

## Selecting a Brush

Two main ways:

1) Through the view components (if using props directly):
- `ThreeViewport.vue` and `OrthoViewport.vue` accept:
  - `editEnabled?: boolean`
  - `editMode?: string`       // e.g. 'raise', 'lower', 'smooth', 'flatten', 'erode', ...
  - `editRadius?: number`
  - `editStrength?: number`
  - `editPreview?: boolean`

2) Through the ResourceBus (recommended for editor tools/panels):
Publish to the 'edit' key:
```ts
bus.publish({
  edit: {
    enabled: true,
    mode: 'terrace',      // any registered brush id
    radius: 64,
    strength: 8,          // brush-specific semantics (here: step size in world units)
    preview: true
  }
})
```

`ViewportFromBus.vue` listens for 'edit' and passes the values to the active viewport. Both viewports look up the brush by id in the registry and call `apply()` with world-space center and parameters for each stroke sample.

## Performance Considerations

- Brushes update only the affected sub-rectangle to avoid O(W*L) work on each stroke.
- Always return a new Float32Array (copy and modify is fine), so reactivity triggers.
- Avoid allocating large temporary arrays in inner loops.
- For heavy effects (e.g., smoothing), consider multi-pass with small per-pass blend to maintain responsiveness.

## Extending Beyond Heightmaps

The core pipeline operates on the heightmap. If you need to modify other data (overlay, splats), options:
- Extend `BrushApplyArgs` in the future with optional fields.
- Coordinate side-effects via ResourceBus outside the brush to keep brushes pure (input -> output heights).

## Type Imports

Plugin authors can import types from the registry module:
```ts
import type { Brush, BrushApplyArgs, BrushRegistry } from '../../lib/brushes'
```

## Troubleshooting

- If TS complains about `import.meta.glob`, note we access it via `(import.meta as any).glob?.(...)` to compile in non-Vite contexts. In Vite, it will resolve and eagerly import your plugin modules.
- Ensure your plugin file lives under `src/plugins/brushes/` so it is auto-discovered.
- Brush `id` must be unique. If a duplicate id is registered, the later one overrides and a warning is logged.
