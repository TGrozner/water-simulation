export type RendererStats = {
  instances: number;
  updateMs: number;
  capacity: number;
  rebuilds: number;
};

export function createRendererStats(capacity: number): RendererStats {
  return {
    instances: 0,
    updateMs: 0,
    capacity,
    rebuilds: 0,
  };
}
