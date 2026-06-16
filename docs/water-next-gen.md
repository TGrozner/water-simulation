# Next-Gen Water Direction

This project treats water as a core pillar, not a visual effect layered on top
of voxel cells. The target is a best-in-class game water system for a
destructible cavern: physically credible enough to trust, visually rich enough
to read at a glance, and stable enough for play.

## North Star

Build water that feels simulated rather than hidden by rendering tricks:

- Volume is conserved and visibly follows carved terrain.
- Flow has pressure, inertia, settling, and believable resistance.
- Surfaces are continuous, stable, and shaped by the solver.
- Shorelines, waterfalls, foam, spray, and ripples come from flow events.
- The renderer never relies on flickering voxel quads as the final look.
- Debug tools expose the hydraulic state behind every visible cue.

## Current Baseline

The current system is now a sparse hydraulic span graph in the main app, with
the older sequential span solver still available for comparison:

- voxel terrain stays authoritative for carving, collision, scoring, and
  inspection;
- water volume is stored per cell for compatibility with existing gameplay;
- vertical open spans collapse water downward;
- active column spans are connected by overlapping portal edges;
- lateral edge fluxes are proposed simultaneously from head delta, aperture,
  capacity, and stored pipe flux;
- pipe flux metadata now carries bounded momentum across tiny adverse heads;
- applied span-edge transfers now emit solver-owned visual events for edge
  flow, falls, and impacts;
- solver diagnostics expose active span count, edge count, flux magnitude, max
  head delta, and correction volume;
- terrain and water rendering now share the same organic terrain density field
  for shoreline/contact decisions;
- rendering reconstructs continuous water surfaces from contiguous simulated
  water segments rather than from entire open voxel columns;
- gameplay can emit localized waterfall/impact ribbons from solver-owned
  hydraulic events.

That baseline is strong enough to iterate visually and physically, but not the
final water model.

The gameplay renderer intentionally keeps decorative shoreline skirts, broad
heuristic waterfall sheets, and foam quads disabled. Re-enabling axis-aligned
quads would make screenshots look busier, but it would hide the exact
terrain/water defects the simulation still needs to solve. The only gameplay
fall sheets currently allowed are localized ribbons emitted directly from
hydraulic `fall` and `impact` events.

## Architecture Direction

Keep the voxel terrain, but evolve the water layer into a sparse hydraulic span
graph:

1. Build active column spans from open voxel columns.
2. Build portal edges between overlapping neighboring spans.
3. Solve lateral edge fluxes simultaneously from head delta, aperture, prior
   flux, damping, capacity, and source volume.
4. Apply all span volume deltas together, with strict conservation.
5. Write back to `world.water` as a compatibility/output buffer.
6. Drive surface targets, velocity, foam, spray, and waterfall events from the
   span graph rather than from integer top voxels alone.

Avoid a full dense CFD grid until the game needs it. FLIP/SPH-style particles
can be useful later for local spray and splashes, but the main cavern water
should stay sparse enough for realtime carving.

## Research Anchors

- [Bridson and Muller-Fischer's SIGGRAPH 2007 fluid simulation notes](https://www.cs.ubc.ca/~rbridson/fluidsimulation/fluids_notes.pdf)
  frame the game constraint clearly: realtime water needs low compute cost, low
  memory, fixed-step stability, and visual plausibility.
- [GPU Gems, Chapter 38, Fast Fluid Dynamics Simulation on the GPU](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu)
  reinforces that a velocity field is the useful bridge between simulation and
  visible motion.
- [Stam's Stable Fluids](https://pages.cs.wisc.edu/~chaol/data/cs777/stam-stable_fluids.pdf)
  is the reference for stable interactive fluid fields, but it is intentionally
  dissipative and better treated here as guidance for robustness and visual
  velocity advection than as the main cavern volume model.
- Virtual-pipe and shallow-water work remains the closest fit for this project:
  it gives pressure/head-driven flow across local connections without paying for
  dense 3D Navier-Stokes over the whole destructible cave.

## Visual Direction

The final renderer should make the hydraulic state legible:

- Continuous surface meshes with hysteresis so topology changes do not shimmer.
- Stable depth coloring and absorption so basins read as deep water, not flat
  cyan plates.
- Terrain-aware shore skirts that hide hard intersections against cave walls.
- Flow-aligned normals/ripples and streaks.
- Foam bands at shorelines, constrictions, falls, and turbulent impact zones.
- Spray and mist as local event particles, not random decoration.
- Waterfall sheets that follow real vertical flow and break into spray where
  they hit pools.

Any effect that does not trace back to solver state should be treated as suspect
until it proves it improves readability without hiding a simulation defect.

## No Cache-Misere Contract

Water visuals are allowed only when their source is auditable:

- primary water surface vertices come from conserved simulated water volume;
- terrain clipping/contact comes from the shared terrain density field;
- waterfall, foam, spray, and mist activation comes from hydraulic edge events,
  head gradients, impact energy, or surface velocity;
- debug-only legacy quads may exist for inspection, but gameplay must not depend
  on them as the final look.

When a visual artifact appears, prefer fixing the simulation data or shared
surface extraction before adding a masking layer.

## Validation Standard

Every major water slice should prove three things:

- **Physics:** conservation, no NaN/invalid cells, stable sleep, route delivery,
  and no regressions in staged generated-cavern scenarios.
- **Performance:** carving and warmup remain interactive on the 72 x 48 x 72
  generated cavern.
- **Visual:** screenshot smoke/full plus browser inspection from FPS viewpoints
  that show basins, shorelines, waterfalls, and post-carve flow.

Recommended checks while iterating:

```bash
npx --no-install tsc --noEmit --pretty false
npm run test:sim:smoke
npm run test:sim -- --only=game,progressive,scenario
npm run screenshots:smoke
```

Recommended handoff checks for accepted water changes:

```bash
npm run validate:standard
npm run screenshots:full
VITE_BASE_PATH=/water-simulation/ npm run build
git diff --check
```

Use `npm run test:sim:full` when solver behavior changes broadly. Reserve
`npm run test:sim:paranoid` for deep solver debugging; it scans every tick and
can be substantially slower on the generated cavern.

## Next Implementation Steps

1. Move surface rendering inputs further from voxel top cells toward span
   surface targets and edge flow metadata.
2. Replace disabled gameplay shoreline skirts and foam with terrain-contact
   geometry emitted from hydraulic events.
3. Extend local particle spray/mist around high-energy impact events while
   keeping activation solver-driven.
4. Add stronger profiler coverage for `test:sim:full` and generated-cavern
   warmup so long checks can be split intentionally instead of skipped.
5. Profile the sparse graph on generated-cavern carving bursts and add chunked
   span invalidation only if the metrics require it.
6. Add terrain-aware foam variants for constrictions, shore rebound, and
   waterfall impact zones.
7. Expand visual captures to post-carve sluice sequences and side-by-side
   `solver=sparse` / `solver=legacy` comparisons when debugging regressions.
