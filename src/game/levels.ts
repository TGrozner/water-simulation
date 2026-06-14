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

export type SettlingInput = {
  stableTicks: number;
  requiredTicks: number;
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

export type SettlingProgress = {
  stableTicks: number;
  requiredTicks: number;
  ratio: number;
};

export type LevelProgress = {
  level: GameLevel;
  stageProgress: StageProgress;
  deliveredWater: number;
  deliveryRequirements: DeliveryRequirementProgress[];
  wastedWater: number;
  totalWater: number;
  settling: SettlingProgress;
  settled: boolean;
  failed: boolean;
  complete: boolean;
  score: LevelScore | null;
  status: string;
};

const DEFAULT_SETTLING_REQUIRED_TICKS = 18;

export const GAME_LEVELS: GameLevel[] = [
  {
    id: "generated-cavern",
    name: "Seeded Cavern Expedition",
    scene: "generated-cavern",
    brief:
      "Follow the template-cut cave chain: breach the reservoir, open the throat, then carve both seeded sluices into the twin basins.",
    successText: "Seeded cavern stabilized",
    failText: "The seeded cavern leaked too much water",
    deliveryTargetWater: 680,
    maxWastedWater: 130,
    scoreParTicks: 3000,
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
        label: "Seeded spill rims",
        boxes: [box(30, 43, 0, 3, 32, 43), box(10, 13, 4, 9, 47, 54)],
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
  currentTotalWater = totalWater(world),
  settlingInput?: SettlingInput,
): LevelProgress {
  const deliveredWater = measureBoxWater(world, level.deliveryBoxes);
  const deliveryRequirements = getDeliveryRequirementProgress(world, level);
  const safeWater = measureBoxWater(world, level.safeWaterBoxes);
  const wastedWater = Math.max(0, currentTotalWater - safeWater);
  const allStagesOpen = stageProgress.completedStages >= stageProgress.stageCount;
  const hazardTriggered = stageProgress.openedHazardCount > 0;
  const failed = settled && wastedWater > level.maxWastedWater && (allStagesOpen || hazardTriggered);
  const delivered = deliveredWater >= level.deliveryTargetWater && deliveryRequirements.every((requirement) => requirement.complete);
  const complete = allStagesOpen && delivered && settled && !failed;
  const score = complete && scoreInput ? scoreLevel(level, deliveredWater, wastedWater, scoreInput.ticks) : null;
  const settling = getSettlingProgress(settled, settlingInput);

  return {
    level,
    stageProgress,
    deliveredWater,
    deliveryRequirements,
    wastedWater,
    totalWater: currentTotalWater,
    settling,
    settled,
    failed,
    complete,
    score,
    status: getStatusText(
      level,
      stageProgress,
      allStagesOpen,
      delivered,
      settled,
      failed,
      deliveredWater,
      deliveryRequirements,
      wastedWater,
      settling,
    ),
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

let measureVisitMarks = new Uint32Array(0);
let measureVisitStamp = 0;

export function measureBoxWater(world: VoxelWorld, boxes: ClearBox[]): number {
  if (boxes.length === 0) {
    return 0;
  }

  if (boxes.length === 1) {
    return measureSingleBoxWater(world, boxes[0]);
  }

  const visited = getMeasureVisitMarks(world.water.length);
  const stamp = nextMeasureVisitStamp(visited);
  let water = 0;

  for (const waterBox of boxes) {
    for (let y = waterBox.minY; y <= waterBox.maxY; y += 1) {
      for (let z = waterBox.minZ; z <= waterBox.maxZ; z += 1) {
        for (let x = waterBox.minX; x <= waterBox.maxX; x += 1) {
          if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
            continue;
          }

          const cellIndex = x + world.width * (z + world.depth * y);
          if (visited[cellIndex] === stamp) {
            continue;
          }

          visited[cellIndex] = stamp;
          water += world.water[cellIndex];
        }
      }
    }
  }

  return water;
}

function measureSingleBoxWater(world: VoxelWorld, waterBox: ClearBox): number {
  let water = 0;

  for (let y = waterBox.minY; y <= waterBox.maxY; y += 1) {
    for (let z = waterBox.minZ; z <= waterBox.maxZ; z += 1) {
      for (let x = waterBox.minX; x <= waterBox.maxX; x += 1) {
        if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
          continue;
        }

        water += world.water[x + world.width * (z + world.depth * y)];
      }
    }
  }

  return water;
}

function getMeasureVisitMarks(length: number): Uint32Array {
  if (measureVisitMarks.length !== length) {
    measureVisitMarks = new Uint32Array(length);
    measureVisitStamp = 0;
  }

  return measureVisitMarks;
}

function nextMeasureVisitStamp(visited: Uint32Array): number {
  measureVisitStamp += 1;
  if (measureVisitStamp >= 0xffffffff) {
    visited.fill(0);
    measureVisitStamp = 1;
  }

  return measureVisitStamp;
}

function getStatusText(
  level: GameLevel,
  stageProgress: StageProgress,
  allStagesOpen: boolean,
  delivered: boolean,
  settled: boolean,
  failed: boolean,
  deliveredWater: number,
  deliveryRequirements: DeliveryRequirementProgress[],
  wastedWater: number,
  settling: SettlingProgress,
): string {
  if (failed) {
    return `${level.failText}: ${wastedWater.toFixed(0)} / ${level.maxWastedWater.toFixed(0)} wasted`;
  }

  if (!allStagesOpen) {
    if (stageProgress.activeStageIsManual) {
      return hasRouteFlow(stageProgress)
        ? `Water caught in ${stageProgress.activeStageLabel}; widen the route`
        : `Carve ${stageProgress.activeStageLabel} until water enters`;
    }

    return `Cut highlighted marker: ${stageProgress.activeStageLabel}`;
  }

  if (!delivered) {
    const unmetRequirement = deliveryRequirements.find((requirement) => !requirement.complete);
    if (unmetRequirement) {
      return `Fill ${unmetRequirement.label}: ${unmetRequirement.water.toFixed(0)} / ${unmetRequirement.targetWater.toFixed(0)}`;
    }

    return hasRouteFlow(stageProgress)
      ? `Route more water: ${deliveredWater.toFixed(0)} / ${level.deliveryTargetWater.toFixed(0)}`
      : "Open a route into the lower cave";
  }

  if (!settled) {
    return `Delivered; settling ${settling.stableTicks} / ${settling.requiredTicks}`;
  }

  return level.successText;
}

function getSettlingProgress(settled: boolean, input?: SettlingInput): SettlingProgress {
  const requiredTicks = Math.max(1, Math.floor(input?.requiredTicks ?? DEFAULT_SETTLING_REQUIRED_TICKS));
  const stableTicks = settled ? requiredTicks : Math.max(0, Math.floor(input?.stableTicks ?? 0));
  return {
    stableTicks: Math.min(requiredTicks, stableTicks),
    requiredTicks,
    ratio: clamp01(stableTicks / requiredTicks),
  };
}

function hasRouteFlow(stageProgress: StageProgress): boolean {
  return (stageProgress.selectedRouteWater ?? 0) >= ROUTE_FLOW_STAGE_COMPLETE_WATER;
}

function box(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): ClearBox {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
