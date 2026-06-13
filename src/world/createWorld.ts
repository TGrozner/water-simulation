import { createEmptyWorld, index, setWater, wakeCell } from "./grid";
import { WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH, type VoxelWorld } from "./types";

export const SCENE_PRESETS = ["sluice", "splitter"] as const;

export type ScenePresetId = (typeof SCENE_PRESETS)[number];

export type ScenePreset = {
  id: ScenePresetId;
  name: string;
  description: string;
};

export const SCENE_PRESET_DETAILS: Record<ScenePresetId, ScenePreset> = {
  sluice: {
    id: "sluice",
    name: "Sluice Gates",
    description: "Open two gates to drop water from an upper pool into a lower spillway.",
  },
  splitter: {
    id: "splitter",
    name: "Split Basin",
    description: "Release water into a fork that divides flow between two lower cavities.",
  },
};

export function createWorld(preset: ScenePresetId = "sluice"): VoxelWorld {
  const world = createEmptyWorld(WORLD_WIDTH, WORLD_HEIGHT, WORLD_DEPTH);

  createTerrainMass(world);
  if (preset === "splitter") {
    carveSplitterScene(world);
  } else {
    carveSluiceScene(world);
  }

  return world;
}

function createTerrainMass(world: VoxelWorld): void {
  for (let y = 0; y < 24; y += 1) {
    for (let z = 4; z < 35; z += 1) {
      for (let x = 4; x < world.width - 4; x += 1) {
        world.solid[index(world, x, y, z)] = 1;
      }
    }
  }
}

function carveSharedCutaway(world: VoxelWorld): void {
  carveBox(world, 0, 0, 35, world.width - 1, world.height - 1, world.depth - 1);
  carveBox(world, 4, 0, 24, world.width - 5, 23, 34);
}

function carveSluiceScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 15, 13, 18, 34, 17, 31);
  carveBox(world, 18, 8, 18, 38, 12, 31);
  carveBox(world, 21, 3, 20, 39, 7, 30);
  carveBox(world, 25, 1, 22, 35, 2, 28);
  addSolidBox(world, 15, 13, 24, 20, 18, 31);
  addSolidBox(world, 24, 8, 23, 30, 13, 28);

  addReservoirTank(world, 7, 15, 14, 24, 24, 31);
  fillWaterBox(world, 8, 14, 15, 23, 25, 30);
}

function carveSplitterScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 15, 9, 19, 24, 15, 31);
  carveBox(world, 23, 7, 21, 31, 12, 29);
  carveBox(world, 30, 4, 16, 40, 8, 23);
  carveBox(world, 30, 4, 27, 40, 8, 33);
  carveBox(world, 33, 1, 17, 39, 3, 22);
  carveBox(world, 33, 1, 28, 39, 3, 32);
  addSolidBox(world, 14, 13, 24, 19, 20, 31);
  addSolidBox(world, 25, 7, 21, 30, 12, 29);

  addReservoirTank(world, 7, 15, 14, 24, 24, 31);
  fillWaterBox(world, 8, 14, 15, 23, 25, 30);
}

function fillWaterBox(
  world: VoxelWorld,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): void {
  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        setWater(world, x, y, z, 1);
        wakeCell(world, x, y, z);
      }
    }
  }
}

function addReservoirTank(
  world: VoxelWorld,
  minX: number,
  maxX: number,
  floorY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): void {
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      world.solid[index(world, x, floorY, z)] = 1;
    }
  }

  for (let y = floorY + 1; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      world.solid[index(world, minX, y, z)] = 1;
      world.solid[index(world, maxX, y, z)] = 1;
    }

    for (let x = minX; x <= maxX; x += 1) {
      world.solid[index(world, x, y, minZ)] = 1;
      world.solid[index(world, x, y, maxZ)] = 1;
    }
  }
}

function addSolidBox(
  world: VoxelWorld,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        world.solid[index(world, x, y, z)] = 1;
        world.water[index(world, x, y, z)] = 0;
      }
    }
  }
}

function carveBox(
  world: VoxelWorld,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        world.solid[index(world, x, y, z)] = 0;
      }
    }
  }
}
