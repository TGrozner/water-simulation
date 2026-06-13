import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Scene,
} from "three";
import { cellCenter, inBounds, isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type TerrainRenderer = {
  mesh: InstancedMesh;
  instanceToCell: Int32Array;
  update: (world: VoxelWorld, options?: RenderOptions) => void;
  dispose: () => void;
};

const dummy = new Object3D();

export function createTerrainRenderer(scene: Scene, world: VoxelWorld): TerrainRenderer {
  const geometry = new BoxGeometry(0.96, 0.96, 0.96);
  const material = new MeshLambertMaterial({ color: 0xb8894d });
  const mesh = new InstancedMesh(geometry, material, world.solid.length);
  const instanceToCell = new Int32Array(world.solid.length);

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const terrainRenderer: TerrainRenderer = {
    mesh,
    instanceToCell,
    update: (nextWorld, options = defaultRenderOptions(nextWorld)) =>
      updateTerrainMesh(terrainRenderer, nextWorld, options),
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };

  terrainRenderer.update(world);

  return terrainRenderer;
}

function updateTerrainMesh(renderer: TerrainRenderer, world: VoxelWorld, options: RenderOptions): void {
  let instanceCount = 0;
  const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
        if (
          world.solid[cellIndex] === 0 ||
          !shouldRenderCell(world, z, options) ||
          !isExposedSolid(world, x, y, z, options)
        ) {
          continue;
        }

        const center = cellCenter(world, x, y, z);
        dummy.position.set(center.x, center.y, center.z);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        renderer.mesh.setMatrixAt(instanceCount, dummy.matrix);

        renderer.instanceToCell[instanceCount] = cellIndex;
        instanceCount += 1;
      }
    }
  }

  for (let i = instanceCount; i < renderer.mesh.count; i += 1) {
    renderer.mesh.setMatrixAt(i, hiddenMatrix);
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
  renderer.mesh.computeBoundingSphere();
}

function isExposedSolid(world: VoxelWorld, x: number, y: number, z: number, options: RenderOptions): boolean {
  return (
    !inBounds(world, x + 1, y, z) ||
    !inBounds(world, x - 1, y, z) ||
    !inBounds(world, x, y + 1, z) ||
    !inBounds(world, x, y - 1, z) ||
    !inBounds(world, x, y, z + 1) ||
    !inBounds(world, x, y, z - 1) ||
    !isSolid(world, x + 1, y, z) ||
    !isSolid(world, x - 1, y, z) ||
    !isSolid(world, x, y + 1, z) ||
    !isSolid(world, x, y - 1, z) ||
    !isSolid(world, x, y, z + 1) ||
    !isSolid(world, x, y, z - 1) ||
    (options.slice.enabled && z === options.slice.z)
  );
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
