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

## CI/CD and hosting

Pushes to `main` run the GitHub Actions workflow, build the Vite app with the
GitHub Pages base path, run the simulation harness, and deploy `dist` to GitHub
Pages:

https://tgrozner.github.io/water-simulation/

Pull requests run the same build and simulation checks without deploying.

Run the non-browser simulation harness:

```bash
npm run test:sim
```

Capture the authored scenes, staged-open states, and game screens:

```bash
npm run screenshots
```

Refresh screenshot baselines:

```bash
npm run screenshots:update
```

Durable baseline PNGs live in `test/baselines/visual`. Generated actual and diff
images are written under `.sim-build/screenshots`. Screenshot captures use fresh
Chrome profiles under `.sim-build/screenshots/chrome-profile` so persisted
best-score fixtures stay deterministic.

Useful URL parameters for repeatable captures:

- `?scene=splitter`
- `?scene=braid`
- `?scene=divide`
- `?game=1`
- `?game=1&level=challenge`
- `?game=1&level=splitpath`
- `?game=1&level=splitbasin`
- `?game=1&debugUi=1`
- `?game=0&scene=sluice`
- `?camera=fps`
- `?camera=orbit`
- `?spawn=overview`
- `?debugUi=1`
- `?openStages=2`
- `?openHazards=1`
- `?carveManual=1`
- `?branch=north` or `?branch=south`
- `?choice2=1`
- `?warmupTicks=1800`
- `?seedBestScores=1`
- `?tuning=fast-drain`
- `?debug=1&active=0&flow=0`
- `?slice=1&sliceZ=28`

`openStages` only advances authored collapses; manual carve stages still require
terrain removal in the highlighted work zone.

## Vertical Slice

The root URL starts in a focused first-person game slice. It uses the same
terrain destruction and grid-water simulation as the sandbox, then adds a
lightweight mission loop on top:

- **Sluice Tutorial**: cut highlighted weak rock gates in order and drain the reservoir through the lower cave.
- **Forked Cavern Challenge**: mine into a forked cave network, hand-carve the final water route, and avoid red spill seams.
- **Split Path Challenge**: open the reservoir, then choose and carve one of two lower branches without relying on an authored fork gate.
- **Split Basin Challenge**: carve two outlets from one release chamber and fill both lower basins before the route settles.
- **Deep Cavern Expedition**: route a high reservoir through a much larger vertical cavern and split it into two distant lower basins.

In game mode, the full solid cave is destructible. Highlighted route markers
show the intended water-routing milestones, and red seams mark risky cuts. Once
a guided route marker is mostly destroyed, its authored breach opens and the
next marker is highlighted. Some markers are branch choices: clear either
highlighted route and only that route opens. Manual carve markers are completed
by the player's own tunnel once water enters it. Freeform shortcuts, bypasses,
side mining, and accidental leaks are allowed; the mission contract is still
judged by delivered water, per-basin targets, waste, settling, and red-seam
risk. The best completion score for each level is saved locally in the browser
and shown when that level is revisited. Best scores are keyed by level id in `localStorage` as
`voxel-water-best-scores-v1`, with `{ version: 1, scores }` as the stored
payload. The challenge selector lists every level and its local best score so a
level can be entered directly without cycling through the campaign.
The debug panels are hidden on the root view by default; press F3 or backquote,
or add `debugUi=1`, to bring them back. Use `?scene=<name>` or `?game=0` to
start directly in the full sandbox/debug workflow.

## Controls

- Left mouse: lock mouse in FPS mode and dig any solid terrain
- F: request FPS pointer lock, then toggle FPS/orbit once locked
- W / A / S / D or Z / Q / S / D: move in FPS mode
- Mouse: look around in FPS mode; click the scene if the browser needs pointer lock
- Space: jump in FPS mode, pause/resume in orbit mode
- Shift: sprint in FPS mode
- F3 or backquote: toggle sandbox/debug UI
- Hover visible terrain or water: inspect the cell under the cursor
- Hover empty space: inspect the first voxel hit by the 3D grid probe
- Right mouse: orbit camera
- Mouse wheel: zoom
- Space: pause or resume simulation outside pointer-locked FPS
- G: step one simulation tick while paused
- D: toggle water debug display
- V: toggle slice view
- [ / ]: move the slice plane through the z axis
- O: open the next guided route marker
- Shift+O: open all remaining guided route markers
- 1: Sluice Tutorial / Sluice Gates scene
- 2: Forked Cavern Challenge / Forked Cavern scene
- 3: Split Path Challenge / Split Path Cavern scene
- 4: Split Basin Challenge / Twin Basin Divide scene
- 5: Deep Cavern Expedition / Deep Cavern scene
- R: reset the world
- Challenge list buttons: enter a level directly and preview local best scores

The debug panel also provides scene selection, pause/step/reset, **Open next**,
**Open all**, water debug, separate active-cell and flow-glyph toggles, slice
controls, and live tuning for flow rates, steps per frame, and brush size.
Tuning presets include Default, Fast drain, Slow viscous, Stable spread, and
Debug aggressive. Custom tuning can be saved, loaded, and cleared from local
storage.

## What is implemented

- 48 x 32 x 48 typed-array voxel world for the focused scenes, plus a 72 x 48 x 72 deep-cavern preset
- Solid terrain cells and water volume cells
- Face-culled terrain mesh with triangle-to-cell raycast mapping
- Partial-height water cubes driven by real grid water values
- Click-and-hold spherical digging through any raycasted solid terrain cell
- Deterministic fixed-step water simulation
- Downward-first water movement, lateral spreading, sleeping active cells, and neighbor wake-up
- Debug overlay with pause state, active cells, total water volume, moved volume, FPS, and controls
- Debug overlay with terrain face count, water instance count, simulation timing, and renderer update timings
- Player-aligned 3D cave sonar showing nearby cave contours, water pockets, and camera heading
- Height- and zone-colored cave terrain with destructible physical landmarks in the large cavern
- Five authored scenes: a focused sluice tutorial, forked cavern challenge, split-path manual carve challenge, twin-basin split challenge, and large vertical deep cavern
- Runtime slice view for inspecting the inside of the voxel volume without changing simulation data
- Water volume baseline and delta warning to catch conservation drift while iterating
- Hover cell inspection for coordinates, solid/open state, water amount, active/sleep state, and hit source
- Interactive debug panel for scene switching, pause/step/reset, water debug, and slice controls
- Browser-free simulation harness covering focused scenes across all tuning presets, plus the large deep-cavern preset on the default gameplay tuning, staged openings, game completion, manual route choices, per-basin delivery targets, and focused dig/opening edge cases
- Active water cell outlines in water debug mode
- Separate active-cell and flow-glyph debug toggles
- Empty-space probing on the current z slice
- Scene tool buttons for opening each scene's guided drain path
- Progressive scene opening timeline for multi-stage scenarios
- Runtime metrics for ticks, last moved volume, max water delta, idle ticks, and stable/moving state
- Completion scoring that grades route efficiency, wasted water, and time to stable delivery
- Local best-score persistence for completed levels
- Level-select summary with direct challenge entry and best-score readouts
- Headless screenshot comparison for all scenes with slice off/on, staged openings, and game screens
- Durable screenshot baselines under `test/baselines/visual`, with generated actual/diff images under `.sim-build/screenshots`
- Flow direction debug: recent downward and lateral flow glyphs in water debug mode
- Dig brush preview showing the cells that will be removed
- 3D grid raymarch inspection for empty cells, plus slice-plane fallback
- Named tuning presets for fast drain, slow viscous, stable spread, and aggressive debug passes
- Local-storage save/load/clear controls for one custom tuning profile
- URL support for staged captures with `?openStages=N`
- First-person game slice with weak-rock-only digging, red spill hazards, fork choices, manual carve routes, per-basin delivery goals, mission HUD, and completion/failure state

## Known limitations

- This is not a physically accurate fluid solver and intentionally avoids pressure, CFD, SPH, and particles.
- Water does not push upward to equalize fully enclosed pressure systems.
- The renderer draws all visible water cells as simple translucent boxes.
- Terrain rendering is face-culled but not greedy-merged; individual voxel picking is preserved.
- Orbit uses right mouse so left mouse can stay dedicated to digging.
- The sonar is player/camera centered and top-down; it is a readability aid, not a full minimap.
- The slice view currently cuts along z only.
- Flow glyphs show the most recent dominant direction per receiving cell, not a full velocity field.
- Screenshot comparison uses a simple normalized pixel-difference threshold.
- Renderer update timings are coarse browser-side measurements, not a profiler.
- The failure loop is intentionally light; only the challenge levels have authored spill hazards.
- There is no cross-device or campaign-level persistence yet.
- The large deep-cavern preset is intentionally heavier than the focused scenes and is not yet chunked or greedy-meshed.

## Recommended next steps

- Add more branch-choice levels where safe cuts and risky shortcuts compete for the same water.
- Add greedy meshing only if a separate voxel picking path is introduced.
- Add a stronger settling metric that distinguishes true rest from small-but-continuing ripples.
- Add more authored cave scenarios with distinct staged release patterns.
