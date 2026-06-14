import {
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  MeshPhongMaterial,
  InstancedMesh,
  Mesh,
  Object3D,
  Scene,
} from "three";
import { cellCenter } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type WaterRenderer = {
  mesh: InstancedMesh<BoxGeometry, MeshPhongMaterial>;
  surfaceMesh: Mesh<BufferGeometry, MeshPhongMaterial>;
  foamMesh: InstancedMesh<BoxGeometry, MeshPhongMaterial>;
  instanceToCell: Int32Array;
  stats: RendererStats;
  update: (world: VoxelWorld, debugMode: boolean, options?: RenderOptions, gameplayMode?: boolean) => void;
  dispose: () => void;
};

const bodyDummy = new Object3D();
const foamDummy = new Object3D();
const FULL_WATER_RENDER_THRESHOLD = 0.96;
const EXPOSED_WATER_DELTA = 0.05;

export function createWaterRenderer(scene: Scene, world: VoxelWorld): WaterRenderer {
  const geometry = new BoxGeometry(0.96, 1, 0.96);
  const foamGeometry = new BoxGeometry(0.78, 0.045, 0.78);
  const material = new MeshPhongMaterial({
    color: 0x2fc4df,
    emissive: 0x073d4d,
    specular: 0xcff8ff,
    shininess: 115,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  const surfaceMaterial = new MeshPhongMaterial({
    color: 0xc6fbff,
    emissive: 0x125d68,
    specular: 0xffffff,
    shininess: 180,
    transparent: true,
    opacity: 0.66,
    depthWrite: false,
    side: DoubleSide,
  });
  const foamMaterial = new MeshPhongMaterial({
    color: 0xe8feff,
    emissive: 0x2c8290,
    specular: 0xffffff,
    shininess: 160,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const mesh = new InstancedMesh(geometry, material, world.water.length);
  const surfaceMesh = new Mesh(new BufferGeometry(), surfaceMaterial);
  const foamMesh = new InstancedMesh(foamGeometry, foamMaterial, world.water.length);
  const instanceToCell = new Int32Array(world.water.length);
  const stats = createRendererStats(world.water.length);

  mesh.frustumCulled = false;
  surfaceMesh.frustumCulled = false;
  foamMesh.frustumCulled = false;
  scene.add(mesh);
  scene.add(surfaceMesh);
  scene.add(foamMesh);

  const waterRenderer: WaterRenderer = {
    mesh,
    surfaceMesh,
    foamMesh,
    instanceToCell,
    stats,
    update: (nextWorld, debugMode, options = defaultRenderOptions(nextWorld), gameplayMode = false) =>
      updateWaterMesh(waterRenderer, nextWorld, debugMode, options, gameplayMode),
    dispose: () => {
      scene.remove(mesh);
      scene.remove(surfaceMesh);
      scene.remove(foamMesh);
      geometry.dispose();
      surfaceMesh.geometry.dispose();
      foamGeometry.dispose();
      material.dispose();
      surfaceMaterial.dispose();
      foamMaterial.dispose();
    },
  };

  waterRenderer.update(world, false);

  return waterRenderer;
}

function updateWaterMesh(
  renderer: WaterRenderer,
  world: VoxelWorld,
  debugMode: boolean,
  options: RenderOptions,
  gameplayMode: boolean,
): void {
  const startedAt = performance.now();
  let instanceCount = 0;
  let foamCount = 0;
  const surfaceBuckets = new Map<number, Uint8Array>();
  const material = renderer.mesh.material;
  const surfaceMaterial = renderer.surfaceMesh.material;
  const foamMaterial = renderer.foamMesh.material;
  material.color.set(debugMode ? 0x5ef0ff : gameplayMode ? 0x25b9d2 : 0x2fc4df);
  material.emissive.set(debugMode ? 0x126c7c : gameplayMode ? 0x043946 : 0x073d4d);
  material.opacity = debugMode ? 0.82 : gameplayMode ? 0.24 : 0.26;
  surfaceMaterial.color.set(debugMode ? 0xd6ffff : gameplayMode ? 0xbff8ff : 0xc6fbff);
  surfaceMaterial.emissive.set(debugMode ? 0x1a7b88 : gameplayMode ? 0x0f5262 : 0x125d68);
  surfaceMaterial.opacity = debugMode ? 0.58 : gameplayMode ? 0.7 : 0.66;
  foamMaterial.opacity = debugMode ? 0.5 : gameplayMode ? 0.46 : 0.36;
  const layerSize = world.width * world.depth;

  for (const cellIndex of world.wetCells) {
    const y = Math.floor(cellIndex / layerSize);
    const layerIndex = cellIndex - y * layerSize;
    const z = Math.floor(layerIndex / world.width);
    const x = layerIndex - z * world.width;
    const amount = world.water[cellIndex];
    if (
      amount <= EPSILON ||
      world.solid[cellIndex] === 1 ||
      !shouldRenderCell(world, z, options) ||
      !shouldRenderWaterCell(world, x, y, z, amount, debugMode, gameplayMode)
    ) {
      continue;
    }

    const center = cellCenter(world, x, y, z);
    const waterHeight = Math.max(0.05, amount);
    bodyDummy.position.set(center.x, y + waterHeight * 0.5, center.z);
    bodyDummy.scale.set(1, waterHeight, 1);
    bodyDummy.updateMatrix();
    renderer.mesh.setMatrixAt(instanceCount, bodyDummy.matrix);

    renderer.instanceToCell[instanceCount] = cellIndex;
    instanceCount += 1;

    if (shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode)) {
      markSurfaceCell(surfaceBuckets, world, x, y, z, waterHeight);
    }

    if (shouldRenderWaterFoam(world, x, y, z, amount, debugMode, gameplayMode)) {
      const foamScale = getWaterFoamScale(world, x, y, z, amount);
      foamDummy.position.set(center.x, y + waterHeight + 0.035, center.z);
      foamDummy.scale.set(foamScale, 1, foamScale);
      foamDummy.updateMatrix();
      renderer.foamMesh.setMatrixAt(foamCount, foamDummy.matrix);
      foamCount += 1;
    }
  }

  renderer.mesh.count = instanceCount;
  renderer.mesh.instanceMatrix.needsUpdate = true;
  renderer.mesh.computeBoundingSphere();
  const surfaceFaceCount = rebuildSurfaceMesh(renderer.surfaceMesh, world, surfaceBuckets);
  renderer.foamMesh.count = foamCount;
  renderer.foamMesh.instanceMatrix.needsUpdate = true;
  renderer.foamMesh.computeBoundingSphere();
  renderer.stats.instances = instanceCount + surfaceFaceCount + foamCount;
  renderer.stats.updateMs = performance.now() - startedAt;
}

function markSurfaceCell(
  buckets: Map<number, Uint8Array>,
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  waterHeight: number,
): void {
  const levelKey = Math.round(y + Math.min(1, waterHeight));
  let bucket = buckets.get(levelKey);
  if (!bucket) {
    bucket = new Uint8Array(world.width * world.depth);
    buckets.set(levelKey, bucket);
  }

  bucket[x + world.width * z] = 1;
}

function rebuildSurfaceMesh(
  mesh: Mesh<BufferGeometry, MeshPhongMaterial>,
  world: VoxelWorld,
  buckets: Map<number, Uint8Array>,
): number {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  let faceCount = 0;

  for (const [levelKey, cells] of buckets) {
    const visited = new Uint8Array(cells.length);
    const surfaceY = levelKey + 0.014;

    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
        const cellIndex = x + world.width * z;
        if (cells[cellIndex] === 0 || visited[cellIndex] === 1) {
          continue;
        }

        let rectWidth = 1;
        while (
          x + rectWidth < world.width &&
          cells[x + rectWidth + world.width * z] === 1 &&
          visited[x + rectWidth + world.width * z] === 0
        ) {
          rectWidth += 1;
        }

        let rectDepth = 1;
        let canExtend = true;
        while (z + rectDepth < world.depth && canExtend) {
          for (let dx = 0; dx < rectWidth; dx += 1) {
            const nextIndex = x + dx + world.width * (z + rectDepth);
            if (cells[nextIndex] === 0 || visited[nextIndex] === 1) {
              canExtend = false;
              break;
            }
          }
          if (canExtend) {
            rectDepth += 1;
          }
        }

        for (let dz = 0; dz < rectDepth; dz += 1) {
          for (let dx = 0; dx < rectWidth; dx += 1) {
            visited[x + dx + world.width * (z + dz)] = 1;
          }
        }

        appendSurfaceQuad(positions, normals, colors, world, x, z, rectWidth, rectDepth, surfaceY);
        faceCount += 1;
      }
    }
  }

  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.computeBoundingSphere();
  mesh.geometry.dispose();
  mesh.geometry = nextGeometry;
  return faceCount;
}

function appendSurfaceQuad(
  positions: number[],
  normals: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  z: number,
  width: number,
  depth: number,
  surfaceY: number,
): void {
  const minX = x - world.width / 2 - 0.015;
  const maxX = x + width - world.width / 2 + 0.015;
  const minZ = z - world.depth / 2 - 0.015;
  const maxZ = z + depth - world.depth / 2 + 0.015;
  const color = getSurfaceColor(x, z, width, depth);
  const vertices = [
    [minX, surfaceY, minZ],
    [maxX, surfaceY, minZ],
    [maxX, surfaceY, maxZ],
    [minX, surfaceY, minZ],
    [maxX, surfaceY, maxZ],
    [minX, surfaceY, maxZ],
  ];

  for (const vertex of vertices) {
    positions.push(vertex[0], vertex[1], vertex[2]);
    normals.push(0, 1, 0);
    colors.push(color.r, color.g, color.b);
  }
}

function getSurfaceColor(x: number, z: number, width: number, depth: number): { r: number; g: number; b: number } {
  const variation = getCellVariation(x + width, 0, z + depth) * 0.08;
  return {
    r: 0.66 + variation,
    g: 0.96 + variation * 0.3,
    b: 1,
  };
}

function getCellVariation(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, -2048144789);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

function shouldRenderWaterCell(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (!gameplayMode || debugMode || amount < FULL_WATER_RENDER_THRESHOLD) {
    return true;
  }

  return (
    isWaterExposedToLowerNeighbor(world, x, y + 1, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x - 1, y, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x + 1, y, z, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y, z - 1, amount) ||
    isWaterExposedToLowerNeighbor(world, x, y, z + 1, amount)
  );
}

function isWaterExposedToLowerNeighbor(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
): boolean {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height || z < 0 || z >= world.depth) {
    return true;
  }

  const cellIndex = x + world.width * (z + world.depth * y);
  if (world.solid[cellIndex] === 1) {
    return false;
  }

  return world.water[cellIndex] < amount - EXPOSED_WATER_DELTA;
}

function shouldRenderWaterSurface(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (debugMode || !gameplayMode || amount < FULL_WATER_RENDER_THRESHOLD) {
    return true;
  }

  const aboveY = y + 1;
  if (aboveY >= world.height) {
    return true;
  }

  const aboveIndex = x + world.width * (z + world.depth * aboveY);
  return world.solid[aboveIndex] === 1 || world.water[aboveIndex] <= EPSILON;
}

function shouldRenderWaterFoam(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  amount: number,
  debugMode: boolean,
  gameplayMode: boolean,
): boolean {
  if (!gameplayMode || debugMode || amount < 0.12) {
    return false;
  }

  const dropScore = getWaterDropScore(world, x, y, z, amount);
  return dropScore >= 1 || (amount > 0.62 && dropScore > 0 && shouldRenderWaterSurface(world, x, y, z, amount, debugMode, gameplayMode));
}

function getWaterFoamScale(world: VoxelWorld, x: number, y: number, z: number, amount: number): number {
  return Math.min(1.55, 0.82 + getWaterDropScore(world, x, y, z, amount) * 0.22 + amount * 0.18);
}

function getWaterDropScore(world: VoxelWorld, x: number, y: number, z: number, amount: number): number {
  let score = 0;
  score += isWaterExposedToLowerNeighbor(world, x, y - 1, z, amount) ? 2 : 0;
  score += isWaterExposedToLowerNeighbor(world, x - 1, y, z, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x + 1, y, z, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x, y, z - 1, amount) ? 1 : 0;
  score += isWaterExposedToLowerNeighbor(world, x, y, z + 1, amount) ? 1 : 0;
  return score;
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
