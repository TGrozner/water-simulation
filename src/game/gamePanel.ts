import { GAME_LEVELS, type LevelProgress } from "./levels";

export type GamePanelActions = {
  resetLevel: () => void;
  nextLevel: () => void;
};

export type GamePanel = {
  update: (progress: LevelProgress | null, levelIndex: number, enabled: boolean) => void;
};

export function createGamePanel(actions: GamePanelActions): GamePanel {
  const panel = document.createElement("section");
  panel.className = "game-panel";
  panel.innerHTML = `
    <div class="game-panel-heading">
      <span data-game-level-count>Level 1/2</span>
      <h2 data-game-title>Level</h2>
      <p data-game-brief></p>
    </div>
    <div class="game-panel-progress">
      <div class="game-panel-progress-row">
        <span data-game-stage-label>Weak rock</span>
        <strong data-game-stage-percent>0%</strong>
      </div>
      <div class="game-panel-bar"><span data-game-stage-bar></span></div>
    </div>
    <dl class="game-panel-metrics">
      <dt>Delivered</dt><dd data-game-metric="delivered">0</dd>
      <dt>Wasted</dt><dd data-game-metric="wasted">0</dd>
      <dt data-game-route-label>Route</dt><dd data-game-metric="route">unselected</dd>
      <dt data-game-risk-label>Risk</dt><dd data-game-metric="risk">none</dd>
      <dt>Flow</dt><dd data-game-metric="settled">moving</dd>
    </dl>
    <div class="game-panel-status" data-game-status>In progress</div>
    <div class="game-panel-actions">
      <button type="button" data-game-action="reset">Reset level</button>
      <button type="button" data-game-action="next">Next level</button>
    </div>
  `;

  panel.querySelector<HTMLButtonElement>('[data-game-action="reset"]')?.addEventListener("click", actions.resetLevel);
  panel.querySelector<HTMLButtonElement>('[data-game-action="next"]')?.addEventListener("click", actions.nextLevel);
  document.body.appendChild(panel);

  return {
    update: (progress, levelIndex, enabled) => updateGamePanel(panel, progress, levelIndex, enabled),
  };
}

function updateGamePanel(
  panel: HTMLElement,
  progress: LevelProgress | null,
  levelIndex: number,
  enabled: boolean,
): void {
  panel.hidden = !enabled || progress === null;
  if (!enabled || progress === null) {
    return;
  }

  const stagePercent = Math.round(progress.stageProgress.activeStageProgress * 100);
  const resetButton = panel.querySelector<HTMLButtonElement>('[data-game-action="reset"]');
  const nextButton = panel.querySelector<HTMLButtonElement>('[data-game-action="next"]');
  const stageBar = panel.querySelector<HTMLElement>("[data-game-stage-bar]");
  const routeLabel = panel.querySelector<HTMLElement>("[data-game-route-label]");
  const routeValue = panel.querySelector<HTMLElement>('[data-game-metric="route"]');
  const riskLabel = panel.querySelector<HTMLElement>("[data-game-risk-label]");
  const riskValue = panel.querySelector<HTMLElement>('[data-game-metric="risk"]');
  const hasRouteChoice = progress.stageProgress.selectedChoiceLabel !== null;
  const hasHazards = progress.level.hazardStages.length > 0;

  setText(panel, "[data-game-level-count]", `Level ${levelIndex + 1}/${GAME_LEVELS.length}`);
  setText(panel, "[data-game-title]", progress.level.name);
  setText(panel, "[data-game-brief]", progress.level.brief);
  setText(
    panel,
    "[data-game-stage-label]",
    progress.stageProgress.completedStages >= progress.stageProgress.stageCount
      ? "All weak gates open"
      : progress.stageProgress.activeStageLabel,
  );
  setText(panel, "[data-game-stage-percent]", `${stagePercent}%`);
  setText(
    panel,
    '[data-game-metric="delivered"]',
    `${progress.deliveredWater.toFixed(0)} / ${progress.level.deliveryTargetWater.toFixed(0)}`,
  );
  setText(
    panel,
    '[data-game-metric="wasted"]',
    `${progress.wastedWater.toFixed(0)} / ${progress.level.maxWastedWater.toFixed(0)}`,
  );
  setText(panel, '[data-game-metric="route"]', progress.stageProgress.selectedChoiceLabel ?? "unselected");
  setText(panel, '[data-game-metric="risk"]', hasHazards ? `avoid ${progress.level.hazardStages.length} red seams` : "none");
  setText(panel, '[data-game-metric="settled"]', progress.settled ? "settled" : "moving");
  setText(panel, "[data-game-status]", progress.status);

  if (routeLabel && routeValue) {
    routeLabel.hidden = !hasRouteChoice;
    routeValue.hidden = !hasRouteChoice;
  }

  if (riskLabel && riskValue) {
    riskLabel.hidden = !hasHazards;
    riskValue.hidden = !hasHazards;
  }

  if (stageBar) {
    stageBar.style.width = `${stagePercent}%`;
  }

  panel.dataset.complete = String(progress.complete);
  panel.dataset.failed = String(progress.failed);
  panel.dataset.risk = hasHazards ? "hazard" : "none";

  if (resetButton) {
    resetButton.textContent = progress.failed ? "Retry level" : "Reset level";
  }

  if (nextButton) {
    nextButton.disabled = !progress.complete;
    nextButton.textContent = levelIndex >= GAME_LEVELS.length - 1 ? "Restart slice" : "Next level";
  }
}

function setText(parent: HTMLElement, selector: string, value: string): void {
  const element = parent.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}
