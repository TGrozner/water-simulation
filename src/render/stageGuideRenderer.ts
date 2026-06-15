import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Scene,
} from "three";
import { getStageDigBoxes, type ClearBox, type SceneOpeningStage } from "../world/sceneTools";
import type { VoxelWorld } from "../world/types";
import type { RenderOptions } from "./renderOptions";

export type StageGuideRenderer = {
  update: (world: VoxelWorld, stage: SceneOpeningStage | null, options: RenderOptions) => void;
  dispose: () => void;
};

type StageGuideStyle = {
  color?: number;
  fill?: boolean;
  opacity?: number;
  scale?: number;
  wireframe?: boolean;
  depthTest?: boolean;
  outline?: boolean;
  cornerOnly?: boolean;
  outlineColor?: number;
  outlineOpacity?: number;
  outlineScale?: number;
  outlineDepthTest?: boolean;
};

export function createStageGuideRenderer(scene: Scene, style: StageGuideStyle = {}): StageGuideRenderer {
  const color = style.color ?? 0xffc247;
  const fill = style.fill ?? true;
  const opacity = style.opacity ?? 0.32;
  const scale = style.scale ?? 1;
  const wireframe = style.wireframe ?? true;
  const depthTest = style.depthTest ?? true;
  const outline = style.outline ?? false;
  const cornerOnly = style.cornerOnly ?? false;
  const outlineColor = style.outlineColor ?? color;
  const outlineOpacity = style.outlineOpacity ?? 0.88;
  const outlineScale = style.outlineScale ?? scale * 1.02;
  const outlineDepthTest = style.outlineDepthTest ?? depthTest;
  const group = new Group();
  const fillMeshes: Mesh<BoxGeometry, MeshBasicMaterial>[] = [];
  const outlineMeshes: LineSegments<BufferGeometry, LineBasicMaterial>[] = [];
  scene.add(group);

  return {
    update: (world, stage, options) => {
      const boxes = stage ? getStageDigBoxes(stage) : [];
      ensureMeshCount(group, fillMeshes, fill ? boxes.length : 0, color, opacity, wireframe, depthTest);
      ensureOutlineCount(group, outlineMeshes, outline ? boxes.length : 0, outlineColor, outlineOpacity, outlineDepthTest, cornerOnly);

      const meshCount = Math.max(fillMeshes.length, outlineMeshes.length);
      for (let i = 0; i < meshCount; i += 1) {
        const mesh = fillMeshes[i];
        const outlineMesh = outlineMeshes[i];
        const box = boxes[i];
        const visible = Boolean(box) && (!options.slice.enabled || boxContainsSlice(box, options.slice.z));
        if (mesh) {
          mesh.visible = visible;
        }
        if (outlineMesh) {
          outlineMesh.visible = visible;
        }
        if (!box) {
          continue;
        }

        if (mesh) {
          positionGuideMesh(mesh, world, box, scale);
        }
        if (outlineMesh) {
          positionGuideMesh(outlineMesh, world, box, outlineScale);
        }
      }
    },
    dispose: () => {
      scene.remove(group);
      for (const mesh of [...fillMeshes, ...outlineMeshes]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      fillMeshes.length = 0;
      outlineMeshes.length = 0;
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
  depthTest: boolean,
): void {
  while (meshes.length < count) {
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        wireframe,
        depthTest,
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

function ensureOutlineCount(
  group: Group,
  meshes: LineSegments<BufferGeometry, LineBasicMaterial>[],
  count: number,
  color: number,
  opacity: number,
  depthTest: boolean,
  cornerOnly: boolean,
): void {
  while (meshes.length < count) {
    const mesh = new LineSegments(
      cornerOnly ? createCornerOutlineGeometry() : new EdgesGeometry(new BoxGeometry(1, 1, 1)),
      new LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest,
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

function createCornerOutlineGeometry(): BufferGeometry {
  const positions: number[] = [];
  const length = 0.24;
  const signs = [-1, 1] as const;

  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        const x = sx * 0.5;
        const y = sy * 0.5;
        const z = sz * 0.5;
        positions.push(x, y, z, sx * (0.5 - length), y, z);
        positions.push(x, y, z, x, sy * (0.5 - length), z);
        positions.push(x, y, z, x, y, sz * (0.5 - length));
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  return geometry;
}

function boxContainsSlice(box: ClearBox, sliceZ: number): boolean {
  return sliceZ >= box.minZ && sliceZ <= box.maxZ;
}

function positionGuideMesh(mesh: Object3D, world: VoxelWorld, box: ClearBox, scale: number): void {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const depth = box.maxZ - box.minZ + 1;
  const centerX = box.minX + width / 2 - world.width / 2;
  const centerY = box.minY + height / 2;
  const centerZ = box.minZ + depth / 2 - world.depth / 2;

  mesh.position.set(centerX, centerY, centerZ);
  mesh.scale.set(width, height, depth).multiplyScalar(scale);
}
