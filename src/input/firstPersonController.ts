import { PerspectiveCamera, Vector3 } from "three";
import { isSolid } from "../world/grid";
import type { VoxelWorld } from "../world/types";

export type SpawnPose = {
  position: Vector3;
  lookAt: Vector3;
};

export type FirstPersonController = {
  enabled: boolean;
  isPointerLocked: () => boolean;
  hasSceneAim: () => boolean;
  requestPointerLock: () => void;
  setEnabled: (enabled: boolean) => void;
  reset: (world: VoxelWorld, spawnPose?: SpawnPose) => void;
  update: (world: VoxelWorld, deltaSeconds: number) => void;
  dispose: () => void;
};

const WALK_SPEED = 7.2;
const SPRINT_SPEED = 11.5;
const LOOK_SENSITIVITY = 0.0022;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.75;
const GRAVITY = 18;
const JUMP_SPEED = 7.4;
const MAX_DELTA_SECONDS = 0.05;
const MAX_PITCH = Math.PI / 2 - 0.05;
const GROUND_CHECK_DISTANCE = 0.08;
const COLLISION_EPSILON = 0.001;
const HORIZONTAL_MOVE_SUBSTEP_DISTANCE = 0.14;
const STEP_UP_HEIGHT = 1.05;
const STEP_UP_INCREMENT = 0.12;
const STEP_DOWN_DISTANCE = 1.15;
const STEP_DOWN_INCREMENT = 0.08;

const movement = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const nextPosition = new Vector3();
const stepCandidatePosition = new Vector3();
const groundProbePosition = new Vector3();

type MovableBody = {
  position: Vector3;
};

type MovementPhysics = {
  verticalVelocity: number;
  jumpQueued: boolean;
  grounded: boolean;
};

type CanvasRenderer = {
  domElement: HTMLCanvasElement;
};

export function createFirstPersonController(
  renderer: CanvasRenderer,
  camera: PerspectiveCamera,
  initiallyEnabled: boolean,
): FirstPersonController {
  const canvas = renderer.domElement;
  const keys = new Set<string>();
  const reticle = document.createElement("div");
  reticle.className = "fps-reticle";
  document.body.appendChild(reticle);
  canvas.tabIndex = 0;

  let enabled = initiallyEnabled;
  let yaw = 0;
  let pitch = 0;
  let lockRequestPending = false;
  let fallbackAimActive = false;
  let lastUnlockedMouseX: number | null = null;
  let lastUnlockedMouseY: number | null = null;
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

  const requestPointerLock = (armFallbackAim = true) => {
    if (!enabled) {
      return;
    }

    if (armFallbackAim) {
      fallbackAimActive = true;
    }
    if (document.pointerLockElement === canvas || lockRequestPending) {
      return;
    }

    lockRequestPending = true;
    canvas.focus({ preventScroll: true });

    try {
      const result = canvas.requestPointerLock();
      void Promise.resolve(result)
        .catch(() => {
          lockRequestPending = false;
        })
        .finally(() => {
          if (document.pointerLockElement !== canvas) {
            lockRequestPending = false;
          }
        });
    } catch {
      lockRequestPending = false;
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || shouldIgnorePointerLockTarget(event.target)) {
      return;
    }

    fallbackAimActive = true;
    requestPointerLock(false);
  };

  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || shouldIgnorePointerLockTarget(event.target)) {
      return;
    }

    requestPointerLock();
  };

  const onPointerLockChange = () => {
    lockRequestPending = false;
    lastUnlockedMouseX = null;
    lastUnlockedMouseY = null;
    if (document.pointerLockElement === canvas) {
      fallbackAimActive = true;
      syncFromCamera();
    } else {
      fallbackAimActive = false;
      keys.clear();
      physics.jumpQueued = false;
    }
  };

  const onPointerLockError = () => {
    lockRequestPending = false;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!enabled) {
      return;
    }

    const locked = document.pointerLockElement === canvas;
    const mouseDelta = locked ? getLockedMouseDelta(event) : getUnlockedMouseDelta(event, canvas);
    if (!mouseDelta) {
      return;
    }

    yaw -= mouseDelta.x * LOOK_SENSITIVITY;
    pitch -= mouseDelta.y * LOOK_SENSITIVITY;
    pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch));
    applyRotation();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled || isEditableTarget(event.target)) {
      return;
    }

    const movementKey = getMovementKey(event);
    if (movementKey) {
      requestPointerLock();
      keys.add(movementKey);
      event.preventDefault();
      return;
    }

    if (event.code === "Space") {
      requestPointerLock();
      physics.jumpQueued = true;
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const movementKey = getMovementKey(event);
    if (movementKey) {
      keys.delete(movementKey);
    }
  };

  const onWindowBlur = () => {
    keys.clear();
    physics.jumpQueued = false;
  };

  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("click", onClick, { capture: true });
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("pointerlockerror", onPointerLockError);
  document.addEventListener("mousemove", onMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onWindowBlur);

  const controller: FirstPersonController = {
    get enabled() {
      return enabled;
    },
    isPointerLocked: () => document.pointerLockElement === canvas,
    hasSceneAim: () => enabled && (document.pointerLockElement === canvas || fallbackAimActive),
    requestPointerLock,
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled;
      reticle.hidden = !enabled;
      keys.clear();
      physics.jumpQueued = false;
      physics.verticalVelocity = 0;
      lockRequestPending = false;
      fallbackAimActive = false;
      lastUnlockedMouseX = null;
      lastUnlockedMouseY = null;
      if (!enabled && document.pointerLockElement === canvas) {
        document.exitPointerLock();
      }
      if (enabled) {
        syncFromCamera();
      }
    },
    reset: (world, spawnPose) => {
      setSpawn(camera, world, spawnPose);
      syncFromCamera();
      applyRotation();
      keys.clear();
      physics.verticalVelocity = 0;
      physics.jumpQueued = false;
      physics.grounded = isGrounded(world, camera.position);
      fallbackAimActive = false;
      lastUnlockedMouseX = null;
      lastUnlockedMouseY = null;
    },
    update: (world, deltaSeconds) => {
      if (!enabled) {
        return;
      }

      updateMovement(world, camera, keys, yaw, Math.min(deltaSeconds, MAX_DELTA_SECONDS), physics);
    },
    dispose: () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      reticle.remove();
    },
  };

  controller.setEnabled(initiallyEnabled);
  return controller;

  function getUnlockedMouseDelta(event: MouseEvent, targetCanvas: HTMLCanvasElement): { x: number; y: number } | null {
    if (!isSceneMouseEvent(event, targetCanvas)) {
      lastUnlockedMouseX = null;
      lastUnlockedMouseY = null;
      return null;
    }

    const previousX = lastUnlockedMouseX;
    const previousY = lastUnlockedMouseY;
    lastUnlockedMouseX = event.clientX;
    lastUnlockedMouseY = event.clientY;
    if (previousX === null || previousY === null) {
      return null;
    }

    return {
      x: event.clientX - previousX,
      y: event.clientY - previousY,
    };
  }
}

function getLockedMouseDelta(event: MouseEvent): { x: number; y: number } | null {
  return { x: event.movementX, y: event.movementY };
}

function isSceneMouseEvent(event: MouseEvent, canvas: HTMLCanvasElement): boolean {
  if (shouldIgnorePointerLockTarget(event.target)) {
    return false;
  }

  return event.target === canvas || event.composedPath().includes(canvas);
}

function setSpawn(camera: PerspectiveCamera, world: VoxelWorld, spawnPose?: SpawnPose): void {
  if (spawnPose && canOccupy(spawnPose.position, world)) {
    camera.position.copy(spawnPose.position);
    camera.lookAt(spawnPose.lookAt);
    return;
  }

  const spawnCandidates = [
    { position: new Vector3(-16.5, 26.75, 3.5), lookAt: new Vector3(-2, 17, 2) },
    { position: new Vector3(-14.5, 26.75, 3.5), lookAt: new Vector3(-2, 17, 2) },
    { position: new Vector3(-11.5, 26.75, 3.5), lookAt: new Vector3(-8, 19, 3) },
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

function shouldIgnorePointerLockTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (Boolean(target.closest(".debug-panel")) ||
      Boolean(target.closest(".game-panel")) ||
      Boolean(target.closest(".sonar-panel")) ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement)
  );
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

  physics.grounded = isGrounded(world, camera.position);
  const jumpedThisFrame = physics.jumpQueued && physics.grounded;
  if (jumpedThisFrame) {
    physics.verticalVelocity = JUMP_SPEED;
    physics.grounded = false;
  }
  physics.jumpQueued = false;

  if (movement.lengthSq() > 0) {
    movement
      .normalize()
      .multiplyScalar((keys.has("sprint") ? SPRINT_SPEED : WALK_SPEED) * deltaSeconds);
    moveHorizontally(world, camera, movement.x, movement.z, physics.grounded && !jumpedThisFrame);
  }

  if (physics.grounded && !jumpedThisFrame && snapDownToGround(world, camera, STEP_DOWN_DISTANCE)) {
    physics.verticalVelocity = 0;
    return;
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

function canOccupy(position: Vector3, world: VoxelWorld): boolean {
  const minX = Math.floor(position.x + world.width / 2 - PLAYER_RADIUS + COLLISION_EPSILON);
  const maxX = Math.floor(position.x + world.width / 2 + PLAYER_RADIUS - COLLISION_EPSILON);
  const minY = Math.floor(position.y - PLAYER_HEIGHT + 0.08 + COLLISION_EPSILON);
  const maxY = Math.floor(position.y - 0.12 - COLLISION_EPSILON);
  const minZ = Math.floor(position.z + world.depth / 2 - PLAYER_RADIUS + COLLISION_EPSILON);
  const maxZ = Math.floor(position.z + world.depth / 2 + PLAYER_RADIUS - COLLISION_EPSILON);

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
  moveHorizontally,
  snapDownToGround,
};

function getMovementKey(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (key === "z" || key === "w") {
    return "forward";
  }
  if (key === "s") {
    return "back";
  }
  if (key === "q" || key === "a") {
    return "left";
  }
  if (key === "d") {
    return "right";
  }
  if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
    return "sprint";
  }

  return null;
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
