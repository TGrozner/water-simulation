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
  faceSpans: FaceSpan[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  faceCount: number;
};

type FaceAxis = "x" | "y" | "z";

type FaceSpan = {
  originX: number;
  originY: number;
  originZ: number;
  uAxis: FaceAxis;
  vAxis: FaceAxis;
  width: number;
  height: number;
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
const GENERATED_CAVERN_VERTEX_JITTER = 0;
const DEFAULT_VERTEX_JITTER = 0;

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

    const span = chunks[chunkIndex]?.faceSpans[hit.faceIndex];
    if (!span || !hit.uv) {
      return null;
    }

    const u = Math.min(span.width - 1, Math.max(0, Math.floor(hit.uv.x)));
    const v = Math.min(span.height - 1, Math.max(0, Math.floor(hit.uv.y)));
    const x = span.originX + getAxisOffset(span.uAxis, u) + getAxisOffset(span.vAxis, v);
    const y = span.originY + getAxisOffsetY(span.uAxis, u) + getAxisOffsetY(span.vAxis, v);
    const z = span.originZ + getAxisOffsetZ(span.uAxis, u) + getAxisOffsetZ(span.vAxis, v);
    const cellIndex = x + world.width * (z + world.depth * y);
    return inBounds(world, x, y, z) && world.solid[cellIndex] === 1 ? { cellIndex, distance: hit.distance } : null;
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
          faceSpans: [],
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
  const uvs: number[] = [];
  const faceSpans: FaceSpan[] = [];
  let faceCount = 0;

  for (const direction of FACE_DIRECTIONS) {
    faceCount += appendGreedyFacesForDirection(positions, normals, colors, uvs, faceSpans, chunk, world, options, direction);
  }

  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  nextGeometry.computeBoundingSphere();
  chunk.mesh.geometry.dispose();
  chunk.mesh.geometry = nextGeometry;
  chunk.faceSpans = faceSpans;
  chunk.faceCount = faceCount;
}

function appendGreedyFacesForDirection(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  chunk: TerrainChunk,
  world: VoxelWorld,
  options: RenderOptions,
  direction: FaceDirection,
): number {
  if (direction.nx !== 0) {
    return appendGreedyXFaces(positions, normals, colors, uvs, faceSpans, chunk, world, options, direction);
  }
  if (direction.ny !== 0) {
    return appendGreedyYFaces(positions, normals, colors, uvs, faceSpans, chunk, world, options, direction);
  }
  return appendGreedyZFaces(positions, normals, colors, uvs, faceSpans, chunk, world, options, direction);
}

function appendGreedyXFaces(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  chunk: TerrainChunk,
  world: VoxelWorld,
  options: RenderOptions,
  direction: FaceDirection,
): number {
  let faceCount = 0;
  const maskWidth = chunk.maxZ - chunk.minZ;
  const maskHeight = chunk.maxY - chunk.minY;
  const mask = new Int32Array(maskWidth * maskHeight);
  const keys = new Int32Array(mask.length);

  for (let x = chunk.minX; x < chunk.maxX; x += 1) {
    fillFaceMask(mask, keys, maskWidth, maskHeight, (u, v) => {
      const z = chunk.minZ + u;
      const y = chunk.minY + v;
      return getVisibleFaceEntry(world, x, y, z, direction, options);
    });
    faceCount += appendGreedyMaskFaces(positions, normals, colors, uvs, faceSpans, world, mask, keys, maskWidth, maskHeight, (u, v, width, height) => ({
      direction,
      minX: x,
      maxX: x + 1,
      minY: chunk.minY + v,
      maxY: chunk.minY + v + height,
      minZ: chunk.minZ + u,
      maxZ: chunk.minZ + u + width,
      originX: x,
      originY: chunk.minY + v,
      originZ: chunk.minZ + u,
      uAxis: "z",
      vAxis: "y",
      width,
      height,
    }));
  }

  return faceCount;
}

function appendGreedyYFaces(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  chunk: TerrainChunk,
  world: VoxelWorld,
  options: RenderOptions,
  direction: FaceDirection,
): number {
  let faceCount = 0;
  const maskWidth = chunk.maxX - chunk.minX;
  const maskHeight = chunk.maxZ - chunk.minZ;
  const mask = new Int32Array(maskWidth * maskHeight);
  const keys = new Int32Array(mask.length);

  for (let y = chunk.minY; y < chunk.maxY; y += 1) {
    fillFaceMask(mask, keys, maskWidth, maskHeight, (u, v) => {
      const x = chunk.minX + u;
      const z = chunk.minZ + v;
      return getVisibleFaceEntry(world, x, y, z, direction, options);
    });
    faceCount += appendGreedyMaskFaces(positions, normals, colors, uvs, faceSpans, world, mask, keys, maskWidth, maskHeight, (u, v, width, height) => ({
      direction,
      minX: chunk.minX + u,
      maxX: chunk.minX + u + width,
      minY: y,
      maxY: y + 1,
      minZ: chunk.minZ + v,
      maxZ: chunk.minZ + v + height,
      originX: chunk.minX + u,
      originY: y,
      originZ: chunk.minZ + v,
      uAxis: "x",
      vAxis: "z",
      width,
      height,
    }));
  }

  return faceCount;
}

function appendGreedyZFaces(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  chunk: TerrainChunk,
  world: VoxelWorld,
  options: RenderOptions,
  direction: FaceDirection,
): number {
  let faceCount = 0;
  const maskWidth = chunk.maxX - chunk.minX;
  const maskHeight = chunk.maxY - chunk.minY;
  const mask = new Int32Array(maskWidth * maskHeight);
  const keys = new Int32Array(mask.length);

  for (let z = chunk.minZ; z < chunk.maxZ; z += 1) {
    fillFaceMask(mask, keys, maskWidth, maskHeight, (u, v) => {
      const x = chunk.minX + u;
      const y = chunk.minY + v;
      return getVisibleFaceEntry(world, x, y, z, direction, options);
    });
    faceCount += appendGreedyMaskFaces(positions, normals, colors, uvs, faceSpans, world, mask, keys, maskWidth, maskHeight, (u, v, width, height) => ({
      direction,
      minX: chunk.minX + u,
      maxX: chunk.minX + u + width,
      minY: chunk.minY + v,
      maxY: chunk.minY + v + height,
      minZ: z,
      maxZ: z + 1,
      originX: chunk.minX + u,
      originY: chunk.minY + v,
      originZ: z,
      uAxis: "x",
      vAxis: "y",
      width,
      height,
    }));
  }

  return faceCount;
}

type FaceMaskEntry = {
  cellIndex: number;
  key: number;
};

type MergedFace = {
  direction: FaceDirection;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  originX: number;
  originY: number;
  originZ: number;
  uAxis: FaceAxis;
  vAxis: FaceAxis;
  width: number;
  height: number;
};

function fillFaceMask(
  mask: Int32Array,
  keys: Int32Array,
  width: number,
  height: number,
  getEntry: (u: number, v: number) => FaceMaskEntry | null,
): void {
  mask.fill(-1);
  keys.fill(0);

  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const entry = getEntry(u, v);
      if (!entry) {
        continue;
      }

      const maskIndex = u + width * v;
      mask[maskIndex] = entry.cellIndex;
      keys[maskIndex] = entry.key;
    }
  }
}

function getVisibleFaceEntry(
  world: VoxelWorld,
  x: number,
  y: number,
  z: number,
  direction: FaceDirection,
  options: RenderOptions,
): FaceMaskEntry | null {
  const cellIndex = x + world.width * (z + world.depth * y);
  if (world.solid[cellIndex] === 0 || !shouldRenderCell(world, z, options) || !shouldRenderFace(world, x, y, z, direction, options)) {
    return null;
  }

  return {
    cellIndex,
    key: getTerrainMergeKey(world, x, y, z, direction),
  };
}

function appendGreedyMaskFaces(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  world: VoxelWorld,
  mask: Int32Array,
  keys: Int32Array,
  maskWidth: number,
  maskHeight: number,
  createFace: (u: number, v: number, width: number, height: number) => MergedFace,
): number {
  const visited = new Uint8Array(mask.length);
  const maxSpan = getGreedyFaceSpanLimit(world);
  let faceCount = 0;

  for (let v = 0; v < maskHeight; v += 1) {
    for (let u = 0; u < maskWidth; u += 1) {
      const startIndex = u + maskWidth * v;
      if (visited[startIndex] === 1 || mask[startIndex] < 0) {
        continue;
      }

      const key = keys[startIndex];
      let width = 1;
      while (width < maxSpan && u + width < maskWidth) {
        const nextIndex = u + width + maskWidth * v;
        if (visited[nextIndex] === 1 || mask[nextIndex] < 0 || keys[nextIndex] !== key) {
          break;
        }
        width += 1;
      }

      let height = 1;
      let canExtend = true;
      while (height < maxSpan && v + height < maskHeight && canExtend) {
        for (let dx = 0; dx < width; dx += 1) {
          const nextIndex = u + dx + maskWidth * (v + height);
          if (visited[nextIndex] === 1 || mask[nextIndex] < 0 || keys[nextIndex] !== key) {
            canExtend = false;
            break;
          }
        }
        if (canExtend) {
          height += 1;
        }
      }

      for (let dy = 0; dy < height; dy += 1) {
        for (let dx = 0; dx < width; dx += 1) {
          visited[u + dx + maskWidth * (v + dy)] = 1;
        }
      }

      appendMergedFace(positions, normals, colors, uvs, faceSpans, world, createFace(u, v, width, height));
      faceCount += 1;
    }
  }

  return faceCount;
}

function appendMergedFace(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  world: VoxelWorld,
  face: MergedFace,
): void {
  const vertices = getMergedFaceVertices(face);
  const span = {
    originX: face.originX,
    originY: face.originY,
    originZ: face.originZ,
    uAxis: face.uAxis,
    vAxis: face.vAxis,
    width: face.width,
    height: face.height,
  };

  for (const vertex of vertices) {
    appendMergedVertex(positions, normals, colors, uvs, world, face, vertex);
  }
  faceSpans.push(span, span);
}

function getMergedFaceVertices(face: MergedFace): readonly { x: number; y: number; z: number; u: number; v: number }[] {
  if (face.direction.nx > 0) {
    return [
      { x: face.maxX, y: face.minY, z: face.minZ, u: 0, v: 0 },
      { x: face.maxX, y: face.maxY, z: face.minZ, u: 0, v: face.height },
      { x: face.maxX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.maxX, y: face.minY, z: face.minZ, u: 0, v: 0 },
      { x: face.maxX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.maxX, y: face.minY, z: face.maxZ, u: face.width, v: 0 },
    ];
  }

  if (face.direction.nx < 0) {
    return [
      { x: face.minX, y: face.minY, z: face.maxZ, u: face.width, v: 0 },
      { x: face.minX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.minX, y: face.maxY, z: face.minZ, u: 0, v: face.height },
      { x: face.minX, y: face.minY, z: face.maxZ, u: face.width, v: 0 },
      { x: face.minX, y: face.maxY, z: face.minZ, u: 0, v: face.height },
      { x: face.minX, y: face.minY, z: face.minZ, u: 0, v: 0 },
    ];
  }

  if (face.direction.ny > 0) {
    return [
      { x: face.minX, y: face.maxY, z: face.maxZ, u: 0, v: face.height },
      { x: face.maxX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.maxX, y: face.maxY, z: face.minZ, u: face.width, v: 0 },
      { x: face.minX, y: face.maxY, z: face.maxZ, u: 0, v: face.height },
      { x: face.maxX, y: face.maxY, z: face.minZ, u: face.width, v: 0 },
      { x: face.minX, y: face.maxY, z: face.minZ, u: 0, v: 0 },
    ];
  }

  if (face.direction.ny < 0) {
    return [
      { x: face.minX, y: face.minY, z: face.minZ, u: 0, v: 0 },
      { x: face.maxX, y: face.minY, z: face.minZ, u: face.width, v: 0 },
      { x: face.maxX, y: face.minY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.minX, y: face.minY, z: face.minZ, u: 0, v: 0 },
      { x: face.maxX, y: face.minY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.minX, y: face.minY, z: face.maxZ, u: 0, v: face.height },
    ];
  }

  if (face.direction.nz > 0) {
    return [
      { x: face.minX, y: face.minY, z: face.maxZ, u: 0, v: 0 },
      { x: face.maxX, y: face.minY, z: face.maxZ, u: face.width, v: 0 },
      { x: face.maxX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.minX, y: face.minY, z: face.maxZ, u: 0, v: 0 },
      { x: face.maxX, y: face.maxY, z: face.maxZ, u: face.width, v: face.height },
      { x: face.minX, y: face.maxY, z: face.maxZ, u: 0, v: face.height },
    ];
  }

  return [
    { x: face.maxX, y: face.minY, z: face.minZ, u: face.width, v: 0 },
    { x: face.minX, y: face.minY, z: face.minZ, u: 0, v: 0 },
    { x: face.minX, y: face.maxY, z: face.minZ, u: 0, v: face.height },
    { x: face.maxX, y: face.minY, z: face.minZ, u: face.width, v: 0 },
    { x: face.minX, y: face.maxY, z: face.minZ, u: 0, v: face.height },
    { x: face.maxX, y: face.maxY, z: face.minZ, u: face.width, v: face.height },
  ];
}

function appendMergedVertex(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  world: VoxelWorld,
  face: MergedFace,
  vertex: { x: number; y: number; z: number; u: number; v: number },
): void {
  const gridX = vertex.x;
  const gridY = vertex.y;
  const gridZ = vertex.z;
  const sampleX = clampInt(gridX, face.minX, face.maxX - 1);
  const sampleY = clampInt(gridY, face.minY, face.maxY - 1);
  const sampleZ = clampInt(gridZ, face.minZ, face.maxZ - 1);
  const jitter = getTerrainVertexJitter(world, gridX, gridY, gridZ);
  const color = getTerrainVertexColor(world, sampleX, sampleY, sampleZ, face.direction, gridX, gridY, gridZ);
  positions.push(gridX - world.width / 2 + jitter.x, gridY + jitter.y, gridZ - world.depth / 2 + jitter.z);
  normals.push(face.direction.nx, face.direction.ny, face.direction.nz);
  colors.push(color.r, color.g, color.b);
  uvs.push(vertex.u, vertex.v);
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
    const wetColor = isGeneratedCavernWorld(world) ? 0x1f6472 : 0x2f7a86;
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
  if (isGeneratedCavernWorld(world)) {
    return getGeneratedCavernColor(x, y, z);
  }

  if (y <= 3) {
    return 0x4f6f68;
  }

  if (y >= 18) {
    return 0xc59a63;
  }

  return 0x9f7041;
}

function isGeneratedCavernWorld(world: VoxelWorld): boolean {
  return world.width >= 64 || world.depth >= 64 || world.height >= 40;
}

function getGeneratedCavernColor(x: number, y: number, z: number): number {
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

function getTerrainMergeKey(world: VoxelWorld, x: number, y: number, z: number, direction: FaceDirection): number {
  const baseColor = getBaseTerrainColor(world, x, y, z);
  const isWet = getAdjacentWaterAmount(world, x, y, z, direction) > EPSILON ? 1 : 0;
  return baseColor * 2 + isWet;
}

function getGreedyFaceSpanLimit(world: VoxelWorld): number {
  return isGeneratedCavernWorld(world) ? 4 : 8;
}

function getTerrainVertexJitter(world: VoxelWorld, gridX: number, gridY: number, gridZ: number): { x: number; y: number; z: number } {
  const amount = isGeneratedCavernWorld(world) ? GENERATED_CAVERN_VERTEX_JITTER : DEFAULT_VERTEX_JITTER;
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAxisOffset(axis: FaceAxis, amount: number): number {
  return axis === "x" ? amount : 0;
}

function getAxisOffsetY(axis: FaceAxis, amount: number): number {
  return axis === "y" ? amount : 0;
}

function getAxisOffsetZ(axis: FaceAxis, amount: number): number {
  return axis === "z" ? amount : 0;
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
