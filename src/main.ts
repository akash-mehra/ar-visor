import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision';
import { FingerCount, countExtended, type Pt } from './gesture';
import { ANATOMY, layerFor } from './palette';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

const palette = ANATOMY;
const counter = new FingerCount();

let face: FaceLandmarker;
let hands: HandLandmarker;

async function initModels() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
  [face, hands] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2
    })
  ]);
}

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable — needs HTTPS or localhost');
  }
  // 640x480 @30fps keeps the tablet GPU out of thermal throttling.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30, max: 30 }
    }
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
}

const px = (lm: NormalizedLandmark[]): Pt[] =>
  lm.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height }));

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2) return;

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
  status.textContent = layer.name;

  ctx.save();
  ctx.setTransform(-1, 0, 0, 1, canvas.width, 0); // mirror frame + overlays together
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const faceLm = faceRes.faceLandmarks[0];
  if (layer.face && faceLm) layer.face(ctx, px(faceLm));
  if (layer.hand) for (const h of handsPx) layer.hand(ctx, h);
  ctx.restore();
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    status.textContent = 'Loading models…';
    await initModels();
    status.textContent = 'Starting camera…';
    await initCamera();
    status.textContent = '';
    startBtn.remove();
    loop();
  } catch (err) {
    status.textContent = `Failed: ${(err as Error).message}`;
    startBtn.disabled = false;
  }
});
