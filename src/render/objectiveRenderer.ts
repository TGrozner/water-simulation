import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene } from "three";
import type { GameLevel, LevelProgress, ObjectiveZone } from "../game/levels";
import type { RenderOptions } from "./renderOptions";
import type { VoxelWorld } from "../world/types";

export type ObjectiveRenderer = {
  update: (world: VoxelWorld, level: GameLevel, progress: LevelProgress, options: RenderOptions) => void;
  dispose: () => void;
};

type ZoneMesh = {
  id: string;
  mesh: Mesh<BoxGeometry, MeshBasicMaterial>;
};

export function createObjectiveRenderer(scene: Scene): ObjectiveRenderer {
  const group = new Group();
  const zoneMeshes = new Map<string, ZoneMesh>();
  scene.add(group);

  return {
    update: (world, level, progress, options) => {
      const visibleZoneIds = new Set(level.zones.map((zone) => zone.id));

      for (const zone of level.zones) {
        const objective = progress.objectives.find((entry) => entry.zone.id === zone.id);
        const zoneMesh = getOrCreateZoneMesh(group, zoneMeshes, zone.id);
        positionZoneMesh(zoneMesh.mesh, world, zone);
        zoneMesh.mesh.visible = !options.slice.enabled || zoneContainsSlice(zone, options.slice.z);
        zoneMesh.mesh.material.color.set(objective?.complete ? 0x62ff8b : 0xffd65a);
        zoneMesh.mesh.material.opacity = objective?.complete ? 0.28 : 0.2;
      }

      for (const [zoneId, zoneMesh] of zoneMeshes) {
        if (!visibleZoneIds.has(zoneId)) {
          group.remove(zoneMesh.mesh);
          zoneMesh.mesh.geometry.dispose();
          zoneMesh.mesh.material.dispose();
          zoneMeshes.delete(zoneId);
        }
      }
    },
    dispose: () => {
      scene.remove(group);
      for (const zoneMesh of zoneMeshes.values()) {
        zoneMesh.mesh.geometry.dispose();
        zoneMesh.mesh.material.dispose();
      }
      zoneMeshes.clear();
    },
  };
}

function zoneContainsSlice(zone: ObjectiveZone, sliceZ: number): boolean {
  return sliceZ >= zone.minZ && sliceZ <= zone.maxZ;
}

function getOrCreateZoneMesh(group: Group, zoneMeshes: Map<string, ZoneMesh>, id: string): ZoneMesh {
  const existing = zoneMeshes.get(id);
  if (existing) {
    return existing;
  }

  const geometry = new BoxGeometry(1, 1, 1);
  const material = new MeshBasicMaterial({
    color: 0xffd65a,
    transparent: true,
    opacity: 0.2,
    wireframe: true,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  group.add(mesh);

  const zoneMesh = { id, mesh };
  zoneMeshes.set(id, zoneMesh);
  return zoneMesh;
}

function positionZoneMesh(mesh: Mesh, world: VoxelWorld, zone: ObjectiveZone): void {
  const width = zone.maxX - zone.minX + 1;
  const height = zone.maxY - zone.minY + 1;
  const depth = zone.maxZ - zone.minZ + 1;
  const centerX = zone.minX + width / 2 - world.width / 2;
  const centerY = zone.minY + height / 2;
  const centerZ = zone.minZ + depth / 2 - world.depth / 2;

  mesh.position.set(centerX, centerY, centerZ);
  mesh.scale.set(width, height, depth);
}
