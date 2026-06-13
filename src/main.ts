import "./style.css";
import { createDebugOverlay, updateDebugOverlay } from "./debug/debugOverlay";
import { createDebugPanel } from "./debug/debugPanel";
import { createGamePanel } from "./game/gamePanel";
import { evaluateLevel, GAME_LEVELS, getLevel, type GameLevel, type LevelProgress } from "./game/levels";
import { createCellInspector } from "./input/cellInspector";
import { createFirstPersonController } from "./input/firstPersonController";
import {
  bindKeyboardControls,
  configureOrbitControls,
  createDigController,
  type InputState,
} from "./input/controls";
import { createActiveCellRenderer, type ActiveCellRenderer } from "./render/activeCellRenderer";
import { createBrushPreviewRenderer, type BrushPreviewRenderer } from "./render/brushPreviewRenderer";
import { createFlowDebugRenderer, type FlowDebugRenderer, type RecentFlow } from "./render/flowDebugRenderer";
import { createSceneContext } from "./render/scene";
import { createSonarRenderer } from "./render/sonarRenderer";
import { createStageGuideRenderer, type StageGuideRenderer } from "./render/stageGuideRenderer";
import { createTerrainRenderer, type TerrainRenderer } from "./render/terrainRenderer";
import { createWaterRenderer, type WaterRenderer } from "./render/waterRenderer";
import type { RenderOptions } from "./render/renderOptions";
import {
  clearCustomTuning as clearStoredCustomTuning,
  loadCustomTuning as loadStoredCustomTuning,
  saveCustomTuning as saveStoredCustomTuning,
  type StoredCustomTuning,
} from "./sim/customTuningStorage";
import { stepWaterSimulation, type FlowEvent, type WaterSimulationConfig } from "./sim/waterSimulation";
import {
  cloneTuningPreset,
  DEFAULT_DIG_RADIUS,
  DEFAULT_TUNING_PRESET_ID,
  TUNING_PRESETS,
  type TuningPresetId,
} from "./sim/tuningPresets";
import { totalWater } from "./world/grid";
import { createWorld, SCENE_PRESET_DETAILS, SCENE_PRESETS, type ScenePresetId } from "./world/createWorld";
import {
  countStageSolidCells,
  getSceneOpeningStages,
  getStageChoices,
  getStageDigBoxes,
  isCellInStage,
  isStageAutoOpen,
  openClearBox,
  openSceneStage,
  type SceneOpeningStage,
} from "./world/sceneTools";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

const sceneContext = createSceneContext(app);
configureOrbitControls(sceneContext.controls);

const VOLUME_WARNING_TOLERANCE = 0.05;
const FLOW_DEBUG_TTL = 16;
const STABLE_COMPLETE_TICKS = 18;
const STAGE_CLEAR_RATIO = 0.72;
const initialUrlParams = new URLSearchParams(window.location.search);

let gameModeEnabled = getInitialGameModeEnabled();
let currentLevelIndex = getInitialLevelIndex();
let currentPreset: ScenePresetId = gameModeEnabled ? getCurrentLevel().scene : getInitialPreset();
let firstPersonMode = getInitialFirstPersonEnabled();
let world = createWorld(currentPreset);
let openedStageChoices: number[] = [];
let openedStageCount = openInitialStages(world, currentPreset, openedStageChoices);
let openedHazards = openInitialHazards(world, getCurrentLevel());
let stageInitialSolidCounts = getStageSolidCounts(world, currentPreset);
let hazardInitialSolidCounts = getHazardSolidCounts(world, getCurrentLevel());
let terrainRenderer: TerrainRenderer = createTerrainRenderer(sceneContext.scene, world);
let waterRenderer: WaterRenderer = createWaterRenderer(sceneContext.scene, world);
let activeCellRenderer: ActiveCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
let flowDebugRenderer: FlowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
let brushPreviewRenderer: BrushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
let stageGuideRenderer: StageGuideRenderer = createStageGuideRenderer(sceneContext.scene);
let hazardGuideRenderer: StageGuideRenderer = createStageGuideRenderer(sceneContext.scene, {
  color: 0xff4a3d,
  opacity: 0.22,
  scale: 1.06,
  wireframe: false,
});
const sonarRenderer = createSonarRenderer(document.body, world);
let baselineWaterVolume = totalWater(world);
let levelProgress: LevelProgress | null = gameModeEnabled ? evaluateLevel(world, getCurrentLevel(), getMissionStageProgress(), false) : null;
const initialTuningPreset = getInitialTuningPreset();
let currentTuningPreset: TuningPresetId | "custom" = initialTuningPreset;
let activeTuning = cloneTuningPreset(initialTuningPreset);
let waterConfig: WaterSimulationConfig = { ...activeTuning.waterConfig };
let simStepsPerFrame = activeTuning.simStepsPerFrame;
let hasSavedCustomTuning = loadStoredCustomTuning() !== null;
let recentFlows = new Map<number, RecentFlow>();

const inputState: InputState = {
  paused: false,
  debugWater: initialUrlParams.get("debug") === "1",
  showActiveCells: initialUrlParams.get("active") !== "0",
  showFlowDebug: initialUrlParams.get("flow") !== "0",
  terrainDirty: true,
  forceWaterUpdate: true,
  sliceEnabled: initialUrlParams.get("slice") === "1",
  sliceZ: getInitialSliceZ(),
  digRadius: DEFAULT_DIG_RADIUS,
};

let queuedStep = false;
let movedLastFrame = 0;
let lastSimulationMs = 0;
let tickCount = 0;
let maxVolumeDelta = 0;
let stableTicks = 0;
let fps = 0;
let lastTime = performance.now();
let debugUiVisible = getInitialDebugUiVisible();
const initialWarmupStableTicks = runInitialSimulationWarmup();
if (initialWarmupStableTicks > 0) {
  stableTicks = initialWarmupStableTicks;
}
baselineWaterVolume = totalWater(world);
levelProgress = gameModeEnabled
  ? evaluateLevel(world, getCurrentLevel(), getMissionStageProgress(), stableTicks >= STABLE_COMPLETE_TICKS)
  : null;

const overlay = createDebugOverlay();
const gamePanel = createGamePanel({
  resetLevel: resetCurrentLevel,
  nextLevel: advanceToNextLevel,
});
const firstPersonController = createFirstPersonController(sceneContext.renderer, sceneContext.camera, firstPersonMode);
if (firstPersonMode) {
  firstPersonController.reset(world);
}
sceneContext.controls.enabled = !firstPersonMode;
const digController = createDigController(
  sceneContext.renderer,
  sceneContext.camera,
  () => world,
  () => terrainRenderer,
  inputState,
  () => canAcceptDigInput(),
  () => firstPersonMode && firstPersonController.hasSceneAim(),
  (cellIndex) => canDigCell(cellIndex),
  handleDig,
);
const cellInspector = createCellInspector(
  sceneContext.renderer,
  sceneContext.camera,
  () => world,
  () => terrainRenderer,
  () => waterRenderer,
  () => getRenderOptions(),
);

const debugPanel = createDebugPanel({
  getSnapshot: () => ({
    preset: currentPreset,
    paused: inputState.paused,
    debugWater: inputState.debugWater,
    showActiveCells: inputState.showActiveCells,
    showFlowDebug: inputState.showFlowDebug,
    sliceEnabled: inputState.sliceEnabled,
    sliceZ: getRenderOptions().slice.z,
    maxSliceZ: world.depth - 1,
    tickCount,
    maxVolumeDelta,
    stableTicks,
    lastMovedVolume: movedLastFrame,
    stable: isStable(),
    nextOpeningLabel: getNextOpeningLabel(),
    openedStages: openedStageCount,
    openingStages: getSceneOpeningStages(currentPreset).length,
    openingStageLabels: getSceneOpeningStages(currentPreset).map((stage) => stage.label),
    lastSimulationMs,
    simStepsPerFrame,
    digRadius: inputState.digRadius,
    tuningPreset: currentTuningPreset,
    hasSavedCustomTuning,
    waterConfig,
  }),
  setPreset: selectPreset,
  setPaused: setPaused,
  step: queueStep,
  reset: resetWorld,
  openScene: openCurrentScene,
  openAllScene: openAllSceneStages,
  setDebugWater: setDebugWater,
  setShowActiveCells: setShowActiveCells,
  setShowFlowDebug: setShowFlowDebug,
  setSliceEnabled: setSliceEnabled,
  setSliceZ: setSliceZ,
  setSimStepsPerFrame: setSimStepsPerFrame,
  setDigRadius: setDigRadius,
  setWaterConfig: setWaterConfig,
  setTuningPreset: applyTuningPreset,
  saveCustomTuning: saveCurrentCustomTuning,
  loadCustomTuning: loadCustomTuning,
  clearCustomTuning: clearCustomTuning,
  resetTuning: resetTuning,
});

bindKeyboardControls(inputState, {
  reset: resetWorld,
  step: queueStep,
  openScene: openCurrentScene,
  openAllScene: openAllSceneStages,
  selectPreset,
  renderOptionsChanged: markRenderOptionsChanged,
  toggleFirstPerson: toggleFirstPersonMode,
  isFirstPersonActive: () => firstPersonMode,
  toggleDebugUi: toggleDebugUi,
  allowSandboxShortcuts: () => !gameModeEnabled || debugUiVisible,
});

function selectPreset(preset: ScenePresetId): void {
  gameModeEnabled = false;
  levelProgress = null;
  setFirstPersonMode(false);
  currentPreset = preset;
  resetWorld();
}

function resetCurrentLevel(): void {
  gameModeEnabled = true;
  setFirstPersonMode(true);
  currentPreset = getCurrentLevel().scene;
  resetWorld();
  firstPersonController.requestPointerLock();
}

function advanceToNextLevel(): void {
  if (!levelProgress?.complete) {
    return;
  }

  gameModeEnabled = true;
  setFirstPersonMode(true);
  currentLevelIndex = currentLevelIndex >= GAME_LEVELS.length - 1 ? 0 : currentLevelIndex + 1;
  currentPreset = getCurrentLevel().scene;
  resetWorld();
  firstPersonController.requestPointerLock();
}

function toggleFirstPersonMode(): void {
  if (firstPersonMode && !firstPersonController.isPointerLocked()) {
    firstPersonController.requestPointerLock();
    return;
  }

  const nextEnabled = !firstPersonMode;
  setFirstPersonMode(nextEnabled);
  if (nextEnabled) {
    firstPersonController.reset(world);
    firstPersonController.requestPointerLock();
  }
}

function setFirstPersonMode(enabled: boolean): void {
  firstPersonMode = enabled;
  firstPersonController.setEnabled(enabled);
  sceneContext.controls.enabled = !enabled;
}

function setPaused(paused: boolean): void {
  inputState.paused = paused;
}

function queueStep(): void {
  queuedStep = true;
}

function toggleDebugUi(): void {
  debugUiVisible = !debugUiVisible;
  syncBodyModeClasses();
}

function canAcceptDigInput(): boolean {
  if (firstPersonMode && !firstPersonController.hasSceneAim()) {
    return false;
  }

  return !gameModeEnabled || (!levelProgress?.failed && !levelProgress?.complete);
}

function canDigCell(cellIndex: number): boolean {
  if (levelProgress?.failed || levelProgress?.complete) {
    return false;
  }

  if (!gameModeEnabled) {
    return true;
  }

  const stage = getVisibleGuideStage();
  return Boolean(stage && isCellInStage(world, stage, cellIndex)) || isCellInVisibleHazard(cellIndex);
}

function handleDig(): void {
  advanceClearedGameStages();
  openClearedHazards();
}

function advanceClearedGameStages(): void {
  if (!gameModeEnabled) {
    return;
  }

  const stages = getSceneOpeningStages(currentPreset);
  while (openedStageCount < stages.length) {
    const stage = stages[openedStageCount];
    const choices = getStageChoices(stage);
    const initialChoiceSolids = stageInitialSolidCounts[openedStageCount] ?? [];
    let clearedChoiceIndex = -1;

    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
      const initialSolids = initialChoiceSolids[choiceIndex] ?? 0;
      if (initialSolids <= 0) {
        clearedChoiceIndex = choiceIndex;
        break;
      }

      const remainingSolids = countStageSolidCells(world, choices[choiceIndex]);
      const clearedRatio = 1 - remainingSolids / initialSolids;
      if (clearedRatio >= STAGE_CLEAR_RATIO) {
        clearedChoiceIndex = choiceIndex;
        break;
      }
    }

    if (clearedChoiceIndex < 0) {
      break;
    }

    if ((initialChoiceSolids[clearedChoiceIndex] ?? 0) <= 0) {
      openedStageCount += 1;
      continue;
    }

    openedStageChoices[openedStageCount] = clearedChoiceIndex;
    if (isStageAutoOpen(stage)) {
      openSceneStage(world, currentPreset, openedStageCount, clearedChoiceIndex);
    }
    openedStageCount += 1;
    markRenderOptionsChanged();
    inputState.forceWaterUpdate = true;
  }
}

function isCellInVisibleHazard(cellIndex: number): boolean {
  if (!gameModeEnabled) {
    return false;
  }

  return getCurrentLevel().hazardStages.some(
    (hazard, hazardIndex) => !openedHazards.has(hazardIndex) && isCellInStage(world, hazard, cellIndex),
  );
}

function openClearedHazards(): void {
  if (!gameModeEnabled) {
    return;
  }

  for (let hazardIndex = 0; hazardIndex < getCurrentLevel().hazardStages.length; hazardIndex += 1) {
    if (openedHazards.has(hazardIndex)) {
      continue;
    }

    const hazard = getCurrentLevel().hazardStages[hazardIndex];
    const initialSolids = hazardInitialSolidCounts[hazardIndex] ?? 0;
    if (initialSolids <= 0) {
      openedHazards.add(hazardIndex);
      continue;
    }

    const remainingSolids = countStageSolidCells(world, hazard);
    const clearedRatio = 1 - remainingSolids / initialSolids;
    if (clearedRatio < STAGE_CLEAR_RATIO) {
      continue;
    }

    for (const clearRegion of hazard.boxes) {
      openClearBox(world, clearRegion);
    }
    openedHazards.add(hazardIndex);
    markRenderOptionsChanged();
  }
}

function openCurrentScene(): void {
  const stage = getSceneOpeningStages(currentPreset)[openedStageCount];
  if (stage && !isStageAutoOpen(stage)) {
    return;
  }

  const choiceIndex = getInitialStageChoiceIndex(currentPreset, openedStageCount);
  const removed = openSceneStage(world, currentPreset, openedStageCount, choiceIndex);
  if (openedStageCount < getSceneOpeningStages(currentPreset).length) {
    openedStageChoices[openedStageCount] = choiceIndex;
    openedStageCount += 1;
  }
  if (removed > 0) {
    markRenderOptionsChanged();
  }
}

function openAllSceneStages(): void {
  let removed = 0;
  const stageCount = getSceneOpeningStages(currentPreset).length;

  while (openedStageCount < stageCount) {
    const stage = getSceneOpeningStages(currentPreset)[openedStageCount];
    if (!isStageAutoOpen(stage)) {
      break;
    }

    const choiceIndex = getInitialStageChoiceIndex(currentPreset, openedStageCount);
    removed += openSceneStage(world, currentPreset, openedStageCount, choiceIndex);
    openedStageChoices[openedStageCount] = choiceIndex;
    openedStageCount += 1;
  }

  if (removed > 0) {
    markRenderOptionsChanged();
  }
}

function getNextOpeningLabel(): string {
  return getSceneOpeningStages(currentPreset)[openedStageCount]?.label ?? "complete";
}

function setDebugWater(enabled: boolean): void {
  inputState.debugWater = enabled;
  inputState.forceWaterUpdate = true;
}

function setShowActiveCells(enabled: boolean): void {
  inputState.showActiveCells = enabled;
  inputState.forceWaterUpdate = true;
}

function setShowFlowDebug(enabled: boolean): void {
  inputState.showFlowDebug = enabled;
  inputState.forceWaterUpdate = true;
}

function setSliceEnabled(enabled: boolean): void {
  inputState.sliceEnabled = enabled;
  markRenderOptionsChanged();
}

function setSliceZ(z: number): void {
  inputState.sliceZ = Math.min(world.depth - 1, Math.max(0, z));
  markRenderOptionsChanged();
}

function setSimStepsPerFrame(steps: number): void {
  simStepsPerFrame = Math.min(8, Math.max(1, steps));
  currentTuningPreset = "custom";
}

function setDigRadius(radius: number): void {
  inputState.digRadius = Math.min(4, Math.max(0.8, radius));
  currentTuningPreset = "custom";
}

function setWaterConfig(config: WaterSimulationConfig): void {
  waterConfig = {
    downFlowRate: Math.min(1, Math.max(0.05, config.downFlowRate)),
    sideFlowRate: Math.min(0.6, Math.max(0.02, config.sideFlowRate)),
    minFlow: Math.min(0.05, Math.max(0.001, config.minFlow)),
  };
  currentTuningPreset = "custom";
}

function applyTuningPreset(preset: TuningPresetId): void {
  activeTuning = cloneTuningPreset(preset);
  currentTuningPreset = preset;
  waterConfig = { ...activeTuning.waterConfig };
  simStepsPerFrame = activeTuning.simStepsPerFrame;
  inputState.digRadius = activeTuning.digRadius;
}

function applyStoredCustomTuning(tuning: StoredCustomTuning): void {
  setWaterConfig(tuning.waterConfig);
  simStepsPerFrame = Math.min(8, Math.max(1, Math.round(tuning.simStepsPerFrame)));
  inputState.digRadius = Math.min(4, Math.max(0.8, tuning.digRadius));
  currentTuningPreset = "custom";
}

function saveCurrentCustomTuning(): void {
  saveStoredCustomTuning({
    waterConfig,
    simStepsPerFrame,
    digRadius: inputState.digRadius,
  });
  hasSavedCustomTuning = true;
}

function loadCustomTuning(): void {
  const tuning = loadStoredCustomTuning();
  if (!tuning) {
    hasSavedCustomTuning = false;
    return;
  }

  applyStoredCustomTuning(tuning);
  hasSavedCustomTuning = true;
}

function clearCustomTuning(): void {
  clearStoredCustomTuning();
  hasSavedCustomTuning = false;
}

function resetTuning(): void {
  applyTuningPreset(DEFAULT_TUNING_PRESET_ID);
}

function markRenderOptionsChanged(): void {
  inputState.terrainDirty = true;
  inputState.forceWaterUpdate = true;
}

function resetWorld(): void {
  terrainRenderer.dispose();
  waterRenderer.dispose();
  activeCellRenderer.dispose();
  flowDebugRenderer.dispose();
  brushPreviewRenderer.dispose();
  stageGuideRenderer.dispose();
  hazardGuideRenderer.dispose();
  if (gameModeEnabled) {
    currentPreset = getCurrentLevel().scene;
  }
  world = createWorld(currentPreset);
  openedStageChoices = [];
  openedStageCount = 0;
  openedStageCount = openInitialStages(world, currentPreset, openedStageChoices);
  openedHazards = openInitialHazards(world, getCurrentLevel());
  stageInitialSolidCounts = getStageSolidCounts(world, currentPreset);
  hazardInitialSolidCounts = getHazardSolidCounts(world, getCurrentLevel());
  inputState.sliceZ = Math.min(inputState.sliceZ, world.depth - 1);
  baselineWaterVolume = totalWater(world);
  levelProgress = gameModeEnabled ? evaluateLevel(world, getCurrentLevel(), getMissionStageProgress(), false) : null;
  tickCount = 0;
  maxVolumeDelta = 0;
  stableTicks = 0;
  recentFlows = new Map<number, RecentFlow>();
  terrainRenderer = createTerrainRenderer(sceneContext.scene, world);
  waterRenderer = createWaterRenderer(sceneContext.scene, world);
  activeCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
  flowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
  brushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
  stageGuideRenderer = createStageGuideRenderer(sceneContext.scene);
  hazardGuideRenderer = createStageGuideRenderer(sceneContext.scene, {
    color: 0xff4a3d,
    opacity: 0.22,
    scale: 1.06,
    wireframe: false,
  });
  terrainRenderer.update(world, getRenderOptions());
  sonarRenderer.updateTerrain(world);
  sonarRenderer.updateWater(world);
  if (firstPersonMode) {
    firstPersonController.reset(world);
  }
  inputState.forceWaterUpdate = true;
}

function getRenderOptions(): RenderOptions {
  return {
    slice: {
      enabled: inputState.sliceEnabled,
      z: Math.min(world.depth - 1, Math.max(0, inputState.sliceZ)),
    },
  };
}

function getInitialPreset(): ScenePresetId {
  const requestedPreset = initialUrlParams.get("scene");
  if (SCENE_PRESETS.includes(requestedPreset as ScenePresetId)) {
    return requestedPreset as ScenePresetId;
  }

  return "sluice";
}

function getInitialGameModeEnabled(): boolean {
  if (initialUrlParams.get("game") === "1") {
    return true;
  }

  if (initialUrlParams.get("game") === "0") {
    return false;
  }

  return !initialUrlParams.has("scene");
}

function getInitialDebugUiVisible(): boolean {
  if (initialUrlParams.get("debugUi") === "1") {
    return true;
  }

  if (initialUrlParams.get("debugUi") === "0") {
    return false;
  }

  return !gameModeEnabled;
}

function getInitialFirstPersonEnabled(): boolean {
  const requestedCamera = initialUrlParams.get("camera");
  if (requestedCamera === "fps") {
    return true;
  }

  if (requestedCamera === "orbit") {
    return false;
  }

  return gameModeEnabled;
}

function getInitialLevelIndex(): number {
  const requestedLevel = initialUrlParams.get("level");
  if (!requestedLevel) {
    return 0;
  }

  const namedLevel = getLevel(requestedLevel);
  if (namedLevel) {
    return GAME_LEVELS.indexOf(namedLevel);
  }

  const levelIndex = Number.parseInt(requestedLevel, 10) - 1;
  return Number.isFinite(levelIndex) ? Math.min(GAME_LEVELS.length - 1, Math.max(0, levelIndex)) : 0;
}

function getCurrentLevel(): GameLevel {
  return GAME_LEVELS[currentLevelIndex] ?? GAME_LEVELS[0];
}

function getInitialTuningPreset(): TuningPresetId {
  const requestedTuning = initialUrlParams.get("tuning");
  if (TUNING_PRESETS.includes(requestedTuning as TuningPresetId)) {
    return requestedTuning as TuningPresetId;
  }

  return DEFAULT_TUNING_PRESET_ID;
}

function getInitialSliceZ(): number {
  const requestedSlice = Number.parseInt(initialUrlParams.get("sliceZ") ?? "31", 10);
  return Number.isFinite(requestedSlice) ? requestedSlice : 31;
}

function runInitialSimulationWarmup(): number {
  const requestedTicks = Number.parseInt(initialUrlParams.get("warmupTicks") ?? "0", 10);
  const warmupTicks = Number.isFinite(requestedTicks) ? Math.min(3000, Math.max(0, requestedTicks)) : 0;
  let idleTicks = 0;

  for (let i = 0; i < warmupTicks; i += 1) {
    stepWaterSimulation(world, waterConfig);
    tickCount += 1;
    if (world.activeCells.size === 0) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
    }
  }

  if (warmupTicks > 0) {
    inputState.forceWaterUpdate = true;
  }

  return idleTicks;
}

function openInitialStages(initialWorld: typeof world, preset: ScenePresetId, selectedChoices: number[]): number {
  const requestedStages = Number.parseInt(initialUrlParams.get("openStages") ?? "0", 10);
  const stageCount = getSceneOpeningStages(preset).length;
  const stagesToOpen = Number.isFinite(requestedStages) ? Math.min(stageCount, Math.max(0, requestedStages)) : 0;

  for (let stageIndex = 0; stageIndex < stagesToOpen; stageIndex += 1) {
    const stage = getSceneOpeningStages(preset)[stageIndex];
    if (!isStageAutoOpen(stage)) {
      return stageIndex;
    }

    const choiceIndex = getInitialStageChoiceIndex(preset, stageIndex);
    openSceneStage(initialWorld, preset, stageIndex, choiceIndex);
    selectedChoices[stageIndex] = choiceIndex;
  }

  return stagesToOpen;
}

function getInitialStageChoiceIndex(preset: ScenePresetId, stageIndex: number): number {
  const stage = getSceneOpeningStages(preset)[stageIndex];
  const choices = stage ? getStageChoices(stage) : [];
  if (choices.length <= 1) {
    return 0;
  }

  const requestedBranch = initialUrlParams.get("branch")?.toLowerCase();
  if (preset === "splitter" && stageIndex === 1 && requestedBranch) {
    const branchChoiceIndex = choices.findIndex((choice) => choice.label.toLowerCase().startsWith(requestedBranch));
    if (branchChoiceIndex >= 0) {
      return branchChoiceIndex;
    }
  }

  const requestedChoice = Number.parseInt(initialUrlParams.get(`choice${stageIndex + 1}`) ?? "", 10);
  if (Number.isFinite(requestedChoice)) {
    return Math.min(choices.length - 1, Math.max(0, requestedChoice));
  }

  return 0;
}

function openInitialHazards(initialWorld: typeof world, level: GameLevel): Set<number> {
  const requestedHazards = Number.parseInt(initialUrlParams.get("openHazards") ?? "0", 10);
  const hazardsToOpen = Number.isFinite(requestedHazards)
    ? Math.min(level.hazardStages.length, Math.max(0, requestedHazards))
    : 0;
  const opened = new Set<number>();

  for (let hazardIndex = 0; hazardIndex < hazardsToOpen; hazardIndex += 1) {
    for (const clearRegion of level.hazardStages[hazardIndex].boxes) {
      openClearBox(initialWorld, clearRegion);
    }
    opened.add(hazardIndex);
  }

  return opened;
}

function getStageSolidCounts(targetWorld: typeof world, preset: ScenePresetId): number[][] {
  return getSceneOpeningStages(preset).map((stage) =>
    getStageChoices(stage).map((choice) => countStageSolidCells(targetWorld, choice)),
  );
}

function getHazardSolidCounts(targetWorld: typeof world, level: GameLevel): number[] {
  return level.hazardStages.map((hazard) => countStageSolidCells(targetWorld, hazard));
}

function getMissionStageProgress() {
  const stages = getSceneOpeningStages(currentPreset);
  const activeStage = stages[openedStageCount];
  const activeChoices = activeStage ? getStageChoices(activeStage) : [];
  const initialChoiceSolids = stageInitialSolidCounts[openedStageCount] ?? [];
  const activeStageProgress =
    activeChoices.length === 0
      ? 1
      : Math.max(
          ...activeChoices.map((choice, choiceIndex) => {
            const initialSolids = initialChoiceSolids[choiceIndex] ?? 0;
            const remainingSolids = countStageSolidCells(world, choice);
            return initialSolids <= 0 ? 1 : Math.min(1, Math.max(0, 1 - remainingSolids / initialSolids));
          }),
        );

  return {
    completedStages: openedStageCount,
    stageCount: stages.length,
    activeStageLabel: activeStage?.label ?? "complete",
    activeStageProgress,
    activeStageIsManual: activeStage ? !isStageAutoOpen(activeStage) : false,
    selectedChoiceLabel: getSelectedChoiceLabel(),
  };
}

function getSelectedChoiceLabel(): string | null {
  const stages = getSceneOpeningStages(currentPreset);
  for (let stageIndex = 0; stageIndex < Math.min(openedStageCount, stages.length); stageIndex += 1) {
    const choices = getStageChoices(stages[stageIndex]);
    if (choices.length <= 1) {
      continue;
    }

    return choices[openedStageChoices[stageIndex] ?? 0]?.label ?? null;
  }

  return null;
}

function isStable(): boolean {
  return world.activeCells.size === 0 && movedLastFrame <= 0.0005;
}

function animate(now: number): void {
  requestAnimationFrame(animate);

  const deltaSeconds = Math.max(0.0001, (now - lastTime) / 1000);
  fps = fps * 0.9 + (1 / deltaSeconds) * 0.1;
  lastTime = now;

  if (sceneContext.controls.enabled) {
    sceneContext.controls.update();
  }
  firstPersonController.update(world, deltaSeconds);
  digController.update();
  cellInspector.update();
  brushPreviewRenderer.update(world, digController.getPreviewCells(), getRenderOptions());
  stageGuideRenderer.update(world, getVisibleGuideStage(), getRenderOptions());
  hazardGuideRenderer.update(world, getVisibleHazardStage(), getRenderOptions());
  updateAimFeedback();
  movedLastFrame = 0;

  if (!inputState.paused || queuedStep) {
    const simulationStartedAt = performance.now();
    const stepCount = queuedStep ? 1 : simStepsPerFrame;
    const activeCellsBeforeStep = world.activeCells.size;
    let waterChanged = false;
    for (let i = 0; i < stepCount; i += 1) {
      const stats = stepWaterSimulation(world, waterConfig);
      movedLastFrame += stats.movedVolume;
      recordFlowEvents(stats.flowEvents);
      if (stats.movedVolume > 0 || stats.changedCells > 0 || stats.flowEvents.length > 0) {
        waterChanged = true;
      }
      tickCount += 1;
    }
    queuedStep = false;
    if (waterChanged || activeCellsBeforeStep !== world.activeCells.size) {
      inputState.forceWaterUpdate = true;
    }
    lastSimulationMs = performance.now() - simulationStartedAt;
  }

  decayFlowEvents();
  stableTicks = isStable() ? stableTicks + 1 : 0;

  if (inputState.terrainDirty) {
    terrainRenderer.update(world, getRenderOptions());
    sonarRenderer.updateTerrain(world);
    inputState.terrainDirty = false;
  }

  if (inputState.forceWaterUpdate) {
    waterRenderer.update(world, inputState.debugWater, getRenderOptions(), gameModeEnabled);
    activeCellRenderer.update(world, inputState.debugWater && inputState.showActiveCells, getRenderOptions());
    flowDebugRenderer.update(world, recentFlows, inputState.debugWater && inputState.showFlowDebug, getRenderOptions());
    sonarRenderer.updateWater(world);
    inputState.forceWaterUpdate = false;
  }

  const currentWaterVolume = totalWater(world);
  const volumeDelta = currentWaterVolume - baselineWaterVolume;
  maxVolumeDelta = Math.max(maxVolumeDelta, Math.abs(volumeDelta));
  const volumeWarning = Math.abs(volumeDelta) > VOLUME_WARNING_TOLERANCE;
  const preset = SCENE_PRESET_DETAILS[currentPreset];
  const settledForMission = stableTicks >= STABLE_COMPLETE_TICKS;
  levelProgress = gameModeEnabled
    ? evaluateLevel(world, getCurrentLevel(), getMissionStageProgress(), settledForMission)
    : null;

  updateDebugOverlay(overlay, {
    presetName: preset.name,
    paused: inputState.paused,
    debugWater: inputState.debugWater,
    sliceEnabled: inputState.sliceEnabled,
    sliceZ: getRenderOptions().slice.z,
    activeCells: world.activeCells.size,
    totalWater: currentWaterVolume,
    baselineWater: baselineWaterVolume,
    volumeDelta,
    volumeWarning,
    fps,
    movedVolume: movedLastFrame,
    inspectedCell: cellInspector.getCell(),
    tickCount,
    stableTicks,
    stable: isStable(),
    terrainInstances: terrainRenderer.stats.instances,
    waterInstances: waterRenderer.stats.instances,
    terrainUpdateMs: terrainRenderer.stats.updateMs,
    waterUpdateMs: waterRenderer.stats.updateMs,
    simulationUpdateMs: lastSimulationMs,
  });
  gamePanel.update(levelProgress, currentLevelIndex, gameModeEnabled);
  debugPanel.update();
  syncBodyModeClasses();

  sceneContext.renderer.render(sceneContext.scene, sceneContext.camera);
  sonarRenderer.render(sceneContext.camera);
}

function getVisibleGuideStage() {
  if (openedStageCount >= getSceneOpeningStages(currentPreset).length) {
    return null;
  }

  return getSceneOpeningStages(currentPreset)[openedStageCount] ?? null;
}

function getVisibleHazardStage() {
  if (!gameModeEnabled) {
    return null;
  }

  const visibleHazards = getCurrentLevel().hazardStages.filter((_hazard, hazardIndex) => !openedHazards.has(hazardIndex));
  if (visibleHazards.length === 0) {
    return null;
  }

  return {
    label: "Spill seams",
    boxes: visibleHazards.flatMap((hazard) => hazard.boxes),
    digBoxes: visibleHazards.flatMap((hazard) => getStageDigBoxes(hazard)),
  } satisfies SceneOpeningStage;
}

function updateAimFeedback(): void {
  const previewCells = digController.getPreviewCells();
  const hasDigTarget = firstPersonMode && previewCells.length > 0;
  const hasHazardTarget = hasDigTarget && previewCells.some((cellIndex) => isCellInVisibleHazard(cellIndex));

  document.body.classList.toggle("is-dig-target", hasDigTarget);
  document.body.classList.toggle("is-hazard-target", hasHazardTarget);
}

function syncBodyModeClasses(): void {
  document.body.classList.toggle("game-mode", gameModeEnabled);
  document.body.classList.toggle("debug-ui-visible", debugUiVisible);
  document.body.classList.toggle("debug-ui-hidden", !debugUiVisible);
}

requestAnimationFrame(animate);

function recordFlowEvents(events: FlowEvent[]): void {
  for (const event of events) {
    recentFlows.set(event.cellIndex, {
      direction: event.direction,
      dx: event.dx,
      dy: event.dy,
      dz: event.dz,
      amount: Math.max(event.amount, recentFlows.get(event.cellIndex)?.amount ?? 0),
      ttl: FLOW_DEBUG_TTL,
    });
  }
}

function decayFlowEvents(): void {
  let changed = false;

  for (const [cellIndex, flow] of recentFlows) {
    flow.ttl -= 1;
    if (flow.ttl <= 0) {
      recentFlows.delete(cellIndex);
      changed = true;
    }
  }

  if (changed && inputState.debugWater) {
    inputState.forceWaterUpdate = true;
  }
}
