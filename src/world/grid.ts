import { EPSILON, MAX_WATER, type CellCoords, type VoxelWorld } from "./types";

export function createEmptyWorld(width: number, height: number, depth: number): VoxelWorld {
  const cellCount = width * height * depth;

  return {
    width,
    height,
    depth,
    solid: new Uint8Array(cellCount),
    water: new Float32Array(cellCount),
    activeCells: new Set<number>(),
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

  const cellIndex = index(world, x, y, z);
  world.water[cellIndex] = world.solid[cellIndex] === 1 ? 0 : clampWater(amount);
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
  let total = 0;

  for (let i = 0; i < world.water.length; i += 1) {
    total += world.water[i];
  }

  return total;
}
