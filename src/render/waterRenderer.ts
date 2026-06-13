import {
  BoxGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Scene,
} from "three";
import { cellCenter } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type WaterRenderer = {
  mesh: InstancedMesh;
  instanceToCell: Int32Array;
  stats: RendererStats;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions, gameplayMode?: boolean) => void;
  dispose: () => void;
};

const dummy = new Object3D();
const FULL_WATER_RENDER_THRESHOLD = 0.96;
const EXPOSED_WATER_DELTA = 0.05;

export function createWaterRenderer(scene: Scene, world: VoxelWorld): WaterRenderer {
  const geometry = new BoxGeometry(0.92, 1, 0.92);
  const material = new MeshBasicMaterial({
    color: 0x36a4ff,
    transparent: true,
    opacity: 0.56,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, world.water.length);
  const instanceToCell = new Int32Array(world.water.length);
  const stats = createRendererStats(world.water.length);

  mesh.frustumCulled = false;
  scene.add(mesh);

  const waterRenderer: WaterRenderer = {
    mesh,
    instanceToCell,
    stats,
    update: (nextWorld, debugMode, options = defaultRenderOptions(nextWorld), gameplayMode = false) =>
      updateWaterMesh(waterRenderer, nextWorld, debugMode, options, gameplayMode),
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
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
  const material = renderer.mesh.material as MeshBasicMaterial;
  material.color.set(debugMode ? 0x5ef0ff : gameplayMode ? 0x28b8d4 : 0x36a4ff);
  material.opacity = debugMode ? 0.88 : gameplayMode ? 0.34 : 0.56;

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
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
        dummy.position.set(center.x, y + waterHeight * 0.5, center.z);
        dummy.scale.set(1, waterHeight, 1);
        dummy.updateMatrix();
        renderer.mesh.setMatrixAt(instanceCount, dummy.matrix);

        renderer.instanceToCell[instanceCount] = cellIndex;
        instanceCount += 1;
      }
    }
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
  renderer.mesh.computeBoundingSphere();
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

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
