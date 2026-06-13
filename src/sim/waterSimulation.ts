import {
  clampWater,
  coords,
  getCapacity,
  index,
  inBounds,
  isSolid,
  wakeNeighbors,
} from "../world/grid";
import {
  DOWN_FLOW_RATE,
  EPSILON,
  MIN_FLOW,
  SIDE_FLOW_RATE,
  type CellCoords,
  type VoxelWorld,
} from "../world/types";

const LATERAL_DIRECTIONS: CellCoords[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

export type WaterSimulationConfig = {
  downFlowRate: number;
  sideFlowRate: number;
  minFlow: number;
};

export const DEFAULT_WATER_SIMULATION_CONFIG: WaterSimulationConfig = {
  downFlowRate: DOWN_FLOW_RATE,
  sideFlowRate: SIDE_FLOW_RATE,
  minFlow: MIN_FLOW,
};

export type FlowDirection = "down" | "side";

export type FlowEvent = {
  fromCellIndex: number;
  cellIndex: number;
  direction: FlowDirection;
  dx: number;
  dy: number;
  dz: number;
  amount: number;
};

export type WaterStepStats = {
  movedVolume: number;
  changedCells: number;
  flowEvents: FlowEvent[];
};

export function stepWaterSimulation(
  world: VoxelWorld,
  config: WaterSimulationConfig = DEFAULT_WATER_SIMULATION_CONFIG,
): WaterStepStats {
  const currentCells = Array.from(world.activeCells).sort((a, b) => a - b);
  const nextActiveCells = new Set<number>();
  let movedVolume = 0;
  let changedCells = 0;
  const flowEvents: FlowEvent[] = [];

  world.activeCells.clear();

  for (const cellIndex of currentCells) {
    if (world.solid[cellIndex] === 1 || world.water[cellIndex] <= EPSILON) {
      continue;
    }

    const cell = coords(world, cellIndex);
    let changed = false;

    const downTransfer = transferWater(world, cell, { x: cell.x, y: cell.y - 1, z: cell.z }, config.downFlowRate);
    if (downTransfer > EPSILON) {
      movedVolume += downTransfer;
      changed = downTransfer >= config.minFlow;
      changedCells += changed ? 1 : 0;
      flowEvents.push({
        fromCellIndex: cellIndex,
        cellIndex: index(world, cell.x, cell.y - 1, cell.z),
        direction: "down",
        dx: 0,
        dy: -1,
        dz: 0,
        amount: downTransfer,
      });
      wakeNeighbors(world, cell.x, cell.y, cell.z, nextActiveCells);
      wakeNeighbors(world, cell.x, cell.y - 1, cell.z, nextActiveCells);
    }

    for (const direction of LATERAL_DIRECTIONS) {
      if (world.water[cellIndex] <= EPSILON) {
        break;
      }

      const target = {
        x: cell.x + direction.x,
        y: cell.y,
        z: cell.z + direction.z,
      };
      const lateralTransfer = transferLateralWater(world, cell, target, config);

      if (lateralTransfer > EPSILON) {
        movedVolume += lateralTransfer;
        flowEvents.push({
          fromCellIndex: cellIndex,
          cellIndex: index(world, target.x, target.y, target.z),
          direction: "side",
          dx: direction.x,
          dy: direction.y,
          dz: direction.z,
          amount: lateralTransfer,
        });
        if (lateralTransfer >= config.minFlow) {
          changed = true;
          changedCells += 1;
          wakeNeighbors(world, cell.x, cell.y, cell.z, nextActiveCells);
          wakeNeighbors(world, target.x, target.y, target.z, nextActiveCells);
        }
      }
    }

    if (changed && world.water[cellIndex] > EPSILON) {
      nextActiveCells.add(cellIndex);
    } else if (world.water[cellIndex] > EPSILON && canStillFlow(world, cell, config)) {
      nextActiveCells.add(cellIndex);
    }
  }

  world.activeCells = nextActiveCells;

  return {
    movedVolume,
    changedCells,
    flowEvents,
  };
}

function canStillFlow(world: VoxelWorld, cell: CellCoords, config: WaterSimulationConfig): boolean {
  if (getCapacity(world, cell.x, cell.y - 1, cell.z) > EPSILON) {
    return true;
  }

  const fromWater = world.water[index(world, cell.x, cell.y, cell.z)];

  for (const direction of LATERAL_DIRECTIONS) {
    const target = {
      x: cell.x + direction.x,
      y: cell.y,
      z: cell.z + direction.z,
    };
    if (!inBounds(world, target.x, target.y, target.z) || isSolid(world, target.x, target.y, target.z)) {
      continue;
    }

    if (fromWater - world.water[index(world, target.x, target.y, target.z)] > config.minFlow) {
      return true;
    }
  }

  return false;
}

function transferWater(world: VoxelWorld, from: CellCoords, to: CellCoords, maxRate: number): number {
  if (!inBounds(world, to.x, to.y, to.z) || isSolid(world, to.x, to.y, to.z)) {
    return 0;
  }

  const fromIndex = index(world, from.x, from.y, from.z);
  const toIndex = index(world, to.x, to.y, to.z);
  const capacity = getCapacity(world, to.x, to.y, to.z);
  const amount = Math.min(world.water[fromIndex], capacity, maxRate);

  if (amount <= EPSILON) {
    return 0;
  }

  world.water[fromIndex] = clampWater(world.water[fromIndex] - amount);
  world.water[toIndex] = clampWater(world.water[toIndex] + amount);

  return amount;
}

function transferLateralWater(
  world: VoxelWorld,
  from: CellCoords,
  to: CellCoords,
  config: WaterSimulationConfig,
): number {
  if (!inBounds(world, to.x, to.y, to.z) || isSolid(world, to.x, to.y, to.z)) {
    return 0;
  }

  const fromIndex = index(world, from.x, from.y, from.z);
  const toIndex = index(world, to.x, to.y, to.z);
  const fromWater = world.water[fromIndex];
  const toWater = world.water[toIndex];
  const levelDifference = fromWater - toWater;

  if (levelDifference <= config.minFlow) {
    return 0;
  }

  const capacity = getCapacity(world, to.x, to.y, to.z);
  const amount = Math.min(levelDifference * 0.5, config.sideFlowRate, fromWater, capacity);

  if (amount <= EPSILON) {
    return 0;
  }

  world.water[fromIndex] = clampWater(fromWater - amount);
  world.water[toIndex] = clampWater(toWater + amount);

  return amount;
}
