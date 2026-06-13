import { index, inBounds, wakeNeighbors } from "./grid";
import type { ScenePresetId } from "./createWorld";
import type { VoxelWorld } from "./types";

export function openSceneDrain(world: VoxelWorld, preset: ScenePresetId): number {
  if (preset === "shaft") {
    return (
      clearBox(world, 11, 16, 13, 20, 25, 31) +
      clearBox(world, 16, 23, 10, 16, 24, 27)
    );
  }

  if (preset === "basin") {
    return (
      clearBox(world, 11, 16, 15, 21, 25, 31) +
      clearBox(world, 16, 23, 10, 16, 24, 28)
    );
  }

  if (preset === "leak") {
    return (
      clearBox(world, 13, 16, 11, 18, 25, 31) +
      clearBox(world, 15, 24, 10, 16, 24, 28)
    );
  }

  if (preset === "cascade") {
    return (
      clearBox(world, 13, 18, 15, 23, 24, 31) +
      clearBox(world, 17, 24, 16, 20, 22, 28) +
      clearBox(world, 22, 27, 10, 16, 23, 27)
    );
  }

  if (preset === "puzzle") {
    return (
      clearBox(world, 13, 19, 14, 22, 23, 31) +
      clearBox(world, 20, 26, 8, 14, 23, 28) +
      clearBox(world, 29, 33, 4, 8, 23, 28)
    );
  }

  if (preset === "network") {
    return (
      clearBox(world, 12, 18, 13, 21, 25, 31) +
      clearBox(world, 18, 26, 10, 14, 23, 28) +
      clearBox(world, 25, 32, 5, 10, 23, 27)
    );
  }

  return (
    clearBox(world, 12, 17, 13, 20, 25, 31) +
    clearBox(world, 16, 23, 9, 15, 24, 28)
  );
}

function clearBox(
  world: VoxelWorld,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): number {
  let removed = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (!inBounds(world, x, y, z)) {
          continue;
        }

        const cellIndex = index(world, x, y, z);
        if (world.solid[cellIndex] === 1) {
          removed += 1;
        }
        world.solid[cellIndex] = 0;
        wakeNeighbors(world, x, y, z);
      }
    }
  }

  return removed;
}
