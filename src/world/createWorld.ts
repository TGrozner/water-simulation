import { createEmptyWorld, index, setWater, wakeCell } from "./grid";
import { WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH, type VoxelWorld } from "./types";

export const SCENE_PRESETS = ["reservoir", "shaft", "basin", "leak", "cascade", "puzzle", "network"] as const;

export type ScenePresetId = (typeof SCENE_PRESETS)[number];

export type ScenePreset = {
  id: ScenePresetId;
  name: string;
  description: string;
};

export const SCENE_PRESET_DETAILS: Record<ScenePresetId, ScenePreset> = {
  reservoir: {
    id: "reservoir",
    name: "Reservoir Gate",
    description: "Open the tank wall to drain water into the cave.",
  },
  shaft: {
    id: "shaft",
    name: "Vertical Shaft",
    description: "Dig below the tank and watch water fall through a deep shaft.",
  },
  basin: {
    id: "basin",
    name: "Lower Basin",
    description: "Release water into a stepped basin and let it settle.",
  },
  leak: {
    id: "leak",
    name: "Side Leak",
    description: "Break a side wall so the reservoir leaks laterally.",
  },
  cascade: {
    id: "cascade",
    name: "Cascade Steps",
    description: "Release water through staggered drops into lower shelves.",
  },
  puzzle: {
    id: "puzzle",
    name: "Plug Puzzle",
    description: "Open a tank, then punch through a second plug into the lower bowl.",
  },
  network: {
    id: "network",
    name: "Cave Network",
    description: "Drain a reservoir into connected side pockets and a central sink.",
  },
};

export function createWorld(preset: ScenePresetId = "reservoir"): VoxelWorld {
  const world = createEmptyWorld(WORLD_WIDTH, WORLD_HEIGHT, WORLD_DEPTH);

  createTerrainMass(world);
  if (preset === "shaft") {
    carveShaftScene(world);
  } else if (preset === "basin") {
    carveBasinScene(world);
  } else if (preset === "leak") {
    carveLeakScene(world);
  } else if (preset === "cascade") {
    carveCascadeScene(world);
  } else if (preset === "puzzle") {
    carvePuzzleScene(world);
  } else if (preset === "network") {
    carveNetworkScene(world);
  } else {
    carveReservoirScene(world);
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

function carveReservoirScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 18, 5, 16, 33, 13, 32);
  carveBox(world, 22, 1, 20, 34, 4, 31);
  carveBox(world, 18, 11, 22, 22, 13, 26);
  carveBox(world, 29, 13, 22, 32, 19, 26);

  addReservoirTank(world, 8, 16, 13, 20, 25, 31);
  fillWaterBox(world, 9, 15, 14, 20, 26, 30);
  addBridgePillars(world);
}

function carveShaftScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 18, 4, 16, 33, 12, 31);
  carveBox(world, 22, 1, 20, 32, 3, 30);
  carveBox(world, 23, 4, 22, 27, 21, 26);

  addReservoirTank(world, 8, 16, 13, 20, 25, 31);
  fillWaterBox(world, 9, 15, 14, 20, 26, 30);
  addBridgePillars(world);
}

function carveBasinScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 15, 8, 16, 35, 14, 32);
  carveBox(world, 19, 4, 19, 34, 7, 31);
  carveBox(world, 23, 1, 22, 32, 3, 29);
  carveBox(world, 17, 11, 23, 22, 16, 28);

  addReservoirTank(world, 8, 16, 15, 21, 25, 31);
  fillWaterBox(world, 9, 15, 16, 21, 26, 30);
}

function carveLeakScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 18, 7, 16, 34, 14, 32);
  carveBox(world, 24, 4, 20, 34, 6, 31);
  carveBox(world, 31, 10, 22, 35, 13, 27);

  addReservoirTank(world, 7, 15, 11, 18, 25, 31);
  fillWaterBox(world, 8, 14, 12, 18, 26, 30);
}

function carveCascadeScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 17, 16, 18, 33, 20, 31);
  carveBox(world, 21, 11, 18, 36, 15, 31);
  carveBox(world, 24, 6, 19, 38, 10, 31);
  carveBox(world, 28, 1, 21, 39, 5, 30);
  carveBox(world, 23, 6, 23, 27, 20, 27);
  carveBox(world, 31, 1, 24, 35, 12, 28);

  addReservoirTank(world, 7, 16, 15, 25, 24, 31);
  fillWaterBox(world, 8, 15, 16, 24, 25, 30);
}

function carvePuzzleScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 17, 9, 17, 30, 15, 31);
  carveBox(world, 23, 5, 19, 35, 8, 30);
  carveBox(world, 27, 1, 21, 39, 4, 29);
  carveBox(world, 31, 6, 23, 35, 13, 27);

  addReservoirTank(world, 7, 16, 14, 24, 23, 31);
  fillWaterBox(world, 8, 15, 15, 23, 24, 30);
}

function carveNetworkScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 15, 8, 16, 26, 14, 30);
  carveBox(world, 28, 8, 18, 39, 14, 31);
  carveBox(world, 21, 4, 20, 34, 7, 29);
  carveBox(world, 24, 1, 22, 32, 3, 28);
  carveBox(world, 20, 10, 23, 34, 12, 25);
  carveBox(world, 31, 5, 24, 35, 12, 27);

  addReservoirTank(world, 7, 15, 13, 24, 25, 31);
  fillWaterBox(world, 8, 14, 14, 23, 26, 30);
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

function addBridgePillars(world: VoxelWorld): void {
  for (let x = 24; x <= 30; x += 1) {
    for (let z = 22; z <= 28; z += 1) {
      world.solid[index(world, x, 5, z)] = 1;
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
