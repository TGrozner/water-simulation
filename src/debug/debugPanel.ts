import { SCENE_PRESET_DETAILS, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { TUNING_PRESET_DETAILS, TUNING_PRESETS, type TuningPresetId } from "../sim/tuningPresets";
import type { WaterSimulationConfig } from "../sim/waterSimulation";

export type DebugPanelSnapshot = {
  preset: ScenePresetId;
  paused: boolean;
  debugWater: boolean;
  sliceEnabled: boolean;
  sliceZ: number;
  maxSliceZ: number;
  tickCount: number;
  maxVolumeDelta: number;
  stableTicks: number;
  lastMovedVolume: number;
  stable: boolean;
  simStepsPerFrame: number;
  digRadius: number;
  tuningPreset: TuningPresetId | "custom";
  waterConfig: WaterSimulationConfig;
};

export type DebugPanelActions = {
  getSnapshot: () => DebugPanelSnapshot;
  setPreset: (preset: ScenePresetId) => void;
  setPaused: (paused: boolean) => void;
  step: () => void;
  reset: () => void;
  openScene: () => void;
  setDebugWater: (enabled: boolean) => void;
  setSliceEnabled: (enabled: boolean) => void;
  setSliceZ: (z: number) => void;
  setSimStepsPerFrame: (steps: number) => void;
  setDigRadius: (radius: number) => void;
  setWaterConfig: (config: WaterSimulationConfig) => void;
  setTuningPreset: (preset: TuningPresetId) => void;
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
    <div class="debug-panel-row">
      <button type="button" name="pause"></button>
      <button type="button" name="step">Step</button>
      <button type="button" name="reset">Reset</button>
    </div>
    <button type="button" name="openScene">Open path</button>
    <label class="debug-panel-check">
      <input type="checkbox" name="debugWater" />
      <span>Water debug</span>
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
      <button type="button" name="resetTuning">Reset tuning</button>
    </fieldset>
    <dl class="debug-panel-metrics">
      <dt>Ticks</dt><dd data-metric="ticks">0</dd>
      <dt>Last moved</dt><dd data-metric="lastMoved">0.000</dd>
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
  const stepButton = panel.elements.namedItem("step") as HTMLButtonElement;
  const resetButton = panel.elements.namedItem("reset") as HTMLButtonElement;
  const openSceneButton = panel.elements.namedItem("openScene") as HTMLButtonElement;
  const tuningPresetSelect = panel.elements.namedItem("tuningPreset") as HTMLSelectElement;
  const debugWaterInput = panel.elements.namedItem("debugWater") as HTMLInputElement;
  const sliceInput = panel.elements.namedItem("sliceEnabled") as HTMLInputElement;
  const sliceZInput = panel.elements.namedItem("sliceZ") as HTMLInputElement;
  const downFlowInput = panel.elements.namedItem("downFlow") as HTMLInputElement;
  const sideFlowInput = panel.elements.namedItem("sideFlow") as HTMLInputElement;
  const minFlowInput = panel.elements.namedItem("minFlow") as HTMLInputElement;
  const stepsInput = panel.elements.namedItem("steps") as HTMLInputElement;
  const brushInput = panel.elements.namedItem("brush") as HTMLInputElement;
  const resetTuningButton = panel.elements.namedItem("resetTuning") as HTMLButtonElement;
  const ticksMetric = panel.querySelector<HTMLElement>('[data-metric="ticks"]');
  const lastMovedMetric = panel.querySelector<HTMLElement>('[data-metric="lastMoved"]');
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
  tuningPresetSelect.addEventListener("change", () => actions.setTuningPreset(tuningPresetSelect.value as TuningPresetId));
  pauseButton.addEventListener("click", () => actions.setPaused(!actions.getSnapshot().paused));
  stepButton.addEventListener("click", () => actions.step());
  resetButton.addEventListener("click", () => actions.reset());
  openSceneButton.addEventListener("click", () => actions.openScene());
  debugWaterInput.addEventListener("change", () => actions.setDebugWater(debugWaterInput.checked));
  sliceInput.addEventListener("change", () => actions.setSliceEnabled(sliceInput.checked));
  sliceZInput.addEventListener("input", () => actions.setSliceZ(Number.parseInt(sliceZInput.value, 10)));
  downFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  sideFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  minFlowInput.addEventListener("input", () => updateWaterConfig(actions, downFlowInput, sideFlowInput, minFlowInput));
  stepsInput.addEventListener("input", () => actions.setSimStepsPerFrame(Number.parseInt(stepsInput.value, 10)));
  brushInput.addEventListener("input", () => actions.setDigRadius(Number.parseFloat(brushInput.value)));
  resetTuningButton.addEventListener("click", () => actions.resetTuning());

  function update(): void {
    const snapshot = actions.getSnapshot();
    presetSelect.value = snapshot.preset;
    pauseButton.textContent = snapshot.paused ? "Resume" : "Pause";
    debugWaterInput.checked = snapshot.debugWater;
    sliceInput.checked = snapshot.sliceEnabled;
    sliceZInput.max = String(snapshot.maxSliceZ);
    sliceZInput.value = String(snapshot.sliceZ);
    sliceZInput.disabled = !snapshot.sliceEnabled;
    stepButton.disabled = !snapshot.paused;
    tuningPresetSelect.value = snapshot.tuningPreset;
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
    updateMetric(ticksMetric, String(snapshot.tickCount));
    updateMetric(lastMovedMetric, snapshot.lastMovedVolume.toFixed(3));
    updateMetric(maxDeltaMetric, snapshot.maxVolumeDelta.toFixed(3));
    updateMetric(idleTicksMetric, String(snapshot.stableTicks));
    updateMetric(statusMetric, snapshot.stable ? "stable" : "moving");
  }

  update();

  return { update };
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
