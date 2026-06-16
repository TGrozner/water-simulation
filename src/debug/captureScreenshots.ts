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
const DEFAULT_CAPTURE_WAIT_MS = 5_000;
const LARGE_SCENE_CAPTURE_WAIT_MS = 10_000;
const BLANK_CAPTURE_RETRY_COUNT = 3;
const CDP_CAPTURE_READY_TIMEOUT_MS = 25_000;
const CDP_REQUEST_TIMEOUT_MS = 15_000;
const STAGED_CAPTURE_PRESETS: ScenePresetId[] = ["generated-cavern"];
type GameCapture = {
  url: string;
  filename: string;
  timeoutMs?: number;
};

const GAME_CAPTURES: GameCapture[] = [
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=1&warmupTicks=300&camera=fps&spawn=water-drop&debugUi=0&visualCapture=1`,
    filename: "water-reservoir-drop.png",
    timeoutMs: 1200,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&carveManual=1&warmupTicks=240&camera=fps&spawn=basins&debugUi=0&visualCapture=1`,
    filename: "water-shoreline-basin.png",
    timeoutMs: 5000,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&carveManual=1&warmupTicks=240&camera=fps&spawn=south-basin&debugUi=0&visualCapture=1`,
    filename: "water-contact-tunnel.png",
    timeoutMs: 10000,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&carveManual=1&openHazards=1&warmupTicks=240&camera=fps&spawn=south-basin&debugUi=0&visualCapture=1`,
    filename: "water-hazard-flow.png",
    timeoutMs: 10000,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&camera=fps&spawn=overview`,
    filename: "game-generated-cavern-start.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&camera=fps&spawn=drop`,
    filename: "game-generated-cavern-open-2.png",
    timeoutMs: 700,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&carveManual=1&warmupTicks=240&camera=fps&spawn=basins`,
    filename: "game-generated-cavern-complete.png",
    timeoutMs: 5000,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&openStages=2&carveManual=1&openHazards=1&warmupTicks=240&camera=fps&spawn=south-basin`,
    filename: "game-generated-cavern-hazard.png",
    timeoutMs: 5000,
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&seedBestScores=1&camera=fps&spawn=overview`,
    filename: "game-level-select-summary.png",
  },
  {
    url: `${BASE_URL}/?game=1&level=generated-cavern&seedBestScores=1&debugUi=1&camera=fps&spawn=overview`,
    filename: "game-level-select-debug-ui.png",
  },
];

async function run(): Promise<void> {
  const updateBaseline = process.argv.includes("--update-baseline");
  const onlyFilenames = getOnlyFilenames();
  await mkdir(BASELINE_DIR, { recursive: true });
  await rm(CHROME_PROFILE_DIR, { recursive: true, force: true });
  await mkdir(CHROME_PROFILE_DIR, { recursive: true });
  await mkdir(ACTUAL_DIR, { recursive: true });
  await mkdir(DIFF_DIR, { recursive: true });

  const server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", HOST, "--port", String(PORT), "--strictPort"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForServer(server);
    const chrome = findChromeCommand();

    for (const preset of SCENE_PRESETS) {
      const sceneFilename = `${preset}.png`;
      if (shouldCapture(sceneFilename, onlyFilenames)) {
        await captureAndCompare(
          chrome,
          getSceneCaptureUrl(preset),
          sceneFilename,
          updateBaseline,
          getSceneCaptureTimeout(preset),
        );
      }

      const sliceFilename = `${preset}-slice.png`;
      if (shouldCapture(sliceFilename, onlyFilenames)) {
        await captureNonBlank(
          chrome,
          withCaptureMode(getSceneSliceCaptureUrl(preset)),
          `${ACTUAL_DIR}/${sliceFilename}`,
          getSceneCaptureTimeout(preset),
        );
        await compareOrUpdateBaseline(sliceFilename, updateBaseline);
      }
    }

    for (const preset of STAGED_CAPTURE_PRESETS) {
      const stages = getSceneOpeningStages(preset);
      const scriptedStageCount = stages.filter(isStageAutoOpen).length;
      for (let openStages = 1; openStages <= scriptedStageCount; openStages += 1) {
        const filename = `${preset}-open-${openStages}.png`;
        if (shouldCapture(filename, onlyFilenames)) {
          await captureAndCompare(
            chrome,
            `${BASE_URL}/?scene=${preset}&openStages=${openStages}&debug=1&paused=1`,
            filename,
            updateBaseline,
          );
        }
      }
    }

    for (const gameCapture of GAME_CAPTURES) {
      if (shouldCapture(gameCapture.filename, onlyFilenames)) {
        await captureAndCompare(chrome, gameCapture.url, gameCapture.filename, updateBaseline, gameCapture.timeoutMs);
      }
    }
  } finally {
    await stopProcess(server);
  }
}

function getOnlyFilenames(): Set<string> | null {
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  if (!onlyArg) {
    return null;
  }

  const filenames = onlyArg
    .slice("--only=".length)
    .split(",")
    .map((filename) => filename.trim())
    .filter(Boolean);
  return filenames.length > 0 ? new Set(filenames) : null;
}

function shouldCapture(filename: string, onlyFilenames: Set<string> | null): boolean {
  return !onlyFilenames || onlyFilenames.has(filename);
}

function getSceneCaptureUrl(preset: ScenePresetId): string {
  return `${BASE_URL}/?scene=${preset}&camera=fps&spawn=overview&debugUi=1&paused=1`;
}

function getSceneSliceCaptureUrl(preset: ScenePresetId): string {
  return `${BASE_URL}/?scene=${preset}&camera=fps&spawn=drop&slice=1&sliceZ=36&debug=1&debugUi=1&paused=1`;
}

function getSceneCaptureTimeout(_preset: ScenePresetId): number {
  return LARGE_SCENE_CAPTURE_WAIT_MS;
}

async function captureAndCompare(
  chrome: string,
  url: string,
  filename: string,
  updateBaseline: boolean,
  timeoutMs?: number,
): Promise<void> {
  await captureNonBlank(chrome, withCaptureMode(url), `${ACTUAL_DIR}/${filename}`, timeoutMs);
  await compareOrUpdateBaseline(filename, updateBaseline);
}

async function captureNonBlank(chrome: string, url: string, outputPath: string, timeoutMs = DEFAULT_CAPTURE_WAIT_MS): Promise<void> {
  if (shouldUseCdpFirst(outputPath, timeoutMs)) {
    await captureWithCdp(chrome, url, outputPath, timeoutMs);
    assertNotBlank(await readPng(outputPath), outputPath);
    return;
  }

  let lastBlankError: unknown;

  for (let attempt = 1; attempt <= BLANK_CAPTURE_RETRY_COUNT; attempt += 1) {
    const attemptTimeoutMs = timeoutMs * attempt;
    await capture(chrome, url, outputPath, attemptTimeoutMs);

    try {
      assertNotBlank(await readPng(outputPath), outputPath);
      return;
    } catch (error) {
      if (!isBlankScreenshotError(error) || attempt === BLANK_CAPTURE_RETRY_COUNT) {
        if (!isBlankScreenshotError(error)) {
          throw error;
        }
        lastBlankError = error;
        break;
      }

      lastBlankError = error;
      console.warn(`retrying blank capture ${outputPath} attempt=${attempt + 1}`);
    }
  }

  console.warn(`falling back to CDP capture ${outputPath}`);
  await captureWithCdp(chrome, url, outputPath, timeoutMs);
  try {
    assertNotBlank(await readPng(outputPath), outputPath);
  } catch (error) {
    if (lastBlankError instanceof Error && error instanceof Error) {
      throw new Error(`${error.message}; CLI fallback source: ${lastBlankError.message}`);
    }
    throw error;
  }
}

function withCaptureMode(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}capture=1`;
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

function isBlankScreenshotError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("screenshot appears blank");
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

function waitForServer(server: ReturnType<typeof spawn>): Promise<void> {
  const startedAt = Date.now();
  let serverExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      serverExit = { code, signal };
    };
    server.once("exit", onExit);

    const poll = () => {
      if (serverExit) {
        server.off("exit", onExit);
        reject(new Error(`Vite server exited before capture startup at ${BASE_URL} code=${serverExit.code} signal=${serverExit.signal}`));
        return;
      }

      get(BASE_URL, (response) => {
        response.resume();
        setTimeout(() => {
          if (serverExit) {
            server.off("exit", onExit);
            reject(new Error(`Vite server exited after port probe at ${BASE_URL} code=${serverExit.code} signal=${serverExit.signal}`));
            return;
          }

          server.off("exit", onExit);
          resolve();
        }, 250);
      }).on("error", () => {
        if (Date.now() - startedAt > 10_000) {
          server.off("exit", onExit);
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

async function capture(chrome: string, url: string, outputPath: string, timeoutMs = DEFAULT_CAPTURE_WAIT_MS): Promise<void> {
  const profilePath = getCaptureProfilePath(outputPath);
  await rm(profilePath, { recursive: true, force: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
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

async function captureWithCdp(chrome: string, url: string, outputPath: string, timeoutMs: number): Promise<void> {
  const port = 12_000 + Math.floor(Math.random() * 20_000);
  const profilePath = `${getCaptureProfilePath(outputPath)}-cdp`;
  await rm(profilePath, { recursive: true, force: true });
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`,
    "about:blank",
  ];
  const browser = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    browser.kill("SIGKILL");
  }, CAPTURE_TIMEOUT_MS);
  browser.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const version = await waitForCdpVersion(port);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const cdp = createCdpClient(ws);
    await cdp.open();
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitForRenderedPage(cdp, sessionId);
    await sleep(getCdpSettleWaitMs(timeoutMs));
    cdp.throwIfRuntimeFailed(url);
    const screenshot = await cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      sessionId,
    );
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
    await cdp.send("Target.closeTarget", { targetId });
    cdp.close();
  } catch (error) {
    if (timedOut) {
      throw new Error(`CDP screenshot timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}\n${stderr}`);
    }
    throw new Error(`CDP screenshot failed for ${url}: ${String(error)}\n${stderr}`);
  } finally {
    clearTimeout(timeout);
    await stopProcess(browser);
  }
}

type CdpVersion = {
  webSocketDebuggerUrl: string;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: {
    type?: string;
    args?: Array<{ value?: unknown; description?: string; type?: string }>;
    exceptionDetails?: {
      text?: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
      exception?: { description?: string };
    };
  };
  result?: unknown;
  error?: unknown;
};

type PendingCdpRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type CdpClient = ReturnType<typeof createCdpClient>;

function createCdpClient(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, PendingCdpRequest>();
  const runtimeFailures: string[] = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }

      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(JSON.stringify(message.error)));
        return;
      }

      request.resolve(message.result);
      return;
    }

    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      runtimeFailures.push(
        `${details?.exception?.description ?? details?.text ?? "runtime exception"} ${details?.url ?? ""}:${
          details?.lineNumber ?? 0
        }:${details?.columnNumber ?? 0}`,
      );
    }

    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      runtimeFailures.push(
        (message.params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? arg.type ?? "error")).join(" "),
      );
    }
  });

  ws.addEventListener("error", () => {
    rejectPendingRequests("CDP websocket error");
  });

  ws.addEventListener("close", () => {
    rejectPendingRequests("CDP websocket closed");
  });

  function rejectPendingRequests(message: string): void {
    for (const [id, request] of pending) {
      pending.delete(id);
      clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
  }

  return {
    open: () =>
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
      }),
    send: <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const id = nextId;
      nextId += 1;
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) {
        payload.sessionId = sessionId;
      }

      ws.send(JSON.stringify(payload));
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP request ${method} timed out after ${CDP_REQUEST_TIMEOUT_MS}ms`));
        }, CDP_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      });
    },
    throwIfRuntimeFailed: (url: string) => {
      const meaningfulFailures = runtimeFailures.filter((failure) => !failure.includes("favicon.ico"));
      if (meaningfulFailures.length > 0) {
        throw new Error(`${url} runtime failures:\n${meaningfulFailures.join("\n")}`);
      }
    },
    close: () => ws.close(),
  };
}

async function waitForCdpVersion(port: number): Promise<CdpVersion> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return (await response.json()) as CdpVersion;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  throw lastError instanceof Error ? lastError : new Error("CDP endpoint did not start");
}

async function waitForRenderedPage(cdp: CdpClient, sessionId: string): Promise<void> {
  const deadline = Date.now() + CDP_CAPTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rendered = await cdp.send<{ result?: { value?: boolean } }>(
      "Runtime.evaluate",
      {
        expression:
          'document.readyState === "complete" && Array.from(document.querySelectorAll("canvas")).some((canvas) => canvas.clientWidth > 0 && canvas.clientHeight > 0)',
        returnByValue: true,
      },
      sessionId,
    );
    if (rendered.result?.value === true) {
      return;
    }
    await sleep(150);
  }

  throw new Error("page did not render a canvas and UI before timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCdpSettleWaitMs(timeoutMs: number): number {
  const maxWait = timeoutMs >= LARGE_SCENE_CAPTURE_WAIT_MS ? 5_000 : 1_500;
  return Math.min(Math.max(timeoutMs, 350), maxWait);
}

function shouldUseCdpFirst(outputPath: string, timeoutMs: number): boolean {
  const filename = getCaptureFilename(outputPath);
  return timeoutMs >= LARGE_SCENE_CAPTURE_WAIT_MS || filename.startsWith("game-") || filename.startsWith("water-");
}

function getCaptureProfilePath(outputPath: string): string {
  const filename = getCaptureFilename(outputPath);
  return `${CHROME_PROFILE_DIR}/${filename.replace(/[^a-z0-9_-]+/gi, "-")}`;
}

function getCaptureFilename(outputPath: string): string {
  return outputPath.split("/").pop() ?? "capture";
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
