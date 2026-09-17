// Checks for gesture.ts and palette.ts. Run: npm test
import assert from 'node:assert/strict';
import {
  FingerCount,
  Latch,
  boundsOf,
  countExtended,
  faceBasis,
  frameQuad,
  type Pt,
  type Vec3
} from './gesture.ts';
import { ANATOMY, Wipe, layerFor, setMode } from './palette.ts';

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

// The four poses the layers are keyed to: whole hand, drop the ring and little
// fingers, drop the middle too, then close the fist.
assert.equal(layerFor(ANATOMY, 5).name, 'skin', 'all five: bare camera');
assert.equal(layerFor(ANATOMY, 3).name, 'muscle', 'thumb, index, middle');
assert.equal(layerFor(ANATOMY, 2).name, 'bone', 'thumb and index');
assert.equal(layerFor(ANATOMY, 0).name, 'bone', 'fist');
// The counts in between still land somewhere sensible rather than nowhere.
assert.equal(layerFor(ANATOMY, 4).name, 'muscle');
assert.equal(layerFor(ANATOMY, 1).name, 'bone');
assert.equal(layerFor(ANATOMY, 2.4).name, 'bone', 'a fractional count still lands on a layer');
assert.equal(layerFor(ANATOMY, 99).name, 'skin', 'out-of-range count is clamped');
assert.equal(layerFor(ANATOMY, -1).name, 'bone', 'out-of-range count is clamped');

// The frame hangs off the thumb tip and index fingertip of each hand — the
// ends of the "L" — and nothing else on the hand touches it.
const lHand = (thumb: Pt, index: Pt): Pt[] =>
  Array.from({ length: 21 }, (_, i) => (i === 4 ? thumb : i === 8 ? index : { x: 999, y: 999 }));

assert.deepEqual(
  frameQuad([
    lHand({ x: 10, y: 40 }, { x: 12, y: 0 }),
    lHand({ x: 62, y: 50 }, { x: 60, y: 10 })
  ]),
  [{ x: 12, y: 0 }, { x: 60, y: 10 }, { x: 62, y: 50 }, { x: 10, y: 40 }],
  'upper anchors along the top, lower along the bottom, each side its own height'
);
assert.deepEqual(
  frameQuad([
    lHand({ x: 62, y: 50 }, { x: 60, y: 10 }),
    lHand({ x: 10, y: 40 }, { x: 12, y: 0 })
  ]),
  frameQuad([
    lHand({ x: 10, y: 40 }, { x: 12, y: 0 }),
    lHand({ x: 62, y: 50 }, { x: 60, y: 10 })
  ]),
  'detection order does not flip the quad'
);
// Whichever of the two is higher leads, so an inverted hand still frames.
assert.deepEqual(
  frameQuad([
    lHand({ x: 12, y: 0 }, { x: 10, y: 40 }),
    lHand({ x: 60, y: 10 }, { x: 62, y: 50 })
  ]),
  [{ x: 12, y: 0 }, { x: 60, y: 10 }, { x: 62, y: 50 }, { x: 10, y: 40 }],
  'thumb above index frames the same box'
);
// Every other landmark is ignored: the pose that picks the layer must not
// drag the frame around.
const noisy = lHand({ x: 10, y: 40 }, { x: 12, y: 0 });
noisy[20] = { x: -500, y: -500 };
noisy[0] = { x: 500, y: 500 };
assert.deepEqual(
  frameQuad([noisy, lHand({ x: 62, y: 50 }, { x: 60, y: 10 })]),
  frameQuad([lHand({ x: 10, y: 40 }, { x: 12, y: 0 }), lHand({ x: 62, y: 50 }, { x: 60, y: 10 })]),
  'the other fingers and the wrist do not move the frame'
);
assert.equal(frameQuad([lHand({ x: 10, y: 40 }, { x: 12, y: 0 })]), null, 'one hand holds no frame');
assert.equal(frameQuad([]), null, 'no hands, no frame');
assert.equal(
  frameQuad([lHand({ x: 10, y: 40 }, { x: 12, y: 0 }), lHand({ x: 10, y: 50 }, { x: 12, y: 10 })]),
  null,
  'hands at the same place leave no width to frame'
);
assert.equal(
  frameQuad([lHand({ x: 10, y: 40 }, { x: 12, y: 0 }), [{ x: 60, y: 10 }]]),
  null,
  'a partial landmark list is not a hand'
);

// The wipe reveals the incoming layer from the top over the outgoing one.
const [skin, , muscle, bone] = ANATOMY.layers;
const w = new Wipe(100);
assert.deepEqual(w.update(skin, 0), { from: null, to: skin, k: 1 }, 'first layer does not wipe in');
assert.deepEqual(w.update(skin, 50), { from: null, to: skin, k: 1 }, 'no change, no wipe');

let step = w.update(muscle, 100);
assert.equal(step.from, skin, 'the outgoing layer keeps drawing');
assert.equal(step.k, 0, 'and covers everything at the start');
assert.equal(w.update(muscle, 150).k, 0.5, 'halfway');
assert.deepEqual(w.update(muscle, 200), { from: null, to: muscle, k: 1 }, 'done, outgoing dropped');
assert.equal(w.update(muscle, 5000).k, 1, 'k stays clamped past the end');

// Swapping mid-wipe restarts against whatever is on screen, not the layer the
// interrupted wipe started from.
const w2 = new Wipe(100);
w2.update(skin, 0);
w2.update(muscle, 100);
assert.equal(w2.update(muscle, 150).k, 0.5, 'wipe still running');
step = w2.update(bone, 150);
assert.equal(step.from, muscle, 'restarts from the layer coming in, not skin');
assert.equal(step.k, 0, 'and from the top');

// Every drawn layer leans on FACE_OVAL being chained into an ordered ring
// before it can be clipped or filled; a broken chain draws nothing at all
// rather than failing, so count what each renderer actually puts on a canvas.
function spy() {
  const calls: Record<string, number> = {};
  const rec = (k: string) => () => (calls[k] = (calls[k] ?? 0) + 1);
  const ctx = {
    beginPath: rec('beginPath'), moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    closePath: rec('closePath'), fill: rec('fill'), stroke: rec('stroke'),
    arc: rec('arc'), roundRect: rec('roundRect'), quadraticCurveTo: rec('quadraticCurveTo'),
    clip: rec('clip'), save: rec('save'), restore: rec('restore'),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '', strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '',
    globalCompositeOperation: ''
  } as unknown as CanvasRenderingContext2D;
  return { calls, ctx };
}

const faceLm: Pt[] = Array.from({ length: 478 }, (_, i) => ({ x: (i % 20) * 5, y: Math.floor(i / 20) * 5 }));
const handLm: Pt[] = Array.from({ length: 21 }, (_, i) => ({ x: i * 3, y: (i % 5) * 7 }));

for (const l of ANATOMY.layers.slice(1)) {
  const f = spy();
  l.face!(f.ctx, faceLm);
  assert.ok(f.calls.clip >= 1, `${l.name} face must clip to the oval`);
  assert.ok(f.calls.fill >= 1, `${l.name} face drew no fill`);
  // A ring chained only part way still closes, so hold the segment count too:
  // a truncated oval drops ~30 of these.
  assert.ok(f.calls.lineTo >= 120, `${l.name} ring chained short (${f.calls.lineTo} segments)`);
  assert.equal(f.calls.save, f.calls.restore, `${l.name} face leaked a canvas state`);

  const h = spy();
  l.hand!(h.ctx, handLm);
  assert.ok((h.calls.stroke ?? 0) + (h.calls.fill ?? 0) >= 2, `${l.name} hand drew nothing`);
  assert.equal(h.calls.save, h.calls.restore, `${l.name} hand leaked a canvas state`);
}

// Displace covers the whole oval; project cuts the eyes and mouth back out of
// it, which is three more closed rings in the clip path.
const clipped = ANATOMY.layers.find((l) => l.name === 'muscle')!;
const projected = spy();
setMode('project');
clipped.face!(projected.ctx, faceLm);
const displaced = spy();
setMode('displace');
clipped.face!(displaced.ctx, faceLm);
setMode('project');
assert.ok(
  displaced.calls.closePath < projected.calls.closePath,
  `displace should close fewer rings than project (${displaced.calls.closePath} vs ${projected.calls.closePath})`
);
assert.ok(displaced.calls.fill >= 1, 'displace still fills the face');

// The frame's bounds size whatever draws into it, so they must stay inside
// the canvas however far outside it a hand reaches.
assert.deepEqual(
  boundsOf([{ x: 10, y: 20 }, { x: 60, y: 30 }, { x: 60, y: 90 }, { x: 10, y: 80 }], 200, 200),
  { x: 10, y: 20, w: 50, h: 70 },
  'plain bounds of the quad'
);
assert.deepEqual(
  boundsOf([{ x: -40, y: -10 }, { x: 400, y: 5 }, { x: 400, y: 300 }, { x: -40, y: 290 }], 200, 150),
  { x: 0, y: 0, w: 200, h: 150 },
  'a quad past every edge clamps to the canvas'
);

// The latch holds through the dead zone: a blink score crosses any single
// threshold several times on the way, and would chatter the art on and off.
const latch = new Latch(0.5, 0.3);
assert.equal(latch.update(0), false, 'starts off');
assert.equal(latch.update(0.45), false, 'below the rise');
assert.equal(latch.update(0.55), true, 'rises');
assert.equal(latch.update(0.4), true, 'holds in the dead zone');
assert.equal(latch.update(0.31), true, 'still holds just above the fall');
assert.equal(latch.update(0.3), false, 'falls');
assert.equal(latch.update(0.4), false, 'and stays off in the dead zone');

// --------------------------------------------------------------- pose -----
// A synthetic head. The four landmarks faceBasis reads are placed by rotating
// a canonical front-facing set, so the basis it recovers can be checked
// against the rotation that produced it rather than against a tablet.
function head(yaw = 0, roll = 0): Pt[] {
  const lm: Pt[] = Array.from({ length: 468 }, () => ({ x: 0, y: 0, z: 0 }));
  // Canvas pixels: x right, y down, z away from the camera.
  const put = (i: number, x: number, y: number, z: number) => {
    const xr = x * Math.cos(yaw) + z * Math.sin(yaw);
    const zr = -x * Math.sin(yaw) + z * Math.cos(yaw);
    lm[i] = {
      x: 200 + xr * Math.cos(roll) - y * Math.sin(roll),
      y: 200 + xr * Math.sin(roll) + y * Math.cos(roll),
      z: zr
    };
  };
  put(234, -50, 0, 0); // the subject's right temple, to the left in the image
  put(454, 50, 0, 0);
  put(10, 0, -60, 0); // forehead
  put(152, 0, 60, 0); // chin
  return lm;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const near = (got: number, want: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(got - want) < eps, `${what}: ${got} != ${want}`);

assert.equal(faceBasis([{ x: 0, y: 0 }]), null, 'no basis without a full mesh');

{
  const b = faceBasis(head())!;
  assert.ok(b, 'a front-facing head has a basis');
  // Image x runs to the subject's left, which is where the model's +X points.
  near(b.right.x, 1, 'right is +x');
  near(b.up.y, 1, 'up is +y once the canvas flip is undone');
  near(b.forward.z, 1, 'forward comes out of the face, towards the camera');
  near(b.width, 100, 'width is the temple span');
  near(b.centre.x, 200, 'centre sits between the temples');
}

// Roll rotates the basis in the image plane and leaves forward alone.
{
  const b = faceBasis(head(0, Math.PI / 6))!;
  near(b.right.x, Math.cos(Math.PI / 6), 'roll turns right');
  near(b.right.y, -Math.sin(Math.PI / 6), 'y flips with the canvas');
  near(b.forward.z, 1, 'roll does not move forward');
  near(b.width, 100, 'roll does not change width');
}

// Yaw swings forward off the camera axis, and the 3D width holds up even
// though the temples have visibly closed together in the image.
{
  const b = faceBasis(head(Math.PI / 4))!;
  assert.ok(b.forward.z < 0.75, `yaw turns the face away: ${b.forward.z}`);
  assert.ok(Math.abs(b.forward.x) > 0.5, `yaw swings forward sideways: ${b.forward.x}`);
  near(b.width, 100, 'width is measured in 3D, so yaw does not shrink it', 1e-6);
  const flat = Math.hypot(head(Math.PI / 4)[454].x - head(Math.PI / 4)[234].x, 0);
  assert.ok(flat < 80, `the 2D span really has collapsed (${flat}), so that was worth checking`);
}

// Whatever the pose, the basis has to stay square or the model shears.
for (const [yaw, roll] of [[0, 0], [0.5, 0], [0, 0.9], [0.7, -0.4], [1.2, 2.1]]) {
  const b = faceBasis(head(yaw, roll))!;
  const tag = `yaw ${yaw} roll ${roll}`;
  for (const [n, v] of [['right', b.right], ['up', b.up], ['forward', b.forward]] as const) {
    near(Math.hypot(v.x, v.y, v.z), 1, `${n} is unit at ${tag}`);
  }
  near(dot(b.right, b.up), 0, `right vs up at ${tag}`);
  near(dot(b.right, b.forward), 0, `right vs forward at ${tag}`);
  near(dot(b.up, b.forward), 0, `up vs forward at ${tag}`);
}

console.log('gesture + palette + pose checks passed');
