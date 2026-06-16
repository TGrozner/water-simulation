export const WORLD_WIDTH = 48;
export const WORLD_HEIGHT = 32;
export const WORLD_DEPTH = 48;

export const MAX_WATER = 1;
export const EPSILON = 0.001;
export const MIN_FLOW = 0.01;
export const DOWN_FLOW_RATE = 0.6;
export const SIDE_FLOW_RATE = 0.2;
export const SIM_STEPS_PER_FRAME = 2;

export type CellCoords = {
  x: number;
  y: number;
  z: number;
};

export type HydraulicSpanEdgeEventKind = "edge-flow" | "fall" | "impact";

export type HydraulicSpanEdgeEvent = {
  sourceCellIndex: number;
  targetCellIndex: number;
  edgeKey: string;
  kind: HydraulicSpanEdgeEventKind;
  dx: number;
  dy: number;
  dz: number;
  amount: number;
  flux: number;
  headDelta: number;
  portalBottomY: number;
  portalTopY: number;
  sourceSurfaceY: number;
  targetSurfaceY: number;
  dropDistance: number;
  intensity: number;
};

export type VoxelWorld = {
  width: number;
  height: number;
  depth: number;
  solid: Uint8Array;
  water: Float32Array;
  waterFlow: Float32Array;
  waterSurfaceOffset: Float32Array;
  waterSurfaceVelocity: Float32Array;
  waterFlux: Map<string, number>;
  waterEdgeEvents: HydraulicSpanEdgeEvent[];
  activeCells: Set<number>;
  activeFlowCells: Set<number>;
  activeSurfaceCells: Set<number>;
  wetCells: Set<number>;
};
