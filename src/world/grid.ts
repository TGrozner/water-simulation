import { EPSILON, MAX_WATER, type CellCoords, type VoxelWorld } from "./types";

export function createEmptyWorld(width: number, height: number, depth: number): VoxelWorld {
  const cellCount = width * height * depth;

  return {
    width,
    height,
    depth,
    solid: new Uint8Array(cellCount),
    water: new Float32Array(cellCount),
    totalWater: 0,
    waterFlow: new Float32Array(cellCount * 3),
    waterSurfaceOffset: new Float32Array(cellCount),
    waterSurfaceVelocity: new Float32Array(cellCount),
    waterFlux: new Map<string, number>(),
    waterEdgeEvents: [],
    waterVisualEvents: [],
    activeCells: new Set<number>(),
    activeFlowCells: new Set<number>(),
    activeSurfaceCells: new Set<number>(),
    wetCells: new Set<number>(),
  };
}

export function index(world: VoxelWorld, x: number, y: number, z: number): number {
  return x + world.width * (z + world.depth * y);
}

export function coords(world: VoxelWorld, cellIndex: number): CellCoords {
  const layerSize = world.width * world.depth;
  const y = Math.floor(cellIndex / layerSize);
  const layerIndex = cellIndex - y * layerSize;
  const z = Math.floor(layerIndex / world.width);
  const x = layerIndex - z * world.width;

  return { x, y, z };
}

export function inBounds(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return x >= 0 && x < world.width && y >= 0 && y < world.height && z >= 0 && z < world.depth;
}

export function isSolid(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (!inBounds(world, x, y, z)) {
    return true;
  }

  return world.solid[index(world, x, y, z)] === 1;
}

export function getWater(world: VoxelWorld, x: number, y: number, z: number): number {
  if (!inBounds(world, x, y, z)) {
    return 0;
  }

  return world.water[index(world, x, y, z)];
}

export function setWater(world: VoxelWorld, x: number, y: number, z: number, amount: number): void {
  if (!inBounds(world, x, y, z)) {
    return;
  }

  setCellWater(world, index(world, x, y, z), amount);
}

export function setCellWater(world: VoxelWorld, cellIndex: number, amount: number): void {
  const previousWater = world.water[cellIndex];
  const nextWater = world.solid[cellIndex] === 1 ? 0 : clampWater(amount);
  if (previousWater !== nextWater) {
    world.water[cellIndex] = nextWater;
    world.totalWater += world.water[cellIndex] - previousWater;
  }
  refreshWetCell(world, cellIndex);
}

export function refreshWetCell(world: VoxelWorld, cellIndex: number): void {
  if (world.water[cellIndex] > EPSILON && world.solid[cellIndex] === 0) {
    world.wetCells.add(cellIndex);
  } else {
    world.wetCells.delete(cellIndex);
  }
}

export function rebuildWetCells(world: VoxelWorld): void {
  world.wetCells.clear();
  world.totalWater = 0;
  for (let cellIndex = 0; cellIndex < world.water.length; cellIndex += 1) {
    world.totalWater += world.water[cellIndex];
    refreshWetCell(world, cellIndex);
  }
}

export function clearWaterMotion(world: VoxelWorld): void {
  world.waterFlow.fill(0);
  world.waterSurfaceOffset.fill(0);
  world.waterSurfaceVelocity.fill(0);
  world.waterFlux.clear();
  world.waterEdgeEvents.length = 0;
  world.waterVisualEvents.length = 0;
  world.activeFlowCells.clear();
  world.activeSurfaceCells.clear();
}

export function clearWaterMotionNearCells(world: VoxelWorld, cellIndexes: readonly number[], radius = 4): void {
  if (cellIndexes.length === 0) {
    return;
  }

  const affectedCells = new Set<number>();
  const affectedColumns = new Set<string>();
  for (const cellIndex of cellIndexes) {
    const cell = coords(world, cellIndex);
    for (let y = Math.max(0, cell.y - radius); y <= Math.min(world.height - 1, cell.y + radius); y += 1) {
      for (let z = Math.max(0, cell.z - radius); z <= Math.min(world.depth - 1, cell.z + radius); z += 1) {
        for (let x = Math.max(0, cell.x - radius); x <= Math.min(world.width - 1, cell.x + radius); x += 1) {
          const motionCellIndex = index(world, x, y, z);
          affectedCells.add(motionCellIndex);
          affectedColumns.add(`${x}:${z}`);
        }
      }
    }
  }

  for (const cellIndex of affectedCells) {
    const flowOffset = cellIndex * 3;
    world.waterFlow[flowOffset] = 0;
    world.waterFlow[flowOffset + 1] = 0;
    world.waterFlow[flowOffset + 2] = 0;
    world.waterSurfaceOffset[cellIndex] = 0;
    world.waterSurfaceVelocity[cellIndex] = 0;
    world.activeFlowCells.delete(cellIndex);
    world.activeSurfaceCells.delete(cellIndex);
  }

  for (const key of Array.from(world.waterFlux.keys())) {
    if (hydraulicEdgeKeyTouchesColumns(key, affectedColumns)) {
      world.waterFlux.delete(key);
    }
  }

  world.waterEdgeEvents = world.waterEdgeEvents.filter(
    (event) =>
      !affectedCells.has(event.sourceCellIndex) &&
      !affectedCells.has(event.targetCellIndex) &&
      !hydraulicEdgeKeyTouchesColumns(event.edgeKey, affectedColumns),
  );
  world.waterVisualEvents = world.waterVisualEvents.filter(
    (event) =>
      !affectedCells.has(event.sourceCellIndex) &&
      !affectedCells.has(event.targetCellIndex) &&
      !hydraulicEdgeKeyTouchesColumns(event.edgeKey, affectedColumns),
  );
}

function hydraulicEdgeKeyTouchesColumns(edgeKey: string, columns: Set<string>): boolean {
  for (const spanKey of edgeKey.split("|")) {
    const parts = spanKey.split(":");
    if (parts.length < 2) {
      continue;
    }

    if (columns.has(`${parts[0]}:${parts[1]}`)) {
      return true;
    }
  }

  return false;
}

export function getCapacity(world: VoxelWorld, x: number, y: number, z: number): number {
  if (!inBounds(world, x, y, z) || isSolid(world, x, y, z)) {
    return 0;
  }

  return Math.max(0, MAX_WATER - getWater(world, x, y, z));
}

export function wakeCell(world: VoxelWorld, x: number, y: number, z: number, target = world.activeCells): void {
  if (!inBounds(world, x, y, z)) {
    return;
  }

  target.add(index(world, x, y, z));
}

export function wakeNeighbors(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  target = world.activeCells,
): void {
  wakeCell(world, x, y, z, target);
  wakeCell(world, x + 1, y, z, target);
  wakeCell(world, x - 1, y, z, target);
  wakeCell(world, x, y + 1, z, target);
  wakeCell(world, x, y - 1, z, target);
  wakeCell(world, x, y, z + 1, target);
  wakeCell(world, x, y, z - 1, target);
}

export function clampWater(amount: number): number {
  if (amount <= EPSILON) {
    return 0;
  }

  return Math.min(MAX_WATER, Math.max(0, amount));
}

export function cellCenter(world: VoxelWorld, x: number, y: number, z: number): CellCoords {
  return {
    x: x - world.width / 2 + 0.5,
    y: y + 0.5,
    z: z - world.depth / 2 + 0.5,
  };
}

export function totalWater(world: VoxelWorld): number {
  return world.totalWater;
}
