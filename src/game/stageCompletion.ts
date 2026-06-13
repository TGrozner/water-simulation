export const STAGE_CLEAR_RATIO = 0.72;
export const ROUTE_FLOW_STAGE_COMPLETE_WATER = 1;

export type StageChoiceCompletionInput = {
  autoOpen: boolean;
  initialSolids: number;
  remainingSolids: number;
  routeWater: number;
};

export function getStageClearRatio(initialSolids: number, remainingSolids: number): number {
  if (initialSolids <= 0) {
    return 1;
  }

  return Math.min(1, Math.max(0, 1 - remainingSolids / initialSolids));
}

export function isStageChoiceComplete(input: StageChoiceCompletionInput): boolean {
  if (input.initialSolids <= 0) {
    return input.autoOpen || input.routeWater >= ROUTE_FLOW_STAGE_COMPLETE_WATER;
  }

  const clearRatio = getStageClearRatio(input.initialSolids, input.remainingSolids);
  if (input.autoOpen) {
    return clearRatio >= STAGE_CLEAR_RATIO;
  }

  return clearRatio >= STAGE_CLEAR_RATIO && input.routeWater >= ROUTE_FLOW_STAGE_COMPLETE_WATER;
}
