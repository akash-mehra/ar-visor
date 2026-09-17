/** `z` is MediaPipe's depth, in roughly the same units as x, where it is
 *  available: face landmarks carry it, and the layer renderers shade with it. */
export type Pt = { x: number; y: number; z?: number };

const d2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * Extended fingers on one MediaPipe hand (21 landmarks, canvas pixels).
 *
 * Four fingers: the tip sits further from the wrist than its PIP joint. That
 * comparison is scale- and rotation-free, so it holds whichever way the hand
 * is turned. The thumb folds sideways instead of curling, so it is measured
 * against the pinky MCP it folds towards.
 */
export function countExtended(lm: Pt[]): number {
  if (lm.length < 21) return 0;
  let n = d2(lm[4], lm[17]) > d2(lm[3], lm[17]) ? 1 : 0;
  for (const tip of [8, 12, 16, 20]) {
    if (d2(lm[0], lm[tip]) > d2(lm[0], lm[tip - 2])) n++;
  }
  return n;
}

/**
 * Finger count with a hold: a new count only takes effect once it has been
 * seen on `hold` consecutive frames. Folding five fingers down to one passes
 * through four, three and two too fast to commit, so the layers in between
 * never flash.
 */
export class FingerCount {
  #hold: number;
  #seen = -1;
  #streak = 0;
  #count: number;

  constructor(hold = 4, initial = 5) {
    this.#hold = hold;
    this.#count = initial;
  }

  /** `null` means no hand: hold the current count rather than snapping back. */
  update(raw: number | null): number {
    if (raw === null || raw === this.#count) {
      this.#seen = -1;
      this.#streak = 0;
      return this.#count;
    }
    this.#streak = raw === this.#seen ? this.#streak + 1 : 1;
    this.#seen = raw;
    if (this.#streak >= this.#hold) this.#count = raw;
    return this.#count;
  }
}

/**
 * The two corners each hand makes when it frames a shot: the thumb tip and
 * the index fingertip, the ends of the "L". Nothing else on the hand touches
 * the frame, so the other fingers are free to carry the pose that picks the
 * layer, and closing the hand narrows the frame instead of moving it.
 */
const THUMB_TIP = 4;
const INDEX_TIP = 8;

/**
 * The frame the two hands hold. Each hand contributes its two anchors as one
 * edge, upper point first, and the four make a quad that leans and resizes
 * with them. Null without two usable hands, or when both hands sit at the
 * same place and leave no width to frame.
 */
export function frameQuad(hands: Pt[][]): Pt[] | null {
  const sides = hands
    .filter((lm) => lm.length >= 21)
    .slice(0, 2)
    .map((lm) => {
      const a = lm[THUMB_TIP];
      const b = lm[INDEX_TIP];
      return a.y <= b.y ? { top: a, bottom: b } : { top: b, bottom: a };
    })
    .sort((p, q) => p.top.x + p.bottom.x - (q.top.x + q.bottom.x));
  if (sides.length < 2) return null;
  const [a, b] = sides;
  if (b.top.x + b.bottom.x <= a.top.x + a.bottom.x) return null;
  return [a.top, b.top, b.bottom, a.bottom];
}

/**
 * Schmitt trigger. A blink score crosses any single threshold several times
 * on the way through, so one would chatter the art on and off; rising at `hi`
 * and only falling at `lo` makes the state stick.
 */
export class Latch {
  #hi: number;
  #lo: number;
  #on = false;

  constructor(hi = 0.5, lo = 0.3) {
    this.#hi = hi;
    this.#lo = lo;
  }

  update(v: number): boolean {
    if (v >= this.#hi) this.#on = true;
    else if (v <= this.#lo) this.#on = false;
    return this.#on;
  }
}

export type Box = { x: number; y: number; w: number; h: number };

/** Axis-aligned bounds of the frame, clamped to the canvas. */
export function boundsOf(quad: Pt[], w: number, h: number): Box {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  return {
    x,
    y,
    w: Math.min(w, Math.ceil(Math.max(...xs))) - x,
    h: Math.min(h, Math.ceil(Math.max(...ys))) - y
  };
}

/** A direction or point in the landmark space, y-up and right-handed. */
export type Vec3 = { x: number; y: number; z: number };

/**
 * The head's own axes, read off four rigid landmarks.
 *
 * MediaPipe also hands out a 4x4 head-pose matrix, but its row/column order
 * is the sort of thing that is only settled by a device, and a transposed
 * rotation is its own inverse — the head would turn the wrong way and the
 * code would look right. Four landmarks we already convert every frame give
 * the same basis with nothing to get backwards, and they can be checked here
 * against numbers rather than against a tablet.
 *
 * 234 and 454 are the face oval at its widest, 10 the forehead and 152 the
 * chin: all four sit on bone, so expression does not move them.
 *
 * `width` is measured in 3D, so it holds up as the head turns — the 2D
 * distance between the temples collapses on a profile.
 */
export type Basis = { right: Vec3; up: Vec3; forward: Vec3; centre: Vec3; width: number };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x
});
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => {
  const n = len(a);
  return n < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: a.x / n, y: a.y / n, z: a.z / n };
};

export function faceBasis(lm: Pt[]): Basis | null {
  if (lm.length < 468) return null;
  // Canvas y grows downward and MediaPipe's z grows away from the camera;
  // both are flipped here so the basis comes out right-handed and y-up, which
  // is what glTF models are authored in.
  const v = (i: number): Vec3 => ({ x: lm[i].x, y: -lm[i].y, z: -(lm[i].z ?? 0) });
  const l = v(454), r = v(234), top = v(10), chin = v(152);

  const right = unit(sub(l, r));
  const up0 = unit(sub(top, chin));
  // Cross first, then rebuild up from it: the temple-to-temple and
  // chin-to-forehead lines are close to perpendicular but never exactly, and
  // an un-squared basis shears the model.
  const forward = unit(cross(right, up0));
  if (len(forward) < 1e-9) return null;
  const up = cross(forward, right);

  return {
    right,
    up,
    forward,
    centre: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, z: (l.z + r.z) / 2 },
    width: len(sub(l, r))
  };
}

// ------------------------------------------------------- study gestures ---
const WRIST = 0;
const MIDDLE_MCP = 9;

/** Palm length, as the yardstick every hand measurement is taken against. */
const palmOf = (lm: Pt[]) => Math.hypot(lm[WRIST].x - lm[MIDDLE_MCP].x, lm[WRIST].y - lm[MIDDLE_MCP].y);

/**
 * Both hands carrying the frame out through the left and right edges — what
 * blows the skull apart.
 *
 * Tracking does not end tidily. One hand is usually lost a frame or two
 * before the other, so a snapshot taken at the moment the count reaches zero
 * often holds only one of them and the gesture is missed. Each side is
 * therefore remembered with a time of its own, and the trigger is both sides
 * having gone recently with nothing left on screen. Leaving through the top
 * or bottom never fires it, because neither wrist was near a lateral edge.
 */
export class LateralExit {
  #edge: number;
  #window: number;
  #left = -Infinity;
  #right = -Infinity;

  /** `edge` as a fraction of the width; `window` in milliseconds. */
  constructor(edge = 0.2, window = 700) {
    this.#edge = edge;
    this.#window = window;
  }

  /** True on the frame the gesture completes, and only that frame. */
  update(hands: Pt[][], w: number, t: number): boolean {
    for (const lm of hands) {
      if (lm.length < 21) continue;
      const x = lm[WRIST].x;
      if (x < w * this.#edge) this.#left = t;
      else if (x > w * (1 - this.#edge)) this.#right = t;
    }
    // A hand still on screen means the pair has not left yet.
    if (hands.length > 0) return false;
    const since = t - this.#window;
    if (this.#left < since || this.#right < since) return false;
    this.#left = this.#right = -Infinity; // spent, so it fires once
    return true;
  }
}

/**
 * Thumb and index tips brought together, and the point between them. Measured
 * against the palm, so it reads the same near the camera or far from it.
 */
export function pinch(lm: Pt[], shut = 0.45): Pt | null {
  if (lm.length < 21) return null;
  const a = lm[THUMB_TIP];
  const b = lm[INDEX_TIP];
  const palm = palmOf(lm);
  if (palm < 1 || Math.hypot(a.x - b.x, a.y - b.y) > palm * shut) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Two hands brought together. The gap runs through a Latch so a hand
 * hovering at the threshold cannot rattle off a dozen claps, and the closing
 * edge is what fires rather than the state — a clap is an event, and holding
 * your hands together is not a dozen of them.
 */
export class Clap {
  #latch = new Latch(0.62, 0.38);
  #shut = false;
  #span: number;

  /** How far apart, in palm lengths, still counts as open. */
  constructor(span = 2.2) {
    this.#span = span;
  }

  /** True on the frame the hands meet, and only that frame. */
  update(hands: Pt[][]): boolean {
    const [a, b] = hands;
    if (!a || !b || a.length < 21 || b.length < 21) {
      this.#latch.update(0);
      this.#shut = false;
      return false;
    }
    const palm = (palmOf(a) + palmOf(b)) / 2;
    const gap = Math.hypot(a[WRIST].x - b[WRIST].x, a[WRIST].y - b[WRIST].y);
    const near = palm < 1 ? 0 : 1 - Math.min(1, gap / (palm * this.#span));
    const shut = this.#latch.update(near);
    const clap = shut && !this.#shut;
    this.#shut = shut;
    return clap;
  }
}
