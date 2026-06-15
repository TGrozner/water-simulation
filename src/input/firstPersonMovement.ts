import { PerspectiveCamera, Vector3 } from "three";
import { isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";

const WALK_SPEED = 7.2;
const SPRINT_SPEED = 11.5;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.75;
const GRAVITY = 18;
const JUMP_SPEED = 7.4;
const GROUND_CHECK_DISTANCE = 0.08;
const COLLISION_EPSILON = 0.001;
const HORIZONTAL_MOVE_SUBSTEP_DISTANCE = 0.14;
const STEP_UP_HEIGHT = 1.05;
const STEP_UP_INCREMENT = 0.08;
const STEP_DOWN_DISTANCE = 1.15;
const STEP_DOWN_INCREMENT = 0.06;
const CAMERA_GROUND_RISE_SPEED = 6.5;
const CAMERA_GROUND_DROP_SPEED = 9;
const GROUND_ACCELERATION = 20;
const GROUND_DECELERATION = 26;
const AIR_ACCELERATION = 4.5;
const AIR_DECELERATION = 1.8;
const MIN_HORIZONTAL_SPEED = 0.03;

const movement = new Vector3();
const targetVelocity = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const nextPosition = new Vector3();
const stepCandidatePosition = new Vector3();
const groundProbePosition = new Vector3();

type MovableBody = {
  position: Vector3;
};

export type FirstPersonMovementPhysics = {
  position: Vector3;
  verticalVelocity: number;
  horizontalVelocity: Vector3;
  jumpQueued: boolean;
  grounded: boolean;
};

export function createFirstPersonMovementPhysics(position: Vector3): FirstPersonMovementPhysics {
  return {
    position: position.clone(),
    verticalVelocity: 0,
    horizontalVelocity: new Vector3(),
    jumpQueued: false,
    grounded: false,
  };
}

export function resetFirstPersonMovementPhysics(
  physics: FirstPersonMovementPhysics,
  world: VoxelWorld,
  position: Vector3,
): void {
  physics.position.copy(position);
  physics.verticalVelocity = 0;
  physics.horizontalVelocity.set(0, 0, 0);
  physics.jumpQueued = false;
  physics.grounded = isGrounded(world, physics.position);
}

export function updateFirstPersonMovement(
  world: VoxelWorld,
  camera: PerspectiveCamera,
  keys: Set<string>,
  yaw: number,
  deltaSeconds: number,
  physics: FirstPersonMovementPhysics,
): void {
  movement.set(0, 0, 0);
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  if (keys.has("forward")) {
    movement.add(forward);
  }
  if (keys.has("back")) {
    movement.sub(forward);
  }
  if (keys.has("right")) {
    movement.add(right);
  }
  if (keys.has("left")) {
    movement.sub(right);
  }

  physics.grounded = isGrounded(world, physics.position);
  const jumpedThisFrame = physics.jumpQueued && physics.grounded;
  if (jumpedThisFrame) {
    physics.verticalVelocity = JUMP_SPEED;
    physics.grounded = false;
  }
  physics.jumpQueued = false;

  const targetSpeed = keys.has("sprint") ? SPRINT_SPEED : WALK_SPEED;
  const hasMovementInput = movement.lengthSq() > 0;
  if (hasMovementInput) {
    movement.normalize();
    targetVelocity.set(movement.x * targetSpeed, 0, movement.z * targetSpeed);
  } else {
    targetVelocity.set(0, 0, 0);
  }
  const acceleration = getHorizontalAcceleration(hasMovementInput, physics.grounded);
  moveVectorToward(physics.horizontalVelocity, targetVelocity, acceleration * deltaSeconds);

  if (physics.horizontalVelocity.lengthSq() > MIN_HORIZONTAL_SPEED * MIN_HORIZONTAL_SPEED) {
    movement.set(physics.horizontalVelocity.x * deltaSeconds, 0, physics.horizontalVelocity.z * deltaSeconds);
    const movedX = movement.x;
    const movedZ = movement.z;
    const beforeX = physics.position.x;
    const beforeZ = physics.position.z;
    moveHorizontally(world, physics, movedX, movedZ, physics.grounded && !jumpedThisFrame);
    dampBlockedHorizontalVelocity(
      physics.horizontalVelocity,
      physics.position.x - beforeX,
      physics.position.z - beforeZ,
      movedX,
      movedZ,
      deltaSeconds,
    );
  }

  if (physics.grounded && !jumpedThisFrame && physics.verticalVelocity <= 0 && snapDownToGround(world, physics, STEP_DOWN_DISTANCE)) {
    physics.verticalVelocity = 0;
    syncCameraToPhysics(camera, physics, deltaSeconds);
    return;
  }

  physics.verticalVelocity -= GRAVITY * deltaSeconds;
  const movedY = moveAxis(world, physics, 0, physics.verticalVelocity * deltaSeconds, 0);
  if (!movedY) {
    if (physics.verticalVelocity < 0) {
      physics.grounded = true;
    }
    physics.verticalVelocity = 0;
  }
  syncCameraToPhysics(camera, physics, deltaSeconds);
}

function getHorizontalAcceleration(hasMovementInput: boolean, grounded: boolean): number {
  if (hasMovementInput) {
    return grounded ? GROUND_ACCELERATION : AIR_ACCELERATION;
  }

  return grounded ? GROUND_DECELERATION : AIR_DECELERATION;
}

function moveVectorToward(current: Vector3, target: Vector3, maxDelta: number): void {
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxDelta || distance <= MIN_HORIZONTAL_SPEED) {
    current.copy(target);
    return;
  }

  const scale = maxDelta / distance;
  current.x += dx * scale;
  current.z += dz * scale;
}

function dampBlockedHorizontalVelocity(
  velocity: Vector3,
  actualDx: number,
  actualDz: number,
  requestedDx: number,
  requestedDz: number,
  deltaSeconds: number,
): void {
  if (deltaSeconds <= 0) {
    return;
  }

  velocity.x = dampBlockedVelocityAxis(velocity.x, actualDx, requestedDx, deltaSeconds);
  velocity.z = dampBlockedVelocityAxis(velocity.z, actualDz, requestedDz, deltaSeconds);
}

function dampBlockedVelocityAxis(velocity: number, actualDelta: number, requestedDelta: number, deltaSeconds: number): number {
  if (Math.abs(requestedDelta) <= COLLISION_EPSILON) {
    return velocity;
  }

  const actualSpeed = actualDelta / deltaSeconds;
  if (Math.abs(actualDelta) >= Math.abs(requestedDelta) * 0.65) {
    return actualSpeed;
  }

  if (Math.sign(actualDelta) === Math.sign(requestedDelta) && Math.abs(actualDelta) > COLLISION_EPSILON) {
    return actualSpeed * 0.35;
  }

  return 0;
}

function syncCameraToPhysics(camera: PerspectiveCamera, physics: FirstPersonMovementPhysics, deltaSeconds: number): void {
  camera.position.x = physics.position.x;
  camera.position.z = physics.position.z;

  if (!physics.grounded) {
    camera.position.y = physics.position.y;
    return;
  }

  const speed = physics.position.y >= camera.position.y ? CAMERA_GROUND_RISE_SPEED : CAMERA_GROUND_DROP_SPEED;
  camera.position.y = moveNumberToward(camera.position.y, physics.position.y, speed * deltaSeconds);
}

function moveNumberToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) {
    return target;
  }

  return current + Math.sign(delta) * maxDelta;
}

function moveHorizontally(world: VoxelWorld, body: MovableBody, dx: number, dz: number, allowStep: boolean): boolean {
  const distance = Math.hypot(dx, dz);
  if (distance <= 0) {
    return false;
  }

  const steps = Math.max(1, Math.ceil(distance / HORIZONTAL_MOVE_SUBSTEP_DISTANCE));
  const stepX = dx / steps;
  const stepZ = dz / steps;
  let moved = false;

  for (let step = 0; step < steps; step += 1) {
    moved = moveHorizontalStep(world, body, stepX, stepZ, allowStep) || moved;
  }

  return moved;
}

function moveHorizontalStep(world: VoxelWorld, body: MovableBody, dx: number, dz: number, allowStep: boolean): boolean {
  if (tryMoveHorizontal(world, body, dx, dz, allowStep)) {
    return true;
  }

  const firstDx = Math.abs(dx) >= Math.abs(dz);
  if (firstDx) {
    return tryMoveHorizontal(world, body, dx, 0, allowStep) || tryMoveHorizontal(world, body, 0, dz, allowStep);
  }

  return tryMoveHorizontal(world, body, 0, dz, allowStep) || tryMoveHorizontal(world, body, dx, 0, allowStep);
}

function tryMoveHorizontal(world: VoxelWorld, body: MovableBody, dx: number, dz: number, allowStep: boolean): boolean {
  if (dx === 0 && dz === 0) {
    return false;
  }

  nextPosition.set(body.position.x + dx, body.position.y, body.position.z + dz);
  if (canOccupy(nextPosition, world)) {
    body.position.copy(nextPosition);
    return true;
  }

  if (!allowStep) {
    return false;
  }

  return tryStepUp(world, body, dx, dz);
}

function tryStepUp(world: VoxelWorld, body: MovableBody, dx: number, dz: number): boolean {
  const startX = body.position.x;
  const startY = body.position.y;
  const startZ = body.position.z;

  for (let stepHeight = STEP_UP_INCREMENT; stepHeight <= STEP_UP_HEIGHT + COLLISION_EPSILON; stepHeight += STEP_UP_INCREMENT) {
    stepCandidatePosition.set(startX, startY + stepHeight, startZ);
    if (!canOccupy(stepCandidatePosition, world)) {
      continue;
    }

    nextPosition.set(startX + dx, startY + stepHeight, startZ + dz);
    if (!canOccupy(nextPosition, world)) {
      continue;
    }

    body.position.copy(nextPosition);
    snapDownToGround(world, body, stepHeight + STEP_DOWN_DISTANCE);
    return true;
  }

  return false;
}

function moveAxis(world: VoxelWorld, body: MovableBody, dx: number, dy: number, dz: number): boolean {
  nextPosition.set(body.position.x + dx, body.position.y + dy, body.position.z + dz);
  if (canOccupy(nextPosition, world)) {
    body.position.copy(nextPosition);
    return true;
  }

  return false;
}

export function canOccupy(position: Vector3, world: VoxelWorld): boolean {
  const centerX = position.x + world.width / 2;
  const centerZ = position.z + world.depth / 2;
  const minX = Math.floor(centerX - PLAYER_RADIUS + COLLISION_EPSILON);
  const maxX = Math.floor(centerX + PLAYER_RADIUS - COLLISION_EPSILON);
  const minY = Math.floor(position.y - PLAYER_HEIGHT + 0.08 + COLLISION_EPSILON);
  const maxY = Math.floor(position.y - 0.12 - COLLISION_EPSILON);
  const minZ = Math.floor(centerZ - PLAYER_RADIUS + COLLISION_EPSILON);
  const maxZ = Math.floor(centerZ + PLAYER_RADIUS - COLLISION_EPSILON);

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (cellOverlapsPlayerRadius(centerX, centerZ, x, z) && isSolid(world, x, y, z)) {
          return false;
        }
      }
    }
  }

  return true;
}

function cellOverlapsPlayerRadius(centerX: number, centerZ: number, cellX: number, cellZ: number): boolean {
  const closestX = Math.min(cellX + 1, Math.max(cellX, centerX));
  const closestZ = Math.min(cellZ + 1, Math.max(cellZ, centerZ));
  const dx = centerX - closestX;
  const dz = centerZ - closestZ;
  return dx * dx + dz * dz <= PLAYER_RADIUS * PLAYER_RADIUS;
}

function isGrounded(world: VoxelWorld, position: Vector3): boolean {
  groundProbePosition.set(position.x, position.y - GROUND_CHECK_DISTANCE, position.z);
  return !canOccupy(groundProbePosition, world);
}

function snapDownToGround(world: VoxelWorld, body: MovableBody, maxDistance: number): boolean {
  if (isGrounded(world, body.position)) {
    return true;
  }

  const originalY = body.position.y;
  let lastValidY = originalY;

  for (let drop = STEP_DOWN_INCREMENT; drop <= maxDistance + COLLISION_EPSILON; drop += STEP_DOWN_INCREMENT) {
    nextPosition.set(body.position.x, originalY - drop, body.position.z);
    if (canOccupy(nextPosition, world)) {
      lastValidY = nextPosition.y;
      continue;
    }

    if (lastValidY !== originalY) {
      body.position.y = lastValidY;
      return true;
    }

    return false;
  }

  return false;
}

export const FIRST_PERSON_MOVEMENT_TEST_HOOKS = {
  canOccupy,
  dampBlockedVelocityAxis,
  moveHorizontally,
  moveVectorToward,
  snapDownToGround,
  updateMovement: updateFirstPersonMovement,
};
