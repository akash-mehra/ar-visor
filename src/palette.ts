import { FaceLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Pt } from './gesture';

/** What the face is doing, for layers that answer to it. */
export type Expression = { blink: boolean; mouth: boolean };

/** Landmarks arrive already converted to canvas pixels. */
export type Renderer = (
  ctx: CanvasRenderingContext2D,
  lm: Pt[],
  expr?: Expression
) => void;
export type Layer = { name: string; face: Renderer | null; hand: Renderer | null };
export type Palette = { name: string; layers: Layer[] };

type Conn = { start: number; end: number };

/** Open hand picks the first layer, closed fist the last. */
export function layerFor(p: Palette, fingers: number): Layer {
  const f = Math.min(5, Math.max(0, fingers));
  return p.layers[Math.round(((5 - f) / 5) * (p.layers.length - 1))];
}

/**
 * The layer swap, as a top-down reveal: the incoming layer is drawn above the
 * line and the outgoing one below it, so the new face wipes down over the old.
 * Swapping again mid-wipe restarts from the top against whatever was showing.
 */
export class Wipe {
  #ms: number;
  #from: Layer | null = null;
  #to: Layer | null = null;
  #start = 0;

  constructor(ms = 140) {
    this.#ms = ms;
  }

  /** `k` is 1 once the wipe is done, and `from` is then no longer drawn. */
  update(layer: Layer, now: number): { from: Layer | null; to: Layer; k: number } {
    if (layer !== this.#to) {
      this.#from = this.#to;
      this.#to = layer;
      this.#start = now;
    }
    const k = this.#from ? Math.min(1, Math.max(0, (now - this.#start) / this.#ms)) : 1;
    return { from: k < 1 ? this.#from : null, to: layer, k };
  }
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

/** Several closed rings as one path, so `clip("evenodd")` cuts the inner ones
 *  out of the outer — the face oval minus the eyes and the mouth. */
function rings(ctx: CanvasRenderingContext2D, lm: Pt[], sets: number[][]) {
  ctx.beginPath();
  for (const idx of sets) {
    if (idx.length < 3) continue;
    idx.forEach((i, n) => (n ? ctx.lineTo(lm[i].x, lm[i].y) : ctx.moveTo(lm[i].x, lm[i].y)));
    ctx.closePath();
  }
}

/** A ring grown about its own centre — the concentric bands that orbicularis
 *  muscle forms around the eyes and mouth, and the rim of a bony orbit. */
function grown(lm: Pt[], idx: number[], k: number): Pt[] {
  const cx = idx.reduce((n, i) => n + lm[i].x, 0) / idx.length;
  const cy = idx.reduce((n, i) => n + lm[i].y, 0) / idx.length;
  return idx.map((i) => ({ x: cx + (lm[i].x - cx) * k, y: cy + (lm[i].y - cy) * k }));
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function bounds(lm: Pt[], idx: number[]) {
  const xs = idx.map((i) => lm[i].x);
  const ys = idx.map((i) => lm[i].y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Stroke a shape three times, widest and faintest first, under `lighter`:
 *  the bloom around a bright structure on a radiograph. No ctx.filter blur,
 *  which is far too slow for a phone GPU at 30fps. */
function glow(ctx: CanvasRenderingContext2D, draw: () => void, w: number, rgb: string) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [mul, a] of [[3.2, 0.1], [1.8, 0.2], [1, 0.85]]) {
    ctx.lineWidth = w * mul;
    ctx.strokeStyle = `rgba(${rgb},${a})`;
    draw();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The tesselation ships as edges; the triangles are its 3-cycles. Derived once
 * at load, then every frame fills them — a shaded surface reads as tissue in a
 * way that strokes over the camera never do.
 */
function triangles(conns: Conn[]): [number, number, number][] {
  const adj = new Map<number, Set<number>>();
  for (const { start, end } of conns) {
    if (!adj.has(start)) adj.set(start, new Set());
    if (!adj.has(end)) adj.set(end, new Set());
    adj.get(start)!.add(end);
    adj.get(end)!.add(start);
  }
  const out: [number, number, number][] = [];
  for (const [a, na] of adj) {
    for (const b of na) {
      if (b <= a) continue;
      for (const c of adj.get(b)!) {
        if (c > b && na.has(c)) out.push([a, b, c]);
      }
    }
  }
  return out;
}

/** Up and to the left, angled towards the viewer. */
const LIGHT = { x: -0.35, y: -0.55, z: -0.76 };

/**
 * Lambert term for one triangle of the mesh, from the landmark depths. Taken
 * absolute, so the mesh's winding order never flips a facet dark.
 */
function lit(lm: Pt[], t: [number, number, number]): number {
  const a = lm[t[0]];
  const b = lm[t[1]];
  const c = lm[t[2]];
  const ux = b.x - a.x, uy = b.y - a.y, uz = (b.z ?? 0) - (a.z ?? 0);
  const vx = c.x - a.x, vy = c.y - a.y, vz = (c.z ?? 0) - (a.z ?? 0);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return Math.abs((nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) / len);
}

/**
 * Fill the whole mesh, shading each facet. Each triangle is stroked in its own
 * colour as well, or antialiasing leaves a hairline grid between the fills.
 */
function surface(
  ctx: CanvasRenderingContext2D,
  lm: Pt[],
  colour: (k: number) => string
) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;
  for (const t of TRIS) {
    const c = colour(lit(lm, t));
    ctx.fillStyle = c;
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(lm[t[0]].x, lm[t[0]].y);
    ctx.lineTo(lm[t[1]].x, lm[t[1]].y);
    ctx.lineTo(lm[t[2]].x, lm[t[2]].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * A photographic layer: an anatomical still, plus where the face mesh's
 * landmarks sit on it. Detected from the still itself rather than baked as a
 * table of numbers, so swapping the art needs no other change.
 */
export type Texture = { img: CanvasImageSource; uv: Pt[] };

let muscleTexture: Texture | null = null;
export const setMuscleTexture = (t: Texture | null) => {
  muscleTexture = t;
};

/**
 * Paint one mesh triangle of `tex` onto the same triangle of the live face.
 * Three point pairs fix an affine exactly, so the whole still is drawn under
 * that transform and clipped to the destination triangle.
 */
function textureTriangle(
  ctx: CanvasRenderingContext2D,
  tex: Texture,
  t: [number, number, number],
  lm: Pt[]
) {
  const s0 = tex.uv[t[0]], s1 = tex.uv[t[1]], s2 = tex.uv[t[2]];
  const d0 = lm[t[0]], d1 = lm[t[1]], d2 = lm[t[2]];
  const s1x = s1.x - s0.x, s1y = s1.y - s0.y;
  const s2x = s2.x - s0.x, s2y = s2.y - s0.y;
  const det = s1x * s2y - s2x * s1y;
  if (!det) return;
  const d1x = d1.x - d0.x, d1y = d1.y - d0.y;
  const d2x = d2.x - d0.x, d2y = d2.y - d0.y;
  const a = (d1x * s2y - d2x * s1y) / det;
  const b = (d1y * s2y - d2y * s1y) / det;
  const c = (d2x * s1x - d1x * s2x) / det;
  const d = (d2y * s1x - d1y * s2x) / det;

  ctx.save();
  ctx.beginPath();
  // Grown a hair about the centroid: neighbouring clips are antialiased, and
  // meeting them exactly leaves a hairline of camera showing along every edge.
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  for (let i = 0; i < 3; i++) {
    const p = [d0, d1, d2][i];
    const x = cx + (p.x - cx) * 1.06;
    const y = cy + (p.y - cy) * 1.06;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y);
  ctx.drawImage(tex.img, 0, 0);
  ctx.restore();
}

/** Bounding box of the live mesh, to skip triangles the frame cannot show. */
function meshBounds(lm: Pt[]) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const i of OVAL) {
    x0 = Math.min(x0, lm[i].x); x1 = Math.max(x1, lm[i].x);
    y0 = Math.min(y0, lm[i].y); y1 = Math.max(y1, lm[i].y);
  }
  return { x0, x1, y0, y1 };
}

const mix = (r: number, g: number, b: number, k: number, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;

// Static in the bundle, so chain them once rather than every frame.
const TRIS = triangles(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const OVAL = ring(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
const LIPS = ring(FaceLandmarker.FACE_LANDMARKS_LIPS);
const EYES = [
  ring(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE),
  ring(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE)
];
const BROWS = [
  ring(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW),
  ring(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW)
];
/** The face, with the eyes and mouth cut out of it. */
const OPENINGS = [OVAL, ...EYES, LIPS];

/**
 * How a layer meets the face underneath. `project` leaves the eyes and mouth
 * open, so the person reads through the tissue and can still emote.
 * `displace` covers the whole oval, replacing the face outright.
 */
export type Mode = 'project' | 'displace';
let mode: Mode = 'project';
export const setMode = (m: Mode) => {
  mode = m;
};

function clipFace(ctx: CanvasRenderingContext2D, lm: Pt[]) {
  if (mode === 'displace') {
    rings(ctx, lm, [OVAL]);
    ctx.clip();
  } else {
    rings(ctx, lm, OPENINGS);
    ctx.clip('evenodd');
  }
}

/** Face width, via the outer eye corners of the 468-point mesh. */
const faceScale = (lm: Pt[]) => span(lm[33], lm[263]) * 2.2;

/**
 * Face-local coordinates from three landmarks that barely move against the
 * skull: the two outer eye corners and the point of the chin. `u` runs 0 to 1
 * across the eye line, `v` 0 at the eyes to 1 at the chin, and the mapping
 * carries the head's position, scale, roll and some of its yaw. Detail baked
 * in this space therefore sits still on the face instead of boiling.
 */
const faceSpace = (lm: Pt[]) => {
  const a = lm[33];
  const b = lm[263];
  const c = lm[152];
  return (u: number, v: number): Pt => ({
    x: a.x + u * (b.x - a.x) + v * (c.x - a.x),
    y: a.y + u * (b.y - a.y) + v * (c.y - a.y)
  });
};

/** Deterministic, so every frame bakes the same pattern. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---------------------------------------------------------------- fat -----
// Adipose tissue is lobular: pale yellow globules packed inside a web of
// fibrous septa. Positions are baked once in face space and drawn through the
// live mapping.
const LOBULES = (() => {
  const r = rand(20260914);
  return Array.from({ length: 620 }, () => ({
    u: -0.55 + r() * 2.1,
    v: -1.75 + r() * 3.3,
    s: 0.016 + r() * 0.03,
    tint: r()
  }));
})();

const faceFat: Renderer = (ctx, lm) => {
  if (lm.length < 468 || OVAL.length < 3) return;
  const at = faceSpace(lm);
  const s = faceScale(lm);
  ctx.save();
  clipFace(ctx, lm);

  // Shaded adipose base, so the cheeks and brow keep their form.
  surface(ctx, lm, (k) => mix(232, 196, 108, 0.55 + k * 0.62));

  // Lobules: small globules packed inside a web of fibrous septa.
  for (const l of LOBULES) {
    const p = at(l.u, l.v);
    const r = l.s * s;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = l.tint > 0.7 ? 'rgba(248,226,150,0.5)'
      : l.tint > 0.4 ? 'rgba(226,190,98,0.45)'
      : 'rgba(198,158,68,0.45)';
    ctx.fill();
    ctx.lineWidth = Math.max(0.6, r * 0.16);
    ctx.strokeStyle = 'rgba(250,242,214,0.35)'; // septum, pale and fibrous
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x - r * 0.3, p.y - r * 0.32, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,250,226,0.3)'; // wet sheen
    ctx.fill();
  }

  rings(ctx, lm, [OVAL]);
  ctx.lineWidth = s / 55;
  ctx.strokeStyle = 'rgba(120,84,20,0.5)';
  ctx.stroke();
  ctx.restore();
};

// ------------------------------------------------------------- muscle -----
const faceMuscle: Renderer = (ctx, lm) => {
  if (lm.length < 468 || OVAL.length < 3) return;
  const s = faceScale(lm);
  ctx.save();
  clipFace(ctx, lm);

  // With an anatomical still loaded, paint it through the mesh: real muscle
  // beats anything drawn from primitives. Everything below is the fallback
  // for when the still is missing or no face was found on it.
  if (muscleTexture) {
    for (const t of TRIS) textureTriangle(ctx, muscleTexture, t, lm);
    rings(ctx, lm, [OVAL]);
    ctx.lineWidth = s / 50;
    ctx.strokeStyle = 'rgba(72,14,14,0.75)';
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Shaded muscle body. Darker and less even than fat, so the form reads.
  surface(ctx, lm, (k) => mix(158, 38, 34, 0.45 + k * 0.85));

  ctx.lineCap = 'round';

  // Orbicularis oculi and oris are sphincters: concentric bands around the
  // eye and the mouth, which is exactly what a grown ring gives.
  for (const idx of [...EYES, LIPS]) {
    if (idx.length < 3) continue;
    for (const k of [1.2, 1.5, 1.85, 2.25, 2.7]) {
      poly(ctx, grown(lm, idx, k));
      ctx.lineWidth = s / 80;
      ctx.strokeStyle = 'rgba(120,20,18,0.55)'; // the gap between bands
      ctx.stroke();
      ctx.lineWidth = s / 190;
      ctx.strokeStyle = 'rgba(238,146,136,0.5)';
      ctx.stroke();
    }
  }

  // Tendinous sheet over the crown, paler than the muscle bellies below it.
  for (const idx of BROWS) {
    if (idx.length < 2) continue;
    poly(ctx, grown(lm, idx, 1.15));
    ctx.lineWidth = s / 60;
    ctx.strokeStyle = 'rgba(198,74,66,0.5)';
    ctx.stroke();
  }

  rings(ctx, lm, [OVAL]);
  ctx.lineWidth = s / 50;
  ctx.strokeStyle = 'rgba(72,14,14,0.75)';
  ctx.stroke();
  ctx.restore();
};

// --------------------------------------------------------------- bone -----
// A radiograph, not a prop skull: the face goes dark and dense tissue lights
// up through it, brightest where the head is thickest.
const faceBone: Renderer = (ctx, lm) => {
  if (lm.length < 468 || OVAL.length < 3) return;
  const at = faceSpace(lm);
  const s = faceScale(lm);
  const BONE = '198,224,255';

  ctx.save();
  rings(ctx, lm, [OVAL]);
  ctx.clip();
  rings(ctx, lm, [OVAL]);
  ctx.fillStyle = 'rgba(3,7,14,0.96)'; // the film behind everything
  ctx.fill();

  // Exposure through the head: the shading term stands in for thickness. Kept
  // dim, so the dense structures below are what actually read.
  surface(ctx, lm, (k) => `rgba(${BONE},${0.04 + k * 0.16})`);

  // Orbits stay dark: there is no bone in a socket.
  for (const idx of EYES) {
    if (idx.length < 3) continue;
    const socket = grown(lm, idx, 2.3);
    poly(ctx, socket);
    ctx.fillStyle = 'rgba(1,3,7,0.9)';
    ctx.fill();
    glow(ctx, () => poly(ctx, socket), s / 40, BONE);
  }

  // Piriform aperture: the pear-shaped hole where the nose was.
  const nose = [at(0.5, 0.1), at(0.575, 0.42), at(0.545, 0.52), at(0.5, 0.48), at(0.455, 0.52), at(0.425, 0.42)];
  poly(ctx, nose);
  ctx.fillStyle = 'rgba(1,3,7,0.92)';
  ctx.fill();
  glow(ctx, () => poly(ctx, nose), s / 52, BONE);

  // Supraorbital ridge and the zygomatic arches, the dense edges of the face.
  for (const idx of BROWS) {
    if (idx.length >= 2) glow(ctx, () => poly(ctx, grown(lm, idx, 1.1)), s / 50, BONE);
  }
  for (const side of [0, 1]) {
    const p = at(side ? 0.88 : 0.12, 0.14);
    const q = at(side ? 1.02 : -0.02, 0.0);
    glow(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo((p.x + q.x) / 2, p.y + s * 0.05, q.x, q.y);
    }, s / 46, BONE);
  }
  glow(ctx, () => rings(ctx, lm, [OVAL]), s / 30, BONE);

  // Teeth: two arcs of enamel, the densest thing on the film.
  if (LIPS.length >= 3) {
    const m = bounds(lm, LIPS);
    const w = m.x1 - m.x0;
    const mid = (m.y0 + m.y1) / 2;
    for (const row of [-1, 1]) {
      for (let i = 0; i < 11; i++) {
        const cx = m.x0 + w * (0.06 + (i / 10) * 0.88);
        const arc = Math.pow((i - 5) / 5, 2) * s * 0.022 * row;
        const cy = mid + row * s * 0.032 + arc;
        const tw = w * 0.045;
        glow(ctx, () => {
          ctx.beginPath();
          ctx.roundRect(cx - tw / 2, cy - s * 0.02, tw, s * 0.04, s * 0.005);
        }, s / 220, '242,248,255');
      }
    }
  }
  ctx.restore();
};

// --------------------------------------------------------------- hands ----
/** Palm width, via wrist to middle-finger MCP. */
const handScale = (lm: Pt[]) => span(lm[0], lm[9]);

const handFat: Renderer = (ctx, lm) => {
  if (lm.length < 21) return;
  const s = handScale(lm);
  // One padded pass, then a narrower lighter one: fat over the tendons.
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 2.6, '#c69a3c');
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 3.4, '#e7c469');
  ctx.fillStyle = 'rgba(255,247,214,0.35)';
  for (const i of [0, 5, 9, 13, 17]) {
    ctx.beginPath();
    ctx.arc(lm[i].x - s * 0.05, lm[i].y - s * 0.05, s / 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
};

const handMuscle: Renderer = (ctx, lm) => {
  if (lm.length < 21) return;
  const s = handScale(lm);
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 3.4, 'rgba(102,22,22,0.95)');
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 5, 'rgba(186,56,52,0.95)');
  strokeConns(ctx, lm, HandLandmarker.HAND_CONNECTIONS, s / 16, 'rgba(240,150,142,0.6)');
  // Thenar eminence: the muscle bulge at the base of the thumb.
  ctx.beginPath();
  ctx.moveTo(lm[0].x, lm[0].y);
  ctx.quadraticCurveTo(lm[1].x, lm[1].y, lm[2].x, lm[2].y);
  ctx.quadraticCurveTo(lm[5].x, lm[5].y, lm[0].x, lm[0].y);
  ctx.fillStyle = 'rgba(150,38,38,0.95)';
  ctx.fill();
};

const handBone: Renderer = (ctx, lm) => {
  if (lm.length < 21) return;
  const s = handScale(lm);
  const BONE = '196,222,255';
  // Carpals: one dense mass at the heel of the hand.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(lm[0].x, lm[0].y, 0, lm[0].x, lm[0].y, s * 0.55);
  g.addColorStop(0, `rgba(${BONE},0.75)`);
  g.addColorStop(1, `rgba(${BONE},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(lm[0].x, lm[0].y, s * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  glow(ctx, () => {
    ctx.beginPath();
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(lm[start].x, lm[start].y);
      ctx.lineTo(lm[end].x, lm[end].y);
    }
  }, s / 7, BONE);

  // Joints read brighter than the shafts on a real hand film.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgba(${BONE},0.5)`;
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s / 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

export const ANATOMY: Palette = {
  name: 'anatomy',
  layers: [
    { name: 'skin', face: null, hand: null },
    { name: 'subcutaneous fat', face: faceFat, hand: handFat },
    { name: 'muscle', face: faceMuscle, hand: handMuscle },
    { name: 'bone', face: faceBone, hand: handBone }
  ]
};
