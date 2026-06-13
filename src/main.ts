import "./style.css";
import { createDebugOverlay, updateDebugOverlay } from "./debug/debugOverlay";
import { createDebugPanel } from "./debug/debugPanel";
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
import { createSceneContext } from "./render/scene";
import { createTerrainRenderer, type TerrainRenderer } from "./render/terrainRenderer";
import { createWaterRenderer, type WaterRenderer } from "./render/waterRenderer";
import type { RenderOptions } from "./render/renderOptions";
import { stepWaterSimulation, type FlowEvent, type WaterSimulationConfig } from "./sim/waterSimulation";
import {
  cloneTuningPreset,
  DEFAULT_DIG_RADIUS,
  DEFAULT_TUNING_PRESET_ID,
  type TuningPresetId,
} from "./sim/tuningPresets";
import { totalWater } from "./world/grid";
import { createWorld, SCENE_PRESET_DETAILS, SCENE_PRESETS, type ScenePresetId } from "./world/createWorld";
import { openSceneDrain } from "./world/sceneTools";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app container");
}

const sceneContext = createSceneContext(app);
configureOrbitControls(sceneContext.controls);

const VOLUME_WARNING_TOLERANCE = 0.05;
const FLOW_DEBUG_TTL = 16;

let currentPreset: ScenePresetId = getInitialPreset();
let world = createWorld(currentPreset);
let terrainRenderer: TerrainRenderer = createTerrainRenderer(sceneContext.scene, world);
let waterRenderer: WaterRenderer = createWaterRenderer(sceneContext.scene, world);
let activeCellRenderer: ActiveCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
let flowDebugRenderer: FlowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
let brushPreviewRenderer: BrushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
let baselineWaterVolume = totalWater(world);
let currentTuningPreset: TuningPresetId | "custom" = DEFAULT_TUNING_PRESET_ID;
let activeTuning = cloneTuningPreset(DEFAULT_TUNING_PRESET_ID);
let waterConfig: WaterSimulationConfig = { ...activeTuning.waterConfig };
let simStepsPerFrame = activeTuning.simStepsPerFrame;
let recentFlows = new Map<number, RecentFlow>();

const inputState: InputState = {
  paused: false,
  debugWater: new URLSearchParams(window.location.search).get("debug") === "1",
  terrainDirty: true,
  forceWaterUpdate: true,
  sliceEnabled: new URLSearchParams(window.location.search).get("slice") === "1",
  sliceZ: getInitialSliceZ(),
  digRadius: DEFAULT_DIG_RADIUS,
};

let queuedStep = false;
let movedLastFrame = 0;
let tickCount = 0;
let maxVolumeDelta = 0;
let stableTicks = 0;
let fps = 0;
let lastTime = performance.now();

const overlay = createDebugOverlay();
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
    paused: inputState.paused,
    debugWater: inputState.debugWater,
    sliceEnabled: inputState.sliceEnabled,
    sliceZ: getRenderOptions().slice.z,
    maxSliceZ: world.depth - 1,
    tickCount,
    maxVolumeDelta,
    stableTicks,
    lastMovedVolume: movedLastFrame,
    stable: isStable(),
    simStepsPerFrame,
    digRadius: inputState.digRadius,
    tuningPreset: currentTuningPreset,
    waterConfig,
  }),
  setPreset: selectPreset,
  setPaused: setPaused,
  step: queueStep,
  reset: resetWorld,
  openScene: openCurrentScene,
  setDebugWater: setDebugWater,
  setSliceEnabled: setSliceEnabled,
  setSliceZ: setSliceZ,
  setSimStepsPerFrame: setSimStepsPerFrame,
  setDigRadius: setDigRadius,
  setWaterConfig: setWaterConfig,
  setTuningPreset: applyTuningPreset,
  resetTuning: resetTuning,
});

bindKeyboardControls(inputState, {
  reset: resetWorld,
  step: queueStep,
  selectPreset,
  renderOptionsChanged: markRenderOptionsChanged,
});

function selectPreset(preset: ScenePresetId): void {
  currentPreset = preset;
  resetWorld();
}

function setPaused(paused: boolean): void {
  inputState.paused = paused;
}

function queueStep(): void {
  queuedStep = true;
}

function openCurrentScene(): void {
  const removed = openSceneDrain(world, currentPreset);
  if (removed > 0) {
    markRenderOptionsChanged();
  }
}

function setDebugWater(enabled: boolean): void {
  inputState.debugWater = enabled;
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
  world = createWorld(currentPreset);
  inputState.sliceZ = Math.min(inputState.sliceZ, world.depth - 1);
  baselineWaterVolume = totalWater(world);
  tickCount = 0;
  maxVolumeDelta = 0;
  stableTicks = 0;
  recentFlows = new Map<number, RecentFlow>();
  terrainRenderer = createTerrainRenderer(sceneContext.scene, world);
  waterRenderer = createWaterRenderer(sceneContext.scene, world);
  activeCellRenderer = createActiveCellRenderer(sceneContext.scene, world);
  flowDebugRenderer = createFlowDebugRenderer(sceneContext.scene, world);
  brushPreviewRenderer = createBrushPreviewRenderer(sceneContext.scene, world);
  terrainRenderer.update(world, getRenderOptions());
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
  const requestedPreset = new URLSearchParams(window.location.search).get("scene");
  if (SCENE_PRESETS.includes(requestedPreset as ScenePresetId)) {
    return requestedPreset as ScenePresetId;
  }

  return "reservoir";
}

function getInitialSliceZ(): number {
  const requestedSlice = Number.parseInt(new URLSearchParams(window.location.search).get("sliceZ") ?? "31", 10);
  return Number.isFinite(requestedSlice) ? requestedSlice : 31;
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
    const stepCount = queuedStep ? 1 : simStepsPerFrame;
    for (let i = 0; i < stepCount; i += 1) {
      const stats = stepWaterSimulation(world, waterConfig);
      movedLastFrame += stats.movedVolume;
      recordFlowEvents(stats.flowEvents);
      tickCount += 1;
    }
    queuedStep = false;
    inputState.forceWaterUpdate = true;
  }

  decayFlowEvents();
  stableTicks = isStable() ? stableTicks + 1 : 0;

  if (inputState.terrainDirty) {
    terrainRenderer.update(world, getRenderOptions());
    inputState.terrainDirty = false;
  }

  if (inputState.forceWaterUpdate) {
    waterRenderer.update(world, inputState.debugWater, getRenderOptions());
    activeCellRenderer.update(world, inputState.debugWater, getRenderOptions());
    flowDebugRenderer.update(world, recentFlows, inputState.debugWater, getRenderOptions());
    inputState.forceWaterUpdate = false;
  }

  const currentWaterVolume = totalWater(world);
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
  });
  debugPanel.update();

  sceneContext.renderer.render(sceneContext.scene, sceneContext.camera);
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
