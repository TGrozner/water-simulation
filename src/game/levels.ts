import { totalWater } from "../world/grid";
import type { ScenePresetId } from "../world/createWorld";
import type { ClearBox, SceneOpeningStage } from "../world/sceneTools";
import type { VoxelWorld } from "../world/types";

export type GameLevel = {
  id: string;
  name: string;
  scene: ScenePresetId;
  brief: string;
  successText: string;
  failText: string;
  deliveryTargetWater: number;
  maxWastedWater: number;
  deliveryBoxes: ClearBox[];
  safeWaterBoxes: ClearBox[];
  hazardStages: SceneOpeningStage[];
};

export type StageProgress = {
  completedStages: number;
  stageCount: number;
  activeStageLabel: string;
  activeStageProgress: number;
};

export type LevelProgress = {
  level: GameLevel;
  stageProgress: StageProgress;
  deliveredWater: number;
  wastedWater: number;
  totalWater: number;
  settled: boolean;
  failed: boolean;
  complete: boolean;
  status: string;
};

export const GAME_LEVELS: GameLevel[] = [
  {
    id: "tutorial",
    name: "Sluice Tutorial",
    scene: "sluice",
    brief: "Cut the highlighted weak rock, then keep carving the sluice chain until the release reaches the lower cave.",
    successText: "Flow stabilized",
    failText: "Too much water escaped the route",
    deliveryTargetWater: 185,
    maxWastedWater: 70,
    deliveryBoxes: [box(21, 39, 1, 7, 20, 30)],
    safeWaterBoxes: [
      box(7, 15, 14, 25, 14, 31),
      box(13, 36, 8, 20, 18, 32),
      box(20, 40, 1, 12, 19, 31),
    ],
    hazardStages: [],
  },
  {
    id: "challenge",
    name: "Split Basin Challenge",
    scene: "splitter",
    brief: "Open the weak gates, split the flow into both basins, and avoid the red spill seams.",
    successText: "Fork stabilized",
    failText: "Too much water escaped the fork",
    deliveryTargetWater: 175,
    maxWastedWater: 30,
    deliveryBoxes: [box(30, 40, 1, 8, 16, 23), box(30, 40, 1, 8, 27, 33)],
    safeWaterBoxes: [
      box(7, 15, 14, 25, 14, 31),
      box(14, 42, 1, 17, 14, 34),
    ],
    hazardStages: [
      {
        label: "South spill seam",
        boxes: [box(34, 42, 2, 8, 10, 16)],
        digBoxes: [box(36, 40, 5, 8, 13, 15)],
      },
      {
        label: "Fork floor sink",
        boxes: [box(31, 39, 0, 2, 23, 27)],
        digBoxes: [box(33, 38, 1, 3, 23, 27)],
      },
    ],
  },
];

export function getLevel(id: string): GameLevel | null {
  return GAME_LEVELS.find((level) => level.id === id) ?? null;
}

export function evaluateLevel(
  world: VoxelWorld,
  level: GameLevel,
  stageProgress: StageProgress,
  settled: boolean,
): LevelProgress {
  const deliveredWater = measureBoxWater(world, level.deliveryBoxes);
  const safeWater = measureBoxWater(world, level.safeWaterBoxes);
  const currentTotalWater = totalWater(world);
  const wastedWater = Math.max(0, currentTotalWater - safeWater);
  const failed = settled && wastedWater > level.maxWastedWater;
  const allStagesOpen = stageProgress.completedStages >= stageProgress.stageCount;
  const delivered = deliveredWater >= level.deliveryTargetWater;
  const complete = allStagesOpen && delivered && settled && !failed;

  return {
    level,
    stageProgress,
    deliveredWater,
    wastedWater,
    totalWater: currentTotalWater,
    settled,
    failed,
    complete,
    status: getStatusText(level, stageProgress, allStagesOpen, delivered, settled, failed),
  };
}

export function measureBoxWater(world: VoxelWorld, boxes: ClearBox[]): number {
  const visited = new Uint8Array(world.water.length);
  let water = 0;

  for (const waterBox of boxes) {
    for (let y = waterBox.minY; y <= waterBox.maxY; y += 1) {
      for (let z = waterBox.minZ; z <= waterBox.maxZ; z += 1) {
        for (let x = waterBox.minX; x <= waterBox.maxX; x += 1) {
          if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
            continue;
          }

          const cellIndex = x + world.width * (z + world.depth * y);
          if (visited[cellIndex] === 1) {
            continue;
          }

          visited[cellIndex] = 1;
          water += world.water[cellIndex];
        }
      }
    }
  }

  return water;
}

function getStatusText(
  level: GameLevel,
  stageProgress: StageProgress,
  allStagesOpen: boolean,
  delivered: boolean,
  settled: boolean,
  failed: boolean,
): string {
  if (failed) {
    return level.failText;
  }

  if (!allStagesOpen) {
    return `Cut weak rock: ${stageProgress.activeStageLabel}`;
  }

  if (!delivered) {
    return "Route more water into the lower cave";
  }

  if (!settled) {
    return "Let the water settle";
  }

  return level.successText;
}

function box(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): ClearBox {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
