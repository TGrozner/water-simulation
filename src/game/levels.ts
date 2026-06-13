import { totalWater } from "../world/grid";
import type { ScenePresetId } from "../world/createWorld";
import type { VoxelWorld } from "../world/types";

export type ObjectiveZone = {
  id: string;
  label: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  targetWater: number;
  maxWater?: number;
};

export type GameLevel = {
  id: string;
  name: string;
  scene: ScenePresetId;
  brief: string;
  successText: string;
  zones: ObjectiveZone[];
  balance?: {
    zoneA: string;
    zoneB: string;
    maxDifference: number;
  };
};

export type ObjectiveProgress = {
  zone: ObjectiveZone;
  water: number;
  complete: boolean;
};

export type LevelProgress = {
  level: GameLevel;
  objectives: ObjectiveProgress[];
  balanceDifference: number | null;
  balanceComplete: boolean;
  complete: boolean;
  totalWater: number;
  targetWater: number;
  waterOutsideTargets: number;
};

export const GAME_LEVELS: GameLevel[] = [
  {
    id: "tutorial",
    name: "Sluice Tutorial",
    scene: "sluice",
    brief: "Open the gates and dig only as needed to fill the marked lower spillway.",
    successText: "Cistern primed",
    zones: [
      {
        id: "catch",
        label: "Lower spillway",
        minX: 0,
        maxX: 23,
        minY: 0,
        maxY: 2,
        minZ: 24,
        maxZ: 39,
        targetWater: 150,
      },
    ],
  },
  {
    id: "challenge",
    name: "Split Basin Challenge",
    scene: "splitter",
    brief: "Split the limited reservoir between both lower basins without starving either side.",
    successText: "Flow balanced",
    zones: [
      {
        id: "near",
        label: "Near basin",
        minX: 0,
        maxX: 15,
        minY: 0,
        maxY: 2,
        minZ: 24,
        maxZ: 31,
        targetWater: 50,
      },
      {
        id: "far",
        label: "Far basin",
        minX: 0,
        maxX: 15,
        minY: 0,
        maxY: 2,
        minZ: 32,
        maxZ: 39,
        targetWater: 50,
      },
    ],
    balance: {
      zoneA: "near",
      zoneB: "far",
      maxDifference: 20,
    },
  },
];

export function getLevel(id: string): GameLevel | null {
  return GAME_LEVELS.find((level) => level.id === id) ?? null;
}

export function evaluateLevel(world: VoxelWorld, level: GameLevel): LevelProgress {
  const objectives = level.zones.map((zone) => {
    const water = measureZoneWater(world, zone);
    return {
      zone,
      water,
      complete: water >= zone.targetWater && (zone.maxWater === undefined || water <= zone.maxWater),
    };
  });

  const balanceDifference = evaluateBalanceDifference(objectives, level);
  const balanceComplete = balanceDifference === null || balanceDifference <= (level.balance?.maxDifference ?? 0);
  const targetWater = objectives.reduce((sum, objective) => sum + objective.water, 0);

  return {
    level,
    objectives,
    balanceDifference,
    balanceComplete,
    complete: objectives.every((objective) => objective.complete) && balanceComplete,
    totalWater: totalWater(world),
    targetWater,
    waterOutsideTargets: Math.max(0, totalWater(world) - targetWater),
  };
}

export function measureZoneWater(world: VoxelWorld, zone: ObjectiveZone): number {
  let water = 0;

  for (let y = zone.minY; y <= zone.maxY; y += 1) {
    for (let z = zone.minZ; z <= zone.maxZ; z += 1) {
      for (let x = zone.minX; x <= zone.maxX; x += 1) {
        if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
          continue;
        }

        water += world.water[x + world.width * (z + world.depth * y)];
      }
    }
  }

  return water;
}

function evaluateBalanceDifference(objectives: ObjectiveProgress[], level: GameLevel): number | null {
  if (!level.balance) {
    return null;
  }

  const zoneA = objectives.find((objective) => objective.zone.id === level.balance?.zoneA);
  const zoneB = objectives.find((objective) => objective.zone.id === level.balance?.zoneB);
  if (!zoneA || !zoneB) {
    return null;
  }

  return Math.abs(zoneA.water - zoneB.water);
}
