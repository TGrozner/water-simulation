import { createEmptyWorld, index, setCellWater, setWater, wakeCell } from "./grid";
import { WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH, type VoxelWorld } from "./types";

export const SCENE_PRESETS = ["sluice", "splitter", "braid", "divide", "deep-cavern"] as const;

export type ScenePresetId = (typeof SCENE_PRESETS)[number];

export type ScenePreset = {
  id: ScenePresetId;
  name: string;
  description: string;
};

type CavePoint = {
  x: number;
  y: number;
  z: number;
};

type WorldSize = {
  width: number;
  height: number;
  depth: number;
};

const DEFAULT_WORLD_SIZE: WorldSize = {
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  depth: WORLD_DEPTH,
};
const DEEP_CAVERN_WORLD_SIZE: WorldSize = {
  width: 72,
  height: 48,
  depth: 72,
};

export const SCENE_PRESET_DETAILS: Record<ScenePresetId, ScenePreset> = {
  sluice: {
    id: "sluice",
    name: "Sluice Gates",
    description: "Open two gates to drop water from an upper pool into a lower spillway.",
  },
  splitter: {
    id: "splitter",
    name: "Forked Cavern",
    description: "Mine through a forked cave network and cut a route for water into one lower cavern.",
  },
  braid: {
    id: "braid",
    name: "Split Path Cavern",
    description: "Release the reservoir, then hand-carve either low branch into a lower basin.",
  },
  divide: {
    id: "divide",
    name: "Twin Basin Divide",
    description: "Carve two outlets from one release chamber so water reaches both lower basins.",
  },
  "deep-cavern": {
    id: "deep-cavern",
    name: "Deep Cavern Expedition",
    description: "Drop a high reservoir through a huge vertical cave and split the flow into two distant lower basins.",
  },
};

export function createWorld(preset: ScenePresetId = "sluice"): VoxelWorld {
  const size = getSceneWorldSize(preset);
  const world = createEmptyWorld(size.width, size.height, size.depth);

  if (preset === "deep-cavern") {
    createDeepCavernTerrainMass(world);
    carveDeepCavernScene(world);
    return world;
  }

  createTerrainMass(world);
  if (preset === "splitter") {
    carveSplitterScene(world);
  } else if (preset === "braid") {
    carveBraidScene(world);
  } else if (preset === "divide") {
    carveDivideScene(world);
  } else {
    carveSluiceScene(world);
  }

  return world;
}

function getSceneWorldSize(preset: ScenePresetId): WorldSize {
  return preset === "deep-cavern" ? DEEP_CAVERN_WORLD_SIZE : DEFAULT_WORLD_SIZE;
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

function createDeepCavernTerrainMass(world: VoxelWorld): void {
  for (let y = 0; y < world.height - 4; y += 1) {
    for (let z = 0; z < world.depth - 3; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        world.solid[index(world, x, y, z)] = 1;
      }
    }
  }

  carveBox(world, 0, 0, world.depth - 3, world.width - 1, world.height - 1, world.depth - 1);
}

function carveSharedCutaway(world: VoxelWorld): void {
  carveBox(world, 0, 0, 35, world.width - 1, world.height - 1, world.depth - 1);
}

function carveSluiceScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveBox(world, 15, 13, 18, 34, 17, 31);
  carveBox(world, 18, 8, 18, 38, 12, 31);
  carveBox(world, 21, 3, 20, 39, 7, 30);
  carveBox(world, 25, 1, 22, 35, 2, 28);
  carveEllipsoid(world, 25, 15, 25, 13, 4, 8);
  carveEllipsoid(world, 31, 10, 25, 13, 4, 7);
  carveEllipsoid(world, 31, 5, 25, 10, 3, 5);
  carveEllipsoid(world, 18, 16, 20, 6, 3, 4);
  carveEllipsoid(world, 36, 8, 30, 5, 3, 4);
  addSolidBox(world, 15, 13, 24, 20, 18, 31);
  addSolidBox(world, 21, 8, 20, 39, 13, 30);

  addReservoirTank(world, 7, 15, 14, 24, 24, 31);
  fillWaterBox(world, 8, 14, 15, 23, 25, 30);
}

function carveSplitterScene(world: VoxelWorld): void {
  carveSharedCutaway(world);
  carveEllipsoid(world, 18, 14, 25, 8, 5, 8);
  carveEllipsoid(world, 24, 11, 25, 7, 5, 6);
  carveEllipsoid(world, 29, 8, 25, 7, 4, 5);
  carveTunnel(
    world,
    [
      { x: 14, y: 16, z: 27 },
      { x: 19, y: 14, z: 25 },
      { x: 25, y: 11, z: 25 },
      { x: 30, y: 8, z: 24 },
    ],
    3.4,
    3.1,
  );
  carveTunnel(
    world,
    [
      { x: 28, y: 8, z: 21 },
      { x: 32, y: 7, z: 20 },
      { x: 37, y: 5, z: 20 },
      { x: 40, y: 4, z: 19 },
    ],
    3.2,
    2.6,
  );
  carveTunnel(
    world,
    [
      { x: 28, y: 8, z: 29 },
      { x: 32, y: 7, z: 30 },
      { x: 37, y: 5, z: 30 },
      { x: 40, y: 4, z: 31 },
    ],
    3.2,
    2.6,
  );
  carveEllipsoid(world, 35, 5, 19, 8, 4, 5);
  carveEllipsoid(world, 35, 5, 30, 8, 4, 5);
  carveEllipsoid(world, 39, 4, 25, 5, 3, 8);
  carveEllipsoid(world, 23, 18, 27, 4, 3, 4);
  carveEllipsoid(world, 31, 13, 20, 4, 3, 3);
  carveEllipsoid(world, 31, 13, 30, 4, 3, 3);
  carveEllipsoid(world, 38, 9, 25, 4, 4, 4);
  addSolidBox(world, 14, 13, 24, 19, 20, 31);
  addSolidBox(world, 25, 1, 16, 30, 15, 34);
  addSolidBox(world, 31, 1, 18, 39, 5, 22);
  addSolidBox(world, 31, 1, 28, 39, 5, 32);
  addSolidBox(world, 43, 0, 4, 43, 12, 34);
  addSolidBox(world, 4, 0, 35, 43, 12, 35);

  addReservoirTank(world, 7, 15, 14, 24, 24, 31);
  fillWaterBox(world, 8, 14, 15, 23, 25, 30);
}

function carveBraidScene(world: VoxelWorld): void {
  carveSplitterScene(world);
  carveEllipsoid(world, 22, 13, 25, 5, 3, 7);
  carveEllipsoid(world, 34, 3, 19, 7, 2.5, 4);
  carveEllipsoid(world, 34, 3, 31, 7, 2.5, 4);
  addSolidBox(world, 25, 1, 16, 39, 13, 25);
  addSolidBox(world, 25, 1, 25, 39, 13, 34);
  addSolidBox(world, 32, 1, 23, 42, 7, 27);
}

function carveDivideScene(world: VoxelWorld): void {
  carveBraidScene(world);
  addSolidBox(world, 30, 1, 23, 40, 9, 27);
}

function carveDeepCavernScene(world: VoxelWorld): void {
  carveEllipsoid(world, 36, 23, 36, 20, 16, 18);
  carveEllipsoid(world, 38, 11, 36, 23, 9, 23);
  carveEllipsoid(world, 32, 36, 35, 16, 8, 15);
  carveEllipsoid(world, 52, 23, 24, 14, 9, 11);
  carveEllipsoid(world, 53, 20, 54, 14, 10, 12);
  carveEllipsoid(world, 18, 24, 23, 12, 8, 10);
  carveEllipsoid(world, 22, 9, 51, 13, 6, 11);
  carveEllipsoid(world, 59, 7, 20, 11, 5, 9);
  carveEllipsoid(world, 58, 7, 58, 11, 5, 9);

  carveTunnel(
    world,
    [
      { x: 21, y: 37, z: 26 },
      { x: 27, y: 34, z: 29 },
      { x: 33, y: 29, z: 33 },
      { x: 37, y: 24, z: 36 },
    ],
    4.2,
    4.5,
  );
  carveTunnel(
    world,
    [
      { x: 37, y: 23, z: 36 },
      { x: 39, y: 17, z: 36 },
      { x: 40, y: 9, z: 36 },
    ],
    5,
    5.2,
  );
  carveTunnel(
    world,
    [
      { x: 40, y: 8, z: 33 },
      { x: 47, y: 8, z: 27 },
      { x: 57, y: 7, z: 21 },
      { x: 64, y: 6, z: 19 },
    ],
    3.5,
    5.4,
  );
  carveTunnel(
    world,
    [
      { x: 40, y: 8, z: 41 },
      { x: 48, y: 8, z: 49 },
      { x: 57, y: 7, z: 58 },
      { x: 64, y: 6, z: 60 },
    ],
    3.5,
    5.4,
  );
  carveTunnel(
    world,
    [
      { x: 27, y: 27, z: 26 },
      { x: 20, y: 23, z: 24 },
      { x: 16, y: 15, z: 32 },
      { x: 22, y: 9, z: 46 },
      { x: 29, y: 7, z: 52 },
    ],
    3.8,
    4.2,
  );
  carveTunnel(
    world,
    [
      { x: 49, y: 22, z: 29 },
      { x: 58, y: 18, z: 36 },
      { x: 50, y: 14, z: 47 },
      { x: 40, y: 11, z: 41 },
    ],
    3.2,
    3.8,
  );
  carveTunnel(
    world,
    [
      { x: 18, y: 24, z: 23 },
      { x: 13, y: 21, z: 31 },
      { x: 15, y: 15, z: 43 },
      { x: 22, y: 9, z: 51 },
    ],
    2.8,
    3.4,
  );
  carveTunnel(
    world,
    [
      { x: 52, y: 23, z: 54 },
      { x: 61, y: 18, z: 48 },
      { x: 62, y: 13, z: 35 },
      { x: 52, y: 9, z: 25 },
    ],
    2.8,
    3.4,
  );

  addSolidEllipsoid(world, 36, 6, 36, 5, 9, 5);
  addSolidEllipsoid(world, 30, 14, 27, 4, 10, 4);
  addSolidEllipsoid(world, 47, 17, 48, 4, 12, 4);
  addSolidEllipsoid(world, 25, 2, 48, 5, 6, 5);
  addSolidEllipsoid(world, 53, 2, 29, 4, 6, 4);
  addSolidEllipsoid(world, 19, 34, 25, 4, 6, 4);
  addSolidEllipsoid(world, 16, 29, 28, 3, 8, 3);
  addSolidEllipsoid(world, 56, 27, 54, 3, 9, 3);
  addSolidEllipsoid(world, 18, 41, 39, 3, 5, 3);
  addSolidEllipsoid(world, 58, 38, 28, 3, 6, 3);
  addSolidEllipsoid(world, 47, 34, 18, 2.5, 5, 2.5);

  addSolidBox(world, 19, 33, 24, 23, 43, 31);
  addSolidBox(world, 28, 22, 28, 36, 31, 36);
  addSolidBox(world, 44, 4, 21, 56, 11, 31);
  addSolidBox(world, 44, 4, 47, 56, 11, 57);
  addSolidBox(world, 61, 3, 32, 68, 10, 43);
  addSolidBox(world, 30, 0, 32, 43, 3, 43);
  addSolidBox(world, 10, 19, 42, 18, 22, 51);
  addSolidBox(world, 49, 21, 18, 59, 24, 25);
  addSolidBox(world, 13, 30, 20, 21, 32, 27);
  addSolidBox(world, 52, 29, 47, 61, 31, 56);

  addReservoirTank(world, 7, 22, 32, 44, 18, 33);
  fillWaterBox(world, 8, 21, 33, 44, 19, 32);
  fillWaterBox(world, 14, 25, 4, 5, 48, 57);
  fillWaterBox(world, 42, 51, 4, 5, 17, 27);
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
  carveBox(world, minX, floorY + 1, minZ, maxX, maxY, maxZ);

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
        setCellWater(world, index(world, x, y, z), 0);
      }
    }
  }
}

function addSolidEllipsoid(
  world: VoxelWorld,
  centerX: number,
  centerY: number,
  centerZ: number,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
): void {
  const minX = Math.floor(centerX - radiusX);
  const maxX = Math.ceil(centerX + radiusX);
  const minY = Math.floor(centerY - radiusY);
  const maxY = Math.ceil(centerY + radiusY);
  const minZ = Math.floor(centerZ - radiusZ);
  const maxZ = Math.ceil(centerZ + radiusZ);

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
          continue;
        }

        const dx = (x - centerX) / radiusX;
        const dy = (y - centerY) / radiusY;
        const dz = (z - centerZ) / radiusZ;
        if (dx * dx + dy * dy + dz * dz <= 1) {
          world.solid[index(world, x, y, z)] = 1;
          setCellWater(world, index(world, x, y, z), 0);
        }
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

function carveEllipsoid(
  world: VoxelWorld,
  centerX: number,
  centerY: number,
  centerZ: number,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
): void {
  const minX = Math.floor(centerX - radiusX);
  const maxX = Math.ceil(centerX + radiusX);
  const minY = Math.floor(centerY - radiusY);
  const maxY = Math.ceil(centerY + radiusY);
  const minZ = Math.floor(centerZ - radiusZ);
  const maxZ = Math.ceil(centerZ + radiusZ);

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
          continue;
        }

        const dx = (x - centerX) / radiusX;
        const dy = (y - centerY) / radiusY;
        const dz = (z - centerZ) / radiusZ;
        if (dx * dx + dy * dy + dz * dz <= 1) {
          world.solid[index(world, x, y, z)] = 0;
        }
      }
    }
  }
}

function carveTunnel(world: VoxelWorld, points: CavePoint[], radiusY: number, radiusZ: number): void {
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz)));

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      carveEllipsoid(world, from.x + dx * t, from.y + dy * t, from.z + dz * t, 3.6, radiusY, radiusZ);
    }
  }
}
