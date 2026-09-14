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
