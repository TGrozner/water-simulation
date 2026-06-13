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

Capture the tutorial/challenge scenes, staged-open states, and game screens:

```bash
npm run screenshots
```

Refresh screenshot baselines:

```bash
npm run screenshots:update
```

Durable baseline PNGs live in `test/baselines/visual`. Generated actual and diff
images are written under `.sim-build/screenshots`.

Useful URL parameters for repeatable captures:

- `?game=1`
- `?game=1&level=challenge`
- `?game=0&scene=sluice`
- `?scene=splitter`
- `?camera=fps`
- `?camera=orbit`
- `?openStages=2`
- `?tuning=fast-drain`
- `?debug=1&active=0&flow=0`
- `?slice=1&sliceZ=28`

## Vertical slice

The root URL starts in a small game-mode vertical slice. It reuses the same
terrain destruction and grid-water simulation as the sandbox, then layers simple
level goals on top:

- **Sluice Tutorial**: open and dig through the sluice route to fill the marked lower spillway.
- **Split Basin Challenge**: split a limited reservoir between two marked lower basins and keep them balanced.

The game HUD shows target fill amounts, water outside target zones, balance
status, reset, and next-level controls. The translucent yellow or green boxes in
the world mark objective volumes. Use `?scene=<name>` or `?game=0` to return to
the full sandbox/debug workflow; the debug panel exposes **Return to game** after
scene browsing.

## Controls

- Left mouse: lock mouse in FPS mode and dig terrain
- F: request FPS pointer lock, then toggle FPS/orbit once locked
- W / A / S / D or Z / Q / S / D: move in FPS mode
- Mouse: look around in FPS mode; click the scene if the browser needs pointer lock
- Space: jump in FPS mode, pause/resume in orbit mode
- Shift: sprint in FPS mode
- Hover visible terrain or water: inspect the cell under the cursor
- Hover empty space: inspect the first voxel hit by the 3D grid probe
- Right mouse: orbit camera
- Mouse wheel: zoom
- Space: pause or resume simulation outside pointer-locked FPS
- G: step one simulation tick while paused
- D: toggle water debug display
- V: toggle slice view
- [ / ]: move the slice plane through the z axis
- O: open the next authored scene path stage
- Shift+O: open all remaining authored scene path stages
- 1: Sluice Tutorial / Sluice Gates scene
- 2: Split Basin Challenge / Split Basin scene
- R: reset the world

The debug panel also provides scene selection, pause/step/reset, **Open next**,
**Open all**, water debug, separate active-cell and flow-glyph toggles, slice
controls, and live tuning for flow rates, steps per frame, and brush size.
Tuning presets include Default, Fast drain, Slow viscous, Stable spread, and
Debug aggressive. Custom tuning can be saved, loaded, and cleared from local
storage.

## What is implemented

- 48 x 32 x 48 typed-array voxel world
- Solid terrain cells and water volume cells
- Face-culled terrain mesh with triangle-to-cell raycast mapping
- Partial-height water cubes driven by real grid water values
- Click-and-hold spherical digging through raycasted terrain cells
- Deterministic fixed-step water simulation
- Downward-first water movement, lateral spreading, sleeping active cells, and neighbor wake-up
- Debug overlay with pause state, active cells, total water volume, moved volume, FPS, and controls
- Debug overlay with terrain face count, water instance count, simulation timing, and renderer update timings
- Corner 3D cave sonar showing open cave contours, water pockets, and camera heading
- Two authored scenes: a focused sluice tutorial and a split-basin challenge
- Runtime slice view for inspecting the inside of the voxel volume without changing simulation data
- Water volume baseline and delta warning to catch conservation drift while iterating
- Hover cell inspection for coordinates, solid/open state, water amount, active/sleep state, and hit source
- Interactive debug panel for scene switching, pause/step/reset, water debug, and slice controls
- Browser-free simulation harness covering both scenes across all tuning presets, staged openings, focused dig/opening edge cases, and scripted game completion
- Active water cell outlines in water debug mode
- Separate active-cell and flow-glyph debug toggles
- Empty-space probing on the current z slice
- Scene tool buttons for opening each level's authored drain path
- Progressive scene opening timeline for multi-stage scenarios
- Runtime metrics for ticks, last moved volume, max water delta, idle ticks, and stable/moving state
- Headless screenshot comparison for both scenes with slice off/on, staged openings, and game screens
- Durable screenshot baselines under `test/baselines/visual`, with generated actual/diff images under `.sim-build/screenshots`
- Flow direction debug: recent downward and lateral flow glyphs in water debug mode
- Dig brush preview showing the cells that will be removed
- 3D grid raymarch inspection for empty cells, plus slice-plane fallback
- Named tuning presets for fast drain, slow viscous, stable spread, and aggressive debug passes
- Local-storage save/load/clear controls for one custom tuning profile
- URL support for staged captures with `?openStages=N`
- Thin game-mode vertical slice with two levels, target zones, limited-water scoring, reset, and next-level flow

## Known limitations

- This is not a physically accurate fluid solver and intentionally avoids pressure, CFD, SPH, and particles.
- Water does not push upward to equalize fully enclosed pressure systems.
- The renderer draws all visible water cells as simple translucent boxes.
- Terrain rendering is face-culled but not greedy-merged; individual voxel picking is preserved.
- Orbit uses right mouse so left mouse can stay dedicated to digging.
- The sonar uses the current camera as a lightweight player-position proxy.
- The slice view currently cuts along z only.
- Flow glyphs show the most recent dominant direction per receiving cell, not a full velocity field.
- Screenshot comparison uses a simple normalized pixel-difference threshold.
- Renderer update timings are coarse browser-side measurements, not a profiler.
- Game objectives are volume-zone checks only; there is no timer, score economy, or campaign persistence yet.

## Recommended next steps

- Add a real level-complete affordance in-world, such as gates unlocking after objectives fill.
- Add fail/retry rules for wasting too much water outside targets.
- Add one more challenge that requires digging a player-authored split path instead of mostly opening staged sluices.
- Add greedy meshing only if a separate voxel picking path is introduced.
- Add a stronger settling metric that distinguishes true rest from small-but-continuing ripples.
- Add more authored scenario goals, such as target fill volume or drain completion checks.
