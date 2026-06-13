import type { VoxelWorld } from "../world/types";

export type SliceView = {
  enabled: boolean;
  z: number;
};

export type RenderOptions = {
  slice: SliceView;
};

export function shouldRenderCell(world: VoxelWorld, z: number, options: RenderOptions): boolean {
  return !options.slice.enabled || z <= options.slice.z || z >= world.depth - 1;
}
