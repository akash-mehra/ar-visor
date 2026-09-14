import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision';
import { ArmSwitch, type Pt } from './gesture';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// FaceLandmarker emits 478 points: 468-472 left iris, 473-477 right iris.
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

const video = document.getElementById('cam') as HTMLVideoElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

// Placeholder skins. Swap for PNGs in public/assets: see drawEyes/drawVisor.
const SKINS = ['#ff3b30', '#7d4bff', '#00d0b0'];
let skin = 0;
const gesture = new ArmSwitch();

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

const toPx = (p: Pt) => ({ x: p.x * canvas.width, y: p.y * canvas.height });

function palmCentre(lm: NormalizedLandmark[]): Pt {
  const [wrist, , , , , indexMcp] = lm;
  const pinkyMcp = lm[17];
  return {
    x: (wrist.x + indexMcp.x + pinkyMcp.x) / 3,
    y: (wrist.y + indexMcp.y + pinkyMcp.y) / 3
  };
}

function drawEyes(res: FaceLandmarkerResult) {
  const lm = res.faceLandmarks[0];
  if (!lm || lm.length <= RIGHT_IRIS) return;

  const l = toPx(lm[LEFT_IRIS]);
  const r = toPx(lm[RIGHT_IRIS]);
  const angle = Math.atan2(r.y - l.y, r.x - l.x); // head tilt
  const size = Math.hypot(r.x - l.x, r.y - l.y) * 0.35;

  for (const eye of [l, r]) {
    ctx.save();
    ctx.translate(eye.x, eye.y);
    ctx.rotate(angle);
    // Replace with: ctx.drawImage(sharinganImg, -size, -size, size * 2, size * 2);
    ctx.fillStyle = SKINS[skin];
    ctx.beginPath();
    ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(2, size * 0.15);
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.restore();
  }
}

function drawVisor(a: Pt, b: Pt) {
  const p1 = toPx(a);
  const p2 = toPx(b);
  const w = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (w < 20) return;

  ctx.save();
  ctx.translate((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
  ctx.rotate(Math.atan2(p2.y - p1.y, p2.x - p1.x));
  // Replace with: ctx.drawImage(maskImg, -w / 2, -w * 0.35, w, w * 0.7);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.strokeStyle = SKINS[skin];
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -w * 0.35, w, w * 0.7, 12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

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

  const [a, b] =
    handRes.landmarks.length >= 2
      ? [palmCentre(handRes.landmarks[0]), palmCentre(handRes.landmarks[1])]
      : [null, null];
  if (gesture.update(a, b)) skin = (skin + 1) % SKINS.length;

  ctx.save();
  ctx.setTransform(-1, 0, 0, 1, canvas.width, 0); // mirror frame + overlays together
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  drawEyes(faceRes);
  if (a && b) drawVisor(a, b);
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
