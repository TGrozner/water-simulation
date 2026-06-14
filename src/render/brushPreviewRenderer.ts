import { BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Scene } from "three";
import { cellCenter, coords } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type BrushPreviewRenderer = {
  mesh: InstancedMesh;
  update: (world: VoxelWorld, cells: number[], options?: RenderOptions) => void;
  dispose: () => void;
};

type BrushPreviewCache = {
  lastCells: number[];
  lastOptionsKey: string;
};

const dummy = new Object3D();
const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);
const WEBGPU_SAFE_INSTANCE_CAPACITY = 1000;

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
  const mesh = new InstancedMesh(geometry, material, Math.min(world.solid.length, WEBGPU_SAFE_INSTANCE_CAPACITY));
  const cache: BrushPreviewCache = {
    lastCells: [],
    lastOptionsKey: "",
  };
  mesh.frustumCulled = false;
  scene.add(mesh);

  const renderer: BrushPreviewRenderer = {
    mesh,
    update: (nextWorld, cells, options = defaultRenderOptions(nextWorld)) =>
      updateBrushPreview(renderer, nextWorld, cells, options, cache),
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };

  renderer.update(world, []);

  return renderer;
}

function updateBrushPreview(
  renderer: BrushPreviewRenderer,
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
  let instanceCount = 0;
  const capacity = renderer.mesh.instanceMatrix.count;

  for (const cellIndex of cells) {
    if (instanceCount >= capacity) {
      break;
    }

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
    renderer.mesh.setMatrixAt(instanceCount, dummy.matrix);
    instanceCount += 1;
  }

  for (let i = instanceCount; i < renderer.mesh.count; i += 1) {
    renderer.mesh.setMatrixAt(i, hiddenMatrix);
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
  renderer.mesh.computeBoundingSphere();
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
