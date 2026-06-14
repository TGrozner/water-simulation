import {
  Color,
  type BufferGeometry,
  ConeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterialParameters,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Scene,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { inBounds, isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";

export type CavernDecorRenderer = {
  root: Group;
  update: (world: VoxelWorld) => void;
  dispose: () => void;
};

type DecorCounts = {
  crystal: number;
  glow: number;
  spike: number;
};

type DecorLight = {
  light: PointLight;
  x: number;
  y: number;
  z: number;
};

const CAVE_ASSET_BASE = "assets/kenney-nature-kit/";
const CAVE_ASSET_FILES = [
  { key: "cliffWaterfall", file: "cliff_waterfall_rock.glb" },
  { key: "cliffWaterfallTop", file: "cliff_waterfallTop_rock.glb" },
  { key: "riverRocks", file: "ground_riverRocks.glb" },
  { key: "largeRockA", file: "rock_largeA.glb" },
  { key: "largeRockD", file: "rock_largeD.glb" },
  { key: "tallRockA", file: "rock_tallA.glb" },
  { key: "flatRock", file: "rock_smallFlatC.glb" },
  { key: "mushrooms", file: "mushroom_tanGroup.glb" },
] as const;

type CaveAssetKey = (typeof CAVE_ASSET_FILES)[number]["key"];

type CaveAssetState = {
  root: Group;
  loader: GLTFLoader;
  prototypes: Partial<Record<CaveAssetKey, Object3D>>;
  loadingStarted: boolean;
  disposed: boolean;
  signature: string;
};

type CaveAssetPlacement = {
  key: CaveAssetKey;
  x: number;
  y: number;
  z: number;
  scale: number;
  rotationY: number;
};

const CAVE_ASSET_MATERIALS: Record<CaveAssetKey, MeshStandardMaterialParameters> = {
  cliffWaterfall: { color: 0x625f51, emissive: 0x101711, roughness: 0.9, metalness: 0.02 },
  cliffWaterfallTop: { color: 0x746852, emissive: 0x15140f, roughness: 0.88, metalness: 0.02 },
  riverRocks: { color: 0x5f675a, emissive: 0x0d1714, roughness: 0.92, metalness: 0.02 },
  largeRockA: { color: 0x6f6858, emissive: 0x121612, roughness: 0.92, metalness: 0.02 },
  largeRockD: { color: 0x665f50, emissive: 0x10130f, roughness: 0.92, metalness: 0.02 },
  tallRockA: { color: 0x59675d, emissive: 0x0c1512, roughness: 0.9, metalness: 0.02 },
  flatRock: { color: 0x79705e, emissive: 0x151510, roughness: 0.9, metalness: 0.02 },
  mushrooms: { color: 0xb49b72, emissive: 0x271d11, roughness: 0.78, metalness: 0.01 },
};

const CRYSTAL_CAPACITY = 260;
const GLOW_CAPACITY = 72;
const SPIKE_CAPACITY = 180;
const PROCEDURAL_DECOR_VISIBLE = false;
const decorDummy = new Object3D();
const decorColor = new Color();

export function createCavernDecorRenderer(scene: Scene, world: VoxelWorld): CavernDecorRenderer {
  const root = new Group();
  root.name = "cavern-decor";
  const assetRoot = new Group();
  assetRoot.name = "cc0-cave-assets";
  root.add(assetRoot);
  const caveAssets = createCaveAssetState(assetRoot);

  const crystalGeometry = new ConeGeometry(0.34, 1.7, 5, 1);
  const glowGeometry = new IcosahedronGeometry(0.45, 1);
  const spikeGeometry = new ConeGeometry(0.46, 2.4, 5, 1);
  const crystalMaterial = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x17333a,
    roughness: 0.42,
    metalness: 0.08,
    vertexColors: true,
  });
  const glowMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.58,
    depthWrite: false,
    vertexColors: true,
  });
  const spikeMaterial = new MeshStandardMaterial({
    color: 0x7b6a55,
    emissive: 0x12100d,
    roughness: 0.88,
    metalness: 0.02,
    vertexColors: true,
  });

  const crystalMesh = new InstancedMesh(crystalGeometry, crystalMaterial, CRYSTAL_CAPACITY);
  const glowMesh = new InstancedMesh(glowGeometry, glowMaterial, GLOW_CAPACITY);
  const spikeMesh = new InstancedMesh(spikeGeometry, spikeMaterial, SPIKE_CAPACITY);
  crystalMesh.frustumCulled = false;
  glowMesh.frustumCulled = false;
  spikeMesh.frustumCulled = false;
  root.add(spikeMesh);
  root.add(crystalMesh);
  root.add(glowMesh);

  const lights: DecorLight[] = [
    createDecorLight(58, 9, 22, 0x4fe8ff),
    createDecorLight(18, 32, 26, 0xffb95f),
    createDecorLight(20, 12, 52, 0x9b7dff),
  ];
  for (const { light } of lights) {
    root.add(light);
  }

  scene.add(root);

  const renderer: CavernDecorRenderer = {
    root,
    update: (nextWorld) => {
      rebuildDecor(nextWorld, crystalMesh, glowMesh, spikeMesh, lights);
      rebuildCaveAssetDecor(nextWorld, caveAssets);
    },
    dispose: () => {
      scene.remove(root);
      disposeCaveAssets(caveAssets);
      crystalGeometry.dispose();
      glowGeometry.dispose();
      spikeGeometry.dispose();
      crystalMaterial.dispose();
      glowMaterial.dispose();
      spikeMaterial.dispose();
    },
  };

  renderer.update(world);
  return renderer;
}

function createCaveAssetState(root: Group): CaveAssetState {
  return {
    root,
    loader: new GLTFLoader(),
    prototypes: {},
    loadingStarted: false,
    disposed: false,
    signature: "",
  };
}

function rebuildCaveAssetDecor(world: VoxelWorld, state: CaveAssetState, force = false): void {
  const isGeneratedCavernWorld = world.width >= 64 || world.depth >= 64 || world.height >= 40;
  state.root.visible = isGeneratedCavernWorld;
  if (!isGeneratedCavernWorld) {
    state.root.clear();
    state.signature = "";
    return;
  }

  startCaveAssetLoading(world, state);
  const loadedCount = CAVE_ASSET_FILES.reduce((count, asset) => count + (state.prototypes[asset.key] ? 1 : 0), 0);
  const signature = `${world.width}x${world.height}x${world.depth}:${loadedCount}`;
  if (!force && state.signature === signature) {
    return;
  }

  state.root.clear();
  for (const placement of getCaveAssetPlacements(world)) {
    const prototype = state.prototypes[placement.key];
    if (!prototype) {
      continue;
    }

    const clone = prototype.clone(true);
    clone.position.set(placement.x - world.width / 2 + 0.5, placement.y, placement.z - world.depth / 2 + 0.5);
    clone.rotation.set(0, placement.rotationY, 0);
    clone.scale.setScalar(placement.scale);
    state.root.add(clone);
  }

  state.signature = signature;
}

function startCaveAssetLoading(world: VoxelWorld, state: CaveAssetState): void {
  if (state.loadingStarted || state.disposed) {
    return;
  }

  state.loadingStarted = true;
  for (const asset of CAVE_ASSET_FILES) {
    state.loader.load(
      `${CAVE_ASSET_BASE}${asset.file}`,
      (gltf) => {
        if (state.disposed) {
          return;
        }
        prepareCaveAssetPrototype(gltf.scene, asset.key);
        state.prototypes[asset.key] = gltf.scene;
        state.signature = "";
        rebuildCaveAssetDecor(world, state, true);
      },
      undefined,
      () => {
        state.signature = "";
      },
    );
  }
}

function prepareCaveAssetPrototype(prototype: Object3D, key: CaveAssetKey): void {
  const material = new MeshStandardMaterial(CAVE_ASSET_MATERIALS[key]);
  prototype.traverse((child) => {
    child.frustumCulled = false;
    child.castShadow = false;
    child.receiveShadow = true;
    if (child instanceof Mesh) {
      child.material = material;
    }
  });
}

function getCaveAssetPlacements(world: VoxelWorld): CaveAssetPlacement[] {
  const placements: CaveAssetPlacement[] = [];
  addAssetOnFloor(placements, world, "cliffWaterfallTop", 57, 22, 8, 0.9, 0.15);
  addAssetOnFloor(placements, world, "cliffWaterfall", 57, 24, 7, 0.95, 0.15);
  addAssetOnFloor(placements, world, "riverRocks", 39, 40, 7, 0.8, 2.2);
  addAssetOnFloor(placements, world, "largeRockA", 49, 18, 6, 0.85, 0.8);
  addAssetOnFloor(placements, world, "largeRockD", 63, 54, 5, 0.82, 2.7);
  addAssetOnFloor(placements, world, "tallRockA", 23, 47, 8, 0.88, 1.5);
  addAssetOnFloor(placements, world, "flatRock", 33, 34, 6, 1.05, 0.35);
  addAssetOnFloor(placements, world, "mushrooms", 18, 26, 26, 1.15, 2.9);
  addAssetOnFloor(placements, world, "mushrooms", 21, 52, 11, 0.95, 0.7);
  addAssetOnFloor(placements, world, "largeRockA", 61, 23, 7, 0.72, 2.1);
  addAssetOnFloor(placements, world, "flatRock", 54, 24, 7, 0.86, 1.7);
  addAssetOnFloor(placements, world, "tallRockA", 56, 27, 7, 0.7, 0.4);
  addAssetOnFloor(placements, world, "riverRocks", 31, 37, 7, 0.72, 0.6);
  return placements;
}

function addAssetOnFloor(
  placements: CaveAssetPlacement[],
  world: VoxelWorld,
  key: CaveAssetKey,
  x: number,
  z: number,
  preferredY: number,
  scale: number,
  rotationY: number,
): void {
  if (x < 1 || x >= world.width - 1 || z < 1 || z >= world.depth - 1) {
    return;
  }

  const floorY = findNearestFloorY(world, x, z, preferredY);
  if (floorY < 0) {
    return;
  }

  placements.push({ key, x, y: floorY + 0.02, z, scale, rotationY });
}

function disposeCaveAssets(state: CaveAssetState): void {
  state.disposed = true;
  const disposedGeometries = new Set<BufferGeometry>();
  const disposedMaterials = new Set<Material>();
  for (const prototype of Object.values(state.prototypes)) {
    if (prototype) {
      disposeObjectTree(prototype, disposedGeometries, disposedMaterials);
    }
  }
  for (const child of state.root.children) {
    disposeObjectTree(child, disposedGeometries, disposedMaterials);
  }
  state.root.clear();
  state.prototypes = {};
}

function disposeObjectTree(object: Object3D, disposedGeometries: Set<BufferGeometry>, disposedMaterials: Set<Material>): void {
  object.traverse((child) => {
    if (!(child instanceof Mesh)) {
      return;
    }

    if (!disposedGeometries.has(child.geometry)) {
      child.geometry.dispose();
      disposedGeometries.add(child.geometry);
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!disposedMaterials.has(material)) {
        material.dispose();
        disposedMaterials.add(material);
      }
    }
  });
}

function rebuildDecor(
  world: VoxelWorld,
  crystalMesh: InstancedMesh,
  glowMesh: InstancedMesh,
  spikeMesh: InstancedMesh,
  lights: DecorLight[],
): void {
  const isGeneratedCavernWorld = world.width >= 64 || world.depth >= 64 || world.height >= 40;
  const showProceduralDecor = isGeneratedCavernWorld && PROCEDURAL_DECOR_VISIBLE;
  crystalMesh.visible = showProceduralDecor;
  glowMesh.visible = showProceduralDecor;
  spikeMesh.visible = showProceduralDecor;
  for (const decorLight of lights) {
    decorLight.light.visible = isGeneratedCavernWorld;
    setDecorLightPosition(world, decorLight);
  }

  if (!showProceduralDecor) {
    crystalMesh.count = 0;
    glowMesh.count = 0;
    spikeMesh.count = 0;
    return;
  }

  const counts: DecorCounts = { crystal: 0, glow: 0, spike: 0 };
  addCrystalCluster(world, crystalMesh, glowMesh, counts, 58, 5, 22, 0x67f1ff, 13, 1.15);
  addCrystalCluster(world, crystalMesh, glowMesh, counts, 60, 5, 56, 0x67d9ff, 12, 1.1);
  addCrystalCluster(world, crystalMesh, glowMesh, counts, 18, 30, 26, 0xffb95f, 16, 1.2);
  addCrystalCluster(world, crystalMesh, glowMesh, counts, 21, 10, 52, 0x9b7dff, 12, 1.08);
  addCrystalCluster(world, crystalMesh, glowMesh, counts, 36, 8, 38, 0xff8a4f, 10, 0.95);

  crystalMesh.count = counts.crystal;
  glowMesh.count = counts.glow;
  spikeMesh.count = 0;
  crystalMesh.instanceMatrix.needsUpdate = true;
  glowMesh.instanceMatrix.needsUpdate = true;
  spikeMesh.instanceMatrix.needsUpdate = true;
  if (crystalMesh.instanceColor) {
    crystalMesh.instanceColor.needsUpdate = true;
  }
  if (glowMesh.instanceColor) {
    glowMesh.instanceColor.needsUpdate = true;
  }
  if (spikeMesh.instanceColor) {
    spikeMesh.instanceColor.needsUpdate = true;
  }
  crystalMesh.computeBoundingSphere();
  glowMesh.computeBoundingSphere();
  spikeMesh.computeBoundingSphere();
}

function addCrystalCluster(
  world: VoxelWorld,
  crystalMesh: InstancedMesh,
  glowMesh: InstancedMesh,
  counts: DecorCounts,
  centerX: number,
  centerY: number,
  centerZ: number,
  color: number,
  count: number,
  scale: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const angle = getDecorNoise(centerX, i, centerZ) * Math.PI * 2;
    const radius = 0.5 + getDecorNoise(centerZ, i, centerX) * 3.6;
    const x = Math.round(centerX + Math.cos(angle) * radius);
    const z = Math.round(centerZ + Math.sin(angle) * radius);
    const floorY = findNearestFloorY(world, x, z, centerY);
    if (floorY < 0) {
      continue;
    }

    addCrystal(world, crystalMesh, counts, x, floorY, z, color, scale * (0.7 + getDecorNoise(i, x, z) * 0.9), angle);
    if (i % 4 === 0) {
      addGlow(world, glowMesh, counts, x, floorY + 1, z, color, scale * 1.6);
    }
  }
}

function addCrystal(
  world: VoxelWorld,
  mesh: InstancedMesh,
  counts: DecorCounts,
  x: number,
  y: number,
  z: number,
  color: number,
  scale: number,
  rotationY: number,
): void {
  if (counts.crystal >= CRYSTAL_CAPACITY || !isOpen(world, x, y, z)) {
    return;
  }

  decorDummy.position.set(x - world.width / 2 + 0.5, y + scale * 0.78, z - world.depth / 2 + 0.5);
  decorDummy.rotation.set(0.12, rotationY, -0.08);
  decorDummy.scale.set(scale * 0.78, scale, scale * 0.78);
  decorDummy.updateMatrix();
  mesh.setMatrixAt(counts.crystal, decorDummy.matrix);
  decorColor.setHex(color);
  mesh.setColorAt(counts.crystal, decorColor);
  counts.crystal += 1;
}

function addGlow(
  world: VoxelWorld,
  mesh: InstancedMesh,
  counts: DecorCounts,
  x: number,
  y: number,
  z: number,
  color: number,
  scale: number,
): void {
  if (counts.glow >= GLOW_CAPACITY || !isOpen(world, x, y, z)) {
    return;
  }

  decorDummy.position.set(x - world.width / 2 + 0.5, y + 0.55, z - world.depth / 2 + 0.5);
  decorDummy.rotation.set(0, 0, 0);
  decorDummy.scale.setScalar(scale);
  decorDummy.updateMatrix();
  mesh.setMatrixAt(counts.glow, decorDummy.matrix);
  decorColor.setHex(color);
  mesh.setColorAt(counts.glow, decorColor);
  counts.glow += 1;
}

function findNearestFloorY(world: VoxelWorld, x: number, z: number, preferredY: number): number {
  let bestY = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 1; y < world.height - 1; y += 1) {
    if (!isOpen(world, x, y, z) || !isSolid(world, x, y - 1, z)) {
      continue;
    }

    const distance = Math.abs(y - preferredY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestY = y;
    }
  }
  return bestY;
}

function isOpen(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return inBounds(world, x, y, z) && !isSolid(world, x, y, z);
}

function createDecorLight(x: number, y: number, z: number, color: number): DecorLight {
  const light = new PointLight(color, 0.85, 18, 1.8);
  return { light, x, y, z };
}

function setDecorLightPosition(world: VoxelWorld, decorLight: DecorLight): void {
  decorLight.light.position.set(decorLight.x - world.width / 2 + 0.5, decorLight.y, decorLight.z - world.depth / 2 + 0.5);
}

function getDecorNoise(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801) ^ Math.imul(z, 958282777);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 2246822519);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967295;
}
