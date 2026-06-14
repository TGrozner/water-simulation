import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
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

const SONAR_RADIUS = 18;
const SONAR_CAMERA_HEIGHT = 72;

export function createSonarRenderer(parent: HTMLElement, world: VoxelWorld): SonarRenderer {
  const panel = document.createElement("section");
  panel.className = "sonar-panel";
  panel.innerHTML = `<div class="sonar-panel-title">Cave sonar</div>`;
  parent.appendChild(panel);

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

  const terrainGeometry = new BoxGeometry(0.82, 0.82, 0.82);
  const terrainMaterial = new MeshBasicMaterial({
    color: 0x6fe7ff,
    transparent: true,
    opacity: 0.16,
    wireframe: true,
  });
  const terrainMesh = new InstancedMesh(terrainGeometry, terrainMaterial, world.solid.length);
  terrainMesh.frustumCulled = false;
  root.add(terrainMesh);

  const waterGeometry = new BoxGeometry(0.76, 0.76, 0.76);
  const waterMaterial = new MeshBasicMaterial({
    color: 0x2e8dff,
    transparent: true,
    opacity: 0.48,
  });
  const waterMesh = new InstancedMesh(waterGeometry, waterMaterial, world.water.length);
  waterMesh.frustumCulled = false;
  root.add(waterMesh);

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
    const height = Math.max(1, Math.floor(bounds.height - 24));
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
    updateTerrain: (nextWorld) => updateTerrainMesh(terrainMesh, nextWorld),
    updateWater: (nextWorld) => updateWaterMesh(waterMesh, nextWorld),
    render: (sourceCamera) => {
      updateCameraMarker(playerMarker, directionLine, sourceCamera, world);
      updateMapCamera(camera, sourceCamera, world);
      renderer.render(scene, camera);
    },
    dispose: () => {
      resizeObserver.disconnect();
      parent.removeChild(panel);
      terrainGeometry.dispose();
      terrainMaterial.dispose();
      waterGeometry.dispose();
      waterMaterial.dispose();
      playerMarker.geometry.dispose();
      playerMarker.material.dispose();
      directionGeometry.dispose();
      directionLine.material.dispose();
      renderer.dispose();
    },
  };

  sonarRenderer.updateTerrain(world);
  sonarRenderer.updateWater(world);

  return sonarRenderer;
}

function updateMapCamera(
  mapCamera: OrthographicCamera,
  sourceCamera: PerspectiveCamera,
  world: VoxelWorld,
): void {
  const playerPosition = getClampedCameraPosition(sourceCamera, world);
  const playerForward = getFlatCameraDirection(sourceCamera);

  mapCameraPosition.set(playerPosition.x, playerPosition.y + SONAR_CAMERA_HEIGHT, playerPosition.z);
  mapTarget.set(playerPosition.x, playerPosition.y, playerPosition.z);
  mapUp.copy(playerForward);

  mapCamera.position.copy(mapCameraPosition);
  mapCamera.up.copy(mapUp);
  mapCamera.lookAt(mapTarget);
  mapCamera.updateMatrixWorld();
}

function updateTerrainMesh(mesh: InstancedMesh, world: VoxelWorld): void {
  let instanceCount = 0;

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
        if (!isSonarOpenCell(world, x, y, z, cellIndex)) {
          continue;
        }

        terrainDummy.position.set(x - world.width / 2 + 0.5, y + 0.5, z - world.depth / 2 + 0.5);
        terrainDummy.scale.setScalar(world.water[cellIndex] > EPSILON ? 0.55 : 1);
        terrainDummy.updateMatrix();
        mesh.setMatrixAt(instanceCount, terrainDummy.matrix);
        instanceCount += 1;
      }
    }
  }

  mesh.count = instanceCount;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

function updateWaterMesh(mesh: InstancedMesh, world: VoxelWorld): void {
  let instanceCount = 0;

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
        const water = world.water[cellIndex];
        if (water <= EPSILON || world.solid[cellIndex] === 1 || !isInsideSonarBounds(world, x, y, z)) {
          continue;
        }

        waterDummy.position.set(x - world.width / 2 + 0.5, y + Math.max(0.08, water) * 0.5, z - world.depth / 2 + 0.5);
        waterDummy.scale.set(0.85, Math.max(0.08, water), 0.85);
        waterDummy.updateMatrix();
        mesh.setMatrixAt(instanceCount, waterDummy.matrix);
        instanceCount += 1;
      }
    }
  }

  mesh.count = instanceCount;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

function updateCameraMarker(
  marker: Mesh,
  directionLine: Line,
  sourceCamera: PerspectiveCamera,
  world: VoxelWorld,
): void {
  clampedCameraPosition.copy(getClampedCameraPosition(sourceCamera, world));
  marker.position.copy(clampedCameraPosition);

  cameraDirection.copy(getFlatCameraDirection(sourceCamera));

  const positions = directionLine.geometry.attributes.position;
  positions.setXYZ(0, clampedCameraPosition.x, clampedCameraPosition.y, clampedCameraPosition.z);
  positions.setXYZ(
    1,
    clampedCameraPosition.x + cameraDirection.x * 5,
    clampedCameraPosition.y,
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

function isSonarOpenCell(world: VoxelWorld, x: number, y: number, z: number, cellIndex: number): boolean {
  return (
    world.solid[cellIndex] === 0 &&
    isInsideSonarBounds(world, x, y, z) &&
    (world.water[cellIndex] > EPSILON || countAdjacentSolidCells(world, x, y, z) > 0)
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
