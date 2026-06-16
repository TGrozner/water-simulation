import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
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

const SONAR_RADIUS = 30;
const SONAR_CAMERA_HEIGHT = 76;
const SONAR_CAMERA_TILT = 38;
const SONAR_HEADER_HEIGHT = 48;
const SONAR_VERTICAL_RANGE = 24;
const SONAR_VERTICAL_SCALE = 0.28;
const SONAR_MIN_COLUMN_HEIGHT = 0.16;
const SONAR_MAX_COLUMN_HEIGHT = 7.2;
const SONAR_PROJECTION_BUCKET_SIZE = 0.75;
const SONAR_PLAYER_MARKER_Y = 1.1;
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
    <div class="sonar-panel-title"><span>Cave sonar</span><em>volume</em><b>N</b></div>
    <div class="sonar-panel-legend"><span>floor</span><i></i><span>roof</span><strong>water</strong></div>
  `;
  parent.appendChild(panel);
  let sonarWorld = world;
  let terrainDirty = true;
  let waterDirty = true;
  let lastTerrainProjectionKey = "";
  let lastWaterProjectionKey = "";

  const scene = new Scene();
  scene.background = new Color(0x071018);
  scene.add(new AmbientLight(0xb7eaff, 0.62));
  const terrainLight = new DirectionalLight(0xffffff, 1.35);
  terrainLight.position.set(-18, 34, 22);
  scene.add(terrainLight);

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

  const terrainGeometry = new BoxGeometry(1.02, 1, 1.02);
  const terrainMaterial = new MeshLambertMaterial({
    color: 0xffffff,
  });
  const terrainBatch = new InstancedMeshBatch({
    scene,
    geometry: terrainGeometry,
    material: terrainMaterial,
    chunkCapacity: 1000,
    frustumCulled: false,
    name: "sonar-terrain-batch",
    renderOrder: 2,
  });
  const waterGeometry = new BoxGeometry(0.98, 1, 0.98);
  const waterMaterial = new MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.72,
    depthTest: false,
    depthWrite: false,
  });
  const waterBatch = new InstancedMeshBatch({
    scene,
    geometry: waterGeometry,
    material: waterMaterial,
    chunkCapacity: 1000,
    frustumCulled: false,
    name: "sonar-water-batch",
    renderOrder: 7,
  });

  const playerMarker = new Mesh(
    new SphereGeometry(0.85, 12, 8),
    new MeshBasicMaterial({ color: 0xf8ff9a, depthTest: false }),
  );
  playerMarker.renderOrder = 20;
  root.add(playerMarker);

  const directionGeometry = new BufferGeometry().setFromPoints([new Vector3(), new Vector3(0, 0, -4)]);
  const directionLine = new Line(directionGeometry, new LineBasicMaterial({ color: 0xf8ff9a, depthTest: false }));
  directionLine.renderOrder = 21;
  root.add(directionLine);

  const resize = () => {
    const bounds = panel.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height - SONAR_HEADER_HEIGHT));
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
      terrainDirty = true;
    },
    updateWater: (nextWorld) => {
      sonarWorld = nextWorld;
      waterDirty = true;
    },
    render: (sourceCamera) => {
      const projectionKey = getSonarProjectionKey(sourceCamera, sonarWorld);
      if (terrainDirty || projectionKey !== lastTerrainProjectionKey) {
        updateProjectedTerrainMesh(terrainBatch, sonarWorld, sourceCamera);
        terrainDirty = false;
        lastTerrainProjectionKey = projectionKey;
      }
      if (waterDirty || projectionKey !== lastWaterProjectionKey) {
        updateProjectedWaterMesh(waterBatch, sonarWorld, sourceCamera);
        waterDirty = false;
        lastWaterProjectionKey = projectionKey;
      }
      updateCameraMarker(playerMarker, directionLine, sourceCamera, sonarWorld);
      updateRangeGuides(rangeGuides.group, sourceCamera, sonarWorld);
      updateMissionBeacons(missionBeacons.group, sonarWorld, sourceCamera);
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

type SonarColumnProfile = {
  floorY: number;
  ceilingY: number;
  centerY: number;
  openHeight: number;
  sideContactRatio: number;
  capContact: number;
};

type SonarWaterColumn = {
  amount: number;
  minY: number;
  topY: number;
  filledHeight: number;
};

function createRangeGuides(): RangeGuides {
  const group = new Group();
  const material = new LineBasicMaterial({ color: 0x69e7ff, transparent: true, opacity: 0.2, depthTest: false });
  const rings = SONAR_RANGE_RINGS.map((radius) => {
    const points: Vector3[] = [];
    for (let i = 0; i <= 72; i += 1) {
      const angle = (i / 72) * Math.PI * 2;
      points.push(new Vector3(Math.cos(angle) * radius, SONAR_PLAYER_MARKER_Y, Math.sin(angle) * radius));
    }
    const ring = new LineLoop(new BufferGeometry().setFromPoints(points), material);
    ring.renderOrder = 10;
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
      depthTest: false,
      depthWrite: false,
    });
    materials.push(material);
    const marker = new Mesh(geometry, material);
    marker.rotation.x = -Math.PI / 2;
    marker.scale.setScalar(beacon.scale);
    marker.renderOrder = 15;
    group.add(marker);
    return marker;
  });

  return { group, markers, geometry, materials };
}

function updateRangeGuides(group: Group, sourceCamera: PerspectiveCamera, world: VoxelWorld): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  group.position.set(playerPosition.x, 0, playerPosition.z);
}

function updateMissionBeacons(group: Group, world: VoxelWorld, sourceCamera: PerspectiveCamera): void {
  group.visible = world.width >= 64 && world.depth >= 64;
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  for (let i = 0; i < group.children.length; i += 1) {
    const beacon = SONAR_MISSION_BEACONS[i];
    const marker = group.children[i];
    const profile = getSonarColumnProfile(world, beacon.x, beacon.z, playerPosition.y);
    const markerY = profile ? toSonarY(profile.centerY, playerPosition.y) + 0.44 : SONAR_PLAYER_MARKER_Y;
    marker.position.set(beacon.x - world.width / 2 + 0.5, markerY, beacon.z - world.depth / 2 + 0.5);
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

  mapCameraPosition.set(playerPosition.x, SONAR_CAMERA_HEIGHT, playerPosition.z + SONAR_CAMERA_TILT);
  mapTarget.set(playerPosition.x, 0, playerPosition.z);
  mapUp.set(0, 0, -1);

  mapCamera.position.copy(mapCameraPosition);
  mapCamera.up.copy(mapUp);
  mapCamera.lookAt(mapTarget);
  mapCamera.updateMatrixWorld();
}

function getSonarProjectionKey(sourceCamera: PerspectiveCamera, world: VoxelWorld): string {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  return [
    Math.round(playerPosition.x / SONAR_PROJECTION_BUCKET_SIZE),
    Math.round(playerPosition.y / SONAR_PROJECTION_BUCKET_SIZE),
    Math.round(playerPosition.z / SONAR_PROJECTION_BUCKET_SIZE),
  ].join(":");
}

function updateProjectedTerrainMesh(
  batch: InstancedMeshBatch<BoxGeometry, MeshLambertMaterial>,
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

      const profile = getSonarColumnProfile(world, x, z, playerPosition.y);
      if (!profile) {
        continue;
      }

      const columnHeight = getSonarColumnHeight(profile.openHeight);
      const footprint = 1.0;
      terrainDummy.position.set(
        x - world.width / 2 + 0.5,
        toSonarY(profile.centerY, playerPosition.y),
        z - world.depth / 2 + 0.5,
      );
      terrainDummy.scale.set(footprint, columnHeight, footprint);
      terrainDummy.updateMatrix();
      const color = getSonarTerrainColor(world, profile, playerPosition.y);
      batch.pushMatrix(terrainDummy.matrix, undefined, color);
    }
  }

  batch.finish();
}

function updateProjectedWaterMesh(
  batch: InstancedMeshBatch<BoxGeometry, MeshLambertMaterial>,
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

      const waterHeight = Math.max(
        0.12,
        Math.min(2.8, columnWater.filledHeight * SONAR_VERTICAL_SCALE * 0.75 + columnWater.amount * 0.035),
      );
      waterDummy.position.set(
        x - world.width / 2 + 0.5,
        toSonarY((columnWater.minY + columnWater.topY) * 0.5, playerPosition.y),
        z - world.depth / 2 + 0.5,
      );
      waterDummy.scale.set(0.92, waterHeight, 0.92);
      waterDummy.updateMatrix();
      batch.pushMatrix(waterDummy.matrix, undefined, getSonarWaterColor(world, columnWater.topY, columnWater.amount));
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
  marker.position.set(clampedCameraPosition.x, SONAR_PLAYER_MARKER_Y, clampedCameraPosition.z);

  cameraDirection.copy(getFlatCameraDirection(sourceCamera));

  const positions = directionLine.geometry.attributes.position;
  positions.setXYZ(0, clampedCameraPosition.x, SONAR_PLAYER_MARKER_Y + 0.08, clampedCameraPosition.z);
  positions.setXYZ(
    1,
    clampedCameraPosition.x + cameraDirection.x * 5,
    SONAR_PLAYER_MARKER_Y + 0.08,
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

function getSonarColumnProfile(world: VoxelWorld, x: number, z: number, playerY: number): SonarColumnProfile | null {
  let bestProfile: SonarColumnProfile | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let spanStart = -1;
  let sideContacts = 0;

  const finishSpan = (spanEnd: number) => {
    if (spanStart < 0) {
      return;
    }

    const openHeight = spanEnd - spanStart + 1;
    const centerY = (spanStart + spanEnd) * 0.5;
    const rangeOverlap = getRangeOverlap(
      spanStart,
      spanEnd,
      Math.max(0, playerY - SONAR_VERTICAL_RANGE),
      Math.min(world.height - 1, playerY + SONAR_VERTICAL_RANGE),
    );
    const containsPlayer = playerY >= spanStart && playerY <= spanEnd;
    const playerDistance = containsPlayer
      ? 0
      : Math.min(Math.abs(playerY - spanStart), Math.abs(playerY - spanEnd));
    const floorContact = isSolidCell(world, x, spanStart - 1, z) ? 1 : 0;
    const ceilingContact = isSolidCell(world, x, spanEnd + 1, z) ? 1 : 0;
    const capContact = floorContact + ceilingContact;
    const sideContactRatio = sideContacts / Math.max(1, openHeight * 4);

    if (capContact + sideContacts <= 0) {
      spanStart = -1;
      sideContacts = 0;
      return;
    }

    const score =
      (containsPlayer ? -12 : 0) -
      rangeOverlap * 3 -
      Math.min(openHeight, 22) * 0.55 -
      sideContactRatio * 4 -
      capContact * 0.8 +
      playerDistance * 0.32;

    if (score < bestScore) {
      bestScore = score;
      bestProfile = {
        floorY: spanStart,
        ceilingY: spanEnd,
        centerY,
        openHeight,
        sideContactRatio,
        capContact,
      };
    }

    spanStart = -1;
    sideContacts = 0;
  };

  for (let y = 0; y < world.height; y += 1) {
    const cellIndex = x + world.width * (z + world.depth * y);
    const isOpen = isInsideSonarBounds(world, x, y, z) && world.solid[cellIndex] === 0;

    if (isOpen) {
      if (spanStart < 0) {
        spanStart = y;
      }
      sideContacts += countSideSolidCells(world, x, y, z);
      continue;
    }

    finishSpan(y - 1);
  }

  finishSpan(world.height - 1);
  return bestProfile;
}

function getProjectedColumnWater(world: VoxelWorld, x: number, z: number): SonarWaterColumn {
  let amount = 0;
  let minY = world.height;
  let topY = 0;
  let filledHeight = 0;

  for (let y = 0; y < world.height; y += 1) {
    const cellIndex = x + world.width * (z + world.depth * y);
    const water = world.water[cellIndex];
    if (water <= EPSILON || world.solid[cellIndex] === 1) {
      continue;
    }

    amount += water;
    minY = Math.min(minY, y);
    topY = y;
    filledHeight += 1;
  }

  if (amount <= EPSILON) {
    minY = 0;
  }

  return { amount, minY, topY, filledHeight };
}

function getSonarTerrainColor(world: VoxelWorld, profile: SonarColumnProfile, playerY: number): Color {
  const relative = clamp((profile.centerY - playerY) / SONAR_VERTICAL_RANGE, -1, 1);
  const height = world.height <= 1 ? 0 : profile.centerY / (world.height - 1);
  const clearance = clamp(profile.openHeight / 15, 0, 1);
  const wallSignal = clamp(profile.sideContactRatio * 1.4 + profile.capContact * 0.12, 0, 1);

  if (relative > 0.24) {
    terrainColor.setRGB(0.9 + wallSignal * 0.08, 0.58 + height * 0.24, 0.24 + clearance * 0.2);
  } else if (relative < -0.24) {
    terrainColor.setRGB(0.1 + clearance * 0.08, 0.28 + wallSignal * 0.14, 0.58 + height * 0.24);
  } else {
    terrainColor.setRGB(0.24 + clearance * 0.16, 0.7 + wallSignal * 0.2, 0.76 + height * 0.16);
  }
  return terrainColor;
}

function getSonarWaterColor(world: VoxelWorld, y: number, amount: number): Color {
  const height = world.height <= 1 ? 0 : y / (world.height - 1);
  const intensity = Math.min(1, 0.35 + amount * 0.15);
  waterColor.setRGB(0.08 + height * 0.08, 0.38 + intensity * 0.26, 1);
  return waterColor;
}

function getSonarColumnHeight(openHeight: number): number {
  return clamp(openHeight * SONAR_VERTICAL_SCALE, SONAR_MIN_COLUMN_HEIGHT, SONAR_MAX_COLUMN_HEIGHT);
}

function toSonarY(worldY: number, playerY: number): number {
  return (worldY - playerY) * SONAR_VERTICAL_SCALE;
}

function getRangeOverlap(start: number, end: number, rangeStart: number, rangeEnd: number): number {
  return Math.max(0, Math.min(end, rangeEnd) - Math.max(start, rangeStart) + 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getColumnDistance(playerPosition: Vector3, world: VoxelWorld, x: number, z: number): number {
  const worldX = x - world.width / 2 + 0.5;
  const worldZ = z - world.depth / 2 + 0.5;
  return Math.hypot(worldX - playerPosition.x, worldZ - playerPosition.z);
}

function isInsideSonarBounds(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return x >= 4 && x < world.width - 4 && y <= world.height - 2 && z >= 4 && z < world.depth - 4;
}

function countSideSolidCells(world: VoxelWorld, x: number, y: number, z: number): number {
  let solid = 0;
  solid += isSolidCell(world, x + 1, y, z) ? 1 : 0;
  solid += isSolidCell(world, x - 1, y, z) ? 1 : 0;
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
