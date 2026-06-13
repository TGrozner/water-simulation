import { coords, index, inBounds, wakeNeighbors } from "./grid";
import type { VoxelWorld } from "./types";

export type DigResult = {
  removed: number;
  changedCells: number[];
};

export function digSphere(world: VoxelWorld, centerIndex: number, radius: number): DigResult {
  const candidateCells = collectDigCells(world, centerIndex, radius);
  const changedCells: number[] = [];

  for (const cellIndex of candidateCells) {
    if (world.solid[cellIndex] === 0) {
      continue;
    }

    const cell = coords(world, cellIndex);
    world.solid[cellIndex] = 0;
    changedCells.push(cellIndex);
    wakeNeighbors(world, cell.x, cell.y, cell.z);
  }

  return {
    removed: changedCells.length,
    changedCells,
  };
}

export function collectDigCells(world: VoxelWorld, centerIndex: number, radius: number): number[] {
  const center = coords(world, centerIndex);
  const radiusSq = radius * radius;
  const minX = Math.floor(center.x - radius);
  const maxX = Math.ceil(center.x + radius);
  const minY = Math.floor(center.y - radius);
  const maxY = Math.ceil(center.y + radius);
  const minZ = Math.floor(center.z - radius);
  const maxZ = Math.ceil(center.z + radius);
  const cells: number[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!inBounds(world, x, y, z)) {
          continue;
        }

        const dx = x - center.x;
        const dy = y - center.y;
        const dz = z - center.z;
        if (dx * dx + dy * dy + dz * dz > radiusSq) {
          continue;
        }

        cells.push(index(world, x, y, z));
      }
    }
  }

  return cells;
}
