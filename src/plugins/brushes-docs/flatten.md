# flatten — Flatten toward target elevation

Behavior
- Moves heights within the brush radius toward a target elevation.
- Target elevation = the height directly under your cursor (raycast hit Y).
- If the cursor hit is not available, falls back to the nearest grid-vertex height at the brush center.
- Uses a smooth falloff from center (1.0) to radius (0.0).

Parameters
- Radius (world units): footprint size in world space.
- Strength (0..1): blend factor toward the target elevation per paint sample.
  - 1.0 = strong leveling (almost a “set height” at center).
  - 0.2–0.5 = softer leveling; preserves more local detail.

Usage Tips
- To set a plateau, hover at the desired elevation and paint with Strength=1.0 near the center of the area.
- For gradual transitions, reduce Strength and paint a few passes.
- Combine with “smooth” or “blend” around the edges to soften hard transitions if needed.

Notes
- This brush only affects heights inside the brush radius. Outer border is smoothly blended.
- Always returns a new height buffer (Float32Array) to keep the editor reactive.
