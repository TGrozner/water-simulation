import { ConeGeometry, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from "three";
import { cellCenter, coords } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import type { FlowDirection } from "../sim/waterSimulation";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";

export type RecentFlow = {
  direction: FlowDirection;
  dx: number;
  dy: number;
  dz: number;
  ttl: number;
  amount: number;
};

export type FlowDebugRenderer = {
  update: (world: VoxelWorld, flows: Map<number, RecentFlow>, enabled: boolean, options?: RenderOptions) => void;
  dispose: () => void;
};

type DirectionMesh = {
  direction: FlowDirection;
  batch: InstancedMeshBatch<ConeGeometry, MeshBasicMaterial>;
  material: MeshBasicMaterial;
  geometry: ConeGeometry;
};

const dummy = new Object3D();
const upVector = new Vector3(0, 1, 0);
const directionVector = new Vector3();
const rotation = new Quaternion();
const WEBGPU_SAFE_BATCH_CAPACITY = 1000;

export function createFlowDebugRenderer(scene: Scene, _world: VoxelWorld): FlowDebugRenderer {
  const meshes: DirectionMesh[] = [
    createDirectionMesh(scene, "down", 0x66d9ff),
    createDirectionMesh(scene, "side", 0x78ff7a),
  ];

  return {
    update: (nextWorld, flows, enabled, options = defaultRenderOptions(nextWorld)) =>
      updateFlowDebug(meshes, nextWorld, flows, enabled, options),
    dispose: () => {
      for (const entry of meshes) {
        entry.batch.dispose();
        entry.geometry.dispose();
        entry.material.dispose();
      }
    },
  };
}

function createDirectionMesh(
  scene: Scene,
  direction: FlowDirection,
  color: number,
): DirectionMesh {
  const geometry = new ConeGeometry(0.26, direction === "down" ? 0.95 : 0.75, 4);
  const material = new MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const batch = new InstancedMeshBatch({
    scene,
    geometry,
    material,
    chunkCapacity: WEBGPU_SAFE_BATCH_CAPACITY,
    frustumCulled: false,
    name: `flow-${direction}-batch`,
  });

  return { direction, batch, material, geometry };
}

function updateFlowDebug(
  meshes: DirectionMesh[],
  world: VoxelWorld,
  flows: Map<number, RecentFlow>,
  enabled: boolean,
  options: RenderOptions,
): void {
  for (const entry of meshes) {
    updateDirectionMesh(entry, world, flows, enabled, options);
  }
}

function updateDirectionMesh(
  entry: DirectionMesh,
  world: VoxelWorld,
  flows: Map<number, RecentFlow>,
  enabled: boolean,
  options: RenderOptions,
): void {
  if (!enabled) {
    entry.batch.clear();
    return;
  }

  if (flows.size === 0) {
    entry.batch.clear();
    return;
  }

  entry.batch.begin();
  for (const [cellIndex, flow] of flows) {
    if (flow.direction !== entry.direction || world.solid[cellIndex] === 1) {
      continue;
    }

    const cell = coords(world, cellIndex);
    if (!shouldRenderCell(world, cell.z, options)) {
      continue;
    }

    const center = cellCenter(world, cell.x, cell.y, cell.z);
    directionVector.set(flow.dx, flow.dy, flow.dz).normalize();
    rotation.setFromUnitVectors(upVector, directionVector);
    const scale = Math.min(1.6, 0.75 + flow.amount * 0.9);
    dummy.position.set(
      center.x - directionVector.x * 0.2,
      center.y - directionVector.y * 0.2,
      center.z - directionVector.z * 0.2,
    );
    dummy.quaternion.copy(rotation);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    entry.batch.pushMatrix(dummy.matrix);
  }

  entry.batch.finish();
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
