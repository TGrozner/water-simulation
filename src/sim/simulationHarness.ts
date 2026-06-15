import { stepWaterSimulation } from "./waterSimulation";
import { getWaterMotionSample, getWaterParticleCue } from "./waterMotion";
import { WATER_SURFACE_OFFSET_LIMIT, WATER_SURFACE_VELOCITY_LIMIT } from "./waterSurface";
import {
  DEFAULT_TUNING_PRESET_ID,
  TUNING_PRESETS,
  type TuningPresetId,
  cloneTuningPreset,
} from "./tuningPresets";
import { PerspectiveCamera, Vector3 } from "three";
import { coords, createEmptyWorld, index, setWater, totalWater, wakeCell, wakeNeighbors } from "../world/grid";
import { createWorld, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { FIRST_PERSON_MOVEMENT_TEST_HOOKS } from "../input/firstPersonController";
import {
  countStageSolidCells,
  getSceneOpeningStages,
  getStageChoices,
  getStageDigBoxes,
  isStageAutoOpen,
  openClearBox,
  openSceneDrain,
  openSceneStage,
  type ClearBox,
} from "../world/sceneTools";
import { EPSILON, type VoxelWorld } from "../world/types";
import { getBestScore, isBetterScore, mergeBestScore, parseStoredBestScores } from "../game/bestScoreStorage";
import { getLevelSelectRows } from "../game/gamePanel";
import { evaluateLevel, GAME_LEVELS, scoreLevel } from "../game/levels";
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

type HarnessTier = "smoke" | "standard" | "full";
type HarnessGroup = "edge" | "rules" | "contracts" | "game" | "progressive" | "routes" | "scenario";
type HarnessOptions = {
  tier: HarnessTier;
  groups: readonly HarnessGroup[];
  scanIntervalTicks: number;
};

const MAX_TICKS = 1800;
const MAX_STAGE_TICKS = 1000;
const LARGE_CAVERN_MAX_TICKS = 5000;
const CONSERVATION_TOLERANCE = 0.1;
const CONSERVATION_RELATIVE_TOLERANCE = 0.0005;
const STANDARD_WATER_SCAN_INTERVAL_TICKS = 25;
const SMALL_WORLD_SCAN_CELL_LIMIT = 10_000;

const HARNESS_GROUPS_BY_TIER: Record<HarnessTier, readonly HarnessGroup[]> = {
  smoke: ["edge", "rules", "contracts"],
  standard: ["edge", "rules", "contracts", "game", "progressive", "scenario"],
  full: ["edge", "rules", "contracts", "game", "progressive", "routes", "scenario"],
};

const ALL_HARNESS_GROUPS = Object.freeze(
  Array.from(new Set(Object.values(HARNESS_GROUPS_BY_TIER).flat())),
) as readonly HarnessGroup[];

const HARNESS_OPTIONS = parseHarnessOptions();

function runHarness(): void {
  const results: HarnessResult[] = [];

  console.log(`simulation harness tier=${HARNESS_OPTIONS.tier} groups=${HARNESS_OPTIONS.groups.join(",")}`);

  if (shouldRunGroup("edge")) {
    runEdgeCaseHarness();
  }

  if (shouldRunGroup("rules")) {
    assertStageCompletionRules();
    assertLevelScoreRules();
    assertBestScoreRules();
    assertLevelSelectRows();
  }

  if (shouldRunGroup("contracts")) {
    assertGeneratedCavernDeterministic();
    assertGeneratedCavernContracts();
  }

  if (shouldRunGroup("game")) {
    assertGameLevelsComplete();
  }

  for (const preset of SCENE_PRESETS) {
    if (shouldRunGroup("progressive")) {
      assertProgressiveStagesMoveWater(preset);
    }

    if (shouldRunGroup("routes")) {
      for (const level of GAME_LEVELS.filter((level) => level.scene === preset)) {
        assertDeliveryRequirementsGateCompletion(preset, level);
        assertChoiceStagesCanComplete(preset, level);
        assertManualChoiceStagesCanComplete(preset, level);
      }
    }

    if (shouldRunGroup("scenario")) {
      for (const tuningPreset of getScenarioTuningPresets(preset)) {
        results.push(runScenario(preset, tuningPreset));
      }
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

function parseHarnessOptions(): HarnessOptions {
  const tier = parseHarnessTier(getArgValue("--tier") ?? "standard");
  const groups = parseHarnessGroups(getArgValue("--only")) ?? HARNESS_GROUPS_BY_TIER[tier];
  const scanIntervalTicks =
    tier === "full" || process.argv.includes("--paranoid") ? 1 : STANDARD_WATER_SCAN_INTERVAL_TICKS;

  return {
    tier,
    groups,
    scanIntervalTicks,
  };
}

function getArgValue(name: string): string | null {
  const inlinePrefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith(inlinePrefix)) {
      return arg.slice(inlinePrefix.length);
    }
    if (arg === name) {
      return process.argv[index + 1] ?? null;
    }
  }

  return null;
}

function parseHarnessTier(value: string): HarnessTier {
  if (value === "smoke" || value === "standard" || value === "full") {
    return value;
  }

  throw new Error(`Unknown simulation harness tier "${value}". Expected smoke, standard, or full.`);
}

function parseHarnessGroups(value: string | null): readonly HarnessGroup[] | null {
  if (!value) {
    return null;
  }

  const groups = value
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean)
    .map(parseHarnessGroup);
  return groups.length > 0 ? groups : null;
}

function parseHarnessGroup(value: string): HarnessGroup {
  if (ALL_HARNESS_GROUPS.includes(value as HarnessGroup)) {
    return value as HarnessGroup;
  }

  throw new Error(`Unknown simulation harness group "${value}". Expected one of ${ALL_HARNESS_GROUPS.join(", ")}.`);
}

function shouldRunGroup(group: HarnessGroup): boolean {
  return HARNESS_OPTIONS.groups.includes(group);
}

function assertGameLevelsComplete(): void {
  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);

  for (const level of GAME_LEVELS) {
    assertGeneratedCavernLevelContract(level);

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
      { ticks: level.scoreParTicks ?? MAX_TICKS },
    );
    assert(
      progress.complete,
      `game/${level.id}: expected scripted path to complete, got delivered=${progress.deliveredWater.toFixed(1)}/${level.deliveryTargetWater.toFixed(
        1,
      )} wasted=${progress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)} status=${progress.status}`,
    );
    assert(
      progress.score !== null &&
        Number.isFinite(progress.score.total) &&
        progress.score.total >= 0 &&
        progress.score.total <= 100 &&
        progress.score.efficiency >= 0 &&
        progress.score.efficiency <= 1 &&
        progress.score.waste >= 0 &&
        progress.score.waste <= 1 &&
        progress.score.time >= 0 &&
        progress.score.time <= 1 &&
        progress.score.ticks >= 0,
      `game/${level.id}: completed level should produce a bounded score`,
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
        { ticks: level.scoreParTicks ?? MAX_TICKS },
      );
      assert(
        hazardProgress.failed && !hazardProgress.complete,
        `game/${level.id}: expected authored hazard ${hazardIndex + 1} to fail, got delivered=${hazardProgress.deliveredWater.toFixed(
          1,
        )} wasted=${hazardProgress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)} status=${hazardProgress.status}`,
      );
      assert(hazardProgress.score === null, `game/${level.id}: failed hazard route should not produce a score`);
    }
  }
}

function assertGeneratedCavernContracts(): void {
  for (const level of GAME_LEVELS) {
    assertGeneratedCavernLevelContract(level);
  }

  for (const preset of SCENE_PRESETS) {
    assertAuthoredStagesRemoveTerrain(preset);
  }
}

function assertGeneratedCavernDeterministic(): void {
  const first = createWorld("generated-cavern");
  const second = createWorld("generated-cavern");
  assert(first.width === second.width, "generated-cavern: deterministic world width mismatch");
  assert(first.height === second.height, "generated-cavern: deterministic world height mismatch");
  assert(first.depth === second.depth, "generated-cavern: deterministic world depth mismatch");

  let openSidePocketCells = 0;
  for (let cellIndex = 0; cellIndex < first.solid.length; cellIndex += 1) {
    assert(first.solid[cellIndex] === second.solid[cellIndex], `generated-cavern: solid mismatch at ${cellIndex}`);
    assert(first.water[cellIndex] === second.water[cellIndex], `generated-cavern: water mismatch at ${cellIndex}`);

    const cell = coords(first, cellIndex);
    if (
      first.solid[cellIndex] === 0 &&
      cell.x >= 12 &&
      cell.x <= 26 &&
      cell.y >= 20 &&
      cell.y <= 31 &&
      cell.z >= 45 &&
      cell.z <= 60
    ) {
      openSidePocketCells += 1;
    }
  }

  assert(openSidePocketCells >= 80, `generated-cavern: expected seeded upper side pocket, got ${openSidePocketCells}`);
}

function assertGeneratedCavernLevelContract(level: (typeof GAME_LEVELS)[number]): void {
  const world = createWorld("generated-cavern");
  const stages = getSceneOpeningStages("generated-cavern");
  assert(stages.length === 3, "generated-cavern: expected three mission stages");
  assert(totalWater(world) > 1200, "generated-cavern: expected a large seeded reservoir");

  for (const [stageIndex, stage] of stages.entries()) {
    const choices = getStageChoices(stage);
    assert(choices.length > 0, `generated-cavern: stage ${stageIndex + 1} has no choices`);
    for (const choice of choices) {
      const solids = countStageSolidCells(world, choice);
      assert(
        solids >= (isStageAutoOpen(stage) ? 80 : 40),
        `generated-cavern: stage ${stageIndex + 1} (${choice.label}) should start with meaningful solids, got ${solids}`,
      );
    }
  }

  const deliveredCapacity = countOpenCellsInBoxes(world, level.deliveryBoxes);
  assert(deliveredCapacity >= 1200, `generated-cavern: delivery basins need open catchment capacity, got ${deliveredCapacity}`);
  assert(level.deliveryRequirements?.length === 2, "generated-cavern: expected two delivery basin requirements");
  assert(level.hazardStages.length === 1, "generated-cavern: expected one authored hazard group");
  assert(
    countStageSolidCells(world, level.hazardStages[0]) >= 40,
    "generated-cavern: hazard seam should start as meaningful solid terrain",
  );
}

function countOpenCellsInBoxes(world: VoxelWorld, boxes: ClearBox[]): number {
  let openCells = 0;
  for (const box of boxes) {
    for (let y = box.minY; y <= box.maxY; y += 1) {
      for (let z = box.minZ; z <= box.maxZ; z += 1) {
        for (let x = box.minX; x <= box.maxX; x += 1) {
          if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
            continue;
          }
          openCells += world.solid[index(world, x, y, z)] === 0 ? 1 : 0;
        }
      }
    }
  }

  return openCells;
}

function assertLevelScoreRules(): void {
  for (const level of GAME_LEVELS) {
    assert(level.scoreParTicks !== undefined && level.scoreParTicks > 0, `game/${level.id}: missing score par ticks`);

    const parTicks = level.scoreParTicks;
    const cleanFastScore = scoreLevel(level, level.deliveryTargetWater, 0, Math.max(1, parTicks - 1));
    const wastedScore = scoreLevel(level, level.deliveryTargetWater, level.maxWastedWater, Math.max(1, parTicks - 1));
    const slowScore = scoreLevel(level, level.deliveryTargetWater, 0, parTicks * 2);

    assert(cleanFastScore.total >= wastedScore.total, `game/${level.id}: waste should not improve score`);
    assert(cleanFastScore.waste > wastedScore.waste, `game/${level.id}: waste component should decline with spills`);
    assert(cleanFastScore.total >= slowScore.total, `game/${level.id}: slow completion should not improve score`);
    assert(cleanFastScore.time > slowScore.time, `game/${level.id}: time component should decline after par`);
    assert(cleanFastScore.grade === "S", `game/${level.id}: clean par route should earn top grade`);
  }
}

function assertBestScoreRules(): void {
  const level = GAME_LEVELS[0];
  const firstScore = scoreLevel(level, level.deliveryTargetWater, 0, level.scoreParTicks ?? MAX_TICKS);
  const lowerScore = { ...firstScore, total: Math.max(0, firstScore.total - 1), ticks: firstScore.ticks - 10 };
  const fasterTieScore = { ...firstScore, ticks: Math.max(0, firstScore.ticks - 1) };
  const slowerTieScore = { ...firstScore, ticks: firstScore.ticks + 1 };
  const invalidGradeScore = { ...firstScore, grade: "Z" };
  const invalidRatioScore = { ...firstScore, efficiency: 2 };

  assert(isBetterScore(firstScore, null), "best-score: first valid score should be accepted");

  const initialUpdate = mergeBestScore({}, level.id, firstScore);
  assert(initialUpdate.improved, "best-score: first merge should improve empty score table");
  assert(getBestScore(initialUpdate.scores, level.id) === firstScore, "best-score: first score should be stored");

  const lowerUpdate = mergeBestScore(initialUpdate.scores, level.id, lowerScore);
  assert(!lowerUpdate.improved, "best-score: lower total should not replace current best");
  assert(getBestScore(lowerUpdate.scores, level.id) === firstScore, "best-score: lower total should keep current best");

  const higherUpdate = mergeBestScore({ [level.id]: lowerScore }, level.id, firstScore);
  assert(higherUpdate.improved, "best-score: higher total should replace current best");
  assert(getBestScore(higherUpdate.scores, level.id) === firstScore, "best-score: higher total should be stored");

  const slowerTieUpdate = mergeBestScore({ [level.id]: firstScore }, level.id, slowerTieScore);
  assert(!slowerTieUpdate.improved, "best-score: slower equal score should not replace current best");

  const fasterTieUpdate = mergeBestScore({ [level.id]: firstScore }, level.id, fasterTieScore);
  assert(fasterTieUpdate.improved, "best-score: faster equal score should replace current best");
  assert(getBestScore(fasterTieUpdate.scores, level.id) === fasterTieScore, "best-score: faster tie should be stored");

  const parsedScores = parseStoredBestScores({
    version: 1,
    scores: {
      [level.id]: firstScore,
      unknownLevel: firstScore,
      invalidGrade: invalidGradeScore,
      invalidRatio: invalidRatioScore,
    },
  });
  assert(getBestScore(parsedScores, level.id)?.total === firstScore.total, "best-score: valid stored score should parse");
  assert(getBestScore(parsedScores, "unknownLevel") === null, "best-score: unknown level id should be ignored");
  assert(getBestScore(parsedScores, "invalidGrade") === null, "best-score: invalid grade should be ignored");
  assert(getBestScore(parsedScores, "invalidRatio") === null, "best-score: invalid ratio should be ignored");
  assert(Object.keys(parseStoredBestScores({ version: 2, scores: { [level.id]: firstScore } })).length === 0, "best-score: unknown version should be ignored");
  assert(Object.keys(parseStoredBestScores(null)).length === 0, "best-score: corrupt stored value should be ignored");
}

function assertLevelSelectRows(): void {
  const level = GAME_LEVELS[0];
  const score = scoreLevel(level, level.deliveryTargetWater, 0, level.scoreParTicks ?? MAX_TICKS);
  const emptyRows = getLevelSelectRows(0, {});

  assert(emptyRows.length === GAME_LEVELS.length, "level-select: should render every game level");
  assert(emptyRows[0]?.selected, "level-select: current level should be marked selected");
  assert(emptyRows.every((row) => row.bestLabel === "No best"), "level-select: empty score table should show No best");

  const rowsWithBest = getLevelSelectRows(0, { [level.id]: score });
  assert(rowsWithBest[0]?.selected, "level-select: selected row should follow current level index");
  assert(rowsWithBest[0]?.bestLabel === `${score.grade} ${score.total}`, "level-select: stored best should be formatted");
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
        dryManualProgress.status === `Carve ${manualChoice.label} until water enters`,
        `${preset}: dry manual status should ask for carving, got "${dryManualProgress.status}"`,
      );
      const wetManualProgress = evaluateLevel(
        world,
        level,
        makeProgress(stages, manualStageIndex, manualChoice.label, 0, choices[choiceIndex].label, 2),
        false,
      );
      assert(
        wetManualProgress.status === `Water caught in ${manualChoice.label}; widen the route`,
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
        flowingProgress.status.startsWith("Route more water:"),
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

function assertManualChoiceStagesCanComplete(preset: ScenePresetId, level: (typeof GAME_LEVELS)[number]): void {
  const stages = getSceneOpeningStages(preset);
  const manualStageIndex = stages.findIndex((stage) => !isStageAutoOpen(stage) && getStageChoices(stage).length > 1);
  if (manualStageIndex < 0) {
    return;
  }

  const previousChoiceStageIndex = stages.findIndex(
    (stage, stageIndex) => stageIndex < manualStageIndex && isStageAutoOpen(stage) && getStageChoices(stage).length > 1,
  );
  if (previousChoiceStageIndex >= 0) {
    return;
  }

  const choices = getStageChoices(stages[manualStageIndex]);
  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);

  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
    const world = createWorld(preset);
    const baselineWater = totalWater(world);

    for (let stageIndex = 0; stageIndex < manualStageIndex; stageIndex += 1) {
      openSceneStage(world, preset, stageIndex);
    }

    const choice = choices[choiceIndex];
    const initialSolids = countStageSolidCells(world, choice);
    assert(
      initialSolids >= 40,
      `${preset}: manual choice ${choiceIndex + 1} (${choice.label}) should start as a meaningful route plug, got ${initialSolids}`,
    );

    const removed = clearStageDigBoxes(world, choice);
    assert(removed > 0, `${preset}: manual choice ${choiceIndex + 1} (${choice.label}) removed no terrain`);

    for (let otherChoiceIndex = 0; otherChoiceIndex < choices.length; otherChoiceIndex += 1) {
      if (otherChoiceIndex === choiceIndex) {
        continue;
      }

      assert(
        countStageSolidCells(world, choices[otherChoiceIndex]) > 0,
        `${preset}: manual choice ${choiceIndex + 1} unexpectedly cleared manual choice ${otherChoiceIndex + 1}`,
      );
    }

    runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}: manual choice ${choiceIndex + 1}`);
    const progress = evaluateLevel(
      world,
      level,
      makeProgress(stages, stages.length, "complete", 1, choice.label),
      true,
    );

    assert(
      progress.complete,
      `${preset}: manual choice ${choiceIndex + 1} (${choice.label}) should complete, delivered=${progress.deliveredWater.toFixed(
        1,
      )}/${level.deliveryTargetWater.toFixed(1)} wasted=${progress.wastedWater.toFixed(1)}/${level.maxWastedWater.toFixed(1)}`,
    );
  }
}

function assertDeliveryRequirementsGateCompletion(preset: ScenePresetId, level: (typeof GAME_LEVELS)[number]): void {
  if (!level.deliveryRequirements || level.deliveryRequirements.length === 0) {
    return;
  }

  const stages = getSceneOpeningStages(preset);
  const manualStageIndex = getManualStageIndex(stages);
  assert(manualStageIndex >= 0, `${preset}: delivery requirements need a manual split stage`);

  const manualStage = stages[manualStageIndex];
  const routeBoxes = getStageDigBoxes(manualStage);
  assert(
    routeBoxes.length >= level.deliveryRequirements.length,
    `${preset}: expected at least one route box per delivery requirement`,
  );

  const tuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);

  for (let routeIndex = 0; routeIndex < level.deliveryRequirements.length; routeIndex += 1) {
    const world = createWorld(preset);
    const baselineWater = totalWater(world);
    for (let stageIndex = 0; stageIndex < manualStageIndex; stageIndex += 1) {
      openSceneStage(world, preset, stageIndex);
    }
    openClearBox(world, routeBoxes[routeIndex]);
    runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}: single basin route ${routeIndex + 1}`);

    const progress = evaluateLevel(world, level, makeProgress(stages, stages.length, "complete", 1, null), true);
    assert(!progress.complete, `${preset}: single route ${routeIndex + 1} should not satisfy all delivery requirements`);
    assert(
      progress.deliveryRequirements.some((requirement) => !requirement.complete),
      `${preset}: single route ${routeIndex + 1} unexpectedly completed every delivery requirement`,
    );
  }

  const world = createWorld(preset);
  const baselineWater = totalWater(world);
  for (let stageIndex = 0; stageIndex < manualStageIndex; stageIndex += 1) {
    openSceneStage(world, preset, stageIndex);
  }
  for (const routeBox of routeBoxes.slice(0, level.deliveryRequirements.length)) {
    openClearBox(world, routeBox);
  }
  runUntilStable(world, tuning.waterConfig, baselineWater, MAX_TICKS, `${preset}: all delivery routes`);

  const progress = evaluateLevel(world, level, makeProgress(stages, stages.length, "complete", 1, null), true);
  assert(
    progress.complete,
    `${preset}: all delivery routes should complete every requirement, got ${progress.deliveryRequirements
      .map((requirement) => `${requirement.label}=${requirement.water.toFixed(1)}/${requirement.targetWater.toFixed(1)}`)
      .join(", ")}`,
  );
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
  assertVerticalSpanSettlesAndConservesWater();
  assertDownFlowRateLimitsVerticalSettling();
  assertWaterDoesNotMergeDisconnectedVerticalSpans();
  assertWaterTransfersThroughRaisedPortal();
  assertWaterTransfersThroughOverlappingPortal();
  assertWaterFluxMetadataTracksLateralTransfer();
  assertWaterSurfaceMetadataTracksMotion();
  assertWaterParticleCuesFollowMotion();
  assertFlowEventCollectionDoesNotChangeWaterState();
  assertTopologyChangesClearWaterMotion();
  assertWaterSpillsIntoLowerAdjacentShaft();
  assertWaterDoesNotCrossNonOverlappingPortal();
  assertDisconnectedPocketDoesNotReceiveWaterThroughOverhang();
  assertStackedOverhangSpansAreEnumeratedSeparately();
  assertFirstPersonCornerClearanceUsesRoundFootprint();
  assertFirstPersonVelocitySmoothsInput();
  assertFirstPersonGroundMovementClimbsVoxelSlopeSmoothly();
  assertFirstPersonJumpIntoVoxelWallDoesNotMantleImmediately();
  assertFirstPersonRisingJumpDoesNotSnapToVoxelTop();
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

function assertVerticalSpanSettlesAndConservesWater(): void {
  const world = createEmptyWorld(3, 6, 3);
  world.solid.fill(1);
  for (let y = 0; y < world.height; y += 1) {
    world.solid[index(world, 1, y, 1)] = 0;
  }
  setWater(world, 1, 5, 1, 0.6);
  setWater(world, 1, 3, 1, 0.7);
  wakeCell(world, 1, 5, 1);
  wakeCell(world, 1, 3, 1);

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 80, "edge/vertical-span-settle");

  assertSmallWorldConserved(world, baselineWater, "edge/vertical-span-settle");
  assert(Math.abs(world.water[index(world, 1, 0, 1)] - 1) <= 0.0001, "edge/vertical-span-settle: expected bottom cell full");
  assert(
    Math.abs(world.water[index(world, 1, 1, 1)] - 0.3) <= 0.0001,
    `edge/vertical-span-settle: expected second cell to hold remaining 0.3, got ${world.water[index(world, 1, 1, 1)].toFixed(6)}`,
  );
  assert(
    measureColumnWater(world, 1, 1, 2, 5) <= EPSILON,
    "edge/vertical-span-settle: expected upper column to drain dry",
  );
  assertQuiescentAfterRewake(world, waterConfig, "edge/vertical-span-settle");
}

function assertDownFlowRateLimitsVerticalSettling(): void {
  const world = createEmptyWorld(3, 6, 3);
  world.solid.fill(1);
  for (let y = 0; y < world.height; y += 1) {
    world.solid[index(world, 1, y, 1)] = 0;
  }
  setWater(world, 1, 5, 1, 1);
  wakeCell(world, 1, 5, 1);

  const waterConfig = {
    ...cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig,
    downFlowRate: 0.25,
    minFlow: 0.001,
  };
  const baselineWater = totalWater(world);
  const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });

  assert(stats.movedVolume >= 0.249 && stats.movedVolume <= 0.251, "edge/down-flow-rate: expected limited fall");
  assert(world.water[index(world, 1, 0, 1)] <= EPSILON, "edge/down-flow-rate: water should not teleport to bottom");
  assert(
    world.water[index(world, 1, 4, 1)] >= 0.249 && world.water[index(world, 1, 4, 1)] <= 0.251,
    `edge/down-flow-rate: expected one-cell fall amount near 0.25, got ${world.water[index(world, 1, 4, 1)].toFixed(6)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/down-flow-rate: first tick");

  runUntilStable(world, waterConfig, baselineWater, 80, "edge/down-flow-rate");
  assert(Math.abs(world.water[index(world, 1, 0, 1)] - 1) <= 0.0001, "edge/down-flow-rate: expected bottom cell full");
  assertSmallWorldConserved(world, baselineWater, "edge/down-flow-rate");
  assertQuiescentAfterRewake(world, waterConfig, "edge/down-flow-rate");
}

function assertWaterDoesNotMergeDisconnectedVerticalSpans(): void {
  const world = createEmptyWorld(3, 6, 3);
  world.solid.fill(1);
  for (const y of [0, 1, 3, 4, 5]) {
    world.solid[index(world, 1, y, 1)] = 0;
  }
  setWater(world, 1, 5, 1, 1);
  wakeCell(world, 1, 5, 1);

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 80, "edge/disconnected-vertical-spans");

  assert(
    measureColumnWater(world, 1, 1, 3, 5) > 0.99,
    "edge/disconnected-vertical-spans: expected upper span to retain water",
  );
  assert(
    measureColumnWater(world, 1, 1, 0, 1) <= EPSILON,
    "edge/disconnected-vertical-spans: expected lower span to stay dry below solid blocker",
  );
  assertSmallWorldConserved(world, baselineWater, "edge/disconnected-vertical-spans");
  assertQuiescentAfterRewake(world, waterConfig, "edge/disconnected-vertical-spans");
}

function assertWaterTransfersThroughRaisedPortal(): void {
  const world = createTwoColumnPortalWorld(0, 4, 2, 4);
  for (let y = 0; y <= 2; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 360, "edge/raised-portal");

  const sourceWater = measureColumnWater(world, 1, 1, 0, 4);
  const targetWater = measureColumnWater(world, 2, 1, 2, 4);
  assert(
    targetWater >= 0.45 && targetWater <= 0.55,
    `edge/raised-portal: expected raised target span to hold about 0.5 water, got ${targetWater.toFixed(3)}`,
  );
  assert(
    sourceWater >= 2.45 && sourceWater <= 2.55,
    `edge/raised-portal: expected source span to hold about 2.5 water, got ${sourceWater.toFixed(3)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/raised-portal");
  assertQuiescentAfterRewake(world, waterConfig, "edge/raised-portal");
}

function assertWaterTransfersThroughOverlappingPortal(): void {
  const world = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 320, "edge/overlapping-portal");

  const leftWater = measureColumnWater(world, 1, 1, 0, 4);
  const rightWater = measureColumnWater(world, 2, 1, 0, 4);
  assert(
    rightWater > 1.8,
    `edge/overlapping-portal: expected right span to receive water, got ${rightWater.toFixed(3)}`,
  );
  assert(
    Math.abs(leftWater - rightWater) < 0.35,
    `edge/overlapping-portal: expected water heads to nearly equalize, got left=${leftWater.toFixed(3)} right=${rightWater.toFixed(3)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/overlapping-portal");
  assertQuiescentAfterRewake(world, waterConfig, "edge/overlapping-portal");
}

function assertWaterFluxMetadataTracksLateralTransfer(): void {
  const world = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });

  assert(stats.movedVolume > 0, "edge/flux-metadata: expected first tick to move water");
  assert(stats.flowChanged, "edge/flux-metadata: expected water flow metadata to change");
  assert(stats.surfaceChanged, "edge/flux-metadata: expected water surface metadata to change");
  assert(world.waterFlux.size > 0, "edge/flux-metadata: expected persistent portal flux");
  assert(
    getCellFlowX(world, 2, 0, 1) > 0,
    `edge/flux-metadata: expected target column to record eastward flow, got ${getCellFlowX(world, 2, 0, 1).toFixed(4)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/flux-metadata: first tick");

  runUntilStable(world, waterConfig, baselineWater, 320, "edge/flux-metadata");
  assert(world.waterFlux.size === 0, `edge/flux-metadata: expected pipe flux to clear at rest, got ${world.waterFlux.size}`);
  assertSmallWorldConserved(world, baselineWater, "edge/flux-metadata");
}

function assertWaterSurfaceMetadataTracksMotion(): void {
  const world = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });
  const targetMotion = getWaterMotionSample(world, 2, 0, 1);

  assert(stats.surfaceChanged, "edge/surface-motion: expected transfer to disturb water surface");
  assert(totalWaterSurfaceMagnitude(world) > EPSILON, "edge/surface-motion: expected non-zero surface motion");
  assert(
    targetMotion.kind === "lateral" || targetMotion.kind === "turbulent",
    `edge/surface-motion: expected lateral/turbulent target motion, got ${targetMotion.kind}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/surface-motion: first tick");

  runUntilStable(world, waterConfig, baselineWater, 320, "edge/surface-motion");
  const activeCellsAfterWaterSettles = world.activeCells.size;
  runSurfaceUntilSettled(world, waterConfig, baselineWater, 240, "edge/surface-motion");
  assert(
    activeCellsAfterWaterSettles === 0 && world.activeCells.size === 0,
    `edge/surface-motion: surface waves should not keep water active cells awake (${activeCellsAfterWaterSettles} -> ${world.activeCells.size})`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/surface-motion");
}

function assertWaterParticleCuesFollowMotion(): void {
  const settledWorld = createEmptyWorld(3, 3, 3);
  setWater(settledWorld, 1, 0, 1, 1);
  const settledCue = getWaterParticleCue(settledWorld, 1, 0, 1, 1);
  assert(settledCue.kind === "none", `edge/particle-cue: expected settled water to emit none, got ${settledCue.kind}`);

  const lateralWorld = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(lateralWorld, 1, y, 1, 1);
    wakeCell(lateralWorld, 1, y, 1);
  }
  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  stepWaterSimulation(lateralWorld, waterConfig, { collectFlowEvents: false });
  const lateralAmount = lateralWorld.water[index(lateralWorld, 2, 0, 1)];
  const lateralCue = getWaterParticleCue(lateralWorld, 2, 0, 1, lateralAmount);
  assert(
    lateralCue.kind === "jet" || lateralCue.kind === "spray" || lateralCue.kind === "splash",
    `edge/particle-cue: expected moving lateral water to emit particles, got ${lateralCue.kind}`,
  );
  assert(lateralCue.intensity > 0, "edge/particle-cue: expected positive lateral cue intensity");
  assert(
    lateralCue.direction.x > 0.25,
    `edge/particle-cue: expected eastward lateral cue direction, got x=${lateralCue.direction.x.toFixed(3)}`,
  );

  const fallingWorld = createEmptyWorld(3, 6, 3);
  fallingWorld.solid.fill(1);
  for (let y = 0; y < 6; y += 1) {
    fallingWorld.solid[index(fallingWorld, 1, y, 1)] = 0;
  }
  setWater(fallingWorld, 1, 4, 1, 1);
  wakeCell(fallingWorld, 1, 4, 1);
  stepWaterSimulation(fallingWorld, waterConfig, { collectFlowEvents: false });
  const fallingAmount = fallingWorld.water[index(fallingWorld, 1, 3, 1)];
  const fallingCue = getWaterParticleCue(fallingWorld, 1, 3, 1, fallingAmount);
  assert(
    fallingCue.kind === "spray" || fallingCue.kind === "splash",
    `edge/particle-cue: expected falling water to emit spray/splash, got ${fallingCue.kind}`,
  );
  assert(fallingCue.intensity > 0, "edge/particle-cue: expected positive falling cue intensity");
  assert(
    fallingCue.direction.y < -0.25,
    `edge/particle-cue: expected downward falling cue direction, got y=${fallingCue.direction.y.toFixed(3)}`,
  );
}

function assertFlowEventCollectionDoesNotChangeWaterState(): void {
  const withoutEvents = createTwoColumnPortalWorld(0, 4, 0, 4);
  const withEvents = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(withoutEvents, 1, y, 1, 1);
    setWater(withEvents, 1, y, 1, 1);
    wakeCell(withoutEvents, 1, y, 1);
    wakeCell(withEvents, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const statsWithoutEvents = stepWaterSimulation(withoutEvents, waterConfig, { collectFlowEvents: false });
  const statsWithEvents = stepWaterSimulation(withEvents, waterConfig, { collectFlowEvents: true });

  assert(statsWithEvents.flowEvents.length > 0, "edge/flow-events-contract: expected collected flow events");
  assert(
    Math.abs(statsWithoutEvents.movedVolume - statsWithEvents.movedVolume) <= 0.0001,
    "edge/flow-events-contract: event collection changed moved volume",
  );
  assert(
    statsWithoutEvents.changedCells === statsWithEvents.changedCells,
    "edge/flow-events-contract: event collection changed changed cell count",
  );
  assertWaterArraysEqual(withoutEvents, withEvents, "edge/flow-events-contract");
  assertWaterFlowArraysEqual(withoutEvents, withEvents, "edge/flow-events-contract");
  assertWaterSurfaceArraysEqual(withoutEvents, withEvents, "edge/flow-events-contract");
  assertSetsEqual(withoutEvents.activeFlowCells, withEvents.activeFlowCells, "edge/flow-events-contract: active flow cells");
  assertSetsEqual(
    withoutEvents.activeSurfaceCells,
    withEvents.activeSurfaceCells,
    "edge/flow-events-contract: active surface cells",
  );
}

function assertTopologyChangesClearWaterMotion(): void {
  const world = createTwoColumnPortalWorld(0, 4, 0, 4);
  for (let y = 0; y <= 3; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });
  assert(world.waterFlux.size > 0, "edge/topology-clears-flow: expected flux before terrain change");
  assert(totalWaterFlowMagnitude(world) > EPSILON, "edge/topology-clears-flow: expected flow vector before terrain change");
  assert(totalWaterSurfaceMagnitude(world) > EPSILON, "edge/topology-clears-flow: expected surface motion before terrain change");

  const removed = openClearBox(world, { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  assert(removed === 1, `edge/topology-clears-flow: expected one solid cell removed, got ${removed}`);
  assert(world.waterFlux.size === 0, "edge/topology-clears-flow: terrain change should clear pipe flux");
  assert(totalWaterFlowMagnitude(world) <= EPSILON, "edge/topology-clears-flow: terrain change should clear flow vectors");
  assert(world.activeFlowCells.size === 0, "edge/topology-clears-flow: terrain change should clear active flow cells");
  assert(totalWaterSurfaceMagnitude(world) <= EPSILON, "edge/topology-clears-flow: terrain change should clear surface motion");
  assert(world.activeSurfaceCells.size === 0, "edge/topology-clears-flow: terrain change should clear active surface cells");
}

function assertWaterSpillsIntoLowerAdjacentShaft(): void {
  const world = createTwoColumnPortalWorld(2, 4, 0, 4);
  for (let y = 2; y <= 4; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 360, "edge/lower-adjacent-shaft");

  const targetLowerWater = measureColumnWater(world, 2, 1, 0, 1);
  const sourceWater = measureColumnWater(world, 1, 1, 2, 4);
  assert(
    targetLowerWater >= 1.95,
    `edge/lower-adjacent-shaft: expected lower shaft to fill before equalizing, got ${targetLowerWater.toFixed(3)}`,
  );
  assert(
    sourceWater >= 0.35 && sourceWater <= 0.65,
    `edge/lower-adjacent-shaft: expected source head near target head, got ${sourceWater.toFixed(3)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/lower-adjacent-shaft");
  assertQuiescentAfterRewake(world, waterConfig, "edge/lower-adjacent-shaft");
}

function assertWaterDoesNotCrossNonOverlappingPortal(): void {
  const world = createTwoColumnPortalWorld(3, 4, 0, 1);
  setWater(world, 1, 3, 1, 1);
  setWater(world, 1, 4, 1, 1);
  wakeCell(world, 1, 3, 1);
  wakeCell(world, 1, 4, 1);

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 80, "edge/non-overlapping-portal");

  const rightWater = measureColumnWater(world, 2, 1, 0, 1);
  assert(
    rightWater <= EPSILON,
    `edge/non-overlapping-portal: expected disconnected neighbor span to stay dry, got ${rightWater.toFixed(3)}`,
  );
  assertSmallWorldConserved(world, baselineWater, "edge/non-overlapping-portal");
  assertQuiescentAfterRewake(world, waterConfig, "edge/non-overlapping-portal");
}

function assertDisconnectedPocketDoesNotReceiveWaterThroughOverhang(): void {
  const world = createSplitTargetPortalWorld(5);
  setWater(world, 1, 0, 1, 1);
  setWater(world, 1, 1, 1, 1);
  setWater(world, 1, 2, 1, 0.4);
  wakeCell(world, 1, 0, 1);
  wakeCell(world, 1, 1, 1);
  wakeCell(world, 1, 2, 1);

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 800, "edge/disconnected-overhang-pocket");

  const lowerTargetWater = measureColumnWater(world, 2, 1, 0, 1);
  const upperTargetWater = measureColumnWater(world, 2, 1, 3, 4);
  assert(
    lowerTargetWater > 1,
    `edge/disconnected-overhang-pocket: expected lower target span to receive water, got ${lowerTargetWater.toFixed(3)}`,
  );
  assert(
    upperTargetWater <= EPSILON,
    `edge/disconnected-overhang-pocket: expected upper target pocket to stay dry, got ${upperTargetWater.toFixed(3)}`,
  );
  assert(world.solid[index(world, 2, 2, 1)] === 1, "edge/disconnected-overhang-pocket: separator should stay solid");
  assert(world.water[index(world, 2, 2, 1)] <= EPSILON, "edge/disconnected-overhang-pocket: separator should stay dry");
  assertSmallWorldConserved(world, baselineWater, "edge/disconnected-overhang-pocket");
  assertQuiescentAfterRewake(world, waterConfig, "edge/disconnected-overhang-pocket");
}

function assertStackedOverhangSpansAreEnumeratedSeparately(): void {
  const world = createSplitTargetPortalWorld(6);
  for (let y = 0; y <= 4; y += 1) {
    setWater(world, 1, y, 1, 1);
    wakeCell(world, 1, y, 1);
  }
  setWater(world, 1, 5, 1, 0.6);
  wakeCell(world, 1, 5, 1);

  const waterConfig = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID).waterConfig;
  const baselineWater = totalWater(world);
  runUntilStable(world, waterConfig, baselineWater, 900, "edge/stacked-overhang-spans");

  const lowerTargetWater = measureColumnWater(world, 2, 1, 0, 1);
  const upperTargetWater = measureColumnWater(world, 2, 1, 3, 5);
  assert(
    lowerTargetWater >= 1.95,
    `edge/stacked-overhang-spans: expected lower target span nearly full, got ${lowerTargetWater.toFixed(3)}`,
  );
  assert(
    upperTargetWater >= 0.2 && upperTargetWater <= 0.45,
    `edge/stacked-overhang-spans: expected upper target span to receive partial water, got ${upperTargetWater.toFixed(3)}`,
  );
  assert(world.solid[index(world, 2, 2, 1)] === 1, "edge/stacked-overhang-spans: separator should stay solid");
  assert(world.water[index(world, 2, 2, 1)] <= EPSILON, "edge/stacked-overhang-spans: separator should stay dry");
  assertSmallWorldConserved(world, baselineWater, "edge/stacked-overhang-spans");
  assertQuiescentAfterRewake(world, waterConfig, "edge/stacked-overhang-spans");
}

function createTwoColumnPortalWorld(
  leftMinY: number,
  leftMaxY: number,
  rightMinY: number,
  rightMaxY: number,
): VoxelWorld {
  const world = createEmptyWorld(4, 5, 3);
  world.solid.fill(1);

  for (let y = leftMinY; y <= leftMaxY; y += 1) {
    world.solid[index(world, 1, y, 1)] = 0;
  }

  for (let y = rightMinY; y <= rightMaxY; y += 1) {
    world.solid[index(world, 2, y, 1)] = 0;
  }

  return world;
}

function createSplitTargetPortalWorld(height: number): VoxelWorld {
  const world = createEmptyWorld(4, height, 3);
  world.solid.fill(1);

  for (let y = 0; y < height; y += 1) {
    world.solid[index(world, 1, y, 1)] = 0;
  }

  world.solid[index(world, 2, 0, 1)] = 0;
  world.solid[index(world, 2, 1, 1)] = 0;
  for (let y = 3; y < height; y += 1) {
    world.solid[index(world, 2, y, 1)] = 0;
  }

  return world;
}

function measureColumnWater(world: VoxelWorld, x: number, z: number, minY: number, maxY: number): number {
  let water = 0;
  for (let y = minY; y <= maxY; y += 1) {
    water += world.water[index(world, x, y, z)];
  }
  return water;
}

function getCellFlowX(world: VoxelWorld, x: number, y: number, z: number): number {
  return world.waterFlow[index(world, x, y, z) * 3];
}

function totalWaterFlowMagnitude(world: VoxelWorld): number {
  let total = 0;
  for (let offset = 0; offset < world.waterFlow.length; offset += 3) {
    total += Math.hypot(world.waterFlow[offset], world.waterFlow[offset + 1], world.waterFlow[offset + 2]);
  }
  return total;
}

function totalWaterSurfaceMagnitude(world: VoxelWorld): number {
  let total = 0;
  for (let cellIndex = 0; cellIndex < world.waterSurfaceOffset.length; cellIndex += 1) {
    total += Math.abs(world.waterSurfaceOffset[cellIndex]) + Math.abs(world.waterSurfaceVelocity[cellIndex]);
  }
  return total;
}

function assertWaterArraysEqual(a: VoxelWorld, b: VoxelWorld, context: string): void {
  assert(a.water.length === b.water.length, `${context}: water array length mismatch`);
  for (let cellIndex = 0; cellIndex < a.water.length; cellIndex += 1) {
    assert(
      Math.abs(a.water[cellIndex] - b.water[cellIndex]) <= 0.0001,
      `${context}: water mismatch at ${formatCell(a, cellIndex)} (${a.water[cellIndex].toFixed(6)} vs ${b.water[cellIndex].toFixed(6)})`,
    );
  }
}

function assertWaterFlowArraysEqual(a: VoxelWorld, b: VoxelWorld, context: string): void {
  assert(a.waterFlow.length === b.waterFlow.length, `${context}: water flow array length mismatch`);
  for (let offset = 0; offset < a.waterFlow.length; offset += 1) {
    assert(
      Math.abs(a.waterFlow[offset] - b.waterFlow[offset]) <= 0.0001,
      `${context}: water flow mismatch at offset ${offset} (${a.waterFlow[offset].toFixed(6)} vs ${b.waterFlow[offset].toFixed(6)})`,
    );
  }
}

function assertWaterSurfaceArraysEqual(a: VoxelWorld, b: VoxelWorld, context: string): void {
  assert(a.waterSurfaceOffset.length === b.waterSurfaceOffset.length, `${context}: water surface offset array length mismatch`);
  assert(
    a.waterSurfaceVelocity.length === b.waterSurfaceVelocity.length,
    `${context}: water surface velocity array length mismatch`,
  );
  for (let cellIndex = 0; cellIndex < a.waterSurfaceOffset.length; cellIndex += 1) {
    assert(
      Math.abs(a.waterSurfaceOffset[cellIndex] - b.waterSurfaceOffset[cellIndex]) <= 0.0001,
      `${context}: water surface offset mismatch at ${formatCell(a, cellIndex)} (${a.waterSurfaceOffset[cellIndex].toFixed(
        6,
      )} vs ${b.waterSurfaceOffset[cellIndex].toFixed(6)})`,
    );
    assert(
      Math.abs(a.waterSurfaceVelocity[cellIndex] - b.waterSurfaceVelocity[cellIndex]) <= 0.0001,
      `${context}: water surface velocity mismatch at ${formatCell(a, cellIndex)} (${a.waterSurfaceVelocity[
        cellIndex
      ].toFixed(6)} vs ${b.waterSurfaceVelocity[cellIndex].toFixed(6)})`,
    );
  }
}

function assertSetsEqual(a: Set<number>, b: Set<number>, context: string): void {
  assert(a.size === b.size, `${context}: set size mismatch (${a.size} vs ${b.size})`);
  for (const value of a) {
    assert(b.has(value), `${context}: missing value ${value}`);
  }
}

function assertSmallWorldConserved(world: VoxelWorld, baselineWater: number, context: string): void {
  const volumeDelta = Math.abs(totalWater(world) - baselineWater);
  assert(volumeDelta <= 0.0001, `${context}: expected strict conservation, drifted by ${volumeDelta.toFixed(6)}`);
}

function runSurfaceUntilSettled(
  world: VoxelWorld,
  waterConfig: ReturnType<typeof cloneTuningPreset>["waterConfig"],
  baselineWater: number,
  maxTicks: number,
  context: string,
): void {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });
    assert(stats.movedVolume <= EPSILON, `${context}: expected no volume movement during surface settle, got ${stats.movedVolume}`);
    scanWorldWater(world, baselineWater, 0.0001, `${context}: surface settle ${tick}`);

    if (world.activeSurfaceCells.size === 0 && totalWaterSurfaceMagnitude(world) <= EPSILON) {
      return;
    }
  }

  assert(false, `${context}: expected water surface motion to settle within ${maxTicks} ticks`);
}

function assertQuiescentAfterRewake(
  world: VoxelWorld,
  waterConfig: ReturnType<typeof cloneTuningPreset>["waterConfig"],
  context: string,
): void {
  for (const cellIndex of world.wetCells) {
    world.activeCells.add(cellIndex);
  }

  const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });
  assert(stats.movedVolume <= EPSILON, `${context}: expected no moved volume after rewake, got ${stats.movedVolume.toFixed(6)}`);
  assert(stats.changedCells === 0, `${context}: expected no changed cells after rewake, got ${stats.changedCells}`);
  assert(world.activeCells.size === 0, `${context}: expected rewoken stable water to sleep immediately`);
}

function assertFirstPersonVelocitySmoothsInput(): void {
  const velocity = new Vector3(0, 0, 0);
  const target = new Vector3(7.2, 0, 0);

  FIRST_PERSON_MOVEMENT_TEST_HOOKS.moveVectorToward(velocity, target, 0.6);
  assert(
    velocity.x > 0 && velocity.x < target.x,
    `first-person/smooth-input: expected eased acceleration below target speed, got ${velocity.x.toFixed(3)}`,
  );

  velocity.set(4, 0, 0);
  FIRST_PERSON_MOVEMENT_TEST_HOOKS.moveVectorToward(velocity, new Vector3(0, 0, 0), 0.7);
  assert(
    velocity.x > 0 && velocity.x < 4,
    `first-person/smooth-input: expected eased deceleration, got ${velocity.x.toFixed(3)}`,
  );

  const blockedVelocity = FIRST_PERSON_MOVEMENT_TEST_HOOKS.dampBlockedVelocityAxis(4, 0, 0.2, 1 / 60);
  assert(blockedVelocity === 0, `first-person/smooth-input: expected blocked axis to damp to zero, got ${blockedVelocity}`);
}

function assertFirstPersonCornerClearanceUsesRoundFootprint(): void {
  const world = createEmptyWorld(8, 5, 8);
  world.solid[index(world, 4, 1, 4)] = 1;

  const diagonalCornerPosition = new Vector3(gridToWorldX(world, 3.75), 2.72, gridToWorldZ(world, 3.75));
  assert(
    FIRST_PERSON_MOVEMENT_TEST_HOOKS.canOccupy(diagonalCornerPosition, world),
    "first-person/corner-clearance: diagonal voxel corner should not catch the round player footprint",
  );

  const sideTouchPosition = new Vector3(gridToWorldX(world, 3.75), 2.72, gridToWorldZ(world, 4.5));
  assert(
    !FIRST_PERSON_MOVEMENT_TEST_HOOKS.canOccupy(sideTouchPosition, world),
    "first-person/corner-clearance: side overlap should still block the player",
  );
}

function assertFirstPersonGroundMovementClimbsVoxelSlopeSmoothly(): void {
  const world = createEmptyWorld(12, 5, 8);
  for (let z = 0; z < world.depth; z += 1) {
    for (let x = 0; x < world.width; x += 1) {
      world.solid[index(world, x, 0, z)] = 1;
    }
  }
  for (let x = 4; x <= 9; x += 1) {
    world.solid[index(world, x, 1, 3)] = 1;
  }

  const startPosition = new Vector3(gridToWorldX(world, 3.3), 2.72, gridToWorldZ(world, 3.5));
  assert(
    FIRST_PERSON_MOVEMENT_TEST_HOOKS.canOccupy(startPosition, world),
    "first-person/smooth-slope: expected start position to be open",
  );

  const blockedBody = { position: startPosition.clone() };
  FIRST_PERSON_MOVEMENT_TEST_HOOKS.moveHorizontally(world, blockedBody, 0.9, 0, false);
  assert(
    blockedBody.position.x < gridToWorldX(world, 3.8),
    "first-person/smooth-slope: expected one-voxel slope to block without step-up",
  );

  const camera = new PerspectiveCamera();
  camera.position.copy(startPosition);
  const physics = {
    position: startPosition.clone(),
    verticalVelocity: 0,
    horizontalVelocity: new Vector3(),
    jumpQueued: false,
    grounded: true,
  };
  const keys = new Set<string>(["forward"]);
  let maxCameraRisePerFrame = 0;
  for (let frame = 0; frame < 45; frame += 1) {
    const previousCameraY = camera.position.y;
    FIRST_PERSON_MOVEMENT_TEST_HOOKS.updateMovement(world, camera, keys, -Math.PI / 2, 1 / 60, physics);
    maxCameraRisePerFrame = Math.max(maxCameraRisePerFrame, camera.position.y - previousCameraY);
  }

  assert(
    physics.position.x > gridToWorldX(world, 4.25) && physics.position.y > 3.4,
    `first-person/smooth-slope: expected grounded movement to climb a voxel slope, got ${physics.position.x.toFixed(
      2,
    )},${physics.position.y.toFixed(2)},${physics.position.z.toFixed(2)}`,
  );
  assert(
    maxCameraRisePerFrame <= 0.12,
    `first-person/smooth-slope: expected camera climb to be smoothed, max frame rise=${maxCameraRisePerFrame.toFixed(3)}`,
  );
}

function assertFirstPersonJumpIntoVoxelWallDoesNotMantleImmediately(): void {
  const world = createEmptyWorld(8, 5, 8);
  for (let z = 0; z < world.depth; z += 1) {
    for (let x = 0; x < world.width; x += 1) {
      world.solid[index(world, x, 0, z)] = 1;
    }
  }
  world.solid[index(world, 4, 1, 3)] = 1;

  const camera = new PerspectiveCamera();
  camera.position.set(gridToWorldX(world, 3.3), 2.72, gridToWorldZ(world, 3.5));
  const startPosition = camera.position.clone();
  const physics = {
    position: startPosition.clone(),
    verticalVelocity: 0,
    horizontalVelocity: new Vector3(),
    jumpQueued: true,
    grounded: true,
  };
  const keys = new Set<string>(["forward"]);

  for (let frame = 0; frame < 12; frame += 1) {
    FIRST_PERSON_MOVEMENT_TEST_HOOKS.updateMovement(world, camera, keys, -Math.PI / 2, 1 / 60, physics);
  }

  const wallContactX = gridToWorldX(world, 4) - 0.3;
  assert(
    camera.position.x < wallContactX,
    `first-person/no-jump-mantle: expected forward jump into a voxel wall to stay blocked early, got x=${camera.position.x.toFixed(
      3,
    )}`,
  );
}

function assertFirstPersonRisingJumpDoesNotSnapToVoxelTop(): void {
  const world = createEmptyWorld(8, 5, 8);
  for (let z = 0; z < world.depth; z += 1) {
    for (let x = 0; x < world.width; x += 1) {
      world.solid[index(world, x, 0, z)] = 1;
    }
  }
  world.solid[index(world, 4, 1, 3)] = 1;

  const camera = new PerspectiveCamera();
  camera.position.set(gridToWorldX(world, 4.5), 3.72, gridToWorldZ(world, 3.5));
  const startY = camera.position.y;
  const physics = {
    position: camera.position.clone(),
    verticalVelocity: 3,
    horizontalVelocity: new Vector3(),
    jumpQueued: false,
    grounded: false,
  };

  FIRST_PERSON_MOVEMENT_TEST_HOOKS.updateMovement(world, camera, new Set<string>(), 0, 1 / 60, physics);

  assert(
    camera.position.y > startY && physics.verticalVelocity > 0,
    `first-person/no-rise-snap: expected rising jump to keep moving upward near a voxel top, got y=${camera.position.y.toFixed(
      3,
    )}, vy=${physics.verticalVelocity.toFixed(3)}`,
  );
}

function gridToWorldX(world: VoxelWorld, x: number): number {
  return x - world.width / 2;
}

function gridToWorldZ(world: VoxelWorld, z: number): number {
  return z - world.depth / 2;
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

    const movedVolume = runUntilStable(
      world,
      tuning.waterConfig,
      baselineWater,
      getProgressiveStageMaxTicks(preset),
      `${preset}: stage ${stageIndex + 1}`,
    );
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
  const maxTicks = getScenarioMaxTicks(preset);
  const movedVolume = runUntilStable(
    world,
    tuning.waterConfig,
    baselineWater,
    maxTicks,
    `${preset}/${tuningPreset}`,
    (volumeDelta) => {
      maxVolumeDelta = Math.max(maxVolumeDelta, volumeDelta);
    },
  );

  assert(movedVolume > 0, `${preset}/${tuningPreset}: expected water to move after opening drain`);
  assert(
    world.activeCells.size === 0,
    `${preset}/${tuningPreset}: expected water to stabilize before ${maxTicks} ticks`,
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

function getScenarioTuningPresets(preset: ScenePresetId): readonly TuningPresetId[] {
  return isLargeCavernPreset(preset) ? [DEFAULT_TUNING_PRESET_ID] : TUNING_PRESETS;
}

function getProgressiveStageMaxTicks(preset: ScenePresetId): number {
  return isLargeCavernPreset(preset) ? LARGE_CAVERN_MAX_TICKS : MAX_STAGE_TICKS;
}

function getScenarioMaxTicks(preset: ScenePresetId): number {
  return isLargeCavernPreset(preset) ? LARGE_CAVERN_MAX_TICKS : MAX_TICKS;
}

function isLargeCavernPreset(preset: ScenePresetId): boolean {
  return preset === "generated-cavern";
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
  const volumeTolerance = Math.max(CONSERVATION_TOLERANCE, baselineWater * CONSERVATION_RELATIVE_TOLERANCE);
  const scanIntervalTicks = getWaterScanIntervalTicks(world);

  for (let tick = 0; tick < maxTicks; tick += 1) {
    const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false });
    movedVolume += stats.movedVolume;
    if (shouldScanWaterTick(tick, scanIntervalTicks)) {
      scanWorldWater(world, baselineWater, volumeTolerance, `${context}: tick ${tick}`, onVolumeDelta);
    }

    if (world.activeCells.size === 0) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
    }

    if (idleTicks >= 4) {
      break;
    }
  }

  scanWorldWater(world, baselineWater, volumeTolerance, `${context}: final`, onVolumeDelta);
  return movedVolume;
}

function getWaterScanIntervalTicks(world: VoxelWorld): number {
  if (world.water.length <= SMALL_WORLD_SCAN_CELL_LIMIT) {
    return 1;
  }

  return HARNESS_OPTIONS.scanIntervalTicks;
}

function shouldScanWaterTick(tick: number, scanIntervalTicks: number): boolean {
  return scanIntervalTicks <= 1 || tick === 0 || tick % scanIntervalTicks === 0;
}

function scanWorldWater(
  world: VoxelWorld,
  baselineWater: number,
  volumeTolerance: number,
  context: string,
  onVolumeDelta?: (volumeDelta: number) => void,
): void {
  const volumeDelta = Math.abs(totalWater(world) - baselineWater);
  onVolumeDelta?.(volumeDelta);
  assert(volumeDelta <= volumeTolerance, `${context}: water volume drifted by ${volumeDelta.toFixed(6)}`);
  assertNoInvalidWater(world, context);
}

function assertNoInvalidWater(world: VoxelWorld, context: string): void {
  assert(
    world.waterFlow.length === world.water.length * 3,
    `${context}: water flow buffer length ${world.waterFlow.length} does not match water cells ${world.water.length}`,
  );
  assert(
    world.waterSurfaceOffset.length === world.water.length,
    `${context}: water surface offset buffer length ${world.waterSurfaceOffset.length} does not match water cells ${world.water.length}`,
  );
  assert(
    world.waterSurfaceVelocity.length === world.water.length,
    `${context}: water surface velocity buffer length ${world.waterSurfaceVelocity.length} does not match water cells ${world.water.length}`,
  );

  for (let cellIndex = 0; cellIndex < world.water.length; cellIndex += 1) {
    const water = world.water[cellIndex];
    assert(Number.isFinite(water), `${context}: non-finite water at ${formatCell(world, cellIndex)}`);
    assert(water >= 0 - EPSILON && water <= 1 + EPSILON, `${context}: water out of range at ${formatCell(world, cellIndex)}`);
    assert(
      !(world.solid[cellIndex] === 1 && water > EPSILON),
      `${context}: water inside solid at ${formatCell(world, cellIndex)}`,
    );
  }

  for (let offset = 0; offset < world.waterFlow.length; offset += 1) {
    const flow = world.waterFlow[offset];
    assert(Number.isFinite(flow), `${context}: non-finite water flow at offset ${offset}`);
    assert(Math.abs(flow) <= 2.5001, `${context}: water flow out of range at offset ${offset}: ${flow.toFixed(6)}`);
  }

  for (const [key, flux] of world.waterFlux) {
    assert(Number.isFinite(flux), `${context}: non-finite pipe flux at ${key}`);
    assert(Math.abs(flux) <= 2.5001, `${context}: pipe flux out of range at ${key}: ${flux.toFixed(6)}`);
  }

  for (let cellIndex = 0; cellIndex < world.waterSurfaceOffset.length; cellIndex += 1) {
    const offset = world.waterSurfaceOffset[cellIndex];
    const velocity = world.waterSurfaceVelocity[cellIndex];
    assert(Number.isFinite(offset), `${context}: non-finite water surface offset at ${formatCell(world, cellIndex)}`);
    assert(Number.isFinite(velocity), `${context}: non-finite water surface velocity at ${formatCell(world, cellIndex)}`);
    assert(
      Math.abs(offset) <= WATER_SURFACE_OFFSET_LIMIT + 0.0001,
      `${context}: water surface offset out of range at ${formatCell(world, cellIndex)}: ${offset.toFixed(6)}`,
    );
    assert(
      Math.abs(velocity) <= WATER_SURFACE_VELOCITY_LIMIT + 0.0001,
      `${context}: water surface velocity out of range at ${formatCell(world, cellIndex)}: ${velocity.toFixed(6)}`,
    );
  }

  for (const cellIndex of world.activeSurfaceCells) {
    assert(cellIndex >= 0 && cellIndex < world.water.length, `${context}: active surface cell out of bounds: ${cellIndex}`);
  }

  for (const cellIndex of world.activeFlowCells) {
    assert(cellIndex >= 0 && cellIndex < world.water.length, `${context}: active flow cell out of bounds: ${cellIndex}`);
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
