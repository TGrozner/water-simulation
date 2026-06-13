import { SIM_STEPS_PER_FRAME } from "../world/types";
import { DEFAULT_WATER_SIMULATION_CONFIG, type WaterSimulationConfig } from "./waterSimulation";

export const DEFAULT_DIG_RADIUS = 2.2;

export const TUNING_PRESETS = ["default", "fast-drain", "slow-viscous", "stable-spread", "debug-aggressive"] as const;

export type TuningPresetId = (typeof TUNING_PRESETS)[number];

export type TuningPreset = {
  id: TuningPresetId;
  name: string;
  description: string;
  waterConfig: WaterSimulationConfig;
  simStepsPerFrame: number;
  digRadius: number;
};

export const DEFAULT_TUNING_PRESET_ID: TuningPresetId = "default";

export const TUNING_PRESET_DETAILS: Record<TuningPresetId, TuningPreset> = {
  default: {
    id: "default",
    name: "Default",
    description: "Balanced gameplay flow for the authored cave scenes.",
    waterConfig: { ...DEFAULT_WATER_SIMULATION_CONFIG },
    simStepsPerFrame: SIM_STEPS_PER_FRAME,
    digRadius: DEFAULT_DIG_RADIUS,
  },
  "fast-drain": {
    id: "fast-drain",
    name: "Fast drain",
    description: "Faster falling water and wider brush cuts for quick reservoir releases.",
    waterConfig: {
      downFlowRate: 0.9,
      sideFlowRate: 0.24,
      minFlow: 0.008,
    },
    simStepsPerFrame: 4,
    digRadius: 2.6,
  },
  "slow-viscous": {
    id: "slow-viscous",
    name: "Slow viscous",
    description: "Slower flow that makes lateral spreading easier to inspect.",
    waterConfig: {
      downFlowRate: 0.35,
      sideFlowRate: 0.1,
      minFlow: 0.012,
    },
    simStepsPerFrame: 2,
    digRadius: 2,
  },
  "stable-spread": {
    id: "stable-spread",
    name: "Stable spread",
    description: "Lower lateral rate and higher sleep threshold for calmer settling.",
    waterConfig: {
      downFlowRate: 0.6,
      sideFlowRate: 0.14,
      minFlow: 0.02,
    },
    simStepsPerFrame: 3,
    digRadius: 2.2,
  },
  "debug-aggressive": {
    id: "debug-aggressive",
    name: "Debug aggressive",
    description: "High movement rates to expose flow paths and wake behavior quickly.",
    waterConfig: {
      downFlowRate: 1,
      sideFlowRate: 0.38,
      minFlow: 0.004,
    },
    simStepsPerFrame: 5,
    digRadius: 3,
  },
};

export function cloneTuningPreset(id: TuningPresetId): TuningPreset {
  const preset = TUNING_PRESET_DETAILS[id];
  return {
    ...preset,
    waterConfig: { ...preset.waterConfig },
  };
}
