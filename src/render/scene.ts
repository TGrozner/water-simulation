import {
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { WebGPURenderer as ThreeWebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type MainRenderer = WebGLRenderer | ThreeWebGPURenderer;
export type RendererRequestMode = "auto" | "webgpu" | "webgl";
export type RendererBackend = "webgl" | "webgpu" | "webgpu-webgl-fallback";

export type SceneContext = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: MainRenderer;
  rendererMode: RendererRequestMode;
  rendererBackend: RendererBackend;
  controls: OrbitControls;
  resize: () => void;
};

export async function createSceneContext(container: HTMLElement): Promise<SceneContext> {
  const scene = new Scene();
  scene.background = new Color(0x050b0d);
  scene.fog = new FogExp2(0x050b0d, 0.016);

  const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(38, 26, 48);
  camera.lookAt(new Vector3(0, 9, 0));

  const rendererMode = getInitialRendererMode();
  const { renderer, backend } = await createMainRenderer(rendererMode);
  container.appendChild(renderer.domElement);
  document.body.dataset.renderer = backend;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 9, 0);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.maxDistance = 110;
  controls.minDistance = 18;

  const ambient = new AmbientLight(0x8fb3bd, 0.28);
  scene.add(ambient);

  const skyFill = new HemisphereLight(0x69d8e5, 0x151b13, 0.48);
  scene.add(skyFill);

  const sun = new DirectionalLight(0xc9f0dc, 1.65);
  sun.position.set(14, 36, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const rim = new PointLight(0x37d7ff, 1.65, 78, 1.7);
  rim.position.set(-24, 18, -18);
  scene.add(rim);

  const grid = new GridHelper(56, 28, 0x253746, 0x111d27);
  grid.position.y = -0.02;
  grid.visible = false;
  scene.add(grid);

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  window.addEventListener("resize", resize);

  return {
    scene,
    camera,
    renderer,
    rendererMode,
    rendererBackend: backend,
    controls,
    resize,
  };
}

async function createMainRenderer(
  rendererMode: RendererRequestMode,
): Promise<{ renderer: MainRenderer; backend: RendererBackend }> {
  if (rendererMode === "webgl") {
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    configureRenderer(renderer);
    return { renderer, backend: "webgl" };
  }

  try {
    const { WebGPURenderer } = await import("three/webgpu");
    const renderer = new WebGPURenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    configureRenderer(renderer);
    await renderer.init();
    return { renderer, backend: getWebGPUBackendLabel(renderer) };
  } catch (error) {
    console.warn("WebGPU renderer failed to initialize; falling back to WebGLRenderer.", error);
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    configureRenderer(renderer);
    return { renderer, backend: "webgl" };
  }
}

function configureRenderer(renderer: MainRenderer): void {
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
}

function getInitialRendererMode(): RendererRequestMode {
  const requested = new URLSearchParams(window.location.search).get("renderer");
  if (requested === "webgpu" || requested === "webgl" || requested === "auto") {
    return requested;
  }

  return "auto";
}

function getWebGPUBackendLabel(renderer: ThreeWebGPURenderer): RendererBackend {
  const backend = renderer.backend as { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
  if (backend.isWebGPUBackend) {
    return "webgpu";
  }

  return "webgpu-webgl-fallback";
}
