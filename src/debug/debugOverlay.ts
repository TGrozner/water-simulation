import type { InspectedCell } from "../input/cellInspector";

export type DebugOverlayStats = {
  presetName: string;
  paused: boolean;
  debugWater: boolean;
  sliceEnabled: boolean;
  sliceZ: number;
  activeCells: number;
  totalWater: number;
  baselineWater: number;
  volumeDelta: number;
  volumeWarning: boolean;
  fps: number;
  movedVolume: number;
  inspectedCell: InspectedCell;
  tickCount: number;
  stableTicks: number;
  stable: boolean;
};

export function createDebugOverlay(): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "debug-overlay";
  document.body.appendChild(overlay);
  return overlay;
}

export function updateDebugOverlay(overlay: HTMLElement, stats: DebugOverlayStats): void {
  overlay.innerHTML = `
    <h1>Voxel Water Prototype</h1>
    <dl>
      <dt>Scene</dt><dd>${stats.presetName}</dd>
      <dt>Simulation</dt><dd>${stats.paused ? "paused" : "running"}</dd>
      <dt>Water debug</dt><dd>${stats.debugWater ? "on" : "off"}</dd>
      <dt>Slice</dt><dd>${stats.sliceEnabled ? `z ${stats.sliceZ}` : "off"}</dd>
      <dt>Active cells</dt><dd>${stats.activeCells}</dd>
      <dt>Total water</dt><dd>${stats.totalWater.toFixed(2)}</dd>
      <dt>Baseline</dt><dd>${stats.baselineWater.toFixed(2)}</dd>
      <dt>Water delta</dt><dd class="${stats.volumeWarning ? "warning" : ""}">${formatDelta(stats.volumeDelta)}</dd>
      <dt>Moved last frame</dt><dd>${stats.movedVolume.toFixed(3)}</dd>
      <dt>Cell</dt><dd>${formatCell(stats.inspectedCell)}</dd>
      <dt>Ticks</dt><dd>${stats.tickCount}</dd>
      <dt>Status</dt><dd>${stats.stable ? `stable ${stats.stableTicks}` : "moving"}</dd>
      <dt>FPS</dt><dd>${Math.round(stats.fps)}</dd>
    </dl>
    <div class="controls">
      Left mouse dig<br />
      Right mouse orbit, wheel zoom<br />
      1-7 scenes, V slice, [ ] move slice<br />
      Space pause, G step, D water debug, R reset
    </div>
  `;
}

function formatCell(cell: InspectedCell): string {
  if (!cell) {
    return "none";
  }

  return `${cell.coords.x},${cell.coords.y},${cell.coords.z} ${cell.solid ? "solid" : "open"} w=${cell.water.toFixed(
    3,
  )} ${cell.active ? "active" : "sleep"} ${cell.source}`;
}

function formatDelta(delta: number): string {
  if (Math.abs(delta) < 0.0005) {
    return "0.000";
  }

  return `${delta > 0 ? "+" : ""}${delta.toFixed(3)}`;
}
