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

export type VoxelWorld = {
  width: number;
  height: number;
  depth: number;
  solid: Uint8Array;
  water: Float32Array;
  activeCells: Set<number>;
};
