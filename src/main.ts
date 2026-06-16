import "./style.css";
import { Vector3 } from "three";
import { createDebugOverlay, updateDebugOverlay } from "./debug/debugOverlay";
import { createDebugPanel } from "./debug/debugPanel";
import {
  getBestScore,
  loadBestScores,
  mergeBestScore,
  saveBestScores,
  type BestScoresByLevel,
} from "./game/bestScoreStorage";
import { createGamePanel } from "./game/gamePanel";
import { evaluateLevel, GAME_LEVELS, getLevel, measureBoxWater, type GameLevel, type LevelProgress } from "./game/levels";
import { STAGE_CLEAR_RATIO, isStageChoiceComplete } from "./game/stageCompletion";
import { createCellInspector } from "./input/cellInspector";
import { createFirstPersonController, type SpawnPose } from "./input/firstPersonController";
import {
  bindKeyboardControls,
  configureOrbitControls,
  createDigController,
  type InputState,
} from "./input/controls";
import { createActiveCellRenderer, type ActiveCellRenderer } from "./render/activeCellRenderer";
import { createBrushPreviewRenderer, type BrushPreviewRenderer } from "./render/brushPreviewRenderer";
import { createCavernDecorRenderer, type CavernDecorRenderer } from "./render/cavernDecorRenderer";
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
import {
  EMPTY_WATER_STEP_DIAGNOSTICS,
  stepWaterSimulation,
  type FlowEvent,
  type WaterSimulationConfig,
  type WaterSolverMode,
  type WaterStepDiagnostics,
} from "./sim/waterSimulation";
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
import type { DigResult } from "./world/dig";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

const sceneContext = await createSceneContext(app);
configureOrbitControls(sceneContext.controls);

const VOLUME_WARNING_TOLERANCE = 0.05;
const FLOW_DEBUG_TTL = 16;
const STABLE_COMPLETE_TICKS = 18;
const MAX_INITIAL_WARMUP_TICKS = 12_000;
const SONAR_TERRAIN_UPDATE_INTERVAL_MS = 250;
const SONAR_WATER_UPDATE_INTERVAL_MS = 125;
const SONAR_RENDER_INTERVAL_MS = 66;
const GAME_PANEL_UPDATE_INTERVAL_MS = 100;
const DEBUG_UI_UPDATE_INTERVAL_MS = 250;
const ACTIVE_STAGE_GUIDE_STYLE = {
  fill: false,
  opacity: 0.08,
  scale: 1.025,
  wireframe: false,
  depthTest: true,
  outline: true,
  cornerOnly: true,
  outlineOpacity: 0.42,
  outlineScale: 1.035,
  outlineDepthTest: true,
};
type AimFeedbackState = "idle" | "dig" | "blocked" | "hazard";
type WaterCaptureState = {
  renderer: {
    mode: string;
    backend: string;
  };
  canvas: {
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
  };
  scene: {
    preset: ScenePresetId;
    gameMode: boolean;
    firstPerson: boolean;
    debugUiVisible: boolean;
  };
  input: {
    paused: boolean;
    debugWater: boolean;
    showActiveCells: boolean;
    showFlowDebug: boolean;
    sliceEnabled: boolean;
    sliceZ: number;
  };
  world: {
    width: number;
    height: number;
    depth: number;
    totalWater: number;
    activeCells: number;
    wetCells: number;
    visualEvents: number;
  };
  render: {
    terrainInstances: number;
    waterInstances: number;
    terrainRebuilds: number;
    waterRebuilds: number;
  };
  simulation: {
    tickCount: number;
    stableTicks: number;
    movedLastFrame: number;
  };
  game: {
    levelId: string | null;
    openedStages: number;
    stageCount: number;
    openedHazards: number;
    hazardCount: number;
    selectedRouteWater: number | null;
    manualRouteWater: number | null;
    deliveredWater: number | null;
    wastedWater: number | null;
    complete: boolean | null;
    failed: boolean | null;
    status: string | null;
  };
};

declare global {
  interface Window {
    __WATER_CAPTURE_STATE__?: () => WaterCaptureState;
  }
}

const initialUrlParams = new URLSearchParams(window.location.search);
const captureMode = initialUrlParams.get("capture") === "1";
const visualCaptureMode = initialUrlParams.get("visualCapture") === "1";
seedCaptureBestScores();

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
openedStageCount = carveInitialManualStage(world, currentPreset, openedStageChoices, openedStageCount);
let terrainRenderer: TerrainRenderer = createTerrainRenderer(sceneContext.scene, world);
let waterRenderer: WaterRenderer = createWaterRenderer(sceneContext.scene, world);
let cavernDecorRenderer: CavernDecorRenderer = createCavernDecorRenderer(sceneContext.scene, world);
let activeCellRenderer: ActiveCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
let flowDebugRenderer: FlowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
let brushPreviewRenderer: BrushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
let stageGuideRenderer: StageGuideRenderer = createStageGuideRenderer(sceneContext.scene, ACTIVE_STAGE_GUIDE_STYLE);
let hazardGuideRenderer: StageGuideRenderer = createStageGuideRenderer(sceneContext.scene, {
  color: 0xff4a3d,
  opacity: 0.14,
  scale: 1.035,
  wireframe: false,
});
const sonarRenderer = createSonarRenderer(document.body, world);
let baselineWaterVolume = totalWater(world);
let levelProgress: LevelProgress | null = null;
const initialTuningPreset = getInitialTuningPreset();
let currentTuningPreset: TuningPresetId | "custom" = initialTuningPreset;
let activeTuning = cloneTuningPreset(initialTuningPreset);
let waterConfig: WaterSimulationConfig = { ...activeTuning.waterConfig };
let waterSolverMode: WaterSolverMode = getInitialWaterSolverMode();
let simStepsPerFrame = activeTuning.simStepsPerFrame;
let hasSavedCustomTuning = loadStoredCustomTuning() !== null;
let bestScores: BestScoresByLevel = loadBestScores();
let recentFlows = new Map<number, RecentFlow>();

const inputState: InputState = {
  paused: initialUrlParams.get("paused") === "1",
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
let lastWaterDiagnostics: WaterStepDiagnostics = { ...EMPTY_WATER_STEP_DIAGNOSTICS };
let lastSimulationMs = 0;
let tickCount = 0;
let scoreStartTick = 0;
let completedAtTick: number | null = null;
let completedScoreRecorded = false;
let currentScoreIsNewBest = false;
let maxVolumeDelta = 0;
let stableTicks = 0;
let fps = 0;
let lastTime = performance.now();
let pendingSonarTerrainUpdate = false;
let pendingSonarWaterUpdate = false;
let lastSonarTerrainUpdateAt = lastTime;
let lastSonarWaterUpdateAt = lastTime;
let lastSonarRenderAt = 0;
let lastGamePanelUpdateAt = Number.NEGATIVE_INFINITY;
let lastGamePanelStatusKey = "";
let lastDebugUiUpdateAt = Number.NEGATIVE_INFINITY;
let debugUiVisible = getInitialDebugUiVisible();
let aimFeedbackState: AimFeedbackState = "idle";
let lastFpsControlHintKey = "";
const initialWarmupStableTicks = runInitialSimulationWarmup();
if (initialWarmupStableTicks > 0) {
  stableTicks = initialWarmupStableTicks;
}
baselineWaterVolume = totalWater(world);
scoreStartTick = tickCount;
levelProgress = evaluateCurrentLevelProgress(stableTicks >= STABLE_COMPLETE_TICKS, baselineWaterVolume);

const overlay = createDebugOverlay();
const gamePanel = createGamePanel({
  resetLevel: resetCurrentLevel,
  nextLevel: advanceToNextLevel,
  selectLevel: selectGameLevel,
});
const firstPersonController = createFirstPersonController(sceneContext.renderer, sceneContext.camera, firstPersonMode);
if (firstPersonMode) {
  firstPersonController.reset(world, getFirstPersonSpawnPose());
}
sceneContext.controls.enabled = !firstPersonMode;
const fpsControlHint = createFpsControlHint();
syncBodyModeClasses();
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
  () => firstPersonMode && firstPersonController.hasSceneAim(),
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
    waterDiagnostics: lastWaterDiagnostics,
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

function selectGameLevel(levelIndex: number): void {
  if (!GAME_LEVELS[levelIndex]) {
    return;
  }

  gameModeEnabled = true;
  currentLevelIndex = levelIndex;
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
    firstPersonController.reset(world, getFirstPersonSpawnPose());
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
  lastDebugUiUpdateAt = Number.NEGATIVE_INFINITY;
  syncBodyModeClasses();
}

function canAcceptDigInput(): boolean {
  if (firstPersonMode && !firstPersonController.hasSceneAim()) {
    return false;
  }

  return !gameModeEnabled || (!levelProgress?.failed && !levelProgress?.complete);
}

function canDigCell(_cellIndex: number): boolean {
  if (levelProgress?.failed || levelProgress?.complete) {
    return false;
  }

  return true;
}

function handleDig(result: DigResult): void {
  terrainRenderer.markCellsDirty(result.changedCells);
  clearFlowDebugState();
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
    const stageAutoOpen = isStageAutoOpen(stage);
    const availableChoiceIndexes = getAvailableChoiceIndexes(openedStageCount);
    const initialChoiceSolids = stageInitialSolidCounts[openedStageCount] ?? [];
    let clearedChoiceIndex = -1;

    for (const choiceIndex of availableChoiceIndexes) {
      const initialSolids = initialChoiceSolids[choiceIndex] ?? 0;
      const remainingSolids = countStageSolidCells(world, choices[choiceIndex]);
      const routeWater = stageAutoOpen ? 0 : getManualChoiceRouteWater(stage, choiceIndex);
      if (
        isStageChoiceComplete({
          autoOpen: stageAutoOpen,
          initialSolids,
          remainingSolids,
          routeWater,
        })
      ) {
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
    if (stageAutoOpen) {
      openSceneStage(world, currentPreset, openedStageCount, clearedChoiceIndex);
      clearFlowDebugState();
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
    clearFlowDebugState();
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
    clearFlowDebugState();
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
    clearFlowDebugState();
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
  terrainRenderer.markAllDirty();
  inputState.terrainDirty = true;
  inputState.forceWaterUpdate = true;
}

function resetWorld(): void {
  terrainRenderer.dispose();
  waterRenderer.dispose();
  cavernDecorRenderer.dispose();
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
  openedStageCount = carveInitialManualStage(world, currentPreset, openedStageChoices, openedStageCount);
  inputState.sliceZ = Math.min(inputState.sliceZ, world.depth - 1);
  tickCount = 0;
  scoreStartTick = 0;
  completedAtTick = null;
  completedScoreRecorded = false;
  currentScoreIsNewBest = false;
  lastGamePanelUpdateAt = Number.NEGATIVE_INFINITY;
  lastGamePanelStatusKey = "";
  maxVolumeDelta = 0;
  stableTicks = 0;
  lastWaterDiagnostics = { ...EMPTY_WATER_STEP_DIAGNOSTICS };
  baselineWaterVolume = totalWater(world);
  levelProgress = evaluateCurrentLevelProgress(false, baselineWaterVolume);
  recentFlows = new Map<number, RecentFlow>();
  terrainRenderer = createTerrainRenderer(sceneContext.scene, world);
  waterRenderer = createWaterRenderer(sceneContext.scene, world);
  cavernDecorRenderer = createCavernDecorRenderer(sceneContext.scene, world);
  activeCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
  flowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
  brushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
  stageGuideRenderer = createStageGuideRenderer(sceneContext.scene, ACTIVE_STAGE_GUIDE_STYLE);
  hazardGuideRenderer = createStageGuideRenderer(sceneContext.scene, {
    color: 0xff4a3d,
    opacity: 0.14,
    scale: 1.035,
    wireframe: false,
  });
  terrainRenderer.update(world, getRenderOptions());
  sonarRenderer.updateTerrain(world);
  sonarRenderer.updateWater(world);
  lastSonarTerrainUpdateAt = performance.now();
  lastSonarWaterUpdateAt = lastSonarTerrainUpdateAt;
  pendingSonarTerrainUpdate = false;
  pendingSonarWaterUpdate = false;
  if (firstPersonMode) {
    firstPersonController.reset(world, getFirstPersonSpawnPose());
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

  return "generated-cavern";
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

function seedCaptureBestScores(): void {
  if (initialUrlParams.get("seedBestScores") !== "1" || typeof window === "undefined") {
    return;
  }

  const seedScores = Object.fromEntries(
    GAME_LEVELS.map((level, levelIndex) => [
      level.id,
      {
        total: Math.max(70, 96 - levelIndex * 5),
        grade: levelIndex === 0 ? "S" : "A",
        efficiency: 1,
        waste: 1,
        time: Math.max(0.5, 1 - levelIndex * 0.1),
        ticks: level.scoreParTicks ?? 1200,
      },
    ]),
  );

  try {
    window.localStorage.setItem("voxel-water-best-scores-v1", JSON.stringify({ version: 1, scores: seedScores }));
  } catch {
    // Capture-only fixture; ignore storage failures.
  }
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

function evaluateCurrentLevelProgress(settled: boolean, currentWaterVolume = totalWater(world)): LevelProgress | null {
  if (!gameModeEnabled) {
    return null;
  }

  const level = getCurrentLevel();
  const stageProgress = getMissionStageProgress();
  const settlingInput = { stableTicks, requiredTicks: STABLE_COMPLETE_TICKS };
  let progress = evaluateLevel(
    world,
    level,
    stageProgress,
    settled,
    { ticks: getScoreTicks() },
    currentWaterVolume,
    settlingInput,
  );

  if (progress.complete && completedAtTick === null) {
    completedAtTick = tickCount;
    progress = evaluateLevel(
      world,
      level,
      stageProgress,
      settled,
      { ticks: getScoreTicks() },
      currentWaterVolume,
      settlingInput,
    );
  }

  if (progress.complete && progress.score && !completedScoreRecorded) {
    const update = mergeBestScore(bestScores, level.id, progress.score);
    if (update.improved) {
      bestScores = update.scores;
      saveBestScores(bestScores);
    }
    currentScoreIsNewBest = update.improved;
    completedScoreRecorded = true;
  }

  return progress;
}

function getScoreTicks(): number {
  return Math.max(0, (completedAtTick ?? tickCount) - scoreStartTick);
}

function getCurrentBestScore() {
  return getBestScore(bestScores, getCurrentLevel().id);
}

function getFirstPersonSpawnPose(): SpawnPose | undefined {
  const spawn = initialUrlParams.get("spawn");
  if (spawn === "drop") {
    return {
      position: new Vector3(-6.5, 36.75, -8.5),
      lookAt: new Vector3(7.5, 8.5, 1.5),
    };
  }

  if (spawn === "water-drop") {
    return {
      position: new Vector3(-15.5, 20.7, -5.5),
      lookAt: new Vector3(-20, 18, -6),
    };
  }

  if (spawn === "south-basin") {
    return {
      position: new Vector3(22.5, 8.75, -11.5),
      lookAt: new Vector3(4.5, 8, 0.5),
    };
  }

  if (spawn === "basins" || spawn === "north-basin") {
    return {
      position: new Vector3(15.5, 9.2, 22.5),
      lookAt: new Vector3(2.5, 8, 2.5),
    };
  }

  if (spawn === "overview") {
    return {
      position: new Vector3(-17.5, 24.5, -13.5),
      lookAt: new Vector3(-14.5, 37.5, -8.5),
    };
  }

  if (openedStageCount >= 2) {
    return {
      position: new Vector3(22.5, 8.75, -11.5),
      lookAt: new Vector3(4.5, 7.5, 0.5),
    };
  }

  if (openedStageCount >= 1) {
    return {
      position: new Vector3(-17.5, 24.5, -13.5),
      lookAt: new Vector3(7, 10, 1.5),
    };
  }

  return {
    position: new Vector3(-17.5, 24.5, -13.5),
    lookAt: new Vector3(-14.5, 37.5, -8.5),
  };
}

function getInitialTuningPreset(): TuningPresetId {
  const requestedTuning = initialUrlParams.get("tuning");
  if (TUNING_PRESETS.includes(requestedTuning as TuningPresetId)) {
    return requestedTuning as TuningPresetId;
  }

  return DEFAULT_TUNING_PRESET_ID;
}

function getInitialWaterSolverMode(): WaterSolverMode {
  const requestedSolver = initialUrlParams.get("solver");
  if (requestedSolver === "legacy" || requestedSolver === "legacy-span") {
    return "legacy-span";
  }

  return "sparse-hydraulic-graph";
}

function getInitialSliceZ(): number {
  const requestedSlice = Number.parseInt(initialUrlParams.get("sliceZ") ?? "31", 10);
  return Number.isFinite(requestedSlice) ? requestedSlice : 31;
}

function runInitialSimulationWarmup(): number {
  const requestedTicks = Number.parseInt(initialUrlParams.get("warmupTicks") ?? "0", 10);
  const warmupTicks = Number.isFinite(requestedTicks) ? Math.min(3000, Math.max(0, requestedTicks)) : 0;
  const warmupUntilStable = initialUrlParams.get("warmupUntilStable") === "1";
  const requestedMaxTicks = Number.parseInt(initialUrlParams.get("warmupMaxTicks") ?? "", 10);
  const maxWarmupTicks = warmupUntilStable
    ? Math.min(
        MAX_INITIAL_WARMUP_TICKS,
        Math.max(warmupTicks, Number.isFinite(requestedMaxTicks) ? requestedMaxTicks : warmupTicks),
      )
    : warmupTicks;
  const requestedStableTicks = Number.parseInt(initialUrlParams.get("warmupStableTicks") ?? `${STABLE_COMPLETE_TICKS}`, 10);
  const requiredStableTicks =
    warmupUntilStable && Number.isFinite(requestedStableTicks)
      ? Math.min(240, Math.max(1, requestedStableTicks))
      : STABLE_COMPLETE_TICKS;
  let idleTicks = 0;

  for (let i = 0; i < maxWarmupTicks; i += 1) {
    const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents: false, solver: waterSolverMode });
    lastWaterDiagnostics = stats.diagnostics;
    tickCount += 1;
    if (world.activeCells.size === 0) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
    }

    if (warmupUntilStable && i + 1 >= warmupTicks && idleTicks >= requiredStableTicks) {
      break;
    }
  }

  if (maxWarmupTicks > 0) {
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

function carveInitialManualStage(
  initialWorld: typeof world,
  preset: ScenePresetId,
  selectedChoices: number[],
  currentOpenedStageCount: number,
): number {
  if (initialUrlParams.get("carveManual") !== "1") {
    return currentOpenedStageCount;
  }

  const stages = getSceneOpeningStages(preset);
  const manualStageIndex = stages.findIndex((stage) => !isStageAutoOpen(stage));
  if (manualStageIndex < 0 || currentOpenedStageCount !== manualStageIndex) {
    return currentOpenedStageCount;
  }

  const manualChoices = getStageChoices(stages[manualStageIndex]);
  if (manualChoices.length === 0) {
    return currentOpenedStageCount;
  }

  const selectedRouteChoiceIndex =
    getInitialSelectedRouteChoiceIndex(stages, selectedChoices, manualStageIndex) ??
    getInitialStageChoiceIndex(preset, manualStageIndex);
  const manualChoiceIndex = Math.min(selectedRouteChoiceIndex, manualChoices.length - 1);
  for (const clearRegion of getStageDigBoxes(manualChoices[manualChoiceIndex])) {
    openClearBox(initialWorld, clearRegion);
  }

  selectedChoices[manualStageIndex] = manualChoiceIndex;
  return manualStageIndex + 1;
}

function getInitialSelectedRouteChoiceIndex(
  stages: ReturnType<typeof getSceneOpeningStages>,
  selectedChoices: number[],
  beforeStageIndex: number,
): number | null {
  for (let stageIndex = 0; stageIndex < beforeStageIndex; stageIndex += 1) {
    const stage = stages[stageIndex];
    if (isStageAutoOpen(stage) && getStageChoices(stage).length > 1) {
      return selectedChoices[stageIndex] ?? 0;
    }
  }

  return null;
}

function getInitialStageChoiceIndex(preset: ScenePresetId, stageIndex: number): number {
  const stage = getSceneOpeningStages(preset)[stageIndex];
  const choices = stage ? getStageChoices(stage) : [];
  if (choices.length <= 1) {
    return 0;
  }

  const requestedBranch = initialUrlParams.get("branch")?.toLowerCase();
  if (requestedBranch) {
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
  const availableChoiceIndexes = getAvailableChoiceIndexes(openedStageCount);
  const initialChoiceSolids = stageInitialSolidCounts[openedStageCount] ?? [];
  const activeStageLabel =
    activeStage && !isStageAutoOpen(activeStage) && availableChoiceIndexes.length === 1
      ? activeChoices[availableChoiceIndexes[0]]?.label ?? activeStage.label
      : activeStage?.label ?? "complete";
  const activeStageProgress =
    activeChoices.length === 0
      ? 1
      : Math.max(
          ...availableChoiceIndexes.map((choiceIndex) => {
            const choice = activeChoices[choiceIndex];
            const initialSolids = initialChoiceSolids[choiceIndex] ?? 0;
            const remainingSolids = countStageSolidCells(world, choice);
            return initialSolids <= 0 ? 1 : Math.min(1, Math.max(0, 1 - remainingSolids / initialSolids));
          }),
        );

  return {
    completedStages: openedStageCount,
    stageCount: stages.length,
    activeStageLabel,
    activeStageProgress,
    activeStageIsManual: activeStage ? !isStageAutoOpen(activeStage) : false,
    selectedChoiceLabel: getSelectedChoiceLabel(),
    selectedRouteWater: getSelectedRouteWater(),
    openedHazardCount: openedHazards.size,
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

function getSelectedRouteChoiceIndex(): number | null {
  const stages = getSceneOpeningStages(currentPreset);
  for (let stageIndex = 0; stageIndex < Math.min(openedStageCount, stages.length); stageIndex += 1) {
    const stage = stages[stageIndex];
    if (getStageChoices(stage).length <= 1) {
      continue;
    }

    return openedStageChoices[stageIndex] ?? 0;
  }

  return null;
}

function getSelectedRouteWater(): number | null {
  const selectedRouteChoiceIndex = getSelectedRouteChoiceIndex();
  if (selectedRouteChoiceIndex === null) {
    return null;
  }

  const manualStage = getSceneOpeningStages(currentPreset).find((stage) => !isStageAutoOpen(stage));
  if (!manualStage) {
    return null;
  }

  const choices = getStageChoices(manualStage);
  if (choices.length === 0) {
    return null;
  }

  const selectedManualChoiceIndex = Math.min(selectedRouteChoiceIndex, choices.length - 1);
  return getManualChoiceRouteWater(manualStage, selectedManualChoiceIndex);
}

function getManualChoiceRouteWater(stage: SceneOpeningStage, choiceIndex: number): number {
  const choice = getStageChoices(stage)[choiceIndex];
  return choice ? measureBoxWater(world, getStageDigBoxes(choice)) : 0;
}

function getAvailableChoiceIndexes(stageIndex: number): number[] {
  const stage = getSceneOpeningStages(currentPreset)[stageIndex];
  const choices = stage ? getStageChoices(stage) : [];
  if (choices.length === 0) {
    return [];
  }

  if (!stage || isStageAutoOpen(stage) || choices.length <= 1) {
    return choices.map((_choice, choiceIndex) => choiceIndex);
  }

  const selectedRouteChoiceIndex = getSelectedRouteChoiceIndex();
  return selectedRouteChoiceIndex === null
    ? choices.map((_choice, choiceIndex) => choiceIndex)
    : [Math.min(selectedRouteChoiceIndex, choices.length - 1)];
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
  let rebuiltTerrainThisFrame = flushTerrainUpdate();
  firstPersonController.update(world, deltaSeconds);
  digController.update();
  rebuiltTerrainThisFrame = flushTerrainUpdate() || rebuiltTerrainThisFrame;
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
    const collectFlowEvents = inputState.debugWater && inputState.showFlowDebug;
    let waterChanged = false;
    for (let i = 0; i < stepCount; i += 1) {
      const stats = stepWaterSimulation(world, waterConfig, { collectFlowEvents, solver: waterSolverMode });
      movedLastFrame += stats.movedVolume;
      lastWaterDiagnostics = stats.diagnostics;
      recordFlowEvents(stats.flowEvents);
      if (
        stats.movedVolume > 0 ||
        stats.changedCells > 0 ||
        stats.flowChanged ||
        stats.surfaceChanged ||
        stats.flowEvents.length > 0
      ) {
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

  advanceClearedGameStages();
  decayFlowEvents();
  stableTicks = isStable() ? stableTicks + 1 : 0;

  if (inputState.forceWaterUpdate) {
    waterRenderer.update(world, inputState.debugWater, getRenderOptions(), gameModeEnabled);
    activeCellRenderer.update(world, inputState.debugWater && inputState.showActiveCells, getRenderOptions());
    flowDebugRenderer.update(world, recentFlows, inputState.debugWater && inputState.showFlowDebug && !gameModeEnabled, getRenderOptions());
    pendingSonarWaterUpdate = true;
    inputState.forceWaterUpdate = false;
  }
  updateQueuedSonar(now, rebuiltTerrainThisFrame);

  const currentWaterVolume = totalWater(world);
  const volumeDelta = currentWaterVolume - baselineWaterVolume;
  maxVolumeDelta = Math.max(maxVolumeDelta, Math.abs(volumeDelta));
  const volumeWarning = Math.abs(volumeDelta) > VOLUME_WARNING_TOLERANCE;
  const preset = SCENE_PRESET_DETAILS[currentPreset];
  const settledForMission = stableTicks >= STABLE_COMPLETE_TICKS;
  levelProgress = evaluateCurrentLevelProgress(settledForMission, currentWaterVolume);

  if (debugUiVisible && now - lastDebugUiUpdateAt >= DEBUG_UI_UPDATE_INTERVAL_MS) {
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
      waterDiagnostics: lastWaterDiagnostics,
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
    debugPanel.update();
    lastDebugUiUpdateAt = now;
  }
  updateGamePanelIfNeeded(now);
  syncBodyModeClasses();

  waterRenderer.animate(captureMode ? 0 : now / 1000);
  sceneContext.renderer.render(sceneContext.scene, sceneContext.camera);
  if (now - lastSonarRenderAt >= SONAR_RENDER_INTERVAL_MS) {
    sonarRenderer.render(sceneContext.camera);
    lastSonarRenderAt = now;
  }
}

function flushTerrainUpdate(): boolean {
  if (!inputState.terrainDirty) {
    return false;
  }

  terrainRenderer.update(world, getRenderOptions());
  cavernDecorRenderer.update(world);
  pendingSonarTerrainUpdate = true;
  inputState.terrainDirty = false;
  return true;
}

function updateGamePanelIfNeeded(now: number): void {
  const statusKey = [
    currentLevelIndex,
    levelProgress?.complete ?? false,
    levelProgress?.failed ?? false,
    levelProgress?.status ?? "-",
    levelProgress?.stageProgress.activeStageProgress.toFixed(2) ?? "-",
    levelProgress?.deliveredWater.toFixed(0) ?? "-",
    levelProgress?.wastedWater.toFixed(0) ?? "-",
    levelProgress?.settling.stableTicks ?? "-",
    levelProgress?.score?.total ?? "-",
    currentScoreIsNewBest,
    gameModeEnabled,
  ].join(":");
  if (statusKey === lastGamePanelStatusKey && now - lastGamePanelUpdateAt < GAME_PANEL_UPDATE_INTERVAL_MS) {
    return;
  }

  gamePanel.update(levelProgress, currentLevelIndex, gameModeEnabled, getCurrentBestScore(), bestScores, currentScoreIsNewBest);
  lastGamePanelUpdateAt = now;
  lastGamePanelStatusKey = statusKey;
}

function updateQueuedSonar(now: number, deferTerrainUpdate: boolean): void {
  if (
    pendingSonarTerrainUpdate &&
    !deferTerrainUpdate &&
    now - lastSonarTerrainUpdateAt >= SONAR_TERRAIN_UPDATE_INTERVAL_MS
  ) {
    sonarRenderer.updateTerrain(world);
    pendingSonarTerrainUpdate = false;
    lastSonarTerrainUpdateAt = now;
  }

  if (pendingSonarWaterUpdate && now - lastSonarWaterUpdateAt >= SONAR_WATER_UPDATE_INTERVAL_MS) {
    sonarRenderer.updateWater(world);
    pendingSonarWaterUpdate = false;
    lastSonarWaterUpdateAt = now;
  }
}

function getVisibleGuideStage() {
  if (openedStageCount >= getSceneOpeningStages(currentPreset).length) {
    return null;
  }

  const stage = getSceneOpeningStages(currentPreset)[openedStageCount];
  if (!stage || getStageChoices(stage).length <= 1) {
    return stage ?? null;
  }

  const choices = getStageChoices(stage);
  const visibleChoiceIndexes = getAvailableChoiceIndexes(openedStageCount);
  return {
    label: stage.label,
    boxes: visibleChoiceIndexes.flatMap((choiceIndex) => choices[choiceIndex]?.boxes ?? []),
    digBoxes: visibleChoiceIndexes.flatMap((choiceIndex) => getStageDigBoxes(choices[choiceIndex])),
  } satisfies SceneOpeningStage;
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
  const previewState = digController.getPreviewState();
  const hasDigTarget = firstPersonMode && previewState.cells.length > 0;
  const hasBlockedTarget =
    firstPersonMode && previewState.targetCell !== null && (!previewState.digAllowed || previewState.cells.length === 0);
  const hasHazardTarget = hasDigTarget && previewState.cells.some((cellIndex) => isCellInVisibleHazard(cellIndex));
  aimFeedbackState = hasHazardTarget ? "hazard" : hasDigTarget ? "dig" : hasBlockedTarget ? "blocked" : "idle";

  document.body.classList.toggle("is-dig-target", hasDigTarget);
  document.body.classList.toggle("is-blocked-dig-target", hasBlockedTarget);
  document.body.classList.toggle("is-hazard-target", hasHazardTarget);
}

function syncBodyModeClasses(): void {
  const pointerLocked = firstPersonMode && firstPersonController.isPointerLocked();
  const hasSceneAim = firstPersonMode && firstPersonController.hasSceneAim();
  document.body.classList.toggle("game-mode", gameModeEnabled);
  document.body.classList.toggle("visual-capture-mode", visualCaptureMode);
  document.body.classList.toggle("debug-ui-visible", debugUiVisible);
  document.body.classList.toggle("debug-ui-hidden", !debugUiVisible);
  document.body.classList.toggle("fps-mode-active", firstPersonMode);
  document.body.classList.toggle("fps-pointer-locked", pointerLocked);
  document.body.classList.toggle("fps-pointer-unlocked", firstPersonMode && !pointerLocked);
  document.body.classList.toggle("fps-scene-aim", hasSceneAim);
  updateFpsControlHint(pointerLocked, hasSceneAim);
}

function createFpsControlHint(): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "fps-control-hint";
  hint.hidden = true;
  hint.innerHTML = `
    <span class="fps-control-hint-status" data-fps-status>FPS active</span>
    <span class="fps-control-hint-action" data-fps-action>Control pending</span>
  `;
  document.body.appendChild(hint);
  return hint;
}

function updateFpsControlHint(pointerLocked: boolean, hasSceneAim: boolean): void {
  const actionLabel = getFpsActionLabel(hasSceneAim);
  const statusLabel = pointerLocked ? "FPS active" : "FPS ready";
  const hintKey = [
    firstPersonMode,
    pointerLocked,
    hasSceneAim,
    aimFeedbackState,
    actionLabel,
    levelProgress?.complete ?? false,
    levelProgress?.failed ?? false,
  ].join(":");

  if (hintKey === lastFpsControlHintKey) {
    return;
  }

  lastFpsControlHintKey = hintKey;
  fpsControlHint.hidden = !firstPersonMode;
  if (!firstPersonMode) {
    return;
  }

  fpsControlHint.dataset.lock = pointerLocked ? "locked" : hasSceneAim ? "free-aim" : "unlocked";
  fpsControlHint.dataset.aim = aimFeedbackState;
  setElementText(fpsControlHint, "[data-fps-status]", statusLabel);
  setElementText(fpsControlHint, "[data-fps-action]", actionLabel);
}

function getFpsActionLabel(hasSceneAim: boolean): string {
  if (!hasSceneAim) {
    return "Control pending";
  }

  if (levelProgress?.complete) {
    return "Route complete";
  }

  if (levelProgress?.failed) {
    return "Route failed";
  }

  if (aimFeedbackState === "hazard") {
    return "Spill risk target";
  }

  if (aimFeedbackState === "blocked") {
    return "No carve target";
  }

  if (aimFeedbackState === "dig") {
    return "Carve target";
  }

  return "Scanning rock";
}

function setElementText(root: ParentNode, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}

function installCaptureStateProbe(): void {
  if (!captureMode && !visualCaptureMode) {
    return;
  }

  window.__WATER_CAPTURE_STATE__ = getCaptureState;
}

function getCaptureState(): WaterCaptureState {
  const canvas = sceneContext.renderer.domElement;
  const stageCount = getSceneOpeningStages(currentPreset).length;
  const level = gameModeEnabled ? getCurrentLevel() : null;
  const stageProgress = levelProgress?.stageProgress ?? getMissionStageProgress();
  const currentWaterVolume = levelProgress?.totalWater ?? totalWater(world);

  return {
    renderer: {
      mode: sceneContext.rendererMode,
      backend: sceneContext.rendererBackend,
    },
    canvas: {
      width: canvas.width,
      height: canvas.height,
      clientWidth: canvas.clientWidth,
      clientHeight: canvas.clientHeight,
    },
    scene: {
      preset: currentPreset,
      gameMode: gameModeEnabled,
      firstPerson: firstPersonMode,
      debugUiVisible,
    },
    input: {
      paused: inputState.paused,
      debugWater: inputState.debugWater,
      showActiveCells: inputState.showActiveCells,
      showFlowDebug: inputState.showFlowDebug,
      sliceEnabled: inputState.sliceEnabled,
      sliceZ: getRenderOptions().slice.z,
    },
    world: {
      width: world.width,
      height: world.height,
      depth: world.depth,
      totalWater: currentWaterVolume,
      activeCells: world.activeCells.size,
      wetCells: world.wetCells.size,
      visualEvents: world.waterVisualEvents.length,
    },
    render: {
      terrainInstances: terrainRenderer.stats.instances,
      waterInstances: waterRenderer.stats.instances,
      terrainRebuilds: terrainRenderer.stats.rebuilds,
      waterRebuilds: waterRenderer.stats.rebuilds,
    },
    simulation: {
      tickCount,
      stableTicks,
      movedLastFrame,
    },
    game: {
      levelId: level?.id ?? null,
      openedStages: openedStageCount,
      stageCount,
      openedHazards: openedHazards.size,
      hazardCount: level?.hazardStages.length ?? 0,
      selectedRouteWater: stageProgress.selectedRouteWater,
      manualRouteWater: getManualRouteWater(),
      deliveredWater: levelProgress?.deliveredWater ?? null,
      wastedWater: levelProgress?.wastedWater ?? null,
      complete: levelProgress?.complete ?? null,
      failed: levelProgress?.failed ?? null,
      status: levelProgress?.status ?? null,
    },
  };
}

function getManualRouteWater(): number | null {
  const manualStage = getSceneOpeningStages(currentPreset).find((stage) => !isStageAutoOpen(stage));
  return manualStage ? measureBoxWater(world, getStageDigBoxes(manualStage)) : null;
}

installCaptureStateProbe();
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

function clearFlowDebugState(): void {
  if (recentFlows.size === 0) {
    return;
  }

  recentFlows.clear();
  inputState.forceWaterUpdate = true;
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
