import { inBounds, index } from "./grid";
import type { VoxelWorld } from "./types";

export const ORGANIC_TERRAIN_ISO_LEVEL = 0.5;
const MIN_OPEN_LATERAL_FACE_APERTURE = 0.32;

export type TerrainFieldCellFilter = (x: number, y: number, z: number) => boolean;

export function getTerrainNodeDensity(
  world: VoxelWorld,
  nodeX: number,
  nodeY: number,
  nodeZ: number,
  cellFilter?: TerrainFieldCellFilter,
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

        if ((cellFilter === undefined || cellFilter(x, y, z)) && world.solid[x + world.width * (z + world.depth * y)] === 1) {
          total += 1;
        }
      }
    }
  }

  return total / count;
}

export function getTerrainLateralPortalAperture(
  world: VoxelWorld,
  sourceX: number,
  sourceZ: number,
  targetX: number,
  targetZ: number,
  portalBottomY: number,
  portalTopY: number,
): number {
  const dx = Math.sign(targetX - sourceX);
  const dz = Math.sign(targetZ - sourceZ);
  if (Math.abs(dx) + Math.abs(dz) !== 1 || portalTopY < portalBottomY) {
    return 0;
  }

  let aperture = 0;
  for (let y = portalBottomY; y <= portalTopY; y += 1) {
    aperture += getTerrainLateralFaceAperture(world, sourceX, y, sourceZ, dx, dz);
  }

  return aperture;
}

export function getTerrainLateralFaceAperture(
  world: VoxelWorld,
  sourceX: number,
  y: number,
  sourceZ: number,
  dx: number,
  dz: number,
): number {
  const targetX = sourceX + dx;
  const targetZ = sourceZ + dz;
  if (
    Math.abs(dx) + Math.abs(dz) !== 1 ||
    !inBounds(world, sourceX, y, sourceZ) ||
    !inBounds(world, targetX, y, targetZ)
  ) {
    return 0;
  }

  if (world.solid[index(world, sourceX, y, sourceZ)] === 1 || world.solid[index(world, targetX, y, targetZ)] === 1) {
    return 0;
  }

  const occupancy =
    dx !== 0
      ? getTerrainFaceNodeOccupancy(world, dx > 0 ? sourceX + 1 : sourceX, y, sourceZ, "x")
      : getTerrainFaceNodeOccupancy(world, sourceX, y, dz > 0 ? sourceZ + 1 : sourceZ, "z");
  const organicAperture = 1 - smoothstep(ORGANIC_TERRAIN_ISO_LEVEL - 0.08, ORGANIC_TERRAIN_ISO_LEVEL + 0.24, occupancy);
  return Math.max(MIN_OPEN_LATERAL_FACE_APERTURE, organicAperture);
}

function getTerrainFaceNodeOccupancy(
  world: VoxelWorld,
  nodeX: number,
  nodeY: number,
  nodeZ: number,
  axis: "x" | "z",
): number {
  const densities =
    axis === "x"
      ? [
          getTerrainNodeDensityUncapped(world, nodeX, nodeY, nodeZ),
          getTerrainNodeDensityUncapped(world, nodeX, nodeY + 1, nodeZ),
          getTerrainNodeDensityUncapped(world, nodeX, nodeY, nodeZ + 1),
          getTerrainNodeDensityUncapped(world, nodeX, nodeY + 1, nodeZ + 1),
        ]
      : [
          getTerrainNodeDensityUncapped(world, nodeX, nodeY, nodeZ),
          getTerrainNodeDensityUncapped(world, nodeX + 1, nodeY, nodeZ),
          getTerrainNodeDensityUncapped(world, nodeX, nodeY + 1, nodeZ),
          getTerrainNodeDensityUncapped(world, nodeX + 1, nodeY + 1, nodeZ),
        ];

  return densities.reduce((total, value) => total + value, 0) / densities.length;
}

function getTerrainNodeDensityUncapped(world: VoxelWorld, nodeX: number, nodeY: number, nodeZ: number): number {
  let total = 0;
  let count = 0;

  for (let y = nodeY - 1; y <= nodeY; y += 1) {
    for (let z = nodeZ - 1; z <= nodeZ; z += 1) {
      for (let x = nodeX - 1; x <= nodeX; x += 1) {
        if (!inBounds(world, x, y, z)) {
          continue;
        }

        count += 1;
        if (world.solid[index(world, x, y, z)] === 1) {
          total += 1;
        }
      }
    }
  }

  return count > 0 ? total / count : 1;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
