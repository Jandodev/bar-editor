# BAR Web Map Editor (SPA) — Project Plan & Tracking

Lightweight, single‑page, componentized web app to ingest, visualize, edit, and re‑export Beyond All Reason / Spring RTS maps in the browser using Three.js + WebGL.

This document tracks top‑level goals, milestones, architecture decisions, and status. Treat it as the living source of truth for scope and progress.

---

## Vision

- Users upload an existing Spring map package (sd7/sdz/zip or folder).
- The app indexes files into an in‑browser Virtual File System (VFS).
- We parse `mapinfo.lua` and other map files to discover referenced assets (SMF, SMT, textures, minimap, metal map, features).
- We render the map in a Three.js viewport with switchable layers.
- MVP editing: replace specific assets (textures, minimap, etc.) or add new ones.
- Export a valid map package with updated contents.

SPA requirement: One-page app with componentized UI so information is indexable and maintainable.

---

## Product Goals (top level)

- [ ] Accurate ingestion of Spring map structures (start with .sdz/.zip, then .sd7/7z via WASM)
- [ ] Virtual File System (VFS) abstraction for complete in‑browser map indexing
- [ ] Parse mapinfo.lua to resolve asset graph (SMF/SMT, textures, minimap, metal map, features)
- [ ] Real-time 3D visualization of terrain and layers using Three.js
- [ ] Lightweight editing workflows for replacing assets and regenerating derived data (e.g., minimap)
- [ ] Re-export to a valid Spring map package with updated contents
- [ ] Component-driven SPA architecture with clear separation of concerns
- [ ] Performance targets that handle large maps without UI jank (web workers, streaming, tiling)
- [ ] Automated validation against example maps

---

## Milestones and Checklists

M0 — Project & Architecture Setup
- [ ] Define component skeleton and folder structure
- [ ] Establish state management (Pinia) and strict TypeScript config
- [ ] Decide on worker setup (Vite workers) and binary parsing utilities
- [ ] Basic error/reporting/log panel

M1 — Ingestion & VFS
- [ ] Accept archive inputs: .sdz/.zip (phase 1), .sd7/7z (phase 2 via wasm)
- [ ] Implement VFS with path normalization and indexed lookups
- [ ] Map root detection, mapinfo.lua discovery
- [ ] Lua parsing pipeline to JSON and schema validation
- [ ] Asset graph build: resolve all referenced resources

M2 — Map Format Parsing
- [ ] SMF parser (geometry, heightmap, tiles mapping)
- [ ] SMT tiles and texture material handling
- [ ] Extract/visualize metal map
- [ ] Minimap extraction
- [ ] (Optional) feature placement data

M3 — Visualization
- [ ] Terrain mesh generation from heightmap with LOD strategy
- [ ] Materials/shaders for diffuse/splat layers
- [ ] Camera controls (orbit, pan, zoom)
- [ ] Toggleable layer views (height, diffuse, metal, wireframe)

M4 — Editor MVP
- [ ] Replace texture/minimap assets via upload
- [ ] Live scene updates from VFS changes
- [ ] Validation of asset dimensions/format
- [ ] Export updated archive

M5 — UX & Persistence
- [ ] Undo/redo for asset replacements
- [ ] Session autosave to IndexedDB
- [ ] Robust error handling with actionable messages

M6 — Validation & Examples
- [ ] Test with sample maps (MAP_EXAMPLES_NOCOMMIT)
- [ ] Sanity checks: re‑exported package loads in Spring/BAR
- [ ] Performance profiling on large maps

---

## Current Repo Context

- Active app: `SMF_format_editor` (Vite + Vue + TS)
- Existing code of interest:
  - `src/lib/archive.ts` — archive handling
  - `src/lib/mapinfo.ts` — map info handling
  - `src/lib/smf.ts` — SMF parsing
  - `src/components/ThreeViewport.vue` — Three.js viewport
  - `src/debug/lua-debug.ts`, `lua-debug.html` — Lua parsing debug
- We will refactor into a more componentized and modular structure (see below).

---

## Architecture Overview

Tech Stack
- Vite + Vue 3 + TypeScript (SPA)
- Three.js for rendering
- Pinia for app state (lightweight and type-safe)
- Web Workers for heavy/binary parsing (SMF/SMT) to keep UI responsive
- Lua parser (existing)
- Archive handling:
  - Phase 1: zip/sdz (e.g., JSZip or existing custom)
  - Phase 2: 7z/sd7 via wasm-7z (or libarchive wasm)

High-Level Data Flow
1. Upload archive/folder → Archive Reader → VFS (indexed)
2. VFS → find `mapinfo.lua` → Lua parser → JSON config
3. Resolve asset graph (SMF/SMT/texture/minimap/metal map)
4. Parse SMF/SMT in a worker → build terrain + materials
5. Store normalized state in Pinia → components subscribe
6. Editor actions update VFS → re-render → export from VFS

---

## Planned Directory Structure (refactor target)

```
SMF_format_editor/src/
  modules/
    vfs/
      Vfs.ts                # In-memory virtual filesystem + index
      ArchiveReader.ts      # Wraps archive.ts, normalizes paths
      Exporter.ts           # Packs VFS → .sdz/.sd7 (phase 2)
    parsers/
      lua/
        LuaParser.ts        # Wrap existing lua parser
      smf.ts                # SMF parsing (worker-coop)
      smt.ts                # SMT tiles parse/stream
      mapinfo.ts            # Map info normalization/schema
    workers/
      smf.worker.ts         # Heavy parsing off main thread
    state/
      store.ts              # Pinia stores (VFS, map, scene)
      types.ts              # Shared types/interfaces
    viewers/
      terrain/
        buildTerrain.ts     # Mesh + materials from parsed data
      layers/
        metalLayer.ts
        minimapLayer.ts
  components/
    app/
      AppShell.vue
      Toolbar.vue
      StatusBar.vue
      LogConsole.vue
    panels/
      FileUploadPanel.vue
      FilesystemExplorer.vue
      ResourceInspector.vue
      PropertiesPanel.vue
    viewport/
      ThreeViewport.vue     # already exists (move/keep)
    modals/
      ReplaceAssetModal.vue
  debug/
    lua/
      lua-debug.ts
  lib/
    archive.ts              # migrate into modules/vfs as needed
    mapinfo.ts              # migrate into modules/parsers/mapinfo.ts
    smf.ts                  # migrate into modules/parsers/smf.ts
```

---

## Key Components (SPA)

- AppShell: layout, global toolbars, status, log console
- FileUploadPanel: drag & drop archives/folders, input validation
- FilesystemExplorer: tree/index of VFS contents
- ResourceInspector: contextual details for selected file/asset
- PropertiesPanel: map metadata, dimensions, tiling, shader options
- ThreeViewport: renders terrain + layers with controls
- ReplaceAssetModal: upload/validate/preview/commit replacement
- LogConsole: user-facing logs, warnings, parse errors

---

## Data Models (initial)

- VfsFile
  - path: string (normalized /)
  - size: number
  - type: 'file' | 'dir'
  - mime?: string
  - data?: ArrayBuffer | Blob | string (lazy-loaded/streaming)

- MapIndex
  - mapinfo: MapInfoNormalized
  - smf: { path: string; meta: SmfMeta }
  - smt?: { path: string }
  - minimap?: { path: string }
  - metal?: { path: string }
  - textures: Record<string, { path: string; kind: 'diffuse'|'splat'|'normal'|... }>

- SceneState
  - camera: { position, target }
  - layerVisibility: { height: boolean; diffuse: boolean; metal: boolean; wireframe: boolean }
  - materialSettings: { splatBlend, scale, gamma }

---

## Dependencies (planned)

Phase 1
- three
- pinia
- Use TypeScript types and lightweight manual guards (no external schema lib)
- JSZip (if needed) or continue using existing `archive.ts` approach
- Comlink (optional) for worker RPC ergonomics

Phase 2
- wasm-7z (or libarchive wasm) for .sd7 support
- draco/meshopt (optional) if we compress scene assets

---

## Definition of Done per Milestone

M1 (Ingestion)
- VFS can list, read, and index all files in uploaded archive
- mapinfo.lua parsed to JSON with validated fields
- Asset graph built with resolved paths and missing-asset warnings

M2 (Parsing)
- SMF parsed with terrain dimensions and tile mapping
- Metal map and minimap extracted
- Benchmarked parsing in worker with no main thread stalls > 16ms

M3 (Visualization)
- Terrain renders with correct scale and materials
- Camera controls smooth at 60fps on mid‑range hardware
- Layer toggles function correctly

M4 (Editor MVP)
- User can replace at least one texture class and the minimap
- VFS updated and scene reflects changes instantly
- Export produces a package mounting in Spring/BAR

---

## Open Questions / Risks

- sd7 support in browser: which wasm decompressor has best perf/size?
- Very large textures/tiles memory pressure: tiling/streaming strategy
- Variations in mapinfo.lua schema across maps: robust normalization
- Feature placement data formats breadth (scope phase 2+)
- WebGL precision and color space correctness for materials
- Undo/redo granularity for binary assets (memory footprint)

---

## Development Quickstart

App lives in `SMF_format_editor`:

Windows PowerShell / CMD:
- cd .\SMF_format_editor
- npm install
- npm run dev

Then open the local dev URL (Vite). Use sample maps from `SMF_format_editor/MAP_EXAMPLES_NOCOMMIT` if available.

---

## Tracking Board (summary)

- [ ] M0: Architecture & skeleton
- [ ] M1: Ingestion & VFS
- [ ] M2: SMF/SMT parsing
- [ ] M3: Visualization
- [ ] M4: Editor MVP (replace assets + export)
- [ ] M5: UX & persistence
- [ ] M6: Validation & performance

---

## Changelog

- 2025-09-20: Initial top-level plan created and checklists added.
