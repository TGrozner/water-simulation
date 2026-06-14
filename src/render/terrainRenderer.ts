import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshLambertMaterial,
  Scene,
} from "three";
import { inBounds, isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";
import { shouldRenderCell, type RenderOptions } from "./renderOptions";
import { createRendererStats, type RendererStats } from "./renderStats";

export type TerrainRenderer = {
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  faceToCell: Int32Array;
  stats: RendererStats;
  update: (world: VoxelWorld, options?: RenderOptions) => void;
  dispose: () => void;
};

type FaceDirection = {
  nx: number;
  ny: number;
  nz: number;
};

type FaceColor = {
  r: number;
  g: number;
  b: number;
};

const FACE_DIRECTIONS: FaceDirection[] = [
  { nx: 1, ny: 0, nz: 0 },
  { nx: -1, ny: 0, nz: 0 },
  { nx: 0, ny: 1, nz: 0 },
  { nx: 0, ny: -1, nz: 0 },
  { nx: 0, ny: 0, nz: 1 },
  { nx: 0, ny: 0, nz: -1 },
];

export function createTerrainRenderer(scene: Scene, world: VoxelWorld): TerrainRenderer {
  const geometry = new BufferGeometry();
  const material = new MeshLambertMaterial({ color: 0xffffff, side: DoubleSide, vertexColors: true });
  const mesh = new Mesh(geometry, material);
  const stats = createRendererStats(world.solid.length * 6);

  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const terrainRenderer: TerrainRenderer = {
    mesh,
    faceToCell: new Int32Array(0),
    stats,
    update: (nextWorld, options = defaultRenderOptions(nextWorld)) =>
      updateTerrainMesh(terrainRenderer, nextWorld, options),
    dispose: () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };

  terrainRenderer.update(world);

  return terrainRenderer;
}

function updateTerrainMesh(renderer: TerrainRenderer, world: VoxelWorld, options: RenderOptions): void {
  const startedAt = performance.now();
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const faceToCell: number[] = [];
  let faceCount = 0;

  for (let y = 0; y < world.height; y += 1) {
    for (let z = 0; z < world.depth; z += 1) {
      for (let x = 0; x < world.width; x += 1) {
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

  renderer.mesh.geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  renderer.mesh.geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  renderer.mesh.geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  renderer.mesh.geometry.computeBoundingSphere();
  renderer.faceToCell = Int32Array.from(faceToCell);
  renderer.stats.instances = faceCount;
  renderer.stats.updateMs = performance.now() - startedAt;
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
  const vertices = getFaceVertices(minX, maxX, minY, maxY, minZ, maxZ, direction);
  const faceColor = getTerrainFaceColor(world, x, y, z, direction);

  for (const vertex of vertices) {
    positions.push(vertex[0], vertex[1], vertex[2]);
    normals.push(direction.nx, direction.ny, direction.nz);
    colors.push(faceColor.r, faceColor.g, faceColor.b);
  }
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
  const hash = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return hash - Math.floor(hash);
}

function getFaceVertices(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  direction: FaceDirection,
): Array<[number, number, number]> {
  if (direction.nx === 1) {
    return [
      [maxX, minY, minZ],
      [maxX, maxY, minZ],
      [maxX, maxY, maxZ],
      [maxX, minY, minZ],
      [maxX, maxY, maxZ],
      [maxX, minY, maxZ],
    ];
  }

  if (direction.nx === -1) {
    return [
      [minX, minY, maxZ],
      [minX, maxY, maxZ],
      [minX, maxY, minZ],
      [minX, minY, maxZ],
      [minX, maxY, minZ],
      [minX, minY, minZ],
    ];
  }

  if (direction.ny === 1) {
    return [
      [minX, maxY, maxZ],
      [maxX, maxY, maxZ],
      [maxX, maxY, minZ],
      [minX, maxY, maxZ],
      [maxX, maxY, minZ],
      [minX, maxY, minZ],
    ];
  }

  if (direction.ny === -1) {
    return [
      [minX, minY, minZ],
      [maxX, minY, minZ],
      [maxX, minY, maxZ],
      [minX, minY, minZ],
      [maxX, minY, maxZ],
      [minX, minY, maxZ],
    ];
  }

  if (direction.nz === 1) {
    return [
      [minX, minY, maxZ],
      [maxX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, minY, maxZ],
      [maxX, maxY, maxZ],
      [minX, maxY, maxZ],
    ];
  }

  return [
    [maxX, minY, minZ],
    [minX, minY, minZ],
    [minX, maxY, minZ],
    [maxX, minY, minZ],
    [minX, maxY, minZ],
    [maxX, maxY, minZ],
  ];
}

function defaultRenderOptions(world: VoxelWorld): RenderOptions {
  return {
    slice: {
      enabled: false,
      z: world.depth - 1,
    },
  };
}
