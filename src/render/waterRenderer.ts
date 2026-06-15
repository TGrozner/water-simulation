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
  Object3D,
  Raycaster,
  RepeatWrapping,
  Scene,
} from "three";
import { getWaterMotionSample } from "../sim/waterMotion";
import { getWaterSurfaceOffsetAt } from "../sim/waterSurface";
import { cellCenter } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type WaterRenderer = {
  bodyBatch: InstancedMeshBatch<BoxGeometry, MeshPhongMaterial, number>;
  surfaceMesh: Mesh<BufferGeometry, MeshPhongMaterial>;
  curtainMesh: Mesh<BufferGeometry, MeshPhongMaterial>;
  foamBatch: InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>;
  sprayBatch: InstancedMeshBatch<CircleGeometry, MeshBasicMaterial>;
  stats: RendererStats;
  pickCell: (raycaster: Raycaster) => { cellIndex: number; distance: number } | null;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions, gameplayMode?: boolean) => void;
  animate: (timeSeconds: number) => void;
  dispose: () => void;
};

type Rgb = { r: number; g: number; b: number };
type SideDirection = { dx: number; dz: number; axis: "x" | "z"; side: -1 | 1 };
type SurfaceCell = { x: number; y: number; z: number; waterHeight: number };
type SurfaceFootprint = { minX: number; maxX: number; minZ: number; maxZ: number };

const bodyDummy = new Object3D();
const foamDummy = new Object3D();
const sprayDummy = new Object3D();
const FULL_WATER_RENDER_THRESHOLD = 0.96;
const EXPOSED_WATER_DELTA = 0.05;
const SURFACE_LIFT = 0.024;
const SURFACE_WAVE_AMPLITUDE = 0.032;
const SURFACE_MOTION_SCALE = 0.86;
const SURFACE_FLOW_TILT_SCALE = 0.036;
const SURFACE_MOTION_HEADROOM = 0.14;
const SURFACE_SHORE_INSET = 0.085;
const SURFACE_SOLID_INSET = 0.18;
const SURFACE_EDGE_JITTER = 0.045;
const SURFACE_SHORE_DROP_DELTA = 0.2;
const MIN_SURFACE_SPAN = 0.34;
const CURTAIN_INSET = 0.1;
const SIDE_CURTAIN_MIN_DROP = 0.45;
const EDGE_SHEET_MIN_DROP = 0.42;
const EDGE_SHEET_MIN_AMOUNT = 0.48;
const FALLING_WATER_DROP_DELTA = 0.2;
const FALLING_WATER_MIN_AMOUNT = 0.16;
const FALLING_RIBBON_MAX_DROP = 12;
const FLOW_FOAM_THRESHOLD = 0.16;
const WEBGPU_SAFE_BATCH_CAPACITY = 1000;
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
  const surfaceRippleTexture = createWaterRippleTexture(0x91f7ff, 0x11677f);
  const material = new MeshPhongMaterial({
    color: 0x32d5eb,
    emissive: 0x073d4d,
    specular: 0xcff8ff,
    shininess: 115,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  material.colorWrite = false;

  const surfaceMaterial = new MeshPhongMaterial({
    color: 0xffffff,
    emissive: 0x093f50,
    specular: 0xffffff,
    shininess: 210,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    side: DoubleSide,
    vertexColors: true,
    map: surfaceRippleTexture,
  });
  const curtainMaterial = new MeshPhongMaterial({
    color: 0xffffff,
    emissive: 0x062637,
    specular: 0xdffbff,
    shininess: 145,
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
  const stats = createRendererStats(world.water.length);

  surfaceMesh.frustumCulled = false;
  curtainMesh.frustumCulled = false;
  curtainMesh.renderOrder = 6;
  surfaceMesh.renderOrder = 7;
  scene.add(curtainMesh);
  scene.add(surfaceMesh);

  const waterRenderer: WaterRenderer = {
    bodyBatch,
    surfaceMesh,
    curtainMesh,
    foamBatch,
    sprayBatch,
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
      geometry.dispose();
      curtainMesh.geometry.dispose();
      surfaceMesh.geometry.dispose();
      foamGeometry.dispose();
      sprayGeometry.dispose();
      material.dispose();
      surfaceMaterial.dispose();
      curtainMaterial.dispose();
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
  const material = renderer.bodyBatch.material;
  const surfaceMaterial = renderer.surfaceMesh.material;
  const curtainMaterial = renderer.curtainMesh.material;
  const foamMaterial = renderer.foamBatch.material;
  const sprayMaterial = renderer.sprayBatch.material;
  material.color.set(debugMode ? 0x5ef0ff : 0x32d5eb);
  material.emissive.set(debugMode ? 0x126c7c : 0x073d4d);
  material.opacity = debugMode ? 0.45 : 0;
  material.colorWrite = debugMode;
  surfaceMaterial.emissive.set(debugMode ? 0x1a7b88 : gameplayMode ? 0x0b485a : 0x125d68);
  surfaceMaterial.opacity = debugMode ? 0.72 : gameplayMode ? 0.58 : 0.72;
  curtainMaterial.emissive.set(debugMode ? 0x125c78 : gameplayMode ? 0x062637 : 0x0b4057);
  curtainMaterial.opacity = debugMode ? 0.5 : gameplayMode ? 0.36 : 0.42;
  foamMaterial.opacity = debugMode ? 0.34 : gameplayMode ? 0.46 : 0.3;
  sprayMaterial.opacity = debugMode ? 0.34 : gameplayMode ? 0.56 : 0.3;
  const layerSize = world.width * world.depth;
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
    bodyDummy.position.set(center.x, y + waterHeight * 0.5, center.z);
    bodyDummy.rotation.set(0, 0, 0);
    bodyDummy.scale.set(1, waterHeight, 1);
    bodyDummy.updateMatrix();
    renderer.bodyBatch.pushMatrix(bodyDummy.matrix, cellIndex);
    instanceCount += 1;

    if (shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)) {
      surfaceCells.push({ x, y, z, waterHeight });
      surfaceFaceCount += 1;
      if (gameplayMode && !debugMode) {
        foamCount = appendShoreFoam(renderer, world, x, y, z, waterHeight, foamCount);
      }
    }

    const fallingRibbon = shouldStartFallingRibbon(world, x, y, z, waterHeight);
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
    if (fallingRibbon && gameplayMode && !debugMode) {
      sprayCount = appendWaterMist(renderer, world, x, y, z, waterHeight, sprayCount);
    }

    if (shouldRenderWaterFoam(world, x, y, z, amount, debugMode, gameplayMode)) {
      const dropScore = getWaterDropScore(world, x, y, z, amount);
      const foamScale = getWaterFoamScale(world, x, y, z, amount);
      const foamStretch = 0.72 + getCellVariation(x, y + 17, z) * 0.34;
      foamDummy.position.set(center.x, y + waterHeight + 0.05, center.z);
      foamDummy.rotation.set(-Math.PI / 2, 0, getCellVariation(z, y, x) * Math.PI * 2);
      foamDummy.scale.set(foamScale, foamScale * foamStretch, 1);
      foamDummy.updateMatrix();
      renderer.foamBatch.pushMatrix(foamDummy.matrix);
      foamCount += 1;

      if (dropScore >= 2) {
        sprayCount = appendWaterSpray(renderer, center.x, y + waterHeight, center.z, x, y, z, sprayCount, amount);
      }
    }
  }

  renderer.bodyBatch.finish();
  replacePoolSurfaceGeometry(renderer.surfaceMesh, world, surfaceCells);
  replaceDynamicGeometry(renderer.curtainMesh, curtainPositions, curtainColors);
  renderer.foamBatch.finish();
  renderer.sprayBatch.finish();
  renderer.stats.instances = instanceCount + surfaceFaceCount + curtainFaceCount + foamCount + sprayCount;
  renderer.stats.updateMs = performance.now() - startedAt;
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
        neighborAmount < waterHeight - EDGE_SHEET_MIN_DROP
      ) {
        appendEdgeSheet(positions, colors, world, x, z, direction, topY, waterHeight);
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
): void {
  const color = getFoamColor(amount);
  const edgeY = topY + 0.018;
  const innerY = topY - 0.012;
  const inset = 0.16;
  const min = 0.08;
  const max = 0.92;

  if (direction.axis === "x") {
    const edgeX = x + (direction.side > 0 ? 1 : 0) - world.width / 2;
    const innerX = edgeX - direction.side * inset;
    const minZ = z - world.depth / 2 + min;
    const maxZ = z - world.depth / 2 + max;
    appendCurtainQuad(
      positions,
      colors,
      [innerX, innerY, minZ],
      [innerX, innerY, maxZ],
      [edgeX, edgeY, maxZ],
      [edgeX, edgeY, minZ],
      color,
      color,
    );
    return;
  }

  const edgeZ = z + (direction.side > 0 ? 1 : 0) - world.depth / 2;
  const innerZ = edgeZ - direction.side * inset;
  const minX = x - world.width / 2 + min;
  const maxX = x - world.width / 2 + max;
  appendCurtainQuad(
    positions,
    colors,
    [minX, innerY, innerZ],
    [maxX, innerY, innerZ],
    [maxX, edgeY, edgeZ],
    [minX, edgeY, edgeZ],
    color,
    color,
  );
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

function appendWaterSpray(
  renderer: WaterRenderer,
  centerX: number,
  topY: number,
  centerZ: number,
  x: number,
  y: number,
  z: number,
  sprayCount: number,
  amount: number,
): number {
  for (let i = 0; i < 4; i += 1) {
    const variation = getCellVariation(x + i * 11, y + 19, z);
    sprayDummy.position.set(
      centerX + (variation - 0.5) * 0.72,
      topY - 0.18 - i * 0.16,
      centerZ + (getCellVariation(z, y + i * 13, x) - 0.5) * 0.72,
    );
    sprayDummy.rotation.set(0.35 + variation * 0.7, variation * Math.PI * 2, 0.2);
    sprayDummy.scale.setScalar(0.18 + amount * 0.28 + variation * 0.1);
    sprayDummy.updateMatrix();
    renderer.sprayBatch.pushMatrix(sprayDummy.matrix);
    sprayCount += 1;
  }
  return sprayCount;
}

function appendWaterMist(
  renderer: WaterRenderer,
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  sprayCount: number,
): number {
  const bottomY = findFallingRibbonBottomY(world, x, y, z);
  const centerX = x - world.width / 2 + 0.5;
  const centerZ = z - world.depth / 2 + 0.5;
  const particleCount = 6 + Math.floor(getCellVariation(x, y + 137, z) * 5);

  for (let i = 0; i < particleCount; i += 1) {
    const angle = getCellVariation(x + i * 17, y + 149, z) * Math.PI * 2;
    const radius = 0.2 + getCellVariation(z, y + i * 19, x) * 0.72;
    sprayDummy.position.set(
      centerX + Math.cos(angle) * radius,
      bottomY + 0.08 + i * 0.035,
      centerZ + Math.sin(angle) * radius,
    );
    sprayDummy.rotation.set(Math.PI / 2, 0, angle);
    const scale = 0.34 + amount * 0.32 + getCellVariation(i, x, z) * 0.22;
    sprayDummy.scale.set(scale * 1.4, scale * 0.72, 1);
    sprayDummy.updateMatrix();
    renderer.sprayBatch.pushMatrix(sprayDummy.matrix);
    sprayCount += 1;
  }

  return sprayCount;
}

function appendShoreFoam(
  renderer: WaterRenderer,
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  foamCount: number,
): number {
  const topY = y + waterHeight + 0.055;

  for (const direction of SIDE_DIRECTIONS) {
    if (!shouldRenderShoreFoamEdge(world, x, y, z, direction, waterHeight)) {
      continue;
    }

    const variation = getCellVariation(x + direction.dx * 23, y + 109, z + direction.dz * 29);
    if (variation < 0.58) {
      continue;
    }

    const lateral = (getCellVariation(z + direction.dz * 31, y + 127, x + direction.dx * 37) - 0.5) * 0.38;
    const edgeOffset = direction.side > 0 ? 0.86 : 0.14;
    const centerX = x - world.width / 2 + 0.5;
    const centerZ = z - world.depth / 2 + 0.5;
    const longScale = 0.38 + variation * 0.24;
    const shortScale = 0.07 + waterHeight * 0.06;

    if (direction.axis === "x") {
      foamDummy.position.set(x - world.width / 2 + edgeOffset, topY, centerZ + lateral);
      foamDummy.scale.set(shortScale, longScale, 1);
    } else {
      foamDummy.position.set(centerX + lateral, topY, z - world.depth / 2 + edgeOffset);
      foamDummy.scale.set(longScale, shortScale, 1);
    }

    foamDummy.rotation.set(-Math.PI / 2, 0, (variation - 0.5) * 0.32);
    foamDummy.updateMatrix();
    renderer.foamBatch.pushMatrix(foamDummy.matrix);
    foamCount += 1;
  }

  return foamCount;
}

function replacePoolSurfaceGeometry(mesh: Mesh<BufferGeometry, MeshPhongMaterial>, world: VoxelWorld, cells: SurfaceCell[]): void {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const nodeIndices = new Map<string, number>();

  const getSharedNodeIndex = (
    cell: SurfaceCell,
    nodeX: number,
    nodeZ: number,
    cornerX: 0 | 1,
    cornerZ: 0 | 1,
  ): number => {
    const key = `${cell.y}:${nodeX}:${nodeZ}`;
    const existing = nodeIndices.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const index = positions.length / 3;
    appendSurfaceVertex(
      positions,
      normals,
      colors,
      uvs,
      world,
      nodeX,
      getSurfaceCornerY(world, cell.x, cell.y, cell.z, cell.waterHeight, cornerX, cornerZ),
      nodeZ,
      getSurfaceColor(world, cell.x, cell.y, cell.z, cell.waterHeight),
    );
    nodeIndices.set(key, index);
    return index;
  };

  for (const cell of cells) {
    const footprint = getSurfaceFootprint(world, cell);
    if (!footprint) {
      continue;
    }

    if (isFullSurfaceFootprint(cell, footprint)) {
      const a = getSharedNodeIndex(cell, cell.x, cell.z, 0, 0);
      const b = getSharedNodeIndex(cell, cell.x + 1, cell.z, 1, 0);
      const c = getSharedNodeIndex(cell, cell.x + 1, cell.z + 1, 1, 1);
      const d = getSharedNodeIndex(cell, cell.x, cell.z + 1, 0, 1);
      indices.push(a, b, c, a, c, d);
      continue;
    }

    const color = getSurfaceColor(world, cell.x, cell.y, cell.z, cell.waterHeight);
    const index = positions.length / 3;
    appendSurfaceVertex(
      positions,
      normals,
      colors,
      uvs,
      world,
      footprint.minX,
      getSurfaceCornerY(world, cell.x, cell.y, cell.z, cell.waterHeight, 0, 0),
      footprint.minZ,
      color,
    );
    appendSurfaceVertex(
      positions,
      normals,
      colors,
      uvs,
      world,
      footprint.maxX,
      getSurfaceCornerY(world, cell.x, cell.y, cell.z, cell.waterHeight, 1, 0),
      footprint.minZ,
      color,
    );
    appendSurfaceVertex(
      positions,
      normals,
      colors,
      uvs,
      world,
      footprint.maxX,
      getSurfaceCornerY(world, cell.x, cell.y, cell.z, cell.waterHeight, 1, 1),
      footprint.maxZ,
      color,
    );
    appendSurfaceVertex(
      positions,
      normals,
      colors,
      uvs,
      world,
      footprint.minX,
      getSurfaceCornerY(world, cell.x, cell.y, cell.z, cell.waterHeight, 0, 1),
      footprint.maxZ,
      color,
    );
    indices.push(index, index + 1, index + 2, index, index + 2, index + 3);
  }

  const nextGeometry = new BufferGeometry();
  nextGeometry.setIndex(indices);
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  nextGeometry.computeVertexNormals();
  nextGeometry.computeBoundingSphere();
  mesh.geometry.dispose();
  mesh.geometry = nextGeometry;
}

function appendSurfaceVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  color: Rgb,
): void {
  positions.push(x - world.width / 2, y, z - world.depth / 2);
  normals.push(0, 1, 0);
  colors.push(color.r, color.g, color.b);
  uvs.push(x * 0.18, z * 0.18);
}

function getSurfaceFootprint(world: VoxelWorld, cell: SurfaceCell): SurfaceFootprint | null {
  const leftInset = getSurfaceInsetWithJitter(
    getSurfaceEdgeInset(world, cell.x, cell.y, cell.z, -1, 0, cell.waterHeight),
    cell.x,
    cell.y,
    cell.z,
    -1,
    0,
  );
  const rightInset = getSurfaceInsetWithJitter(
    getSurfaceEdgeInset(world, cell.x, cell.y, cell.z, 1, 0, cell.waterHeight),
    cell.x,
    cell.y,
    cell.z,
    1,
    0,
  );
  const frontInset = getSurfaceInsetWithJitter(
    getSurfaceEdgeInset(world, cell.x, cell.y, cell.z, 0, -1, cell.waterHeight),
    cell.x,
    cell.y,
    cell.z,
    0,
    -1,
  );
  const backInset = getSurfaceInsetWithJitter(
    getSurfaceEdgeInset(world, cell.x, cell.y, cell.z, 0, 1, cell.waterHeight),
    cell.x,
    cell.y,
    cell.z,
    0,
    1,
  );
  const minX = cell.x + leftInset;
  const maxX = cell.x + 1 - rightInset;
  const minZ = cell.z + frontInset;
  const maxZ = cell.z + 1 - backInset;

  if (maxX - minX < MIN_SURFACE_SPAN || maxZ - minZ < MIN_SURFACE_SPAN) {
    return null;
  }

  return { minX, maxX, minZ, maxZ };
}

function isFullSurfaceFootprint(cell: SurfaceCell, footprint: SurfaceFootprint): boolean {
  return (
    Math.abs(footprint.minX - cell.x) <= EPSILON &&
    Math.abs(footprint.maxX - (cell.x + 1)) <= EPSILON &&
    Math.abs(footprint.minZ - cell.z) <= EPSILON &&
    Math.abs(footprint.maxZ - (cell.z + 1)) <= EPSILON
  );
}

function getSurfaceInsetWithJitter(inset: number, x: number, y: number, z: number, dx: number, dz: number): number {
  if (inset <= EPSILON) {
    return 0;
  }

  const jitter = (getCellVariation(x + dx * 11, y + 59, z + dz * 13) - 0.5) * SURFACE_EDGE_JITTER;
  return Math.max(0.04, inset + jitter);
}

function getSurfaceEdgeInset(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  _waterHeight: number,
): number {
  const neighborX = x + dx;
  const neighborZ = z + dz;
  if (!isHorizontalInBounds(world, neighborX, neighborZ)) {
    return SURFACE_SHORE_INSET;
  }

  if (isSolidWaterNeighbor(world, neighborX, y, neighborZ) || isSolidWaterNeighbor(world, neighborX, y + 1, neighborZ)) {
    return SURFACE_SOLID_INSET;
  }

  return 0;
}

function getSurfaceCornerReliefSag(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  cornerX: 0 | 1,
  cornerZ: 0 | 1,
): number {
  const dx = cornerX === 0 ? -1 : 1;
  const dz = cornerZ === 0 ? -1 : 1;
  let sag = 0;

  if (getSurfaceEdgeInset(world, x, y, z, dx, 0, waterHeight) >= SURFACE_SOLID_INSET * 0.9) {
    sag += 0.032;
  }

  if (getSurfaceEdgeInset(world, x, y, z, 0, dz, waterHeight) >= SURFACE_SOLID_INSET * 0.9) {
    sag += 0.032;
  }

  if (isSolidWaterNeighbor(world, x + dx, y + 1, z + dz)) {
    sag += 0.02;
  }

  return Math.min(0.07, sag);
}

function shouldRenderShoreFoamEdge(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: SideDirection,
  waterHeight: number,
): boolean {
  const neighborX = x + direction.dx;
  const neighborZ = z + direction.dz;
  if (!isHorizontalInBounds(world, neighborX, neighborZ)) {
    return false;
  }

  if (isSolidWaterNeighbor(world, neighborX, y, neighborZ) || isSolidWaterNeighbor(world, neighborX, y + 1, neighborZ)) {
    return true;
  }

  const neighborAmount = getWaterAmountAt(world, neighborX, y, neighborZ);
  return waterHeight > 0.42 && neighborAmount < waterHeight - SURFACE_SHORE_DROP_DELTA;
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
  const gradient = context.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, dark);
  gradient.addColorStop(0.32, light);
  gradient.addColorStop(0.7, "#54d9ff");
  gradient.addColorStop(1, dark);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  context.globalAlpha = 0.24;
  context.strokeStyle = "#e8ffff";
  context.lineWidth = 2;
  for (let i = -size; i < size * 2; i += 18) {
    context.beginPath();
    context.moveTo(i, size);
    context.bezierCurveTo(i + 28, 88, i + 16, 42, i + 62, 0);
    context.stroke();
  }
  context.globalAlpha = 0.16;
  context.strokeStyle = "#07384b";
  context.lineWidth = 3;
  for (let i = -size; i < size * 2; i += 27) {
    context.beginPath();
    context.moveTo(i, 0);
    context.bezierCurveTo(i - 16, 30, i + 36, 78, i + 8, size);
    context.stroke();
  }
  context.globalAlpha = 0.18;
  context.strokeStyle = "#ffffff";
  context.lineWidth = 1.2;
  for (let radius = 10; radius < 82; radius += 18) {
    context.beginPath();
    context.ellipse(35, 42, radius * 1.25, radius * 0.55, 0.5, 0, Math.PI * 2);
    context.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.center.set(0.5, 0.5);
  texture.repeat.set(0.85, 0.85);
  return texture;
}

function replaceDynamicGeometry(mesh: Mesh<BufferGeometry, MeshPhongMaterial>, positions: number[], colors: number[]): void {
  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.computeVertexNormals();
  nextGeometry.computeBoundingSphere();
  mesh.geometry.dispose();
  mesh.geometry = nextGeometry;
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

function getSurfaceCornerY(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
  cornerX: 0 | 1,
  cornerZ: 0 | 1,
): number {
  const xs = cornerX === 0 ? [x - 1, x] : [x, x + 1];
  const zs = cornerZ === 0 ? [z - 1, z] : [z, z + 1];
  let total = 0;
  let count = 0;

  for (const sampleX of xs) {
    for (const sampleZ of zs) {
      const amount = getWaterAmountAt(world, sampleX, y, sampleZ);
      if (amount > EPSILON) {
        total += y + Math.max(0.05, Math.min(1, amount));
        count += 1;
      }
    }
  }

  const average = count > 0 ? total / count : y + waterHeight;
  const motion = getWaterMotionSample(world, x, y, z);
  const wave = getSurfaceWave(x, y, z, cornerX, cornerZ) * SURFACE_WAVE_AMPLITUDE * (0.35 + motion.strength * 0.65);
  const surfaceOffset = getSurfaceCornerMotionOffset(world, x, y, z, cornerX, cornerZ) * SURFACE_MOTION_SCALE;
  const flowTilt = getSurfaceFlowTilt(motion.x, motion.z, cornerX, cornerZ);
  const reliefSag = getSurfaceCornerReliefSag(world, x, y, z, waterHeight, cornerX, cornerZ);
  const maxSurfaceY = y + Math.min(1.08, Math.max(0.08, waterHeight + SURFACE_MOTION_HEADROOM));
  return Math.max(y + 0.04, Math.min(maxSurfaceY, average + SURFACE_LIFT + wave + surfaceOffset + flowTilt - reliefSag));
}

function getSurfaceCornerMotionOffset(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  cornerX: 0 | 1,
  cornerZ: 0 | 1,
): number {
  const xs = cornerX === 0 ? [x - 1, x] : [x, x + 1];
  const zs = cornerZ === 0 ? [z - 1, z] : [z, z + 1];
  let total = 0;
  let count = 0;

  for (const sampleX of xs) {
    for (const sampleZ of zs) {
      const amount = getWaterAmountAt(world, sampleX, y, sampleZ);
      if (amount <= EPSILON) {
        continue;
      }

      total += getWaterSurfaceOffsetAt(world, sampleX, y, sampleZ);
      count += 1;
    }
  }

  return count > 0 ? total / count : 0;
}

function getSurfaceFlowTilt(flowX: number, flowZ: number, cornerX: 0 | 1, cornerZ: 0 | 1): number {
  const horizontal = Math.hypot(flowX, flowZ);
  if (horizontal <= EPSILON) {
    return 0;
  }

  const localX = cornerX === 0 ? -0.5 : 0.5;
  const localZ = cornerZ === 0 ? -0.5 : 0.5;
  const downstream = (flowX * localX + flowZ * localZ) / horizontal;
  return downstream * Math.min(SURFACE_FLOW_TILT_SCALE, horizontal * 0.018);
}

function getSurfaceWave(x: number, y: number, z: number, cornerX: number, cornerZ: number): number {
  const harmonic = Math.sin(x * 1.37 + z * 1.91 + cornerX * 1.7 + cornerZ * 2.3) * 0.55;
  const ripple = getCellVariation(x + cornerX * 3, y + 29, z + cornerZ * 5) - 0.5;
  return harmonic + ripple * 0.9;
}

function getSurfaceColor(world: VoxelWorld, x: number, y: number, z: number, amount: number): Rgb {
  const depth = Math.min(1, getWaterColumnDepth(world, x, y, z) / 4.5);
  const motion = getWaterMotionSample(world, x, y, z);
  const flow = motion.strength;
  const surfaceEnergy = Math.min(1, (Math.abs(motion.surfaceOffset) + Math.abs(motion.surfaceVelocity)) / 0.14);
  const variation = getCellVariation(x, y + 7, z) * 0.08;
  return {
    r: 0.08 + amount * 0.05 - depth * 0.04 + variation + flow * 0.02 + surfaceEnergy * 0.02,
    g: 0.5 + amount * 0.14 - depth * 0.05 + variation * 0.45 + flow * 0.08 + surfaceEnergy * 0.05,
    b: 0.76 + amount * 0.1 + flow * 0.1 + surfaceEnergy * 0.08,
  };
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
    r: 0.7 + amount * 0.16,
    g: 0.96,
    b: 1,
  };
}

function getMistColor(amount: number): Rgb {
  return {
    r: 0.72 + amount * 0.18,
    g: 0.94 + amount * 0.05,
    b: 1,
  };
}

function getCurtainSag(x: number, z: number): number {
  return 0.015 + getCellVariation(x, 31, z) * 0.045;
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
): boolean {
  if (!gameplayMode || debugMode || amount < 0.12) {
    return false;
  }

  const dropScore = getWaterDropScore(world, x, y, z, amount);
  const verticalDrop = isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount);
  const motion = getWaterMotionSample(world, x, y, z);
  const flow = motion.strength;
  if (verticalDrop && amount > 0.28) {
    return motion.kind !== "settled" && getCellVariation(x, y + 41, z) > 0.34 - flow * 0.16;
  }

  if (flow >= FLOW_FOAM_THRESHOLD && amount > 0.22 && shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)) {
    return getCellVariation(x, y + 41, z) > 0.82 - flow * 0.38;
  }

  return (
    dropScore >= 1 &&
    amount > 0.35 &&
    getCellVariation(x, y + 41, z) > 0.76 &&
    shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)
  );
}

function getWaterFoamScale(world: VoxelWorld, x: number, y: number, z: number, amount: number): number {
  const motion = getWaterMotionSample(world, x, y, z);
  const surfaceEnergy = Math.min(1, (Math.abs(motion.surfaceOffset) + Math.abs(motion.surfaceVelocity)) / 0.14);
  return Math.min(
    1.36,
    0.42 + getWaterDropScore(world, x, y, z, amount) * 0.14 + amount * 0.16 + motion.strength * 0.2 + surfaceEnergy * 0.1,
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

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
