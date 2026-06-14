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
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type SceneContext = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  resize: () => void;
};

export function createSceneContext(container: HTMLElement): SceneContext {
  const scene = new Scene();
  scene.background = new Color(0x081017);
  scene.fog = new FogExp2(0x081017, 0.012);

  const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(38, 26, 48);
  camera.lookAt(new Vector3(0, 9, 0));

  const renderer = new WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 9, 0);
  controls.enableDamping = true;
  controls.enablePan = true;
  controls.maxDistance = 110;
  controls.minDistance = 18;

  const ambient = new AmbientLight(0xaec9db, 0.34);
  scene.add(ambient);

  const skyFill = new HemisphereLight(0x76d5e8, 0x251910, 0.54);
  scene.add(skyFill);

  const sun = new DirectionalLight(0xffd39a, 2.05);
  sun.position.set(14, 36, 24);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const rim = new PointLight(0x37d7ff, 1.35, 72, 1.7);
  rim.position.set(-24, 18, -18);
  scene.add(rim);

  const grid = new GridHelper(56, 28, 0x253746, 0x111d27);
  grid.position.y = -0.02;
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
    controls,
    resize,
  };
}
