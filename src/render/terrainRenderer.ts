import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
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
  mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  organicMesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  faceSpans: FaceSpan[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  faceCount: number;
  organicFaceCount: number;
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
const GENERATED_CAVERN_NORMAL_ROUGHNESS = 0.36;
const DEFAULT_NORMAL_ROUGHNESS = 0.16;
const GENERATED_CAVERN_FACE_TILE_SIZE = 1;
const GENERATED_CAVERN_FACE_RELIEF = 0.28;
const ORGANIC_TERRAIN_ISO_LEVEL = 0.5;

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
  const visualMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    side: DoubleSide,
    vertexColors: true,
    roughness: 0.91,
    metalness: 0.01,
    flatShading: false,
  });
  const pickMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  pickMaterial.colorWrite = false;
  const stats = createRendererStats(world.solid.length * 6);
  const chunkXCount = Math.ceil(world.width / TERRAIN_CHUNK_SIZE);
  const chunkYCount = Math.ceil(world.height / TERRAIN_CHUNK_SIZE);
  const chunkZCount = Math.ceil(world.depth / TERRAIN_CHUNK_SIZE);
  const chunks = createTerrainChunks(root, pickMaterial, visualMaterial, world, chunkXCount, chunkYCount, chunkZCount);
  const visibleChunkMeshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
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
        chunk.organicMesh.geometry.dispose();
      }
      visualMaterial.dispose();
      pickMaterial.dispose();
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
      rebuildOrganicTerrainChunk(chunks[chunkIndex], nextWorld, options);
    }

    refreshVisibleChunks();
    renderer.stats.updateMs = performance.now() - startedAt;
    renderer.stats.instances = chunks.reduce((total, chunk) => total + chunk.organicFaceCount, 0);
    dirtyChunks.clear();
    allDirty = false;
    lastOptionsKey = optionsKey;
  }

  function markCellNeighborhoodDirty(cellIndex: number): void {
    const cell = coords(world, cellIndex);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          markChunkAt(cell.x + dx, cell.y + dy, cell.z + dz);
        }
      }
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
      chunk.organicMesh.visible = chunk.organicFaceCount > 0;
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
  pickMaterial: MeshBasicMaterial,
  visualMaterial: MeshStandardMaterial,
  world: VoxelWorld,
  chunkXCount: number,
  chunkYCount: number,
  chunkZCount: number,
): TerrainChunk[] {
  const chunks: TerrainChunk[] = [];

  for (let chunkY = 0; chunkY < chunkYCount; chunkY += 1) {
    for (let chunkZ = 0; chunkZ < chunkZCount; chunkZ += 1) {
      for (let chunkX = 0; chunkX < chunkXCount; chunkX += 1) {
        const mesh = new Mesh(new BufferGeometry(), pickMaterial);
        const organicMesh = new Mesh(new BufferGeometry(), visualMaterial);
        const chunkIndex = chunks.length;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.userData.terrainChunkIndex = chunkIndex;
        organicMesh.castShadow = true;
        organicMesh.receiveShadow = true;
        organicMesh.frustumCulled = false;
        organicMesh.renderOrder = -1;
        root.add(organicMesh);
        root.add(mesh);
        chunks.push({
          mesh,
          organicMesh,
          faceSpans: [],
          minX: chunkX * TERRAIN_CHUNK_SIZE,
          maxX: Math.min(world.width, (chunkX + 1) * TERRAIN_CHUNK_SIZE),
          minY: chunkY * TERRAIN_CHUNK_SIZE,
          maxY: Math.min(world.height, (chunkY + 1) * TERRAIN_CHUNK_SIZE),
          minZ: chunkZ * TERRAIN_CHUNK_SIZE,
          maxZ: Math.min(world.depth, (chunkZ + 1) * TERRAIN_CHUNK_SIZE),
          faceCount: 0,
          organicFaceCount: 0,
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

function rebuildOrganicTerrainChunk(chunk: TerrainChunk, world: VoxelWorld, options: RenderOptions): void {
  const cellMinX = Math.max(0, chunk.minX - 1);
  const cellMinY = Math.max(0, chunk.minY - 1);
  const cellMinZ = Math.max(0, chunk.minZ - 1);
  const cellMaxX = chunk.maxX;
  const cellMaxY = chunk.maxY;
  const cellMaxZ = chunk.maxZ;
  const cellWidth = cellMaxX - cellMinX;
  const cellHeight = cellMaxY - cellMinY;
  const cellDepth = cellMaxZ - cellMinZ;
  const nodeMinX = cellMinX;
  const nodeMinY = cellMinY;
  const nodeMinZ = cellMinZ;
  const nodeMaxX = cellMaxX + 1;
  const nodeMaxY = cellMaxY + 1;
  const nodeMaxZ = cellMaxZ + 1;
  const nodeWidth = nodeMaxX - nodeMinX;
  const nodeHeight = nodeMaxY - nodeMinY;
  const nodeDepth = nodeMaxZ - nodeMinZ;
  const nodeDensities = new Float32Array(nodeWidth * nodeHeight * nodeDepth);
  const cellVertices = new Int32Array(cellWidth * cellHeight * cellDepth);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  cellVertices.fill(-1);

  for (let y = nodeMinY; y < nodeMaxY; y += 1) {
    for (let z = nodeMinZ; z < nodeMaxZ; z += 1) {
      for (let x = nodeMinX; x < nodeMaxX; x += 1) {
        nodeDensities[getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, nodeMinX, nodeMinY, nodeMinZ, x, y, z)] =
          getTerrainNodeDensity(world, options, x, y, z);
      }
    }
  }

  for (let y = cellMinY; y < cellMaxY; y += 1) {
    for (let z = cellMinZ; z < cellMaxZ; z += 1) {
      for (let x = cellMinX; x < cellMaxX; x += 1) {
        const cornerDensities = getSurfaceCellCornerDensities(
          nodeDensities,
          nodeWidth,
          nodeDepth,
          nodeMinX,
          nodeMinY,
          nodeMinZ,
          x,
          y,
          z,
        );
        const solidCornerCount = cornerDensities.reduce(
          (total, density) => total + Number(density >= ORGANIC_TERRAIN_ISO_LEVEL),
          0,
        );
        if (solidCornerCount === 0 || solidCornerCount === 8) {
          continue;
        }

        const vertex = getSurfaceNetVertex(x, y, z, cornerDensities);
        const color = getOrganicTerrainColor(world, vertex.x, vertex.y, vertex.z);
        const vertexIndex = positions.length / 3;
        positions.push(vertex.x - world.width / 2, vertex.y, vertex.z - world.depth / 2);
        colors.push(color.r, color.g, color.b);
        cellVertices[getLocalSurfaceCellIndex(cellWidth, cellDepth, cellMinX, cellMinY, cellMinZ, x, y, z)] =
          vertexIndex;
      }
    }
  }

  appendSurfaceNetXQuads(indices, cellVertices, nodeDensities, nodeWidth, nodeDepth, chunk, world, {
    cellMinX,
    cellMinY,
    cellMinZ,
    cellWidth,
    cellDepth,
    nodeMinX,
    nodeMinY,
    nodeMinZ,
  });
  appendSurfaceNetYQuads(indices, cellVertices, nodeDensities, nodeWidth, nodeDepth, chunk, world, {
    cellMinX,
    cellMinY,
    cellMinZ,
    cellWidth,
    cellDepth,
    nodeMinX,
    nodeMinY,
    nodeMinZ,
  });
  appendSurfaceNetZQuads(indices, cellVertices, nodeDensities, nodeWidth, nodeDepth, chunk, world, {
    cellMinX,
    cellMinY,
    cellMinZ,
    cellWidth,
    cellDepth,
    nodeMinX,
    nodeMinY,
    nodeMinZ,
  });

  const nextGeometry = new BufferGeometry();
  nextGeometry.setIndex(indices);
  nextGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  nextGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  nextGeometry.computeVertexNormals();
  nextGeometry.computeBoundingSphere();
  chunk.organicMesh.geometry.dispose();
  chunk.organicMesh.geometry = nextGeometry;
  chunk.organicMesh.visible = indices.length > 0;
  chunk.organicFaceCount = indices.length / 3;
}

const SURFACE_NET_CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

const SURFACE_NET_EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

function getTerrainNodeDensity(world: VoxelWorld, options: RenderOptions, nodeX: number, nodeY: number, nodeZ: number): number {
  let total = 0;
  let count = 0;

  for (let y = nodeY - 1; y <= nodeY; y += 1) {
    for (let z = nodeZ - 1; z <= nodeZ; z += 1) {
      for (let x = nodeX - 1; x <= nodeX; x += 1) {
        count += 1;
        if (!inBounds(world, x, y, z)) {
          total += 1;
          continue;
        }
        if (shouldRenderCell(world, z, options) && world.solid[getSurfaceCellIndex(world, x, y, z)] === 1) {
          total += 1;
        }
      }
    }
  }

  return total / count;
}

function getSurfaceCellCornerDensities(
  nodeDensities: Float32Array,
  nodeWidth: number,
  nodeDepth: number,
  nodeMinX: number,
  nodeMinY: number,
  nodeMinZ: number,
  x: number,
  y: number,
  z: number,
): number[] {
  return SURFACE_NET_CORNERS.map(([offsetX, offsetY, offsetZ]) =>
    nodeDensities[
      getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, nodeMinX, nodeMinY, nodeMinZ, x + offsetX, y + offsetY, z + offsetZ)
    ]
  );
}

type LocalSurfaceBounds = {
  cellMinX: number;
  cellMinY: number;
  cellMinZ: number;
  cellWidth: number;
  cellDepth: number;
  nodeMinX: number;
  nodeMinY: number;
  nodeMinZ: number;
};

function getSurfaceNetVertex(
  x: number,
  y: number,
  z: number,
  cornerDensities: number[],
): { x: number; y: number; z: number } {
  let totalX = 0;
  let totalY = 0;
  let totalZ = 0;
  let intersectionCount = 0;

  for (const [cornerA, cornerB] of SURFACE_NET_EDGES) {
    const densityA = cornerDensities[cornerA];
    const densityB = cornerDensities[cornerB];
    const solidA = densityA >= ORGANIC_TERRAIN_ISO_LEVEL;
    const solidB = densityB >= ORGANIC_TERRAIN_ISO_LEVEL;
    if (solidA === solidB) {
      continue;
    }

    const [ax, ay, az] = SURFACE_NET_CORNERS[cornerA];
    const [bx, by, bz] = SURFACE_NET_CORNERS[cornerB];
    const t = clamp01((ORGANIC_TERRAIN_ISO_LEVEL - densityA) / (densityB - densityA));
    totalX += x + ax + (bx - ax) * t;
    totalY += y + ay + (by - ay) * t;
    totalZ += z + az + (bz - az) * t;
    intersectionCount += 1;
  }

  const vertexX = intersectionCount > 0 ? totalX / intersectionCount : x + 0.5;
  const vertexY = intersectionCount > 0 ? totalY / intersectionCount : y + 0.5;
  const vertexZ = intersectionCount > 0 ? totalZ / intersectionCount : z + 0.5;
  const drift = getCellVariation(Math.floor(vertexX * 2), Math.floor(vertexY * 2), Math.floor(vertexZ * 2)) - 0.5;

  return {
    x: vertexX + drift * 0.05,
    y: vertexY + (getCellVariation(Math.floor(vertexZ), Math.floor(vertexY * 2), Math.floor(vertexX)) - 0.5) * 0.08,
    z: vertexZ + drift * 0.05,
  };
}

function appendSurfaceNetXQuads(
  indices: number[],
  cellVertices: Int32Array,
  nodeDensities: Float32Array,
  nodeWidth: number,
  nodeDepth: number,
  chunk: TerrainChunk,
  world: VoxelWorld,
  bounds: LocalSurfaceBounds,
): void {
  for (let y = Math.max(1, chunk.minY); y < chunk.maxY; y += 1) {
    for (let z = Math.max(1, chunk.minZ); z < chunk.maxZ; z += 1) {
      for (let x = chunk.minX; x < chunk.maxX; x += 1) {
        const densityA =
          nodeDensities[getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x, y, z)];
        const densityB =
          nodeDensities[
            getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x + 1, y, z)
          ];
        if ((densityA >= ORGANIC_TERRAIN_ISO_LEVEL) === (densityB >= ORGANIC_TERRAIN_ISO_LEVEL)) {
          continue;
        }

        const a = getSurfaceCellVertex(cellVertices, world, bounds, x, y - 1, z - 1);
        const b = getSurfaceCellVertex(cellVertices, world, bounds, x, y, z - 1);
        const c = getSurfaceCellVertex(cellVertices, world, bounds, x, y, z);
        const d = getSurfaceCellVertex(cellVertices, world, bounds, x, y - 1, z);
        appendSurfaceQuad(indices, a, b, c, d, densityA >= ORGANIC_TERRAIN_ISO_LEVEL && densityB < ORGANIC_TERRAIN_ISO_LEVEL);
      }
    }
  }
}

function appendSurfaceNetYQuads(
  indices: number[],
  cellVertices: Int32Array,
  nodeDensities: Float32Array,
  nodeWidth: number,
  nodeDepth: number,
  chunk: TerrainChunk,
  world: VoxelWorld,
  bounds: LocalSurfaceBounds,
): void {
  for (let y = chunk.minY; y < chunk.maxY; y += 1) {
    for (let z = Math.max(1, chunk.minZ); z < chunk.maxZ; z += 1) {
      for (let x = Math.max(1, chunk.minX); x < chunk.maxX; x += 1) {
        const densityA =
          nodeDensities[getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x, y, z)];
        const densityB =
          nodeDensities[
            getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x, y + 1, z)
          ];
        if ((densityA >= ORGANIC_TERRAIN_ISO_LEVEL) === (densityB >= ORGANIC_TERRAIN_ISO_LEVEL)) {
          continue;
        }

        const a = getSurfaceCellVertex(cellVertices, world, bounds, x - 1, y, z - 1);
        const b = getSurfaceCellVertex(cellVertices, world, bounds, x, y, z - 1);
        const c = getSurfaceCellVertex(cellVertices, world, bounds, x, y, z);
        const d = getSurfaceCellVertex(cellVertices, world, bounds, x - 1, y, z);
        appendSurfaceQuad(indices, a, d, c, b, densityA >= ORGANIC_TERRAIN_ISO_LEVEL && densityB < ORGANIC_TERRAIN_ISO_LEVEL);
      }
    }
  }
}

function appendSurfaceNetZQuads(
  indices: number[],
  cellVertices: Int32Array,
  nodeDensities: Float32Array,
  nodeWidth: number,
  nodeDepth: number,
  chunk: TerrainChunk,
  world: VoxelWorld,
  bounds: LocalSurfaceBounds,
): void {
  for (let y = Math.max(1, chunk.minY); y < chunk.maxY; y += 1) {
    for (let z = chunk.minZ; z < chunk.maxZ; z += 1) {
      for (let x = Math.max(1, chunk.minX); x < chunk.maxX; x += 1) {
        const densityA =
          nodeDensities[getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x, y, z)];
        const densityB =
          nodeDensities[
            getLocalSurfaceNodeIndex(nodeWidth, nodeDepth, bounds.nodeMinX, bounds.nodeMinY, bounds.nodeMinZ, x, y, z + 1)
          ];
        if ((densityA >= ORGANIC_TERRAIN_ISO_LEVEL) === (densityB >= ORGANIC_TERRAIN_ISO_LEVEL)) {
          continue;
        }

        const a = getSurfaceCellVertex(cellVertices, world, bounds, x - 1, y - 1, z);
        const b = getSurfaceCellVertex(cellVertices, world, bounds, x, y - 1, z);
        const c = getSurfaceCellVertex(cellVertices, world, bounds, x, y, z);
        const d = getSurfaceCellVertex(cellVertices, world, bounds, x - 1, y, z);
        appendSurfaceQuad(indices, a, b, c, d, densityA >= ORGANIC_TERRAIN_ISO_LEVEL && densityB < ORGANIC_TERRAIN_ISO_LEVEL);
      }
    }
  }
}

function appendSurfaceQuad(indices: number[], a: number, b: number, c: number, d: number, forward: boolean): void {
  if (a < 0 || b < 0 || c < 0 || d < 0) {
    return;
  }

  if (forward) {
    indices.push(a, b, c, a, c, d);
    return;
  }

  indices.push(a, d, c, a, c, b);
}

function getOrganicTerrainColor(world: VoxelWorld, x: number, y: number, z: number): FaceColor {
  const sampleX = clampInt(Math.floor(x), 0, world.width - 1);
  const sampleY = clampInt(Math.floor(y), 0, world.height - 1);
  const sampleZ = clampInt(Math.floor(z), 0, world.depth - 1);
  const baseColor = getBaseTerrainColor(world, sampleX, sampleY, sampleZ);
  const heightFactor = world.height <= 1 ? 0 : y / world.height;
  const largeVariation = getCellVariation(Math.floor(x / 5), Math.floor(y / 3), Math.floor(z / 5));
  const strata = 0.5 + Math.sin(y * 1.15 + x * 0.12 + z * 0.08) * 0.5;
  return scaleHexColor(baseColor, 0.6 + heightFactor * 0.24 + largeVariation * 0.13 + strata * 0.08);
}

function getSurfaceCellIndex(world: VoxelWorld, x: number, y: number, z: number): number {
  return x + world.width * (z + world.depth * y);
}

function getLocalSurfaceNodeIndex(
  width: number,
  depth: number,
  minX: number,
  minY: number,
  minZ: number,
  x: number,
  y: number,
  z: number,
): number {
  return x - minX + width * (z - minZ + depth * (y - minY));
}

function getLocalSurfaceCellIndex(
  width: number,
  depth: number,
  minX: number,
  minY: number,
  minZ: number,
  x: number,
  y: number,
  z: number,
): number {
  return x - minX + width * (z - minZ + depth * (y - minY));
}

function getSurfaceCellVertex(
  cellVertices: Int32Array,
  world: VoxelWorld,
  bounds: LocalSurfaceBounds,
  x: number,
  y: number,
  z: number,
): number {
  if (!inBounds(world, x, y, z)) {
    return -1;
  }

  return cellVertices[
    getLocalSurfaceCellIndex(bounds.cellWidth, bounds.cellDepth, bounds.cellMinX, bounds.cellMinY, bounds.cellMinZ, x, y, z)
  ];
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
  reliefOriginU?: number;
  reliefOriginV?: number;
  reliefWidth?: number;
  reliefHeight?: number;
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
  if (shouldTessellateFace(world, face)) {
    for (let v = 0; v < face.height; v += GENERATED_CAVERN_FACE_TILE_SIZE) {
      for (let u = 0; u < face.width; u += GENERATED_CAVERN_FACE_TILE_SIZE) {
        const subFace = createSubFace(face, u, v, Math.min(GENERATED_CAVERN_FACE_TILE_SIZE, face.width - u), Math.min(GENERATED_CAVERN_FACE_TILE_SIZE, face.height - v));
        appendFaceVertices(positions, normals, colors, uvs, faceSpans, world, subFace, getFaceSpan(subFace));
      }
    }
    return;
  }

  appendFaceVertices(positions, normals, colors, uvs, faceSpans, world, face, getFaceSpan(face));
}

function appendFaceVertices(
  positions: number[],
  normals: number[],
  colors: number[],
  uvs: number[],
  faceSpans: FaceSpan[],
  world: VoxelWorld,
  face: MergedFace,
  span: FaceSpan,
): void {
  const vertices = getMergedFaceVertices(face);
  for (const vertex of vertices) {
    appendMergedVertex(positions, normals, colors, uvs, world, face, vertex);
  }
  faceSpans.push(span, span);
}

function shouldTessellateFace(world: VoxelWorld, face: MergedFace): boolean {
  return isGeneratedCavernWorld(world) && (face.width > GENERATED_CAVERN_FACE_TILE_SIZE || face.height > GENERATED_CAVERN_FACE_TILE_SIZE);
}

function createSubFace(face: MergedFace, u: number, v: number, width: number, height: number): MergedFace {
  const subFace: MergedFace = {
    ...face,
    originX: face.originX + getAxisOffset(face.uAxis, u) + getAxisOffset(face.vAxis, v),
    originY: face.originY + getAxisOffsetY(face.uAxis, u) + getAxisOffsetY(face.vAxis, v),
    originZ: face.originZ + getAxisOffsetZ(face.uAxis, u) + getAxisOffsetZ(face.vAxis, v),
    width,
    height,
    reliefOriginU: (face.reliefOriginU ?? 0) + u,
    reliefOriginV: (face.reliefOriginV ?? 0) + v,
    reliefWidth: face.reliefWidth ?? face.width,
    reliefHeight: face.reliefHeight ?? face.height,
  };
  setFaceAxisRange(subFace, face.uAxis, getFaceAxisOrigin(face, face.uAxis) + u, width);
  setFaceAxisRange(subFace, face.vAxis, getFaceAxisOrigin(face, face.vAxis) + v, height);
  return subFace;
}

function getFaceSpan(face: MergedFace): FaceSpan {
  return {
    originX: face.originX,
    originY: face.originY,
    originZ: face.originZ,
    uAxis: face.uAxis,
    vAxis: face.vAxis,
    width: face.width,
    height: face.height,
  };
}

function getFaceAxisOrigin(face: MergedFace, axis: FaceAxis): number {
  if (axis === "x") {
    return face.originX;
  }
  if (axis === "y") {
    return face.originY;
  }
  return face.originZ;
}

function setFaceAxisRange(face: MergedFace, axis: FaceAxis, start: number, size: number): void {
  if (axis === "x") {
    face.minX = start;
    face.maxX = start + size;
  } else if (axis === "y") {
    face.minY = start;
    face.maxY = start + size;
  } else {
    face.minZ = start;
    face.maxZ = start + size;
  }
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
  const normal = getTerrainVertexNormal(world, face.direction, gridX, gridY, gridZ);
  const color = getTerrainVertexColor(world, sampleX, sampleY, sampleZ, face.direction, gridX, gridY, gridZ);
  const relief = getTerrainFaceRelief(world, face, vertex.u, vertex.v);
  positions.push(
    gridX - world.width / 2 + jitter.x + face.direction.nx * relief,
    gridY + jitter.y + face.direction.ny * relief,
    gridZ - world.depth / 2 + jitter.z + face.direction.nz * relief,
  );
  normals.push(normal.x, normal.y, normal.z);
  colors.push(color.r, color.g, color.b);
  uvs.push(vertex.u, vertex.v);
}

function getTerrainFaceRelief(world: VoxelWorld, face: MergedFace, u: number, v: number): number {
  const sourceWidth = face.reliefWidth ?? face.width;
  const sourceHeight = face.reliefHeight ?? face.height;
  if (!isGeneratedCavernWorld(world) || sourceWidth < 3 || sourceHeight < 3) {
    return 0;
  }

  const sourceU = (face.reliefOriginU ?? 0) + u;
  const sourceV = (face.reliefOriginV ?? 0) + v;
  const edgeDistance = Math.min(sourceU, sourceV, sourceWidth - sourceU, sourceHeight - sourceV);
  if (edgeDistance <= 0) {
    return 0;
  }

  const edgeFade = Math.min(1, edgeDistance / 1.5);
  const worldU = face.originX + getAxisOffset(face.uAxis, u) + getAxisOffset(face.vAxis, v);
  const worldY = face.originY + getAxisOffsetY(face.uAxis, u) + getAxisOffsetY(face.vAxis, v);
  const worldZ = face.originZ + getAxisOffsetZ(face.uAxis, u) + getAxisOffsetZ(face.vAxis, v);
  const strata = Math.sin(worldY * 1.6 + worldU * 0.35 + worldZ * 0.2) * 0.35;
  const noise = getCellVariation(Math.floor(worldU), Math.floor(worldY), Math.floor(worldZ)) - 0.5;
  return (noise + strata) * GENERATED_CAVERN_FACE_RELIEF * edgeFade;
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
    baseColor = mixHexColors(baseColor, wetColor, Math.min(0.52, 0.22 + adjacentWater * 0.24));
  }

  const heightFactor = world.height <= 1 ? 0 : gridY / world.height;
  const isGenerated = isGeneratedCavernWorld(world);
  const variation = isGenerated
    ? getCellVariation(Math.floor(gridX / 4), Math.floor(gridY / 3), Math.floor(gridZ / 4))
    : getCellVariation(gridX, gridY, gridZ);
  const largeVariation = getCellVariation(Math.floor(gridX / 6), Math.floor(gridY / 3), Math.floor(gridZ / 6));
  const strata = 0.5 + Math.sin(gridY * 1.9 + gridX * 0.28 + gridZ * 0.17) * 0.5;
  const light = 0.62 + heightFactor * 0.28 + variation * 0.06 + largeVariation * 0.14 + strata * 0.08;
  const faceLight = direction.ny === 1 ? 1.08 : direction.ny === -1 ? 0.7 : 0.9 + Math.abs(direction.nx) * 0.03;
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
  let color = y <= 7 ? 0x31484c : y >= 34 ? 0x3f4949 : y >= 24 ? 0x52604f : 0x454f43;

  const sediment = Math.sin(y * 0.9 + x * 0.12 + z * 0.08) * 0.5 + Math.sin(y * 0.37 - z * 0.18) * 0.5;
  color = mixHexColors(color, y >= 28 ? 0x6a7159 : 0x28312f, Math.max(0, sediment) * 0.18);

  if (y <= 6 && ((x >= 48 && z <= 32) || (x >= 46 && z >= 47))) {
    color = mixHexColors(color, 0x1f7383, 0.42);
  }

  if (x >= 50 && z <= 32 && y <= 17) {
    color = mixHexColors(color, 0x2a7580, 0.34);
  }

  if (x >= 48 && z >= 47 && y <= 17) {
    color = mixHexColors(color, 0x514a79, 0.3);
  }

  if (x <= 24 && z >= 42 && y <= 16) {
    color = mixHexColors(color, 0x2f7a68, 0.32);
  }

  if (x >= 26 && x <= 44 && z >= 30 && z <= 44 && y <= 16) {
    color = mixHexColors(color, 0x9c6542, 0.26);
  }

  if (x >= 7 && x <= 23 && z >= 18 && z <= 34 && y >= 29) {
    color = mixHexColors(color, 0xaa8649, 0.24);
  }

  color = mixHexColors(color, 0x67f1ff, getGeneratedCavernVeinStrength(x, y, z, 0.41, 0.18) * 0.24);
  color = mixHexColors(color, 0xffb95f, getGeneratedCavernVeinStrength(x, y, z, 0.29, 1.7) * 0.18);
  color = mixHexColors(color, 0x8d6dce, getGeneratedCavernVeinStrength(x, y, z, 0.34, 3.1) * 0.16);

  return color;
}

function getGeneratedCavernVeinStrength(x: number, y: number, z: number, scale: number, phase: number): number {
  const wave =
    Math.sin(x * scale + y * 0.37 + phase) +
    Math.sin(z * scale * 1.4 - y * 0.23 + phase * 0.7) +
    Math.sin((x + z) * scale * 0.45 + y * 0.11);
  return clamp01((wave - 1.15) / 1.45);
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
  const baseColor = getTerrainMergeBand(world, x, y, z);
  if (isGeneratedCavernWorld(world)) {
    return baseColor;
  }

  const isWet = getAdjacentWaterAmount(world, x, y, z, direction) > EPSILON ? 1 : 0;
  return baseColor * 2 + isWet;
}

function getGreedyFaceSpanLimit(world: VoxelWorld): number {
  return isGeneratedCavernWorld(world) ? 9 : 8;
}

function getTerrainVertexJitter(world: VoxelWorld, gridX: number, gridY: number, gridZ: number): { x: number; y: number; z: number } {
  const amount = isGeneratedCavernWorld(world) ? GENERATED_CAVERN_VERTEX_JITTER : DEFAULT_VERTEX_JITTER;
  return {
    x: (getCellVariation(gridX, gridY, gridZ) - 0.5) * amount,
    y: (getCellVariation(gridX + 17, gridY - 11, gridZ + 5) - 0.5) * amount * 0.7,
    z: (getCellVariation(gridX - 23, gridY + 3, gridZ + 29) - 0.5) * amount,
  };
}

function getTerrainVertexNormal(
  world: VoxelWorld,
  direction: FaceDirection,
  gridX: number,
  gridY: number,
  gridZ: number,
): { x: number; y: number; z: number } {
  const roughness = isGeneratedCavernWorld(world) ? GENERATED_CAVERN_NORMAL_ROUGHNESS : DEFAULT_NORMAL_ROUGHNESS;
  const noiseA = getCellVariation(gridX + 31, gridY - 17, gridZ + 11) - 0.5;
  const noiseB = getCellVariation(gridX - 13, gridY + 37, gridZ - 29) - 0.5;
  const noiseC = getCellVariation(Math.floor(gridX / 2), Math.floor(gridY / 2), Math.floor(gridZ / 2)) - 0.5;
  let x = direction.nx;
  let y = direction.ny;
  let z = direction.nz;

  if (Math.abs(direction.nx) > 0) {
    y += (noiseA + noiseC * 0.45) * roughness;
    z += noiseB * roughness;
  } else if (Math.abs(direction.ny) > 0) {
    x += noiseA * roughness;
    z += (noiseB + noiseC * 0.45) * roughness;
  } else {
    x += (noiseA + noiseC * 0.45) * roughness;
    y += noiseB * roughness;
  }

  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

function getTerrainMergeBand(world: VoxelWorld, x: number, y: number, z: number): number {
  if (!isGeneratedCavernWorld(world)) {
    return Math.floor(y / 4);
  }

  let band = Math.floor(y / 6);
  if (x >= 48 && y <= 18 && (z <= 32 || z >= 47)) {
    band += 12;
  } else if (x <= 26 && z >= 42 && y <= 24) {
    band += 20;
  } else if (x >= 26 && x <= 44 && z >= 30 && z <= 44 && y <= 18) {
    band += 28;
  }
  return band;
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
