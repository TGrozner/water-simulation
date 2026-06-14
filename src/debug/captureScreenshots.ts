import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PNG } from "pngjs";
import { SCENE_PRESETS, type ScenePresetId } from "../world/createWorld";
import { getSceneOpeningStages, isStageAutoOpen } from "../world/sceneTools";

const HOST = "127.0.0.1";
const PORT = 4175;
const BASE_URL = `http://${HOST}:${PORT}`;
const BASELINE_DIR = "test/baselines/visual";
const OUTPUT_ROOT = ".sim-build/screenshots";
const ACTUAL_DIR = `${OUTPUT_ROOT}/actual`;
const DIFF_DIR = `${OUTPUT_ROOT}/diff`;
const CHROME_PROFILE_DIR = `${OUTPUT_ROOT}/chrome-profile`;
const CHROME_CANDIDATES = ["google-chrome", "chromium", "chromium-browser"];
const DIFFERENCE_THRESHOLD = 0.03;
const MIN_VARIANCE = 2;
const CAPTURE_TIMEOUT_MS = 90_000;
const STAGED_CAPTURE_PRESETS: ScenePresetId[] = ["sluice", "splitter", "braid", "divide", "deep-cavern"];
type GameCapture = {
  url: string;
  filename: string;
  timeoutMs?: number;
};

const GAME_CAPTURES: GameCapture[] = [
  {
    url: `${BASE_URL}/?game=1&level=tutorial&camera=fps`,
    filename: "game-tutorial.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=tutorial&openStages=2&warmupTicks=1800&camera=fps`,
    filename: "game-tutorial-complete.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=tutorial&seedBestScores=1&camera=fps`,
    filename: "game-tutorial-best-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=tutorial&seedBestScores=1&openStages=2&warmupTicks=1800&camera=fps`,
    filename: "game-tutorial-repeat-complete.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&camera=fps`,
    filename: "game-challenge-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&openStages=2&camera=fps`,
    filename: "game-challenge-open-2.png",
    timeoutMs: 350,
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&openStages=2&branch=north&camera=fps`,
    filename: "game-challenge-north.png",
    timeoutMs: 350,
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&openStages=2&carveManual=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-challenge-route-south.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&openStages=2&branch=north&carveManual=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-challenge-route-north.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=challenge&openStages=2&openHazards=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-challenge-hazard.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitpath&camera=fps`,
    filename: "game-splitpath-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitpath&openStages=1&camera=fps`,
    filename: "game-splitpath-open-1.png",
    timeoutMs: 350,
  },
  {
    url: `${BASE_URL}/?game=1&level=splitpath&openStages=1&carveManual=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-splitpath-route-south.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitpath&openStages=1&choice2=1&carveManual=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-splitpath-route-north.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitpath&openStages=1&carveManual=1&openHazards=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-splitpath-hazard.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitbasin&camera=fps`,
    filename: "game-splitbasin-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitbasin&openStages=1&camera=fps`,
    filename: "game-splitbasin-open-1.png",
    timeoutMs: 350,
  },
  {
    url: `${BASE_URL}/?game=1&level=splitbasin&openStages=1&carveManual=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-splitbasin-both-routes.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=splitbasin&openStages=1&carveManual=1&openHazards=1&warmupTicks=1800&camera=fps&spawn=overview`,
    filename: "game-splitbasin-hazard.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=deep-cavern&camera=fps&spawn=overview`,
    filename: "game-deep-cavern-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=deep-cavern&openStages=2&camera=fps&spawn=overview`,
    filename: "game-deep-cavern-open-2.png",
    timeoutMs: 700,
  },
  {
    url: `${BASE_URL}/?game=1&level=deep-cavern&openStages=2&carveManual=1&warmupTicks=2800&camera=fps&spawn=overview`,
    filename: "game-deep-cavern-complete.png",
    timeoutMs: 5000,
  },
  {
    url: `${BASE_URL}/?game=1&level=deep-cavern&openStages=2&carveManual=1&openHazards=1&warmupTicks=2800&camera=fps&spawn=overview`,
    filename: "game-deep-cavern-hazard.png",
    timeoutMs: 5000,
  },
  {
    url: `${BASE_URL}/?game=1&level=tutorial&seedBestScores=1&camera=fps`,
    filename: "game-level-select-summary.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=tutorial&seedBestScores=1&debugUi=1&camera=fps`,
    filename: "game-level-select-debug-ui.png",
  },
];

async function run(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");
  await mkdir(BASELINE_DIR, { recursive: true });
  await rm(CHROME_PROFILE_DIR, { recursive: true, force: true });
  await mkdir(CHROME_PROFILE_DIR, { recursive: true });
  await mkdir(ACTUAL_DIR, { recursive: true });
  await mkdir(DIFF_DIR, { recursive: true });

  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", HOST, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer();
    const chrome = findChromeCommand();

    for (const preset of SCENE_PRESETS) {
      await captureAndCompare(chrome, getSceneCaptureUrl(preset), `${preset}.png`, updateBaseline);
      await capture(
        chrome,
        getSceneSliceCaptureUrl(preset),
        `${ACTUAL_DIR}/${preset}-slice.png`,
      );
      await compareOrUpdateBaseline(`${preset}-slice.png`, updateBaseline);
    }

    for (const preset of STAGED_CAPTURE_PRESETS) {
      const stages = getSceneOpeningStages(preset);
      const scriptedStageCount = stages.filter(isStageAutoOpen).length;
      for (let openStages = 1; openStages <= scriptedStageCount; openStages += 1) {
        const filename = `${preset}-open-${openStages}.png`;
        await captureAndCompare(chrome, `${BASE_URL}/?scene=${preset}&openStages=${openStages}&debug=1`, filename, updateBaseline);
      }
    }

    for (const gameCapture of GAME_CAPTURES) {
      await captureAndCompare(chrome, gameCapture.url, gameCapture.filename, updateBaseline, gameCapture.timeoutMs);
    }
  } finally {
    await stopProcess(server);
  }
}

function getSceneCaptureUrl(preset: ScenePresetId): string {
  if (preset === "deep-cavern") {
    return `${BASE_URL}/?scene=${preset}&camera=fps&spawn=overview&debugUi=1`;
  }

  return `${BASE_URL}/?scene=${preset}`;
}

function getSceneSliceCaptureUrl(preset: ScenePresetId): string {
  if (preset === "deep-cavern") {
    return `${BASE_URL}/?scene=${preset}&camera=fps&spawn=overview&slice=1&sliceZ=36&debug=1&debugUi=1`;
  }

  return `${BASE_URL}/?scene=${preset}&slice=1&sliceZ=28&debug=1`;
}

async function captureAndCompare(
  chrome: string,
  url: string,
  filename: string,
  updateBaseline: boolean,
  timeoutMs?: number,
): Promise<void> {
  await capture(chrome, url, `${ACTUAL_DIR}/${filename}`, timeoutMs);
  await compareOrUpdateBaseline(filename, updateBaseline);
}

async function compareOrUpdateBaseline(filename: string, updateBaseline: boolean): Promise<void> {
  const actualPath = `${ACTUAL_DIR}/${filename}`;
  const baselinePath = `${BASELINE_DIR}/${filename}`;
  const diffPath = `${DIFF_DIR}/${filename}`;

  assertNotBlank(await readPng(actualPath), actualPath);

  if (updateBaseline || !existsSync(baselinePath)) {
    await copyFile(actualPath, baselinePath);
    console.log(`baseline ${baselinePath}`);
    return;
  }

  const baseline = await readPng(baselinePath);
  const actual = await readPng(actualPath);
  const diff = comparePngs(baseline, actual);
  await writeFile(diffPath, PNG.sync.write(diff.diffImage));

  if (diff.score > DIFFERENCE_THRESHOLD) {
    throw new Error(`${filename}: visual diff ${diff.score.toFixed(4)} exceeds ${DIFFERENCE_THRESHOLD}`);
  }

  console.log(`compared ${filename} diff=${diff.score.toFixed(4)}`);
}

async function readPng(path: string): Promise<PNG> {
  return PNG.sync.read(await readFile(path));
}

function assertNotBlank(image: PNG, path: string): void {
  let sum = 0;
  let sumSquares = 0;
  const pixels = image.width * image.height;

  for (let i = 0; i < image.data.length; i += 4) {
    const value = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
    sum += value;
    sumSquares += value * value;
  }

  const mean = sum / pixels;
  const variance = sumSquares / pixels - mean * mean;
  if (variance < MIN_VARIANCE) {
    throw new Error(`${path}: screenshot appears blank; variance=${variance.toFixed(3)}`);
  }
}

function comparePngs(baseline: PNG, actual: PNG): { score: number; diffImage: PNG } {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    throw new Error(
      `Screenshot dimensions changed: baseline ${baseline.width}x${baseline.height}, actual ${actual.width}x${actual.height}`,
    );
  }

  const diffImage = new PNG({ width: actual.width, height: actual.height });
  let totalDifference = 0;

  for (let i = 0; i < actual.data.length; i += 4) {
    const dr = Math.abs(actual.data[i] - baseline.data[i]);
    const dg = Math.abs(actual.data[i + 1] - baseline.data[i + 1]);
    const db = Math.abs(actual.data[i + 2] - baseline.data[i + 2]);
    const difference = (dr + dg + db) / (255 * 3);
    totalDifference += difference;

    diffImage.data[i] = Math.min(255, dr * 4);
    diffImage.data[i + 1] = Math.min(255, dg * 4);
    diffImage.data[i + 2] = Math.min(255, db * 4);
    diffImage.data[i + 3] = 255;
  }

  return {
    score: totalDifference / (actual.width * actual.height),
    diffImage,
  };
}

function stopProcess(processToStop: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      processToStop.kill("SIGKILL");
      resolve();
    }, 1_000);

    processToStop.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    processToStop.kill("SIGTERM");
  });
}

function waitForServer(): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      get(BASE_URL, (response) => {
        response.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() - startedAt > 10_000) {
          reject(new Error(`Vite server did not start at ${BASE_URL}`));
          return;
        }

        setTimeout(poll, 150);
      });
    };

    poll();
  });
}

function findChromeCommand(): string {
  return process.env.CHROME_BIN || CHROME_CANDIDATES[0];
}

async function capture(chrome: string, url: string, outputPath: string, timeoutMs = 1500): Promise<void> {
  const profilePath = getCaptureProfilePath(outputPath);
  await rm(profilePath, { recursive: true, force: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    `--user-data-dir=${profilePath}`,
    "--window-size=1280,720",
    `--timeout=${timeoutMs}`,
    `--screenshot=${outputPath}`,
    url,
  ];

  return new Promise((resolve, reject) => {
    const browser = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      browser.kill("SIGKILL");
      reject(new Error(`Chrome screenshot timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}`));
    }, CAPTURE_TIMEOUT_MS);

    browser.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    browser.on("error", reject);
    browser.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log(`captured ${outputPath}`);
        resolve();
        return;
      }

      reject(new Error(`Chrome screenshot failed for ${url} with code ${code}\n${stderr}`));
    });
  });
}

function getCaptureProfilePath(outputPath: string): string {
  const filename = outputPath.split("/").pop() ?? "capture";
  return `${CHROME_PROFILE_DIR}/${filename.replace(/[^a-z0-9_-]+/gi, "-")}`;
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
