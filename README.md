# Voxel Water Simulation

Browser MVP for destructible voxel terrain and simple gameplay-oriented volumetric water flow.

## Run

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
```

Run the non-browser simulation harness:

```bash
npm run test:sim
```

Capture every scene in normal and slice mode:

```bash
npm run screenshots
```

Refresh screenshot baselines:

```bash
npm run screenshots:update
```

Durable baseline PNGs live in `test/baselines/visual`. Generated actual and diff
images are written under `.sim-build/screenshots`.

## Controls

- Left mouse: dig terrain
- Hover visible terrain or water: inspect the cell under the cursor
- Hover empty space: inspect the first voxel hit by the 3D grid probe
- Right mouse: orbit camera
- Mouse wheel: zoom
- Space: pause or resume simulation
- G: step one simulation tick while paused
- D: toggle water debug display
- V: toggle slice view
- [ / ]: move the slice plane through the z axis
- 1: Reservoir Gate scene
- 2: Vertical Shaft scene
- 3: Lower Basin scene
- 4: Side Leak scene
- 5: Cascade Steps scene
- 6: Plug Puzzle scene
- 7: Cave Network scene
- R: reset the world

The debug panel also provides scene selection, pause/step/reset, an **Open path**
button for each authored scene, water debug, slice controls, and live tuning for
flow rates, steps per frame, and brush size. Tuning presets include Default,
Fast drain, Slow viscous, Stable spread, and Debug aggressive.

## What is implemented

- 48 x 32 x 48 typed-array voxel world
- Solid terrain cells and water volume cells
- Instanced cube terrain rendering
- Partial-height water cubes driven by real grid water values
- Click-and-hold spherical digging through raycasted terrain cells
- Deterministic fixed-step water simulation
- Downward-first water movement, lateral spreading, sleeping active cells, and neighbor wake-up
- Debug overlay with pause state, active cells, total water volume, moved volume, FPS, and controls
- Seven authored test scenes for reservoir release, vertical falling, lower-cavity filling, lateral leaks, cascades, plug puzzles, and cave networks
- Runtime slice view for inspecting the inside of the voxel volume without changing simulation data
- Water volume baseline and delta warning to catch conservation drift while iterating
- Hover cell inspection for coordinates, solid/open state, water amount, active/sleep state, and hit source
- Interactive debug panel for scene switching, pause/step/reset, water debug, and slice controls
- Browser-free simulation harness covering all scene presets across all tuning presets
- Active water cell outlines in water debug mode
- Empty-space probing on the current z slice
- Scene tool button for opening each preset's authored drain/leak path
- Runtime metrics for ticks, last moved volume, max water delta, idle ticks, and stable/moving state
- Headless screenshot comparison for all scenes with slice off/on
- Durable screenshot baselines under `test/baselines/visual`, with generated actual/diff images under `.sim-build/screenshots`
- Flow direction debug: recent downward and lateral flow glyphs in water debug mode
- Dig brush preview showing the cells that will be removed
- 3D grid raymarch inspection for empty cells, plus slice-plane fallback
- Named tuning presets for fast drain, slow viscous, stable spread, and aggressive debug passes

## Known limitations

- This is not a physically accurate fluid solver and intentionally avoids pressure, CFD, SPH, and particles.
- Water does not push upward to equalize fully enclosed pressure systems.
- The renderer draws all visible water cells as simple translucent boxes.
- Terrain meshing is intentionally naive instancing, not greedy meshing.
- Orbit uses right mouse so left mouse can stay dedicated to digging.
- The slice view currently cuts along z only.
- Flow glyphs show the most recent dominant direction per receiving cell, not a full velocity field.
- Screenshot comparison uses a simple normalized pixel-difference threshold.

## Recommended next steps

- Add greedy meshing or face culling for larger worlds.
- Add a stronger settling metric that distinguishes true rest from small-but-continuing ripples.
- Persist custom tuning profiles to local storage.
- Add per-face terrain rendering so caves read better at larger sizes.
