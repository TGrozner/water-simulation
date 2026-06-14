import { getBestScore, type BestScoresByLevel } from "./bestScoreStorage";
import { GAME_LEVELS, type LevelProgress, type LevelScore } from "./levels";

export type GamePanelActions = {
  resetLevel: () => void;
  nextLevel: () => void;
  selectLevel: (levelIndex: number) => void;
};

export type LevelSelectRow = {
  levelIndex: number;
  levelId: string;
  name: string;
  bestLabel: string;
  selected: boolean;
};

export type GamePanel = {
  update: (
    progress: LevelProgress | null,
    levelIndex: number,
    enabled: boolean,
    bestScore: LevelScore | null,
    bestScores: BestScoresByLevel,
    scoreIsNewBest: boolean,
  ) => void;
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
    <div class="game-panel-level-select">
      ${GAME_LEVELS.map(
        (level, index) => `
          <button type="button" data-game-level-option="${index}">
            <span>${level.name}</span>
            <strong data-game-level-best="${level.id}">No best</strong>
          </button>
        `,
      ).join("")}
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
      <dt data-game-targets-label>Targets</dt><dd data-game-metric="targets">0/0</dd>
      <dt>Wasted</dt><dd data-game-metric="wasted">0</dd>
      <dt data-game-route-label>Route</dt><dd data-game-metric="route">unselected</dd>
      <dt data-game-path-water-label>Path water</dt><dd data-game-metric="pathWater">0</dd>
      <dt data-game-mode-label>Mode</dt><dd data-game-metric="mode">gate</dd>
      <dt data-game-risk-label>Risk</dt><dd data-game-metric="risk">none</dd>
      <dt>Flow</dt><dd data-game-metric="settled">moving</dd>
      <dt data-game-score-label>Score</dt><dd data-game-metric="score">-</dd>
      <dt data-game-best-label>Best</dt><dd data-game-metric="best">-</dd>
    </dl>
    <div class="game-panel-status" data-game-status>In progress</div>
    <div class="game-panel-actions">
      <button type="button" data-game-action="reset">Reset level</button>
      <button type="button" data-game-action="next">Next level</button>
    </div>
  `;

  panel.querySelector<HTMLButtonElement>('[data-game-action="reset"]')?.addEventListener("click", actions.resetLevel);
  panel.querySelector<HTMLButtonElement>('[data-game-action="next"]')?.addEventListener("click", actions.nextLevel);
  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-game-level-option]")) {
    button.addEventListener("click", () => {
      const levelIndex = Number.parseInt(button.dataset.gameLevelOption ?? "", 10);
      if (Number.isFinite(levelIndex)) {
        actions.selectLevel(levelIndex);
      }
    });
  }
  document.body.appendChild(panel);

  return {
    update: (progress, levelIndex, enabled, bestScore, bestScores, scoreIsNewBest) =>
      updateGamePanel(panel, progress, levelIndex, enabled, bestScore, bestScores, scoreIsNewBest),
  };
}

function updateGamePanel(
  panel: HTMLElement,
  progress: LevelProgress | null,
  levelIndex: number,
  enabled: boolean,
  bestScore: LevelScore | null,
  bestScores: BestScoresByLevel,
  scoreIsNewBest: boolean,
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
  const pathWaterLabel = panel.querySelector<HTMLElement>("[data-game-path-water-label]");
  const pathWaterValue = panel.querySelector<HTMLElement>('[data-game-metric="pathWater"]');
  const targetsLabel = panel.querySelector<HTMLElement>("[data-game-targets-label]");
  const targetsValue = panel.querySelector<HTMLElement>('[data-game-metric="targets"]');
  const modeLabel = panel.querySelector<HTMLElement>("[data-game-mode-label]");
  const modeValue = panel.querySelector<HTMLElement>('[data-game-metric="mode"]');
  const riskLabel = panel.querySelector<HTMLElement>("[data-game-risk-label]");
  const riskValue = panel.querySelector<HTMLElement>('[data-game-metric="risk"]');
  const scoreLabel = panel.querySelector<HTMLElement>("[data-game-score-label]");
  const scoreValue = panel.querySelector<HTMLElement>('[data-game-metric="score"]');
  const bestLabel = panel.querySelector<HTMLElement>("[data-game-best-label]");
  const bestValue = panel.querySelector<HTMLElement>('[data-game-metric="best"]');
  const hasRouteChoice = progress.stageProgress.selectedChoiceLabel !== null;
  const hasDeliveryTargets = progress.deliveryRequirements.length > 0;
  const hasScore = progress.score !== null;
  const hasBestScore = bestScore !== null;
  const isManualStage = progress.stageProgress.activeStageIsManual;
  const hasHazards = progress.level.hazardStages.length > 0;

  setText(panel, "[data-game-level-count]", `Level ${levelIndex + 1}/${GAME_LEVELS.length}`);
  setText(panel, "[data-game-title]", progress.level.name);
  setText(panel, "[data-game-brief]", progress.level.brief);
  updateLevelSelect(panel, levelIndex, bestScores);
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
  setText(panel, '[data-game-metric="targets"]', formatDeliveryTargets(progress));
  setText(
    panel,
    '[data-game-metric="wasted"]',
    `${progress.wastedWater.toFixed(0)} / ${progress.level.maxWastedWater.toFixed(0)}`,
  );
  setText(panel, '[data-game-metric="route"]', progress.stageProgress.selectedChoiceLabel ?? "unselected");
  setText(panel, '[data-game-metric="pathWater"]', formatWater(progress.stageProgress.selectedRouteWater));
  setText(panel, '[data-game-metric="mode"]', isManualStage ? "manual carve" : "authored gate");
  setText(panel, '[data-game-metric="risk"]', hasHazards ? `avoid ${progress.level.hazardStages.length} red seams` : "none");
  setText(panel, '[data-game-metric="settled"]', progress.settled ? "settled" : "moving");
  setText(panel, '[data-game-metric="score"]', formatScore(progress));
  setText(panel, '[data-game-metric="best"]', formatBestScore(bestScore, scoreIsNewBest));
  setText(panel, "[data-game-status]", progress.status);

  if (routeLabel && routeValue) {
    routeLabel.hidden = !hasRouteChoice;
    routeValue.hidden = !hasRouteChoice;
  }

  if (pathWaterLabel && pathWaterValue) {
    pathWaterLabel.hidden = !hasRouteChoice;
    pathWaterValue.hidden = !hasRouteChoice;
  }

  if (targetsLabel && targetsValue) {
    targetsLabel.hidden = !hasDeliveryTargets;
    targetsValue.hidden = !hasDeliveryTargets;
  }

  if (modeLabel && modeValue) {
    modeLabel.hidden = !isManualStage;
    modeValue.hidden = !isManualStage;
  }

  if (riskLabel && riskValue) {
    riskLabel.hidden = !hasHazards;
    riskValue.hidden = !hasHazards;
  }

  if (scoreLabel && scoreValue) {
    scoreLabel.hidden = !hasScore;
    scoreValue.hidden = !hasScore;
  }

  if (bestLabel && bestValue) {
    bestLabel.hidden = !hasBestScore;
    bestValue.hidden = !hasBestScore;
  }

  if (stageBar) {
    stageBar.style.width = `${stagePercent}%`;
  }

  panel.dataset.complete = String(progress.complete);
  panel.dataset.failed = String(progress.failed);
  panel.dataset.risk = hasHazards ? "hazard" : "none";
  panel.dataset.routeFlow = (progress.stageProgress.selectedRouteWater ?? 0) >= 1 ? "active" : "dry";
  panel.dataset.grade = progress.score?.grade ?? "";
  panel.dataset.newBest = String(scoreIsNewBest);

  if (resetButton) {
    resetButton.textContent = progress.failed ? "Retry level" : "Reset level";
  }

  if (nextButton) {
    nextButton.disabled = !progress.complete;
    nextButton.textContent = levelIndex >= GAME_LEVELS.length - 1 ? "Restart slice" : "Next level";
  }
}

function formatWater(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatDeliveryTargets(progress: LevelProgress): string {
  if (progress.deliveryRequirements.length === 0) {
    return "-";
  }

  const completeTargets = progress.deliveryRequirements.filter((requirement) => requirement.complete).length;
  return `${completeTargets}/${progress.deliveryRequirements.length} basins`;
}

function formatScore(progress: LevelProgress): string {
  if (!progress.score) {
    return "-";
  }

  return `${progress.score.grade} ${progress.score.total}`;
}

function formatBestScore(score: LevelScore | null, isNewBest: boolean): string {
  if (!score) {
    return "-";
  }

  const prefix = isNewBest ? "new " : "";
  return `${prefix}${score.grade} ${score.total}`;
}

export function getLevelSelectRows(currentLevelIndex: number, bestScores: BestScoresByLevel): LevelSelectRow[] {
  return GAME_LEVELS.map((level, levelIndex) => ({
    levelIndex,
    levelId: level.id,
    name: level.name,
    bestLabel: formatLevelSelectBestScore(getBestScore(bestScores, level.id)),
    selected: levelIndex === currentLevelIndex,
  }));
}

function updateLevelSelect(panel: HTMLElement, currentLevelIndex: number, bestScores: BestScoresByLevel): void {
  for (const row of getLevelSelectRows(currentLevelIndex, bestScores)) {
    const button = panel.querySelector<HTMLButtonElement>(`[data-game-level-option="${row.levelIndex}"]`);
    if (!button) {
      continue;
    }

    button.dataset.selected = String(row.selected);
    button.disabled = row.selected;
    button.setAttribute("aria-pressed", String(row.selected));
    const bestValue = button.querySelector<HTMLElement>(`[data-game-level-best="${row.levelId}"]`);
    if (bestValue) {
      bestValue.textContent = row.bestLabel;
    }
  }
}

function formatLevelSelectBestScore(score: LevelScore | null): string {
  if (!score) {
    return "No best";
  }

  return `${score.grade} ${score.total}`;
}

function setText(parent: HTMLElement, selector: string, value: string): void {
  const element = parent.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}
