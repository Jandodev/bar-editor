# Terrain Brushes – Quick Start

This editor has a plugin-based brush system (VoxelSniper-inspired). You can now select many brushes in the “Terrain Editing (Experimental)” panel.

How to use
1) Enable: Check “Enable brush editing”.
2) Pick Mode: Choose a brush in the Mode dropdown.
   - Common: Add (raise), Remove (lower), Smooth (blend).
   - Plugins: Additional brushes discovered from the plugin system.
3) Radius: World-units footprint size.
4) Strength: Brush-specific meaning (see below).
5) Paint: Click and drag in either viewport. Toggle “Show brush preview” to see the footprint.

Notes
- For brushes that use a target elevation, the “target” defaults to the height under your cursor (raycast hit Y).
- Smooth/Blend clamp strength in [0..1], interpreted as a blend factor.

Available brushes
- raise (Add): Raise terrain. Strength = world-units height delta at center (falloff outward).
- lower (Remove): Lower terrain. Strength = world-units height delta at center (falloff outward).
- smooth (Blend): Blend heights toward local average. Strength ∈ [0..1] (blend factor).
- flatten: Move heights toward a target elevation (cursor hitY, or nearest-vertex height if missing). Strength ∈ [0..1] (blend).
- level: Like flatten, tends to a target elevation. Strength ∈ [0..1] (1.0 ≈ harder set).
- erode: Reduces peaks by moving toward local minimum. Strength ∈ [0..1].
- dilate: Fills pits by moving toward local maximum. Strength ∈ [0..1].
- fill: Raises up toward target elevation but never lowers. Strength ∈ [0..1].
- drain: Lowers down toward target elevation but never raises. Strength ∈ [0..1].
- terrace: Quantizes heights to steps of size = Strength (world units). If Strength ≤ 0, defaults to 8. Blends by falloff.
- noise: Adds band-limited height noise. Strength = noise amplitude (world units).
- sharpen: Unsharp mask to crispen ridges. Strength ∈ [0..1] (amount).
- raise-square: Raise with a square (Chebyshev) footprint. Strength = world-units delta.
- lower-square: Lower with a square (Chebyshev) footprint. Strength = world-units delta.

Tips
- For strong leveling, try “level” with Strength=1.0; for softer leveling, reduce Strength.
- Terrace uses Strength as step size, not blend. To coarsen steps, increase Strength (e.g. 16).
- Noise uses Strength as amplitude. Use small values (e.g. 0.5–2) for natural variation.
- Erode/Dilate are local morphological operations. For more effect, increase Strength or paint a few passes.

Where did this list come from?
- The editor auto-discovers brushes under src/plugins/brushes/**/* via the BrushRegistry.
- The Mode dropdown queries the registry at runtime, so new brush files appear automatically.
- You can add your own brushes by dropping a new file into src/plugins/brushes/. See src/lib/brushes/README.md for the plugin API.

Troubleshooting
- If you don’t see plugin brushes: refresh the page after changes; ensure the project builds; make sure src/lib/brushes is imported at least once (the main UI now does this).
- If Smooth/Blend seem too strong: reduce Strength to a small fraction (e.g. 0.2).
