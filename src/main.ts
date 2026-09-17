import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision';
import {
  Clap,
  FingerCount,
  LateralExit,
  Latch,
  PinchZoom,
  countExtended,
  frameQuad,
  pinch,
  type Pt
} from './gesture';
import {
  ANATOMY,
  Wipe,
  layerFor,
  setBoneRenderer,
  setMode,
  setMuscleTexture,
  type Layer,
  type Mode
} from './palette';
import type { Skull } from './skull';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const modeBtn = document.getElementById('mode') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

/**
 * Two ways to hold the app.
 *
 * `framed` is the hand-held frame: fingers pick the layer, both hands carry
 * the window. `study` is what carrying that window off the sides of the screen
 * leaves behind — the frame fills the display and stops moving, the skull is
 * blown apart, and the counting stops so a hand reaching in to point at a bone
 * cannot change the layer under itself. Only a pinch and a clap are read.
 */
type Stage = 'framed' | 'study' | 'single';

const BONE = ANATOMY.layers[ANATOMY.layers.length - 1];
/** Eased per frame rather than over a clock: at 30fps it settles in ~0.4s. */
const EXPLODE_EASE = 0.12;
/** Holding two pinches this still, this long, lifts a bone out. */
const GRAB_HOLD = 500;
const GRAB_STEADY = 0.1;
/** A drag across the screen is one full turn. */
const SPIN_TURN = Math.PI * 2;
/** Renderers all guard on length, so this is simply "no face this frame". */
const NO_FACE: Pt[] = [];

let stage: Stage = 'framed';
let explode = 0;
let bone: string | null = null;
let grabbed = -1;
let grabSince = 0;
let grabSpan = 0;
let dragFrom: Pt | null = null;
let spinYaw = 0;
let spinPitch = 0;

const exit = new LateralExit();
const clap = new Clap();
const zoom = new PinchZoom();
const counter = new FingerCount();
// Blink and jaw scores hover, so each gets a trigger rather than a threshold.
const blink = new Latch(0.5, 0.3);
const mouth = new Latch(0.4, 0.22);
let mode: Mode = 'project';
modeBtn.textContent = `Mode: ${mode}`;

modeBtn.addEventListener('click', () => {
  mode = mode === 'project' ? 'displace' : 'project';
  setMode(mode);
  modeBtn.textContent = `Mode: ${mode}`;
});
const wipe = new Wipe();

let face: FaceLandmarker;
let hands: HandLandmarker;
let skull: Skull | null = null;
let live = false;

/**
 * Register the anatomical still by running the landmarker over it: the still's
 * own 468 points are the texture coordinates, so the art can be swapped
 * without keeping a table of numbers in step with it. Missing or unreadable
 * art is not an error — the layer falls back to drawing itself.
 */
async function initTexture() {
  try {
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}assets/muscle.jpg`;
    await img.decode();
    const uv = face.detect(img).faceLandmarks[0];
    if (!uv) throw new Error('no face found on the anatomy still');
    setMuscleTexture({ img, uv: uv.map((p) => ({ x: p.x * img.width, y: p.y * img.height })) });
  } catch {
    setMuscleTexture(null);
  }
}

/**
 * A megabyte of Draco-packed skull, so it is loaded once at startup rather
 * than on the frame a fist first appears. A model that fails to load is not an
 * error: the bone layer keeps drawing its radiograph.
 */
async function initSkull() {
  const { loadSkull } = await import('./skull');
  const base = import.meta.env.BASE_URL;
  skull = await loadSkull(`${base}assets/skull.glb`, `${base}draco/`);
  if (skull.ready) setBoneRenderer(skull.draw);
}

async function initModels() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
  [face, hands] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      // IMAGE first so the still can be read; switched to VIDEO right after.
      runningMode: 'IMAGE',
      numFaces: 1,
      // Blink and jaw drive the character plates' expression.
      outputFaceBlendshapes: true
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2
    })
  ]);
  await initTexture();
  await initSkull();
  await face.setOptions({ runningMode: 'VIDEO' });
}

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable — needs HTTPS or localhost');
  }
  // Match the screen's orientation: a landscape stream on a portrait tablet
  // gets its sides cropped away by object-fit, and the sides are where the
  // hands are. ~480 on the short edge either way keeps the GPU out of
  // thermal throttling.
  // ponytail: read once at startup, so rotating the tablet needs a reload.
  const [w, h] = window.innerHeight > window.innerWidth ? [480, 640] : [640, 480];
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: w },
      height: { ideal: h },
      frameRate: { ideal: 30, max: 30 }
    }
  });
  // Android hands the camera to whatever comes to the foreground, so the track
  // can end under us; without this the canvas just freezes with no way back.
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    live = false;
    status.textContent = 'Camera stopped';
    startBtn.hidden = false;
    startBtn.disabled = false;
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth || w;
  canvas.height = video.videoHeight || h;
  live = true;
}

const px = (lm: NormalizedLandmark[]): Pt[] =>
  // z shares x's scale in MediaPipe's output, so it scales with the width.
  lm.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height, z: p.z * canvas.width }));

function loop() {
  requestAnimationFrame(loop);
  if (!live || video.readyState < 2) return;

  const t = performance.now();
  let faceRes: FaceLandmarkerResult;
  let handRes: HandLandmarkerResult;
  try {
    faceRes = face.detectForVideo(video, t);
    handRes = hands.detectForVideo(video, t);
  } catch (err) {
    status.textContent = `Detection error: ${(err as Error).message}`;
    return;
  }

  const handsPx = handRes.landmarks.map(px);
  // One hand drives the count; both get drawn. Taking the most confident avoids
  // inventing a rule for what two disagreeing hands should mean.
  const lead = handRes.handedness.reduce(
    (best, h, i) => (h[0].score > (handRes.handedness[best]?.[0].score ?? 0) ? i : best),
    -1
  );
  const shapes = faceRes.faceBlendshapes[0]?.categories ?? [];
  const score = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
  const expr = {
    blink: blink.update(Math.max(score('eyeBlinkLeft'), score('eyeBlinkRight'))),
    mouth: mouth.update(score('jawOpen'))
  };

  // Away from the frame the count is not read at all, so a hand reaching in to
  // pinch cannot change the layer out from under the thing it is pointing at.
  const picked =
    stage === 'framed'
      ? layerFor(ANATOMY, counter.update(lead < 0 ? null : countExtended(handsPx[lead])))
      : BONE;

  // Carrying the frame out through the sides blows the skull apart. Only ever
  // from bone, and only with a skull to blow apart — there is nothing to
  // separate under a drawn radiograph.
  if (stage === 'framed') {
    if (picked.name === BONE.name && skull?.ready && exit.update(handsPx, canvas.width, t)) {
      stage = 'study';
      bone = null;
    }
  }

  // A clap lands with the hands together and nothing sensible to count, so the
  // frame it leaves on is still bone; the next one reads the hand properly.
  const layer = stage === 'framed' ? picked : BONE;
  const { from, to, k } = wipe.update(layer, t);

  explode += ((stage === 'framed' ? 0 : 1) - explode) * EXPLODE_EASE;
  skull?.setExplode(explode);

  status.textContent =
    skull?.error ??
    (stage === 'single'
      ? `${bone ?? 'bone'} · drag to turn · clap to go back`
      : stage === 'study'
        ? bone ?? 'pinch to name · hold two on one bone to lift it out'
        : layer.name);

  // Converted once: a wipe paints both layers, and the face mesh is 478 points.
  const facePx = faceRes.faceLandmarks[0] ? px(faceRes.faceLandmarks[0]) : null;
  // Study fills the screen with the frame, so every clip, sheet and wipe below
  // carries on working against a quad that simply happens to be the display.
  const quad =
    stage !== 'framed'
      ? [
          { x: 0, y: 0 },
          { x: canvas.width, y: 0 },
          { x: canvas.width, y: canvas.height },
          { x: 0, y: canvas.height }
        ]
      : frameQuad(handsPx);

  // How many hands are pinching decides which gesture this is, which is what
  // keeps them out of each other's way: two pinched hands can only be a zoom
  // or a grab, one can only be a question or a turn, and a clap needs both
  // hands open — so pulling the zoom shut cannot slam the door on the way out.
  if (stage !== 'framed' && skull) {
    const pinched = handsPx.map((hand) => pinch(hand)).filter((p): p is Pt => p !== null);
    if (pinched.length >= 2) {
      const span = Math.hypot(pinched[0].x - pinched[1].x, pinched[0].y - pinched[1].y);
      skull.setZoom(zoom.update(pinched[0], pinched[1]));
      clap.update([]); // hands are busy; do not let the latch sit shut
      dragFrom = null;

      // Both hands on the same bone, held still, lifts it out of the skull.
      // Steadiness is what tells it from a zoom: a zoom changes the span by
      // definition, so a span that has not moved is not one. Running both at
      // once costs nothing, because a zoom that holds still does not zoom.
      if (stage === 'study') {
        const a = skull.pickAt(pinched[0].x, pinched[0].y);
        const b = skull.pickAt(pinched[1].x, pinched[1].y);
        const both = a >= 0 && a === b ? a : -1;
        const steady = grabSpan > 0 && Math.abs(span - grabSpan) < grabSpan * GRAB_STEADY;
        if (both >= 0 && both === grabbed && steady) {
          if (t - grabSince > GRAB_HOLD) {
            stage = 'single';
            skull.isolate(both);
            bone = skull.nameOf(both);
            spinYaw = 0;
            spinPitch = 0;
            skull.setSpin(0, 0);
            zoom.reset();
            skull.setZoom(1);
          }
        } else {
          grabbed = both;
          grabSince = t;
          grabSpan = span;
        }
      }
    } else {
      zoom.release();
      grabbed = -1;
      grabSpan = 0;

      if (pinched.length === 1 && stage === 'single') {
        // Drag turns the bone. The canvas is mirrored, so screen-right is a
        // falling x in landmark space — negating it puts the turn the way
        // round the hand expects.
        if (dragFrom) {
          spinYaw -= ((pinched[0].x - dragFrom.x) * SPIN_TURN) / canvas.width;
          spinPitch += ((pinched[0].y - dragFrom.y) * SPIN_TURN) / canvas.height;
          skull.setSpin(spinYaw, spinPitch);
        }
        dragFrom = pinched[0];
      } else {
        dragFrom = null;
        // A pinch that catches nothing clears the label, so the reading always
        // belongs to the last thing pinched rather than going stale on screen.
        if (pinched.length === 1) bone = skull.nameOf(skull.pickAt(pinched[0].x, pinched[0].y)) || null;
      }

      // One step back rather than all the way out: a single bone returns to
      // the skull it came from, and the skull returns to the hand-held frame.
      if (clap.update(handsPx)) {
        if (stage === 'single') {
          skull.isolate(-1);
          stage = 'study';
        } else {
          stage = 'framed';
        }
        bone = null;
        dragFrom = null;
        zoom.reset();
        skull.setZoom(1);
      }
    }
  } else {
    clap.update([]);
  }
  const quadPath = () => {
    ctx.beginPath();
    quad!.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  };
  // Everything the palette draws lives inside the frame. The hands hold it
  // from outside its edges, so they stay as the camera sees them.
  const paint = (l: Layer) => {
    if (!quad) return;
    ctx.save();
    quadPath();
    ctx.clip();
    // A bone lifted out of the skull is turned by hand, so it keeps drawing
    // with the face out of shot; every renderer already guards on landmark
    // count, so an empty list is simply "nothing to pose against".
    if (l.face) l.face(ctx, facePx ?? NO_FACE, expr);
    // In study the hands are inside the frame rather than holding it, and a
    // pair of drawn skeleton hands over the skull is just something else to
    // see past while trying to pinch a bone.
    if (l.hand && stage === 'framed') for (const h of handsPx) l.hand(ctx, h, expr);
    ctx.restore();
  };
  const band = (l: Layer, top: number, bottom: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, canvas.width, bottom - top);
    ctx.clip();
    paint(l);
    ctx.restore();
  };

  ctx.save();
  ctx.setTransform(-1, 0, 0, 1, canvas.width, 0); // mirror frame + overlays together
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (quad) {
    // Displace lays a dark sheet over the room inside the frame so the layer
    // reads against it — but only when there is a layer to read. Skin is the
    // bare camera, so darkening it would hide the thing it exists to show.
    // Either side of a wipe counts, or the sheet would pop mid-transition.
    // Bone always reads against black. A colour-coded skull over a lit room is
    // mostly room, and the layer replaces the face outright anyway, so there is
    // nothing behind it worth keeping. Deeper once the frame is the whole
    // screen, where there is no reason to see past it at all.
    const bony = to.name === BONE.name || from?.name === BONE.name;
    const sheeted = bony || (mode === 'displace' && Boolean(to.face || from?.face));
    quadPath();
    ctx.fillStyle = sheeted
      ? `rgba(4,6,10,${stage === 'framed' ? 0.62 : 0.85})`
      : 'rgba(255,255,255,0.08)';
    ctx.fill();
    // The edge and its anchors are the hand-held frame's own furniture; in
    // study they would just be a box drawn around the screen.
    if (stage === 'framed') {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Mark the anchors themselves, so a screenshot shows where they landed.
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      for (const p of quad) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, canvas.width / 110, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  if (from) {
    const y = k * canvas.height;
    band(to, 0, y);
    band(from, y, canvas.height);
  } else {
    paint(to);
  }
  ctx.restore();
}

let looping = false;

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    if (!face) {
      status.textContent = 'Loading models…';
      await initModels();
    }
    status.textContent = 'Starting camera…';
    await initCamera();
    // Both hands are up and nothing touches the screen, so Android sleeps
    // part-way through a test without this.
    // ponytail: not re-acquired after the tab is backgrounded; reload to restore.
    navigator.wakeLock?.request('screen').catch(() => {});
    status.textContent = '';
    startBtn.hidden = true;
    modeBtn.hidden = false;
    if (!looping) {
      looping = true;
      loop();
    }
  } catch (err) {
    status.textContent = `Failed: ${(err as Error).message}`;
    startBtn.hidden = false;
    startBtn.disabled = false;
  }
});
