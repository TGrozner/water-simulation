import { ConeGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from "three";
import { cellCenter, coords } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import type { FlowDirection } from "../sim/waterSimulation";
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
  mesh: InstancedMesh;
  material: MeshBasicMaterial;
  geometry: ConeGeometry;
};

const dummy = new Object3D();
const upVector = new Vector3(0, 1, 0);
const directionVector = new Vector3();
const rotation = new Quaternion();
const WEBGPU_SAFE_INSTANCE_CAPACITY = 1000;

export function createFlowDebugRenderer(scene: Scene, world: VoxelWorld): FlowDebugRenderer {
  const meshes: DirectionMesh[] = [
    createDirectionMesh(scene, world, "down", 0x66d9ff),
    createDirectionMesh(scene, world, "side", 0x78ff7a),
  ];

  return {
    update: (nextWorld, flows, enabled, options = defaultRenderOptions(nextWorld)) =>
      updateFlowDebug(meshes, nextWorld, flows, enabled, options),
    dispose: () => {
      for (const entry of meshes) {
        scene.remove(entry.mesh);
        entry.geometry.dispose();
        entry.material.dispose();
      }
    },
  };
}

function createDirectionMesh(
  scene: Scene,
  world: VoxelWorld,
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
  const mesh = new InstancedMesh(geometry, material, Math.min(world.water.length, WEBGPU_SAFE_INSTANCE_CAPACITY));
  mesh.frustumCulled = false;
  scene.add(mesh);

  return { direction, mesh, material, geometry };
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
  const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);

  if (!enabled) {
    if (entry.mesh.count === 0) {
      return;
    }

    for (let i = 0; i < entry.mesh.count; i += 1) {
      entry.mesh.setMatrixAt(i, hiddenMatrix);
    }
    entry.mesh.count = 0;
    entry.mesh.instanceMatrix.needsUpdate = true;
    return;
  }

  let instanceCount = 0;
  const capacity = entry.mesh.instanceMatrix.count;
  if (flows.size === 0) {
    entry.mesh.count = 0;
    entry.mesh.instanceMatrix.needsUpdate = true;
    return;
  }

  for (const [cellIndex, flow] of flows) {
    if (instanceCount >= capacity) {
      break;
    }

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
    entry.mesh.setMatrixAt(instanceCount, dummy.matrix);
    instanceCount += 1;
  }

  for (let i = instanceCount; i < entry.mesh.count; i += 1) {
    entry.mesh.setMatrixAt(i, hiddenMatrix);
  }

  entry.mesh.count = instanceCount;
  entry.mesh.instanceMatrix.needsUpdate = true;
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
