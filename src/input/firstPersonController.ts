import { PerspectiveCamera, Vector3 } from "three";
import type { VoxelWorld } from "../world/types";
import {
  canOccupy,
  createFirstPersonMovementPhysics,
  resetFirstPersonMovementPhysics,
  updateFirstPersonMovement,
  type FirstPersonMovementPhysics,
} from "./firstPersonMovement";
export { FIRST_PERSON_MOVEMENT_TEST_HOOKS } from "./firstPersonMovement";

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

const LOOK_SENSITIVITY = 0.0022;
const MAX_DELTA_SECONDS = 0.05;
const MAX_PITCH = Math.PI / 2 - 0.05;

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
  const physics: FirstPersonMovementPhysics = createFirstPersonMovementPhysics(camera.position);

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

    const takingSceneControl = document.pointerLockElement !== canvas && !fallbackAimActive;
    fallbackAimActive = true;
    requestPointerLock(false);
    if (takingSceneControl) {
      event.preventDefault();
      event.stopPropagation();
    }
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
      physics.horizontalVelocity.set(0, 0, 0);
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
    if (!locked && !fallbackAimActive) {
      return;
    }

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
    physics.horizontalVelocity.set(0, 0, 0);
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
      physics.horizontalVelocity.set(0, 0, 0);
      physics.position.copy(camera.position);
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
      resetFirstPersonMovementPhysics(physics, world, camera.position);
      fallbackAimActive = false;
      lastUnlockedMouseX = null;
      lastUnlockedMouseY = null;
    },
    update: (world, deltaSeconds) => {
      if (!enabled) {
        return;
      }

      updateFirstPersonMovement(world, camera, keys, yaw, Math.min(deltaSeconds, MAX_DELTA_SECONDS), physics);
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
