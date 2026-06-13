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
  maxOutsideWater?: number;
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
  outsideComplete: boolean;
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
    brief: "Dig the glowing weak gate and route the reservoir into the marked catch basin.",
    successText: "Cistern primed",
    maxOutsideWater: 170,
    zones: [
      {
        id: "catch",
        label: "Catch basin",
        minX: 25,
        maxX: 35,
        minY: 1,
        maxY: 3,
        minZ: 22,
        maxZ: 28,
        targetWater: 210,
        maxWater: 285,
      },
    ],
  },
  {
    id: "challenge",
    name: "Split Basin Challenge",
    scene: "splitter",
    brief: "Cut the glowing weak gates and split the reservoir between both lower basins.",
    successText: "Flow balanced",
    maxOutsideWater: 110,
    zones: [
      {
        id: "left",
        label: "Left basin",
        minX: 33,
        maxX: 39,
        minY: 1,
        maxY: 4,
        minZ: 17,
        maxZ: 22,
        targetWater: 135,
        maxWater: 205,
      },
      {
        id: "right",
        label: "Right basin",
        minX: 33,
        maxX: 39,
        minY: 1,
        maxY: 4,
        minZ: 28,
        maxZ: 33,
        targetWater: 135,
        maxWater: 205,
      },
    ],
    balance: {
      zoneA: "left",
      zoneB: "right",
      maxDifference: 30,
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
  const currentTotalWater = totalWater(world);
  const waterOutsideTargets = Math.max(0, currentTotalWater - targetWater);
  const outsideComplete = level.maxOutsideWater === undefined || waterOutsideTargets <= level.maxOutsideWater;

  return {
    level,
    objectives,
    balanceDifference,
    balanceComplete,
    outsideComplete,
    complete: objectives.every((objective) => objective.complete) && balanceComplete && outsideComplete,
    totalWater: currentTotalWater,
    targetWater,
    waterOutsideTargets,
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
