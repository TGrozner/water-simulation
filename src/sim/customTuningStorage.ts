import type { WaterSimulationConfig } from "./waterSimulation";

const STORAGE_KEY = "voxel-water-custom-tuning-v1";

export type StoredCustomTuning = {
  waterConfig: WaterSimulationConfig;
  simStepsPerFrame: number;
  digRadius: number;
};

export function loadCustomTuning(): StoredCustomTuning | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  const rawValue = storage.getItem(STORAGE_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<StoredCustomTuning>;
    if (!isStoredCustomTuning(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveCustomTuning(tuning: StoredCustomTuning): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch {
    // Storage can fail in private contexts or when quota is exhausted.
  }
}

export function clearCustomTuning(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures; custom tuning persistence is optional.
  }
}

function isStoredCustomTuning(value: Partial<StoredCustomTuning>): value is StoredCustomTuning {
  return (
    Boolean(value.waterConfig) &&
    isFiniteNumber(value.waterConfig?.downFlowRate) &&
    isFiniteNumber(value.waterConfig?.sideFlowRate) &&
    isFiniteNumber(value.waterConfig?.minFlow) &&
    isFiniteNumber(value.simStepsPerFrame) &&
    isFiniteNumber(value.digRadius)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
