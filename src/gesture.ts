export type Pt = { x: number; y: number };

/**
 * Hands apart -> hands together cycles the skin. Two thresholds (hysteresis)
 * stop it flickering when the distance hovers on a single boundary.
 * ponytail: raw normalised distance, not scaled by face size — it drifts when
 * the user moves far from the camera. Upgrade: divide by inter-iris distance.
 */
export class ArmSwitch {
  #armed = false;
  #apart: number;
  #together: number;

  constructor(apart = 0.45, together = 0.25) {
    this.#apart = apart;
    this.#together = together;
  }

  /** Returns true on the frame the gesture completes. */
  update(a: Pt | null, b: Pt | null): boolean {
    if (!a || !b) {
      this.#armed = false;
      return false;
    }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > this.#apart) {
      this.#armed = true;
    } else if (d < this.#together && this.#armed) {
      this.#armed = false;
      return true;
    }
    return false;
  }
}
