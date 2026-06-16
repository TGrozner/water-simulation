import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  type Material,
  Object3D,
  Raycaster,
  RepeatWrapping,
  Scene,
} from "three";
import {
  buildWaterEdgeCueMap,
  getWaterEdgeCueForCell,
  getWaterMotionSample,
  getWaterParticleCue,
  type WaterEdgeCue,
  type WaterEdgeCueMap,
  type WaterMotionSample,
} from "../sim/waterMotion";
import { getWaterSurfaceOffsetAt } from "../sim/waterSurface";
import { cellCenter } from "../world/grid";
import { EPSILON, type HydraulicSpanEdgeEvent, type HydraulicVisualEvent, type VoxelWorld } from "../world/types";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";
import { getTerrainNodeDensity, ORGANIC_TERRAIN_ISO_LEVEL } from "./terrainField";

export type WaterRenderer = {
  bodyBatch: InstancedMeshBatch<BoxGeometry, MeshPhongMaterial, number>;
  surfaceMesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  curtainMesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  foamMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  foamBatch: InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>;
  sprayBatch: InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>;
  surfaceHeightMemory: Map<string, number>;
  surfaceFieldMemory: Map<string, number>;
  surfaceHeightMemorySizeKey: string;
  curtainGeometryState: DynamicGeometryState;
  foamGeometryState: DynamicGeometryState;
  surfaceRippleTexture: CanvasTexture;
  stats: RendererStats;
  pickCell: (raycaster: Raycaster) => { cellIndex: number; distance: number } | null;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions, gameplayMode?: boolean) => void;
  animate: (timeSeconds: number) => void;
  dispose: () => void;
};

type Rgb = { r: number; g: number; b: number };
type SideDirection = { dx: number; dz: number; axis: "x" | "z"; side: -1 | 1 };
type SurfaceCell = {
  x: number;
  y: number;
  z: number;
  waterHeight: number;
  surfaceY: number;
  columnDepth: number;
  spanBottomY: number;
  spanTopY: number;
  spanKey: string;
  motion: WaterMotionSample;
};
type SurfaceSample = { x: number; y: number; z: number; value: number; height: number; color: Rgb; terrainContact: boolean };
type SurfaceVertex = { x: number; y: number; z: number; value: number; color: Rgb; terrainContact: boolean };
type ColumnSurfaceSample = {
  surfaceY: number;
  columnDepth: number;
  bottomY: number;
  topY: number;
  spanKey: string;
};
type SurfaceComponentSpan = {
  x: number;
  z: number;
  bottomY: number;
  topY: number;
  spanKey: string;
  volume: number;
  capacity: number;
};
type SurfaceHeightState = {
  surfaceHeightMemory: Map<string, number>;
  surfaceFieldMemory: Map<string, number>;
  surfaceHeightMemorySizeKey: string;
};
type DynamicGeometryState = {
  positionCapacity: number;
  colorCapacity: number;
};
type SurfaceBuildState = SurfaceHeightState & {
  columnSurfaceCache: Map<string, ColumnSurfaceSample | null>;
};
type ShorelineCue = {
  foam: boolean;
  skirt: boolean;
  width: number;
  intensity: number;
  headDelta: number;
  motion: WaterMotionSample;
};
export type WaterSurfaceMeshDebugStats = {
  vertexCount: number;
  triangleCount: number;
  minY: number;
  maxY: number;
  finite: boolean;
};

const bodyDummy = new Object3D();
const foamDummy = new Object3D();
const sprayDummy = new Object3D();
const FULL_WATER_RENDER_THRESHOLD = 0.96;
const EXPOSED_WATER_DELTA = 0.05;
const SURFACE_LIFT = 0.024;
const SURFACE_WAVE_AMPLITUDE = 0.006;
const SURFACE_MOTION_SCALE = 0.14;
const SURFACE_MOTION_HEADROOM = 0.14;
const SURFACE_SHORE_INSET = 0.085;
const SURFACE_SOLID_INSET = 0.18;
const SURFACE_ISO_LEVEL = 0.42;
const SURFACE_TERRAIN_CONTACT_VALUE = 0.06;
const SURFACE_MEMORY_ALPHA = 0.38;
const SURFACE_MEMORY_SNAP_DELTA = 0.6;
const SURFACE_FIELD_RISE_ALPHA = 0.62;
const SURFACE_FIELD_DECAY_ALPHA = 0.2;
const SURFACE_FIELD_CLEAR_EPSILON = 0.035;
const SURFACE_LAYER_MAX_STEP = 0.62;
const SURFACE_TERRAIN_OCCLUSION_START = 0.48;
const SURFACE_TERRAIN_OCCLUSION_END = 0.78;
const SHORE_FOAM_INSET = 0.08;
const SHORE_FOAM_WIDTH = 0.075;
const SHORE_SKIRT_DROP = 0.32;
const SHORE_CONTACT_OVERLAP = 0.14;
const CURTAIN_INSET = 0.1;
const SIDE_CURTAIN_MIN_DROP = 0.45;
const EDGE_SHEET_MIN_DROP = 0.42;
const EDGE_SHEET_MIN_AMOUNT = 0.48;
const FALLING_WATER_DROP_DELTA = 0.2;
const FALLING_WATER_MIN_AMOUNT = 0.16;
const FALLING_RIBBON_MAX_DROP = 12;
const HYDRAULIC_EVENT_RIBBON_MIN_INTENSITY = 0.48;
const HYDRAULIC_EVENT_RIBBON_MAX_COUNT = 48;
const HYDRAULIC_EVENT_FOAM_MIN_INTENSITY = 0.5;
const HYDRAULIC_EVENT_FOAM_MAX_COUNT = 42;
const HYDRAULIC_EVENT_FOAM_SURFACE_LIFT = 0.058;
const HYDRAULIC_EVENT_MIN_FRESHNESS = 0.22;
const HYDRAULIC_EVENT_MIN_TARGET_WATER = 0.16;
const HYDRAULIC_EVENT_MAX_SURFACE_DRIFT = 0.72;
// Gameplay keeps decorative sheet layers disabled until they are generated from
// solver-owned terrain/contact events instead of axis-aligned voxel quads.
const ENABLE_GAMEPLAY_SHORELINE_SKIRTS = false;
const ENABLE_GAMEPLAY_WATER_RIBBONS = false;
const ENABLE_GAMEPLAY_FOAM_QUADS = false;
const WEBGPU_SAFE_BATCH_CAPACITY = 1000;
const SURFACE_VERTEX_KEY_SCALE = 1000;
const SIDE_DIRECTIONS: SideDirection[] = [
  { dx: -1, dz: 0, axis: "x", side: -1 },
  { dx: 1, dz: 0, axis: "x", side: 1 },
  { dx: 0, dz: -1, axis: "z", side: -1 },
  { dx: 0, dz: 1, axis: "z", side: 1 },
];

export function createWaterRenderer(scene: Scene, world: VoxelWorld): WaterRenderer {
  const geometry = new BoxGeometry(0.96, 1, 0.96);
  const foamGeometry = new CircleGeometry(0.5, 18);
  const sprayGeometry = new CircleGeometry(0.5, 10);
  const surfaceRippleTexture = createWaterRippleTexture(0xf6ffff, 0xb6dce4);
  const material = new MeshPhongMaterial({
    color: 0x32d5eb,
    emissive: 0x073d4d,
    specular: 0xcff8ff,
    shininess: 115,
    transparent: true,
    opacity: 0,
    depthWrite: true,
  });
  // Invisible depth pre-pass for transparent water; gameplay color writes stay off below.
  material.colorWrite = false;

  const surfaceMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x093f50,
    roughness: 0.07,
    metalness: 0,
    envMapIntensity: 0.62,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    side: DoubleSide,
    vertexColors: true,
    map: surfaceRippleTexture,
  });
  const curtainMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x062637,
    roughness: 0.18,
    metalness: 0,
    envMapIntensity: 0.38,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: DoubleSide,
    vertexColors: true,
  });
  const foamMaterial = new MeshBasicMaterial({
    color: 0xdffcff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: DoubleSide,
  });
  const foamStripMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: DoubleSide,
    vertexColors: true,
  });
  const sprayMaterial = new MeshBasicMaterial({
    color: 0xecffff,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    side: DoubleSide,
  });
  const bodyBatch = new InstancedMeshBatch<BoxGeometry, MeshPhongMaterial, number>({
    scene,
    geometry,
    material,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: "water-body-batch",
    renderOrder: -10,
  });
  const surfaceMesh = new Mesh(new BufferGeometry(), surfaceMaterial);
  const curtainMesh = new Mesh(new BufferGeometry(), curtainMaterial);
  const foamBatch = new InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>({
    scene,
    geometry: foamGeometry,
    material: foamMaterial,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: "water-foam-batch",
    renderOrder: 8,
  });
  const sprayBatch = new InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>({
    scene,
    geometry: sprayGeometry,
    material: sprayMaterial,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: "water-spray-batch",
    renderOrder: 9,
  });
  const foamMesh = new Mesh(new BufferGeometry(), foamStripMaterial);
  const stats = createRendererStats(world.water.length);

  surfaceMesh.frustumCulled = false;
  curtainMesh.frustumCulled = false;
  foamMesh.frustumCulled = false;
  surfaceMesh.renderOrder = 6;
  curtainMesh.renderOrder = 7;
  foamMesh.renderOrder = 8;
  scene.add(curtainMesh);
  scene.add(surfaceMesh);
  scene.add(foamMesh);

  const waterRenderer: WaterRenderer = {
    bodyBatch,
    surfaceMesh,
    curtainMesh,
    foamMesh,
    foamBatch,
    sprayBatch,
    surfaceHeightMemory: new Map(),
    surfaceFieldMemory: new Map(),
    surfaceHeightMemorySizeKey: getSurfaceMemorySizeKey(world),
    curtainGeometryState: { positionCapacity: 0, colorCapacity: 0 },
    foamGeometryState: { positionCapacity: 0, colorCapacity: 0 },
    surfaceRippleTexture,
    stats,
    pickCell: (raycaster) => {
      const hit = bodyBatch.pick(raycaster);
      return hit ? { cellIndex: hit.metadata, distance: hit.distance } : null;
    },
    update: (nextWorld, debugMode, options = defaultRenderOptions(nextWorld), gameplayMode = false) =>
      updateWaterMesh(waterRenderer, nextWorld, debugMode, options, gameplayMode),
    animate: (timeSeconds) => {
      surfaceRippleTexture.offset.set(timeSeconds * 0.018, timeSeconds * 0.011);
      surfaceRippleTexture.rotation = Math.sin(timeSeconds * 0.08) * 0.08;
    },
    dispose: () => {
      bodyBatch.dispose();
      foamBatch.dispose();
      sprayBatch.dispose();
      scene.remove(curtainMesh);
      scene.remove(surfaceMesh);
      scene.remove(foamMesh);
      geometry.dispose();
      curtainMesh.geometry.dispose();
      surfaceMesh.geometry.dispose();
      foamMesh.geometry.dispose();
      foamGeometry.dispose();
      sprayGeometry.dispose();
      material.dispose();
      surfaceMaterial.dispose();
      curtainMaterial.dispose();
      foamStripMaterial.dispose();
      foamMaterial.dispose();
      sprayMaterial.dispose();
      surfaceRippleTexture.dispose();
    },
  };

  waterRenderer.update(world, false);

  return waterRenderer;
}

function updateWaterMesh(
  renderer: WaterRenderer,
  world: VoxelWorld,
  debugMode: boolean,
  options: RenderOptions,
  gameplayMode: boolean,
): void {
  const startedAt = performance.now();
  let instanceCount = 0;
  let surfaceFaceCount = 0;
  let curtainFaceCount = 0;
  let foamCount = 0;
  let sprayCount = 0;
  const surfaceCells: SurfaceCell[] = [];
  const curtainPositions: number[] = [];
  const curtainColors: number[] = [];
  const foamStripPositions: number[] = [];
  const foamStripColors: number[] = [];
  const material = renderer.bodyBatch.material;
  const surfaceMaterial = renderer.surfaceMesh.material;
  const curtainMaterial = renderer.curtainMesh.material;
  const foamStripMaterial = renderer.foamMesh.material;
  const foamMaterial = renderer.foamBatch.material;
  const sprayMaterial = renderer.sprayBatch.material;
  const nextSurfaceMap = debugMode || !gameplayMode ? renderer.surfaceRippleTexture : null;
  material.color.set(debugMode ? 0x5ef0ff : 0x32d5eb);
  material.emissive.set(debugMode ? 0x126c7c : 0x073d4d);
  material.transparent = true;
  material.opacity = debugMode ? 0.45 : 0;
  material.colorWrite = debugMode;
  surfaceMaterial.emissive.set(debugMode ? 0x1a7b88 : gameplayMode ? 0x084451 : 0x125d68);
  surfaceMaterial.opacity = debugMode ? 0.72 : gameplayMode ? 0.78 : 0.72;
  if (surfaceMaterial.map !== nextSurfaceMap) {
    surfaceMaterial.map = nextSurfaceMap;
    surfaceMaterial.needsUpdate = true;
  }
  curtainMaterial.emissive.set(debugMode ? 0x125c78 : gameplayMode ? 0x062637 : 0x0b4057);
  curtainMaterial.opacity = debugMode ? 0.5 : gameplayMode ? 0.18 : 0.42;
  foamStripMaterial.opacity = debugMode ? 0.12 : gameplayMode ? 0.045 : 0.1;
  foamMaterial.opacity = debugMode ? 0.18 : gameplayMode ? 0.075 : 0.12;
  sprayMaterial.opacity = debugMode ? 0.14 : gameplayMode ? 0.08 : 0.12;
  const layerSize = world.width * world.depth;
  const columnSurfaceCache = new Map<string, ColumnSurfaceSample | null>();
  const edgeCueMap = buildWaterEdgeCueMap(world);
  renderer.bodyBatch.begin();
  renderer.foamBatch.begin();
  renderer.sprayBatch.begin();

  for (const cellIndex of world.wetCells) {
    const y = Math.floor(cellIndex / layerSize);
    const layerIndex = cellIndex - y * layerSize;
    const z = Math.floor(layerIndex / world.width);
    const x = layerIndex - z * world.width;
    const amount = world.water[cellIndex];
    if (
      amount <= EPSILON ||
      world.solid[cellIndex] === 1 ||
      !shouldRenderCell(world, z, options) ||
      !shouldRenderWaterCell(world, x, y, z, amount, debugMode, gameplayMode)
    ) {
      continue;
    }

    const center = cellCenter(world, x, y, z);
    const waterHeight = Math.max(0.05, Math.min(1, amount));
    const edgeCue = getWaterEdgeCueForCell(edgeCueMap, world, x, y, z);
    bodyDummy.position.set(center.x, y + waterHeight * 0.5, center.z);
    bodyDummy.rotation.set(0, 0, 0);
    bodyDummy.scale.set(1, waterHeight, 1);
    bodyDummy.updateMatrix();
    renderer.bodyBatch.pushMatrix(bodyDummy.matrix, cellIndex);
    instanceCount += 1;

    if (shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)) {
      const surfaceCell = createSurfaceCell(world, x, y, z, columnSurfaceCache);
      if (surfaceCell) {
        surfaceCells.push(surfaceCell);
      }
      surfaceFaceCount += 1;
      if (gameplayMode && !debugMode) {
        if (ENABLE_GAMEPLAY_SHORELINE_SKIRTS) {
          curtainFaceCount += appendShorelineSkirts(
            curtainPositions,
            curtainColors,
            world,
            x,
            y,
            z,
            waterHeight,
            edgeCueMap,
          );
        }
        if (ENABLE_GAMEPLAY_FOAM_QUADS) {
          foamCount += appendShoreFoamStrips(foamStripPositions, foamStripColors, world, x, y, z, waterHeight, edgeCueMap);
        }
      }
    }

    if (debugMode || !gameplayMode) {
      curtainFaceCount += appendWaterCurtains(
        curtainPositions,
        curtainColors,
        world,
        x,
        y,
        z,
        waterHeight,
        debugMode,
        gameplayMode,
      );
    } else {
      curtainFaceCount += appendGameplayWaterDrops(curtainPositions, curtainColors, world, x, y, z, waterHeight, edgeCueMap);
    }

    if (shouldRenderWaterFoam(world, x, y, z, amount, debugMode, gameplayMode, edgeCue)) {
      const foamScale = getWaterFoamScale(world, x, y, z, amount, edgeCue);
      const foamStretch = 0.72 + getCellVariation(x, y + 17, z) * 0.34;
      foamDummy.position.set(center.x, y + waterHeight + 0.05, center.z);
      foamDummy.rotation.set(-Math.PI / 2, 0, getCellVariation(z, y, x) * Math.PI * 2);
      foamDummy.scale.set(foamScale, foamScale * foamStretch, 1);
      foamDummy.updateMatrix();
      renderer.foamBatch.pushMatrix(foamDummy.matrix);
      foamCount += 1;
    }

    if (gameplayMode && !debugMode) {
      sprayCount = appendWaterParticleCue(renderer, world, x, y, z, waterHeight, edgeCue, sprayCount);
    }
  }

  if (gameplayMode && !debugMode) {
    if (ENABLE_GAMEPLAY_WATER_RIBBONS) {
      curtainFaceCount += appendHydraulicEventRibbons(curtainPositions, curtainColors, world);
    }
    if (ENABLE_GAMEPLAY_FOAM_QUADS) {
      foamCount += appendHydraulicEventFoam(foamStripPositions, foamStripColors, world);
    }
  }

  renderer.bodyBatch.finish();
  replacePoolSurfaceGeometry(renderer, world, surfaceCells);
  replaceDynamicGeometry(renderer, renderer.curtainMesh, renderer.curtainGeometryState, curtainPositions, curtainColors);
  replaceDynamicGeometry(renderer, renderer.foamMesh, renderer.foamGeometryState, foamStripPositions, foamStripColors);
  renderer.foamBatch.finish();
  renderer.sprayBatch.finish();
  renderer.stats.instances = instanceCount + surfaceFaceCount + curtainFaceCount + foamCount + sprayCount;
  renderer.stats.updateMs = performance.now() - startedAt;
}

function appendHydraulicEventRibbons(positions: number[], colors: number[], world: VoxelWorld): number {
  let faceCount = 0;
  for (const event of getHydraulicDisplayEvents(world)) {
    if (faceCount >= HYDRAULIC_EVENT_RIBBON_MAX_COUNT) {
      break;
    }

    const freshness = getHydraulicEventFreshness(event);
    const intensity = getHydraulicEventDisplayIntensity(event) * freshness;
    const amount = getHydraulicEventDisplayAmount(event) * Math.max(0.35, freshness);
    const horizontal = Math.hypot(event.dx, event.dz);
    if (
      freshness < HYDRAULIC_EVENT_MIN_FRESHNESS ||
      horizontal <= EPSILON ||
      (event.kind !== "fall" && event.kind !== "impact") ||
      intensity < HYDRAULIC_EVENT_RIBBON_MIN_INTENSITY ||
      event.dropDistance < 0.42
    ) {
      continue;
    }

    const source = getCoordsFromCellIndex(world, event.sourceCellIndex);
    const target = getCoordsFromCellIndex(world, event.targetCellIndex);
    if (
      !source ||
      !target ||
      world.water[event.sourceCellIndex] <= EPSILON ||
      !isHydraulicEventAttachedToCurrentWater(world, event, target, HYDRAULIC_EVENT_MIN_TARGET_WATER * 0.35)
    ) {
      continue;
    }

    const topY = Math.max(event.sourceSurfaceY, event.portalTopY) + 0.012;
    const bottomY = Math.max(event.targetSurfaceY + 0.035, topY - Math.min(FALLING_RIBBON_MAX_DROP, event.dropDistance + 0.24));
    if (topY - bottomY < 0.18) {
      continue;
    }

    appendHydraulicRibbon(positions, colors, world, source.x, source.z, event.dx, event.dz, topY, bottomY, amount, intensity);
    faceCount += 1;
  }

  return faceCount;
}

function appendHydraulicEventFoam(positions: number[], colors: number[], world: VoxelWorld): number {
  let faceCount = 0;
  for (const event of getHydraulicDisplayEvents(world)) {
    if (faceCount >= HYDRAULIC_EVENT_FOAM_MAX_COUNT) {
      break;
    }

    const freshness = getHydraulicEventFreshness(event);
    const intensity = getHydraulicEventDisplayIntensity(event) * freshness;
    if (intensity < HYDRAULIC_EVENT_FOAM_MIN_INTENSITY || !shouldRenderHydraulicEventFoam(event, intensity)) {
      continue;
    }

    const target = getCoordsFromCellIndex(world, event.targetCellIndex);
    if (!target || !isHydraulicEventAttachedToCurrentWater(world, event, target, HYDRAULIC_EVENT_MIN_TARGET_WATER)) {
      continue;
    }

    const amount = getHydraulicEventDisplayAmount(event) * Math.max(0.4, freshness);
    const currentSurfaceY = getHydraulicEventCurrentSurfaceY(world, event, target, HYDRAULIC_EVENT_MIN_TARGET_WATER);
    if (currentSurfaceY === null) {
      continue;
    }
    const surfaceY = currentSurfaceY + HYDRAULIC_EVENT_FOAM_SURFACE_LIFT;

    const horizontal = Math.hypot(event.dx, event.dz);
    const flowX = horizontal > EPSILON ? event.dx / horizontal : 0;
    const flowZ = horizontal > EPSILON ? event.dz / horizontal : 0;
    const tangentX = horizontal > EPSILON ? -flowZ : 1;
    const tangentZ = horizontal > EPSILON ? flowX : 0;
    const centerX = target.x - world.width / 2 + 0.5 - flowX * 0.06;
    const centerZ = target.z - world.depth / 2 + 0.5 - flowZ * 0.06;
    const halfWidth = 0.055 + Math.min(0.16, intensity * 0.12 + event.flux * 0.04);
    const length = 0.1 + Math.min(0.28, amount * 0.08 + intensity * 0.13 + event.dropDistance * 0.028);
    const liftA = getFoamLift(target.x, target.z) * 0.55;
    const liftB = getFoamLift(target.z, target.x) * 0.55;
    const color = getHydraulicFoamColor(amount, intensity, event.kind);

    appendCurtainQuad(
      positions,
      colors,
      [centerX - tangentX * halfWidth - flowX * length * 0.35, surfaceY + liftA, centerZ - tangentZ * halfWidth - flowZ * length * 0.35],
      [centerX + tangentX * halfWidth - flowX * length * 0.25, surfaceY + liftB, centerZ + tangentZ * halfWidth - flowZ * length * 0.25],
      [centerX + tangentX * halfWidth * 0.62 + flowX * length, surfaceY + 0.006, centerZ + tangentZ * halfWidth * 0.62 + flowZ * length],
      [centerX - tangentX * halfWidth * 0.62 + flowX * length, surfaceY + 0.012, centerZ - tangentZ * halfWidth * 0.62 + flowZ * length],
      color,
      color,
    );
    faceCount += 1;
  }

  return faceCount;
}

function shouldRenderHydraulicEventFoam(event: HydraulicSpanEdgeEvent | HydraulicVisualEvent, intensity: number): boolean {
  return event.kind === "impact" && intensity > 0.52 && event.dropDistance > 0.55 && event.flux > 0.08;
}

function getHydraulicDisplayEvents(world: VoxelWorld): readonly (HydraulicSpanEdgeEvent | HydraulicVisualEvent)[] {
  return world.waterVisualEvents.length > 0 ? world.waterVisualEvents : world.waterEdgeEvents;
}

function getHydraulicEventDisplayIntensity(event: HydraulicSpanEdgeEvent | HydraulicVisualEvent): number {
  return "displayIntensity" in event ? event.displayIntensity : event.intensity;
}

function getHydraulicEventDisplayAmount(event: HydraulicSpanEdgeEvent | HydraulicVisualEvent): number {
  return "accumulatedAmount" in event ? Math.max(event.amount, Math.min(1.5, event.accumulatedAmount * 0.35)) : event.amount;
}

function getHydraulicEventFreshness(event: HydraulicSpanEdgeEvent | HydraulicVisualEvent): number {
  if (!("ageTicks" in event) || event.ttlTicks <= 0) {
    return 1;
  }

  return clamp01(1 - event.ageTicks / event.ttlTicks);
}

function isHydraulicEventAttachedToCurrentWater(
  world: VoxelWorld,
  event: HydraulicSpanEdgeEvent | HydraulicVisualEvent,
  target: { x: number; y: number; z: number },
  minWater: number,
): boolean {
  const currentSurfaceY = getHydraulicEventCurrentSurfaceY(world, event, target, minWater);
  return (
    currentSurfaceY !== null &&
    Math.abs(currentSurfaceY - event.targetSurfaceY) <= HYDRAULIC_EVENT_MAX_SURFACE_DRIFT &&
    !isTerrainBlockingWaterSheet(world, target.x, currentSurfaceY, target.z)
  );
}

function getHydraulicEventCurrentSurfaceY(
  world: VoxelWorld,
  event: HydraulicSpanEdgeEvent | HydraulicVisualEvent,
  target: { x: number; y: number; z: number },
  minWater: number,
): number | null {
  if (!isHorizontalInBounds(world, target.x, target.z) || world.solid[event.targetCellIndex] === 1) {
    return null;
  }

  const water = world.water[event.targetCellIndex];
  if (water < minWater) {
    return null;
  }

  return target.y + Math.min(1, water);
}

function appendHydraulicRibbon(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  dx: number,
  dz: number,
  topY: number,
  bottomY: number,
  amount: number,
  intensity: number,
): void {
  const centerX = x - world.width / 2 + 0.5 + dx * 0.32;
  const centerZ = z - world.depth / 2 + 0.5 + dz * 0.32;
  const horizontal = Math.hypot(dx, dz);
  const tangentX = horizontal > 0 ? -dz / horizontal : 1;
  const tangentZ = horizontal > 0 ? dx / horizontal : 0;
  const width = 0.08 + Math.min(0.16, amount * 0.13 + intensity * 0.08);
  const driftX = dx * (0.1 + intensity * 0.09) + (getCellVariation(x + 313, 17, z) - 0.5) * 0.08;
  const driftZ = dz * (0.1 + intensity * 0.09) + (getCellVariation(x, 19, z + 317) - 0.5) * 0.08;
  const topColor = getCurtainTopColor(x, z, Math.min(1, amount + intensity * 0.35));
  const bottomColor = eventRibbonBottomColor(amount, intensity);

  appendCurtainQuad(
    positions,
    colors,
    [centerX - tangentX * width, topY, centerZ - tangentZ * width],
    [centerX + tangentX * width, topY - getCurtainSag(x, z) * 0.45, centerZ + tangentZ * width],
    [centerX + tangentX * width * 0.58 + driftX, bottomY, centerZ + tangentZ * width * 0.58 + driftZ],
    [centerX - tangentX * width * 0.58 + driftX, bottomY + getCurtainSag(z, x) * 0.24, centerZ - tangentZ * width * 0.58 + driftZ],
    topColor,
    bottomColor,
  );
}

function appendWaterCurtains(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  debugMode: boolean,
  gameplayMode: boolean,
): number {
  let faceCount = 0;
  const topY = y + waterHeight + 0.01;
  const fallingCell = gameplayMode && !debugMode && isFallingWaterCell(world, x, y, z, waterHeight);

  if (!fallingCell) {
    for (const direction of SIDE_DIRECTIONS) {
      const neighborX = x + direction.dx;
      const neighborZ = z + direction.dz;
      if (isSolidWaterNeighbor(world, neighborX, y, neighborZ)) {
        continue;
      }

      const neighborAmount = getWaterAmountAt(world, neighborX, y, neighborZ);
      if (neighborAmount >= waterHeight - SIDE_CURTAIN_MIN_DROP) {
        continue;
      }

      const bottomY = y + Math.max(0.02, neighborAmount);
      if (topY - bottomY < 0.08) {
        continue;
      }

      appendSideCurtain(positions, colors, world, x, z, direction, topY, bottomY, waterHeight);
      faceCount += 1;
      if (
        gameplayMode &&
        !debugMode &&
        waterHeight >= EDGE_SHEET_MIN_AMOUNT &&
        hasStrongVerticalWaterDrop(world, x, y, z, waterHeight) &&
        hasActiveWaterMotion(world, x, y, z) &&
        neighborAmount < waterHeight - EDGE_SHEET_MIN_DROP &&
        !isTerrainBlockingWaterSheet(world, neighborX, y + waterHeight, neighborZ)
      ) {
        appendEdgeSheet(positions, colors, world, x, z, direction, topY, waterHeight, getWaterMotionSample(world, x, y, z).strength);
        faceCount += 1;
      }
    }
  }

  if (shouldStartFallingRibbon(world, x, y, z, waterHeight)) {
    const bottomY = findFallingRibbonBottomY(world, x, y, z);
    if (topY - bottomY >= 0.18) {
      appendFallingRibbon(positions, colors, world, x, z, topY, bottomY, "x", waterHeight);
      appendFallingRibbon(positions, colors, world, x, z, topY - 0.03, bottomY + 0.02, "z", waterHeight);
      faceCount += 2;
    }
  }

  return faceCount;
}

function appendGameplayWaterDrops(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  edgeCueMap: WaterEdgeCueMap,
): number {
  if (!ENABLE_GAMEPLAY_WATER_RIBBONS) {
    return 0;
  }

  let faceCount = 0;
  const topY = y + waterHeight + 0.01;
  const edgeCue = getWaterEdgeCueForCell(edgeCueMap, world, x, y, z);
  const solverDrop = edgeCue.kind === "fall" || edgeCue.kind === "impact";
  const verticalDrop = hasStrongVerticalWaterDrop(world, x, y, z, waterHeight);
  const eventVerticalDrop = solverDrop && edgeCue.direction.y < -0.25 && verticalDrop;
  const activeDrop = (verticalDrop && hasDownwardWaterMotion(world, x, y, z)) || (eventVerticalDrop && edgeCue.intensity > 0.28);

  if (activeDrop && shouldStartFallingRibbon(world, x, y, z, waterHeight)) {
    const bottomY = findFallingRibbonBottomY(world, x, y, z);
    if (topY - bottomY >= 0.18) {
      appendFallingRibbon(positions, colors, world, x, z, topY, bottomY, "x", waterHeight);
      appendFallingRibbon(positions, colors, world, x, z, topY - 0.03, bottomY + 0.02, "z", waterHeight);
      faceCount += 2;
    }
  }

  if (
    (!verticalDrop && edgeCue.kind === "none") ||
    (!hasActiveWaterMotion(world, x, y, z) && edgeCue.intensity <= 0.24) ||
    waterHeight < EDGE_SHEET_MIN_AMOUNT
  ) {
    return faceCount;
  }

  const motion = getWaterMotionSample(world, x, y, z);
  for (const direction of SIDE_DIRECTIONS) {
    if (!isFlowAlignedWithDirection(motion, direction) && !isEdgeCueAlignedWithDirection(edgeCue, direction)) {
      continue;
    }

    const neighborX = x + direction.dx;
    const neighborZ = z + direction.dz;
    if (isSolidWaterNeighbor(world, neighborX, y, neighborZ)) {
      continue;
    }

    const neighborAmount = getWaterAmountAt(world, neighborX, y, neighborZ);
    if (neighborAmount < waterHeight - EDGE_SHEET_MIN_DROP && !isTerrainBlockingWaterSheet(world, neighborX, y + waterHeight, neighborZ)) {
      appendEdgeSheet(positions, colors, world, x, z, direction, topY, waterHeight, Math.max(motion.strength, edgeCue.intensity));
      faceCount += 1;
    }
  }

  return faceCount;
}

function isFlowAlignedWithDirection(motion: WaterMotionSample, direction: SideDirection): boolean {
  if (motion.horizontal <= 0.08) {
    return motion.vertical > 0.14 || motion.kind === "turbulent";
  }

  const alignment = motion.x * direction.dx + motion.z * direction.dz;
  return alignment >= Math.max(0.04, motion.horizontal * 0.18);
}

function isEdgeCueAlignedWithDirection(cue: WaterEdgeCue, direction: SideDirection): boolean {
  if (cue.kind === "none" || cue.intensity <= 0.2) {
    return false;
  }

  const horizontal = Math.hypot(cue.direction.x, cue.direction.z);
  if (horizontal <= 0.05) {
    return false;
  }

  return cue.direction.x * direction.dx + cue.direction.z * direction.dz >= horizontal * 0.16;
}

function appendSideCurtain(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  direction: SideDirection,
  topY: number,
  bottomY: number,
  amount: number,
): void {
  const topColor = getCurtainTopColor(x, z, amount);
  const bottomColor = getCurtainBottomColor(x, z, amount);
  const ribbonCount = 2 + Math.floor(getCellVariation(x + 7, 43, z + 3) * 3);

  if (direction.axis === "x") {
    const faceX = x + (direction.side > 0 ? 1 : 0) - world.width / 2;
    const usable = 1 - CURTAIN_INSET * 2;
    for (let i = 0; i < ribbonCount; i += 1) {
      const slotStart = CURTAIN_INSET + (usable / ribbonCount) * i;
      const slotEnd = CURTAIN_INSET + (usable / ribbonCount) * (i + 1);
      const center = (slotStart + slotEnd) * 0.5 + (getCellVariation(x, i + 61, z) - 0.5) * 0.06;
      const halfWidth = ((slotEnd - slotStart) * (0.22 + getCellVariation(z, i + 71, x) * 0.22)) / 2;
      const minZ = z - world.depth / 2 + center - halfWidth;
      const maxZ = z - world.depth / 2 + center + halfWidth;
      appendCurtainQuad(
        positions,
        colors,
        [faceX, topY - getCurtainSag(x + i, z), minZ],
        [faceX, topY - getCurtainSag(x, z + i), maxZ],
        [faceX, bottomY, maxZ],
        [faceX, bottomY + getCurtainSag(z + i, x) * 0.5, minZ],
        topColor,
        bottomColor,
      );
    }
    return;
  }

  const faceZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2;
  const usable = 1 - CURTAIN_INSET * 2;
  for (let i = 0; i < ribbonCount; i += 1) {
    const slotStart = CURTAIN_INSET + (usable / ribbonCount) * i;
    const slotEnd = CURTAIN_INSET + (usable / ribbonCount) * (i + 1);
    const center = (slotStart + slotEnd) * 0.5 + (getCellVariation(z, i + 83, x) - 0.5) * 0.06;
    const halfWidth = ((slotEnd - slotStart) * (0.22 + getCellVariation(x, i + 97, z) * 0.22)) / 2;
    const minX = x - world.width / 2 + center - halfWidth;
    const maxX = x - world.width / 2 + center + halfWidth;
    appendCurtainQuad(
      positions,
      colors,
      [minX, topY - getCurtainSag(z + i, x), faceZ],
      [maxX, topY - getCurtainSag(z, x + i), faceZ],
      [maxX, bottomY, faceZ],
      [minX, bottomY + getCurtainSag(x + i, z) * 0.5, faceZ],
      topColor,
      bottomColor,
    );
  }
}

function appendEdgeSheet(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  direction: SideDirection,
  topY: number,
  amount: number,
  intensity: number,
): void {
  const color = getFoamColor(amount);
  const edgeY = topY + 0.018;
  const innerY = topY - 0.012;
  const inset = 0.12 + clamp01(intensity) * 0.08;
  const ribbonCount = 2 + Math.floor(clamp01(intensity) * 3);
  const usable = 0.78;
  const start = 0.11;

  if (direction.axis === "x") {
    const edgeX = x + (direction.side > 0 ? 1 : 0) - world.width / 2;
    const innerX = edgeX - direction.side * inset;
    for (let ribbonIndex = 0; ribbonIndex < ribbonCount; ribbonIndex += 1) {
      const slotStart = start + (usable / ribbonCount) * ribbonIndex;
      const slotEnd = start + (usable / ribbonCount) * (ribbonIndex + 1);
      const center = (slotStart + slotEnd) * 0.5 + (getCellVariation(x + ribbonIndex * 3, 211, z) - 0.5) * 0.06;
      const halfWidth = ((slotEnd - slotStart) * (0.28 + getCellVariation(z, 223 + ribbonIndex, x) * 0.28)) / 2;
      const minZ = z - world.depth / 2 + Math.max(0.06, center - halfWidth);
      const maxZ = z - world.depth / 2 + Math.min(0.94, center + halfWidth);
      appendCurtainQuad(
        positions,
        colors,
        [innerX, innerY + getFoamLift(x + ribbonIndex, z) * 0.35, minZ],
        [innerX, innerY + getFoamLift(x, z + ribbonIndex) * 0.35, maxZ],
        [edgeX, edgeY, maxZ],
        [edgeX, edgeY, minZ],
        color,
        color,
      );
    }
    return;
  }

  const edgeZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2;
  const innerZ = edgeZ - direction.side * inset;
  for (let ribbonIndex = 0; ribbonIndex < ribbonCount; ribbonIndex += 1) {
    const slotStart = start + (usable / ribbonCount) * ribbonIndex;
    const slotEnd = start + (usable / ribbonCount) * (ribbonIndex + 1);
    const center = (slotStart + slotEnd) * 0.5 + (getCellVariation(z + ribbonIndex * 3, 239, x) - 0.5) * 0.06;
    const halfWidth = ((slotEnd - slotStart) * (0.28 + getCellVariation(x, 251 + ribbonIndex, z) * 0.28)) / 2;
    const minX = x - world.width / 2 + Math.max(0.06, center - halfWidth);
    const maxX = x - world.width / 2 + Math.min(0.94, center + halfWidth);
    appendCurtainQuad(
      positions,
      colors,
      [minX, innerY + getFoamLift(z + ribbonIndex, x) * 0.35, innerZ],
      [maxX, innerY + getFoamLift(z, x + ribbonIndex) * 0.35, innerZ],
      [maxX, edgeY, edgeZ],
      [minX, edgeY, edgeZ],
      color,
      color,
    );
  }
}

function appendFallingRibbon(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  topY: number,
  bottomY: number,
  axis: "x" | "z",
  amount: number,
): void {
  const centerX = x - world.width / 2 + 0.5;
  const centerZ = z - world.depth / 2 + 0.5;
  const width = 0.34 + amount * 0.46;
  const swayX = (getCellVariation(x + 101, 19, z) - 0.5) * 0.42;
  const swayZ = (getCellVariation(x, 23, z + 107) - 0.5) * 0.42;
  const topColor = getCurtainTopColor(x + 5, z, amount);
  const bottomColor = getMistColor(amount);

  if (axis === "x") {
    appendCurtainQuad(
      positions,
      colors,
      [centerX - width, topY, centerZ],
      [centerX + width, topY - getCurtainSag(x, z), centerZ],
      [centerX + width * 0.72 + swayX, bottomY, centerZ + swayZ],
      [centerX - width * 0.72 + swayX, bottomY + getCurtainSag(z, x), centerZ + swayZ],
      topColor,
      bottomColor,
    );
    return;
  }

  appendCurtainQuad(
    positions,
    colors,
    [centerX, topY, centerZ - width],
    [centerX, topY - getCurtainSag(z, x), centerZ + width],
    [centerX + swayX, bottomY, centerZ + width * 0.72 + swayZ],
    [centerX + swayX, bottomY + getCurtainSag(x, z), centerZ - width * 0.72 + swayZ],
    topColor,
    bottomColor,
  );
}

function appendShoreFoamStrips(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  edgeCueMap: WaterEdgeCueMap,
): number {
  let faceCount = 0;
  const topY = y + waterHeight + 0.052;

  for (const direction of SIDE_DIRECTIONS) {
    const cue = getShorelineCue(world, x, y, z, direction, waterHeight, edgeCueMap);
    if (!cue?.foam) {
      continue;
    }

    const variation = getCellVariation(x + direction.dx * 23, y + 109, z + direction.dz * 29);
    const breakInset = 0.06 + variation * 0.08;
    const width = cue.width;
    const foamColor = getShoreFoamColor(waterHeight, cue.intensity);

    if (direction.axis === "x") {
      const edgeX = x + (direction.side > 0 ? 1 : 0) - world.width / 2;
      const innerX = edgeX - direction.side * width;
      const minZ = z - world.depth / 2 + breakInset;
      const maxZ = z - world.depth / 2 + 1 - breakInset * 0.65;
      appendCurtainQuad(
        positions,
        colors,
        [innerX, topY + getFoamLift(x, z), minZ],
        [innerX, topY + getFoamLift(x + 1, z), maxZ],
        [edgeX - direction.side * SHORE_FOAM_INSET, topY + 0.018, maxZ],
        [edgeX - direction.side * SHORE_FOAM_INSET, topY + 0.012, minZ],
        foamColor,
        foamColor,
      );
    } else {
      const edgeZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2;
      const innerZ = edgeZ - direction.side * width;
      const minX = x - world.width / 2 + breakInset;
      const maxX = x - world.width / 2 + 1 - breakInset * 0.65;
      appendCurtainQuad(
        positions,
        colors,
        [minX, topY + getFoamLift(z, x), innerZ],
        [maxX, topY + getFoamLift(z + 1, x), innerZ],
        [maxX, topY + 0.018, edgeZ - direction.side * SHORE_FOAM_INSET],
        [minX, topY + 0.012, edgeZ - direction.side * SHORE_FOAM_INSET],
        foamColor,
        foamColor,
      );
    }

    faceCount += 1;
  }

  return faceCount;
}

function appendShorelineSkirts(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  edgeCueMap: WaterEdgeCueMap,
): number {
  let faceCount = 0;
  const topY = y + waterHeight + 0.018;

  for (const direction of SIDE_DIRECTIONS) {
    const cue = getShorelineCue(world, x, y, z, direction, waterHeight, edgeCueMap);
    if (!cue?.skirt) {
      continue;
    }

    const bottomY = Math.max(y + 0.02, topY - SHORE_SKIRT_DROP * (0.45 + cue.intensity * 0.65));
    const topColor = getCurtainTopColor(x, z, waterHeight);
    const bottomColor = getCurtainBottomColor(x, z, waterHeight * (0.45 + cue.intensity * 0.35));
    appendShorelineContactBand(positions, colors, world, x, z, direction, topY, waterHeight, cue);

    if (direction.axis === "x") {
      const edgeX = x + (direction.side > 0 ? 1 : 0) - world.width / 2 + direction.side * SHORE_CONTACT_OVERLAP;
      const minZ = z - world.depth / 2 - SHORE_CONTACT_OVERLAP;
      const maxZ = z - world.depth / 2 + 1 + SHORE_CONTACT_OVERLAP;
      appendCurtainQuad(
        positions,
        colors,
        [edgeX, topY, minZ],
        [edgeX, topY - getCurtainSag(x, z), maxZ],
        [edgeX, bottomY, maxZ],
        [edgeX, bottomY + getCurtainSag(z, x) * 0.35, minZ],
        topColor,
        bottomColor,
      );
    } else {
      const edgeZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2 + direction.side * SHORE_CONTACT_OVERLAP;
      const minX = x - world.width / 2 - SHORE_CONTACT_OVERLAP;
      const maxX = x - world.width / 2 + 1 + SHORE_CONTACT_OVERLAP;
      appendCurtainQuad(
        positions,
        colors,
        [minX, topY, edgeZ],
        [maxX, topY - getCurtainSag(z, x), edgeZ],
        [maxX, bottomY, edgeZ],
        [minX, bottomY + getCurtainSag(x, z) * 0.35, edgeZ],
        topColor,
        bottomColor,
      );
    }

    faceCount += 1;
  }

  return faceCount;
}

function appendShorelineContactBand(
  positions: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  direction: SideDirection,
  topY: number,
  waterHeight: number,
  cue: ShorelineCue,
): void {
  const color = getShoreBlendColor(waterHeight, cue.intensity);
  const width = 0.18 + cue.intensity * 0.12;
  const min = -SHORE_CONTACT_OVERLAP;
  const max = 1 + SHORE_CONTACT_OVERLAP;

  if (direction.axis === "x") {
    const edgeX = x + (direction.side > 0 ? 1 : 0) - world.width / 2 + direction.side * SHORE_CONTACT_OVERLAP;
    const innerX = edgeX - direction.side * width;
    const minZ = z - world.depth / 2 + min;
    const maxZ = z - world.depth / 2 + max;
    appendCurtainQuad(
      positions,
      colors,
      [innerX, topY + 0.01, minZ],
      [innerX, topY + 0.006, maxZ],
      [edgeX, topY + 0.002, maxZ],
      [edgeX, topY + 0.006, minZ],
      color,
      color,
    );
    return;
  }

  const edgeZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2 + direction.side * SHORE_CONTACT_OVERLAP;
  const innerZ = edgeZ - direction.side * width;
  const minX = x - world.width / 2 + min;
  const maxX = x - world.width / 2 + max;
  appendCurtainQuad(
    positions,
    colors,
    [minX, topY + 0.01, innerZ],
    [maxX, topY + 0.006, innerZ],
    [maxX, topY + 0.002, edgeZ],
    [minX, topY + 0.006, edgeZ],
    color,
    color,
  );
}

function appendWaterParticleCue(
  renderer: WaterRenderer,
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  edgeCue: WaterEdgeCue,
  sprayCount: number,
): number {
  const cue = getWaterParticleCue(world, x, y, z, waterHeight, edgeCue);
  if (cue.kind === "none" || cue.kind === "jet" || cue.intensity <= 0.55) {
    return sprayCount;
  }

  const variation = getCellVariation(x + 151, y + 157, z + 163);
  const impactStrength = Math.max(getImpactVisualStrength(world, x, y, z, waterHeight, cue.surfaceEnergy), edgeCue.intensity * 0.82);
  if (variation > Math.min(0.38, cue.intensity * 0.13 + impactStrength * 0.16)) {
    return sprayCount;
  }

  const center = cellCenter(world, x, y, z);
  const scale = 0.055 + cue.intensity * 0.12 + impactStrength * 0.12;
  sprayDummy.position.set(
    center.x + cue.direction.x * 0.16 + (variation - 0.5) * 0.16,
    y + waterHeight + 0.1 + Math.max(0, -cue.direction.y) * 0.12,
    center.z + cue.direction.z * 0.16 + (getCellVariation(z + 167, y, x + 173) - 0.5) * 0.16,
  );
  sprayDummy.rotation.set(-Math.PI / 2 + cue.direction.z * 0.38, cue.direction.x * 0.34, variation * Math.PI * 2);
  sprayDummy.scale.set(
    scale * (1.15 + cue.surfaceEnergy * 0.4 + impactStrength * 0.5),
    scale * (0.68 + variation * 0.4 + impactStrength * 0.25),
    1,
  );
  sprayDummy.updateMatrix();
  renderer.sprayBatch.pushMatrix(sprayDummy.matrix);
  return sprayCount + 1;
}

function getImpactVisualStrength(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  surfaceEnergy: number,
): number {
  if (!hasStrongVerticalWaterDrop(world, x, y, z, waterHeight)) {
    return clamp01(surfaceEnergy);
  }

  const topY = y + waterHeight;
  const bottomY = findFallingRibbonBottomY(world, x, y, z);
  return clamp01((topY - bottomY) / 6 + surfaceEnergy * 0.45);
}

export function getWaterSurfaceMeshDebugStats(world: VoxelWorld): WaterSurfaceMeshDebugStats {
  const cells = collectDebugSurfaceCells(world);
  const surfaceState: SurfaceHeightState = {
    surfaceHeightMemory: new Map(),
    surfaceFieldMemory: new Map(),
    surfaceHeightMemorySizeKey: getSurfaceMemorySizeKey(world),
  };
  const { geometry } = buildPoolSurfaceGeometry(surfaceState, world, cells);
  const position = geometry.getAttribute("position") as Float32BufferAttribute | undefined;
  const index = geometry.getIndex();
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let finite = true;

  if (position) {
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      finite = finite && Number.isFinite(position.getX(i)) && Number.isFinite(y) && Number.isFinite(position.getZ(i));
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  const stats = {
    vertexCount: position?.count ?? 0,
    triangleCount: Math.floor((index?.count ?? 0) / 3),
    minY: minY === Number.POSITIVE_INFINITY ? 0 : minY,
    maxY: maxY === Number.NEGATIVE_INFINITY ? 0 : maxY,
    finite,
  };
  geometry.dispose();
  return stats;
}

function collectDebugSurfaceCells(world: VoxelWorld): SurfaceCell[] {
  const cells: SurfaceCell[] = [];
  const layerSize = world.width * world.depth;
  const columnSurfaceCache = new Map<string, ColumnSurfaceSample | null>();

  for (const cellIndex of world.wetCells) {
    const y = Math.floor(cellIndex / layerSize);
    const layerIndex = cellIndex - y * layerSize;
    const z = Math.floor(layerIndex / world.width);
    const x = layerIndex - z * world.width;
    const amount = world.water[cellIndex];
    if (
      amount > EPSILON &&
      world.solid[cellIndex] !== 1 &&
      shouldRenderWaterCell(world, x, y, z, amount, false, true) &&
      shouldRenderWaterSurface(world, x, y, z, amount, false, true)
    ) {
      const surfaceCell = createSurfaceCell(world, x, y, z, columnSurfaceCache);
      if (surfaceCell) {
        cells.push(surfaceCell);
      }
    }
  }

  return cells;
}

function createSurfaceCell(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  columnSurfaceCache: Map<string, ColumnSurfaceSample | null>,
): SurfaceCell | null {
  const column = getColumnSurfaceSample(world, x, y, z, columnSurfaceCache);
  if (!column) {
    return null;
  }

  return {
    x,
    y,
    z,
    waterHeight: Math.max(0.05, Math.min(1, column.surfaceY - y)),
    surfaceY: column.surfaceY,
    columnDepth: column.columnDepth,
    spanBottomY: column.bottomY,
    spanTopY: column.topY,
    spanKey: column.spanKey,
    motion: getWaterMotionSample(world, x, y, z),
  };
}

function getColumnSurfaceSample(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  cache: Map<string, ColumnSurfaceSample | null>,
): ColumnSurfaceSample | null {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return null;
  }

  let bottomY = y;
  while (bottomY > 0 && isSurfaceColumnWaterCell(world, x, bottomY - 1, z)) {
    bottomY -= 1;
  }

  let topY = y;
  while (topY + 1 < world.height && isSurfaceColumnWaterCell(world, x, topY + 1, z)) {
    topY += 1;
  }

  const spanKey = `${x}:${z}:${bottomY}:${topY}`;
  const cached = cache.get(spanKey);
  if (cached !== undefined) {
    return cached;
  }

  buildConnectedColumnSurfaceSamples(world, { x, z, bottomY, topY }, cache);
  return cache.get(spanKey) ?? null;
}

function buildConnectedColumnSurfaceSamples(
  world: VoxelWorld,
  seed: { x: number; z: number; bottomY: number; topY: number },
  cache: Map<string, ColumnSurfaceSample | null>,
): void {
  const seedKey = getColumnSpanKey(seed.x, seed.z, seed.bottomY, seed.topY);
  const component = new Map<string, SurfaceComponentSpan>();
  const queue = [seed];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const span = queue[queueIndex];
    const spanKey = getColumnSpanKey(span.x, span.z, span.bottomY, span.topY);
    if (component.has(spanKey)) {
      continue;
    }

    const volume = getSurfaceSpanVolume(world, span.x, span.z, span.bottomY, span.topY);
    if (volume <= EPSILON) {
      cache.set(spanKey, null);
      continue;
    }

    component.set(spanKey, {
      ...span,
      spanKey,
      volume,
      capacity: span.topY - span.bottomY + 1,
    });

    for (const direction of SIDE_DIRECTIONS) {
      for (const neighbor of findOverlappingSurfaceSpans(world, span, span.x + direction.dx, span.z + direction.dz)) {
        const neighborKey = getColumnSpanKey(neighbor.x, neighbor.z, neighbor.bottomY, neighbor.topY);
        if (!component.has(neighborKey) && cache.get(neighborKey) === undefined) {
          queue.push(neighbor);
        }
      }
    }
  }

  if (component.size === 0) {
    cache.set(seedKey, null);
    return;
  }

  const waterline = solveComponentWaterline(Array.from(component.values()));
  for (const span of component.values()) {
    const columnDepth = Math.min(span.capacity, Math.max(0, waterline - span.bottomY));
    if (columnDepth <= EPSILON) {
      cache.set(span.spanKey, null);
      continue;
    }

    cache.set(span.spanKey, {
      surfaceY: span.bottomY + columnDepth,
      columnDepth,
      bottomY: span.bottomY,
      topY: span.topY,
      spanKey: span.spanKey,
    });
  }
}

function findOverlappingSurfaceSpans(
  world: VoxelWorld,
  source: { bottomY: number; topY: number },
  targetX: number,
  targetZ: number,
): { x: number; z: number; bottomY: number; topY: number }[] {
  const spans: { x: number; z: number; bottomY: number; topY: number }[] = [];
  if (!isHorizontalInBounds(world, targetX, targetZ)) {
    return spans;
  }

  let y = source.bottomY;
  while (y <= source.topY) {
    if (!isSurfaceColumnWaterCell(world, targetX, y, targetZ)) {
      y += 1;
      continue;
    }

    const span = findSurfaceWaterSpan(world, targetX, y, targetZ);
    if (!span) {
      y += 1;
      continue;
    }

    if (getSurfaceSpanVolume(world, span.x, span.z, span.bottomY, span.topY) > EPSILON) {
      spans.push(span);
    }
    y = span.topY + 1;
  }

  return spans;
}

function findSurfaceWaterSpan(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
): { x: number; z: number; bottomY: number; topY: number } | null {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth || !isSurfaceColumnWaterCell(world, x, y, z)) {
    return null;
  }

  let bottomY = y;
  while (bottomY > 0 && isSurfaceColumnWaterCell(world, x, bottomY - 1, z)) {
    bottomY -= 1;
  }

  let topY = y;
  while (topY + 1 < world.height && isSurfaceColumnWaterCell(world, x, topY + 1, z)) {
    topY += 1;
  }

  return { x, z, bottomY, topY };
}

function getSurfaceSpanVolume(world: VoxelWorld, x: number, z: number, bottomY: number, topY: number): number {
  let volume = 0;
  for (let y = bottomY; y <= topY; y += 1) {
    volume += getWaterAmountAt(world, x, y, z);
  }
  return volume;
}

function solveComponentWaterline(spans: SurfaceComponentSpan[]): number {
  const totalVolume = spans.reduce((total, span) => total + span.volume, 0);
  let low = Math.min(...spans.map((span) => span.bottomY));
  let high = Math.max(...spans.map((span) => span.topY + 1));

  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) * 0.5;
    const volumeAtMid = spans.reduce((total, span) => total + Math.min(span.capacity, Math.max(0, mid - span.bottomY)), 0);
    if (volumeAtMid < totalVolume) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return high;
}

function isSurfaceColumnWaterCell(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return getWaterAmountAt(world, x, y, z) > EPSILON;
}

function replacePoolSurfaceGeometry(renderer: WaterRenderer, world: VoxelWorld, cells: SurfaceCell[]): void {
  const { geometry, activeHeightKeys } = buildPoolSurfaceGeometry(renderer, world, cells);
  renderer.surfaceMesh.geometry.dispose();
  renderer.surfaceMesh.geometry = geometry;
  pruneSurfaceHeightMemory(renderer, activeHeightKeys);
}

function buildPoolSurfaceGeometry(
  surfaceState: SurfaceHeightState,
  world: VoxelWorld,
  cells: SurfaceCell[],
): { geometry: BufferGeometry; activeHeightKeys: Set<string> } {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexIndices = new Map<string, number>();
  const activeHeightKeys = new Set<string>();

  if (surfaceState.surfaceHeightMemorySizeKey !== getSurfaceMemorySizeKey(world)) {
    surfaceState.surfaceHeightMemory.clear();
    surfaceState.surfaceFieldMemory.clear();
    surfaceState.surfaceHeightMemorySizeKey = getSurfaceMemorySizeKey(world);
  }
  const surfaceBuildState: SurfaceBuildState = {
    surfaceHeightMemory: surfaceState.surfaceHeightMemory,
    surfaceFieldMemory: surfaceState.surfaceFieldMemory,
    surfaceHeightMemorySizeKey: surfaceState.surfaceHeightMemorySizeKey,
    columnSurfaceCache: new Map(),
  };

  const getSharedVertexIndex = (vertex: SurfaceVertex): number => {
    const key = getSurfaceVertexKey(vertex);
    const existing = vertexIndices.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const index = positions.length / 3;
    positions.push(vertex.x - world.width / 2, vertex.y, vertex.z - world.depth / 2);
    normals.push(0, 1, 0);
    colors.push(vertex.color.r, vertex.color.g, vertex.color.b);
    uvs.push(vertex.x * 0.22, vertex.z * 0.22);
    vertexIndices.set(key, index);
    return index;
  };

  for (const layer of getSurfaceLayers(cells)) {
    const bounds = getSurfaceLayerBounds(layer);
    const layerCells = new Map<string, SurfaceCell>();
    const sampleCache = new Map<string, SurfaceSample>();

    for (const cell of layer) {
      layerCells.set(getSurfaceCellKey(cell.x, cell.z), cell);
    }
    addOpenWaterBridgeSurfaceCells(world, layerCells, bounds);

    const getSample = (x: number, z: number): SurfaceSample => {
      const key = getSurfaceCellKey(x, z);
      const cached = sampleCache.get(key);
      if (cached) {
        return cached;
      }

      const sample = createSurfaceSample(surfaceBuildState, world, layerCells, layer[0].y, x, z, activeHeightKeys);
      sampleCache.set(key, sample);
      return sample;
    };

    for (let z = bounds.minZ - 1; z <= bounds.maxZ; z += 1) {
      for (let x = bounds.minX - 1; x <= bounds.maxX; x += 1) {
        const polygons = getSurfaceSquarePolygons([
          sampleToSurfaceVertex(getSample(x, z)),
          sampleToSurfaceVertex(getSample(x + 1, z)),
          sampleToSurfaceVertex(getSample(x + 1, z + 1)),
          sampleToSurfaceVertex(getSample(x, z + 1)),
        ]);

        for (const polygon of polygons) {
          if (polygon.length < 3) {
            continue;
          }

          const baseIndex = getSharedVertexIndex(polygon[0]);
          for (let i = 1; i < polygon.length - 1; i += 1) {
            indices.push(baseIndex, getSharedVertexIndex(polygon[i]), getSharedVertexIndex(polygon[i + 1]));
          }
        }
      }
    }
  }

  const nextGeometry = new BufferGeometry();
  nextGeometry.setIndex(indices);
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  nextGeometry.computeBoundingSphere();
  return { geometry: nextGeometry, activeHeightKeys };
}

function addOpenWaterBridgeSurfaceCells(
  world: VoxelWorld,
  layerCells: Map<string, SurfaceCell>,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): void {
  for (let pass = 0; pass < 2; pass += 1) {
    const bridgeCells: SurfaceCell[] = [];

    for (let z = bounds.minZ - 1; z <= bounds.maxZ + 1; z += 1) {
      for (let x = bounds.minX - 1; x <= bounds.maxX + 1; x += 1) {
        if (layerCells.has(getSurfaceCellKey(x, z))) {
          continue;
        }

        const neighbors = getNeighborSurfaceCells(layerCells, x, z);
        if (neighbors.length < (pass === 0 ? 2 : 1)) {
          continue;
        }

        const surfaceY = averageSurfaceValue(neighbors, (cell) => cell.surfaceY);
        if (
          !isHorizontalInBounds(world, x, z) ||
          isTerrainBlockingWaterSheet(world, x, surfaceY, z) ||
          neighbors.every((cell) => Math.abs(cell.surfaceY - surfaceY) > SURFACE_LAYER_MAX_STEP * 0.72)
        ) {
          continue;
        }

        const y = clampInt(Math.floor(surfaceY - EPSILON), 0, world.height - 1);
        if (isSolidWaterNeighbor(world, x, y, z)) {
          continue;
        }

        bridgeCells.push({
          x,
          y,
          z,
          waterHeight: Math.max(0.05, Math.min(1, averageSurfaceValue(neighbors, (cell) => cell.waterHeight))),
          surfaceY,
          columnDepth: averageSurfaceValue(neighbors, (cell) => cell.columnDepth),
          spanBottomY: Math.min(...neighbors.map((cell) => cell.spanBottomY)),
          spanTopY: Math.max(...neighbors.map((cell) => cell.spanTopY)),
          spanKey: `bridge:${x}:${z}:${Math.round(surfaceY * SURFACE_VERTEX_KEY_SCALE)}`,
          motion: neighbors[0].motion,
        });
      }
    }

    for (const cell of bridgeCells) {
      layerCells.set(getSurfaceCellKey(cell.x, cell.z), cell);
    }
  }
}

function getNeighborSurfaceCells(cells: Map<string, SurfaceCell>, x: number, z: number): SurfaceCell[] {
  const neighbors: SurfaceCell[] = [];

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dz === 0) {
        continue;
      }

      const neighbor = cells.get(getSurfaceCellKey(x + dx, z + dz));
      if (neighbor) {
        neighbors.push(neighbor);
      }
    }
  }

  return neighbors;
}

function averageSurfaceValue(cells: SurfaceCell[], read: (cell: SurfaceCell) => number): number {
  return cells.reduce((total, cell) => total + read(cell), 0) / Math.max(1, cells.length);
}

function getSurfaceLayers(cells: SurfaceCell[]): SurfaceCell[][] {
  const columns = new Map<string, SurfaceCell[]>();
  const bySpan = new Map<string, SurfaceCell>();
  const visited = new Set<string>();
  const layers: SurfaceCell[][] = [];

  for (const cell of cells) {
    const column = columns.get(getSurfaceCellKey(cell.x, cell.z));
    if (column) {
      column.push(cell);
    } else {
      columns.set(getSurfaceCellKey(cell.x, cell.z), [cell]);
    }
    bySpan.set(cell.spanKey, cell);
  }

  for (const column of columns.values()) {
    column.sort((a, b) => b.surfaceY - a.surfaceY);
  }

  for (const cell of bySpan.values()) {
    if (visited.has(cell.spanKey)) {
      continue;
    }

    const layer: SurfaceCell[] = [];
    const queue = [cell];
    visited.add(cell.spanKey);

    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const current = queue[queueIndex];
      layer.push(current);

      for (const direction of SIDE_DIRECTIONS) {
        const neighborColumn = columns.get(getSurfaceCellKey(current.x + direction.dx, current.z + direction.dz));
        if (!neighborColumn) {
          continue;
        }

        for (const neighbor of neighborColumn) {
          if (visited.has(neighbor.spanKey) || !canShareSurfaceLayer(current, neighbor)) {
            continue;
          }

          visited.add(neighbor.spanKey);
          queue.push(neighbor);
        }
      }
    }

    layers.push(layer);
  }

  return layers;
}

function canShareSurfaceLayer(a: SurfaceCell, b: SurfaceCell): boolean {
  if (a.spanKey === b.spanKey) {
    return true;
  }

  if (a.x === b.x && a.z === b.z) {
    return false;
  }

  return Math.abs(a.surfaceY - b.surfaceY) <= SURFACE_LAYER_MAX_STEP;
}

function getSurfaceLayerBounds(cells: SurfaceCell[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minZ = Math.min(minZ, cell.z);
    maxZ = Math.max(maxZ, cell.z);
  }

  return { minX, maxX, minZ, maxZ };
}

function createSurfaceSample(
  surfaceState: SurfaceBuildState,
  world: VoxelWorld,
  cells: Map<string, SurfaceCell>,
  y: number,
  x: number,
  z: number,
  activeHeightKeys: Set<string>,
): SurfaceSample {
  const cell = cells.get(getSurfaceCellKey(x, z));
  if (cell) {
    const targetHeight = getSurfaceCellCenterY(world, cell);
    const heightKey = cell.spanKey;
    const previousHeight = surfaceState.surfaceHeightMemory.get(heightKey);
    const height =
      previousHeight === undefined || Math.abs(targetHeight - previousHeight) > SURFACE_MEMORY_SNAP_DELTA
        ? targetHeight
        : previousHeight + (targetHeight - previousHeight) * SURFACE_MEMORY_ALPHA;
    surfaceState.surfaceHeightMemory.set(heightKey, height);
    activeHeightKeys.add(heightKey);
    const terrainOcclusion = getSurfaceTerrainOcclusion(world, cell);
    return {
      x: x + 0.5,
      y,
      z: z + 0.5,
      value: smoothSurfaceFieldValue(surfaceState, heightKey, getWetSurfaceFieldTarget(world, cell), activeHeightKeys),
      height,
      color: getSmoothedSurfaceCellColor(cells, cell),
      terrainContact: terrainOcclusion >= SURFACE_TERRAIN_OCCLUSION_START || hasRenderedTerrainContactNearSurface(world, cell),
    };
  }

  return createDrySurfaceSample(surfaceState, world, cells, y, x, z, activeHeightKeys);
}

function createDrySurfaceSample(
  surfaceState: SurfaceBuildState,
  world: VoxelWorld,
  cells: Map<string, SurfaceCell>,
  y: number,
  x: number,
  z: number,
  activeHeightKeys: Set<string>,
): SurfaceSample {
  let heightTotal = 0;
  let wetFieldTotal = 0;
  let wetCenterXTotal = 0;
  let wetCenterZTotal = 0;
  let colorTotal: Rgb = { r: 0, g: 0, b: 0 };
  let count = 0;

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const cell = cells.get(getSurfaceCellKey(x + dx, z + dz));
      if (!cell) {
        continue;
      }

      heightTotal += getSurfaceCellCenterY(world, cell);
      wetFieldTotal += getWetSurfaceFieldTarget(world, cell);
      wetCenterXTotal += cell.x + 0.5;
      wetCenterZTotal += cell.z + 0.5;
      const color = getSurfaceCellColor(cell);
      colorTotal = addRgb(colorTotal, color);
      count += 1;
    }
  }

  const fallbackColor = { r: 0.05, g: 0.31, b: 0.5 };
  const terrainContact = count > 0 && isTerrainContactSurfaceSample(world, cells, x, z);
  const fieldKey = getSurfaceHeightMemoryKey(y, x, z);
  const targetValue = getDrySurfaceFieldTarget(terrainContact, count, count > 0 ? wetFieldTotal / count : 0);
  const value = smoothSurfaceFieldValue(surfaceState, fieldKey, targetValue, activeHeightKeys);
  const dryX = x + 0.5;
  const dryZ = z + 0.5;
  const openWaterBias = !terrainContact && count > 0 ? 0.12 : 0;
  const sampleX = openWaterBias > 0 ? dryX + (wetCenterXTotal / count - dryX) * openWaterBias : dryX;
  const sampleZ = openWaterBias > 0 ? dryZ + (wetCenterZTotal / count - dryZ) * openWaterBias : dryZ;
  return {
    x: sampleX,
    y,
    z: sampleZ,
    value,
    height: count > 0 ? heightTotal / count : y,
    color: count > 0 ? scaleRgb(colorTotal, 1 / count) : fallbackColor,
    terrainContact,
  };
}

function getDrySurfaceFieldTarget(terrainContact: boolean, nearbyWaterCount: number, nearbyWetFieldValue: number): number {
  if (nearbyWaterCount <= 0) {
    return 0;
  }

  if (terrainContact) {
    return Math.max(0, Math.min(SURFACE_TERRAIN_CONTACT_VALUE, SURFACE_ISO_LEVEL * 2 - nearbyWetFieldValue));
  }

  if (nearbyWaterCount >= 5) {
    return Math.max(SURFACE_ISO_LEVEL + 0.12, nearbyWetFieldValue * 0.62);
  }

  if (nearbyWaterCount >= 4) {
    return Math.max(SURFACE_ISO_LEVEL + 0.04, nearbyWetFieldValue * 0.52);
  }

  if (nearbyWaterCount >= 3) {
    return Math.max(SURFACE_ISO_LEVEL + 0.01, nearbyWetFieldValue * 0.42);
  }

  return nearbyWaterCount >= 2 ? Math.max(SURFACE_ISO_LEVEL + 0.005, nearbyWetFieldValue * 0.32) : 0;
}

function isTerrainContactSurfaceSample(
  world: VoxelWorld,
  cells: Map<string, SurfaceCell>,
  x: number,
  z: number,
): boolean {
  for (let dz = -1; dz <= 0; dz += 1) {
    for (let dx = -1; dx <= 0; dx += 1) {
      const wetCell = cells.get(getSurfaceCellKey(x + dx, z + dz));
      if (!wetCell) {
        continue;
      }

      if (hasRenderedTerrainContactNearSurface(world, wetCell)) {
        return true;
      }
    }
  }

  return false;
}

function hasRenderedTerrainContactNearSurface(world: VoxelWorld, cell: SurfaceCell): boolean {
  const surfaceY = Math.min(world.height - 1, Math.max(0, Math.floor(cell.surfaceY - EPSILON)));
  const minY = Math.max(0, Math.min(surfaceY, cell.y) - 1);
  const maxY = Math.min(world.height - 1, Math.max(surfaceY, cell.y) + 1);

  for (let sampleY = minY; sampleY <= maxY; sampleY += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dz === 0) {
          continue;
        }

        if (isSolidWaterNeighbor(world, cell.x + dx, sampleY, cell.z + dz)) {
          return true;
        }
      }
    }
  }

  return hasOrganicTerrainIsoContact(world, cell.x, surfaceY, cell.z);
}

function hasOrganicTerrainIsoContact(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const minNodeY = Math.max(0, y);
  const maxNodeY = Math.min(world.height, y + 2);
  for (let nodeY = minNodeY; nodeY <= maxNodeY; nodeY += 1) {
    for (let nodeZ = z; nodeZ <= z + 1; nodeZ += 1) {
      for (let nodeX = x; nodeX <= x + 1; nodeX += 1) {
        if (getOrganicTerrainNodeDensity(world, nodeX, nodeY, nodeZ) >= ORGANIC_TERRAIN_ISO_LEVEL) {
          return true;
        }
      }
    }
  }

  return false;
}

function getOrganicTerrainNodeDensity(world: VoxelWorld, nodeX: number, nodeY: number, nodeZ: number): number {
  return getTerrainNodeDensity(world, undefined, nodeX, nodeY, nodeZ);
}

function sampleToSurfaceVertex(sample: SurfaceSample): SurfaceVertex {
  return {
    x: sample.x,
    y: sample.height,
    z: sample.z,
    value: sample.value,
    color: sample.color,
    terrainContact: sample.terrainContact,
  };
}

function getWetSurfaceFieldTarget(world: VoxelWorld, cell: SurfaceCell): number {
  return getSurfaceFieldValue(cell.waterHeight) * getSurfaceTerrainVisibility(getSurfaceTerrainOcclusion(world, cell));
}

function getSurfaceVertexKey(vertex: SurfaceVertex): string {
  return `${Math.round(vertex.x * SURFACE_VERTEX_KEY_SCALE)}:${Math.round(vertex.y * SURFACE_VERTEX_KEY_SCALE)}:${Math.round(
    vertex.z * SURFACE_VERTEX_KEY_SCALE,
  )}`;
}

function getSurfaceSquarePolygons(vertices: SurfaceVertex[]): SurfaceVertex[][] {
  const inside = vertices.map((vertex) => vertex.value >= SURFACE_ISO_LEVEL);
  if (inside[0] && inside[2] && !inside[1] && !inside[3]) {
    if (shouldBridgeOpenWaterAmbiguousSquare(vertices)) {
      return [vertices];
    }
    return [
      [vertices[0], interpolateSurfaceVertex(vertices[0], vertices[1]), interpolateSurfaceVertex(vertices[0], vertices[3])],
      [vertices[2], interpolateSurfaceVertex(vertices[2], vertices[3]), interpolateSurfaceVertex(vertices[2], vertices[1])],
    ];
  }

  if (inside[1] && inside[3] && !inside[0] && !inside[2]) {
    if (shouldBridgeOpenWaterAmbiguousSquare(vertices)) {
      return [vertices];
    }
    return [
      [vertices[1], interpolateSurfaceVertex(vertices[1], vertices[2]), interpolateSurfaceVertex(vertices[1], vertices[0])],
      [vertices[3], interpolateSurfaceVertex(vertices[3], vertices[0]), interpolateSurfaceVertex(vertices[3], vertices[2])],
    ];
  }

  const polygon = clipSurfacePolygon(vertices);
  return polygon.length >= 3 ? [polygon] : [];
}

function shouldBridgeOpenWaterAmbiguousSquare(vertices: SurfaceVertex[]): boolean {
  if (vertices.some((vertex) => vertex.terrainContact)) {
    return false;
  }

  const averageValue = vertices.reduce((total, vertex) => total + vertex.value, 0) / vertices.length;
  return averageValue >= SURFACE_ISO_LEVEL * 0.72;
}

function clipSurfacePolygon(vertices: SurfaceVertex[]): SurfaceVertex[] {
  const clipped: SurfaceVertex[] = [];

  for (let i = 0; i < vertices.length; i += 1) {
    const current = vertices[i];
    const previous = vertices[(i + vertices.length - 1) % vertices.length];
    const currentInside = current.value >= SURFACE_ISO_LEVEL;
    const previousInside = previous.value >= SURFACE_ISO_LEVEL;

    if (currentInside) {
      if (!previousInside) {
        clipped.push(interpolateSurfaceVertex(previous, current));
      }
      clipped.push(current);
    } else if (previousInside) {
      clipped.push(interpolateSurfaceVertex(previous, current));
    }
  }

  return clipped;
}

function interpolateSurfaceVertex(a: SurfaceVertex, b: SurfaceVertex): SurfaceVertex {
  const range = b.value - a.value;
  const t = Math.abs(range) <= EPSILON ? 0.5 : Math.min(1, Math.max(0, (SURFACE_ISO_LEVEL - a.value) / range));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    value: SURFACE_ISO_LEVEL,
    color: lerpRgb(a.color, b.color, t),
    terrainContact: a.terrainContact || b.terrainContact,
  };
}

function getSurfaceTerrainOcclusion(world: VoxelWorld, cell: SurfaceCell): number {
  const surfaceNodeY = clampInt(Math.floor(cell.surfaceY), 0, world.height);
  let total = 0;
  let count = 0;

  for (let nodeY = surfaceNodeY; nodeY <= Math.min(world.height, surfaceNodeY + 1); nodeY += 1) {
    for (let nodeZ = cell.z; nodeZ <= cell.z + 1; nodeZ += 1) {
      for (let nodeX = cell.x; nodeX <= cell.x + 1; nodeX += 1) {
        total += getOrganicTerrainNodeDensity(world, nodeX, nodeY, nodeZ);
        count += 1;
      }
    }
  }

  return count > 0 ? total / count : 0;
}

function getSurfaceTerrainVisibility(terrainOcclusion: number): number {
  if (terrainOcclusion <= SURFACE_TERRAIN_OCCLUSION_START) {
    return 1;
  }

  if (terrainOcclusion >= SURFACE_TERRAIN_OCCLUSION_END) {
    return 0.08;
  }

  const t =
    (terrainOcclusion - SURFACE_TERRAIN_OCCLUSION_START) /
    (SURFACE_TERRAIN_OCCLUSION_END - SURFACE_TERRAIN_OCCLUSION_START);
  return 1 - t * 0.92;
}

function getSurfaceCellCenterY(world: VoxelWorld, cell: SurfaceCell): number {
  const motionOffset = getWaterSurfaceOffsetAt(world, cell.x, cell.y, cell.z) * SURFACE_MOTION_SCALE;
  const flowLift = Math.min(0.026, cell.motion.strength * 0.016);
  const wave =
    getSurfaceWave(cell.x, cell.y, cell.z, 0, 0) *
    SURFACE_WAVE_AMPLITUDE *
    (0.15 + cell.motion.strength * 0.25 + Math.min(0.35, cell.columnDepth / 8));
  const reliefSag =
    getSurfaceCornerReliefSag(world, cell, 0, 0) * 0.5 +
    getSurfaceCornerReliefSag(world, cell, 1, 1) * 0.5;
  const maxSurfaceY = cell.spanTopY + 1 + SURFACE_MOTION_HEADROOM;
  return Math.max(cell.spanBottomY + 0.04, Math.min(maxSurfaceY, cell.surfaceY + SURFACE_LIFT + motionOffset + flowLift + wave - reliefSag));
}

function getSurfaceFieldValue(waterHeight: number): number {
  return Math.min(1, 0.78 + Math.max(0, waterHeight) * 0.22);
}

function smoothSurfaceFieldValue(
  surfaceState: SurfaceHeightState,
  fieldKey: string,
  targetValue: number,
  activeFieldKeys: Set<string>,
): number {
  const previousValue = surfaceState.surfaceFieldMemory.get(fieldKey);
  const alpha =
    targetValue >= (previousValue ?? 0) || targetValue > SURFACE_FIELD_CLEAR_EPSILON
      ? SURFACE_FIELD_RISE_ALPHA
      : SURFACE_FIELD_DECAY_ALPHA;
  const value = previousValue === undefined ? targetValue : previousValue + (targetValue - previousValue) * alpha;
  const settledValue = value <= SURFACE_FIELD_CLEAR_EPSILON ? 0 : value;
  if (settledValue > 0) {
    surfaceState.surfaceFieldMemory.set(fieldKey, settledValue);
    activeFieldKeys.add(fieldKey);
  } else {
    surfaceState.surfaceFieldMemory.delete(fieldKey);
  }

  return settledValue;
}

function getSurfaceCellKey(x: number, z: number): string {
  return `${x}:${z}`;
}

function getColumnSpanKey(x: number, z: number, bottomY: number, topY: number): string {
  return `${x}:${z}:${bottomY}:${topY}`;
}

function getSurfaceHeightMemoryKey(y: number, x: number, z: number): string {
  return `${y}:${x}:${z}`;
}

function getSurfaceMemorySizeKey(world: VoxelWorld): string {
  return `${world.width}:${world.height}:${world.depth}`;
}

function pruneSurfaceHeightMemory(surfaceState: SurfaceHeightState, activeHeightKeys: Set<string>): void {
  for (const key of surfaceState.surfaceHeightMemory.keys()) {
    if (!activeHeightKeys.has(key)) {
      surfaceState.surfaceHeightMemory.delete(key);
    }
  }

  for (const key of surfaceState.surfaceFieldMemory.keys()) {
    if (!activeHeightKeys.has(key)) {
      surfaceState.surfaceFieldMemory.delete(key);
    }
  }
}

function addRgb(a: Rgb, b: Rgb): Rgb {
  return { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
}

function scaleRgb(color: Rgb, scale: number): Rgb {
  return { r: color.r * scale, g: color.g * scale, b: color.b * scale };
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function getSurfaceEdgeInset(
  world: VoxelWorld,
  x: number,
  surfaceY: number,
  z: number,
  dx: number,
  dz: number,
): number {
  const neighborX = x + dx;
  const neighborZ = z + dz;
  if (!isHorizontalInBounds(world, neighborX, neighborZ)) {
    return SURFACE_SHORE_INSET;
  }

  const contact = getTerrainContactFactor(world, neighborX, surfaceY, neighborZ);
  if (contact >= ORGANIC_TERRAIN_ISO_LEVEL) {
    return SURFACE_SOLID_INSET * Math.min(1.18, 0.72 + contact * 0.62);
  }

  if (contact >= ORGANIC_TERRAIN_ISO_LEVEL - 0.14) {
    return SURFACE_SHORE_INSET + (SURFACE_SOLID_INSET - SURFACE_SHORE_INSET) * clamp01((contact - 0.36) / 0.22);
  }

  return 0;
}

function getSurfaceCornerReliefSag(
  world: VoxelWorld,
  cell: SurfaceCell,
  cornerX: 0 | 1,
  cornerZ: 0 | 1,
): number {
  const dx = cornerX === 0 ? -1 : 1;
  const dz = cornerZ === 0 ? -1 : 1;
  const surfaceY = cell.surfaceY;
  let sag = 0;

  if (getSurfaceEdgeInset(world, cell.x, surfaceY, cell.z, dx, 0) >= SURFACE_SOLID_INSET * 0.9) {
    sag += 0.032;
  }

  if (getSurfaceEdgeInset(world, cell.x, surfaceY, cell.z, 0, dz) >= SURFACE_SOLID_INSET * 0.9) {
    sag += 0.032;
  }

  sag += Math.max(0, getTerrainContactFactor(world, cell.x + dx, surfaceY, cell.z + dz) - ORGANIC_TERRAIN_ISO_LEVEL) * 0.045;

  return Math.min(0.07, sag);
}

function getTerrainContactFactor(world: VoxelWorld, x: number, surfaceY: number, z: number): number {
  if (!isHorizontalInBounds(world, x, z)) {
    return 0;
  }

  const surfaceNodeY = clampInt(Math.floor(surfaceY), 0, world.height);
  let maxDensity = 0;
  for (let nodeY = Math.max(0, surfaceNodeY - 1); nodeY <= Math.min(world.height, surfaceNodeY + 1); nodeY += 1) {
    for (let nodeZ = z; nodeZ <= z + 1; nodeZ += 1) {
      for (let nodeX = x; nodeX <= x + 1; nodeX += 1) {
        maxDensity = Math.max(maxDensity, getOrganicTerrainNodeDensity(world, nodeX, nodeY, nodeZ));
      }
    }
  }

  return maxDensity;
}

function getShorelineCue(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: SideDirection,
  waterHeight: number,
  edgeCueMap: WaterEdgeCueMap,
): ShorelineCue | null {
  const neighborX = x + direction.dx;
  const neighborZ = z + direction.dz;
  if (!isHorizontalInBounds(world, neighborX, neighborZ)) {
    return null;
  }

  const neighborAmount = getWaterAmountAt(world, neighborX, y, neighborZ);
  const againstTerrain = neighborAmount <= EPSILON && hasTerrainAgainstShore(world, neighborX, y + waterHeight, neighborZ);
  const motion = getWaterMotionSample(world, x, y, z);
  const edgeCue = getWaterEdgeCueForCell(edgeCueMap, world, x, y, z);
  const headDelta = Math.max(0, waterHeight - neighborAmount);
  const depthGradient = Math.max(0, getWaterColumnDepth(world, x, y, z) - getWaterColumnDepth(world, neighborX, y, neighborZ));
  const surfaceEnergy = Math.abs(motion.surfaceOffset) + Math.abs(motion.surfaceVelocity);
  const solverEnergy = isEdgeCueAlignedWithDirection(edgeCue, direction) ? edgeCue.intensity : edgeCue.intensity * 0.35;
  const solverFoam = edgeCue.kind === "impact" || edgeCue.kind === "fall";
  const intensity = clamp01(
    headDelta * 0.62 + motion.horizontal * 0.16 + surfaceEnergy * 2.4 + depthGradient * 0.04 + solverEnergy * 0.44,
  );

  if (againstTerrain) {
    return waterHeight > 0.22
      ? {
          foam: intensity > 0.62 && (motion.kind === "turbulent" || solverFoam),
          skirt: true,
          width: SHORE_FOAM_WIDTH * (0.75 + intensity * 0.65),
          intensity,
          headDelta,
          motion,
        }
      : null;
  }

  if (waterHeight <= 0.38 || headDelta <= 0.18) {
    return null;
  }

  return {
    foam: waterHeight > 0.52 && (motion.kind === "turbulent" || solverFoam) && intensity > 0.58,
    skirt: false,
    width: SHORE_FOAM_WIDTH * (0.72 + intensity * 0.8),
    intensity,
    headDelta,
    motion,
  };
}

function hasTerrainAgainstShore(world: VoxelWorld, x: number, surfaceY: number, z: number): boolean {
  const surfaceCellY = Math.min(world.height - 1, Math.max(0, Math.floor(surfaceY - EPSILON)));
  const minY = Math.max(0, surfaceCellY - 1);
  const maxY = Math.min(world.height - 1, surfaceCellY + 1);

  for (let sampleY = minY; sampleY <= maxY; sampleY += 1) {
    if (isSolidWaterNeighbor(world, x, sampleY, z)) {
      return true;
    }
  }

  const minNodeY = Math.max(0, surfaceCellY);
  const maxNodeY = Math.min(world.height, surfaceCellY + 2);
  for (let nodeY = minNodeY; nodeY <= maxNodeY; nodeY += 1) {
    for (let nodeZ = z; nodeZ <= z + 1; nodeZ += 1) {
      for (let nodeX = x; nodeX <= x + 1; nodeX += 1) {
        if (getOrganicTerrainNodeDensity(world, nodeX, nodeY, nodeZ) >= ORGANIC_TERRAIN_ISO_LEVEL) {
          return true;
        }
      }
    }
  }

  return false;
}

function isTerrainBlockingWaterSheet(world: VoxelWorld, x: number, surfaceY: number, z: number): boolean {
  if (!isHorizontalInBounds(world, x, z)) {
    return true;
  }

  if (!hasTerrainAgainstShore(world, x, surfaceY, z)) {
    return false;
  }

  const surfaceNodeY = clampInt(Math.floor(surfaceY), 0, world.height);
  let maxDensity = 0;
  for (let nodeY = surfaceNodeY; nodeY <= Math.min(world.height, surfaceNodeY + 1); nodeY += 1) {
    for (let nodeZ = z; nodeZ <= z + 1; nodeZ += 1) {
      for (let nodeX = x; nodeX <= x + 1; nodeX += 1) {
        maxDensity = Math.max(maxDensity, getOrganicTerrainNodeDensity(world, nodeX, nodeY, nodeZ));
      }
    }
  }

  return maxDensity >= ORGANIC_TERRAIN_ISO_LEVEL + 0.08;
}

function isHorizontalInBounds(world: VoxelWorld, x: number, z: number): boolean {
  return x >= 0 && x < world.width && z >= 0 && z < world.depth;
}

function createWaterRippleTexture(lightColor: number, darkColor: number): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create water ripple texture");
  }

  const light = `#${lightColor.toString(16).padStart(6, "0")}`;
  const dark = `#${darkColor.toString(16).padStart(6, "0")}`;
  context.fillStyle = dark;
  context.fillRect(0, 0, size, size);
  context.globalAlpha = 0.13;
  context.strokeStyle = "#e8ffff";
  context.lineWidth = 1.1;
  for (let i = -size; i < size * 2; i += 13) {
    context.beginPath();
    context.moveTo(i, size * 0.75);
    context.bezierCurveTo(i + 18, 82, i + 26, 38, i + 64, 12);
    context.stroke();
  }
  context.globalAlpha = 0.09;
  context.strokeStyle = "#07384b";
  context.lineWidth = 1.4;
  for (let i = -size; i < size * 2; i += 22) {
    context.beginPath();
    context.moveTo(i, 0);
    context.bezierCurveTo(i - 10, 28, i + 28, 74, i + 10, size);
    context.stroke();
  }
  context.globalAlpha = 0.12;
  context.strokeStyle = light;
  context.lineWidth = 1.2;
  for (let radius = 12; radius < 72; radius += 20) {
    context.beginPath();
    context.ellipse(35, 42, radius * 1.25, radius * 0.55, 0.5, 0, Math.PI * 2);
    context.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.center.set(0.5, 0.5);
  texture.repeat.set(2.2, 2.2);
  return texture;
}

function replaceDynamicGeometry(
  renderer: WaterRenderer,
  mesh: Mesh<BufferGeometry, Material>,
  state: DynamicGeometryState,
  positions: number[],
  colors: number[],
): void {
  const vertexCount = positions.length / 3;
  const requiredPositionCapacity = positions.length;
  const requiredColorCapacity = colors.length;
  const positionAttribute = mesh.geometry.getAttribute("position") as Float32BufferAttribute | undefined;
  const colorAttribute = mesh.geometry.getAttribute("color") as Float32BufferAttribute | undefined;
  const needsResize =
    !positionAttribute ||
    !colorAttribute ||
    requiredPositionCapacity > state.positionCapacity ||
    requiredColorCapacity > state.colorCapacity ||
    shouldShrinkDynamicGeometry(state, requiredPositionCapacity, requiredColorCapacity);

  if (needsResize) {
    state.positionCapacity = growDynamicGeometryCapacity(requiredPositionCapacity);
    state.colorCapacity = growDynamicGeometryCapacity(requiredColorCapacity);
    mesh.geometry.dispose();
    mesh.geometry = new BufferGeometry();
    mesh.geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(state.positionCapacity), 3));
    mesh.geometry.setAttribute("color", new Float32BufferAttribute(new Float32Array(state.colorCapacity), 3));
    renderer.stats.rebuilds += 1;
  }

  const nextPositionAttribute = mesh.geometry.getAttribute("position") as Float32BufferAttribute;
  const nextColorAttribute = mesh.geometry.getAttribute("color") as Float32BufferAttribute;
  nextPositionAttribute.array.set(positions);
  nextColorAttribute.array.set(colors);
  if (requiredPositionCapacity < state.positionCapacity) {
    nextPositionAttribute.array.fill(0, requiredPositionCapacity);
  }
  if (requiredColorCapacity < state.colorCapacity) {
    nextColorAttribute.array.fill(0, requiredColorCapacity);
  }
  nextPositionAttribute.needsUpdate = true;
  nextColorAttribute.needsUpdate = true;
  mesh.geometry.setDrawRange(0, vertexCount);
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
}

function shouldShrinkDynamicGeometry(state: DynamicGeometryState, requiredPositionCapacity: number, requiredColorCapacity: number): boolean {
  return (
    (requiredPositionCapacity === 0 && state.positionCapacity > 0) ||
    (requiredColorCapacity === 0 && state.colorCapacity > 0) ||
    state.positionCapacity > Math.max(4096, requiredPositionCapacity * 4) ||
    state.colorCapacity > Math.max(4096, requiredColorCapacity * 4)
  );
}

function growDynamicGeometryCapacity(required: number): number {
  if (required <= 0) {
    return 0;
  }

  let capacity = 3;
  while (capacity < required) {
    capacity *= 2;
  }
  return capacity;
}

function appendCurtainQuad(
  positions: number[],
  colors: number[],
  topA: [number, number, number],
  topB: [number, number, number],
  bottomB: [number, number, number],
  bottomA: [number, number, number],
  topColor: Rgb,
  bottomColor: Rgb,
): void {
  appendTriangle(positions, colors, topA, topB, bottomB, topColor, topColor, bottomColor);
  appendTriangle(positions, colors, topA, bottomB, bottomA, topColor, bottomColor, bottomColor);
}

function appendTriangle(
  positions: number[],
  colors: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  colorA: Rgb,
  colorB: Rgb,
  colorC: Rgb,
): void {
  appendVertex(positions, colors, a, colorA);
  appendVertex(positions, colors, b, colorB);
  appendVertex(positions, colors, c, colorC);
}

function appendVertex(positions: number[], colors: number[], vertex: [number, number, number], color: Rgb): void {
  positions.push(vertex[0], vertex[1], vertex[2]);
  colors.push(color.r, color.g, color.b);
}

function getSurfaceWave(x: number, y: number, z: number, cornerX: number, cornerZ: number): number {
  const harmonic = Math.sin(x * 1.37 + z * 1.91 + cornerX * 1.7 + cornerZ * 2.3) * 0.55;
  const ripple = getCellVariation(x + cornerX * 3, y + 29, z + cornerZ * 5) - 0.5;
  return harmonic + ripple * 0.9;
}

function getSurfaceCellColor(cell: SurfaceCell): Rgb {
  const depth = Math.min(1, cell.columnDepth / 14);
  const motion = cell.motion;
  const flow = motion.strength;
  const variation = getCellVariation(cell.x, cell.y + 7, cell.z) * 0.0015;
  const shallow = { r: 0.055, g: 0.48, b: 0.7 };
  const deep = { r: 0.04, g: 0.43, b: 0.67 };
  const color = lerpRgb(shallow, deep, depth);
  return {
    r: color.r + variation + flow * 0.012,
    g: color.g + variation * 0.35 + flow * 0.04,
    b: color.b + flow * 0.06,
  };
}

function getSmoothedSurfaceCellColor(cells: Map<string, SurfaceCell>, cell: SurfaceCell): Rgb {
  let weightedColor = scaleRgb(getSurfaceCellColor(cell), 2.4);
  let totalWeight = 2.4;

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dz === 0) {
        continue;
      }

      const neighbor = cells.get(getSurfaceCellKey(cell.x + dx, cell.z + dz));
      if (!neighbor || Math.abs(neighbor.surfaceY - cell.surfaceY) > SURFACE_LAYER_MAX_STEP) {
        continue;
      }

      const weight = Math.abs(dx) + Math.abs(dz) === 2 ? 0.48 : 0.78;
      weightedColor = addRgb(weightedColor, scaleRgb(getSurfaceCellColor(neighbor), weight));
      totalWeight += weight;
    }
  }

  return scaleRgb(weightedColor, 1 / totalWeight);
}

function getCurtainTopColor(x: number, z: number, amount: number): Rgb {
  const variation = getCellVariation(x, 13, z) * 0.08;
  return {
    r: 0.16 + amount * 0.08 + variation,
    g: 0.72 + amount * 0.14 + variation * 0.3,
    b: 1,
  };
}

function getCurtainBottomColor(x: number, z: number, amount: number): Rgb {
  const variation = getCellVariation(x, 23, z) * 0.05;
  return {
    r: 0.05 + amount * 0.06 + variation,
    g: 0.34 + amount * 0.2 + variation,
    b: 0.68 + amount * 0.24,
  };
}

function getFoamColor(amount: number): Rgb {
  return {
    r: 0.56 + amount * 0.1,
    g: 0.86 + amount * 0.06,
    b: 0.95,
  };
}

function getShoreFoamColor(amount: number, intensity = 0): Rgb {
  return {
    r: 0.28 + amount * 0.06 + intensity * 0.08,
    g: 0.66 + amount * 0.08 + intensity * 0.08,
    b: 0.82 + amount * 0.06 + intensity * 0.06,
  };
}

function getHydraulicFoamColor(amount: number, intensity: number, kind: "edge-flow" | "fall" | "impact"): Rgb {
  const base = getShoreFoamColor(amount, intensity);
  const impactBoost = kind === "impact" ? 0.1 : kind === "fall" ? 0.04 : 0;
  return {
    r: Math.min(0.78, base.r + 0.08 + impactBoost),
    g: Math.min(0.9, base.g + 0.08 + impactBoost * 0.45),
    b: Math.min(0.98, base.b + 0.08 + impactBoost * 0.35),
  };
}

function getShoreBlendColor(amount: number, intensity = 0): Rgb {
  return {
    r: 0.06 + amount * 0.04 + intensity * 0.02,
    g: 0.34 + amount * 0.08 + intensity * 0.05,
    b: 0.52 + amount * 0.1 + intensity * 0.06,
  };
}

function getMistColor(amount: number): Rgb {
  return {
    r: 0.72 + amount * 0.18,
    g: 0.94 + amount * 0.05,
    b: 1,
  };
}

function eventRibbonBottomColor(amount: number, intensity: number): Rgb {
  return {
    r: 0.24 + amount * 0.08 + intensity * 0.1,
    g: 0.68 + amount * 0.08 + intensity * 0.12,
    b: 0.9 + intensity * 0.08,
  };
}

function getCurtainSag(x: number, z: number): number {
  return 0.015 + getCellVariation(x, 31, z) * 0.045;
}

function getFoamLift(x: number, z: number): number {
  return 0.004 + getCellVariation(x, 181, z) * 0.018;
}

function getWaterColumnDepth(world: VoxelWorld, x: number, y: number, z: number): number {
  let depth = 0;
  for (let sampleY = y; sampleY >= 0; sampleY -= 1) {
    const amount = getWaterAmountAt(world, x, sampleY, z);
    if (amount <= EPSILON) {
      break;
    }
    depth += Math.min(1, amount);
  }
  return depth;
}

function getWaterAmountAt(world: VoxelWorld, x: number, y: number, z: number): number {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return 0;
  }

  const cellIndex = x + world.width * (z + world.depth * y);
  return world.solid[cellIndex] === 1 ? 0 : world.water[cellIndex];
}

function isSolidWaterNeighbor(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return false;
  }

  const cellIndex = x + world.width * (z + world.depth * y);
  return world.solid[cellIndex] === 1;
}

function getCoordsFromCellIndex(world: VoxelWorld, cellIndex: number): { x: number; y: number; z: number } | null {
  if (cellIndex < 0 || cellIndex >= world.water.length) {
    return null;
  }

  const layerSize = world.width * world.depth;
  const y = Math.floor(cellIndex / layerSize);
  const layerIndex = cellIndex - y * layerSize;
  const z = Math.floor(layerIndex / world.width);
  const x = layerIndex - z * world.width;
  return { x, y, z };
}

function getCellVariation(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, -2048144789);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

function shouldRenderWaterCell(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (!gameplayMode || debugMode || amount < FULL_WATER_RENDER_THRESHOLD) {
    return true;
  }

  return (
    shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode) ||
    isWaterExposedToLowerNeighbor(world, x, y + 1, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x - 1, y, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x + 1, y, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y, z - 1, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y, z + 1, amount)
  );
}

function isWaterExposedToLowerNeighbor(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return true;
  }

  const cellIndex = x + world.width * (z + world.depth * y);
  if (world.solid[cellIndex] === 1) {
    return false;
  }

  return world.water[cellIndex] < amount - EXPOSED_WATER_DELTA;
}

function hasStrongVerticalWaterDrop(world: VoxelWorld, x: number, y: number, z: number, amount: number): boolean {
  if (y <= 0 || amount < FALLING_WATER_MIN_AMOUNT || isSolidWaterNeighbor(world, x, y - 1, z)) {
    return false;
  }

  const belowAmount = getWaterAmountAt(world, x, y - 1, z);
  return belowAmount < Math.min(amount - FALLING_WATER_DROP_DELTA, 0.58);
}

function isFallingWaterCell(world: VoxelWorld, x: number, y: number, z: number, amount: number): boolean {
  if (hasStrongVerticalWaterDrop(world, x, y, z, amount) && hasDownwardWaterMotion(world, x, y, z)) {
    return true;
  }

  const belowAmount = getWaterAmountAt(world, x, y - 1, z);
  const supportedByFloor = y <= 0 || isSolidWaterNeighbor(world, x, y - 1, z);
  const supportedByWater = belowAmount >= Math.max(0.38, amount - FALLING_WATER_DROP_DELTA);
  if (supportedByFloor || supportedByWater) {
    return false;
  }

  return amount < 0.72 && getWaterDropScore(world, x, y, z, amount) >= 2 && hasActiveWaterMotion(world, x, y, z);
}

function shouldStartFallingRibbon(world: VoxelWorld, x: number, y: number, z: number, amount: number): boolean {
  if (!hasStrongVerticalWaterDrop(world, x, y, z, amount) || !hasDownwardWaterMotion(world, x, y, z)) {
    return false;
  }

  const aboveAmount = getWaterAmountAt(world, x, y + 1, z);
  return aboveAmount <= EPSILON || !hasStrongVerticalWaterDrop(world, x, y + 1, z, aboveAmount);
}

function hasDownwardWaterMotion(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const motion = getWaterMotionSample(world, x, y, z);
  return motion.kind === "falling" || motion.kind === "turbulent";
}

function hasActiveWaterMotion(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const motion = getWaterMotionSample(world, x, y, z);
  return motion.kind !== "settled";
}

function findFallingRibbonBottomY(world: VoxelWorld, x: number, y: number, z: number): number {
  const minY = Math.max(0, Math.floor(y - FALLING_RIBBON_MAX_DROP));

  for (let sampleY = y - 1; sampleY >= minY; sampleY -= 1) {
    if (isSolidWaterNeighbor(world, x, sampleY, z)) {
      return sampleY + 1.04;
    }

    const sampleAmount = getWaterAmountAt(world, x, sampleY, z);
    if (sampleAmount <= EPSILON) {
      continue;
    }

    const sampleHeight = Math.max(0.05, Math.min(1, sampleAmount));
    if (!hasStrongVerticalWaterDrop(world, x, sampleY, z, sampleHeight)) {
      return sampleY + sampleHeight + 0.04;
    }
  }

  return Math.max(0.04, y - FALLING_RIBBON_MAX_DROP);
}

function hasOpenWaterTop(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const aboveY = y + 1;
  if (aboveY >= world.height) {
    return true;
  }

  const aboveIndex = x + world.width * (z + world.depth * aboveY);
  return world.solid[aboveIndex] !== 1 && world.water[aboveIndex] <= EPSILON;
}

function shouldRenderWaterSurface(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (!hasOpenWaterTop(world, x, y, z)) {
    return debugMode && !gameplayMode;
  }

  if (gameplayMode && !debugMode && isFallingWaterCell(world, x, y, z, amount)) {
    return false;
  }

  if (amount < FULL_WATER_RENDER_THRESHOLD) {
    return (
      !gameplayMode ||
      debugMode ||
      y <= 0 ||
      isSolidWaterNeighbor(world, x, y - 1, z) ||
      getWaterAmountAt(world, x, y - 1, z) > 0.28
    );
  }

  return true;
}

function shouldRenderWaterFoam(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
  edgeCue: WaterEdgeCue,
): boolean {
  if (!ENABLE_GAMEPLAY_FOAM_QUADS) {
    return false;
  }

  if (!gameplayMode || debugMode || amount < 0.12) {
    return false;
  }

  if ((edgeCue.kind === "impact" || edgeCue.kind === "fall") && edgeCue.intensity > 0.4) {
    return getCellVariation(x, y + 41, z) > 0.9 - edgeCue.intensity * 0.14;
  }

  const dropScore = getWaterDropScore(world, x, y, z, amount);
  const verticalDrop = isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount);
  const motion = getWaterMotionSample(world, x, y, z);
  const flow = motion.strength;
  if (!verticalDrop || amount <= 0.4 || !hasDownwardWaterMotion(world, x, y, z) || flow < 0.36 || dropScore < 2) {
    return false;
  }

  return getCellVariation(x, y + 41, z) > 0.9 - flow * 0.04;
}

function getWaterFoamScale(world: VoxelWorld, x: number, y: number, z: number, amount: number, edgeCue: WaterEdgeCue): number {
  const motion = getWaterMotionSample(world, x, y, z);
  return Math.min(
    0.48,
    0.12 + getWaterDropScore(world, x, y, z, amount) * 0.04 + amount * 0.05 + motion.strength * 0.06 + edgeCue.intensity * 0.1,
  );
}

function getWaterDropScore(world: VoxelWorld, x: number, y: number, z: number, amount: number): number {
  let score = 0;
  score += isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount) ? 2 : 0;
  score += isWaterExposedToLowerNeighbor(world, x - 1, y, z, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x + 1, y, z, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x, y, z - 1, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x, y, z + 1, amount) ? 1 : 0;
  return score;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
