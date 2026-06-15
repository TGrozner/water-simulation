import { createEmptyWorld, index, setCellWater, setWater, wakeCell } from "./grid";
import type { VoxelWorld } from "./types";

export const SCENE_PRESETS = ["generated-cavern"] as const;

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

type CaveRadius = {
  x: number;
  y: number;
  z: number;
};

type CaveTemplateRandomizer = {
  kind: "carve" | "fill";
  chance: number;
  center: CavePoint;
  radius: CaveRadius;
  jitter?: CaveRadius;
};

type CaveRoomTemplate = {
  name: string;
  center: CavePoint;
  radius: CaveRadius;
  jitter?: CaveRadius;
  randomizers?: CaveTemplateRandomizer[];
};

type WorldSize = {
  width: number;
  height: number;
  depth: number;
};

const GENERATED_CAVERN_WORLD_SIZE: WorldSize = {
  width: 72,
  height: 48,
  depth: 72,
};
const GENERATED_CAVERN_SEED = 0x5eedc0de;

const GENERATED_CAVERN_SIDE_ROOMS: CaveRoomTemplate[] = [
  {
    name: "upper survey pocket",
    center: { x: 19, y: 27, z: 52 },
    radius: { x: 8, y: 4, z: 7 },
    jitter: { x: 1.5, y: 1, z: 1.5 },
    randomizers: [
      { kind: "carve", chance: 0.7, center: { x: 13, y: 25, z: 55 }, radius: { x: 4, y: 2, z: 4 } },
      { kind: "fill", chance: 0.55, center: { x: 22, y: 25, z: 49 }, radius: { x: 2.5, y: 4, z: 2.5 } },
    ],
  },
  {
    name: "east mineral pocket",
    center: { x: 58, y: 25, z: 17 },
    radius: { x: 7, y: 4, z: 6 },
    jitter: { x: 1.25, y: 1, z: 1.25 },
    randomizers: [
      { kind: "carve", chance: 0.75, center: { x: 63, y: 22, z: 14 }, radius: { x: 4, y: 2.5, z: 4 } },
      { kind: "fill", chance: 0.5, center: { x: 55, y: 24, z: 18 }, radius: { x: 2.5, y: 4, z: 2.5 } },
    ],
  },
  {
    name: "low return gallery",
    center: { x: 32, y: 12, z: 17 },
    radius: { x: 8, y: 4, z: 6 },
    jitter: { x: 1, y: 0.75, z: 1 },
    randomizers: [
      { kind: "carve", chance: 0.65, center: { x: 27, y: 11, z: 13 }, radius: { x: 4, y: 2, z: 3.5 } },
      { kind: "fill", chance: 0.6, center: { x: 35, y: 11, z: 19 }, radius: { x: 2, y: 3.5, z: 2 } },
    ],
  },
  {
    name: "north overlook pocket",
    center: { x: 50, y: 31, z: 56 },
    radius: { x: 7, y: 4, z: 6 },
    jitter: { x: 1, y: 0.75, z: 1 },
    randomizers: [
      { kind: "carve", chance: 0.7, center: { x: 55, y: 30, z: 61 }, radius: { x: 3.5, y: 2, z: 3.5 } },
      { kind: "fill", chance: 0.55, center: { x: 47, y: 30, z: 52 }, radius: { x: 2.5, y: 4, z: 2.5 } },
    ],
  },
];

export const SCENE_PRESET_DETAILS: Record<ScenePresetId, ScenePreset> = {
  "generated-cavern": {
    id: "generated-cavern",
    name: "Seeded Cavern Expedition",
    description: "A deterministic template-built cavern: linked rooms, side pockets, plugs, hazards, and twin basins.",
  },
};

export function createWorld(preset: ScenePresetId = "generated-cavern"): VoxelWorld {
  const size = getSceneWorldSize(preset);
  const world = createEmptyWorld(size.width, size.height, size.depth);

  createGeneratedCavernTerrainMass(world);
  carveGeneratedCavernScene(world);

  return world;
}

function getSceneWorldSize(_preset: ScenePresetId): WorldSize {
  return GENERATED_CAVERN_WORLD_SIZE;
}

function createGeneratedCavernTerrainMass(world: VoxelWorld): void {
  for (let y = 0; y < world.height - 4; y += 1) {
    for (let z = 0; z < world.depth - 3; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        world.solid[index(world, x, y, z)] = 1;
      }
    }
  }

  carveBox(world, 0, 0, world.depth - 3, world.width - 1, world.height - 1, world.depth - 1);
}

function carveGeneratedCavernBaseScene(world: VoxelWorld): void {
  carveEllipsoid(world, 36, 23, 36, 16, 13, 14);
  carveEllipsoid(world, 38, 11, 36, 18, 7, 18);
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
  carveGeneratedCavernGalleries(world);

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
  addGeneratedCavernStrata(world);

  addRaggedSolidBox(world, 19, 33, 24, 23, 43, 31, 11);
  addRaggedSolidBox(world, 28, 22, 28, 36, 31, 36, 23);
  addRaggedSolidBox(world, 44, 4, 21, 56, 11, 31, 37);
  addRaggedSolidBox(world, 44, 4, 47, 56, 11, 57, 41);
  addRaggedSolidBox(world, 61, 3, 32, 68, 10, 43, 53);
  addRaggedSolidBox(world, 30, 0, 32, 43, 3, 43, 59);
  addRaggedSolidBox(world, 10, 19, 42, 18, 22, 51, 67);
  addRaggedSolidBox(world, 49, 21, 18, 59, 24, 25, 71);
  addRaggedSolidBox(world, 13, 30, 20, 21, 32, 27, 79);
  addRaggedSolidBox(world, 52, 29, 47, 61, 31, 56, 83);

  addReservoirTank(world, 7, 22, 32, 44, 18, 33);
  fillWaterBox(world, 8, 21, 33, 44, 19, 32);
  fillWaterBox(world, 14, 25, 4, 5, 48, 57);
  fillWaterBox(world, 42, 51, 4, 5, 17, 27);
}

function carveGeneratedCavernScene(world: VoxelWorld): void {
  carveGeneratedCavernBaseScene(world);

  const random = createSeededRandom(GENERATED_CAVERN_SEED);
  const placedRooms = GENERATED_CAVERN_SIDE_ROOMS.map((room) => carveCaveTemplateRoom(world, room, random));

  carveTemplateTunnel(
    world,
    [
      { x: 27, y: 27, z: 26 },
      { x: 22, y: 27, z: 36 },
      placedRooms[0].center,
    ],
    2.2,
    2.6,
    random,
    1.2,
  );
  carveTemplateTunnel(
    world,
    [
      { x: 49, y: 22, z: 29 },
      { x: 54, y: 24, z: 22 },
      placedRooms[1].center,
    ],
    2.1,
    2.4,
    random,
    1,
  );
  carveTemplateTunnel(
    world,
    [
      { x: 32, y: 12, z: 29 },
      { x: 30, y: 12, z: 22 },
      placedRooms[2].center,
    ],
    2,
    2.3,
    random,
    0.8,
  );
  carveTemplateTunnel(
    world,
    [
      { x: 52, y: 23, z: 54 },
      { x: 51, y: 28, z: 56 },
      placedRooms[3].center,
    ],
    2.1,
    2.5,
    random,
    0.8,
  );

  addGeneratedCavernDebris(world, random);
}

function carveCaveTemplateRoom(
  world: VoxelWorld,
  template: CaveRoomTemplate,
  random: () => number,
): CaveRoomTemplate {
  const center = jitterPoint(template.center, template.jitter, random);
  const radius = jitterRadius(template.radius, 0.1, random);
  const placedTemplate = { ...template, center, radius };

  carveEllipsoid(world, center.x, center.y, center.z, radius.x, radius.y, radius.z);
  for (const randomizer of template.randomizers ?? []) {
    if (random() > randomizer.chance) {
      continue;
    }

    const randomizerCenter = jitterPoint(randomizer.center, randomizer.jitter, random);
    const randomizerRadius = jitterRadius(randomizer.radius, 0.18, random);
    if (randomizer.kind === "carve") {
      carveEllipsoid(
        world,
        randomizerCenter.x,
        randomizerCenter.y,
        randomizerCenter.z,
        randomizerRadius.x,
        randomizerRadius.y,
        randomizerRadius.z,
      );
    } else {
      addSolidEllipsoid(
        world,
        randomizerCenter.x,
        randomizerCenter.y,
        randomizerCenter.z,
        randomizerRadius.x,
        randomizerRadius.y,
        randomizerRadius.z,
      );
    }
  }

  return placedTemplate;
}

function carveTemplateTunnel(
  world: VoxelWorld,
  points: CavePoint[],
  radiusY: number,
  radiusZ: number,
  random: () => number,
  midpointJitter = 0,
): void {
  const jitteredPoints = points.map((point, pointIndex) => {
    if (pointIndex === 0 || pointIndex === points.length - 1 || midpointJitter <= 0) {
      return point;
    }

    return {
      x: point.x + centeredRandom(random) * midpointJitter,
      y: point.y + centeredRandom(random) * Math.min(1, midpointJitter),
      z: point.z + centeredRandom(random) * midpointJitter,
    };
  });

  carveTunnel(world, jitteredPoints, radiusY, radiusZ);
}

function addGeneratedCavernDebris(world: VoxelWorld, random: () => number): void {
  const debris = [
    { center: { x: 41, y: 27, z: 34 }, radius: { x: 2.5, y: 5, z: 2.5 }, chance: 0.7 },
    { center: { x: 18, y: 22, z: 51 }, radius: { x: 2, y: 4, z: 2 }, chance: 0.6 },
    { center: { x: 60, y: 21, z: 17 }, radius: { x: 2, y: 3.5, z: 2 }, chance: 0.55 },
    { center: { x: 50, y: 10, z: 37 }, radius: { x: 2.5, y: 4, z: 2.5 }, chance: 0.65 },
    { center: { x: 30, y: 8, z: 19 }, radius: { x: 2, y: 3, z: 2 }, chance: 0.55 },
  ];

  for (const item of debris) {
    if (random() > item.chance) {
      continue;
    }

    const center = jitterPoint(item.center, { x: 1, y: 0.5, z: 1 }, random);
    const radius = jitterRadius(item.radius, 0.15, random);
    addSolidEllipsoid(world, center.x, center.y, center.z, radius.x, radius.y, radius.z);
  }
}

function jitterPoint(point: CavePoint, jitter: CaveRadius | undefined, random: () => number): CavePoint {
  if (!jitter) {
    return point;
  }

  return {
    x: point.x + centeredRandom(random) * jitter.x,
    y: point.y + centeredRandom(random) * jitter.y,
    z: point.z + centeredRandom(random) * jitter.z,
  };
}

function jitterRadius(radius: CaveRadius, strength: number, random: () => number): CaveRadius {
  return {
    x: Math.max(1, radius.x * (1 + centeredRandom(random) * strength)),
    y: Math.max(1, radius.y * (1 + centeredRandom(random) * strength)),
    z: Math.max(1, radius.z * (1 + centeredRandom(random) * strength)),
  };
}

function centeredRandom(random: () => number): number {
  return random() * 2 - 1;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function carveGeneratedCavernGalleries(world: VoxelWorld): void {
  carveTunnel(
    world,
    [
      { x: 29, y: 27, z: 38 },
      { x: 24, y: 27, z: 43 },
      { x: 18, y: 26, z: 49 },
    ],
    2.2,
    2.6,
  );
  carveTunnel(
    world,
    [
      { x: 48, y: 23, z: 29 },
      { x: 53, y: 24, z: 22 },
      { x: 56, y: 24, z: 16 },
    ],
    2.1,
    2.4,
  );
  carveTunnel(
    world,
    [
      { x: 32, y: 12, z: 29 },
      { x: 27, y: 13, z: 22 },
      { x: 23, y: 13, z: 16 },
    ],
    2,
    2.4,
  );

  carveEllipsoid(world, 18, 26, 49, 8, 3, 6);
  carveEllipsoid(world, 56, 24, 16, 7, 3, 6);
  carveEllipsoid(world, 23, 13, 16, 7, 4, 5);
}

function addGeneratedCavernStrata(world: VoxelWorld): void {
  addRaggedSolidBox(world, 24, 14, 38, 32, 29, 42, 101);
  addRaggedSolidBox(world, 43, 14, 30, 50, 27, 35, 107);
  addRaggedSolidBox(world, 24, 4, 35, 31, 13, 43, 109);
  addRaggedSolidBox(world, 10, 4, 47, 13, 9, 54, 113);
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

function addRaggedSolidBox(
  world: VoxelWorld,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  seed: number,
): void {
  addSolidBox(world, minX, minY, minZ, maxX, maxY, maxZ);

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const boundaryDistance = Math.min(x - minX, maxX - x, y - minY, maxY - y, z - minZ, maxZ - z);
        if (boundaryDistance > 0) {
          continue;
        }

        const cornerPressure =
          Number(x === minX || x === maxX) + Number(y === minY || y === maxY) + Number(z === minZ || z === maxZ);
        const strata = positiveModulo(y + Math.floor(x * 0.3) + Math.floor(z * 0.2) + seed, 5) === 0 ? 0.18 : 0;
        const threshold = 0.22 + cornerPressure * 0.06 + strata;
        if (getCavernShapeNoise(x + seed, y - seed, z + seed * 2) > threshold) {
          continue;
        }

        const cellIndex = index(world, x, y, z);
        world.solid[cellIndex] = 0;
        setCellWater(world, cellIndex, 0);
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

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function getCavernShapeNoise(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, -2048144789);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}
