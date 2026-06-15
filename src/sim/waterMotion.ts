import { inBounds, index } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import {
  getWaterSurfaceOffsetAt,
  getWaterSurfaceVelocityAt,
  WATER_SURFACE_OFFSET_LIMIT,
  WATER_SURFACE_VELOCITY_LIMIT,
} from "./waterSurface";

export type WaterMotionKind = "settled" | "lateral" | "falling" | "turbulent";

export type WaterMotionSample = {
  x: number;
  y: number;
  z: number;
  horizontal: number;
  vertical: number;
  strength: number;
  surfaceOffset: number;
  surfaceVelocity: number;
  kind: WaterMotionKind;
};

export const WATER_FLOW_VISUAL_SCALE = 0.75;
const LATERAL_MOTION_THRESHOLD = 0.08;
const FALLING_MOTION_THRESHOLD = 0.11;
const TURBULENT_SURFACE_THRESHOLD = 0.035;

export function getWaterMotionSample(world: VoxelWorld, x: number, y: number, z: number): WaterMotionSample {
  const flow = getWaterFlowVector(world, x, y, z);
  const horizontal = Math.hypot(flow.x, flow.z);
  const vertical = Math.max(0, -flow.y);
  const surfaceOffset = getWaterSurfaceOffsetAt(world, x, y, z);
  const surfaceVelocity = getWaterSurfaceVelocityAt(world, x, y, z);
  const strength = Math.min(1, Math.hypot(horizontal, vertical) / WATER_FLOW_VISUAL_SCALE);
  const surfaceMotion = Math.abs(surfaceOffset) + Math.abs(surfaceVelocity);

  let kind: WaterMotionKind = "settled";
  if (vertical >= FALLING_MOTION_THRESHOLD && horizontal >= LATERAL_MOTION_THRESHOLD) {
    kind = "turbulent";
  } else if (vertical >= FALLING_MOTION_THRESHOLD) {
    kind = "falling";
  } else if (horizontal >= LATERAL_MOTION_THRESHOLD) {
    kind = "lateral";
  } else if (
    surfaceMotion >= TURBULENT_SURFACE_THRESHOLD &&
    (WATER_SURFACE_OFFSET_LIMIT > 0 || WATER_SURFACE_VELOCITY_LIMIT > 0)
  ) {
    kind = "turbulent";
  }

  return {
    x: flow.x,
    y: flow.y,
    z: flow.z,
    horizontal,
    vertical,
    strength,
    surfaceOffset,
    surfaceVelocity,
    kind,
  };
}

export function getWaterFlowVector(world: VoxelWorld, x: number, y: number, z: number): { x: number; y: number; z: number } {
  if (!inBounds(world, x, y, z)) {
    return { x: 0, y: 0, z: 0 };
  }

  const offset = index(world, x, y, z) * 3;
  return {
    x: world.waterFlow[offset],
    y: world.waterFlow[offset + 1],
    z: world.waterFlow[offset + 2],
  };
}

export function getWaterFlowStrength(world: VoxelWorld, x: number, y: number, z: number): number {
  return getWaterMotionSample(world, x, y, z).strength;
}
