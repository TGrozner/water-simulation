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

export type WaterRenderer = {
  mesh: InstancedMesh;
  instanceToCell: Int32Array;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions) => void;
  dispose: () => void;
};

const dummy = new Object3D();

export function createWaterRenderer(scene: Scene, world: VoxelWorld): WaterRenderer {
  const geometry = new BoxGeometry(0.92, 1, 0.92);
  const material = new MeshBasicMaterial({
    color: 0x36a4ff,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, world.water.length);
  const instanceToCell = new Int32Array(world.water.length);

  mesh.frustumCulled = false;
  scene.add(mesh);

  const waterRenderer: WaterRenderer = {
    mesh,
    instanceToCell,
    update: (nextWorld, debugMode, options = defaultRenderOptions(nextWorld)) =>
      updateWaterMesh(waterRenderer, nextWorld, debugMode, options),
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
): void {
  let instanceCount = 0;
  const material = renderer.mesh.material as MeshBasicMaterial;
  material.color.set(debugMode ? 0x5ef0ff : 0x36a4ff);
  material.opacity = debugMode ? 0.88 : 0.72;

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
        const amount = world.water[cellIndex];
        if (amount <= EPSILON || world.solid[cellIndex] === 1 || !shouldRenderCell(world, z, options)) {
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
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
