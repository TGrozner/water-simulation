import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import { InstancedMeshBatch } from "./instancedMeshBatch";
import { EPSILON, type VoxelWorld } from "../world/types";

export type SonarRenderer = {
  updateTerrain: (world: VoxelWorld) => void;
  updateWater: (world: VoxelWorld) => void;
  render: (sourceCamera: PerspectiveCamera) => void;
  dispose: () => void;
};

const terrainDummy = new Object3D();
const waterDummy = new Object3D();
const cameraDirection = new Vector3();
const clampedCameraPosition = new Vector3();
const mapCameraPosition = new Vector3();
const mapTarget = new Vector3();
const mapUp = new Vector3();
const terrainColor = new Color();
const waterColor = new Color();

const SONAR_RADIUS = 24;
const SONAR_CAMERA_HEIGHT = 72;
const SONAR_VERTICAL_RANGE = 16;
const SONAR_RANGE_RINGS = [8, 16, 24] as const;
const SONAR_MISSION_BEACONS = [
  { x: 21, z: 27, color: 0xffc247, scale: 1.12 },
  { x: 33, z: 32, color: 0xeaf4ff, scale: 0.98 },
  { x: 58, z: 20, color: 0x52d9ff, scale: 1.08 },
  { x: 58, z: 58, color: 0x7df4c1, scale: 1.08 },
] as const;

export function createSonarRenderer(parent: HTMLElement, world: VoxelWorld): SonarRenderer {
  const panel = document.createElement("section");
  panel.className = "sonar-panel";
  panel.innerHTML = `
    <div class="sonar-panel-title"><span>Cave sonar</span><em>route</em><b>N</b></div>
    <div class="sonar-panel-legend"><span>low</span><i></i><span>high</span><strong>water</strong></div>
  `;
  parent.appendChild(panel);
  let sonarWorld = world;

  const scene = new Scene();
  scene.background = new Color(0x071018);

  const camera = new OrthographicCamera(-SONAR_RADIUS, SONAR_RADIUS, SONAR_RADIUS, -SONAR_RADIUS, 0.1, 200);
  camera.position.set(0, SONAR_CAMERA_HEIGHT, 0);
  camera.lookAt(0, 0, 0);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  panel.appendChild(renderer.domElement);

  const root = new Group();
  scene.add(root);

  const rangeGuides = createRangeGuides();
  root.add(rangeGuides.group);
  const missionBeacons = createMissionBeacons();
  root.add(missionBeacons.group);

  const terrainGeometry = new BoxGeometry(0.92, 0.035, 0.92);
  const terrainMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.78,
  });
  const terrainBatch = new InstancedMeshBatch({
    scene,
    geometry: terrainGeometry,
    material: terrainMaterial,
    chunkCapacity: 1000,
    frustumCulled: false,
    name: "sonar-terrain-batch",
  });

  const waterGeometry = new BoxGeometry(1.02, 0.045, 1.02);
  const waterMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.68,
  });
  const waterBatch = new InstancedMeshBatch({
    scene,
    geometry: waterGeometry,
    material: waterMaterial,
    chunkCapacity: 1000,
    frustumCulled: false,
    name: "sonar-water-batch",
  });

  const playerMarker = new Mesh(
    new SphereGeometry(0.85, 12, 8),
    new MeshBasicMaterial({ color: 0xf8ff9a }),
  );
  root.add(playerMarker);

  const directionGeometry = new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -4)]);
  const directionLine = new Line(directionGeometry, new LineBasicMaterial({ color: 0xf8ff9a }));
  root.add(directionLine);

  const resize = () => {
    const bounds = panel.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height - 43));
    const aspect = width / height;
    camera.left = -SONAR_RADIUS * aspect;
    camera.right = SONAR_RADIUS * aspect;
    camera.top = SONAR_RADIUS;
    camera.bottom = -SONAR_RADIUS;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(panel);
  resize();

  const sonarRenderer: SonarRenderer = {
    updateTerrain: (nextWorld) => {
      sonarWorld = nextWorld;
    },
    updateWater: (nextWorld) => {
      sonarWorld = nextWorld;
    },
    render: (sourceCamera) => {
      updateProjectedTerrainMesh(terrainBatch, sonarWorld, sourceCamera);
      updateProjectedWaterMesh(waterBatch, sonarWorld, sourceCamera);
      updateCameraMarker(playerMarker, directionLine, sourceCamera, sonarWorld);
      updateRangeGuides(rangeGuides.group, sourceCamera, sonarWorld);
      updateMissionBeacons(missionBeacons.group, sonarWorld);
      updateMapCamera(camera, sourceCamera, sonarWorld);
      renderer.render(scene, camera);
    },
    dispose: () => {
      resizeObserver.disconnect();
      parent.removeChild(panel);
      terrainBatch.dispose();
      waterBatch.dispose();
      terrainGeometry.dispose();
      terrainMaterial.dispose();
      waterGeometry.dispose();
      waterMaterial.dispose();
      playerMarker.geometry.dispose();
      playerMarker.material.dispose();
      disposeRangeGuides(rangeGuides);
      disposeMissionBeacons(missionBeacons);
      directionGeometry.dispose();
      directionLine.material.dispose();
      renderer.dispose();
    },
  };

  sonarRenderer.updateTerrain(world);
  sonarRenderer.updateWater(world);

  return sonarRenderer;
}

type RangeGuides = {
  group: Group;
  rings: LineLoop[];
  material: LineBasicMaterial;
};

type MissionBeacons = {
  group: Group;
  markers: Mesh[];
  geometry: RingGeometry;
  materials: MeshBasicMaterial[];
};

function createRangeGuides(): RangeGuides {
  const group = new Group();
  const material = new LineBasicMaterial({ color: 0x69e7ff, transparent: true, opacity: 0.18 });
  const rings = SONAR_RANGE_RINGS.map((radius) => {
    const points: Vector3[] = [];
    for (let i = 0; i <= 72; i += 1) {
      const angle = (i / 72) * Math.PI * 2;
      points.push(new Vector3(Math.cos(angle) * radius, 0.12, Math.sin(angle) * radius));
    }
    const ring = new LineLoop(new BufferGeometry().setFromPoints(points), material);
    group.add(ring);
    return ring;
  });
  return { group, rings, material };
}

function createMissionBeacons(): MissionBeacons {
  const group = new Group();
  const geometry = new RingGeometry(0.72, 1.04, 32);
  const materials: MeshBasicMaterial[] = [];
  const markers = SONAR_MISSION_BEACONS.map((beacon) => {
    const material = new MeshBasicMaterial({
      color: beacon.color,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    });
    materials.push(material);
    const marker = new Mesh(geometry, material);
    marker.rotation.x = -Math.PI / 2;
    marker.scale.setScalar(beacon.scale);
    group.add(marker);
    return marker;
  });

  return { group, markers, geometry, materials };
}

function updateRangeGuides(group: Group, sourceCamera: PerspectiveCamera, world: VoxelWorld): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  group.position.set(playerPosition.x, 0, playerPosition.z);
}

function updateMissionBeacons(group: Group, world: VoxelWorld): void {
  group.visible = world.width >= 64 && world.depth >= 64;
  for (let i = 0; i < group.children.length; i += 1) {
    const beacon = SONAR_MISSION_BEACONS[i];
    const marker = group.children[i];
    marker.position.set(beacon.x - world.width / 2 + 0.5, 0.26, beacon.z - world.depth / 2 + 0.5);
  }
}

function disposeRangeGuides(guides: RangeGuides): void {
  for (const ring of guides.rings) {
    ring.geometry.dispose();
  }
  guides.material.dispose();
}

function disposeMissionBeacons(beacons: MissionBeacons): void {
  beacons.geometry.dispose();
  for (const material of beacons.materials) {
    material.dispose();
  }
}

function updateMapCamera(
  mapCamera: OrthographicCamera,
  sourceCamera: PerspectiveCamera,
  world: VoxelWorld,
): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);

  mapCameraPosition.set(playerPosition.x, SONAR_CAMERA_HEIGHT, playerPosition.z);
  mapTarget.set(playerPosition.x, 0, playerPosition.z);
  mapUp.set(0, 0, -1);

  mapCamera.position.copy(mapCameraPosition);
  mapCamera.up.copy(mapUp);
  mapCamera.lookAt(mapTarget);
  mapCamera.updateMatrixWorld();
}

function updateProjectedTerrainMesh(
  batch: InstancedMeshBatch<BoxGeometry, MeshBasicMaterial>,
  world: VoxelWorld,
  sourceCamera: PerspectiveCamera,
): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  const minX = Math.max(0, Math.floor(playerPosition.x + world.width / 2 - SONAR_RADIUS));
  const maxX = Math.min(world.width - 1, Math.ceil(playerPosition.x + world.width / 2 + SONAR_RADIUS));
  const minZ = Math.max(0, Math.floor(playerPosition.z + world.depth / 2 - SONAR_RADIUS));
  const maxZ = Math.min(world.depth - 1, Math.ceil(playerPosition.z + world.depth / 2 + SONAR_RADIUS));

  batch.begin();
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!isInsideSonarBounds(world, x, 0, z) || getColumnDistance(playerPosition, world, x, z) > SONAR_RADIUS) {
        continue;
      }

      const openY = findProjectedOpenY(world, x, z, playerPosition.y);
      if (openY < 0) {
        continue;
      }

      terrainDummy.position.set(x - world.width / 2 + 0.5, 0.01, z - world.depth / 2 + 0.5);
      terrainDummy.scale.setScalar(1);
      terrainDummy.updateMatrix();
      batch.pushMatrix(terrainDummy.matrix, undefined, getSonarTerrainColor(world, openY, playerPosition.y));
    }
  }

  batch.finish();
}

function updateProjectedWaterMesh(
  batch: InstancedMeshBatch<BoxGeometry, MeshBasicMaterial>,
  world: VoxelWorld,
  sourceCamera: PerspectiveCamera,
): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  const minX = Math.max(0, Math.floor(playerPosition.x + world.width / 2 - SONAR_RADIUS));
  const maxX = Math.min(world.width - 1, Math.ceil(playerPosition.x + world.width / 2 + SONAR_RADIUS));
  const minZ = Math.max(0, Math.floor(playerPosition.z + world.depth / 2 - SONAR_RADIUS));
  const maxZ = Math.min(world.depth - 1, Math.ceil(playerPosition.z + world.depth / 2 + SONAR_RADIUS));

  batch.begin();
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!isInsideSonarBounds(world, x, 0, z) || getColumnDistance(playerPosition, world, x, z) > SONAR_RADIUS) {
        continue;
      }

      const columnWater = getProjectedColumnWater(world, x, z);
      if (columnWater.amount <= EPSILON) {
        continue;
      }

      waterDummy.position.set(x - world.width / 2 + 0.5, 0.055, z - world.depth / 2 + 0.5);
      waterDummy.scale.setScalar(1);
      waterDummy.updateMatrix();
      batch.pushMatrix(waterDummy.matrix, undefined, getSonarWaterColor(world, columnWater.y, columnWater.amount));
    }
  }

  batch.finish();
}

function updateCameraMarker(
  marker: Mesh,
  directionLine: Line,
  sourceCamera: PerspectiveCamera,
  world: VoxelWorld,
): void {
  clampedCameraPosition.copy(getClampedCameraPosition(sourceCamera, world));
  marker.position.set(clampedCameraPosition.x, 0.18, clampedCameraPosition.z);

  cameraDirection.copy(getFlatCameraDirection(sourceCamera));

  const positions = directionLine.geometry.attributes.position;
  positions.setXYZ(0, clampedCameraPosition.x, 0.22, clampedCameraPosition.z);
  positions.setXYZ(
    1,
    clampedCameraPosition.x + cameraDirection.x * 5,
    0.22,
    clampedCameraPosition.z + cameraDirection.z * 5,
  );
  positions.needsUpdate = true;
}

function getClampedCameraPosition(sourceCamera: PerspectiveCamera, world: VoxelWorld): Vector3 {
  clampedCameraPosition.copy(sourceCamera.position);
  clampedCameraPosition.x = Math.min(world.width / 2, Math.max(-world.width / 2, clampedCameraPosition.x));
  clampedCameraPosition.y = Math.min(world.height, Math.max(0, clampedCameraPosition.y));
  clampedCameraPosition.z = Math.min(world.depth / 2, Math.max(-world.depth / 2, clampedCameraPosition.z));
  return clampedCameraPosition;
}

function getFlatCameraDirection(sourceCamera: PerspectiveCamera): Vector3 {
  sourceCamera.getWorldDirection(cameraDirection);
  cameraDirection.y = 0;
  if (cameraDirection.lengthSq() < 0.0001) {
    cameraDirection.set(0, 0, -1);
  }
  return cameraDirection.normalize();
}

function findProjectedOpenY(world: VoxelWorld, x: number, z: number, playerY: number): number {
  const minY = Math.max(0, Math.floor(playerY - SONAR_VERTICAL_RANGE));
  const maxY = Math.min(world.height - 1, Math.ceil(playerY + SONAR_VERTICAL_RANGE));
  let bestY = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let y = maxY; y >= minY; y -= 1) {
    const cellIndex = x + world.width * (z + world.depth * y);
    if (!isSonarOpenCell(world, x, y, z, cellIndex)) {
      continue;
    }

    const score = Math.abs(y - playerY) - y * 0.03;
    if (score < bestScore) {
      bestScore = score;
      bestY = y;
    }
  }

  if (bestY >= 0) {
    return bestY;
  }

  for (let y = world.height - 1; y >= 0; y -= 1) {
    const cellIndex = x + world.width * (z + world.depth * y);
    if (isSonarOpenCell(world, x, y, z, cellIndex)) {
      return y;
    }
  }

  return -1;
}

function getProjectedColumnWater(world: VoxelWorld, x: number, z: number): { amount: number; y: number } {
  let amount = 0;
  let topY = 0;

  for (let y = 0; y < world.height; y += 1) {
    const cellIndex = x + world.width * (z + world.depth * y);
    const water = world.water[cellIndex];
    if (water <= EPSILON || world.solid[cellIndex] === 1) {
      continue;
    }

    amount += water;
    topY = y;
  }

  return { amount, y: topY };
}

function getSonarTerrainColor(world: VoxelWorld, y: number, playerY: number): Color {
  const relative = Math.max(-1, Math.min(1, (y - playerY) / SONAR_VERTICAL_RANGE));
  const height = world.height <= 1 ? 0 : y / (world.height - 1);
  if (relative > 0.28) {
    terrainColor.setRGB(0.95, 0.69 + height * 0.16, 0.34);
  } else if (relative < -0.28) {
    terrainColor.setRGB(0.16, 0.42 + height * 0.1, 0.62);
  } else {
    terrainColor.setRGB(0.32 + height * 0.12, 0.86, 0.91);
  }
  return terrainColor;
}

function getSonarWaterColor(world: VoxelWorld, y: number, amount: number): Color {
  const height = world.height <= 1 ? 0 : y / (world.height - 1);
  const intensity = Math.min(1, 0.35 + amount * 0.15);
  waterColor.setRGB(0.08 + height * 0.08, 0.38 + intensity * 0.26, 1);
  return waterColor;
}

function getColumnDistance(playerPosition: Vector3, world: VoxelWorld, x: number, z: number): number {
  const worldX = x - world.width / 2 + 0.5;
  const worldZ = z - world.depth / 2 + 0.5;
  return Math.hypot(worldX - playerPosition.x, worldZ - playerPosition.z);
}

function isSonarOpenCell(world: VoxelWorld, x: number, y: number, z: number, cellIndex: number): boolean {
  return (
    world.solid[cellIndex] === 0 &&
    isInsideSonarBounds(world, x, y, z) &&
    countAdjacentSolidCells(world, x, y, z) > 0
  );
}

function isInsideSonarBounds(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return x >= 4 && x < world.width - 4 && y <= world.height - 2 && z >= 4 && z < world.depth - 4;
}

function countAdjacentSolidCells(world: VoxelWorld, x: number, y: number, z: number): number {
  let solid = 0;
  solid += isSolidCell(world, x + 1, y, z) ? 1 : 0;
  solid += isSolidCell(world, x - 1, y, z) ? 1 : 0;
  solid += isSolidCell(world, x, y + 1, z) ? 1 : 0;
  solid += isSolidCell(world, x, y - 1, z) ? 1 : 0;
  solid += isSolidCell(world, x, y, z + 1) ? 1 : 0;
  solid += isSolidCell(world, x, y, z - 1) ? 1 : 0;
  return solid;
}

function isSolidCell(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return true;
  }

  return world.solid[x + world.width * (z + world.depth * y)] === 1;
}
