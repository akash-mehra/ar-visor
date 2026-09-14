import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision';
import { FingerCount, countExtended, frameQuad, type Pt } from './gesture';
import { ANATOMY, Wipe, layerFor, setMode, setMuscleTexture, type Layer, type Mode } from './palette';

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

const palette = ANATOMY;
const counter = new FingerCount();
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

async function initModels() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
  [face, hands] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      // IMAGE first so the still can be read; switched to VIDEO right after.
      runningMode: 'IMAGE',
      numFaces: 1
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2
    })
  ]);
  await initTexture();
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
  const layer = layerFor(palette, counter.update(lead < 0 ? null : countExtended(handsPx[lead])));
  const { from, to, k } = wipe.update(layer, t);
  status.textContent = layer.name;

  // Converted once: a wipe paints both layers, and the face mesh is 478 points.
  const facePx = faceRes.faceLandmarks[0] ? px(faceRes.faceLandmarks[0]) : null;
  const quad = frameQuad(handsPx);
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
    if (l.face && facePx) l.face(ctx, facePx);
    if (l.hand) for (const h of handsPx) l.hand(ctx, h);
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
    const sheeted = mode === 'displace' && Boolean(to.face || from?.face);
    quadPath();
    ctx.fillStyle = sheeted ? 'rgba(5,7,10,0.55)' : 'rgba(255,255,255,0.08)';
    ctx.fill();
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
