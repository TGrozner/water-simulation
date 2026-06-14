import { totalWater } from "../world/grid";
import type { ScenePresetId } from "../world/createWorld";
import type { ClearBox, SceneOpeningStage } from "../world/sceneTools";
import type { VoxelWorld } from "../world/types";
import { ROUTE_FLOW_STAGE_COMPLETE_WATER } from "./stageCompletion";

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
  deliveryRequirements?: DeliveryRequirement[];
  scoreParTicks?: number;
  safeWaterBoxes: ClearBox[];
  hazardStages: SceneOpeningStage[];
};

export type LevelScore = {
  total: number;
  grade: "S" | "A" | "B" | "C";
  efficiency: number;
  waste: number;
  time: number;
  ticks: number;
};

export type ScoreInput = {
  ticks: number;
};

export type DeliveryRequirement = {
  label: string;
  targetWater: number;
  boxes: ClearBox[];
};

export type DeliveryRequirementProgress = {
  label: string;
  water: number;
  targetWater: number;
  complete: boolean;
};

export type StageProgress = {
  completedStages: number;
  stageCount: number;
  activeStageLabel: string;
  activeStageProgress: number;
  activeStageIsManual: boolean;
  selectedChoiceLabel: string | null;
  selectedRouteWater: number | null;
  openedHazardCount: number;
};

export type LevelProgress = {
  level: GameLevel;
  stageProgress: StageProgress;
  deliveredWater: number;
  deliveryRequirements: DeliveryRequirementProgress[];
  wastedWater: number;
  totalWater: number;
  settled: boolean;
  failed: boolean;
  complete: boolean;
  score: LevelScore | null;
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
    scoreParTicks: 900,
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
    name: "Forked Cavern Challenge",
    scene: "splitter",
    brief: "Mine the fork plug, pick a basin branch, cut the low tunnel for the water, and avoid red spill seams.",
    successText: "Fork stabilized",
    failText: "Too much water escaped the fork",
    deliveryTargetWater: 150,
    maxWastedWater: 35,
    scoreParTicks: 1300,
    deliveryBoxes: [box(30, 40, 1, 8, 16, 23), box(30, 40, 1, 8, 27, 33)],
    safeWaterBoxes: [
      box(7, 15, 14, 25, 14, 31),
      box(14, 42, 1, 23, 14, 34),
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
  {
    id: "splitpath",
    name: "Split Path Challenge",
    scene: "braid",
    brief: "Release the reservoir, then carve either lower branch yourself while keeping the center spill seam sealed.",
    successText: "Player route stabilized",
    failText: "Too much water escaped the carved route",
    deliveryTargetWater: 145,
    maxWastedWater: 32,
    scoreParTicks: 1300,
    deliveryBoxes: [box(30, 40, 1, 8, 16, 23), box(30, 40, 1, 8, 27, 33)],
    safeWaterBoxes: [
      box(7, 15, 14, 25, 24, 31),
      box(13, 27, 8, 22, 18, 32),
      box(24, 42, 1, 12, 16, 34),
    ],
    hazardStages: [
      {
        label: "Outer spill seams",
        boxes: [box(34, 42, 1, 7, 11, 15), box(34, 42, 1, 7, 35, 38)],
        digBoxes: [box(36, 40, 2, 6, 15, 17), box(36, 40, 2, 6, 33, 35)],
      },
    ],
  },
  {
    id: "splitbasin",
    name: "Split Basin Challenge",
    scene: "divide",
    brief: "Open the reservoir, then carve both lower outlets so each basin gets enough water before the flow settles.",
    successText: "Both basins stabilized",
    failText: "Too much water escaped the split route",
    deliveryTargetWater: 170,
    maxWastedWater: 38,
    scoreParTicks: 1450,
    deliveryBoxes: [box(30, 40, 1, 8, 16, 22), box(30, 40, 1, 8, 28, 34)],
    deliveryRequirements: [
      { label: "south basin", targetWater: 80, boxes: [box(30, 40, 1, 8, 16, 22)] },
      { label: "north basin", targetWater: 80, boxes: [box(30, 40, 1, 8, 28, 34)] },
    ],
    safeWaterBoxes: [
      box(7, 15, 14, 25, 24, 31),
      box(13, 27, 8, 22, 18, 32),
      box(24, 42, 1, 12, 16, 22),
      box(24, 42, 1, 12, 28, 34),
    ],
    hazardStages: [
      {
        label: "Center spill seam",
        boxes: [box(34, 42, 1, 7, 23, 27)],
        digBoxes: [box(36, 40, 2, 6, 23, 27)],
      },
    ],
  },
  {
    id: "deep-cavern",
    name: "Deep Cavern Expedition",
    scene: "deep-cavern",
    brief: "Breach the high reservoir, drop the flow through the main cavern, then carve both lower sluices into distant basins.",
    successText: "Deep cavern stabilized",
    failText: "The cavern swallowed too much water",
    deliveryTargetWater: 680,
    maxWastedWater: 120,
    scoreParTicks: 2800,
    deliveryBoxes: [box(54, 68, 1, 12, 14, 31), box(52, 68, 1, 12, 48, 66)],
    deliveryRequirements: [
      { label: "south basin", targetWater: 330, boxes: [box(54, 68, 1, 12, 14, 31)] },
      { label: "north basin", targetWater: 330, boxes: [box(52, 68, 1, 12, 48, 66)] },
    ],
    safeWaterBoxes: [
      box(7, 22, 32, 45, 18, 33),
      box(16, 43, 20, 43, 20, 42),
      box(14, 60, 1, 28, 14, 58),
      box(54, 68, 1, 12, 14, 31),
      box(52, 68, 1, 12, 48, 66),
    ],
    hazardStages: [
      {
        label: "Lower sinkhole",
        boxes: [box(30, 43, 0, 3, 32, 43)],
        digBoxes: [box(33, 41, 1, 3, 34, 41)],
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
  scoreInput?: ScoreInput,
): LevelProgress {
  const deliveredWater = measureBoxWater(world, level.deliveryBoxes);
  const deliveryRequirements = getDeliveryRequirementProgress(world, level);
  const safeWater = measureBoxWater(world, level.safeWaterBoxes);
  const currentTotalWater = totalWater(world);
  const wastedWater = Math.max(0, currentTotalWater - safeWater);
  const allStagesOpen = stageProgress.completedStages >= stageProgress.stageCount;
  const hazardTriggered = stageProgress.openedHazardCount > 0;
  const failed = settled && wastedWater > level.maxWastedWater && (allStagesOpen || hazardTriggered);
  const delivered = deliveredWater >= level.deliveryTargetWater && deliveryRequirements.every((requirement) => requirement.complete);
  const complete = allStagesOpen && delivered && settled && !failed;
  const score = complete && scoreInput ? scoreLevel(level, deliveredWater, wastedWater, scoreInput.ticks) : null;

  return {
    level,
    stageProgress,
    deliveredWater,
    deliveryRequirements,
    wastedWater,
    totalWater: currentTotalWater,
    settled,
    failed,
    complete,
    score,
    status: getStatusText(level, stageProgress, allStagesOpen, delivered, settled, failed),
  };
}

export function scoreLevel(level: GameLevel, deliveredWater: number, wastedWater: number, ticks: number): LevelScore {
  const safeTicks = Math.max(0, Math.floor(ticks));
  const routeEfficiency = clamp01(level.deliveryTargetWater / Math.max(level.deliveryTargetWater, deliveredWater + wastedWater));
  const wasteScore = clamp01(1 - wastedWater / Math.max(1, level.maxWastedWater));
  const parTicks = level.scoreParTicks ?? 1200;
  const timeScore = clamp01(1 - Math.max(0, safeTicks - parTicks) / parTicks);
  const total = Math.round(routeEfficiency * 42 + wasteScore * 34 + timeScore * 24);

  return {
    total,
    grade: getGrade(total),
    efficiency: routeEfficiency,
    waste: wasteScore,
    time: timeScore,
    ticks: safeTicks,
  };
}

function getGrade(score: number): LevelScore["grade"] {
  if (score >= 92) {
    return "S";
  }

  if (score >= 82) {
    return "A";
  }

  if (score >= 68) {
    return "B";
  }

  return "C";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function getDeliveryRequirementProgress(world: VoxelWorld, level: GameLevel): DeliveryRequirementProgress[] {
  return (level.deliveryRequirements ?? []).map((requirement) => {
    const water = measureBoxWater(world, requirement.boxes);
    return {
      label: requirement.label,
      water,
      targetWater: requirement.targetWater,
      complete: water >= requirement.targetWater,
    };
  });
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
    if (stageProgress.activeStageIsManual) {
      return hasRouteFlow(stageProgress)
        ? `Water entering ${stageProgress.activeStageLabel}`
        : `Carve ${stageProgress.activeStageLabel}`;
    }

    return `Cut weak rock: ${stageProgress.activeStageLabel}`;
  }

  if (!delivered) {
    const unmetRequirement = level.deliveryRequirements
      ? stageProgress.completedStages >= stageProgress.stageCount
        ? "Fill every basin"
        : null
      : null;
    if (unmetRequirement) {
      return unmetRequirement;
    }

    return hasRouteFlow(stageProgress) ? "Water is taking the low tunnel" : "Route more water into the lower cave";
  }

  if (!settled) {
    return "Let the water settle";
  }

  return level.successText;
}

function hasRouteFlow(stageProgress: StageProgress): boolean {
  return (stageProgress.selectedRouteWater ?? 0) >= ROUTE_FLOW_STAGE_COMPLETE_WATER;
}

function box(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): ClearBox {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
