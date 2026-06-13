import { index, inBounds, wakeNeighbors } from "./grid";
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

export type SceneOpeningStage = {
  label: string;
  boxes: ClearBox[];
  digBoxes?: ClearBox[];
};

export const SCENE_OPENING_STAGES: Record<ScenePresetId, SceneOpeningStage[]> = {
  sluice: [
    { label: "Reservoir weak gate", boxes: [box(12, 18, 14, 22, 24, 31)], digBoxes: [box(14, 18, 15, 20, 25, 30)] },
    { label: "Lower drop gate", boxes: [box(21, 39, 8, 13, 20, 30)], digBoxes: [box(24, 31, 9, 13, 23, 28)] },
  ],
  splitter: [
    { label: "Reservoir weak gate", boxes: [box(12, 18, 14, 22, 24, 31)], digBoxes: [box(14, 18, 15, 20, 25, 30)] },
    { label: "Fork weak gate", boxes: [box(25, 30, 7, 12, 21, 29)], digBoxes: [box(26, 30, 8, 11, 23, 27)] },
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

export function countStageSolidCells(world: VoxelWorld, stage: SceneOpeningStage): number {
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

export function openSceneStage(world: VoxelWorld, preset: ScenePresetId, stageIndex: number): number {
  const stage = getSceneOpeningStages(preset)[stageIndex];
  if (!stage) {
    return 0;
  }

  return stage.boxes.reduce((removed, clearRegion) => removed + clearBox(world, clearRegion), 0);
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
  return stage.digBoxes ?? stage.boxes;
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

  return removed;
}
