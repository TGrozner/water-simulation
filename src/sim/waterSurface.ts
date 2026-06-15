import { coords, inBounds, index } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";

export const WATER_SURFACE_OFFSET_LIMIT = 0.12;
export const WATER_SURFACE_VELOCITY_LIMIT = 0.16;
export const WATER_SURFACE_ACTIVE_CELL_LIMIT = 4096;

const SURFACE_WAVE_COUPLING = 0.14;
const SURFACE_WAVE_STIFFNESS = 0.1;
const SURFACE_WAVE_DAMPING = 0.78;
const SURFACE_WAVE_CLEAR_EPSILON = 0.001_2;
const SURFACE_WAVE_PROPAGATION_THRESHOLD = 0.026;
const SURFACE_HORIZONTAL_IMPULSE_SCALE = 0.034;
const SURFACE_VERTICAL_IMPULSE_SCALE = 0.052;
const SURFACE_IMPULSE_LIMIT = 0.08;
const SURFACE_NEIGHBOR_Y_OFFSETS = [0, 1, -1] as const;

const LATERAL_OFFSETS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
] as const;

export type WaterSurfaceStepStats = {
  changed: boolean;
  visitedCells: number;
};

export function recordSurfaceImpulse(
  world: VoxelWorld,
  cellIndex: number,
  amount: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  if (amount <= EPSILON) {
    return false;
  }

  const surfaceCellIndex = resolveSurfaceCellIndex(world, cellIndex);
  if (surfaceCellIndex === null) {
    return false;
  }

  const horizontal = Math.hypot(dx, dz);
  const vertical = Math.abs(dy);
  const impulseScale = vertical > horizontal ? SURFACE_VERTICAL_IMPULSE_SCALE : SURFACE_HORIZONTAL_IMPULSE_SCALE;
  const impulseSign = dy < 0 ? -1 : 1;
  const impulse = clampSurfaceVelocity(impulseSign * Math.min(SURFACE_IMPULSE_LIMIT, amount * impulseScale));
  const previousVelocity = world.waterSurfaceVelocity[surfaceCellIndex];
  const nextVelocity = clampSurfaceVelocity(previousVelocity + impulse);
  if (previousVelocity === nextVelocity && world.activeSurfaceCells.has(surfaceCellIndex)) {
    return false;
  }

  world.waterSurfaceVelocity[surfaceCellIndex] = nextVelocity;
  world.activeSurfaceCells.add(surfaceCellIndex);
  return true;
}

export function stepWaterSurface(
  world: VoxelWorld,
  maxVisitedCells = WATER_SURFACE_ACTIVE_CELL_LIMIT,
): WaterSurfaceStepStats {
  if (world.activeSurfaceCells.size === 0) {
    return { changed: false, visitedCells: 0 };
  }

  const candidates = new Set<number>();
  const nextActiveCells = new Set<number>();
  let deferred = false;

  for (const cellIndex of world.activeSurfaceCells) {
    if (candidates.size >= maxVisitedCells) {
      nextActiveCells.add(cellIndex);
      deferred = true;
      continue;
    }

    queueSurfaceCandidate(world, cellIndex, candidates, maxVisitedCells);
  }

  const updates: Array<{ cellIndex: number; offset: number; velocity: number }> = [];
  let changed = deferred;

  for (const cellIndex of candidates) {
    const previousOffset = world.waterSurfaceOffset[cellIndex];
    const previousVelocity = world.waterSurfaceVelocity[cellIndex];

    if (!isRenderableSurfaceCell(world, cellIndex)) {
      if (previousOffset !== 0 || previousVelocity !== 0) {
        updates.push({ cellIndex, offset: 0, velocity: 0 });
        changed = true;
      }
      continue;
    }

    const neighborOffset = getNeighborSurfaceOffset(world, cellIndex);
    const restoringForce = (neighborOffset - previousOffset) * SURFACE_WAVE_COUPLING - previousOffset * SURFACE_WAVE_STIFFNESS;
    let nextVelocity = clampSurfaceVelocity((previousVelocity + restoringForce) * SURFACE_WAVE_DAMPING);
    let nextOffset = clampSurfaceOffset(previousOffset + nextVelocity);

    if (Math.abs(nextOffset) <= SURFACE_WAVE_CLEAR_EPSILON && Math.abs(nextVelocity) <= SURFACE_WAVE_CLEAR_EPSILON) {
      nextOffset = 0;
      nextVelocity = 0;
    }

    if (previousOffset !== nextOffset || previousVelocity !== nextVelocity) {
      updates.push({ cellIndex, offset: nextOffset, velocity: nextVelocity });
      changed = true;
    }

    if (isActiveSurfaceMotion(nextOffset, nextVelocity)) {
      nextActiveCells.add(cellIndex);
      if (Math.abs(nextOffset) + Math.abs(nextVelocity) >= SURFACE_WAVE_PROPAGATION_THRESHOLD) {
        queueLateralSurfaceNeighbors(world, cellIndex, nextActiveCells);
      }
    }
  }

  for (const update of updates) {
    world.waterSurfaceOffset[update.cellIndex] = update.offset;
    world.waterSurfaceVelocity[update.cellIndex] = update.velocity;
  }

  world.activeSurfaceCells = nextActiveCells;
  return { changed, visitedCells: candidates.size };
}

export function getWaterSurfaceOffsetAt(world: VoxelWorld, x: number, y: number, z: number): number {
  if (!inBounds(world, x, y, z)) {
    return 0;
  }

  return world.waterSurfaceOffset[index(world, x, y, z)];
}

export function getWaterSurfaceVelocityAt(world: VoxelWorld, x: number, y: number, z: number): number {
  if (!inBounds(world, x, y, z)) {
    return 0;
  }

  return world.waterSurfaceVelocity[index(world, x, y, z)];
}

function queueSurfaceCandidate(
  world: VoxelWorld,
  cellIndex: number,
  candidates: Set<number>,
  maxVisitedCells: number,
): void {
  if (candidates.size >= maxVisitedCells) {
    return;
  }

  candidates.add(cellIndex);
  const cell = coords(world, cellIndex);
  for (const offset of LATERAL_OFFSETS) {
    if (candidates.size >= maxVisitedCells) {
      return;
    }

    const neighborIndex = getLateralSurfaceNeighborIndex(world, cell.x + offset.x, cell.y, cell.z + offset.z);
    if (neighborIndex !== null) {
      candidates.add(neighborIndex);
    }
  }
}

function queueLateralSurfaceNeighbors(world: VoxelWorld, cellIndex: number, target: Set<number>): void {
  const cell = coords(world, cellIndex);
  for (const offset of LATERAL_OFFSETS) {
    const neighborIndex = getLateralSurfaceNeighborIndex(world, cell.x + offset.x, cell.y, cell.z + offset.z);
    if (neighborIndex !== null) {
      target.add(neighborIndex);
    }
  }
}

function getNeighborSurfaceOffset(world: VoxelWorld, cellIndex: number): number {
  const cell = coords(world, cellIndex);
  let total = 0;
  let count = 0;

  for (const offset of LATERAL_OFFSETS) {
    const neighborIndex = getLateralSurfaceNeighborIndex(world, cell.x + offset.x, cell.y, cell.z + offset.z);
    if (neighborIndex === null) {
      continue;
    }

    total += world.waterSurfaceOffset[neighborIndex];
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function resolveSurfaceCellIndex(world: VoxelWorld, cellIndex: number): number | null {
  if (isRenderableSurfaceCell(world, cellIndex)) {
    return cellIndex;
  }

  const cell = coords(world, cellIndex);
  for (let y = Math.min(world.height - 1, cell.y + 2); y >= Math.max(0, cell.y - 2); y -= 1) {
    const candidateIndex = index(world, cell.x, y, cell.z);
    if (isRenderableSurfaceCell(world, candidateIndex)) {
      return candidateIndex;
    }
  }

  return null;
}

function getLateralSurfaceNeighborIndex(world: VoxelWorld, x: number, y: number, z: number): number | null {
  if (x < 0 || x >= world.width || z < 0 || z >= world.depth) {
    return null;
  }

  for (const yOffset of SURFACE_NEIGHBOR_Y_OFFSETS) {
    const sampleY = y + yOffset;
    if (sampleY < 0 || sampleY >= world.height) {
      continue;
    }

    const cellIndex = index(world, x, sampleY, z);
    if (isRenderableSurfaceCell(world, cellIndex)) {
      return cellIndex;
    }
  }

  return null;
}

function isRenderableSurfaceCell(world: VoxelWorld, cellIndex: number): boolean {
  if (cellIndex < 0 || cellIndex >= world.water.length || world.solid[cellIndex] === 1 || world.water[cellIndex] <= EPSILON) {
    return false;
  }

  const cell = coords(world, cellIndex);
  if (cell.y + 1 >= world.height) {
    return true;
  }

  const aboveIndex = index(world, cell.x, cell.y + 1, cell.z);
  return world.solid[aboveIndex] !== 1 && world.water[aboveIndex] <= EPSILON;
}

function isActiveSurfaceMotion(offset: number, velocity: number): boolean {
  return Math.abs(offset) > SURFACE_WAVE_CLEAR_EPSILON || Math.abs(velocity) > SURFACE_WAVE_CLEAR_EPSILON;
}

function clampSurfaceOffset(value: number): number {
  return Math.min(WATER_SURFACE_OFFSET_LIMIT, Math.max(-WATER_SURFACE_OFFSET_LIMIT, value));
}

function clampSurfaceVelocity(value: number): number {
  return Math.min(WATER_SURFACE_VELOCITY_LIMIT, Math.max(-WATER_SURFACE_VELOCITY_LIMIT, value));
}
