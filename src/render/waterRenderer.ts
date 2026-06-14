import {
  BoxGeometry,
  MeshPhongMaterial,
  InstancedMesh,
  Object3D,
  Scene,
} from "three";
import { cellCenter } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type WaterRenderer = {
  mesh: InstancedMesh<BoxGeometry, MeshPhongMaterial>;
  surfaceMesh: InstancedMesh<BoxGeometry, MeshPhongMaterial>;
  instanceToCell: Int32Array;
  stats: RendererStats;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions, gameplayMode?: boolean) => void;
  dispose: () => void;
};

const bodyDummy = new Object3D();
const surfaceDummy = new Object3D();
const FULL_WATER_RENDER_THRESHOLD = 0.96;
const EXPOSED_WATER_DELTA = 0.05;

export function createWaterRenderer(scene: Scene, world: VoxelWorld): WaterRenderer {
  const geometry = new BoxGeometry(0.92, 1, 0.92);
  const surfaceGeometry = new BoxGeometry(0.86, 0.035, 0.86);
  const material = new MeshPhongMaterial({
    color: 0x37c6e6,
    emissive: 0x0b5262,
    specular: 0xcff8ff,
    shininess: 95,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
  });
  const surfaceMaterial = new MeshPhongMaterial({
    color: 0xaaf5ff,
    emissive: 0x104f5d,
    specular: 0xffffff,
    shininess: 140,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, world.water.length);
  const surfaceMesh = new InstancedMesh(surfaceGeometry, surfaceMaterial, world.water.length);
  const instanceToCell = new Int32Array(world.water.length);
  const stats = createRendererStats(world.water.length);

  mesh.frustumCulled = false;
  surfaceMesh.frustumCulled = false;
  scene.add(mesh);
  scene.add(surfaceMesh);

  const waterRenderer: WaterRenderer = {
    mesh,
    surfaceMesh,
    instanceToCell,
    stats,
    update: (nextWorld, debugMode, options = defaultRenderOptions(nextWorld), gameplayMode = false) =>
      updateWaterMesh(waterRenderer, nextWorld, debugMode, options, gameplayMode),
    dispose: () => {
      scene.remove(mesh);
      scene.remove(surfaceMesh);
      geometry.dispose();
      surfaceGeometry.dispose();
      material.dispose();
      surfaceMaterial.dispose();
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
  let surfaceCount = 0;
  const material = renderer.mesh.material;
  const surfaceMaterial = renderer.surfaceMesh.material;
  material.color.set(debugMode ? 0x5ef0ff : gameplayMode ? 0x35bfd8 : 0x37c6e6);
  material.emissive.set(debugMode ? 0x126c7c : gameplayMode ? 0x064a56 : 0x0b5262);
  material.opacity = debugMode ? 0.82 : gameplayMode ? 0.42 : 0.52;
  surfaceMaterial.opacity = debugMode ? 0.46 : gameplayMode ? 0.3 : 0.34;
  const layerSize = world.width * world.depth;

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
    const waterHeight = Math.max(0.05, amount);
    bodyDummy.position.set(center.x, y + waterHeight * 0.5, center.z);
    bodyDummy.scale.set(1, waterHeight, 1);
    bodyDummy.updateMatrix();
    renderer.mesh.setMatrixAt(instanceCount, bodyDummy.matrix);

    renderer.instanceToCell[instanceCount] = cellIndex;
    instanceCount += 1;

    if (shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)) {
      surfaceDummy.position.set(center.x, y + waterHeight + 0.012, center.z);
      surfaceDummy.scale.setScalar(1);
      surfaceDummy.updateMatrix();
      renderer.surfaceMesh.setMatrixAt(surfaceCount, surfaceDummy.matrix);
      surfaceCount += 1;
    }
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
  renderer.mesh.computeBoundingSphere();
  renderer.surfaceMesh.count = surfaceCount;
  renderer.surfaceMesh.instanceMatrix.needsUpdate = true;
  renderer.surfaceMesh.computeBoundingSphere();
  renderer.stats.instances = instanceCount;
  renderer.stats.updateMs = performance.now() - startedAt;
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

function shouldRenderWaterSurface(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (debugMode || !gameplayMode || amount < FULL_WATER_RENDER_THRESHOLD) {
    return true;
  }

  const aboveY = y + 1;
  if (aboveY >= world.height) {
    return true;
  }

  const aboveIndex = x + world.width * (z + world.depth * aboveY);
  return world.solid[aboveIndex] === 1 || world.water[aboveIndex] <= EPSILON;
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
