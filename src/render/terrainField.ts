import type { VoxelWorld } from "../world/types";
import {
  getTerrainNodeDensity as getWorldTerrainNodeDensity,
  ORGANIC_TERRAIN_ISO_LEVEL,
} from "../world/terrainField";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export { ORGANIC_TERRAIN_ISO_LEVEL };

export function getTerrainNodeDensity(
  world: VoxelWorld,
  options: RenderOptions | undefined,
  nodeX: number,
  nodeY: number,
  nodeZ: number,
): number {
  return getWorldTerrainNodeDensity(
    world,
    nodeX,
    nodeY,
    nodeZ,
    options === undefined ? undefined : (_x, _y, z) => shouldRenderCell(world, z, options),
  );
}
