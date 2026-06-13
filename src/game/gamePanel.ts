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
    <div class="game-panel-objectives"></div>
    <dl class="game-panel-metrics">
      <dt>Water in targets</dt><dd data-game-metric="targetWater">0</dd>
      <dt>Water outside</dt><dd data-game-metric="outsideWater">0</dd>
      <dt>Balance</dt><dd data-game-metric="balance">n/a</dd>
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

  setText(panel, "[data-game-level-count]", `Level ${levelIndex + 1}/${GAME_LEVELS.length}`);
  setText(panel, "[data-game-title]", progress.level.name);
  setText(panel, "[data-game-brief]", progress.level.brief);
  setText(panel, '[data-game-metric="targetWater"]', progress.targetWater.toFixed(1));
  setText(
    panel,
    '[data-game-metric="balance"]',
    progress.balanceDifference === null
      ? "n/a"
      : `${progress.balanceDifference.toFixed(1)} / ${progress.level.balance?.maxDifference.toFixed(1)}`,
  );
  setText(
    panel,
    '[data-game-metric="outsideWater"]',
    progress.level.maxOutsideWater === undefined
      ? progress.waterOutsideTargets.toFixed(1)
      : `${progress.waterOutsideTargets.toFixed(1)} / ${progress.level.maxOutsideWater.toFixed(1)}`,
  );

  const objectives = panel.querySelector<HTMLElement>(".game-panel-objectives");
  if (objectives) {
    objectives.innerHTML = progress.objectives
      .map(
        (objective) => `
          <div class="game-panel-objective" data-complete="${objective.complete ? "true" : "false"}">
            <span>${objective.zone.label}</span>
            <strong>${objective.water.toFixed(1)} / ${objective.zone.targetWater.toFixed(1)}</strong>
          </div>
        `,
      )
      .join("");
  }

  const status = getStatusText(progress);
  setText(panel, "[data-game-status]", status);
  panel.dataset.complete = String(progress.complete);

  const nextButton = panel.querySelector<HTMLButtonElement>('[data-game-action="next"]');
  if (nextButton) {
    nextButton.disabled = !progress.complete;
    nextButton.textContent = levelIndex >= GAME_LEVELS.length - 1 ? "Restart slice" : "Next level";
  }
}

function getStatusText(progress: LevelProgress): string {
  if (progress.complete) {
    return progress.level.successText;
  }

  if (!progress.objectives.every((objective) => objective.complete)) {
    return "Guide the water";
  }

  if (!progress.balanceComplete) {
    return "Balance the basins";
  }

  if (!progress.outsideComplete) {
    return "Too much water outside targets";
  }

  return "Guide the water";
}

function setText(parent: HTMLElement, selector: string, value: string): void {
  const element = parent.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = value;
  }
}
