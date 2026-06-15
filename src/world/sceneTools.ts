import { clearWaterMotion, index, inBounds, wakeNeighbors } from "./grid";
import type { ScenePresetId } from "./createWorld";
import type { VoxelWorld } from "./types";

export type ClearBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type SceneOpeningChoice = {
  label: string;
  boxes: ClearBox[];
  digBoxes?: ClearBox[];
};

export type SceneOpeningStage = SceneOpeningChoice & {
  choices?: SceneOpeningChoice[];
  autoOpen?: boolean;
};

export const SCENE_OPENING_STAGES: Record<ScenePresetId, SceneOpeningStage[]> = {
  "generated-cavern": [
    {
      label: "Seeded reservoir breach",
      boxes: [box(19, 23, 33, 43, 24, 31)],
      digBoxes: [box(19, 23, 33, 43, 24, 31)],
    },
    {
      label: "Template throat",
      boxes: [box(28, 36, 22, 31, 28, 36)],
      digBoxes: [box(29, 35, 23, 30, 29, 35)],
    },
    {
      label: "Twin seeded sluices",
      boxes: [],
      digBoxes: [box(44, 56, 4, 11, 21, 31), box(44, 56, 4, 11, 47, 57)],
      autoOpen: false,
    },
  ],
};

export function getSceneOpeningStages(preset: ScenePresetId): SceneOpeningStage[] {
  return SCENE_OPENING_STAGES[preset];
}

export function isCellInStage(world: VoxelWorld, stage: SceneOpeningStage, cellIndex: number): boolean {
  const x = cellIndex % world.width;
  const z = Math.floor(cellIndex / world.width) % world.depth;
  const y = Math.floor(cellIndex / (world.width * world.depth));

  return getStageDigBoxes(stage).some((clearRegion) => isCellInBox(x, y, z, clearRegion));
}

export function countStageSolidCells(world: VoxelWorld, stage: SceneOpeningChoice): number {
  let count = 0;

  for (const clearRegion of getStageDigBoxes(stage)) {
    for (let y = clearRegion.minY; y <= clearRegion.maxY; y += 1) {
      for (let z = clearRegion.minZ; z <= clearRegion.maxZ; z += 1) {
        for (let x = clearRegion.minX; x <= clearRegion.maxX; x += 1) {
          if (!inBounds(world, x, y, z)) {
            continue;
          }

          count += world.solid[index(world, x, y, z)];
        }
      }
    }
  }

  return count;
}

export function openSceneStage(world: VoxelWorld, preset: ScenePresetId, stageIndex: number, choiceIndex = 0): number {
  const stage = getSceneOpeningStages(preset)[stageIndex];
  if (!stage) {
    return 0;
  }

  if (!isStageAutoOpen(stage)) {
    return 0;
  }

  return openStageChoice(world, getStageChoices(stage)[choiceIndex] ?? getStageChoices(stage)[0]);
}

export function openStageChoice(world: VoxelWorld, choice: SceneOpeningChoice | undefined): number {
  if (!choice) {
    return 0;
  }

  return choice.boxes.reduce((removed, clearRegion) => removed + clearBox(world, clearRegion), 0);
}

export function openClearBox(world: VoxelWorld, clearRegion: ClearBox): number {
  return clearBox(world, clearRegion);
}

export function openSceneDrain(world: VoxelWorld, preset: ScenePresetId): number {
  return getSceneOpeningStages(preset).reduce(
    (removed, _stage, stageIndex) => removed + openSceneStage(world, preset, stageIndex),
    0,
  );
}

export function getStageDigBoxes(stage: SceneOpeningStage): ClearBox[] {
  if (stage.choices) {
    return stage.choices.flatMap((choice) => choice.digBoxes ?? choice.boxes);
  }

  return stage.digBoxes ?? stage.boxes;
}

export function getStageChoices(stage: SceneOpeningStage): SceneOpeningChoice[] {
  return stage.choices ?? [stage];
}

export function isStageAutoOpen(stage: SceneOpeningStage): boolean {
  return stage.autoOpen !== false;
}

function isCellInBox(x: number, y: number, z: number, clearRegion: ClearBox): boolean {
  return (
    x >= clearRegion.minX &&
    x <= clearRegion.maxX &&
    y >= clearRegion.minY &&
    y <= clearRegion.maxY &&
    z >= clearRegion.minZ &&
    z <= clearRegion.maxZ
  );
}

function box(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): ClearBox {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function clearBox(world: VoxelWorld, clearRegion: ClearBox): number {
  let removed = 0;

  for (let y = clearRegion.minY; y <= clearRegion.maxY; y += 1) {
    for (let z = clearRegion.minZ; z <= clearRegion.maxZ; z += 1) {
      for (let x = clearRegion.minX; x <= clearRegion.maxX; x += 1) {
        if (!inBounds(world, x, y, z)) {
          continue;
        }

        const cellIndex = index(world, x, y, z);
        if (world.solid[cellIndex] === 1) {
          removed += 1;
        }
        world.solid[cellIndex] = 0;
        wakeNeighbors(world, x, y, z);
      }
    }
  }

  if (removed > 0) {
    clearWaterMotion(world);
  }

  return removed;
}
