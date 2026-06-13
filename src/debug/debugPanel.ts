import { SCENE_PRESET_DETAILS, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { TUNING_PRESET_DETAILS, TUNING_PRESETS, type TuningPresetId } from "../sim/tuningPresets";
import type { WaterSimulationConfig } from "../sim/waterSimulation";

export type DebugPanelSnapshot = {
  preset: ScenePresetId;
  gameModeEnabled: boolean;
  currentLevelName: string;
  paused: boolean;
  debugWater: boolean;
  showActiveCells: boolean;
  showFlowDebug: boolean;
  sliceEnabled: boolean;
  sliceZ: number;
  maxSliceZ: number;
  tickCount: number;
  maxVolumeDelta: number;
  stableTicks: number;
  lastMovedVolume: number;
  stable: boolean;
  nextOpeningLabel: string;
  openedStages: number;
  openingStages: number;
  openingStageLabels: string[];
  lastSimulationMs: number;
  simStepsPerFrame: number;
  digRadius: number;
  tuningPreset: TuningPresetId | "custom";
  hasSavedCustomTuning: boolean;
  waterConfig: WaterSimulationConfig;
};

export type DebugPanelActions = {
  getSnapshot: () => DebugPanelSnapshot;
  setPreset: (preset: ScenePresetId) => void;
  returnToGame: () => void;
  setPaused: (paused: boolean) => void;
  step: () => void;
  reset: () => void;
  openScene: () => void;
  openAllScene: () => void;
  setDebugWater: (enabled: boolean) => void;
  setShowActiveCells: (enabled: boolean) => void;
  setShowFlowDebug: (enabled: boolean) => void;
  setSliceEnabled: (enabled: boolean) => void;
  setSliceZ: (z: number) => void;
  setSimStepsPerFrame: (steps: number) => void;
  setDigRadius: (radius: number) => void;
  setWaterConfig: (config: WaterSimulationConfig) => void;
  setTuningPreset: (preset: TuningPresetId) => void;
  saveCustomTuning: () => void;
  loadCustomTuning: () => void;
  clearCustomTuning: () => void;
  resetTuning: () => void;
};

export type DebugPanel = {
  update: () => void;
};

export function createDebugPanel(actions: DebugPanelActions): DebugPanel {
  const panel = document.createElement("form");
  panel.className = "debug-panel";
  panel.innerHTML = `
    <label>
      <span>Scene</span>
      <select name="preset"></select>
    </label>
    <button type="button" name="returnToGame">Return to game</button>
    <div class="debug-panel-row">
      <button type="button" name="pause"></button>
      <button type="button" name="step">Step</button>
      <button type="button" name="reset">Reset</button>
    </div>
    <div class="debug-panel-row debug-panel-row-two">
      <button type="button" name="openScene">Open next</button>
      <button type="button" name="openAllScene">Open all</button>
    </div>
    <ol class="debug-panel-stages"></ol>
    <label class="debug-panel-check">
      <input type="checkbox" name="debugWater" />
      <span>Water debug</span>
    </label>
    <label class="debug-panel-check">
      <input type="checkbox" name="showActiveCells" />
      <span>Active cells</span>
    </label>
    <label class="debug-panel-check">
      <input type="checkbox" name="showFlowDebug" />
      <span>Flow glyphs</span>
    </label>
    <label class="debug-panel-check">
      <input type="checkbox" name="sliceEnabled" />
      <span>Slice view</span>
    </label>
    <label>
      <span>Slice z</span>
      <input type="range" name="sliceZ" min="0" max="47" step="1" />
    </label>
    <fieldset class="debug-panel-tuning">
      <legend>Tuning</legend>
      <label>
        <span>Preset</span>
        <select name="tuningPreset"></select>
      </label>
      <label>
        <span>Down flow <b data-tuning-value="downFlow">0.60</b></span>
        <input type="range" name="downFlow" min="0.05" max="1" step="0.05" />
      </label>
      <label>
        <span>Side flow <b data-tuning-value="sideFlow">0.20</b></span>
        <input type="range" name="sideFlow" min="0.02" max="0.6" step="0.02" />
      </label>
      <label>
        <span>Min flow <b data-tuning-value="minFlow">0.010</b></span>
        <input type="range" name="minFlow" min="0.001" max="0.05" step="0.001" />
      </label>
      <label>
        <span>Steps/frame <b data-tuning-value="steps">2</b></span>
        <input type="range" name="steps" min="1" max="8" step="1" />
      </label>
      <label>
        <span>Brush <b data-tuning-value="brush">2.2</b></span>
        <input type="range" name="brush" min="0.8" max="4" step="0.1" />
      </label>
      <div class="debug-panel-row">
        <button type="button" name="saveCustomTuning">Save</button>
        <button type="button" name="loadCustomTuning">Load</button>
        <button type="button" name="clearCustomTuning">Clear</button>
      </div>
      <button type="button" name="resetTuning">Reset tuning</button>
    </fieldset>
    <dl class="debug-panel-metrics">
      <dt>Ticks</dt><dd data-metric="ticks">0</dd>
      <dt>Last moved</dt><dd data-metric="lastMoved">0.000</dd>
      <dt>Sim update</dt><dd data-metric="simUpdate">0.0ms</dd>
      <dt>Max delta</dt><dd data-metric="maxDelta">0.000</dd>
      <dt>Idle ticks</dt><dd data-metric="idleTicks">0</dd>
      <dt>Status</dt><dd data-metric="status">stable</dd>
    </dl>
  `;

  panel.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.appendChild(panel);

  const presetSelect = panel.elements.namedItem("preset") as HTMLSelectElement;
  for (const preset of SCENE_PRESETS) {
    const option = document.createElement("option");
    option.value = preset;
    option.textContent = SCENE_PRESET_DETAILS[preset].name;
    presetSelect.appendChild(option);
  }

  const pauseButton = panel.elements.namedItem("pause") as HTMLButtonElement;
  const returnToGameButton = panel.elements.namedItem("returnToGame") as HTMLButtonElement;
  const stepButton = panel.elements.namedItem("step") as HTMLButtonElement;
  const resetButton = panel.elements.namedItem("reset") as HTMLButtonElement;
  const openSceneButton = panel.elements.namedItem("openScene") as HTMLButtonElement;
  const openAllSceneButton = panel.elements.namedItem("openAllScene") as HTMLButtonElement;
  const stageList = panel.querySelector<HTMLOListElement>(".debug-panel-stages");
  const tuningPresetSelect = panel.elements.namedItem("tuningPreset") as HTMLSelectElement;
  const debugWaterInput = panel.elements.namedItem("debugWater") as HTMLInputElement;
  const showActiveCellsInput = panel.elements.namedItem("showActiveCells") as HTMLInputElement;
  const showFlowDebugInput = panel.elements.namedItem("showFlowDebug") as HTMLInputElement;
  const sliceInput = panel.elements.namedItem("sliceEnabled") as HTMLInputElement;
  const sliceZInput = panel.elements.namedItem("sliceZ") as HTMLInputElement;
  const downFlowInput = panel.elements.namedItem("downFlow") as HTMLInputElement;
  const sideFlowInput = panel.elements.namedItem("sideFlow") as HTMLInputElement;
  const minFlowInput = panel.elements.namedItem("minFlow") as HTMLInputElement;
  const stepsInput = panel.elements.namedItem("steps") as HTMLInputElement;
  const brushInput = panel.elements.namedItem("brush") as HTMLInputElement;
  const saveCustomTuningButton = panel.elements.namedItem("saveCustomTuning") as HTMLButtonElement;
  const loadCustomTuningButton = panel.elements.namedItem("loadCustomTuning") as HTMLButtonElement;
  const clearCustomTuningButton = panel.elements.namedItem("clearCustomTuning") as HTMLButtonElement;
  const resetTuningButton = panel.elements.namedItem("resetTuning") as HTMLButtonElement;
  const ticksMetric = panel.querySelector<HTMLElement>('[data-metric="ticks"]');
  const lastMovedMetric = panel.querySelector<HTMLElement>('[data-metric="lastMoved"]');
  const simUpdateMetric = panel.querySelector<HTMLElement>('[data-metric="simUpdate"]');
  const maxDeltaMetric = panel.querySelector<HTMLElement>('[data-metric="maxDelta"]');
  const idleTicksMetric = panel.querySelector<HTMLElement>('[data-metric="idleTicks"]');
  const statusMetric = panel.querySelector<HTMLElement>('[data-metric="status"]');

  for (const tuningPreset of TUNING_PRESETS) {
    const option = document.createElement("option");
    option.value = tuningPreset;
    option.textContent = TUNING_PRESET_DETAILS[tuningPreset].name;
    tuningPresetSelect.appendChild(option);
  }
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom";
  customOption.disabled = true;
  tuningPresetSelect.appendChild(customOption);

  presetSelect.addEventListener("change", () => actions.setPreset(presetSelect.value as ScenePresetId));
  returnToGameButton.addEventListener("click", () => actions.returnToGame());
  tuningPresetSelect.addEventListener("change", () => actions.setTuningPreset(tuningPresetSelect.value as TuningPresetId));
  pauseButton.addEventListener("click", () => actions.setPaused(!actions.getSnapshot().paused));
  stepButton.addEventListener("click", () => actions.step());
  resetButton.addEventListener("click", () => actions.reset());
  openSceneButton.addEventListener("click", () => actions.openScene());
  openAllSceneButton.addEventListener("click", () => actions.openAllScene());
  debugWaterInput.addEventListener("change", () => actions.setDebugWater(debugWaterInput.checked));
  showActiveCellsInput.addEventListener("change", () => actions.setShowActiveCells(showActiveCellsInput.checked));
  showFlowDebugInput.addEventListener("change", () => actions.setShowFlowDebug(showFlowDebugInput.checked));
  sliceInput.addEventListener("change", () => actions.setSliceEnabled(sliceInput.checked));
  sliceZInput.addEventListener("input", () => actions.setSliceZ(Number.parseInt(sliceZInput.value, 10)));
  downFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  sideFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  minFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  stepsInput.addEventListener("input", () => actions.setSimStepsPerFrame(Number.parseInt(stepsInput.value, 10)));
  brushInput.addEventListener("input", () => actions.setDigRadius(Number.parseFloat(brushInput.value)));
  saveCustomTuningButton.addEventListener("click", () => actions.saveCustomTuning());
  loadCustomTuningButton.addEventListener("click", () => actions.loadCustomTuning());
  clearCustomTuningButton.addEventListener("click", () => actions.clearCustomTuning());
  resetTuningButton.addEventListener("click", () => actions.resetTuning());

  function update(): void {
    const snapshot = actions.getSnapshot();
    presetSelect.value = snapshot.preset;
    returnToGameButton.hidden = snapshot.gameModeEnabled;
    returnToGameButton.textContent = `Return to ${snapshot.currentLevelName}`;
    pauseButton.textContent = snapshot.paused ? "Resume" : "Pause";
    openSceneButton.textContent =
      snapshot.openedStages >= snapshot.openingStages
        ? "Path open"
        : `Open ${snapshot.openedStages + 1}/${snapshot.openingStages}: ${snapshot.nextOpeningLabel}`;
    openSceneButton.disabled = snapshot.openedStages >= snapshot.openingStages;
    openAllSceneButton.disabled = snapshot.openedStages >= snapshot.openingStages;
    debugWaterInput.checked = snapshot.debugWater;
    showActiveCellsInput.checked = snapshot.showActiveCells;
    showFlowDebugInput.checked = snapshot.showFlowDebug;
    showActiveCellsInput.disabled = !snapshot.debugWater;
    showFlowDebugInput.disabled = !snapshot.debugWater;
    sliceInput.checked = snapshot.sliceEnabled;
    sliceZInput.max = String(snapshot.maxSliceZ);
    sliceZInput.value = String(snapshot.sliceZ);
    sliceZInput.disabled = !snapshot.sliceEnabled;
    stepButton.disabled = !snapshot.paused;
    tuningPresetSelect.value = snapshot.tuningPreset;
    loadCustomTuningButton.disabled = !snapshot.hasSavedCustomTuning;
    clearCustomTuningButton.disabled = !snapshot.hasSavedCustomTuning;
    downFlowInput.value = String(snapshot.waterConfig.downFlowRate);
    sideFlowInput.value = String(snapshot.waterConfig.sideFlowRate);
    minFlowInput.value = String(snapshot.waterConfig.minFlow);
    stepsInput.value = String(snapshot.simStepsPerFrame);
    brushInput.value = String(snapshot.digRadius);
    updateTuningValue(panel, "downFlow", snapshot.waterConfig.downFlowRate.toFixed(2));
    updateTuningValue(panel, "sideFlow", snapshot.waterConfig.sideFlowRate.toFixed(2));
    updateTuningValue(panel, "minFlow", snapshot.waterConfig.minFlow.toFixed(3));
    updateTuningValue(panel, "steps", String(snapshot.simStepsPerFrame));
    updateTuningValue(panel, "brush", snapshot.digRadius.toFixed(1));
    updateStageList(stageList, snapshot.openingStageLabels, snapshot.openedStages);
    updateMetric(ticksMetric, String(snapshot.tickCount));
    updateMetric(lastMovedMetric, snapshot.lastMovedVolume.toFixed(3));
    updateMetric(simUpdateMetric, `${snapshot.lastSimulationMs.toFixed(1)}ms`);
    updateMetric(maxDeltaMetric, snapshot.maxVolumeDelta.toFixed(3));
    updateMetric(idleTicksMetric, String(snapshot.stableTicks));
    updateMetric(statusMetric, snapshot.stable ? "stable" : "moving");
  }

  update();

  return { update };
}

function updateStageList(element: HTMLOListElement | null, labels: string[], openedStages: number): void {
  if (!element) {
    return;
  }

  element.innerHTML = labels
    .map((label, index) => {
      const state = index < openedStages ? "open" : index === openedStages ? "next" : "locked";
      return `<li data-stage-state="${state}"><span>${index + 1}</span>${label}</li>`;
    })
    .join("");
}

function updateMetric(element: HTMLElement | null, value: string): void {
  if (element) {
    element.textContent = value;
  }
}

function updateWaterConfig(
  actions: DebugPanelActions,
  downFlowInput: HTMLInputElement,
  sideFlowInput: HTMLInputElement,
  minFlowInput: HTMLInputElement,
): void {
  actions.setWaterConfig({
    downFlowRate: Number.parseFloat(downFlowInput.value),
    sideFlowRate: Number.parseFloat(sideFlowInput.value),
    minFlow: Number.parseFloat(minFlowInput.value),
  });
}

function updateTuningValue(panel: HTMLFormElement, key: string, value: string): void {
  const element = panel.querySelector<HTMLElement>(`[data-tuning-value="${key}"]`);
  if (element) {
    element.textContent = value;
  }
}
