import { coords, inBounds, index, isSolid, refreshWetCell, wakeNeighbors } from "../world/grid";
import {
  DOWN_FLOW_RATE,
  EPSILON,
  MIN_FLOW,
  SIDE_FLOW_RATE,
  type CellCoords,
  type VoxelWorld,
} from "../world/types";

const LATERAL_DIRECTIONS: CellCoords[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const VOLUME_CORRECTION_EPSILON = 0.000_000_1;

type ColumnSpan = {
  x: number;
  z: number;
  bottomY: number;
  topY: number;
};

type LateralCandidate = {
  direction: CellCoords;
  span: ColumnSpan;
  portalBottomY: number;
  portalTopY: number;
  targetHeadY: number;
};

export type WaterSimulationConfig = {
  downFlowRate: number;
  sideFlowRate: number;
  minFlow: number;
};

export const DEFAULT_WATER_SIMULATION_CONFIG: WaterSimulationConfig = {
  downFlowRate: DOWN_FLOW_RATE,
  sideFlowRate: SIDE_FLOW_RATE,
  minFlow: MIN_FLOW,
};

export type FlowDirection = "down" | "side";

export type FlowEvent = {
  fromCellIndex: number;
  cellIndex: number;
  direction: FlowDirection;
  dx: number;
  dy: number;
  dz: number;
  amount: number;
};

export type WaterStepStats = {
  movedVolume: number;
  changedCells: number;
  flowEvents: FlowEvent[];
};

export type WaterStepOptions = {
  collectFlowEvents?: boolean;
};

const EMPTY_FLOW_EVENTS: FlowEvent[] = [];

export function stepWaterSimulation(
  world: VoxelWorld,
  config: WaterSimulationConfig = DEFAULT_WATER_SIMULATION_CONFIG,
  options: WaterStepOptions = {},
): WaterStepStats {
  const currentCells = Array.from(world.activeCells).sort((a, b) => a - b);
  const nextActiveCells = new Set<number>();
  const activeSpans = new Map<string, ColumnSpan>();
  let movedVolume = 0;
  let changedCells = 0;
  const collectFlowEvents = options.collectFlowEvents ?? true;
  const flowEvents: FlowEvent[] = collectFlowEvents ? [] : EMPTY_FLOW_EVENTS;

  world.activeCells.clear();

  for (const cellIndex of currentCells) {
    if (world.solid[cellIndex] === 1) {
      continue;
    }

    const cell = coords(world, cellIndex);
    const span = findOpenSpan(world, cell.x, cell.y, cell.z);
    if (!span) {
      continue;
    }

    const key = getSpanKey(span);
    if (activeSpans.has(key)) {
      continue;
    }

    const settled = settleSpan(world, span, config);
    if (settled.changedCells > 0) {
      movedVolume += settled.movedVolume;
      changedCells += settled.changedCells;
      markSpanActive(world, span, settled.volume, nextActiveCells);
      if (collectFlowEvents && settled.movedVolume > EPSILON) {
        flowEvents.push({
          fromCellIndex: cellIndex,
          cellIndex: getSpanSurfaceCellIndex(world, span, settled.volume),
          direction: "down",
          dx: 0,
          dy: -1,
          dz: 0,
          amount: settled.movedVolume,
        });
      }
    }

    if (settled.volume > EPSILON) {
      activeSpans.set(key, span);
    }
  }

  const sortedSpans = Array.from(activeSpans.values()).sort((a, b) => getSpanSurfaceY(world, b) - getSpanSurfaceY(world, a));
  for (const span of sortedSpans) {
    const result = flowSpanLaterally(world, span, config, flowEvents, collectFlowEvents, nextActiveCells);
    movedVolume += result.movedVolume;
    changedCells += result.changedCells;
  }

  for (const span of sortedSpans) {
    const volume = getSpanVolume(world, span);
    if (volume > EPSILON && canSpanStillFlow(world, span, volume, config)) {
      markSpanActive(world, span, volume, nextActiveCells);
    }
  }

  world.activeCells = nextActiveCells;

  return {
    movedVolume,
    changedCells,
    flowEvents,
  };
}

function settleSpan(
  world: VoxelWorld,
  span: ColumnSpan,
  config: WaterSimulationConfig,
): { volume: number; movedVolume: number; changedCells: number } {
  const volume = getSpanVolume(world, span);
  const fallRate = Math.max(0, config.downFlowRate);
  if (fallRate <= config.minFlow || volume <= EPSILON) {
    return {
      volume,
      movedVolume: 0,
      changedCells: 0,
    };
  }

  const amounts = getSpanAmounts(world, span);
  let movedVolume = 0;

  for (let offset = 0; offset < amounts.length - 1; offset += 1) {
    const lowerAmount = amounts[offset];
    const upperAmount = amounts[offset + 1];
    const transfer = Math.min(1 - lowerAmount, upperAmount, fallRate);
    if (transfer <= config.minFlow) {
      continue;
    }

    amounts[offset] += transfer;
    amounts[offset + 1] -= transfer;
    movedVolume += transfer;
  }

  const result = writeSpanAmounts(world, span, amounts, volume);
  return {
    volume,
    movedVolume,
    changedCells: result.changedCells,
  };
}

function flowSpanLaterally(
  world: VoxelWorld,
  span: ColumnSpan,
  config: WaterSimulationConfig,
  flowEvents: FlowEvent[],
  collectFlowEvents: boolean,
  nextActiveCells: Set<number>,
): { movedVolume: number; changedCells: number } {
  let movedVolume = 0;
  let changedCells = 0;

  for (const candidate of getLateralCandidates(world, span)) {
    const sourceVolume = getSpanVolume(world, span);
    if (sourceVolume <= EPSILON) {
      break;
    }

    const targetVolume = getSpanVolume(world, candidate.span);
    const transfer = getLateralTransferAmount(span, sourceVolume, candidate, targetVolume, config);
    if (transfer <= config.minFlow) {
      continue;
    }

    const sourceResult = setSpanVolume(world, span, sourceVolume - transfer);
    const targetResult = setSpanVolume(world, candidate.span, targetVolume + transfer);
    movedVolume += transfer;
    changedCells += sourceResult.changedCells + targetResult.changedCells;

    markSpanActive(world, span, sourceVolume - transfer, nextActiveCells);
    markSpanActive(world, candidate.span, targetVolume + transfer, nextActiveCells);

    if (collectFlowEvents) {
      flowEvents.push({
        fromCellIndex: getSpanSurfaceCellIndex(world, span, sourceVolume),
        cellIndex: index(world, candidate.span.x, candidate.portalBottomY, candidate.span.z),
        direction: "side",
        dx: candidate.direction.x,
        dy: 0,
        dz: candidate.direction.z,
        amount: transfer,
      });
    }
  }

  return { movedVolume, changedCells };
}

function getLateralCandidates(world: VoxelWorld, source: ColumnSpan): LateralCandidate[] {
  const sourceVolume = getSpanVolume(world, source);
  const sourceSurfaceY = getSurfaceY(source, sourceVolume);
  const candidates: LateralCandidate[] = [];

  if (sourceVolume <= EPSILON) {
    return candidates;
  }

  for (const direction of LATERAL_DIRECTIONS) {
    const targetX = source.x + direction.x;
    const targetZ = source.z + direction.z;
    for (const target of findOverlappingNeighborSpans(world, source, targetX, targetZ)) {
      const portalBottomY = Math.max(source.bottomY, target.bottomY);
      const portalTopY = Math.min(source.topY, target.topY);
      if (portalBottomY > portalTopY || sourceSurfaceY <= portalBottomY + EPSILON) {
        continue;
      }

      const targetVolume = getSpanVolume(world, target);
      candidates.push({
        direction,
        span: target,
        portalBottomY,
        portalTopY,
        targetHeadY: Math.max(getSurfaceY(target, targetVolume), portalBottomY),
      });
    }
  }

  return candidates.sort((a, b) => {
    const headDelta = a.targetHeadY - b.targetHeadY;
    if (Math.abs(headDelta) > EPSILON) {
      return headDelta;
    }

    const portalHeightDelta = b.portalTopY - b.portalBottomY - (a.portalTopY - a.portalBottomY);
    if (Math.abs(portalHeightDelta) > EPSILON) {
      return portalHeightDelta;
    }

    return compareDirections(a.direction, b.direction);
  });
}

function getLateralTransferAmount(
  source: ColumnSpan,
  sourceVolume: number,
  candidate: LateralCandidate,
  targetVolume: number,
  config: WaterSimulationConfig,
): number {
  const sourceSurfaceY = getSurfaceY(source, sourceVolume);
  const targetSurfaceY = getSurfaceY(candidate.span, targetVolume);
  const targetHeadY = Math.max(targetSurfaceY, candidate.portalBottomY);
  const headDelta = sourceSurfaceY - targetHeadY;
  if (headDelta <= config.minFlow) {
    return 0;
  }

  const maxTargetSurfaceY = Math.min(candidate.span.topY + 1, sourceSurfaceY);
  const targetCapacityBelowSource = Math.max(0, maxTargetSurfaceY - targetSurfaceY);
  if (targetCapacityBelowSource <= EPSILON) {
    return 0;
  }

  const portalHeight = candidate.portalTopY - candidate.portalBottomY + 1;
  const apertureRate = config.sideFlowRate * Math.min(2.4, 0.65 + portalHeight * 0.22);
  const transfer = Math.min(headDelta * 0.45, apertureRate, sourceVolume, targetCapacityBelowSource);
  if (transfer <= config.minFlow) {
    return 0;
  }

  if (sourceVolume - transfer <= EPSILON) {
    return sourceVolume;
  }

  if (targetCapacityBelowSource - transfer <= EPSILON) {
    return targetCapacityBelowSource;
  }

  return transfer;
}

function canSpanStillFlow(
  world: VoxelWorld,
  span: ColumnSpan,
  volume: number,
  config: WaterSimulationConfig,
): boolean {
  return getLateralCandidates(world, span).some((candidate) => {
    const targetVolume = getSpanVolume(world, candidate.span);
    return getLateralTransferAmount(span, volume, candidate, targetVolume, config) > config.minFlow;
  });
}

function findOverlappingNeighborSpans(
  world: VoxelWorld,
  source: ColumnSpan,
  targetX: number,
  targetZ: number,
): ColumnSpan[] {
  const spans: ColumnSpan[] = [];
  if (targetX < 0 || targetX >= world.width || targetZ < 0 || targetZ >= world.depth) {
    return spans;
  }

  let y = source.bottomY;
  while (y <= source.topY) {
    if (isSolid(world, targetX, y, targetZ)) {
      y += 1;
      continue;
    }

    const span = findOpenSpan(world, targetX, y, targetZ);
    if (!span) {
      y += 1;
      continue;
    }

    spans.push(span);
    y = span.topY + 1;
  }

  return spans;
}

function findOpenSpan(world: VoxelWorld, x: number, y: number, z: number): ColumnSpan | null {
  if (!inBounds(world, x, y, z) || isSolid(world, x, y, z)) {
    return null;
  }

  let bottomY = y;
  while (bottomY > 0 && !isSolid(world, x, bottomY - 1, z)) {
    bottomY -= 1;
  }

  let topY = y;
  while (topY + 1 < world.height && !isSolid(world, x, topY + 1, z)) {
    topY += 1;
  }

  return { x, z, bottomY, topY };
}

function getSpanKey(span: ColumnSpan): string {
  return `${span.x}:${span.z}:${span.bottomY}:${span.topY}`;
}

function getSpanCapacity(span: ColumnSpan): number {
  return span.topY - span.bottomY + 1;
}

function getSpanVolume(world: VoxelWorld, span: ColumnSpan): number {
  let volume = 0;
  for (let y = span.bottomY; y <= span.topY; y += 1) {
    volume += world.water[index(world, span.x, y, span.z)];
  }

  return Math.min(getSpanCapacity(span), Math.max(0, volume));
}

function getSpanAmounts(world: VoxelWorld, span: ColumnSpan): number[] {
  const amounts: number[] = [];
  for (let y = span.bottomY; y <= span.topY; y += 1) {
    amounts.push(world.water[index(world, span.x, y, span.z)]);
  }

  return amounts;
}

function getSpanSurfaceY(world: VoxelWorld, span: ColumnSpan): number {
  return getSurfaceY(span, getSpanVolume(world, span));
}

function getSurfaceY(span: ColumnSpan, volume: number): number {
  return span.bottomY + Math.min(getSpanCapacity(span), Math.max(0, volume));
}

function setSpanVolume(
  world: VoxelWorld,
  span: ColumnSpan,
  volume: number,
): { changedCells: number; redistributedVolume: number } {
  const clampedVolume = Math.min(getSpanCapacity(span), Math.max(0, volume));
  let remaining = clampedVolume;
  let changedCells = 0;
  let delta = 0;

  for (let y = span.bottomY; y <= span.topY; y += 1) {
    const cellIndex = index(world, span.x, y, span.z);
    const nextWater = remaining >= 1 ? 1 : remaining > 0 ? remaining : 0;
    const previousWater = world.water[cellIndex];
    if (Math.abs(previousWater - nextWater) > EPSILON) {
      delta += Math.abs(previousWater - nextWater);
      writeCellWater(world, cellIndex, nextWater);
      changedCells += 1;
    }
    remaining = Math.max(0, remaining - nextWater);
  }

  const correction = clampedVolume - getSpanVolume(world, span);
  if (Math.abs(correction) > VOLUME_CORRECTION_EPSILON) {
    const corrected = applySpanVolumeCorrection(world, span, correction);
    if (corrected > 0) {
      delta += corrected;
      changedCells += 1;
    }
  }

  return {
    changedCells,
    redistributedVolume: delta * 0.5,
  };
}

function writeSpanAmounts(
  world: VoxelWorld,
  span: ColumnSpan,
  amounts: number[],
  targetVolume: number,
): { changedCells: number } {
  let changedCells = 0;

  for (let y = span.bottomY; y <= span.topY; y += 1) {
    const cellIndex = index(world, span.x, y, span.z);
    const nextWater = amounts[y - span.bottomY] ?? 0;
    const previousWater = world.water[cellIndex];
    if (Math.abs(previousWater - nextWater) > EPSILON) {
      writeCellWater(world, cellIndex, nextWater);
      changedCells += 1;
    }
  }

  const correction = targetVolume - getSpanVolume(world, span);
  if (Math.abs(correction) > VOLUME_CORRECTION_EPSILON) {
    const corrected = applySpanVolumeCorrection(world, span, correction);
    if (corrected > 0) {
      changedCells += 1;
    }
  }

  return { changedCells };
}

function applySpanVolumeCorrection(world: VoxelWorld, span: ColumnSpan, correction: number): number {
  if (correction > 0) {
    for (let y = span.bottomY; y <= span.topY; y += 1) {
      const cellIndex = index(world, span.x, y, span.z);
      const previousWater = world.water[cellIndex];
      const room = 1 - previousWater;
      if (room <= 0) {
        continue;
      }

      const applied = Math.min(room, correction);
      writeCellWater(world, cellIndex, previousWater + applied);
      return applied;
    }
    return 0;
  }

  for (let y = span.topY; y >= span.bottomY; y -= 1) {
    const cellIndex = index(world, span.x, y, span.z);
    const previousWater = world.water[cellIndex];
    if (previousWater <= 0) {
      continue;
    }

    const applied = Math.min(previousWater, -correction);
    writeCellWater(world, cellIndex, previousWater - applied);
    return applied;
  }

  return 0;
}

function writeCellWater(world: VoxelWorld, cellIndex: number, amount: number): void {
  world.water[cellIndex] = world.solid[cellIndex] === 1 ? 0 : Math.min(1, Math.max(0, amount));
  refreshWetCell(world, cellIndex);
}

function markSpanActive(world: VoxelWorld, span: ColumnSpan, volume: number, target: Set<number>): void {
  if (volume <= EPSILON) {
    return;
  }

  const surfaceCellY = Math.min(span.topY, Math.max(span.bottomY, Math.floor(getSurfaceY(span, volume) - EPSILON)));
  wakeNeighbors(world, span.x, surfaceCellY, span.z, target);
  if (surfaceCellY > span.bottomY) {
    wakeNeighbors(world, span.x, surfaceCellY - 1, span.z, target);
  }
}

function getSpanSurfaceCellIndex(world: VoxelWorld, span: ColumnSpan, volume: number): number {
  const y = Math.min(span.topY, Math.max(span.bottomY, Math.floor(getSurfaceY(span, volume) - EPSILON)));
  return index(world, span.x, y, span.z);
}

function compareDirections(a: CellCoords, b: CellCoords): number {
  if (a.x !== b.x) {
    return b.x - a.x;
  }

  return b.z - a.z;
}
