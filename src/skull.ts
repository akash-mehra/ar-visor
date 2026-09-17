import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  OrthographicCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { faceBasis, type Pt } from './gesture';
import type { Renderer } from './palette';

/**
 * The bone layer as an actual skull rather than a drawn radiograph.
 *
 * It renders to its own WebGL canvas and the result is blitted into the 2D
 * context the rest of the palette draws into. That keeps one clipping path,
 * one mirror transform and one wipe for every layer: the 3D arrives as just
 * another image to draw inside the frame, and the working 2D pipeline is not
 * touched. The model is posed with an orthographic camera in canvas pixels,
 * so placing it is the same arithmetic the 2D layers already do — and it
 * sidesteps having to match whatever projection MediaPipe assumes.
 *
 * ponytail: a full-canvas texture upload every frame. Fine at 640x480; if the
 * tablet complains, the fix is a real DOM canvas with a CSS clip-path instead
 * of the blit.
 */

/** Sized off the model, tuned on the device. */
const WIDTH_RATIO = 1; // skull width against the temple-to-temple landmarks
const FORWARD_OFFSET = 0; // + moves the skull away from the camera
const UP_OFFSET = 0; // + raises it, in face widths
/** How far a bone travels at full spread, as a fraction of the skull. */
const EXPLODE_SPAN = 0.6;
/** How much of the short edge the separated skull is allowed to fill. */
const STUDY_FILL = 0.9;

export type Skull = {
  ready: boolean;
  error: string | null;
  /** How many separable bones the file turned out to hold. */
  bones: number;
  /** 0 rests, 1 fully separated. */
  setExplode(t: number): void;
  /** Multiplies the separated view's size. 1 is fit-to-screen. */
  setZoom(z: number): void;
  /** The bone under a canvas point, named for reading. */
  nameAt(x: number, y: number): string | null;
  draw: Renderer;
};

/**
 * Blender's own suffixes, spelled out: "Zygomatic bone.r" is a fine name for
 * a mesh and a poor one for a label.
 *
 * Read off userData rather than the object's name. GLTFLoader runs node names
 * through sanitizeNodeName, which turns spaces into underscores and deletes
 * dots outright, so "Parietal bone.l" reaches Object3D.name as
 * "Parietal_bonel" — and the side, by then, is an ordinary letter at the end
 * of a word with nothing to tell it apart from spelling. The loader keeps the
 * original on userData for exactly this.
 */
function label(mesh: Mesh): string {
  const raw = typeof mesh.userData?.name === 'string' ? mesh.userData.name : mesh.name;
  return raw
    .replace(/_/g, ' ')
    .replace(/\.\d+$/, '')
    .replace(/\.([lr])$/i, (_, side: string) =>
      side.toLowerCase() === 'l' ? ' (left)' : ' (right)');
}

type Part = { mesh: Mesh; out: Vector3; box: Box3 };

export async function loadSkull(url: string, dracoPath: string): Promise<Skull> {
  const state: Skull = {
    ready: false,
    error: null,
    bones: 0,
    setExplode: () => {},
    setZoom: () => {},
    nameAt: () => null,
    draw: () => {}
  };

  // setDecoderPath looks redundant — DRACOLoader already defaults to a
  // module-level `new URL('../libs/draco/…', import.meta.url)`, which the
  // bundler resolves and emits from our own origin. It is not. That default
  // only survives a production build: under the dev server import.meta.url
  // points into vite's pre-bundle directory, `../libs/draco/` resolves to
  // nothing, and the 404 comes back as index.html — which the decoder then
  // tries to run, for a `SyntaxError: Unexpected token '<'` and no skull.
  // A copy in public/ resolves the same way in both.
  const draco = new DRACOLoader().setDecoderPath(dracoPath);
  const loader = new GLTFLoader().setDRACOLoader(draco);

  let gltf;
  try {
    gltf = await loader.loadAsync(url);
  } catch (e) {
    state.error = `skull: ${(e as Error).message}`;
    return state;
  } finally {
    draco.dispose();
  }

  // The model is authored standing on a floor, so it arrives a metre and a
  // half up. Re-centre it inside a group and drive the group instead.
  const root = new Group();
  root.add(gltf.scene);

  const box = new Box3().setFromObject(gltf.scene);
  const centre = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  gltf.scene.position.sub(centre);

  // Each bone separates straight out from the middle of the skull. Taking the
  // direction from its own geometry means the file needs no authored explode
  // hints, and bones added or removed later need no code change.
  const parts: Part[] = [];
  gltf.scene.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const box = new Box3().setFromObject(m);
    box.min.sub(centre);
    box.max.sub(centre);
    const c = box.getCenter(new Vector3());
    parts.push({ mesh: m, out: c.lengthSq() < 1e-12 ? new Vector3() : c.normalize(), box });
  });
  state.bones = parts.length;

  /**
   * Half the room the skull needs, at rest and fully apart.
   *
   * Measured from where the bones actually end up rather than from a sphere
   * around the whole model: they do not all travel the same distance, and
   * fitting the bounding diagonal leaves the view about a third smaller than
   * the screen would allow. Taken across all three axes, not just the two on
   * screen, because the head turns and its depth swings into view with it.
   * Reading it off the geometry also means the re-exported model resizes
   * itself.
   */
  const reachOf = (b: Box3) =>
    Math.max(
      Math.abs(b.min.x), Math.abs(b.max.x),
      Math.abs(b.min.y), Math.abs(b.max.y),
      Math.abs(b.min.z), Math.abs(b.max.z)
    );
  const fullTravel = EXPLODE_SPAN * size.length();
  const apart = new Box3();
  for (const p of parts) {
    apart.union(
      new Box3(
        p.box.min.clone().addScaledVector(p.out, fullTravel),
        p.box.max.clone().addScaledVector(p.out, fullTravel)
      )
    );
  }
  const restReach = reachOf(new Box3(box.min.clone().sub(centre), box.max.clone().sub(centre)));
  const apartReach = reachOf(apart);

  const scene = new Scene();
  scene.add(root);
  // Flat ambient plus one key light: enough to read the form without pretending
  // to be a lighting rig that matches the room.
  scene.add(new AmbientLight(0xffffff, 1.6));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(0.3, 0.6, 1);
  scene.add(key);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  camera.position.z = 2000;

  const gl = document.createElement('canvas');
  const renderer = new WebGLRenderer({ canvas: gl, alpha: true, antialias: true });
  renderer.setClearAlpha(0);

  let explode = 0;
  state.setExplode = (t) => {
    explode = Math.min(1, Math.max(0, t));
  };

  let zoom = 1;
  state.setZoom = (z) => {
    zoom = z > 0 ? z : 1;
  };

  // Pinching reads the bone under the fingertips. Landmarks and the 3D are
  // both in unmirrored video space — the mirror is applied once, to the blit —
  // so a pinch point needs no flipping before it is cast.
  const meshes = parts.map((p) => p.mesh);
  const ray = new Raycaster();
  const ndc = new Vector2();
  state.nameAt = (x, y) => {
    if (!gl.width || !gl.height) return null;
    ndc.set((x / gl.width) * 2 - 1, -(y / gl.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit ? label(hit.object as Mesh) : null;
  };

  const basisMatrix = new Matrix4();
  const vRight = new Vector3();
  const vUp = new Vector3();
  const vFwd = new Vector3();

  state.draw = (ctx, lm) => {
    const b = faceBasis(lm as Pt[]);
    if (!b || b.width < 1) return;

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    if (gl.width !== w || gl.height !== h) {
      renderer.setSize(w, h, false);
      camera.left = -w / 2;
      camera.right = w / 2;
      camera.top = h / 2;
      camera.bottom = -h / 2;
      camera.updateProjectionMatrix();
    }

    // Separating the bones is also what carries the skull off the face, and
    // the same value drives both. At rest it is sized to the temples and sits
    // where the head is; fully apart it is centred and sized to the screen,
    // because a view of a skull in pieces is no longer a view of a face and
    // scaling it to one only means standing closer throws the far bones off
    // the edge. Everything between is the blend, so the move is the spread.
    const travel = explode * fullTravel;
    const reach = restReach + (apartReach - restReach) * explode;
    const onFace = (b.width * WIDTH_RATIO) / size.x;
    const onScreen = (Math.min(w, h) * STUDY_FILL * zoom) / (reach * 2);
    root.scale.setScalar(onFace + (onScreen - onFace) * explode);

    vRight.set(b.right.x, b.right.y, b.right.z);
    vUp.set(b.up.x, b.up.y, b.up.z);
    vFwd.set(b.forward.x, b.forward.y, b.forward.z);
    root.quaternion.setFromRotationMatrix(basisMatrix.makeBasis(vRight, vUp, vFwd));

    // Landmark space is canvas pixels with y down; the camera is centred with
    // y up, so the origin moves to the middle and y flips. Fully separated the
    // skull sits at the middle of the screen instead, which is also what makes
    // a bone stay still long enough to be pinched.
    root.position.set(b.centre.x - w / 2, b.centre.y + h / 2, 0);
    root.position.addScaledVector(vFwd, -FORWARD_OFFSET * b.width);
    root.position.addScaledVector(vUp, UP_OFFSET * b.width);
    root.position.multiplyScalar(1 - explode);

    for (const p of parts) p.mesh.position.copy(p.out).multiplyScalar(travel);

    renderer.render(scene, camera);
    ctx.drawImage(gl, 0, 0, w, h);
  };

  state.ready = true;
  return state;
}
