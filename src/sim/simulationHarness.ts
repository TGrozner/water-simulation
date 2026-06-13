import { stepWaterSimulation } from "./waterSimulation";
import {
  DEFAULT_TUNING_PRESET_ID,
  TUNING_PRESETS,
  type TuningPresetId,
  cloneTuningPreset,
} from "./tuningPresets";
import { coords, createEmptyWorld, index, setWater, totalWater, wakeCell, wakeNeighbors } from "../world/grid";
import { createWorld, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import {
  countStageSolidCells,
  getSceneOpeningStages,
  getStageChoices,
  getStageDigBoxes,
  isStageAutoOpen,
  openClearBox,
  openSceneDrain,
  openSceneStage,
} from "../world/sceneTools";
import { EPSILON, type VoxelWorld } from "../world/types";
import { evaluateLevel, GAME_LEVELS } from "../game/levels";
import {
  ROUTE_FLOW_STAGE_COMPLETE_WATER,
  STAGE_CLEAR_RATIO,
  isStageChoiceComplete,
} from "../game/stageCompletion";

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
const MAX_STAGE_TICKS = 1000;
const CONSERVATION_TOLERANCE = 0.1;

function runHarness(): void {
  const results: HarnessResult[] = [];

  runEdgeCaseHarness();
  assertStageCompletionRules();
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
    const stages = getSceneOpeningStages(level.scene);
    const earlyWorld = createWorld(level.scene);
    const earlyBaselineWater = totalWater(earlyWorld);
    openSceneStage(earlyWorld, level.scene, 0);
    runUntilStable(earlyWorld, tuning.waterConfig, earlyBaselineWater, MAX_TICKS, `game/${level.id}: first stage`);
    const earlyProgress = evaluateLevel(
      earlyWorld,
      level,
      {
        completedStages: 1,
        stageCount: stages.length,
        activeStageLabel: stages[1]?.label ?? "complete",
        activeStageProgress: 0,
        activeStageIsManual: stages[1] ? !isStageAutoOpen(stages[1]) : false,
        selectedChoiceLabel: null,
        selectedRouteWater: null,
        openedHazardCount: 0,
      },
      true,
    );
    assert(!earlyProgress.complete, `game/${level.id}: first opening stage should not complete the level`);
    if (level.id === "challenge") {
      assert(
        earlyProgress.deliveredWater < level.deliveryTargetWater * 0.5,
        `game/${level.id}: first opening stage bypassed the fork gate with delivered=${earlyProgress.deliveredWater.toFixed(
          1,
        )}/${level.deliveryTargetWater.toFixed(1)}`,
      );
    }

    const world = createWorld(level.scene);
    const baselineWater = totalWater(world);
    openSceneDrain(world, level.scene);
    const manualStageIndex = getManualStageIndex(stages);

    if (manualStageIndex >= 0) {
      const beforeManualProgress = evaluateLevel(
        world,
        level,
        makeProgress(stages, manualStageIndex, stages[manualStageIndex].label, 0, getScriptedSelectedChoiceLabel(stages)),
        false,
      );
      assert(!beforeManualProgress.complete, `game/${level.id}: openSceneDrain should not complete manual carve stage`);
      assert(
        countStageSolidCells(world, getStageChoices(stages[manualStageIndex])[0]) > 0,
        `game/${level.id}: openSceneDrain should not clear manual carve terrain`,
      );
      clearStageDigBoxes(world, getStageChoices(stages[manualStageIndex])[0]);
    } else {
      runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `game/${level.id}: before complete`);
    }

    runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `game/${level.id}`);

    const progress = evaluateLevel(
      world,
      level,
      makeProgress(stages, stages.length, "complete", 1, getScriptedSelectedChoiceLabel(stages)),
      true,
    );
    assert(
      progress.complete,
      `game/${level.id}: expected scripted path to complete, got delivered=${progress.deliveredWater.toFixed(1)}/${level.deliveryTargetWater.toFixed(
        1,
      )} wasted=${progress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)} status=${progress.status}`,
    );

    for (let hazardIndex = 0; hazardIndex < level.hazardStages.length; hazardIndex += 1) {
      const hazardWorld = createWorld(level.scene);
      const hazardBaselineWater = totalWater(hazardWorld);
      openSceneDrain(hazardWorld, level.scene);
      if (manualStageIndex >= 0) {
        clearStageDigBoxes(hazardWorld, getStageChoices(stages[manualStageIndex])[0]);
      }
      for (const clearRegion of level.hazardStages[hazardIndex].boxes) {
        openClearBox(hazardWorld, clearRegion);
      }
      runUntilStable(
        hazardWorld,
        tuning.waterConfig,
        hazardBaselineWater,
        MAX_TICKS,
        `game/${level.id}: hazard ${hazardIndex + 1}`,
      );

      const hazardProgress = evaluateLevel(
        hazardWorld,
        level,
        makeProgress(stages, stages.length, "complete", 1, getScriptedSelectedChoiceLabel(stages)),
        true,
      );
      assert(
        hazardProgress.failed && !hazardProgress.complete,
        `game/${level.id}: expected authored hazard ${hazardIndex + 1} to fail, got delivered=${hazardProgress.deliveredWater.toFixed(
          1,
        )} wasted=${hazardProgress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)} status=${hazardProgress.status}`,
      );
    }

    assertChoiceStagesCanComplete(level.scene, level);
  }
}

function makeProgress(
  stages: ReturnType<typeof getSceneOpeningStages>,
  completedStages: number,
  activeStageLabel: string,
  activeStageProgress: number,
  selectedChoiceLabel: string | null,
  selectedRouteWater: number | null = selectedChoiceLabel === null ? null : 0,
  openedHazardCount = 0,
) {
  const activeStage = stages[completedStages];
  return {
    completedStages,
    stageCount: stages.length,
    activeStageLabel,
    activeStageProgress,
    activeStageIsManual: activeStage ? !isStageAutoOpen(activeStage) : false,
    selectedChoiceLabel,
    selectedRouteWater,
    openedHazardCount,
  };
}

function assertStageCompletionRules(): void {
  const initialSolids = 108;
  const remainingSolidsAtGateThreshold = initialSolids - Math.ceil(initialSolids * STAGE_CLEAR_RATIO);

  assert(
    isStageChoiceComplete({
      autoOpen: true,
      initialSolids,
      remainingSolids: remainingSolidsAtGateThreshold,
      routeWater: 0,
    }),
    "authored stages should complete from clear ratio alone",
  );
  assert(
    !isStageChoiceComplete({
      autoOpen: false,
      initialSolids,
      remainingSolids: remainingSolidsAtGateThreshold,
      routeWater: 0,
    }),
    "manual stages should not complete from clear ratio without route water",
  );
  assert(
    isStageChoiceComplete({
      autoOpen: false,
      initialSolids,
      remainingSolids: remainingSolidsAtGateThreshold,
      routeWater: ROUTE_FLOW_STAGE_COMPLETE_WATER,
    }),
    "manual stages should complete once enough rock is cleared and route water enters",
  );
}

function getManualStageIndex(stages: ReturnType<typeof getSceneOpeningStages>): number {
  return stages.findIndex((stage) => !isStageAutoOpen(stage));
}

function clearStageDigBoxes(world: VoxelWorld, stageOrChoice: Parameters<typeof getStageDigBoxes>[0]): number {
  return getStageDigBoxes(stageOrChoice).reduce((removed, clearRegion) => removed + openClearBox(world, clearRegion), 0);
}

function getScriptedSelectedChoiceLabel(stages: ReturnType<typeof getSceneOpeningStages>): string | null {
  for (const stage of stages) {
    const choices = getStageChoices(stage);
    if (choices.length > 1) {
      return choices[0].label;
    }
  }

  return null;
}

function assertChoiceStagesCanComplete(preset: ScenePresetId, level: (typeof GAME_LEVELS)[number]): void {
  const stages = getSceneOpeningStages(preset);
  const choiceStageIndex = stages.findIndex((stage) => isStageAutoOpen(stage) && getStageChoices(stage).length > 1);
  if (choiceStageIndex < 0) {
    return;
  }

  const choices = getStageChoices(stages[choiceStageIndex]);
  const manualStageIndex = getManualStageIndex(stages);
  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);

  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
    const world = createWorld(preset);
    const baselineWater = totalWater(world);
    for (let stageIndex = 0; stageIndex < choiceStageIndex; stageIndex += 1) {
      openSceneStage(world, preset, stageIndex);
    }
    const removed = openSceneStage(world, preset, choiceStageIndex, choiceIndex);
    assert(removed > 0, `${preset}: choice ${choiceIndex + 1} (${choices[choiceIndex].label}) removed no terrain`);

    for (let otherChoiceIndex = 0; otherChoiceIndex < choices.length; otherChoiceIndex += 1) {
      if (otherChoiceIndex === choiceIndex) {
        continue;
      }

      assert(
        countStageSolidCells(world, choices[otherChoiceIndex]) > 0,
        `${preset}: choice ${choiceIndex + 1} unexpectedly cleared choice ${otherChoiceIndex + 1}`,
      );
    }

    assertUnfinishedManualRouteDoesNotFail(preset, level, stages, choiceStageIndex, choiceIndex, tuning);

    const beforeManualProgress = evaluateLevel(
      world,
      level,
      makeProgress(stages, manualStageIndex >= 0 ? manualStageIndex : stages.length, "complete", 0, choices[choiceIndex].label),
      false,
    );
    assert(!beforeManualProgress.complete, `${preset}: choice ${choiceIndex + 1} should still require manual carve stage`);

    if (manualStageIndex >= 0) {
      const manualChoices = getStageChoices(stages[manualStageIndex]);
      const manualChoiceIndex = Math.min(choiceIndex, manualChoices.length - 1);
      const manualChoice = manualChoices[manualChoiceIndex];
      const manualChoiceInitialSolids = countStageSolidCells(world, manualChoice);
      assert(
        manualChoiceInitialSolids >= 40,
        `${preset}: manual carve choice ${choiceIndex + 1} should start as a meaningful plug, got ${manualChoiceInitialSolids} solids`,
      );
      const dryManualProgress = evaluateLevel(
        world,
        level,
        makeProgress(stages, manualStageIndex, manualChoice.label, 0, choices[choiceIndex].label, 0),
        false,
      );
      assert(
        dryManualProgress.status === `Carve route: ${manualChoice.label}`,
        `${preset}: dry manual status should ask for carving, got "${dryManualProgress.status}"`,
      );
      const wetManualProgress = evaluateLevel(
        world,
        level,
        makeProgress(stages, manualStageIndex, manualChoice.label, 0, choices[choiceIndex].label, 2),
        false,
      );
      assert(
        wetManualProgress.status === `Water entering: ${manualChoice.label}`,
        `${preset}: wet manual status should report entering water, got "${wetManualProgress.status}"`,
      );
      const removed = clearStageDigBoxes(world, manualChoice);
      assert(removed > 0, `${preset}: manual carve choice ${choiceIndex + 1} removed no terrain`);

      for (let otherManualChoiceIndex = 0; otherManualChoiceIndex < manualChoices.length; otherManualChoiceIndex += 1) {
        if (otherManualChoiceIndex === manualChoiceIndex) {
          continue;
        }

        assert(
          countStageSolidCells(world, manualChoices[otherManualChoiceIndex]) > 0,
          `${preset}: manual carve choice ${choiceIndex + 1} unexpectedly cleared manual choice ${
            otherManualChoiceIndex + 1
          }`,
        );
      }

      const flowingProgress = evaluateLevel(
        world,
        level,
        makeProgress(stages, stages.length, "complete", 1, choices[choiceIndex].label, 2),
        false,
      );
      assert(
        flowingProgress.status === "Water is taking the carved route",
        `${preset}: routed water status should acknowledge carved flow, got "${flowingProgress.status}"`,
      );
    }

    runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}: choice ${choiceIndex + 1}`);
    const progress = evaluateLevel(
      world,
      level,
      makeProgress(stages, stages.length, "complete", 1, choices[choiceIndex].label),
      true,
    );

    assert(
      progress.complete,
      `${preset}: choice ${choiceIndex + 1} (${choices[choiceIndex].label}) should complete, delivered=${progress.deliveredWater.toFixed(
        1,
      )}/${level.deliveryTargetWater.toFixed(1)} wasted=${progress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)}`,
    );
  }
}

function assertUnfinishedManualRouteDoesNotFail(
  preset: ScenePresetId,
  level: (typeof GAME_LEVELS)[number],
  stages: ReturnType<typeof getSceneOpeningStages>,
  choiceStageIndex: number,
  choiceIndex: number,
  tuning: ReturnType<typeof cloneTuningPreset>,
): void {
  const manualStageIndex = getManualStageIndex(stages);
  if (manualStageIndex < 0) {
    return;
  }

  const world = createWorld(preset);
  const baselineWater = totalWater(world);
  for (let stageIndex = 0; stageIndex < choiceStageIndex; stageIndex += 1) {
    openSceneStage(world, preset, stageIndex);
  }
  openSceneStage(world, preset, choiceStageIndex, choiceIndex);
  runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}: unfinished choice ${choiceIndex + 1}`);

  const selectedChoice = getStageChoices(stages[choiceStageIndex])[choiceIndex];
  const manualChoices = getStageChoices(stages[manualStageIndex]);
  const manualChoice = manualChoices[Math.min(choiceIndex, manualChoices.length - 1)];
  const progress = evaluateLevel(
    world,
    level,
    makeProgress(stages, manualStageIndex, manualChoice.label, 0, selectedChoice.label, 0),
    true,
  );

  assert(
    !progress.failed,
    `${preset}: unfinished manual route ${choiceIndex + 1} should not fail before a hazard or completed route, wasted=${progress.wastedWater.toFixed(
      1,
    )}/${level.maxWastedWater.toFixed(1)}`,
  );
  assert(!progress.complete, `${preset}: unfinished manual route ${choiceIndex + 1} should not complete`);
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
    if (!isStageAutoOpen(stages[stageIndex])) {
      assert(
        countStageSolidCells(world, getStageChoices(stages[stageIndex])[0]) > 0,
        `${preset}: manual stage ${stageIndex + 1} (${stages[stageIndex].label}) has no terrain to carve`,
      );
      continue;
    }

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
    const removed = isStageAutoOpen(stages[stageIndex])
      ? openSceneStage(world, preset, stageIndex)
      : clearStageDigBoxes(world, getStageChoices(stages[stageIndex])[0]);
    assert(removed > 0, `${preset}: stage ${stageIndex + 1} (${stages[stageIndex].label}) removed no terrain`);

    const movedVolume = runUntilStable(world, tuning.waterConfig, baselineWater, MAX_STAGE_TICKS, `${preset}: stage ${stageIndex + 1}`);
    if (stageIndex === 0) {
      assert(
        movedVolume > EPSILON,
        `${preset}: opening stage ${stageIndex + 1} (${stages[stageIndex].label}) did not move water`,
      );
    }
    if (stageIndex === stages.length - 1) {
      assert(world.activeCells.size === 0, `${preset}: final stage did not stabilize`);
    }
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
