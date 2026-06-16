import { inBounds, index } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
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

export type WaterParticleCueKind = "none" | "jet" | "spray" | "splash";

export type WaterParticleCue = {
  kind: WaterParticleCueKind;
  intensity: number;
  direction: { x: number; y: number; z: number };
  surfaceEnergy: number;
};

export type WaterEdgeCueKind = "none" | "edge-flow" | "fall" | "impact";

export type WaterEdgeCue = {
  kind: WaterEdgeCueKind;
  intensity: number;
  amount: number;
  dropDistance: number;
  direction: { x: number; y: number; z: number };
  surfaceEnergy: number;
};

export type WaterEdgeCueMap = Map<number, WaterEdgeCue>;

export const WATER_FLOW_VISUAL_SCALE = 0.75;
const LATERAL_MOTION_THRESHOLD = 0.14;
const FALLING_MOTION_THRESHOLD = 0.11;
const TURBULENT_SURFACE_THRESHOLD = 0.035;
const PARTICLE_SURFACE_ENERGY_SCALE = 0.14;

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

export function buildWaterEdgeCueMap(world: VoxelWorld): WaterEdgeCueMap {
  const cues: WaterEdgeCueMap = new Map();

  for (const event of world.waterEdgeEvents) {
    const horizontal = Math.hypot(event.dx, event.dz);
    mergeWaterEdgeCue(cues, event.targetCellIndex, {
      kind: event.kind,
      intensity: event.intensity,
      amount: event.amount,
      dropDistance: event.dropDistance,
      direction: normalizeCueDirection(event.dx, event.dy, event.dz),
      surfaceEnergy: clamp01(event.intensity * 0.7 + event.dropDistance * 0.08),
    });
    mergeWaterEdgeCue(cues, event.sourceCellIndex, {
      kind: horizontal > 0.1 ? "edge-flow" : event.kind === "impact" ? "fall" : event.kind,
      intensity: event.intensity * (horizontal > 0.1 ? 0.35 : 0.55),
      amount: event.amount,
      dropDistance: event.dropDistance,
      direction: normalizeCueDirection(event.dx, event.dy, event.dz),
      surfaceEnergy: clamp01(event.intensity * 0.42 + event.dropDistance * 0.05),
    });
  }

  return cues;
}

export function getWaterEdgeCueForCell(
  cues: WaterEdgeCueMap,
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
): WaterEdgeCue {
  if (!inBounds(world, x, y, z)) {
    return createEmptyWaterEdgeCue();
  }

  return cues.get(index(world, x, y, z)) ?? createEmptyWaterEdgeCue();
}

export function getWaterParticleCue(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  edgeCue: WaterEdgeCue = createEmptyWaterEdgeCue(),
): WaterParticleCue {
  if (!isOpenWaterCell(world, x, y, z) || amount <= EPSILON) {
    return createEmptyParticleCue();
  }

  const motion = getWaterMotionSample(world, x, y, z);
  const surfaceEnergy = Math.min(
    1,
    (Math.abs(motion.surfaceOffset) + Math.abs(motion.surfaceVelocity)) / PARTICLE_SURFACE_ENERGY_SCALE,
  );
  const drop = getOpenDropVector(world, x, y, z, amount);
  const moving = motion.kind !== "settled";

  if (edgeCue.kind !== "none" && edgeCue.intensity > 0.18) {
    const eventSurfaceEnergy = Math.max(surfaceEnergy, edgeCue.surfaceEnergy);
    if (edgeCue.kind === "impact") {
      return {
        kind: "splash",
        intensity: clamp01(0.28 + edgeCue.intensity * 0.7 + eventSurfaceEnergy * 0.18),
        direction: normalizeCueDirection(
          edgeCue.direction.x + motion.x * 0.22,
          Math.max(0.16, 0.42 - edgeCue.dropDistance * 0.04),
          edgeCue.direction.z + motion.z * 0.22,
        ),
        surfaceEnergy: eventSurfaceEnergy,
      };
    }

    if (edgeCue.kind === "fall") {
      return {
        kind: edgeCue.intensity > 0.58 ? "splash" : "spray",
        intensity: clamp01(0.22 + edgeCue.intensity * 0.68 + edgeCue.dropDistance * 0.06),
        direction: normalizeCueDirection(edgeCue.direction.x + motion.x * 0.18, -Math.max(0.32, edgeCue.dropDistance * 0.12), edgeCue.direction.z + motion.z * 0.18),
        surfaceEnergy: eventSurfaceEnergy,
      };
    }

    if (edgeCue.intensity > 0.34) {
      return {
        kind: edgeCue.dropDistance > 0.35 ? "spray" : "jet",
        intensity: clamp01(0.14 + edgeCue.intensity * 0.62 + motion.horizontal * 0.18),
        direction: normalizeCueDirection(edgeCue.direction.x + motion.x * 0.28, -0.08 - eventSurfaceEnergy * 0.12, edgeCue.direction.z + motion.z * 0.28),
        surfaceEnergy: eventSurfaceEnergy,
      };
    }
  }

  if (!moving && surfaceEnergy < 0.18) {
    return createEmptyParticleCue();
  }

  if (drop.y < 0 && (motion.vertical >= FALLING_MOTION_THRESHOLD || surfaceEnergy >= 0.35)) {
    return {
      kind: surfaceEnergy >= 0.5 || motion.kind === "turbulent" ? "splash" : "spray",
      intensity: clamp01(0.24 + motion.vertical * 0.52 + surfaceEnergy * 0.42 + drop.strength * 0.16),
      direction: normalizeCueDirection(motion.x + drop.x * 0.35, -Math.max(0.35, motion.vertical + drop.strength), motion.z + drop.z * 0.35),
      surfaceEnergy,
    };
  }

  if (motion.horizontal >= LATERAL_MOTION_THRESHOLD) {
    const lateralX = drop.x !== 0 || drop.z !== 0 ? motion.x + drop.x * 0.55 : motion.x;
    const lateralZ = drop.x !== 0 || drop.z !== 0 ? motion.z + drop.z * 0.55 : motion.z;
    return {
      kind: drop.strength > 0.35 ? "spray" : "jet",
      intensity: clamp01(0.18 + motion.horizontal * 0.55 + surfaceEnergy * 0.22 + drop.strength * 0.18),
      direction: normalizeCueDirection(lateralX, -0.08 - surfaceEnergy * 0.16, lateralZ),
      surfaceEnergy,
    };
  }

  if (surfaceEnergy >= 0.35) {
    return {
      kind: "splash",
      intensity: clamp01(0.12 + surfaceEnergy * 0.62),
      direction: normalizeCueDirection(motion.x, 0.2, motion.z),
      surfaceEnergy,
    };
  }

  return createEmptyParticleCue(surfaceEnergy);
}

function getOpenDropVector(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
): { x: number; y: number; z: number; strength: number } {
  let dropX = 0;
  let dropY = 0;
  let dropZ = 0;
  let strength = 0;

  if (isLowerOpenWaterNeighbor(world, x, y - 1, z, amount)) {
    dropY -= 1;
    strength += 1;
  }

  const lateralDrops = [
    { x: -1, z: 0 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: 0, z: 1 },
  ] as const;

  for (const offset of lateralDrops) {
    if (!isLowerOpenWaterNeighbor(world, x + offset.x, y, z + offset.z, amount)) {
      continue;
    }

    dropX += offset.x;
    dropZ += offset.z;
    strength += 0.42;
  }

  return { x: dropX, y: dropY, z: dropZ, strength: Math.min(1, strength) };
}

function isLowerOpenWaterNeighbor(world: VoxelWorld, x: number, y: number, z: number, amount: number): boolean {
  if (!inBounds(world, x, y, z)) {
    return false;
  }

  const cellIndex = index(world, x, y, z);
  return world.solid[cellIndex] !== 1 && world.water[cellIndex] < amount - 0.2;
}

function isOpenWaterCell(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (!inBounds(world, x, y, z)) {
    return false;
  }

  const cellIndex = index(world, x, y, z);
  return world.solid[cellIndex] !== 1 && world.water[cellIndex] > EPSILON;
}

function normalizeCueDirection(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const length = Math.hypot(x, y, z);
  if (length <= EPSILON) {
    return { x: 0, y: 1, z: 0 };
  }

  return { x: x / length, y: y / length, z: z / length };
}

function createEmptyParticleCue(surfaceEnergy = 0): WaterParticleCue {
  return {
    kind: "none",
    intensity: 0,
    direction: { x: 0, y: 0, z: 0 },
    surfaceEnergy,
  };
}

function createEmptyWaterEdgeCue(): WaterEdgeCue {
  return {
    kind: "none",
    intensity: 0,
    amount: 0,
    dropDistance: 0,
    direction: { x: 0, y: 0, z: 0 },
    surfaceEnergy: 0,
  };
}

function mergeWaterEdgeCue(cues: WaterEdgeCueMap, cellIndex: number, cue: WaterEdgeCue): void {
  const previous = cues.get(cellIndex);
  if (!previous) {
    cues.set(cellIndex, cue);
    return;
  }

  const lowerIntensity = Math.min(previous.intensity, cue.intensity);
  const nextIntensity = Math.min(1, Math.max(previous.intensity, cue.intensity) + lowerIntensity * 0.18);
  const previousWeight = previous.intensity;
  const cueWeight = cue.intensity;
  cues.set(cellIndex, {
    kind: getDominantCueKind(previous.kind, cue.kind),
    intensity: nextIntensity,
    amount: previous.amount + cue.amount,
    dropDistance: Math.max(previous.dropDistance, cue.dropDistance),
    direction: normalizeCueDirection(
      previous.direction.x * previousWeight + cue.direction.x * cueWeight,
      previous.direction.y * previousWeight + cue.direction.y * cueWeight,
      previous.direction.z * previousWeight + cue.direction.z * cueWeight,
    ),
    surfaceEnergy: Math.max(previous.surfaceEnergy, cue.surfaceEnergy),
  });
}

function getDominantCueKind(a: WaterEdgeCueKind, b: WaterEdgeCueKind): WaterEdgeCueKind {
  return getCueKindPriority(b) > getCueKindPriority(a) ? b : a;
}

function getCueKindPriority(kind: WaterEdgeCueKind): number {
  switch (kind) {
    case "impact":
      return 3;
    case "fall":
      return 2;
    case "edge-flow":
      return 1;
    case "none":
      return 0;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
