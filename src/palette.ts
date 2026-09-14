import { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Pt } from './gesture';

/** Landmarks arrive already converted to canvas pixels. */
export type Renderer = (ctx: CanvasRenderingContext2D, lm: Pt[]) => void;
export type Layer = { name: string; face: Renderer | null; hand: Renderer | null };
export type Palette = { name: string; layers: Layer[] };

type Conn = { start: number; end: number };

/** Open hand picks the first layer, closed fist the last. */
export function layerFor(p: Palette, fingers: number): Layer {
  const f = Math.min(5, Math.max(0, fingers));
  return p.layers[Math.round(((5 - f) / 5) * (p.layers.length - 1))];
}

const span = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Chain {start,end} pairs into one ordered ring of landmark indices. */
function ring(conns: Conn[]): number[] {
  if (!conns.length) return [];
  const next = new Map(conns.map((c) => [c.start, c.end]));
  const out = [conns[0].start];
  for (let i = next.get(out[0]); i !== undefined && i !== out[0]; i = next.get(i)) {
    if (out.length > conns.length) break; // malformed data: don't spin forever
    out.push(i);
  }
  return out;
}

function strokeConns(ctx: CanvasRenderingContext2D, lm: Pt[], conns: Conn[], w: number, colour: string) {
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.strokeStyle = colour;
  ctx.beginPath();
  for (const { start, end } of conns) {
    const a = lm[start];
    const b = lm[end];
    if (!a || !b) continue;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function path(ctx: CanvasRenderingContext2D, lm: Pt[], idx: number[]) {
  ctx.beginPath();
  idx.forEach((i, n) => (n ? ctx.lineTo(lm[i].x, lm[i].y) : ctx.moveTo(lm[i].x, lm[i].y)));
  ctx.closePath();
}

// Static in the bundle, so chain them once rather than every frame.
const OVAL = ring(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
const EYES = [
  ring(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
  ring(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE)
];

/** Face width, via the outer eye corners of the 468-point mesh. */
const faceScale = (lm: Pt[]) => span(lm[33], lm[263]) * 2.2;

const faceMuscle: Renderer = (ctx, lm) => {
  if (lm.length < 468) return;
  strokeConns(ctx, lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, faceScale(lm) / 220, 'rgba(150,38,38,0.75)');
  strokeConns(ctx, lm, FaceLandmarker.FACE_LANDMARKS_CONTOURS, faceScale(lm) / 90, 'rgba(92,16,16,0.9)');
};

const faceBone: Renderer = (ctx, lm) => {
  if (lm.length < 468 || OVAL.length < 3) return;
  const s = faceScale(lm);
  ctx.fillStyle = '#e8ddc8';
  path(ctx, lm, OVAL);
  ctx.fill();
  ctx.fillStyle = '#1a1512';
  for (const eye of EYES) {
    if (eye.length < 3) continue;
    path(ctx, lm, eye);
    ctx.fill();
  }
  strokeConns(ctx, lm, FaceLandmarker.FACE_LANDMARKS_LIPS, s / 70, '#3a322a');
  strokeConns(ctx, lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, s / 90, '#cbbda2');
};

/** Palm width, via wrist to middle-finger MCP. */
const handScale = (lm: Pt[]) => span(lm[0], lm[9]);

const handMuscle: Renderer = (ctx, lm) => {
  if (lm.length < 21) return;
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, handScale(lm) / 4, 'rgba(150,38,38,0.95)');
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, handScale(lm) / 14, 'rgba(206,92,92,0.9)');
};

const handBone: Renderer = (ctx, lm) => {
  if (lm.length < 21) return;
  const s = handScale(lm);
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 11, '#e8ddc8');
  ctx.fillStyle = '#fbf5e8';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s / 14, 0, Math.PI * 2);
    ctx.fill();
  }
};

export const ANATOMY: Palette = {
  name: 'anatomy',
  layers: [
    { name: 'skin', face: null, hand: null },
    { name: 'muscle', face: faceMuscle, hand: handMuscle },
    { name: 'bone', face: faceBone, hand: handBone }
  ]
};
