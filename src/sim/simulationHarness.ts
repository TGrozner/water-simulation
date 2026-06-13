import { stepWaterSimulation } from "./waterSimulation";
import {
  DEFAULT_TUNING_PRESET_ID,
  TUNING_PRESETS,
  type TuningPresetId,
  cloneTuningPreset,
} from "./tuningPresets";
import { coords, createEmptyWorld, index, setWater, totalWater, wakeCell, wakeNeighbors } from "../world/grid";
import { createWorld, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { getSceneOpeningStages, openSceneDrain, openSceneStage } from "../world/sceneTools";
import { EPSILON, type VoxelWorld } from "../world/types";
import { evaluateLevel, GAME_LEVELS } from "../game/levels";

type HarnessResult = {
  preset: ScenePresetId;
  tuningPreset: TuningPresetId;
  baselineWater: number;
  finalWater: number;
  finalActiveCells: number;
  maxVolumeDelta: number;
  movedVolume: number;
};

const MAX_TICKS = 1800;
const MAX_STAGE_TICKS = 650;
const CONSERVATION_TOLERANCE = 0.075;

function runHarness(): void {
  const results: HarnessResult[] = [];

  runEdgeCaseHarness();
  assertGameLevelsComplete();

  for (const preset of SCENE_PRESETS) {
    assertAuthoredStagesRemoveTerrain(preset);
    assertProgressiveStagesMoveWater(preset);
    for (const tuningPreset of TUNING_PRESETS) {
      results.push(runScenario(preset, tuningPreset));
    }
  }

  for (const result of results) {
    console.log(
      `${result.preset}/${result.tuningPreset}: water=${result.finalWater.toFixed(3)} delta=${(
        result.finalWater - result.baselineWater
      ).toFixed(6)} maxDelta=${result.maxVolumeDelta.toFixed(6)} moved=${result.movedVolume.toFixed(3)} active=${
        result.finalActiveCells
      }`,
    );
  }
}

function assertGameLevelsComplete(): void {
  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);

  for (const level of GAME_LEVELS) {
    const world = createWorld(level.scene);
    const baselineWater = totalWater(world);
    openSceneDrain(world, level.scene);
    runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `game/${level.id}`);

    const progress = evaluateLevel(world, level);
    assert(
      progress.complete,
      `game/${level.id}: expected scripted path to complete objectives, got ${progress.objectives
        .map((objective) => `${objective.zone.id}=${objective.water.toFixed(1)}/${objective.zone.targetWater.toFixed(1)}`)
        .join(", ")}`,
    );
  }
}

function runEdgeCaseHarness(): void {
  assertWaterFallsThroughOpenedShaft();
  assertWaterLeaksThroughOpenedSideWall();
}

function assertWaterFallsThroughOpenedShaft(): void {
  const world = createEmptyWorld(6, 6, 6);
  world.solid[index(world, 3, 3, 3)] = 1;
  setWater(world, 3, 4, 3, 1);
  wakeCell(world, 3, 4, 3);

  const baselineWater = totalWater(world);
  world.solid[index(world, 3, 3, 3)] = 0;
  wakeNeighbors(world, 3, 3, 3);

  runUntilStable(
    world,
    cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig,
    baselineWater,
    80,
    "edge/opened-shaft",
  );

  let lowerWater = 0;
  for (let cellIndex = 0; cellIndex < world.water.length; cellIndex += 1) {
    const cell = coords(world, cellIndex);
    if (cell.y <= 3) {
      lowerWater += world.water[cellIndex];
    }
  }
  assert(lowerWater > 0.5, "edge/opened-shaft: expected water to fall below the opened plug");
}

function assertWaterLeaksThroughOpenedSideWall(): void {
  const world = createEmptyWorld(7, 4, 5);
  world.solid[index(world, 2, 1, 2)] = 1;
  world.solid[index(world, 3, 1, 2)] = 1;
  world.solid[index(world, 4, 1, 2)] = 1;
  world.solid[index(world, 3, 2, 2)] = 1;
  setWater(world, 2, 2, 2, 1);
  wakeCell(world, 2, 2, 2);

  const baselineWater = totalWater(world);
  world.solid[index(world, 3, 2, 2)] = 0;
  wakeNeighbors(world, 3, 2, 2);

  runUntilStable(
    world,
    cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig,
    baselineWater,
    120,
    "edge/opened-side-wall",
  );

  let leakedWater = 0;
  for (let cellIndex = 0; cellIndex < world.water.length; cellIndex += 1) {
    const cell = coords(world, cellIndex);
    if (cell.x >= 3) {
      leakedWater += world.water[cellIndex];
    }
  }
  assert(leakedWater > 0.1, "edge/opened-side-wall: expected water to leak through opened wall");
}

function assertAuthoredStagesRemoveTerrain(preset: ScenePresetId): void {
  const world = createWorld(preset);
  const stages = getSceneOpeningStages(preset);
  assert(stages.length > 0, `${preset}: expected authored opening stages`);

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const removed = openSceneStage(world, preset, stageIndex);
    assert(removed > 0, `${preset}: opening stage ${stageIndex + 1} (${stages[stageIndex].label}) removed no terrain`);
  }
}

function assertProgressiveStagesMoveWater(preset: ScenePresetId): void {
  const world = createWorld(preset);
  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);
  const baselineWater = totalWater(world);
  const stages = getSceneOpeningStages(preset);

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const removed = openSceneStage(world, preset, stageIndex);
    assert(removed > 0, `${preset}: opening stage ${stageIndex + 1} (${stages[stageIndex].label}) removed no terrain`);

    const movedVolume = runUntilStable(world, tuning.waterConfig, baselineWater, MAX_STAGE_TICKS, `${preset}: stage ${stageIndex + 1}`);
    if (stageIndex === 0) {
      assert(
        movedVolume > EPSILON,
        `${preset}: opening stage ${stageIndex + 1} (${stages[stageIndex].label}) did not move water`,
      );
    }
    assert(world.activeCells.size === 0, `${preset}: stage ${stageIndex + 1} did not stabilize`);
  }
}

function runScenario(preset: ScenePresetId, tuningPreset: TuningPresetId): HarnessResult {
    const world = createWorld(preset);
    const tuning = cloneTuningPreset(tuningPreset);
    const baselineWater = totalWater(world);
    assert(baselineWater > 0, `${preset}/${tuningPreset}: expected initial water`);
    assertNoInvalidWater(world, `${preset}/${tuningPreset}: initial`);

    openSceneDrain(world, preset);

    let maxVolumeDelta = 0;
    const movedVolume = runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}/${tuningPreset}`, (volumeDelta) => {
      maxVolumeDelta = Math.max(maxVolumeDelta, volumeDelta);
    });

    assert(movedVolume > 0, `${preset}/${tuningPreset}: expected water to move after opening drain`);
    assert(
      world.activeCells.size === 0,
      `${preset}/${tuningPreset}: expected water to stabilize before ${MAX_TICKS} ticks`,
    );

    return {
      preset,
      tuningPreset,
      baselineWater,
      finalWater: totalWater(world),
      finalActiveCells: world.activeCells.size,
      maxVolumeDelta,
      movedVolume,
    };
}

function runUntilStable(
  world: VoxelWorld,
  waterConfig: ReturnType<typeof cloneTuningPreset>["waterConfig"],
  baselineWater: number,
  maxTicks: number,
  context: string,
  onVolumeDelta?: (volumeDelta: number) => void,
): number {
  let movedVolume = 0;
  let idleTicks = 0;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const stats = stepWaterSimulation(world, waterConfig);
    movedVolume += stats.movedVolume;
    const volumeDelta = Math.abs(totalWater(world) - baselineWater);
    onVolumeDelta?.(volumeDelta);
    assert(volumeDelta <= CONSERVATION_TOLERANCE, `${context}: water volume drifted by ${volumeDelta.toFixed(6)}`);
    assertNoInvalidWater(world, `${context}: tick ${tick}`);

    if (world.activeCells.size === 0) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
    }

    if (idleTicks >= 4) {
      break;
    }
  }

  return movedVolume;
}

function assertNoInvalidWater(world: VoxelWorld, context: string): void {
  for (let cellIndex = 0; cellIndex < world.water.length; cellIndex += 1) {
    const water = world.water[cellIndex];
    assert(Number.isFinite(water), `${context}: non-finite water at ${formatCell(world, cellIndex)}`);
    assert(water >= 0 - EPSILON && water <= 1 + EPSILON, `${context}: water out of range at ${formatCell(world, cellIndex)}`);
    assert(
      !(world.solid[cellIndex] === 1 && water > EPSILON),
      `${context}: water inside solid at ${formatCell(world, cellIndex)}`,
    );
  }
}

function formatCell(world: VoxelWorld, cellIndex: number): string {
  const cell = coords(world, cellIndex);
  return `${cell.x},${cell.y},${cell.z}`;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

runHarness();
