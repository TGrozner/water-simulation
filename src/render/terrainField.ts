import { inBounds } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export const ORGANIC_TERRAIN_ISO_LEVEL = 0.5;

export function getTerrainNodeDensity(
  world: VoxelWorld,
  options: RenderOptions | undefined,
  nodeX: number,
  nodeY: number,
  nodeZ: number,
): number {
  let total = 0;
  let count = 0;

  for (let y = nodeY - 1; y <= nodeY; y += 1) {
    for (let z = nodeZ - 1; z <= nodeZ; z += 1) {
      for (let x = nodeX - 1; x <= nodeX; x += 1) {
        count += 1;
        if (!inBounds(world, x, y, z)) {
          total += 1;
          continue;
        }

        if ((options === undefined || shouldRenderCell(world, z, options)) && world.solid[x + world.width * (z + world.depth * y)] === 1) {
          total += 1;
        }
      }
    }
  }

  return total / count;
}
