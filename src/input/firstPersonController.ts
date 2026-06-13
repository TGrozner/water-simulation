import { PerspectiveCamera, Vector3, WebGLRenderer } from "three";
import { isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";

export type FirstPersonController = {
  enabled: boolean;
  isPointerLocked: () => boolean;
  setEnabled: (enabled: boolean) => void;
  reset: (world: VoxelWorld) => void;
  update: (world: VoxelWorld, deltaSeconds: number) => void;
  dispose: () => void;
};

const WALK_SPEED = 7.2;
const SPRINT_SPEED = 11.5;
const LOOK_SENSITIVITY = 0.0022;
const PLAYER_RADIUS = 0.36;
const PLAYER_HEIGHT = 1.75;
const GRAVITY = 18;
const JUMP_SPEED = 7.4;
const MAX_DELTA_SECONDS = 0.05;
const MAX_PITCH = Math.PI / 2 - 0.05;
const GROUND_CHECK_DISTANCE = 0.08;

const movement = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const nextPosition = new Vector3();
const groundProbePosition = new Vector3();

type MovementPhysics = {
  verticalVelocity: number;
  jumpQueued: boolean;
  grounded: boolean;
};

export function createFirstPersonController(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  initiallyEnabled: boolean,
): FirstPersonController {
  const canvas = renderer.domElement;
  const keys = new Set<string>();
  const reticle = document.createElement("div");
  reticle.className = "fps-reticle";
  document.body.appendChild(reticle);

  let enabled = initiallyEnabled;
  let yaw = 0;
  let pitch = 0;
  const physics: MovementPhysics = {
    verticalVelocity: 0,
    jumpQueued: false,
    grounded: false,
  };

  camera.rotation.order = "YXZ";

  const syncFromCamera = () => {
    yaw = camera.rotation.y;
    pitch = camera.rotation.x;
  };

  const applyRotation = () => {
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  };

  const requestPointerLock = () => {
    if (enabled && document.pointerLockElement !== canvas) {
      void canvas.requestPointerLock();
    }
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!enabled || document.pointerLockElement !== canvas) {
      return;
    }

    yaw -= event.movementX * LOOK_SENSITIVITY;
    pitch -= event.movementY * LOOK_SENSITIVITY;
    pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch));
    applyRotation();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled || isEditableTarget(event.target)) {
      return;
    }

    if (isMovementKey(event.code)) {
      keys.add(event.code);
      event.preventDefault();
      return;
    }

    if (event.code === "Space") {
      physics.jumpQueued = true;
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code);
  };

  canvas.addEventListener("pointerdown", requestPointerLock);
  canvas.addEventListener("click", requestPointerLock);
  document.addEventListener("mousemove", onMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const controller: FirstPersonController = {
    get enabled() {
      return enabled;
    },
    isPointerLocked: () => document.pointerLockElement === canvas,
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled;
      reticle.hidden = !enabled;
      keys.clear();
      physics.jumpQueued = false;
      physics.verticalVelocity = 0;
      if (!enabled && document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
      if (enabled) {
        syncFromCamera();
      }
    },
    reset: (world) => {
      setSpawn(camera, world);
      syncFromCamera();
      applyRotation();
      keys.clear();
      physics.verticalVelocity = 0;
      physics.jumpQueued = false;
      physics.grounded = isGrounded(world, camera.position);
    },
    update: (world, deltaSeconds) => {
      if (!enabled) {
        return;
      }

      updateMovement(world, camera, keys, yaw, Math.min(deltaSeconds, MAX_DELTA_SECONDS), physics);
    },
    dispose: () => {
      canvas.removeEventListener("pointerdown", requestPointerLock);
      canvas.removeEventListener("click", requestPointerLock);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      reticle.remove();
    },
  };

  controller.setEnabled(initiallyEnabled);
  return controller;
}

function setSpawn(camera: PerspectiveCamera, world: VoxelWorld): void {
  const spawnCandidates = [
    { position: new Vector3(-5, 15.4, -4.5), lookAt: new Vector3(9, 15.4, -4.5) },
    { position: new Vector3(4, 15.4, -5), lookAt: new Vector3(10, 15.4, 4) },
    { position: new Vector3(8, 15.4, -2), lookAt: new Vector3(-4, 15.4, -4) },
    { position: new Vector3(0, 14.8, -4), lookAt: new Vector3(7, 14.8, 4) },
    { position: new Vector3(0, 16.2, 3), lookAt: new Vector3(-8, 15.5, 4) },
  ];

  for (const candidate of spawnCandidates) {
    if (canOccupy(candidate.position, world)) {
      camera.position.copy(candidate.position);
      camera.lookAt(candidate.lookAt);
      return;
    }
  }

  camera.position.set(0, 15.2, 0);
  camera.lookAt(-8, 15.5, 4);
}

function updateMovement(
  world: VoxelWorld,
  camera: PerspectiveCamera,
  keys: Set<string>,
  yaw: number,
  deltaSeconds: number,
  physics: MovementPhysics,
): void {
  movement.set(0, 0, 0);
  forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  if (keys.has("KeyW") || keys.has("KeyZ")) {
    movement.add(forward);
  }
  if (keys.has("KeyS")) {
    movement.sub(forward);
  }
  if (keys.has("KeyD")) {
    movement.add(right);
  }
  if (keys.has("KeyA") || keys.has("KeyQ")) {
    movement.sub(right);
  }

  physics.grounded = isGrounded(world, camera.position);
  if (physics.jumpQueued && physics.grounded) {
    physics.verticalVelocity = JUMP_SPEED;
    physics.grounded = false;
  }
  physics.jumpQueued = false;

  if (movement.lengthSq() > 0) {
    movement
      .normalize()
      .multiplyScalar((keys.has("ShiftLeft") || keys.has("ShiftRight") ? SPRINT_SPEED : WALK_SPEED) * deltaSeconds);
    moveAxis(world, camera, movement.x, 0, 0);
    moveAxis(world, camera, 0, 0, movement.z);
  }

  physics.verticalVelocity -= GRAVITY * deltaSeconds;
  const movedY = moveAxis(world, camera, 0, physics.verticalVelocity * deltaSeconds, 0);
  if (!movedY) {
    if (physics.verticalVelocity < 0) {
      physics.grounded = true;
    }
    physics.verticalVelocity = 0;
  }
}

function moveAxis(world: VoxelWorld, camera: PerspectiveCamera, dx: number, dy: number, dz: number): boolean {
  nextPosition.set(camera.position.x + dx, camera.position.y + dy, camera.position.z + dz);
  if (canOccupy(nextPosition, world)) {
    camera.position.copy(nextPosition);
    return true;
  }

  return false;
}

function canOccupy(position: Vector3, world: VoxelWorld): boolean {
  const minX = Math.floor(position.x + world.width / 2 - PLAYER_RADIUS);
  const maxX = Math.floor(position.x + world.width / 2 + PLAYER_RADIUS);
  const minY = Math.floor(position.y - PLAYER_HEIGHT + 0.08);
  const maxY = Math.floor(position.y - 0.12);
  const minZ = Math.floor(position.z + world.depth / 2 - PLAYER_RADIUS);
  const maxZ = Math.floor(position.z + world.depth / 2 + PLAYER_RADIUS);

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (isSolid(world, x, y, z)) {
          return false;
        }
      }
    }
  }

  return true;
}

function isGrounded(world: VoxelWorld, position: Vector3): boolean {
  groundProbePosition.set(position.x, position.y - GROUND_CHECK_DISTANCE, position.z);
  return !canOccupy(groundProbePosition, world);
}

function isMovementKey(code: string): boolean {
  return (
    code === "KeyW" ||
    code === "KeyZ" ||
    code === "KeyA" ||
    code === "KeyQ" ||
    code === "KeyS" ||
    code === "KeyD" ||
    code === "ShiftLeft" ||
    code === "ShiftRight"
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      Boolean(target.closest(".debug-panel")) ||
      Boolean(target.closest(".game-panel")))
  );
}
