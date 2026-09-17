import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Euler,
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
  /** Which bone is under a canvas point, or -1. */
  pickAt(x: number, y: number): number;
  /** A bone's name, for reading. */
  nameOf(i: number): string;
  /** Show one bone on its own, or -1 for the whole skull. */
  isolate(i: number): void;
  /** Turned by hand rather than by the head, once a bone is on its own. */
  setSpin(yaw: number, pitch: number): void;
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
    pickAt: () => -1,
    nameOf: () => '',
    isolate: () => {},
    setSpin: () => {},
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
  // Where the scene sits for every view but a single bone, which re-centres
  // on the bone instead.
  const rest = centre.clone().negate();
  gltf.scene.position.copy(rest);

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

  let single = -1;
  state.isolate = (i) => {
    single = i;
    parts.forEach((p, k) => (p.mesh.visible = i < 0 || k === i));
  };
  state.nameOf = (i) => (parts[i] ? label(parts[i].mesh) : '');

  let spinYaw = 0;
  let spinPitch = 0;
  state.setSpin = (yaw, pitch) => {
    spinYaw = yaw;
    spinPitch = pitch;
  };

  // Pinching reads the bone under the fingertips. Landmarks and the 3D are
  // both in unmirrored video space — the mirror is applied once, to the blit —
  // so a pinch point needs no flipping before it is cast.
  const meshes = parts.map((p) => p.mesh);
  const ray = new Raycaster();
  const ndc = new Vector2();
  state.pickAt = (x, y) => {
    if (!gl.width || !gl.height) return -1;
    ndc.set((x / gl.width) * 2 - 1, -(y / gl.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    // A hidden bone is still in the scene, and the raycaster does not care.
    const hit = ray.intersectObjects(meshes.filter((m) => m.visible), false)[0];
    return hit ? meshes.indexOf(hit.object as Mesh) : -1;
  };

  const basisMatrix = new Matrix4();
  const spinEuler = new Euler();
  const centreOf = new Vector3();
  const halfOf = new Vector3();
  const vRight = new Vector3();
  const vUp = new Vector3();
  const vFwd = new Vector3();

  state.draw = (ctx, lm) => {
    const b = faceBasis(lm as Pt[]);
    // One bone on its own is turned by hand, so it keeps drawing whether or
    // not a face is still in shot — which is the point of having taken it out
    // of the skull. Every other view is posed on the head and needs one.
    if (single < 0 && (!b || b.width < 1)) return;

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
    if (single >= 0) {
      // One bone, middle of the screen, sized to itself and turned by the
      // hand that grabbed it. Re-centring moves the scene rather than the
      // mesh, so the bone's own geometry is never touched.
      const p = parts[single];
      p.box.getCenter(centreOf);
      halfOf.subVectors(p.box.max, p.box.min).multiplyScalar(0.5);
      const r = Math.max(halfOf.x, halfOf.y, halfOf.z);
      gltf.scene.position.copy(rest).sub(centreOf);
      root.scale.setScalar((Math.min(w, h) * STUDY_FILL * zoom) / (r * 2 || 1));
      root.quaternion.setFromEuler(spinEuler.set(spinPitch, spinYaw, 0));
      root.position.set(0, 0, 0);
      for (const q of parts) q.mesh.position.set(0, 0, 0);
    } else {
      gltf.scene.position.copy(rest);
      const travel = explode * fullTravel;
      const reach = restReach + (apartReach - restReach) * explode;
      const onFace = (b!.width * WIDTH_RATIO) / size.x;
      const onScreen = (Math.min(w, h) * STUDY_FILL * zoom) / (reach * 2);
      root.scale.setScalar(onFace + (onScreen - onFace) * explode);

      vRight.set(b!.right.x, b!.right.y, b!.right.z);
      vUp.set(b!.up.x, b!.up.y, b!.up.z);
      vFwd.set(b!.forward.x, b!.forward.y, b!.forward.z);
      root.quaternion.setFromRotationMatrix(basisMatrix.makeBasis(vRight, vUp, vFwd));

      // Landmark space is canvas pixels with y down; the camera is centred
      // with y up, so the origin moves to the middle and y flips. Fully
      // separated the skull sits at the middle of the screen instead, which
      // is also what makes a bone stay still long enough to be pinched.
      root.position.set(b!.centre.x - w / 2, b!.centre.y + h / 2, 0);
      root.position.addScaledVector(vFwd, -FORWARD_OFFSET * b!.width);
      root.position.addScaledVector(vUp, UP_OFFSET * b!.width);
      root.position.multiplyScalar(1 - explode);

      for (const p of parts) p.mesh.position.copy(p.out).multiplyScalar(travel);
    }

    renderer.render(scene, camera);
    ctx.drawImage(gl, 0, 0, w, h);
  };

  state.ready = true;
  return state;
}
