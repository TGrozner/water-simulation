import { coords, inBounds, index, isSolid, setCellWater, totalWater, wakeNeighbors } from "../world/grid";
import { EPSILON, type CellCoords, type HydraulicSpanEdgeEventKind, type VoxelWorld } from "../world/types";
import { recordSurfaceImpulse, stepWaterSurface } from "./waterSurface";
import type { FlowEvent, WaterSimulationConfig } from "./waterSimulation";

const LATERAL_DIRECTIONS: CellCoords[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];
const VOLUME_CORRECTION_EPSILON = 0.000_000_1;
const FLOW_VECTOR_DECAY = 0.68;
const FLOW_VECTOR_CLEAR_EPSILON = 0.000_1;
const FLOW_VECTOR_LIMIT = 2.5;
const PIPE_FLUX_INERTIA = 0.52;
const PIPE_REVERSE_FLUX_INERTIA = 0.14;
const PIPE_FLUX_RATE_MULTIPLIER = 1.75;
const PIPE_MOMENTUM_HEADROOM = 0.08;
const PIPE_MOMENTUM_HEADROOM_SCALE = 0.35;
const PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER = 3;
const EMPTY_FLOW_EVENTS: FlowEvent[] = [];
const MAX_HYDRAULIC_EDGE_EVENTS = 2048;

export type HydraulicSpan = {
  id: number;
  key: string;
  x: number;
  z: number;
  bottomY: number;
  topY: number;
  volume: number;
  capacity: number;
  surfaceY: number;
};

export type HydraulicEdge = {
  id: number;
  key: string;
  a: number;
  b: number;
  dx: number;
  dz: number;
  portalBottomY: number;
  portalTopY: number;
  aperture: number;
  headDelta: number;
  previousFlux: number;
};

export type HydraulicSpanGraph = {
  spans: HydraulicSpan[];
  edges: HydraulicEdge[];
};

export type HydraulicSpanGraphStats = {
  activeSpanCount: number;
  edgeCount: number;
  totalFluxMagnitude: number;
  maxHeadDelta: number;
  conservationCorrection: number;
};

export type HydraulicStepStats = HydraulicSpanGraphStats & {
  movedVolume: number;
  changedCells: number;
  flowChanged: boolean;
  surfaceChanged: boolean;
  flowEvents: FlowEvent[];
};

export type HydraulicStepOptions = {
  collectFlowEvents?: boolean;
};

type ColumnSpan = {
  x: number;
  z: number;
  bottomY: number;
  topY: number;
};

type EdgeProposal = {
  edge: HydraulicEdge;
  sourceId: number;
  targetId: number;
  amount: number;
  signedFlux: number;
  targetCapacity: number;
};

type AppliedTransfer = EdgeProposal & {
  appliedAmount: number;
};

export function buildSparseHydraulicSpanGraph(world: VoxelWorld): HydraulicSpanGraph {
  const spanMap = new Map<string, ColumnSpan>();
  const sourceKeys = new Set<string>();
  const sortedActiveCells = Array.from(world.activeCells).sort((a, b) => a - b);

  for (const cellIndex of sortedActiveCells) {
    if (world.solid[cellIndex] === 1) {
      continue;
    }

    const cell = coords(world, cellIndex);
    const span = findOpenSpan(world, cell.x, cell.y, cell.z);
    if (!span) {
      continue;
    }

    const key = getSpanKey(span);
    spanMap.set(key, span);
    sourceKeys.add(key);
  }

  for (const key of Array.from(sourceKeys).sort()) {
    const span = spanMap.get(key);
    if (!span) {
      continue;
    }

    for (const direction of LATERAL_DIRECTIONS) {
      for (const neighbor of findOverlappingNeighborSpans(world, span, span.x + direction.x, span.z + direction.z)) {
        spanMap.set(getSpanKey(neighbor), neighbor);
      }
    }
  }

  const spans = Array.from(spanMap.values())
    .sort(compareSpans)
    .map((span, id) => createHydraulicSpan(world, span, id));
  const spanIds = new Map(spans.map((span) => [span.key, span.id]));
  const edges = buildHydraulicEdges(world, spans, spanIds);

  return { spans, edges };
}

export function stepSparseHydraulicSpanGraph(
  world: VoxelWorld,
  config: WaterSimulationConfig,
  options: HydraulicStepOptions = {},
): HydraulicStepStats {
  world.waterEdgeEvents.length = 0;
  const baselineWater = totalWater(world);
  let graph = buildSparseHydraulicSpanGraph(world);
  let movedVolume = 0;
  let changedCells = 0;
  let conservationCorrection = 0;
  let flowChanged = decayWaterFlow(world);
  let surfaceChanged = false;
  const collectFlowEvents = options.collectFlowEvents ?? false;
  const flowEvents: FlowEvent[] = collectFlowEvents ? [] : EMPTY_FLOW_EVENTS;
  const nextActiveCells = new Set<number>();

  world.activeCells.clear();

  for (const span of graph.spans) {
    const settled = settleHydraulicSpan(world, span, config, flowEvents, collectFlowEvents);
    movedVolume += settled.movedVolume;
    changedCells += settled.changedCells;
    conservationCorrection += settled.conservationCorrection;
    flowChanged = settled.flowChanged || flowChanged;
    surfaceChanged = settled.surfaceChanged || surfaceChanged;
    if (settled.changedCells > 0 || settled.volume > EPSILON) {
      markSpanActive(world, span, settled.volume, nextActiveCells);
    }
  }

  graph = buildSparseHydraulicSpanGraphFromSeeds(world, graph.spans, nextActiveCells);
  const proposals = computeEdgeProposals(world, graph, config);
  const appliedTransfers = scaleEdgeProposals(graph, proposals, config);
  const nextFlux = new Map<string, number>();
  const spanVolumes = graph.spans.map((span) => span.volume);

  for (const transfer of appliedTransfers) {
    const amount = transfer.appliedAmount;
    if (amount <= config.minFlow) {
      continue;
    }

    spanVolumes[transfer.sourceId] -= amount;
    spanVolumes[transfer.targetId] += amount;
    movedVolume += amount;
  }

  for (let spanId = 0; spanId < graph.spans.length; spanId += 1) {
    const span = graph.spans[spanId];
    const targetVolume = spanVolumes[spanId];
    if (Math.abs(targetVolume - span.volume) <= EPSILON) {
      continue;
    }

    const result = setHydraulicSpanVolume(world, span, targetVolume);
    changedCells += result.changedCells;
    conservationCorrection += result.conservationCorrection;
    markSpanActive(world, span, targetVolume, nextActiveCells);
  }

  for (const transfer of appliedTransfers) {
    const amount = transfer.appliedAmount;
    if (amount <= config.minFlow) {
      continue;
    }

    setSignedFlux(nextFlux, transfer.edge, transfer.signedFlux * (amount / transfer.amount), config.minFlow);
    flowChanged = recordTransferFlow(world, graph, transfer, amount) || flowChanged;
    surfaceChanged = recordTransferSurfaceImpulse(world, graph, transfer, amount) || surfaceChanged;
    recordHydraulicEdgeEvent(world, graph, transfer, amount);
    if (collectFlowEvents) {
      const source = graph.spans[transfer.sourceId];
      const target = graph.spans[transfer.targetId];
      flowEvents.push({
        fromCellIndex: getSpanSurfaceCellIndex(world, source, source.volume),
        cellIndex: index(world, target.x, transfer.edge.portalBottomY, target.z),
        direction: "side",
        dx: Math.sign(target.x - source.x),
        dy: 0,
        dz: Math.sign(target.z - source.z),
        amount,
      });
    }
  }

  for (let spanId = 0; spanId < graph.spans.length; spanId += 1) {
    const volume = getSpanVolumeByHydraulicSpan(world, graph.spans[spanId]);
    if (volume > EPSILON && canHydraulicSpanStillFlow(graph, spanId, spanVolumes, config)) {
      markSpanActive(world, graph.spans[spanId], volume, nextActiveCells);
    }
  }

  world.activeCells = nextActiveCells;
  world.waterFlux = nextFlux;
  const surfaceStep = stepWaterSurface(world);
  surfaceChanged = surfaceStep.changed || surfaceChanged;

  const globalCorrection = baselineWater - totalWater(world);
  if (Math.abs(globalCorrection) > VOLUME_CORRECTION_EPSILON) {
    conservationCorrection += applyGraphVolumeCorrection(world, graph.spans, globalCorrection);
  }

  const diagnostics = summarizeGraph(graph, appliedTransfers, conservationCorrection);
  return {
    ...diagnostics,
    movedVolume,
    changedCells,
    flowChanged,
    surfaceChanged,
    flowEvents,
  };
}

function buildSparseHydraulicSpanGraphFromSeeds(
  world: VoxelWorld,
  spans: HydraulicSpan[],
  nextActiveCells: Set<number>,
): HydraulicSpanGraph {
  for (const span of spans) {
    if (span.volume > EPSILON) {
      markSpanActive(world, span, span.volume, nextActiveCells);
    }
  }

  const savedActiveCells = world.activeCells;
  world.activeCells = nextActiveCells;
  const graph = buildSparseHydraulicSpanGraph(world);
  world.activeCells = savedActiveCells;
  return graph;
}

function buildHydraulicEdges(world: VoxelWorld, spans: HydraulicSpan[], spanIds: Map<string, number>): HydraulicEdge[] {
  const edges = new Map<string, HydraulicEdge>();

  for (const source of spans) {
    for (const direction of LATERAL_DIRECTIONS) {
      for (const target of findOverlappingNeighborSpans(world, source, source.x + direction.x, source.z + direction.z)) {
        const targetId = spanIds.get(getSpanKey(target));
        if (targetId === undefined || targetId === source.id) {
          continue;
        }

        const targetSpan = spans[targetId];
        const portalBottomY = Math.max(source.bottomY, targetSpan.bottomY);
        const portalTopY = Math.min(source.topY, targetSpan.topY);
        if (portalBottomY > portalTopY) {
          continue;
        }

        const key = getEdgeKey(source, targetSpan);
        if (edges.has(key)) {
          continue;
        }

        const [a, b] = source.key <= targetSpan.key ? [source, targetSpan] : [targetSpan, source];
        const headDelta = getEdgeHeadDelta(a, b, portalBottomY);
        edges.set(key, {
          id: edges.size,
          key,
          a: a.id,
          b: b.id,
          dx: b.x - a.x,
          dz: b.z - a.z,
          portalBottomY,
          portalTopY,
          aperture: portalTopY - portalBottomY + 1,
          headDelta,
          previousFlux: getSignedStoredFlux(world, a.key, b.key),
        });
      }
    }
  }

  return Array.from(edges.values()).sort((a, b) => a.key.localeCompare(b.key)).map((edge, id) => ({ ...edge, id }));
}

function computeEdgeProposals(
  world: VoxelWorld,
  graph: HydraulicSpanGraph,
  config: WaterSimulationConfig,
): EdgeProposal[] {
  const proposals: EdgeProposal[] = [];

  for (const edge of graph.edges) {
    const a = graph.spans[edge.a];
    const b = graph.spans[edge.b];
    const headDelta = getEdgeHeadDelta(a, b, edge.portalBottomY);
    const signedPreviousFlux = getSignedStoredFlux(world, a.key, b.key);
    const adverseFromA =
      signedPreviousFlux > config.minFlow &&
      headDelta < -config.minFlow &&
      headDelta >= -config.minFlow * PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER;
    const adverseFromB =
      signedPreviousFlux < -config.minFlow &&
      headDelta > config.minFlow &&
      headDelta <= config.minFlow * PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER;
    let proposal: EdgeProposal | null;
    if (adverseFromA) {
      proposal = createEdgeProposal(edge, a, b, headDelta, signedPreviousFlux, config);
    } else if (adverseFromB) {
      proposal = createEdgeProposal(edge, b, a, -headDelta, -signedPreviousFlux, config);
    } else if (headDelta >= 0) {
      proposal = createEdgeProposal(edge, a, b, headDelta, signedPreviousFlux, config);
    } else {
      proposal = createEdgeProposal(edge, b, a, -headDelta, -signedPreviousFlux, config);
    }
    if (proposal) {
      proposals.push(proposal);
    }
  }

  return proposals;
}

function createEdgeProposal(
  edge: HydraulicEdge,
  source: HydraulicSpan,
  target: HydraulicSpan,
  headDelta: number,
  signedPreviousFlux: number,
  config: WaterSimulationConfig,
): EdgeProposal | null {
  const forwardMomentum = Math.max(0, signedPreviousFlux);
  const canUseForwardMomentum = forwardMomentum > config.minFlow && headDelta > 0;
  const canUseAdverseMomentum =
    forwardMomentum > config.minFlow &&
    headDelta < 0 &&
    headDelta >= -config.minFlow * PIPE_MOMENTUM_MAX_ADVERSE_HEAD_MULTIPLIER;
  if (headDelta <= config.minFlow && !canUseAdverseMomentum) {
    return null;
  }

  const momentumHeadroom = canUseAdverseMomentum
    ? Math.min(PIPE_MOMENTUM_HEADROOM, forwardMomentum * PIPE_MOMENTUM_HEADROOM_SCALE)
    : 0;
  const maxTargetSurfaceY = Math.min(target.topY + 1, source.surfaceY + momentumHeadroom);
  const targetCapacity = Math.max(0, Math.min(target.capacity - target.volume, maxTargetSurfaceY - target.surfaceY));
  if (source.volume <= EPSILON || targetCapacity <= EPSILON) {
    return null;
  }

  const apertureRate = config.sideFlowRate * Math.min(2.4, 0.65 + edge.aperture * 0.22);
  const pressureTransfer = Math.min(headDelta * 0.45, apertureRate, source.volume, targetCapacity);
  const inertialTransfer = Math.max(
    0,
    pressureTransfer +
      (canUseForwardMomentum || canUseAdverseMomentum
        ? forwardMomentum * (headDelta >= 0 ? PIPE_FLUX_INERTIA : PIPE_REVERSE_FLUX_INERTIA)
        : 0),
  );
  const amount = Math.min(inertialTransfer, apertureRate * PIPE_FLUX_RATE_MULTIPLIER, source.volume, targetCapacity);
  if (amount <= config.minFlow) {
    return null;
  }

  const signedFlux = source.id === edge.a ? amount : -amount;
  return {
    edge,
    sourceId: source.id,
    targetId: target.id,
    amount,
    signedFlux,
    targetCapacity,
  };
}

function scaleEdgeProposals(
  graph: HydraulicSpanGraph,
  proposals: EdgeProposal[],
  config: WaterSimulationConfig,
): AppliedTransfer[] {
  const sourceOutflow = new Map<number, number>();
  const targetInflow = new Map<number, number>();
  const targetCapacity = new Map<number, number>();

  for (const proposal of proposals) {
    sourceOutflow.set(proposal.sourceId, (sourceOutflow.get(proposal.sourceId) ?? 0) + proposal.amount);
    targetInflow.set(proposal.targetId, (targetInflow.get(proposal.targetId) ?? 0) + proposal.amount);
    targetCapacity.set(
      proposal.targetId,
      Math.min(targetCapacity.get(proposal.targetId) ?? Number.POSITIVE_INFINITY, proposal.targetCapacity),
    );
  }

  const applied: AppliedTransfer[] = [];
  for (const proposal of proposals) {
    const source = graph.spans[proposal.sourceId];
    const sourceScale = Math.min(1, source.volume / Math.max(proposal.amount, sourceOutflow.get(proposal.sourceId) ?? proposal.amount));
    const capacity = targetCapacity.get(proposal.targetId) ?? proposal.targetCapacity;
    const targetScale = Math.min(1, capacity / Math.max(proposal.amount, targetInflow.get(proposal.targetId) ?? proposal.amount));
    const appliedAmount = proposal.amount * Math.min(sourceScale, targetScale);
    if (appliedAmount > config.minFlow) {
      applied.push({ ...proposal, appliedAmount });
    }
  }

  return applied;
}

function settleHydraulicSpan(
  world: VoxelWorld,
  span: HydraulicSpan,
  config: WaterSimulationConfig,
  flowEvents: FlowEvent[],
  collectFlowEvents: boolean,
): {
  volume: number;
  movedVolume: number;
  changedCells: number;
  conservationCorrection: number;
  flowChanged: boolean;
  surfaceChanged: boolean;
} {
  const volume = getSpanVolumeByHydraulicSpan(world, span);
  const fallRate = Math.max(0, config.downFlowRate);
  if (fallRate <= config.minFlow || volume <= EPSILON) {
    return { volume, movedVolume: 0, changedCells: 0, conservationCorrection: 0, flowChanged: false, surfaceChanged: false };
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
    const lowerCellIndex = index(world, span.x, span.bottomY + offset, span.z);
    const upperCellIndex = index(world, span.x, span.bottomY + offset + 1, span.z);
    flowChanged = recordWaterFlow(world, lowerCellIndex, 0, -1, 0, transfer) || flowChanged;
    flowChanged = recordWaterFlow(world, upperCellIndex, 0, -1, 0, transfer) || flowChanged;
    surfaceChanged = recordSurfaceImpulse(world, getSpanSurfaceCellIndex(world, span, volume), transfer, 0, -1, 0) || surfaceChanged;
    recordHydraulicFallEvent(world, span, upperCellIndex, lowerCellIndex, lowerAmount, transfer, offset);
    if (collectFlowEvents) {
      flowEvents.push({
        fromCellIndex: upperCellIndex,
        cellIndex: lowerCellIndex,
        direction: "down",
        dx: 0,
        dy: -1,
        dz: 0,
        amount: transfer,
      });
    }
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

function createHydraulicSpan(world: VoxelWorld, span: ColumnSpan, id: number): HydraulicSpan {
  const capacity = getSpanCapacity(span);
  const volume = getSpanVolume(world, span);
  return {
    id,
    key: getSpanKey(span),
    ...span,
    volume,
    capacity,
    surfaceY: getSurfaceY(span, volume),
  };
}

function canHydraulicSpanStillFlow(
  graph: HydraulicSpanGraph,
  spanId: number,
  spanVolumes: number[],
  config: WaterSimulationConfig,
): boolean {
  const span = graph.spans[spanId];
  const volume = spanVolumes[spanId] ?? 0;
  if (volume <= EPSILON) {
    return false;
  }

  const surfaceY = getSurfaceY(span, volume);
  return graph.edges.some((edge) => {
    if (edge.a !== spanId && edge.b !== spanId) {
      return false;
    }
    const target = graph.spans[edge.a === spanId ? edge.b : edge.a];
    const targetVolume = spanVolumes[target.id] ?? target.volume;
    const targetSurfaceY = Math.max(getSurfaceY(target, targetVolume), edge.portalBottomY);
    return surfaceY - targetSurfaceY > config.minFlow;
  });
}

function summarizeGraph(
  graph: HydraulicSpanGraph,
  appliedTransfers: AppliedTransfer[],
  conservationCorrection: number,
): HydraulicSpanGraphStats {
  return {
    activeSpanCount: graph.spans.length,
    edgeCount: graph.edges.length,
    totalFluxMagnitude: appliedTransfers.reduce((total, transfer) => total + Math.abs(transfer.appliedAmount), 0),
    maxHeadDelta: graph.edges.reduce((max, edge) => Math.max(max, Math.abs(edge.headDelta)), 0),
    conservationCorrection,
  };
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

function getEdgeKey(a: HydraulicSpan, b: HydraulicSpan): string {
  return a.key <= b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
}

function getStoredFluxKey(aKey: string, bKey: string): { key: string; sign: 1 | -1 } {
  return aKey <= bKey ? { key: `${aKey}|${bKey}`, sign: 1 } : { key: `${bKey}|${aKey}`, sign: -1 };
}

function getSignedStoredFlux(world: VoxelWorld, aKey: string, bKey: string): number {
  const edge = getStoredFluxKey(aKey, bKey);
  return (world.waterFlux.get(edge.key) ?? 0) * edge.sign;
}

function setSignedFlux(target: Map<string, number>, edge: HydraulicEdge, signedFlux: number, minFlow: number): void {
  if (Math.abs(signedFlux) <= minFlow) {
    return;
  }

  const a = edge.key.split("|")[0];
  const b = edge.key.split("|")[1];
  const stored = getStoredFluxKey(a, b);
  target.set(stored.key, signedFlux * stored.sign);
}

function getEdgeHeadDelta(a: HydraulicSpan, b: HydraulicSpan, portalBottomY: number): number {
  return Math.max(a.surfaceY, portalBottomY) - Math.max(b.surfaceY, portalBottomY);
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

function getSpanVolumeByHydraulicSpan(world: VoxelWorld, span: HydraulicSpan): number {
  return getSpanVolume(world, span);
}

function getSpanAmounts(world: VoxelWorld, span: ColumnSpan): number[] {
  const amounts: number[] = [];
  for (let y = span.bottomY; y <= span.topY; y += 1) {
    amounts.push(world.water[index(world, span.x, y, span.z)]);
  }

  return amounts;
}

function getSurfaceY(span: ColumnSpan, volume: number): number {
  return span.bottomY + Math.min(getSpanCapacity(span), Math.max(0, volume));
}

function setHydraulicSpanVolume(
  world: VoxelWorld,
  span: HydraulicSpan,
  volume: number,
): { changedCells: number; conservationCorrection: number } {
  const clampedVolume = Math.min(span.capacity, Math.max(0, volume));
  let remaining = clampedVolume;
  let changedCells = 0;

  for (let y = span.bottomY; y <= span.topY; y += 1) {
    const cellIndex = index(world, span.x, y, span.z);
    const nextWater = remaining >= 1 ? 1 : remaining > 0 ? remaining : 0;
    const previousWater = world.water[cellIndex];
    if (Math.abs(previousWater - nextWater) > EPSILON) {
      setCellWater(world, cellIndex, nextWater);
      changedCells += 1;
    }
    remaining = Math.max(0, remaining - nextWater);
  }

  const correction = clampedVolume - getSpanVolumeByHydraulicSpan(world, span);
  const conservationCorrection = Math.abs(correction) > VOLUME_CORRECTION_EPSILON ? applySpanVolumeCorrection(world, span, correction) : 0;
  return {
    changedCells: changedCells + (conservationCorrection > 0 ? 1 : 0),
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
  for (let y = span.bottomY; y <= span.topY; y += 1) {
    const cellIndex = index(world, span.x, y, span.z);
    const nextWater = amounts[y - span.bottomY] ?? 0;
    if (Math.abs(world.water[cellIndex] - nextWater) > EPSILON) {
      setCellWater(world, cellIndex, nextWater);
      changedCells += 1;
    }
  }

  const correction = targetVolume - getSpanVolume(world, span);
  const conservationCorrection = Math.abs(correction) > VOLUME_CORRECTION_EPSILON ? applySpanVolumeCorrection(world, span, correction) : 0;
  return {
    changedCells: changedCells + (conservationCorrection > 0 ? 1 : 0),
    conservationCorrection,
  };
}

function applySpanVolumeCorrection(world: VoxelWorld, span: ColumnSpan, correction: number): number {
  if (correction > 0) {
    for (let y = span.bottomY; y <= span.topY; y += 1) {
      const cellIndex = index(world, span.x, y, span.z);
      const room = 1 - world.water[cellIndex];
      if (room <= 0) {
        continue;
      }
      const applied = Math.min(room, correction);
      setCellWater(world, cellIndex, world.water[cellIndex] + applied);
      return Math.abs(applied);
    }
    return 0;
  }

  for (let y = span.topY; y >= span.bottomY; y -= 1) {
    const cellIndex = index(world, span.x, y, span.z);
    if (world.water[cellIndex] <= 0) {
      continue;
    }
    const applied = Math.min(world.water[cellIndex], -correction);
    setCellWater(world, cellIndex, world.water[cellIndex] - applied);
    return Math.abs(applied);
  }

  return 0;
}

function applyGraphVolumeCorrection(world: VoxelWorld, spans: HydraulicSpan[], correction: number): number {
  let remaining = correction;
  let totalApplied = 0;

  for (const span of spans) {
    if (Math.abs(remaining) <= VOLUME_CORRECTION_EPSILON) {
      break;
    }

    const applied = applySpanVolumeCorrection(world, span, remaining);
    if (applied > 0) {
      totalApplied += applied;
      remaining += correction > 0 ? -applied : applied;
    }
  }

  return totalApplied;
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
      const settledFlow = Math.abs(previousFlow * FLOW_VECTOR_DECAY) <= FLOW_VECTOR_CLEAR_EPSILON ? 0 : previousFlow * FLOW_VECTOR_DECAY;
      if (previousFlow !== settledFlow) {
        world.waterFlow[flowOffset] = settledFlow;
        changed = true;
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

function recordHydraulicEdgeEvent(
  world: VoxelWorld,
  graph: HydraulicSpanGraph,
  transfer: AppliedTransfer,
  amount: number,
): void {
  if (amount <= EPSILON || world.waterEdgeEvents.length >= MAX_HYDRAULIC_EDGE_EVENTS) {
    return;
  }

  const source = graph.spans[transfer.sourceId];
  const target = graph.spans[transfer.targetId];
  const dx = Math.sign(target.x - source.x);
  const dz = Math.sign(target.z - source.z);
  const sourceSurfaceY = getSurfaceY(source, source.volume);
  const targetSurfaceY = getSurfaceY(target, target.volume);
  const targetVolumeAfterTransfer = Math.min(target.capacity, target.volume + amount);
  const targetCellIndex = getSpanSurfaceCellIndex(world, target, targetVolumeAfterTransfer);
  const headDelta = Math.max(sourceSurfaceY, transfer.edge.portalBottomY) - Math.max(targetSurfaceY, transfer.edge.portalBottomY);
  const dropDistance = Math.max(0, transfer.edge.portalBottomY - targetSurfaceY, sourceSurfaceY - targetSurfaceY - 0.35);
  const flux = Math.abs(transfer.signedFlux * (amount / Math.max(transfer.amount, EPSILON)));
  const kind = getHydraulicEdgeEventKind(dropDistance, amount, target.volume);
  const rawIntensity = 0.12 + amount * 0.48 + Math.max(0, headDelta) * 0.08 + dropDistance * 0.05 + flux * 0.08;
  const maxIntensity = kind === "impact" ? 0.72 : kind === "fall" ? 0.56 : 0.38;

  world.waterEdgeEvents.push({
    sourceCellIndex: getSpanSurfaceCellIndex(world, source, source.volume),
    targetCellIndex,
    edgeKey: transfer.edge.key,
    kind,
    dx,
    dy: kind === "edge-flow" ? 0 : -1,
    dz,
    amount,
    flux,
    headDelta,
    portalBottomY: transfer.edge.portalBottomY,
    portalTopY: transfer.edge.portalTopY,
    sourceSurfaceY,
    targetSurfaceY,
    dropDistance,
    intensity: Math.min(maxIntensity, clamp01(rawIntensity)),
  });
}

function recordHydraulicFallEvent(
  world: VoxelWorld,
  span: HydraulicSpan,
  sourceCellIndex: number,
  targetCellIndex: number,
  lowerAmountBeforeTransfer: number,
  amount: number,
  offset: number,
): void {
  if (amount <= EPSILON || world.waterEdgeEvents.length >= MAX_HYDRAULIC_EDGE_EVENTS) {
    return;
  }

  const targetSurfaceY = span.bottomY + offset + Math.min(1, lowerAmountBeforeTransfer);
  const sourceSurfaceY = span.bottomY + offset + 1 + Math.min(1, amount);
  const dropDistance = Math.max(0.15, sourceSurfaceY - targetSurfaceY - 0.12);
  const kind: HydraulicSpanEdgeEventKind = lowerAmountBeforeTransfer > 0.18 || offset === 0 ? "impact" : "fall";
  world.waterEdgeEvents.push({
    sourceCellIndex,
    targetCellIndex,
    edgeKey: `${span.key}:fall:${offset}`,
    kind,
    dx: 0,
    dy: -1,
    dz: 0,
    amount,
    flux: amount,
    headDelta: dropDistance,
    portalBottomY: span.bottomY + offset,
    portalTopY: span.bottomY + offset + 1,
    sourceSurfaceY,
    targetSurfaceY,
    dropDistance,
    intensity: Math.min(0.78, clamp01(0.18 + amount * 0.58 + dropDistance * 0.1)),
  });
}

function getHydraulicEdgeEventKind(dropDistance: number, amount: number, targetVolume: number): HydraulicSpanEdgeEventKind {
  if (dropDistance <= 0.65) {
    return "edge-flow";
  }

  if (dropDistance >= 1.25 && targetVolume >= 0.55 && amount >= 0.18) {
    return "impact";
  }

  return "fall";
}

function recordTransferFlow(
  world: VoxelWorld,
  graph: HydraulicSpanGraph,
  transfer: AppliedTransfer,
  amount: number,
): boolean {
  const source = graph.spans[transfer.sourceId];
  const target = graph.spans[transfer.targetId];
  const dx = Math.sign(target.x - source.x);
  const dz = Math.sign(target.z - source.z);
  const sourceCellIndex = getSpanSurfaceCellIndex(world, source, source.volume);
  const targetCellIndex = index(world, target.x, transfer.edge.portalBottomY, target.z);
  return (
    recordWaterFlow(world, sourceCellIndex, dx, 0, dz, amount) ||
    recordWaterFlow(world, targetCellIndex, dx, 0, dz, amount)
  );
}

function recordTransferSurfaceImpulse(
  world: VoxelWorld,
  graph: HydraulicSpanGraph,
  transfer: AppliedTransfer,
  amount: number,
): boolean {
  const source = graph.spans[transfer.sourceId];
  const target = graph.spans[transfer.targetId];
  const dx = Math.sign(target.x - source.x);
  const dz = Math.sign(target.z - source.z);
  return (
    recordSurfaceImpulse(world, getSpanSurfaceCellIndex(world, source, source.volume), amount, dx, 0, dz) ||
    recordSurfaceImpulse(world, getSpanSurfaceCellIndex(world, target, target.volume), amount, dx, 0, dz)
  );
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
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

function compareSpans(a: ColumnSpan, b: ColumnSpan): number {
  return a.x - b.x || a.z - b.z || a.bottomY - b.bottomY || a.topY - b.topY;
}
