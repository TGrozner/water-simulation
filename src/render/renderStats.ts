export type RendererStats = {
  instances: number;
  updateMs: number;
  capacity: number;
};

export function createRendererStats(capacity: number): RendererStats {
  return {
    instances: 0,
    updateMs: 0,
    capacity,
  };
}
