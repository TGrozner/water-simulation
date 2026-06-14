import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Scene } from "three";
import { cellCenter, coords } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type ActiveCellRenderer = {
  mesh: InstancedMesh;
  update: (world: VoxelWorld, enabled: boolean, options?: RenderOptions) => void;
  dispose: () => void;
};

const dummy = new Object3D();
const WEBGPU_SAFE_INSTANCE_CAPACITY = 1000;

export function createActiveCellRenderer(scene: Scene, world: VoxelWorld): ActiveCellRenderer {
  const geometry = new BoxGeometry(1.08, 1.08, 1.08);
  const material = new MeshBasicMaterial({
    color: 0xffd24a,
    transparent: true,
    opacity: 0.68,
    wireframe: true,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, Math.min(world.water.length, WEBGPU_SAFE_INSTANCE_CAPACITY));
  mesh.frustumCulled = false;
  scene.add(mesh);

  const renderer: ActiveCellRenderer = {
    mesh,
    update: (nextWorld, enabled, options = defaultRenderOptions(nextWorld)) =>
      updateActiveCells(renderer, nextWorld, enabled, options),
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };

  renderer.update(world, false);

  return renderer;
}

function updateActiveCells(renderer: ActiveCellRenderer, world: VoxelWorld, enabled: boolean, options: RenderOptions): void {
  const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);

  if (!enabled) {
    if (renderer.mesh.count === 0) {
      return;
    }

    for (let i = 0; i < renderer.mesh.count; i += 1) {
      renderer.mesh.setMatrixAt(i, hiddenMatrix);
    }
    renderer.mesh.count = 0;
    renderer.mesh.instanceMatrix.needsUpdate = true;
    return;
  }

  let instanceCount = 0;
  const capacity = renderer.mesh.instanceMatrix.count;
  const activeCells = Array.from(world.activeCells).sort((a, b) => a - b);

  for (const cellIndex of activeCells) {
    if (instanceCount >= capacity) {
      break;
    }

    if (world.water[cellIndex] <= EPSILON || world.solid[cellIndex] === 1) {
      continue;
    }

    const cell = coords(world, cellIndex);
    if (!shouldRenderCell(world, cell.z, options)) {
      continue;
    }

    const center = cellCenter(world, cell.x, cell.y, cell.z);
    dummy.position.set(center.x, center.y, center.z);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    renderer.mesh.setMatrixAt(instanceCount, dummy.matrix);
    instanceCount += 1;
  }

  for (let i = instanceCount; i < renderer.mesh.count; i += 1) {
    renderer.mesh.setMatrixAt(i, hiddenMatrix);
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
