import { coords, inBounds, index, isSolid, refreshWetCell, wakeNeighbors } from "../world/grid";
import {
  DOWN_FLOW_RATE,
  EPSILON,
  MIN_FLOW,
  SIDE_FLOW_RATE,
  type CellCoords,
  type VoxelWorld,
} from "../world/types";
import { stepSparseHydraulicSpanGraph } from "./spanHydraulicGraph";
import { recordSurfaceImpulse, stepWaterSurface } from "./waterSurface";

const LATERAL_DIRECTIONS: CellCoords[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const VOLUME_CORRECTION_EPSILON = 0.000_000_1;
const PIPE_FLUX_INERTIA = 0.52;
const PIPE_REVERSE_FLUX_INERTIA = 0.14;
const PIPE_FLUX_RATE_MULTIPLIER = 1.75;
const PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER = 3;
const PIPE_MOMENTUM_HEADROOM = 0.08;
const PIPE_MOMENTUM_HEADROOM_SCALE = 0.35;
const FLOW_VECTOR_DECAY = 0.68;
const FLOW_VECTOR_CLEAR_EPSILON = 0.000_1;
const FLOW_VECTOR_LIMIT = 2.5;

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

type FluxEdge = {
  key: string;
  sign: 1 | -1;
};

type LateralTransfer = {
  amount: number;
  flux: number;
};

type LateralTransferProposal = {
  candidate: LateralCandidate;
  targetVolume: number;
  transfer: LateralTransfer;
};

type MutableWaterStepDiagnostics = {
  spanKeys: Set<string>;
  edgeKeys: Set<string>;
  totalFluxMagnitude: number;
  maxHeadDelta: number;
  conservationCorrection: number;
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

export type WaterSolverMode = "legacy-span" | "sparse-hydraulic-graph";

export type WaterStepDiagnostics = {
  activeSpanCount: number;
  edgeCount: number;
  totalFluxMagnitude: number;
  maxHeadDelta: number;
  conservationCorrection: number;
};

export const EMPTY_WATER_STEP_DIAGNOSTICS: WaterStepDiagnostics = {
  activeSpanCount: 0,
  edgeCount: 0,
  totalFluxMagnitude: 0,
  maxHeadDelta: 0,
  conservationCorrection: 0,
};

export type WaterStepStats = {
  movedVolume: number;
  changedCells: number;
  flowChanged: boolean;
  surfaceChanged: boolean;
  flowEvents: FlowEvent[];
  diagnostics: WaterStepDiagnostics;
};

export type WaterStepOptions = {
  collectFlowEvents?: boolean;
  solver?: WaterSolverMode;
};

const EMPTY_FLOW_EVENTS: FlowEvent[] = [];

export function stepWaterSimulation(
  world: VoxelWorld,
  config: WaterSimulationConfig = DEFAULT_WATER_SIMULATION_CONFIG,
  options: WaterStepOptions = {},
): WaterStepStats {
  const collectFlowEvents = options.collectFlowEvents ?? true;
  if (options.solver === "sparse-hydraulic-graph") {
    const stats = stepSparseHydraulicSpanGraph(world, config, { collectFlowEvents });
    return {
      movedVolume: stats.movedVolume,
      changedCells: stats.changedCells,
      flowChanged: stats.flowChanged,
      surfaceChanged: stats.surfaceChanged,
      flowEvents: stats.flowEvents,
      diagnostics: {
        activeSpanCount: stats.activeSpanCount,
        edgeCount: stats.edgeCount,
        totalFluxMagnitude: stats.totalFluxMagnitude,
        maxHeadDelta: stats.maxHeadDelta,
        conservationCorrection: stats.conservationCorrection,
      },
    };
  }

  const currentCells = Array.from(world.activeCells).sort((a, b) => a - b);
  const nextActiveCells = new Set<number>();
  const activeSpans = new Map<string, ColumnSpan>();
  let movedVolume = 0;
  let changedCells = 0;
  const flowEvents: FlowEvent[] = collectFlowEvents ? [] : EMPTY_FLOW_EVENTS;
  const nextFlux = new Map<string, number>();
  const diagnostics: MutableWaterStepDiagnostics = {
    spanKeys: new Set(),
    edgeKeys: new Set(),
    totalFluxMagnitude: 0,
    maxHeadDelta: 0,
    conservationCorrection: 0,
  };

  let flowChanged = decayWaterFlow(world);
  let surfaceChanged = false;
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
    flowChanged = settled.flowChanged || flowChanged;
    surfaceChanged = settled.surfaceChanged || surfaceChanged;
    if (settled.changedCells > 0) {
      movedVolume += settled.movedVolume;
      changedCells += settled.changedCells;
      diagnostics.conservationCorrection += settled.conservationCorrection;
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
      diagnostics.spanKeys.add(key);
    }
  }

  const sortedSpans = Array.from(activeSpans.values()).sort((a, b) => getSpanSurfaceY(world, b) - getSpanSurfaceY(world, a));
  for (const span of sortedSpans) {
    const result = flowSpanLaterally(world, span, config, flowEvents, collectFlowEvents, nextActiveCells, nextFlux, diagnostics);
    movedVolume += result.movedVolume;
    changedCells += result.changedCells;
    flowChanged = result.flowChanged || flowChanged;
    surfaceChanged = result.surfaceChanged || surfaceChanged;
  }

  for (const span of sortedSpans) {
    const volume = getSpanVolume(world, span);
    if (volume > EPSILON && canSpanStillFlow(world, span, volume, config)) {
      markSpanActive(world, span, volume, nextActiveCells);
    }
  }

  world.activeCells = nextActiveCells;
  world.waterFlux = nextFlux;
  const surfaceStep = stepWaterSurface(world);
  surfaceChanged = surfaceStep.changed || surfaceChanged;

  return {
    movedVolume,
    changedCells,
    flowChanged,
    surfaceChanged,
    flowEvents,
    diagnostics: {
      activeSpanCount: diagnostics.spanKeys.size,
      edgeCount: diagnostics.edgeKeys.size,
      totalFluxMagnitude: diagnostics.totalFluxMagnitude,
      maxHeadDelta: diagnostics.maxHeadDelta,
      conservationCorrection: diagnostics.conservationCorrection,
    },
  };
}

function settleSpan(
  world: VoxelWorld,
  span: ColumnSpan,
  config: WaterSimulationConfig,
): {
  volume: number;
  movedVolume: number;
  changedCells: number;
  conservationCorrection: number;
  flowChanged: boolean;
  surfaceChanged: boolean;
} {
  const volume = getSpanVolume(world, span);
  const fallRate = Math.max(0, config.downFlowRate);
  if (fallRate <= config.minFlow || volume <= EPSILON) {
    return {
      volume,
      movedVolume: 0,
      changedCells: 0,
      conservationCorrection: 0,
      flowChanged: false,
      surfaceChanged: false,
    };
  }

  const amounts = getSpanAmounts(world, span);
  let movedVolume = 0;
  let flowChanged = false;
  let surfaceChanged = false;

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
    const surfaceCellIndex = getSpanSurfaceCellIndex(world, span, volume);
    flowChanged = recordWaterFlow(world, index(world, span.x, span.bottomY + offset, span.z), 0, -1, 0, transfer) || flowChanged;
    flowChanged =
      recordWaterFlow(world, index(world, span.x, span.bottomY + offset + 1, span.z), 0, -1, 0, transfer) ||
      flowChanged;
    surfaceChanged = recordSurfaceImpulse(world, surfaceCellIndex, transfer, 0, -1, 0) || surfaceChanged;
  }

  const result = writeSpanAmounts(world, span, amounts, volume);
  return {
    volume,
    movedVolume,
    changedCells: result.changedCells,
    conservationCorrection: result.conservationCorrection,
    flowChanged,
    surfaceChanged,
  };
}

function flowSpanLaterally(
  world: VoxelWorld,
  span: ColumnSpan,
  config: WaterSimulationConfig,
  flowEvents: FlowEvent[],
  collectFlowEvents: boolean,
  nextActiveCells: Set<number>,
  nextFlux: Map<string, number>,
  diagnostics: MutableWaterStepDiagnostics,
): { movedVolume: number; changedCells: number; flowChanged: boolean; surfaceChanged: boolean } {
  let movedVolume = 0;
  let changedCells = 0;
  let flowChanged = false;
  let surfaceChanged = false;
  const sourceVolume = getSpanVolume(world, span);
  if (sourceVolume <= EPSILON) {
    return { movedVolume, changedCells, flowChanged, surfaceChanged };
  }

  const proposals: LateralTransferProposal[] = [];
  for (const candidate of getLateralCandidates(world, span)) {
    const sourceSurfaceY = getSurfaceY(span, sourceVolume);
    diagnostics.spanKeys.add(getSpanKey(span));
    diagnostics.spanKeys.add(getSpanKey(candidate.span));
    diagnostics.edgeKeys.add(getFluxEdge(span, candidate.span).key);
    diagnostics.maxHeadDelta = Math.max(diagnostics.maxHeadDelta, Math.abs(sourceSurfaceY - candidate.targetHeadY));
    const targetVolume = getSpanVolume(world, candidate.span);
    const transfer = getLateralTransfer(world, span, sourceVolume, candidate, targetVolume, config);
    if (transfer.amount <= config.minFlow) {
      continue;
    }

    proposals.push({ candidate, targetVolume, transfer });
  }

  if (proposals.length === 0) {
    return { movedVolume, changedCells, flowChanged, surfaceChanged };
  }

  const desiredOutflow = proposals.reduce((total, proposal) => total + proposal.transfer.amount, 0);
  const outflowScale = desiredOutflow > sourceVolume ? sourceVolume / desiredOutflow : 1;
  const sourceSurfaceCellIndex = getSpanSurfaceCellIndex(world, span, sourceVolume);
  const appliedTransfers: LateralTransferProposal[] = [];

  for (const proposal of proposals) {
    const amount = proposal.transfer.amount * outflowScale;
    if (amount <= config.minFlow) {
      continue;
    }

    appliedTransfers.push({
      ...proposal,
      transfer: {
        amount,
        flux: proposal.transfer.flux * outflowScale,
      },
    });
    movedVolume += amount;
  }

  if (movedVolume <= config.minFlow) {
    return { movedVolume: 0, changedCells, flowChanged, surfaceChanged };
  }

  const sourceResult = setSpanVolume(world, span, sourceVolume - movedVolume);
  changedCells += sourceResult.changedCells;
  diagnostics.conservationCorrection += sourceResult.conservationCorrection;
  markSpanActive(world, span, sourceVolume - movedVolume, nextActiveCells);

  for (const proposal of appliedTransfers) {
    const { candidate, targetVolume, transfer } = proposal;
    const targetResult = setSpanVolume(world, candidate.span, targetVolume + transfer.amount);
    const targetSurfaceCellIndex = getSpanSurfaceCellIndex(world, candidate.span, targetVolume + transfer.amount);
    changedCells += targetResult.changedCells;
    diagnostics.conservationCorrection += targetResult.conservationCorrection;
    diagnostics.totalFluxMagnitude += transfer.amount;

    markSpanActive(world, candidate.span, targetVolume + transfer.amount, nextActiveCells);
    setSignedPipeFlux(nextFlux, span, candidate.span, transfer.flux, config.minFlow);

    const targetCellIndex = index(world, candidate.span.x, candidate.portalBottomY, candidate.span.z);
    flowChanged =
      recordWaterFlow(
        world,
        sourceSurfaceCellIndex,
        candidate.direction.x,
        0,
        candidate.direction.z,
        transfer.amount,
      ) || flowChanged;
    flowChanged =
      recordWaterFlow(world, targetCellIndex, candidate.direction.x, 0, candidate.direction.z, transfer.amount) ||
      flowChanged;
    surfaceChanged =
      recordSurfaceImpulse(
        world,
        sourceSurfaceCellIndex,
        transfer.amount,
        candidate.direction.x,
        0,
        candidate.direction.z,
      ) || surfaceChanged;
    surfaceChanged =
      recordSurfaceImpulse(
        world,
        targetSurfaceCellIndex,
        transfer.amount,
        candidate.direction.x,
        0,
        candidate.direction.z,
      ) || surfaceChanged;

    if (collectFlowEvents) {
      flowEvents.push({
        fromCellIndex: sourceSurfaceCellIndex,
        cellIndex: targetCellIndex,
        direction: "side",
        dx: candidate.direction.x,
        dy: 0,
        dz: candidate.direction.z,
        amount: transfer.amount,
      });
    }
  }

  return { movedVolume, changedCells, flowChanged, surfaceChanged };
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

function getLateralTransfer(
  world: VoxelWorld,
  source: ColumnSpan,
  sourceVolume: number,
  candidate: LateralCandidate,
  targetVolume: number,
  config: WaterSimulationConfig,
): LateralTransfer {
  const sourceSurfaceY = getSurfaceY(source, sourceVolume);
  const targetSurfaceY = getSurfaceY(candidate.span, targetVolume);
  const targetHeadY = Math.max(targetSurfaceY, candidate.portalBottomY);
  const headDelta = sourceSurfaceY - targetHeadY;
  const signedPreviousFlux = getSignedPipeFlux(world, source, candidate.span);
  const forwardMomentum = Math.max(0, signedPreviousFlux);
  const canUseForwardMomentum = forwardMomentum > config.minFlow && headDelta > 0;
  const canUseAdverseMomentum =
    forwardMomentum > config.minFlow && headDelta < 0 && headDelta >= -config.minFlow * PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER;
  if (headDelta <= config.minFlow && !canUseAdverseMomentum) {
    return { amount: 0, flux: 0 };
  }

  const momentumHeadroom = canUseAdverseMomentum
    ? Math.min(PIPE_MOMENTUM_HEADROOM, forwardMomentum * PIPE_MOMENTUM_HEADROOM_SCALE)
    : 0;
  const maxTargetSurfaceY = Math.min(candidate.span.topY + 1, sourceSurfaceY + momentumHeadroom);
  const targetCapacityBelowSource = Math.max(0, maxTargetSurfaceY - targetSurfaceY);
  if (targetCapacityBelowSource <= EPSILON) {
    return { amount: 0, flux: 0 };
  }

  const portalHeight = candidate.portalTopY - candidate.portalBottomY + 1;
  const apertureRate = config.sideFlowRate * Math.min(2.4, 0.65 + portalHeight * 0.22);
  const pressureTransfer = getPressureLateralTransferAmount(
    source,
    sourceVolume,
    candidate,
    targetVolume,
    config,
    sourceSurfaceY,
    targetSurfaceY,
    headDelta,
    targetCapacityBelowSource,
    apertureRate,
  );
  const inertialTransfer = Math.max(
    0,
    pressureTransfer +
      (canUseForwardMomentum || canUseAdverseMomentum
        ? forwardMomentum * (headDelta >= 0 ? PIPE_FLUX_INERTIA : PIPE_REVERSE_FLUX_INERTIA)
        : 0),
  );
  const transfer = Math.min(
    inertialTransfer,
    apertureRate * PIPE_FLUX_RATE_MULTIPLIER,
    sourceVolume,
    targetCapacityBelowSource,
  );
  if (transfer <= config.minFlow) {
    return { amount: 0, flux: 0 };
  }

  if (sourceVolume - transfer <= EPSILON) {
    return { amount: sourceVolume, flux: sourceVolume };
  }

  if (targetCapacityBelowSource - transfer <= EPSILON) {
    return { amount: targetCapacityBelowSource, flux: targetCapacityBelowSource };
  }

  return { amount: transfer, flux: transfer };
}

function getPressureLateralTransferAmount(
  source: ColumnSpan,
  sourceVolume: number,
  candidate: LateralCandidate,
  targetVolume: number,
  config: WaterSimulationConfig,
  sourceSurfaceY = getSurfaceY(source, sourceVolume),
  targetSurfaceY = getSurfaceY(candidate.span, targetVolume),
  headDelta = sourceSurfaceY - Math.max(targetSurfaceY, candidate.portalBottomY),
  targetCapacityBelowSource = Math.max(0, Math.min(candidate.span.topY + 1, sourceSurfaceY) - targetSurfaceY),
  apertureRate = config.sideFlowRate * Math.min(2.4, 0.65 + (candidate.portalTopY - candidate.portalBottomY + 1) * 0.22),
): number {
  if (headDelta <= config.minFlow || targetCapacityBelowSource <= EPSILON) {
    return 0;
  }

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
  if (volume <= EPSILON) {
    return false;
  }

  const pressureTransfers = getLateralCandidates(world, span).map((candidate) => {
    const targetVolume = getSpanVolume(world, candidate.span);
    return getPressureLateralTransferAmount(span, volume, candidate, targetVolume, config);
  });
  const desiredOutflow = pressureTransfers.reduce((total, transfer) => total + transfer, 0);
  if (desiredOutflow <= config.minFlow) {
    return false;
  }

  const outflowScale = desiredOutflow > volume ? volume / desiredOutflow : 1;
  return pressureTransfers.some((transfer) => transfer * outflowScale > config.minFlow);
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

function getFluxEdge(a: ColumnSpan, b: ColumnSpan): FluxEdge {
  const aKey = getSpanKey(a);
  const bKey = getSpanKey(b);
  return aKey <= bKey ? { key: `${aKey}|${bKey}`, sign: 1 } : { key: `${bKey}|${aKey}`, sign: -1 };
}

function getSignedPipeFlux(world: VoxelWorld, source: ColumnSpan, target: ColumnSpan): number {
  const edge = getFluxEdge(source, target);
  return (world.waterFlux.get(edge.key) ?? 0) * edge.sign;
}

function setSignedPipeFlux(
  target: Map<string, number>,
  source: ColumnSpan,
  destination: ColumnSpan,
  sourceToDestinationFlux: number,
  minFlow: number,
): void {
  if (sourceToDestinationFlux <= minFlow) {
    return;
  }

  const edge = getFluxEdge(source, destination);
  target.set(edge.key, sourceToDestinationFlux * edge.sign);
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
): { changedCells: number; redistributedVolume: number; conservationCorrection: number } {
  const clampedVolume = Math.min(getSpanCapacity(span), Math.max(0, volume));
  let remaining = clampedVolume;
  let changedCells = 0;
  let delta = 0;
  let conservationCorrection = 0;

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
      conservationCorrection += corrected;
      changedCells += 1;
    }
  }

  return {
    changedCells,
    redistributedVolume: delta * 0.5,
    conservationCorrection,
  };
}

function writeSpanAmounts(
  world: VoxelWorld,
  span: ColumnSpan,
  amounts: number[],
  targetVolume: number,
): { changedCells: number; conservationCorrection: number } {
  let changedCells = 0;
  let conservationCorrection = 0;

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
      conservationCorrection += corrected;
      changedCells += 1;
    }
  }

  return { changedCells, conservationCorrection };
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

function decayWaterFlow(world: VoxelWorld): boolean {
  if (world.activeFlowCells.size === 0) {
    return false;
  }

  const nextActiveFlowCells = new Set<number>();
  let changed = false;
  for (const cellIndex of world.activeFlowCells) {
    const offset = cellIndex * 3;
    let cellStillActive = false;

    for (let axisOffset = 0; axisOffset < 3; axisOffset += 1) {
      const flowOffset = offset + axisOffset;
      const previousFlow = world.waterFlow[flowOffset];
      const nextFlow = previousFlow * FLOW_VECTOR_DECAY;
      const settledFlow = Math.abs(nextFlow) <= FLOW_VECTOR_CLEAR_EPSILON ? 0 : nextFlow;
      if (previousFlow !== settledFlow) {
        changed = true;
        world.waterFlow[flowOffset] = settledFlow;
      }
      if (settledFlow !== 0) {
        cellStillActive = true;
      }
    }

    if (cellStillActive) {
      nextActiveFlowCells.add(cellIndex);
    }
  }

  world.activeFlowCells = nextActiveFlowCells;
  return changed;
}

function recordWaterFlow(world: VoxelWorld, cellIndex: number, dx: number, dy: number, dz: number, amount: number): boolean {
  if (amount <= EPSILON || world.solid[cellIndex] === 1) {
    return false;
  }

  const offset = cellIndex * 3;
  const nextX = clampFlowVector(world.waterFlow[offset] + dx * amount);
  const nextY = clampFlowVector(world.waterFlow[offset + 1] + dy * amount);
  const nextZ = clampFlowVector(world.waterFlow[offset + 2] + dz * amount);
  const changed =
    world.waterFlow[offset] !== nextX || world.waterFlow[offset + 1] !== nextY || world.waterFlow[offset + 2] !== nextZ;
  world.waterFlow[offset] = nextX;
  world.waterFlow[offset + 1] = nextY;
  world.waterFlow[offset + 2] = nextZ;
  if (nextX !== 0 || nextY !== 0 || nextZ !== 0) {
    world.activeFlowCells.add(cellIndex);
  } else {
    world.activeFlowCells.delete(cellIndex);
  }
  return changed;
}

function clampFlowVector(value: number): number {
  return Math.min(FLOW_VECTOR_LIMIT, Math.max(-FLOW_VECTOR_LIMIT, value));
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
