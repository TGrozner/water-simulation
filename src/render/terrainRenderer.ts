import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Scene,
} from "three";
import { coords, inBounds, isSolid } from "../world/grid";
import { EPSILON, type VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type TerrainPick = {
  cellIndex: number;
  distance: number;
};

export type TerrainRenderer = {
  root: Group;
  stats: RendererStats;
  update: (world: VoxelWorld, options?: RenderOptions) => void;
  markCellsDirty: (cellIndexes: number[]) => void;
  markAllDirty: () => void;
  pickCell: (raycaster: Raycaster) => TerrainPick | null;
  dispose: () => void;
};

type TerrainChunk = {
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  faceToCell: Int32Array;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  faceCount: number;
};

type FaceDirection = {
  nx: number;
  ny: number;
  nz: number;
  vertices: readonly FaceVertex[];
};

type FaceVertex = readonly [x: 0 | 1, y: 0 | 1, z: 0 | 1];

type FaceColor = {
  r: number;
  g: number;
  b: number;
};

const TERRAIN_CHUNK_SIZE = 12;
const DEEP_CAVERN_VERTEX_JITTER = 0.16;
const DEFAULT_VERTEX_JITTER = 0.06;

const FACE_DIRECTIONS: FaceDirection[] = [
  { nx: 1, ny: 0, nz: 0, vertices: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 0, 1]] },
  { nx: -1, ny: 0, nz: 0, vertices: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 0]] },
  { nx: 0, ny: 1, nz: 0, vertices: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { nx: 0, ny: -1, nz: 0, vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { nx: 0, ny: 0, nz: 1, vertices: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { nx: 0, ny: 0, nz: -1, vertices: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

export function createTerrainRenderer(scene: Scene, world: VoxelWorld): TerrainRenderer {
  const root = new Group();
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    side: DoubleSide,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.03,
    flatShading: true,
  });
  const stats = createRendererStats(world.solid.length * 6);
  const chunkXCount = Math.ceil(world.width / TERRAIN_CHUNK_SIZE);
  const chunkYCount = Math.ceil(world.height / TERRAIN_CHUNK_SIZE);
  const chunkZCount = Math.ceil(world.depth / TERRAIN_CHUNK_SIZE);
  const chunks = createTerrainChunks(root, material, world, chunkXCount, chunkYCount, chunkZCount);
  const visibleChunkMeshes: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
  const dirtyChunks = new Set<number>();
  let allDirty = true;
  let lastOptionsKey = "";

  root.frustumCulled = false;
  scene.add(root);

  const terrainRenderer: TerrainRenderer = {
    root,
    stats,
    update: (nextWorld, options = defaultRenderOptions(nextWorld)) =>
      updateTerrainChunks(terrainRenderer, nextWorld, options),
    markCellsDirty: (cellIndexes) => {
      for (const cellIndex of cellIndexes) {
        markCellNeighborhoodDirty(cellIndex);
      }
    },
    markAllDirty: () => {
      allDirty = true;
    },
    pickCell: (raycaster) => pickTerrainCell(raycaster),
    dispose: () => {
      scene.remove(root);
      for (const chunk of chunks) {
        chunk.mesh.geometry.dispose();
      }
      material.dispose();
    },
  };

  terrainRenderer.update(world);

  return terrainRenderer;

  function updateTerrainChunks(renderer: TerrainRenderer, nextWorld: VoxelWorld, options: RenderOptions): void {
    const startedAt = performance.now();
    const optionsKey = getRenderOptionsKey(options);
    const rebuildAllChunks = allDirty || optionsKey !== lastOptionsKey || dirtyChunks.size === 0;
    const targetChunks = rebuildAllChunks ? chunks.map((_chunk, chunkIndex) => chunkIndex) : [...dirtyChunks];

    for (const chunkIndex of targetChunks) {
      rebuildTerrainChunk(chunks[chunkIndex], nextWorld, options);
    }

    refreshVisibleChunks();
    renderer.stats.updateMs = performance.now() - startedAt;
    renderer.stats.instances = chunks.reduce((total, chunk) => total + chunk.faceCount, 0);
    dirtyChunks.clear();
    allDirty = false;
    lastOptionsKey = optionsKey;
  }

  function markCellNeighborhoodDirty(cellIndex: number): void {
    const cell = coords(world, cellIndex);
    markChunkAt(cell.x, cell.y, cell.z);
    for (const direction of FACE_DIRECTIONS) {
      markChunkAt(cell.x + direction.nx, cell.y + direction.ny, cell.z + direction.nz);
    }
  }

  function markChunkAt(x: number, y: number, z: number): void {
    if (!inBounds(world, x, y, z)) {
      return;
    }

    const chunkX = Math.floor(x / TERRAIN_CHUNK_SIZE);
    const chunkY = Math.floor(y / TERRAIN_CHUNK_SIZE);
    const chunkZ = Math.floor(z / TERRAIN_CHUNK_SIZE);
    dirtyChunks.add(chunkX + chunkXCount * (chunkZ + chunkZCount * chunkY));
  }

  function refreshVisibleChunks(): void {
    visibleChunkMeshes.length = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      chunk.mesh.visible = chunk.faceCount > 0;
      if (chunk.mesh.visible) {
        visibleChunkMeshes.push(chunk.mesh);
      }
    }
  }

  function pickTerrainCell(raycaster: Raycaster): TerrainPick | null {
    const hit = raycaster.intersectObjects(visibleChunkMeshes, false)[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) {
      return null;
    }

    const chunkIndex = hit.object.userData.terrainChunkIndex;
    if (typeof chunkIndex !== "number") {
      return null;
    }

    const cellIndex = chunks[chunkIndex]?.faceToCell[hit.faceIndex] ?? -1;
    return cellIndex < 0 ? null : { cellIndex, distance: hit.distance };
  }
}

function createTerrainChunks(
  root: Group,
  material: MeshStandardMaterial,
  world: VoxelWorld,
  chunkXCount: number,
  chunkYCount: number,
  chunkZCount: number,
): TerrainChunk[] {
  const chunks: TerrainChunk[] = [];

  for (let chunkY = 0; chunkY < chunkYCount; chunkY += 1) {
    for (let chunkZ = 0; chunkZ < chunkZCount; chunkZ += 1) {
      for (let chunkX = 0; chunkX < chunkXCount; chunkX += 1) {
        const mesh = new Mesh(new BufferGeometry(), material);
        const chunkIndex = chunks.length;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.userData.terrainChunkIndex = chunkIndex;
        root.add(mesh);
        chunks.push({
          mesh,
          faceToCell: new Int32Array(0),
          minX: chunkX * TERRAIN_CHUNK_SIZE,
          maxX: Math.min(world.width, (chunkX + 1) * TERRAIN_CHUNK_SIZE),
          minY: chunkY * TERRAIN_CHUNK_SIZE,
          maxY: Math.min(world.height, (chunkY + 1) * TERRAIN_CHUNK_SIZE),
          minZ: chunkZ * TERRAIN_CHUNK_SIZE,
          maxZ: Math.min(world.depth, (chunkZ + 1) * TERRAIN_CHUNK_SIZE),
          faceCount: 0,
        });
      }
    }
  }

  return chunks;
}

function rebuildTerrainChunk(chunk: TerrainChunk, world: VoxelWorld, options: RenderOptions): void {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const faceToCell: number[] = [];
  let faceCount = 0;

  for (let y = chunk.minY; y < chunk.maxY; y += 1) {
    for (let z = chunk.minZ; z < chunk.maxZ; z += 1) {
      for (let x = chunk.minX; x < chunk.maxX; x += 1) {
        const cellIndex = x + world.width * (z + world.depth * y);
        if (world.solid[cellIndex] === 0 || !shouldRenderCell(world, z, options)) {
          continue;
        }

        for (const direction of FACE_DIRECTIONS) {
          if (!shouldRenderFace(world, x, y, z, direction, options)) {
            continue;
          }

          appendFace(positions, normals, colors, world, x, y, z, direction);
          faceToCell.push(cellIndex, cellIndex);
          faceCount += 1;
        }
      }
    }
  }

  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.computeBoundingSphere();
  chunk.mesh.geometry.dispose();
  chunk.mesh.geometry = nextGeometry;
  chunk.faceToCell = Int32Array.from(faceToCell);
  chunk.faceCount = faceCount;
}

function shouldRenderFace(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: FaceDirection,
  options: RenderOptions,
): boolean {
  const nx = x + direction.nx;
  const ny = y + direction.ny;
  const nz = z + direction.nz;

  if (!inBounds(world, nx, ny, nz)) {
    return true;
  }

  if (options.slice.enabled && direction.nz === 1 && z === options.slice.z) {
    return true;
  }

  if (!shouldRenderCell(world, nz, options)) {
    return true;
  }

  return !isSolid(world, nx, ny, nz);
}

function appendFace(
  positions: number[],
  normals: number[],
  colors: number[],
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: FaceDirection,
): void {
  const minX = x - world.width / 2;
  const maxX = minX + 1;
  const minY = y;
  const maxY = y + 1;
  const minZ = z - world.depth / 2;
  const maxZ = minZ + 1;

  for (const vertex of direction.vertices) {
    appendVertex(positions, normals, colors, world, x, y, z, direction, minX, maxX, minY, maxY, minZ, maxZ, vertex);
  }
}

function appendVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  world: VoxelWorld,
  cellX: number,
  cellY: number,
  cellZ: number,
  direction: FaceDirection,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  vertex: FaceVertex,
): void {
  const gridX = cellX + vertex[0];
  const gridY = cellY + vertex[1];
  const gridZ = cellZ + vertex[2];
  const x = vertex[0] === 0 ? minX : maxX;
  const y = vertex[1] === 0 ? minY : maxY;
  const z = vertex[2] === 0 ? minZ : maxZ;
  const jitter = getTerrainVertexJitter(world, gridX, gridY, gridZ);
  const color = getTerrainVertexColor(world, cellX, cellY, cellZ, direction, gridX, gridY, gridZ);
  positions.push(x + jitter.x, y + jitter.y, z + jitter.z);
  normals.push(direction.nx, direction.ny, direction.nz);
  colors.push(color.r, color.g, color.b);
}

function getTerrainVertexColor(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: FaceDirection,
  gridX: number,
  gridY: number,
  gridZ: number,
): FaceColor {
  let baseColor = getBaseTerrainColor(world, x, y, z);
  const adjacentWater = getAdjacentWaterAmount(world, x, y, z, direction);
  if (adjacentWater > EPSILON) {
    const wetColor = isDeepCavernWorld(world) ? 0x1f6472 : 0x2f7a86;
    baseColor = mixHexColors(baseColor, wetColor, Math.min(0.72, 0.28 + adjacentWater * 0.34));
  }

  const heightFactor = world.height <= 1 ? 0 : gridY / world.height;
  const variation = getCellVariation(gridX, gridY, gridZ);
  const largeVariation = getCellVariation(Math.floor(gridX / 3), Math.floor(gridY / 2), Math.floor(gridZ / 3));
  const strata = 0.5 + Math.sin(gridY * 1.9 + gridX * 0.28 + gridZ * 0.17) * 0.5;
  const light = 0.68 + heightFactor * 0.34 + variation * 0.12 + largeVariation * 0.06 + strata * 0.08;
  const faceLight = direction.ny === 1 ? 1.18 : direction.ny === -1 ? 0.58 : 0.86 + Math.abs(direction.nx) * 0.04;
  return scaleHexColor(baseColor, light * faceLight);
}

function getBaseTerrainColor(world: VoxelWorld, x: number, y: number, z: number): number {
  if (isDeepCavernWorld(world)) {
    return getDeepCavernColor(x, y, z);
  }

  if (y <= 3) {
    return 0x4f6f68;
  }

  if (y >= 18) {
    return 0xc59a63;
  }

  return 0x9f7041;
}

function isDeepCavernWorld(world: VoxelWorld): boolean {
  return world.width >= 64 || world.depth >= 64 || world.height >= 40;
}

function getDeepCavernColor(x: number, y: number, z: number): number {
  let color = y <= 7 ? 0x51635e : y >= 34 ? 0x596171 : y >= 24 ? 0x8b7658 : 0x84603e;

  const band = positiveModulo(y + Math.floor(x * 0.21) + Math.floor(z * 0.13), 7);
  if (band <= 1) {
    color = mixHexColors(color, y >= 28 ? 0xb28b57 : 0x4c4438, 0.26);
  }

  if (y <= 6 && ((x >= 48 && z <= 32) || (x >= 46 && z >= 47))) {
    color = mixHexColors(color, 0x25788b, 0.58);
  }

  if (x >= 50 && z <= 32 && y <= 17) {
    color = mixHexColors(color, 0x2f7683, 0.5);
  }

  if (x >= 48 && z >= 47 && y <= 17) {
    color = mixHexColors(color, 0x5b4e86, 0.48);
  }

  if (x <= 24 && z >= 42 && y <= 16) {
    color = mixHexColors(color, 0x347f74, 0.5);
  }

  if (x >= 26 && x <= 44 && z >= 30 && z <= 44 && y <= 16) {
    color = mixHexColors(color, 0xc77a42, 0.55);
  }

  if (x >= 7 && x <= 23 && z >= 18 && z <= 34 && y >= 29) {
    color = mixHexColors(color, 0xd0a14e, 0.48);
  }

  if (isAzureVein(x, y, z)) {
    color = mixHexColors(color, 0x67f1ff, 0.62);
  }

  if (isAmberVein(x, y, z)) {
    color = mixHexColors(color, 0xffb95f, 0.56);
  }

  if (isVioletPocket(x, y, z)) {
    color = mixHexColors(color, 0x8d6dce, 0.52);
  }

  return color;
}

function isAzureVein(x: number, y: number, z: number): boolean {
  const inBasin = (x >= 50 && x <= 66 && z >= 13 && z <= 28 && y <= 18) || (x >= 51 && x <= 68 && z >= 48 && y <= 17);
  const inGallery = x >= 52 && x <= 60 && z >= 13 && z <= 24 && y >= 18 && y <= 28;
  return (inBasin || inGallery) && positiveModulo(x * 5 + y * 7 + z * 3, 11) <= 2;
}

function isAmberVein(x: number, y: number, z: number): boolean {
  const inThroat = x >= 27 && x <= 45 && z >= 28 && z <= 45 && y >= 9 && y <= 28;
  const inReservoir = x >= 8 && x <= 24 && z >= 18 && z <= 34 && y >= 28;
  return (inThroat || inReservoir) && positiveModulo(x * 3 + y * 11 + z * 5, 13) <= 2;
}

function isVioletPocket(x: number, y: number, z: number): boolean {
  return x >= 15 && x <= 27 && z >= 43 && z <= 58 && y >= 9 && y <= 28 && positiveModulo(x * 7 + y * 2 + z * 9, 17) <= 3;
}

function getAdjacentWaterAmount(world: VoxelWorld, x: number, y: number, z: number, direction: FaceDirection): number {
  const nx = x + direction.nx;
  const ny = y + direction.ny;
  const nz = z + direction.nz;
  if (!inBounds(world, nx, ny, nz)) {
    return 0;
  }

  return world.water[nx + world.width * (nz + world.depth * ny)];
}

function getTerrainVertexJitter(world: VoxelWorld, gridX: number, gridY: number, gridZ: number): { x: number; y: number; z: number } {
  const amount = isDeepCavernWorld(world) ? DEEP_CAVERN_VERTEX_JITTER : DEFAULT_VERTEX_JITTER;
  return {
    x: (getCellVariation(gridX, gridY, gridZ) - 0.5) * amount,
    y: (getCellVariation(gridX + 17, gridY - 11, gridZ + 5) - 0.5) * amount * 0.7,
    z: (getCellVariation(gridX - 23, gridY + 3, gridZ + 29) - 0.5) * amount,
  };
}

function mixHexColors(a: number, b: number, amount: number): number {
  const inverse = 1 - amount;
  const r = ((a >> 16) & 0xff) * inverse + ((b >> 16) & 0xff) * amount;
  const g = ((a >> 8) & 0xff) * inverse + ((b >> 8) & 0xff) * amount;
  const blue = (a & 0xff) * inverse + (b & 0xff) * amount;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(blue);
}

function scaleHexColor(color: number, scalar: number): FaceColor {
  return {
    r: clamp01((((color >> 16) & 0xff) / 255) * scalar),
    g: clamp01((((color >> 8) & 0xff) / 255) * scalar),
    b: clamp01(((color & 0xff) / 255) * scalar),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function getCellVariation(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, -2048144789);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}

function getRenderOptionsKey(options: RenderOptions): string {
  return options.slice.enabled ? `slice:${options.slice.z}` : "full";
}
