import {
  Color,
  ConeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  Scene,
} from "three";
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

const CRYSTAL_CAPACITY = 260;
const GLOW_CAPACITY = 72;
const SPIKE_CAPACITY = 180;
const decorDummy = new Object3D();
const decorColor = new Color();

export function createCavernDecorRenderer(scene: Scene, world: VoxelWorld): CavernDecorRenderer {
  const root = new Group();
  root.name = "cavern-decor";

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
    },
    dispose: () => {
      scene.remove(root);
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

function rebuildDecor(
  world: VoxelWorld,
  crystalMesh: InstancedMesh,
  glowMesh: InstancedMesh,
  spikeMesh: InstancedMesh,
  lights: DecorLight[],
): void {
  const isDeepCavern = world.width >= 64 || world.depth >= 64 || world.height >= 40;
  crystalMesh.visible = isDeepCavern;
  glowMesh.visible = isDeepCavern;
  spikeMesh.visible = isDeepCavern;
  for (const decorLight of lights) {
    decorLight.light.visible = isDeepCavern;
    setDecorLightPosition(world, decorLight);
  }

  if (!isDeepCavern) {
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

  for (let z = 8; z < world.depth - 8; z += 5) {
    for (let x = 8; x < world.width - 8; x += 5) {
      const seed = getDecorNoise(x, 0, z);
      if (seed < 0.16) {
        const floorY = findFloorY(world, x, z);
        if (floorY >= 0) {
          addSpike(world, spikeMesh, counts, x, floorY, z, false, 0.9 + seed * 2.4, 0x78604a);
        }
      } else if (seed > 0.84) {
        const ceilingY = findCeilingY(world, x, z);
        if (ceilingY >= 0) {
          addSpike(world, spikeMesh, counts, x, ceilingY, z, true, 1.0 + (1 - seed) * 2.1, 0x615c57);
        }
      }
    }
  }

  crystalMesh.count = counts.crystal;
  glowMesh.count = counts.glow;
  spikeMesh.count = counts.spike;
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

function addSpike(
  world: VoxelWorld,
  mesh: InstancedMesh,
  counts: DecorCounts,
  x: number,
  y: number,
  z: number,
  inverted: boolean,
  scale: number,
  color: number,
): void {
  if (counts.spike >= SPIKE_CAPACITY || !isOpen(world, x, y, z)) {
    return;
  }

  const height = 2.4 * scale;
  decorDummy.position.set(
    x - world.width / 2 + 0.5,
    inverted ? y + 1 - height * 0.5 : y + height * 0.5,
    z - world.depth / 2 + 0.5,
  );
  decorDummy.rotation.set(inverted ? Math.PI : 0, getDecorNoise(x, y, z) * Math.PI * 2, 0);
  decorDummy.scale.set(0.72 + scale * 0.2, scale, 0.72 + scale * 0.2);
  decorDummy.updateMatrix();
  mesh.setMatrixAt(counts.spike, decorDummy.matrix);
  decorColor.setHex(color);
  mesh.setColorAt(counts.spike, decorColor);
  counts.spike += 1;
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

function findFloorY(world: VoxelWorld, x: number, z: number): number {
  for (let y = 1; y < world.height - 1; y += 1) {
    if (isOpen(world, x, y, z) && isSolid(world, x, y - 1, z)) {
      return y;
    }
  }
  return -1;
}

function findCeilingY(world: VoxelWorld, x: number, z: number): number {
  for (let y = world.height - 2; y > 1; y -= 1) {
    if (isOpen(world, x, y, z) && isSolid(world, x, y + 1, z)) {
      return y;
    }
  }
  return -1;
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
