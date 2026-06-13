import "./style.css";
import { createDebugOverlay, updateDebugOverlay } from "./debug/debugOverlay";
import { createDebugPanel } from "./debug/debugPanel";
import { createGamePanel } from "./game/gamePanel";
import { evaluateLevel, GAME_LEVELS, getLevel, type GameLevel, type LevelProgress } from "./game/levels";
import { createCellInspector } from "./input/cellInspector";
import {
  bindKeyboardControls,
  configureOrbitControls,
  createDigController,
  type InputState,
} from "./input/controls";
import { createActiveCellRenderer, type ActiveCellRenderer } from "./render/activeCellRenderer";
import { createBrushPreviewRenderer, type BrushPreviewRenderer } from "./render/brushPreviewRenderer";
import { createFlowDebugRenderer, type FlowDebugRenderer, type RecentFlow } from "./render/flowDebugRenderer";
import { createObjectiveRenderer, type ObjectiveRenderer } from "./render/objectiveRenderer";
import { createSceneContext } from "./render/scene";
import { createSonarRenderer } from "./render/sonarRenderer";
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
import { getSceneOpeningStages, openSceneStage } from "./world/sceneTools";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

const sceneContext = createSceneContext(app);
configureOrbitControls(sceneContext.controls);

const VOLUME_WARNING_TOLERANCE = 0.05;
const FLOW_DEBUG_TTL = 16;
const initialUrlParams = new URLSearchParams(window.location.search);

let gameModeEnabled = getInitialGameModeEnabled();
let currentLevelIndex = getInitialLevelIndex();
let currentPreset: ScenePresetId = gameModeEnabled ? getCurrentLevel().scene : getInitialPreset();
let world = createWorld(currentPreset);
let openedStageCount = openInitialStages(world, currentPreset);
let terrainRenderer: TerrainRenderer = createTerrainRenderer(sceneContext.scene, world);
let waterRenderer: WaterRenderer = createWaterRenderer(sceneContext.scene, world);
let activeCellRenderer: ActiveCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
let flowDebugRenderer: FlowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
let objectiveRenderer: ObjectiveRenderer = createObjectiveRenderer(sceneContext.scene);
let brushPreviewRenderer: BrushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
const sonarRenderer = createSonarRenderer(document.body, world);
let baselineWaterVolume = totalWater(world);
let levelProgress: LevelProgress | null = gameModeEnabled ? evaluateLevel(world, getCurrentLevel()) : null;
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

const overlay = createDebugOverlay();
const gamePanel = createGamePanel({
  resetLevel: resetCurrentLevel,
  nextLevel: advanceToNextLevel,
});
const digController = createDigController(
  sceneContext.renderer,
  sceneContext.camera,
  () => world,
  () => terrainRenderer,
  inputState,
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
    gameModeEnabled,
    currentLevelName: getCurrentLevel().name,
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
  returnToGame: resetCurrentLevel,
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
});

function selectPreset(preset: ScenePresetId): void {
  gameModeEnabled = false;
  levelProgress = null;
  currentPreset = preset;
  resetWorld();
}

function resetCurrentLevel(): void {
  gameModeEnabled = true;
  currentPreset = getCurrentLevel().scene;
  resetWorld();
}

function advanceToNextLevel(): void {
  gameModeEnabled = true;
  currentLevelIndex = currentLevelIndex >= GAME_LEVELS.length - 1 ? 0 : currentLevelIndex + 1;
  currentPreset = getCurrentLevel().scene;
  resetWorld();
}

function setPaused(paused: boolean): void {
  inputState.paused = paused;
}

function queueStep(): void {
  queuedStep = true;
}

function openCurrentScene(): void {
  const removed = openSceneStage(world, currentPreset, openedStageCount);
  if (openedStageCount < getSceneOpeningStages(currentPreset).length) {
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
    removed += openSceneStage(world, currentPreset, openedStageCount);
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
  objectiveRenderer.dispose();
  brushPreviewRenderer.dispose();
  if (gameModeEnabled) {
    currentPreset = getCurrentLevel().scene;
  }
  world = createWorld(currentPreset);
  openedStageCount = 0;
  inputState.sliceZ = Math.min(inputState.sliceZ, world.depth - 1);
  baselineWaterVolume = totalWater(world);
  levelProgress = gameModeEnabled ? evaluateLevel(world, getCurrentLevel()) : null;
  tickCount = 0;
  maxVolumeDelta = 0;
  stableTicks = 0;
  recentFlows = new Map<number, RecentFlow>();
  terrainRenderer = createTerrainRenderer(sceneContext.scene, world);
  waterRenderer = createWaterRenderer(sceneContext.scene, world);
  activeCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
  flowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
  objectiveRenderer = createObjectiveRenderer(sceneContext.scene);
  brushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
  terrainRenderer.update(world, getRenderOptions());
  sonarRenderer.updateTerrain(world);
  sonarRenderer.updateWater(world);
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

function openInitialStages(initialWorld: typeof world, preset: ScenePresetId): number {
  const requestedStages = Number.parseInt(initialUrlParams.get("openStages") ?? "0", 10);
  const stageCount = getSceneOpeningStages(preset).length;
  const stagesToOpen = Number.isFinite(requestedStages) ? Math.min(stageCount, Math.max(0, requestedStages)) : 0;

  for (let stageIndex = 0; stageIndex < stagesToOpen; stageIndex += 1) {
    openSceneStage(initialWorld, preset, stageIndex);
  }

  return stagesToOpen;
}

function isStable(): boolean {
  return world.activeCells.size === 0 && movedLastFrame <= 0.0005;
}

function animate(now: number): void {
  requestAnimationFrame(animate);

  const deltaSeconds = Math.max(0.0001, (now - lastTime) / 1000);
  fps = fps * 0.9 + (1 / deltaSeconds) * 0.1;
  lastTime = now;

  sceneContext.controls.update();
  digController.update();
  cellInspector.update();
  brushPreviewRenderer.update(world, digController.getPreviewCells(), getRenderOptions());
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
    waterRenderer.update(world, inputState.debugWater, getRenderOptions());
    activeCellRenderer.update(world, inputState.debugWater && inputState.showActiveCells, getRenderOptions());
    flowDebugRenderer.update(world, recentFlows, inputState.debugWater && inputState.showFlowDebug, getRenderOptions());
    sonarRenderer.updateWater(world);
    inputState.forceWaterUpdate = false;
  }

  const currentWaterVolume = totalWater(world);
  levelProgress = gameModeEnabled ? evaluateLevel(world, getCurrentLevel()) : null;
  if (levelProgress) {
    objectiveRenderer.update(world, getCurrentLevel(), levelProgress, getRenderOptions());
  }
  const volumeDelta = currentWaterVolume - baselineWaterVolume;
  maxVolumeDelta = Math.max(maxVolumeDelta, Math.abs(volumeDelta));
  const volumeWarning = Math.abs(volumeDelta) > VOLUME_WARNING_TOLERANCE;
  const preset = SCENE_PRESET_DETAILS[currentPreset];

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

  sceneContext.renderer.render(sceneContext.scene, sceneContext.camera);
  sonarRenderer.render(sceneContext.camera);
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
