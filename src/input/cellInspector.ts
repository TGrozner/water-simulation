import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3, WebGLRenderer } from "three";
import type { TerrainRenderer } from "../render/terrainRenderer";
import type { WaterRenderer } from "../render/waterRenderer";
import type { RenderOptions } from "../render/renderOptions";
import { coords, inBounds, index } from "../world/grid";
import type { CellCoords, VoxelWorld } from "../world/types";

export type InspectedCell = {
  coords: CellCoords;
  solid: boolean;
  water: number;
  active: boolean;
  source: "terrain" | "water" | "ray-empty" | "slice-empty";
} | null;

export type CellInspector = {
  update: () => void;
  getCell: () => InspectedCell;
};

export function createCellInspector(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  worldProvider: () => VoxelWorld,
  terrainProvider: () => TerrainRenderer,
  waterProvider: () => WaterRenderer,
  renderOptionsProvider: () => RenderOptions,
): CellInspector {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const slicePlane = new Plane();
  const sliceHit = new Vector3();
  let hasPointer = false;
  let inspectedCell: InspectedCell = null;
  const canvas = renderer.domElement;

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    hasPointer = true;
  });

  canvas.addEventListener("pointerleave", () => {
    hasPointer = false;
    inspectedCell = null;
  });

  function update(): void {
    if (!hasPointer) {
      return;
    }

    raycaster.setFromCamera(pointer, camera);
    const terrainHit = terrainProvider().pickCell(raycaster);
    const waterHit = raycaster.intersectObject(waterProvider().mesh, false)[0];
    const terrainDistance = terrainHit?.distance ?? Number.POSITIVE_INFINITY;
    const waterDistance = waterHit?.distance ?? Number.POSITIVE_INFINITY;

    if (!terrainHit && !waterHit) {
      inspectedCell = inspectRaymarchedCell() ?? inspectSliceCell();
      return;
    }

    const world = worldProvider();
    const source = waterDistance <= terrainDistance ? "water" : "terrain";
    const cellIndex = source === "water" ? getWaterHitCellIndex(waterHit) : terrainHit?.cellIndex ?? null;
    if (cellIndex === null) {
      inspectedCell = null;
      return;
    }
    const cell = coords(world, cellIndex);

    inspectedCell = {
      coords: cell,
      solid: world.solid[cellIndex] === 1,
      water: world.water[cellIndex],
      active: world.activeCells.has(cellIndex),
      source,
    };
  }

  function getWaterHitCellIndex(hit: { instanceId?: number }): number | null {
    return hit.instanceId === undefined ? null : waterProvider().instanceToCell[hit.instanceId];
  }

  function inspectRaymarchedCell(): InspectedCell {
    const world = worldProvider();
    const bounds = {
      minX: -world.width / 2,
      maxX: world.width / 2,
      minY: 0,
      maxY: world.height,
      minZ: -world.depth / 2,
      maxZ: world.depth / 2,
    };
    const interval = intersectWorldBounds(bounds);
    if (!interval) {
      return null;
    }

    const step = 0.35;
    for (let t = Math.max(0, interval.near); t <= interval.far; t += step) {
      const point = raycaster.ray.at(t, sliceHit);
      const x = Math.floor(point.x + world.width / 2);
      const y = Math.floor(point.y);
      const z = Math.floor(point.z + world.depth / 2);
      if (!inBounds(world, x, y, z)) {
        continue;
      }

      const cellIndex = index(world, x, y, z);
      return {
        coords: { x, y, z },
        solid: world.solid[cellIndex] === 1,
        water: world.water[cellIndex],
        active: world.activeCells.has(cellIndex),
        source: "ray-empty",
      };
    }

    return null;
  }

  function intersectWorldBounds(bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  }): { near: number; far: number } | null {
    let near = 0;
    let far = Number.POSITIVE_INFINITY;
    const origin = raycaster.ray.origin;
    const direction = raycaster.ray.direction;

    const axes = [
      { origin: origin.x, direction: direction.x, min: bounds.minX, max: bounds.maxX },
      { origin: origin.y, direction: direction.y, min: bounds.minY, max: bounds.maxY },
      { origin: origin.z, direction: direction.z, min: bounds.minZ, max: bounds.maxZ },
    ];

    for (const axis of axes) {
      if (Math.abs(axis.direction) < 0.000001) {
        if (axis.origin < axis.min || axis.origin > axis.max) {
          return null;
        }
        continue;
      }

      const t1 = (axis.min - axis.origin) / axis.direction;
      const t2 = (axis.max - axis.origin) / axis.direction;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));

      if (near > far) {
        return null;
      }
    }

    return { near, far };
  }

  function inspectSliceCell(): InspectedCell {
    const world = worldProvider();
    const options = renderOptionsProvider();
    if (!options.slice.enabled) {
      return null;
    }

    const sliceZ = Math.min(world.depth - 1, Math.max(0, options.slice.z));
    const worldZ = sliceZ - world.depth / 2 + 0.5;
    slicePlane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1), new Vector3(0, 0, worldZ));

    if (!raycaster.ray.intersectPlane(slicePlane, sliceHit)) {
      return null;
    }

    const x = Math.floor(sliceHit.x + world.width / 2);
    const y = Math.floor(sliceHit.y);
    const z = sliceZ;
    if (!inBounds(world, x, y, z)) {
      return null;
    }

    const cellIndex = index(world, x, y, z);

    return {
      coords: { x, y, z },
      solid: world.solid[cellIndex] === 1,
      water: world.water[cellIndex],
      active: world.activeCells.has(cellIndex),
      source: "slice-empty",
    };
  }

  return {
    update,
    getCell: () => inspectedCell,
  };
}
