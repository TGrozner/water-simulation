import { MOUSE, PerspectiveCamera, Raycaster, Vector2, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { collectDigCells, digSphere, type DigResult } from "../world/dig";
import type { TerrainRenderer } from "../render/terrainRenderer";
import type { VoxelWorld } from "../world/types";
import { SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";

export type InputState = {
  paused: boolean;
  debugWater: boolean;
  showActiveCells: boolean;
  showFlowDebug: boolean;
  terrainDirty: boolean;
  forceWaterUpdate: boolean;
  sliceEnabled: boolean;
  sliceZ: number;
  digRadius: number;
};

export type InputCallbacks = {
  reset: () => void;
  step: () => void;
  openScene: () => void;
  openAllScene: () => void;
  selectPreset: (preset: ScenePresetId) => void;
  renderOptionsChanged: () => void;
  toggleFirstPerson: () => void;
  isFirstPersonActive: () => boolean;
  toggleDebugUi: () => void;
  allowSandboxShortcuts: () => boolean;
};

export type DigController = {
  update: () => void;
  getPreviewCells: () => number[];
};

const DIG_INTERVAL_MS = 70;
const PREVIEW_INTERVAL_MS = 33;

export function configureOrbitControls(controls: OrbitControls): void {
  controls.mouseButtons.LEFT = null as unknown as MOUSE;
  controls.mouseButtons.MIDDLE = MOUSE.DOLLY;
  controls.mouseButtons.RIGHT = MOUSE.ROTATE;
}

export function bindKeyboardControls(state: InputState, callbacks: InputCallbacks): void {
  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) {
      return;
    }

    if (event.repeat) {
      return;
    }

    if (event.code === "KeyF") {
      callbacks.toggleFirstPerson();
      return;
    }

    if (event.code === "F3" || event.code === "Backquote") {
      event.preventDefault();
      callbacks.toggleDebugUi();
      return;
    }

    if (callbacks.isFirstPersonActive() && isFirstPersonGameplayKey(event)) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      state.paused = !state.paused;
      return;
    }

    if (!callbacks.allowSandboxShortcuts()) {
      if (event.code === "KeyR") {
        callbacks.reset();
      }
      return;
    }

    if (event.code === "KeyD") {
      state.debugWater = !state.debugWater;
      state.forceWaterUpdate = true;
      return;
    }

    if (event.code === "KeyV") {
      state.sliceEnabled = !state.sliceEnabled;
      callbacks.renderOptionsChanged();
      return;
    }

    if (event.code === "BracketLeft") {
      state.sliceZ = Math.max(0, state.sliceZ - 1);
      callbacks.renderOptionsChanged();
      return;
    }

    if (event.code === "BracketRight") {
      state.sliceZ += 1;
      callbacks.renderOptionsChanged();
      return;
    }

    if (event.code === "KeyR") {
      callbacks.reset();
      return;
    }

    if (event.code === "KeyG" && state.paused) {
      callbacks.step();
      return;
    }

    if (event.code === "KeyO") {
      if (event.shiftKey) {
        callbacks.openAllScene();
        return;
      }

      callbacks.openScene();
      return;
    }

    if (event.code.startsWith("Digit")) {
      const presetIndex = Number.parseInt(event.code.replace("Digit", ""), 10) - 1;
      const preset = SCENE_PRESETS[presetIndex];
      if (preset) {
        callbacks.selectPreset(preset);
      }
    }
  });
}

function isFirstPersonGameplayKey(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (
    key === "z" ||
    key === "w" ||
    key === "q" ||
    key === "a" ||
    key === "s" ||
    key === "d" ||
    key === " " ||
    event.code === "Space" ||
    event.code === "ShiftLeft" ||
    event.code === "ShiftRight"
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    Boolean(target.closest(".debug-panel")) ||
    Boolean(target.closest(".game-panel"))
  );
}

export function createDigController(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  worldProvider: () => VoxelWorld,
  terrainProvider: () => TerrainRenderer,
  state: InputState,
  canDig = () => true,
  useCenteredAim = () => false,
  canDigCell: (cellIndex: number) => boolean = () => true,
  onDig: (result: DigResult) => void = () => {},
): DigController {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let isDigging = false;
  let lastPointerEvent: PointerEvent | null = null;
  let lastDigTime = 0;
  let lastPreviewTime = Number.NEGATIVE_INFINITY;
  let lastPreviewRadius = state.digRadius;
  let previewDirty = true;
  let previewCells: number[] = [];
  let hasPointer = false;

  const canvas = renderer.domElement;

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    lastPointerEvent = event;
    hasPointer = true;
    if (!canDig()) {
      return;
    }

    isDigging = true;
    canvas.setPointerCapture(event.pointerId);
    digFromEvent(event);
  });

  canvas.addEventListener("pointermove", (event) => {
    lastPointerEvent = event;
    hasPointer = true;
    previewDirty = true;
  });

  const stopDigging = (event: PointerEvent) => {
    isDigging = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener("pointerup", stopDigging);
  canvas.addEventListener("pointercancel", stopDigging);
  canvas.addEventListener("pointerleave", () => {
    isDigging = false;
    hasPointer = false;
    previewCells = [];
    previewDirty = true;
  });

  function update(): void {
    const now = performance.now();
    if (shouldUpdatePreview(now)) {
      updatePreview();
      lastPreviewTime = now;
      lastPreviewRadius = state.digRadius;
      previewDirty = false;
    }

    if (!isDigging || !lastPointerEvent) {
      return;
    }

    if (now - lastDigTime < DIG_INTERVAL_MS) {
      return;
    }

    digFromEvent(lastPointerEvent);
  }

  function updatePreview(): void {
    if (!hasPointer || !lastPointerEvent) {
      previewCells = [];
      return;
    }

    const hitCell = pickTerrainCell(lastPointerEvent);
    if (hitCell === null) {
      previewCells = [];
      return;
    }

    const world = worldProvider();
    previewCells = collectDigCells(world, hitCell, state.digRadius).filter(
      (cellIndex) => world.solid[cellIndex] === 1 && canDigCell(cellIndex),
    );
  }

  function digFromEvent(event: PointerEvent): void {
    const cellIndex = pickTerrainCell(event);
    if (cellIndex === null) {
      return;
    }

    const world = worldProvider();
    const result = digSphere(world, cellIndex, state.digRadius, canDigCell);
    if (result.removed === 0) {
      return;
    }

    state.terrainDirty = true;
    state.forceWaterUpdate = true;
    previewCells = [];
    previewDirty = true;
    lastDigTime = performance.now();
    onDig(result);
  }

  function shouldUpdatePreview(now: number): boolean {
    if (!hasPointer || !lastPointerEvent) {
      return previewCells.length > 0;
    }

    return previewDirty || state.digRadius !== lastPreviewRadius || now - lastPreviewTime >= PREVIEW_INTERVAL_MS;
  }

  function pickTerrainCell(event: PointerEvent): number | null {
    const rect = canvas.getBoundingClientRect();
    if (document.pointerLockElement === canvas || useCenteredAim()) {
      pointer.set(0, 0);
    } else {
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    }
    raycaster.setFromCamera(pointer, camera);

    return terrainProvider().pickCell(raycaster)?.cellIndex ?? null;
  }

  return {
    update,
    getPreviewCells: () => previewCells,
  };
}
