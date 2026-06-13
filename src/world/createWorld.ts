import { createEmptyWorld, index, setWater, wakeCell } from "./grid";
import { WORLD_DEPTH, WORLD_HEIGHT, WORLD_WIDTH, type VoxelWorld } from "./types";

export const SCENE_PRESETS = ["sluice", "splitter"] as const;

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
