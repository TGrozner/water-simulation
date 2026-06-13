import { stepWaterSimulation } from "./waterSimulation";
import { TUNING_PRESETS, type TuningPresetId, cloneTuningPreset } from "./tuningPresets";
import { coords, totalWater } from "../world/grid";
import { createWorld, SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { openSceneDrain } from "../world/sceneTools";
import { EPSILON, type VoxelWorld } from "../world/types";

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
const CONSERVATION_TOLERANCE = 0.075;

function runHarness(): void {
  const results: HarnessResult[] = [];

  for (const preset of SCENE_PRESETS) {
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

function runScenario(preset: ScenePresetId, tuningPreset: TuningPresetId): HarnessResult {
    const world = createWorld(preset);
    const tuning = cloneTuningPreset(tuningPreset);
    const baselineWater = totalWater(world);
    assert(baselineWater > 0, `${preset}/${tuningPreset}: expected initial water`);
    assertNoInvalidWater(world, `${preset}/${tuningPreset}: initial`);

    openSceneDrain(world, preset);

    let maxVolumeDelta = 0;
    let movedVolume = 0;
    let idleTicks = 0;

    for (let tick = 0; tick < MAX_TICKS; tick += 1) {
      const stats = stepWaterSimulation(world, tuning.waterConfig);
      movedVolume += stats.movedVolume;
      const volumeDelta = Math.abs(totalWater(world) - baselineWater);
      maxVolumeDelta = Math.max(maxVolumeDelta, volumeDelta);
      assert(
        volumeDelta <= CONSERVATION_TOLERANCE,
        `${preset}/${tuningPreset}: water volume drifted by ${volumeDelta.toFixed(6)}`,
      );
      assertNoInvalidWater(world, `${preset}/${tuningPreset}: tick ${tick}`);

      if (world.activeCells.size === 0) {
        idleTicks += 1;
      } else {
        idleTicks = 0;
      }

      if (idleTicks >= 4) {
        break;
      }
    }

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
