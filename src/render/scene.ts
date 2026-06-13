import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
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
  scene.background = new Color(0x101820);

  const camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(38, 26, 48);
  camera.lookAt(new Vector3(0, 9, 0));

  const renderer = new WebGLRenderer({ antialias: true });
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

  const ambient = new AmbientLight(0xd5e7ff, 0.62);
  scene.add(ambient);

  const sun = new DirectionalLight(0xffffff, 2.8);
  sun.position.set(16, 38, 22);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const grid = new GridHelper(56, 28, 0x405166, 0x253141);
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
