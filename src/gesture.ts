export type Pt = { x: number; y: number };

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
 * The frame the two hands hold: each hand gives the inner edge of its
 * landmark box, top and bottom, and the four make a quad that leans with
 * them. Null without two usable hands, or when the hands overlap and leave
 * no gap between their inner edges.
 */
export function frameQuad(hands: Pt[][]): Pt[] | null {
  const boxes = hands
    .filter((lm) => lm.length >= 21)
    .slice(0, 2)
    .map((lm) => ({
      lo: Math.min(...lm.map((p) => p.x)),
      hi: Math.max(...lm.map((p) => p.x)),
      top: Math.min(...lm.map((p) => p.y)),
      bottom: Math.max(...lm.map((p) => p.y))
    }))
    .sort((a, b) => a.lo - b.lo);
  if (boxes.length < 2) return null;
  const [a, b] = boxes;
  if (b.lo <= a.hi) return null;
  return [
    { x: a.hi, y: a.top },
    { x: b.lo, y: b.top },
    { x: b.lo, y: b.bottom },
    { x: a.hi, y: a.bottom }
  ];
}
