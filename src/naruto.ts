import type { Pt } from './gesture';
import type { Palette, Renderer } from './palette';

/**
 * Measured off the master drawing, 1100x825: the iris centres the plate is
 * anchored by, and the eye openings the closed-lid pass paints over. Every
 * state is exported from that same drawing, so one set of numbers serves all
 * of them — which is also why a state from a different illustration cannot be
 * used, however close it looks.
 */
const ART_W = 1100;
const ART_EYES = [
  { x: 457, y: 368, rx: 34, ry: 21 },
  { x: 627, y: 370, rx: 34, ry: 21 }
];
const SKIN = '#e3c1b0'; // sampled off the drawing's cheek
const INK = '#181110';

// FaceLandmarker's refined points: 468 left iris centre, 473 right.
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

type Eye = (typeof ART_EYES)[number];
let art: { rest: CanvasImageSource; talk: CanvasImageSource } | null = null;
let eyes: Eye[] = ART_EYES;

/**
 * The whole canvas is drawn through a mirror, so art drawn straight onto it
 * comes out reversed and the headband reads backwards. Flipping each still
 * once at load cancels that, and keeps the draw a plain similarity rather
 * than a reflection to reason about every frame.
 */
function mirror(img: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.translate(w, 0);
  x.scale(-1, 1);
  x.drawImage(img, 0, 0);
  return c;
}

export function setItachi(rest: HTMLImageElement | null, talk: HTMLImageElement | null) {
  if (!rest || !talk) {
    art = null;
    return;
  }
  art = {
    rest: mirror(rest, rest.naturalWidth, rest.naturalHeight),
    talk: mirror(talk, talk.naturalWidth, talk.naturalHeight)
  };
  eyes = ART_EYES.map((e) => ({ ...e, x: ART_W - e.x }));
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Anime shuts an eye with a skin fill and one curved stroke, which is why the
 * blink state needs no art of its own. Drawn in the drawing's own coordinates
 * under the plate's transform, so it scales and leans with the head.
 */
function shutEyes(ctx: CanvasRenderingContext2D) {
  for (const e of eyes) {
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, e.rx, e.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = SKIN;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(e.x - e.rx, e.y - e.ry * 0.2);
    ctx.quadraticCurveTo(e.x, e.y + e.ry * 0.9, e.x + e.rx, e.y - e.ry * 0.35);
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

/**
 * Two point pairs fix a similarity, so the drawing's irises landing on the
 * face's irises carries position, scale and roll together. Sorting both pairs
 * by x pairs them consistently whichever way the head is turned.
 */
const itachi: Renderer = (ctx, lm, expr) => {
  if (!art || lm.length <= RIGHT_IRIS) return;
  const usr = [lm[LEFT_IRIS], lm[RIGHT_IRIS]].sort((p, q) => p.x - q.x);
  const src = [...eyes].sort((p, q) => p.x - q.x);
  const uv = { x: usr[1].x - usr[0].x, y: usr[1].y - usr[0].y };
  const av = { x: src[1].x - src[0].x, y: src[1].y - src[0].y };
  const k = Math.hypot(uv.x, uv.y) / Math.hypot(av.x, av.y);
  if (!Number.isFinite(k) || k <= 0) return;
  const um = mid(usr[0], usr[1]);
  const am = mid(src[0], src[1]);

  ctx.save();
  ctx.translate(um.x, um.y);
  ctx.rotate(Math.atan2(uv.y, uv.x) - Math.atan2(av.y, av.x));
  ctx.scale(k, k);
  ctx.translate(-am.x, -am.y);
  ctx.drawImage(expr?.mouth ? art.talk : art.rest, 0, 0);
  if (expr?.blink) shutEyes(ctx);
  ctx.restore();
};

export const NARUTO: Palette = {
  name: 'naruto',
  layers: [{ name: 'itachi', face: itachi, hand: null }]
};
