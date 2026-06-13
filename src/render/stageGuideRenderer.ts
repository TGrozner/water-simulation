import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene } from "three";
import { getStageDigBoxes, type ClearBox, type SceneOpeningStage } from "../world/sceneTools";
import type { VoxelWorld } from "../world/types";
import type { RenderOptions } from "./renderOptions";

export type StageGuideRenderer = {
  update: (world: VoxelWorld, stage: SceneOpeningStage | null, options: RenderOptions) => void;
  dispose: () => void;
};

type StageGuideStyle = {
  color?: number;
  opacity?: number;
  scale?: number;
  wireframe?: boolean;
};

export function createStageGuideRenderer(scene: Scene, style: StageGuideStyle = {}): StageGuideRenderer {
  const color = style.color ?? 0xffc247;
  const opacity = style.opacity ?? 0.32;
  const scale = style.scale ?? 1;
  const wireframe = style.wireframe ?? true;
  const group = new Group();
  const meshes: Mesh<BoxGeometry, MeshBasicMaterial>[] = [];
  scene.add(group);

  return {
    update: (world, stage, options) => {
      const boxes = stage ? getStageDigBoxes(stage) : [];
      ensureMeshCount(group, meshes, boxes.length, color, opacity, wireframe);

      for (let i = 0; i < meshes.length; i += 1) {
        const mesh = meshes[i];
        const box = boxes[i];
        mesh.visible = Boolean(box) && (!options.slice.enabled || boxContainsSlice(box, options.slice.z));
        if (!box) {
          continue;
        }

        positionGuideMesh(mesh, world, box, scale);
      }
    },
    dispose: () => {
      scene.remove(group);
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      meshes.length = 0;
    },
  };
}

function ensureMeshCount(
  group: Group,
  meshes: Mesh<BoxGeometry, MeshBasicMaterial>[],
  count: number,
  color: number,
  opacity: number,
  wireframe: boolean,
): void {
  while (meshes.length < count) {
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        wireframe,
        depthTest: false,
        depthWrite: false,
      }),
    );
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  for (let i = count; i < meshes.length; i += 1) {
    meshes[i].visible = false;
  }
}

function boxContainsSlice(box: ClearBox, sliceZ: number): boolean {
  return sliceZ >= box.minZ && sliceZ <= box.maxZ;
}

function positionGuideMesh(mesh: Mesh, world: VoxelWorld, box: ClearBox, scale: number): void {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const depth = box.maxZ - box.minZ + 1;
  const centerX = box.minX + width / 2 - world.width / 2;
  const centerY = box.minY + height / 2;
  const centerZ = box.minZ + depth / 2 - world.depth / 2;

  mesh.position.set(centerX, centerY, centerZ);
  mesh.scale.set(width, height, depth).multiplyScalar(scale);
}
