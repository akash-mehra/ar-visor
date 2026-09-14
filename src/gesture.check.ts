// Checks for gesture.ts and palette.ts. Run: npm test
import assert from 'node:assert/strict';
import { FingerCount, countExtended, type Pt } from './gesture.ts';
import { ANATOMY, layerFor } from './palette.ts';

/**
 * Synthetic hand, fingers pointing up the -y axis. `up` is
 * [thumb, index, middle, ring, pinky]; a folded finger curls its tip back
 * towards the MCP, a folded thumb lies across the palm near the pinky.
 */
function hand(up: boolean[]): Pt[] {
  const lm: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  [1, 2, 3, 4].forEach((col, f) => {
    const base = 5 + f * 4;
    const ext = up[f + 1];
    lm[base] = { x: col, y: -1 };                  // MCP
    lm[base + 1] = { x: col, y: -2 };              // PIP
    lm[base + 2] = { x: col, y: ext ? -3 : -1.5 }; // DIP
    lm[base + 3] = { x: col, y: ext ? -4 : -1.2 }; // TIP
  });
  lm[3] = { x: up[0] ? -1 : 2, y: -1 };
  lm[4] = { x: up[0] ? -2 : 3, y: -1 };
  return lm;
}

const open = [true, true, true, true, true];
const fist = [false, false, false, false, false];

assert.equal(countExtended(hand(open)), 5, 'open hand is five');
assert.equal(countExtended(hand(fist)), 0, 'fist is zero');
assert.equal(countExtended(hand([false, true, true, true, true])), 4, 'thumb folds alone');
assert.equal(countExtended(hand([true, false, false, false, false])), 1, 'thumb extends alone');
assert.equal(countExtended(hand([false, true, false, false, false])), 1, 'index only');
assert.equal(countExtended([]), 0, 'a short landmark list is not a hand');

// The hold: a count has to survive `hold` frames before it takes effect.
const c = new FingerCount(3);
assert.equal(c.update(5), 5, 'starts open');
assert.equal(c.update(2), 5, 'one frame does not commit');
assert.equal(c.update(2), 5, 'two frames do not commit');
assert.equal(c.update(2), 2, 'three frames commit');

// Folding straight past the middle counts must not land on them.
const f = new FingerCount(3);
for (const n of [4, 3, 2, 1]) f.update(n);
assert.equal(f.update(1), 5, 'a fast fold commits nothing yet');
assert.equal(f.update(1), 1, 'holding the final count commits it');

// A lost hand holds the layer rather than snapping back to skin.
const h = new FingerCount(2);
for (const n of [0, 0]) h.update(n);
assert.equal(h.update(null), 0, 'no hand keeps the last count');

// layerFor: open hand is the first layer, fist the last, whatever the length.
assert.equal(layerFor(ANATOMY, 5).name, 'skin');
assert.equal(layerFor(ANATOMY, 3).name, 'muscle');
assert.equal(layerFor(ANATOMY, 0).name, 'bone');
assert.equal(layerFor(ANATOMY, 99).name, 'skin', 'out-of-range count is clamped');
assert.equal(layerFor(ANATOMY, -1).name, 'bone', 'out-of-range count is clamped');

// The bone face needs FACE_OVAL chained into an ordered ring before it can be
// filled; a broken chain draws nothing at all rather than failing.
const calls: Record<string, number> = {};
const rec = (k: string) => () => (calls[k] = (calls[k] ?? 0) + 1);
const ctx = {
  beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
  closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'), arc: rec('arc'),
  fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: ''
} as unknown as CanvasRenderingContext2D;

const faceLm: Pt[] = Array.from({ length: 478 }, (_, i) => ({ x: (i % 20) * 5, y: Math.floor(i / 20) * 5 }));
layerFor(ANATOMY, 0).face!(ctx, faceLm);
assert.equal(calls.closePath, 3, 'the oval and both eye sockets close into rings');
assert.equal(calls.fill, 3, 'and all three get filled');
// A ring that chained only part way still closes and fills, so hold the segment
// count too: a truncated oval drops ~30 of these.
assert.ok(calls.lineTo >= 120, `ring chained short, drew only ${calls.lineTo} segments`);

console.log('gesture + palette checks passed');
