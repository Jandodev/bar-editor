# BAR Editor — Web Map Editor for Beyond All Reason (Spring RTS)

Lightweight, single‑page, WebGL/Vue editor that ingests, visualizes, edits, and re‑exports Spring/BAR maps directly in your browser. No installs, no native deps.

- Stack: Vite + Vue 3 + TypeScript + Three.js
- Formats: .smf (terrain), .sdz/.zip (map packages), folder trees
- License: MIT

Status: Early but usable. Terrain brushes, overlays, and SMF save/export are implemented. Packaging and some viewers are WIP.

---

## Quick start

1) Requirements
- Node 18+ (recommended 20+)
- A Chromium browser (Chrome/Edge) for best performance and save dialogs
- Optional: a BAR map to try (or use the included “Blank Generic Map” example skeleton)

2) Install and run
- npm
  - npm install
  - npm run dev
- pnpm
  - pnpm install
  - pnpm dev

Vite will print a local URL. Open it in your browser.

3) Load map data
- Load .smf to visualize/edit terrain, or
- Load .sdz/.zip to browse the map package (ingests mapinfo.lua + images), or
- Load folder (pick a map directory tree, e.g. MyMap.sdd)

4) Edit
- Enable Terrain Editing in the right panel
- Pick a brush (Add/Remove/Smooth or plugins like Flatten, Erode, Terrace, etc.)
- Adjust Radius/Strength
- Click+drag in either viewport

5) Save / Export
- Save Edited SMF to get edited.smf
- Export mapinfo.lua (points to maps/flat.smf) if you need a minimal mapinfo

6) Test in BAR (Windows example)
- Create a folder: %LOCALAPPDATA%\Programs\Beyond-All-Reason\data\maps\MyMap.sdd
- Put mapinfo.lua at the root of MyMap.sdd
- Put your .smf in MyMap.sdd\maps\ (e.g. maps\flat.smf)
- Launch BAR and select your map

Tip: Use MAP_EXAMPLES_NOCOMMIT/blank-generic-map as a reference skeleton.

---

## Features

Viewer
- Dual viewports: Perspective + Orthographic
- Terrain mesh rendering with adjustable wireframe + grid
- Toggleable overlays: Metal map, Type map, Tiles index, Grass, Features
- Minimap bytes ingest (DXT1) — on-canvas rendering WIP

Ingestion
- Open .smf files
- Open .sdz/.zip map packages: auto-parses mapinfo.lua and indexes files
- Open folders (webkitdirectory) or via the Directory Picker (Chrome/Edge): builds a virtual file browser
- mapinfo.lua parsing to JSON; exposes map metadata and environment hints

Editing
- VoxelSniper-inspired brush system, plugin-based:
  - Built-ins: raise, lower, smooth
  - Plugins: flatten, level, blend, erode, dilate, fill, drain, terrace, noise, sharpen, raise-square, lower-square
- Brush preview in viewports
- Stride-aware editor: downsampling for performance, automatic bilinear upsampling on save
- New Flat Map generator (.smf), or “Flat From Current” one-click flatten

Assets & Overlays
- Drag/drop images from package/folder into Overlays list
- Mapinfo Resources panel binds images to mapinfo.smf/resources keys, with quick “Enable overlay” and “Use as base” actions
- DDS awareness for overlays

Save/Export
- Save edited terrain to .smf (updates min/max in header)
- Export a minimal mapinfo.lua that references maps/flat.smf
- File System Access API save dialog on supported browsers, automatic download fallback otherwise

Performance
- Geometry downsampling based on map size (stride)
- Efficient sub-rectangle edits; brushes return new Float32Array for reactive updates
- Chrome recommended for faster WebGL and larger memory budgets

---

## Limitations and notes

- .sd7 (7z) packages: not supported in-browser yet. Convert to .sdz/.zip to ingest, or load a folder.
- Minimap rendering: ingest available; runtime decoding/rendering is WIP.
- Packaging back to .sdz: not wired yet. For now:
  - Use a .sdd folder (recommended for fast iteration), or
  - Zip your folder as .sdz using your archiver (store/deflate).
- Browsers cannot write to BAR’s maps directory automatically. Use the Save dialog, then copy files manually.
- No Lua is executed; mapinfo.lua is parsed to JSON only.

---

## How to test a new map quickly (sdd workflow)

1) Create a folder like:
- Windows: %LOCALAPPDATA%\Programs\Beyond-All-Reason\data\maps\MyMap.sdd
- Linux: ~/.config/beyond-all-reason/data/maps/MyMap.sdd (varies by install)
- macOS: ~/Library/Application Support/Beyond-All-Reason/data/maps/MyMap.sdd (varies by install)

2) Inside MyMap.sdd:
- mapinfo.lua           (root)
- maps/flat.smf         (or your edited.smf, path must match mapinfo.lua)
- textures/...          (optional, referenced textures)

3) Ensure mapinfo.lua has mapfile = "maps/flat.smf" (or the filename you saved).
4) Start BAR and select “MyMap”.

Use MAP_EXAMPLES_NOCOMMIT/blank-generic-map as a template.

---

## Brush system (plugins)

- Auto-discovers plugins from src/plugins/brushes/**/*.{ts,js} via Vite import.meta.glob
- Add your own by dropping a file there; the Mode dropdown updates automatically
- Docs:
  - In-app: Right panel → “Terrain Editing (Experimental)” → Show Brush Docs
  - Repo: src/lib/brushes/README.md and src/plugins/brushes-docs/overview.md

Example plugin
```ts
// src/plugins/brushes/my-brush.ts
import type { Brush } from '../../lib/brushes'
export default <Brush>{
  id: 'my-brush',
  label: 'My Custom Brush',
  apply: (a) => new Float32Array(a.heights),
}
```

---

## Usage guide

- Files toolbar (top): Load .smf, Load .sdz/.zip, Load folder, Load mapinfo.lua
- Left panel: File browser of uploaded package/folder; quick actions per file:
  - Parse mapinfo (lua) → parse and preview JSON
  - Load SMF → visualize/edit heights
  - Overlay / Use as base → quickly add images to the canvas or as base color
- Right panel:
  - New Flat Map: generate a brand-new SMF or flatten current
  - Detection: SMT files found and mapinfo references
  - Map Definition: name, shortname, version, author, mapfile
  - Map Info: size, square size, height range, stride used
  - Ortho View: switch right viewport (terrain/atlas/profiler)
  - Display: toggles for overlays + wireframe/grid
  - Terrain Editing (Experimental): enable brushes, choose mode/radius/strength, Save Edited SMF
  - Base Texture: pick a base color image from loaded images
  - Mapinfo Resources: bind overlays to mapinfo keys and enable them
  - mapinfo.lua (parsed): view JSON

---

## Troubleshooting

- BAR crashes with “supreme_xxx.smf not found”: Ensure mapinfo.lua’s mapfile matches your .smf filename and path under maps/.
- Minimap not visible: SMF holds DXT1 minimap bytes; viewer rendering is WIP. You can still bind an external minimap image as an overlay.
- Smooth seems too strong: Strength is [0..1] blend. Try 0.2.
- No plugin brushes: Rebuild/refresh. Ensure src/lib/brushes is imported (the main UI does this). Place plugins in src/plugins/brushes/.
- SD7 won’t open: Convert to .sdz/.zip, or open the map folder (sdd).

---

## Development

Scripts
- npm run dev — start Vite dev server
- npm run build — typecheck + production build
- npm run preview — preview built files

Project layout (selected)
- src/App.vue — main SPA with side panels + viewports
- src/components/editor/ViewportHost.vue — viewport host
- src/plugins/viewport/{perspective,orthographic}.ts — viewport plugins
- src/lib/smf.ts — SMF parser
- src/lib/smf-writer.ts — Write/patch SMF
- src/lib/mapinfo.ts — mapinfo.lua parsing to JSON
- src/lib/save.ts — File System Access API save helpers
- src/lib/brushes/** — brush registry + types + docs
- src/plugins/brushes/** — brush plugins (auto-loaded)
- src/plugins/brushes-docs/** — inline help markdown
- MAP_EXAMPLES_NOCOMMIT/** — example skeleton (not shipped)

Debugging Lua
- lua-debug.html and src/debug/lua-debug.ts have a minimal surface for parser testing.

Browser notes
- The editor prefers Chrome/Edge for File System Access API and higher WebGL budgets.
- Firefox/Safari fall back to download prompts instead of native save dialogs.

---

## Roadmap (short)

- Ingestion: wasm-based .sd7 support
- Viewer: improved materials, minimap decoding, feature placement overlay
- Editor: normals/specular/helpers, undo/redo, pathing preview
- Export: full package builder (.sdz), validation
- Integration: embed in BAR client where possible

For a detailed milestone board, see the original planning doc in this file’s history.

---

## Contributing

PRs and issues are welcome:
- Keep brushes pure (input heights -> output heights); wire side-effects through the ResourceBus
- Prefer TypeScript + small, composable modules
- Keep the UI performant (do heavy work off main thread where reasonable)
- Add docs to src/plugins/brushes-docs/ for new brushes

---

## Security

- The app never executes Lua; it parses mapinfo.lua into JSON
- Malicious code can exist in map packages in general; prefer trusted sources
- This is a browser app — it cannot write to system directories; you choose where to save

---

## License

MIT © 2025 Jando
