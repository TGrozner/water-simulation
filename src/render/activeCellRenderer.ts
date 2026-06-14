import { BoxGeometry, MeshBasicMaterial, Object3D, Scene } from "three";
import { cellCenter, coords } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type ActiveCellRenderer = {
  update: (world: VoxelWorld, enabled: boolean, options?: RenderOptions) => void;
  dispose: () => void;
};

const dummy = new Object3D();
const WEBGPU_SAFE_BATCH_CAPACITY = 1000;

export function createActiveCellRenderer(scene: Scene, world: VoxelWorld): ActiveCellRenderer {
  const geometry = new BoxGeometry(1.08, 1.08, 1.08);
  const material = new MeshBasicMaterial({
    color: 0xffd24a,
    transparent: true,
    opacity: 0.68,
    wireframe: true,
    depthWrite: false,
  });
  const batch = new InstancedMeshBatch({
    scene,
    geometry,
    material,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: "active-cell-batch",
  });

  const renderer: ActiveCellRenderer = {
    update: (nextWorld, enabled, options = defaultRenderOptions(nextWorld)) =>
      updateActiveCells(batch, nextWorld, enabled, options),
    dispose: () => {
      batch.dispose();
      geometry.dispose();
      material.dispose();
    },
  };

  renderer.update(world, false);

  return renderer;
}

function updateActiveCells(
  batch: InstancedMeshBatch<BoxGeometry, MeshBasicMaterial>,
  world: VoxelWorld,
  enabled: boolean,
  options: RenderOptions,
): void {
  if (!enabled) {
    batch.clear();
    return;
  }

  batch.begin();
  const activeCells = Array.from(world.activeCells).sort((a, b) => a - b);

  for (const cellIndex of activeCells) {
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
    batch.pushMatrix(dummy.matrix);
  }

  batch.finish();
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
