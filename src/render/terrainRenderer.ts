import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  Raycaster,
  Scene,
} from "three";
import { coords, inBounds, isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";
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
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
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
  const material = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide, vertexColors: true });
  const stats = createRendererStats(world.solid.length * 6);
  const chunkXCount = Math.ceil(world.width / TERRAIN_CHUNK_SIZE);
  const chunkYCount = Math.ceil(world.height / TERRAIN_CHUNK_SIZE);
  const chunkZCount = Math.ceil(world.depth / TERRAIN_CHUNK_SIZE);
  const chunks = createTerrainChunks(root, material, world, chunkXCount, chunkYCount, chunkZCount);
  const visibleChunkMeshes: Mesh<BufferGeometry, MeshLambertMaterial>[] = [];
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
  material: MeshLambertMaterial,
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
  const faceColor = getTerrainFaceColor(world, x, y, z, direction);

  for (const vertex of direction.vertices) {
    appendVertex(positions, normals, colors, direction, faceColor, minX, maxX, minY, maxY, minZ, maxZ, vertex);
  }
}

function appendVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  direction: FaceDirection,
  color: FaceColor,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  vertex: FaceVertex,
): void {
  const x = vertex[0] === 0 ? minX : maxX;
  const y = vertex[1] === 0 ? minY : maxY;
  const z = vertex[2] === 0 ? minZ : maxZ;
  positions.push(x, y, z);
  normals.push(direction.nx, direction.ny, direction.nz);
  colors.push(color.r, color.g, color.b);
}

function getTerrainFaceColor(world: VoxelWorld, x: number, y: number, z: number, direction: FaceDirection): FaceColor {
  const baseColor = getBaseTerrainColor(world, x, y, z);
  const heightFactor = world.height <= 1 ? 0 : y / (world.height - 1);
  const variation = getCellVariation(x, y, z);
  const light = 0.78 + heightFactor * 0.26 + variation * 0.1;
  const faceLight = direction.ny === 1 ? 1.12 : direction.ny === -1 ? 0.66 : 0.9;
  const scalar = light * faceLight;
  return {
    r: (((baseColor >> 16) & 0xff) / 255) * scalar,
    g: (((baseColor >> 8) & 0xff) / 255) * scalar,
    b: ((baseColor & 0xff) / 255) * scalar,
  };
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
  if (y <= 6 && ((x >= 48 && z <= 32) || (x >= 46 && z >= 47))) {
    return 0x2f7182;
  }

  if (x >= 50 && z <= 32 && y <= 17) {
    return 0x355f6a;
  }

  if (x >= 48 && z >= 47 && y <= 17) {
    return 0x594d81;
  }

  if (x <= 24 && z >= 42 && y <= 16) {
    return 0x4b7b72;
  }

  if (x >= 26 && x <= 44 && z >= 30 && z <= 44 && y <= 16) {
    return 0xbd7043;
  }

  if (x >= 7 && x <= 23 && z >= 18 && z <= 34 && y >= 29) {
    return 0xc79a4d;
  }

  if (y >= 34) {
    return 0x58606f;
  }

  if (y <= 8) {
    return 0x5f5f4d;
  }

  return 0x8c6742;
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
