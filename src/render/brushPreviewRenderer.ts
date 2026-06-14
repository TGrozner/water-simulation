import { BoxGeometry, MeshBasicMaterial, Object3D, Scene } from "three";
import { cellCenter, coords } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type BrushPreviewRenderer = {
  update: (world: VoxelWorld, cells: number[], options?: RenderOptions) => void;
  dispose: () => void;
};

type BrushPreviewCache = {
  lastCells: number[];
  lastOptionsKey: string;
};

const dummy = new Object3D();
const WEBGPU_SAFE_BATCH_CAPACITY = 1000;

export function createBrushPreviewRenderer(scene: Scene, world: VoxelWorld): BrushPreviewRenderer {
  const geometry = new BoxGeometry(1.12, 1.12, 1.12);
  const material = new MeshBasicMaterial({
    color: 0xb8fbff,
    transparent: true,
    opacity: 0.18,
    wireframe: false,
    depthTest: true,
    depthWrite: false,
  });
  const batch = new InstancedMeshBatch({
    scene,
    geometry,
    material,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: "brush-preview-batch",
  });
  const cache: BrushPreviewCache = {
    lastCells: [],
    lastOptionsKey: "",
  };

  const renderer: BrushPreviewRenderer = {
    update: (nextWorld, cells, options = defaultRenderOptions(nextWorld)) =>
      updateBrushPreview(batch, nextWorld, cells, options, cache),
    dispose: () => {
      batch.dispose();
      geometry.dispose();
      material.dispose();
    },
  };

  renderer.update(world, []);

  return renderer;
}

function updateBrushPreview(
  batch: InstancedMeshBatch<BoxGeometry, MeshBasicMaterial>,
  world: VoxelWorld,
  cells: number[],
  options: RenderOptions,
  cache: BrushPreviewCache,
): void {
  const optionsKey = getRenderOptionsKey(options);
  if (optionsKey === cache.lastOptionsKey && areCellArraysEqual(cells, cache.lastCells)) {
    return;
  }

  cache.lastCells.length = 0;
  cache.lastCells.push(...cells);
  cache.lastOptionsKey = optionsKey;
  batch.begin();

  for (const cellIndex of cells) {
    if (world.solid[cellIndex] === 0) {
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

function areCellArraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function getRenderOptionsKey(options: RenderOptions): string {
  return options.slice.enabled ? `slice:${options.slice.z}` : "full";
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
