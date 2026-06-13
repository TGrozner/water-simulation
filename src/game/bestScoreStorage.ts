import { GAME_LEVELS, type LevelScore } from "./levels";

const STORAGE_KEY = "voxel-water-best-scores-v1";
const STORAGE_VERSION = 1;
const KNOWN_LEVEL_IDS = new Set(GAME_LEVELS.map((level) => level.id));

export type BestScoresByLevel = Partial<Record<string, LevelScore>>;

export type StoredBestScores = {
  version: typeof STORAGE_VERSION;
  scores: BestScoresByLevel;
};

export type BestScoreUpdate = {
  scores: BestScoresByLevel;
  improved: boolean;
};

export function loadBestScores(): BestScoresByLevel {
  const storage = getStorage();
  if (!storage) {
    return {};
  }

  const rawValue = storage.getItem(STORAGE_KEY);
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return parseStoredBestScores(parsed);
  } catch {
    return {};
  }
}

export function saveBestScores(scores: BestScoresByLevel): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, scores } satisfies StoredBestScores));
  } catch {
    // Storage can fail in private contexts or when quota is exhausted.
  }
}

export function getBestScore(scores: BestScoresByLevel, levelId: string): LevelScore | null {
  return scores[levelId] ?? null;
}

export function mergeBestScore(scores: BestScoresByLevel, levelId: string, score: LevelScore): BestScoreUpdate {
  const currentBest = getBestScore(scores, levelId);
  if (!isBetterScore(score, currentBest)) {
    return { scores, improved: false };
  }

  return {
    scores: {
      ...scores,
      [levelId]: score,
    },
    improved: true,
  };
}

export function isBetterScore(candidate: LevelScore, currentBest: LevelScore | null): boolean {
  if (!currentBest) {
    return true;
  }

  if (candidate.total !== currentBest.total) {
    return candidate.total > currentBest.total;
  }

  return candidate.ticks < currentBest.ticks;
}

export function parseStoredBestScores(value: unknown): BestScoresByLevel {
  if (!isRecord(value)) {
    return {};
  }

  if (value.version !== STORAGE_VERSION || !isRecord(value.scores)) {
    return {};
  }

  const scores: BestScoresByLevel = {};
  for (const [levelId, score] of Object.entries(value.scores)) {
    if (KNOWN_LEVEL_IDS.has(levelId) && isLevelScore(score)) {
      scores[levelId] = score;
    }
  }

  return scores;
}

function isLevelScore(value: unknown): value is LevelScore {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isFiniteNumber(value.total) &&
    value.total >= 0 &&
    value.total <= 100 &&
    isScoreGrade(value.grade) &&
    isRatio(value.efficiency) &&
    isRatio(value.waste) &&
    isRatio(value.time) &&
    isFiniteNumber(value.ticks) &&
    value.ticks >= 0
  );
}

function isScoreGrade(value: unknown): value is LevelScore["grade"] {
  return value === "S" || value === "A" || value === "B" || value === "C";
}

function isRatio(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
