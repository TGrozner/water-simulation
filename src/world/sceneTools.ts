import { index, inBounds, wakeNeighbors } from "./grid";
import type { ScenePresetId } from "./createWorld";
import type { VoxelWorld } from "./types";

type ClearBox = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type SceneOpeningStage = {
  label: string;
  boxes: ClearBox[];
};

export const SCENE_OPENING_STAGES: Record<ScenePresetId, SceneOpeningStage[]> = {
  sluice: [
    { label: "Upper sluice", boxes: [box(12, 18, 14, 22, 24, 31)] },
    { label: "Middle gate", boxes: [box(21, 39, 8, 13, 20, 30)] },
  ],
  splitter: [
    { label: "Reservoir gate", boxes: [box(12, 18, 14, 22, 24, 31)] },
    { label: "Fork splitter", boxes: [box(25, 30, 7, 12, 21, 29)] },
  ],
};

export function getSceneOpeningStages(preset: ScenePresetId): SceneOpeningStage[] {
  return SCENE_OPENING_STAGES[preset];
}

export function openSceneStage(world: VoxelWorld, preset: ScenePresetId, stageIndex: number): number {
  const stage = getSceneOpeningStages(preset)[stageIndex];
  if (!stage) {
    return 0;
  }

  return stage.boxes.reduce((removed, clearRegion) => removed + clearBox(world, clearRegion), 0);
}

export function openSceneDrain(world: VoxelWorld, preset: ScenePresetId): number {
  return getSceneOpeningStages(preset).reduce(
    (removed, _stage, stageIndex) => removed + openSceneStage(world, preset, stageIndex),
    0,
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

  return removed;
}
