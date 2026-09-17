// Checks for gesture.ts and palette.ts. Run: npm test
import assert from 'node:assert/strict';
import {
  Clap,
  FingerCount,
  LateralExit,
  Latch,
  DoubleBlink,
  PinchZoom,
  coverFit,
  onScreen,
  boundsOf,
  countExtended,
  faceBasis,
  frameQuad,
  pinch,
  point,
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

// ------------------------------------------------------ study gestures ----
/** A hand with its wrist and palm placed, and its thumb/index tips apart. */
function at(x: number, y: number, gap = 40): Pt[] {
  const lm: Pt[] = Array.from({ length: 21 }, () => ({ x, y }));
  lm[0] = { x, y };          // wrist
  lm[9] = { x, y: y - 40 };  // middle MCP, so the palm is 40 long
  lm[4] = { x: x - gap / 2, y };
  lm[8] = { x: x + gap / 2, y };
  return lm;
}

const W = 480;
{
  const e = new LateralExit();
  // Hands present are never an exit, however close to the edge they are.
  assert.equal(e.update([at(10, 200), at(470, 200)], W, 1000), false, 'still on screen');
  // Both sides gone, nothing left: that is the gesture.
  assert.equal(e.update([], W, 1040), true, 'both hands left sideways');
  assert.equal(e.update([], W, 1080), false, 'and it fires once, not every frame after');
}
{
  // Tracking drops one hand before the other, which is the whole reason the
  // sides are timed separately rather than snapshotted together.
  const e = new LateralExit();
  e.update([at(10, 200), at(470, 200)], W, 1000);
  e.update([at(470, 200)], W, 1020); // left hand already lost
  assert.equal(e.update([], W, 1040), true, 'staggered loss still reads as a pair');
}
{
  const e = new LateralExit();
  e.update([at(240, 20), at(250, 30)], W, 1000); // up and out of the top
  assert.equal(e.update([], W, 1040), false, 'leaving upwards is not a lateral exit');
}
{
  const e = new LateralExit();
  e.update([at(10, 200)], W, 1000);
  e.update([at(470, 200)], W, 3000); // the other side, much later
  assert.equal(e.update([], W, 3040), false, 'one side going stale does not count');
}
{
  const e = new LateralExit();
  e.update([at(10, 200), at(240, 200)], W, 1000); // one lateral, one central
  assert.equal(e.update([], W, 1040), false, 'one side alone is not the gesture');
}

// A pinch is the tips together, measured against the palm so distance from
// the camera does not change the verdict.
assert.equal(pinch(at(100, 100, 40)), null, 'tips apart is not a pinch');
assert.deepEqual(pinch(at(100, 100, 10)), { x: 100, y: 100 }, 'tips together, point between');
assert.equal(pinch([{ x: 0, y: 0 }]), null, 'a partial hand cannot pinch');

// A point is the index out with the thumb clear of it. `at` leaves every other
// landmark on the wrist, which reads as an extended index over its own PIP and
// three curled fingers — the pose, with the thumb gap the only variable.
assert.deepEqual(point(at(100, 100, 40)), { x: 120, y: 100 }, 'the fingertip is the point');
assert.equal(point(at(100, 100, 10)), null, 'thumb against the index is a pinch, not a point');
assert.equal(point([{ x: 0, y: 0 }]), null, 'a partial hand cannot point');
{
  const spread = at(100, 100, 40);
  for (const t of [12, 16, 20]) spread[t] = { x: 100, y: 40 }; // other fingers out
  assert.equal(point(spread), null, 'an open hand is not a point');
  const curled = at(100, 100, 40);
  curled[6] = { x: 100, y: 40 }; // index PIP past its own tip
  assert.equal(point(curled), null, 'a curled index is not a point');
}
// The property the whole gesture split rests on: no hand is both, at any gap.
// A two-handed pinch passes through a one-handed pinch at each end of itself,
// so counting pinched hands named a bone on the way into every zoom and again
// on the way out. Shape cannot overlap the way a count does.
for (let gap = 0; gap <= 80; gap++) {
  const h = at(100, 100, gap);
  assert.ok(!(pinch(h) && point(h)), `one hand pinches and points at gap ${gap}`);
}

{
  const c = new Clap();
  assert.equal(c.update([at(100, 200)]), false, 'one hand cannot clap');
  assert.equal(c.update([at(40, 200), at(400, 200)]), false, 'hands apart');
  assert.equal(c.update([at(230, 200), at(250, 200)]), true, 'hands meet');
  assert.equal(c.update([at(230, 200), at(250, 200)]), false, 'held together is still one clap');
  c.update([at(40, 200), at(400, 200)]);
  assert.equal(c.update([at(230, 200), at(250, 200)]), true, 'apart and together again claps');
}

{
  const z = new PinchZoom();
  const at0 = { x: 200, y: 300 };
  // The first frame of a grab only takes the reference; it must not jump.
  assert.equal(z.update(at0, { x: 300, y: 300 }), 1, 'the grab starts where it was');
  assert.equal(z.update(at0, { x: 400, y: 300 }), 2, 'twice as far apart is twice the size');
  assert.equal(z.update(at0, { x: 250, y: 300 }), 0.5, 'half as far is half');
  assert.equal(z.update(at0, { x: 10000, y: 300 }), 4, 'clamped at the top');
  assert.equal(z.update(at0, { x: 201, y: 300 }), 0.35, 'clamped at the bottom');

  // Letting go and grabbing again carries on from here rather than snapping
  // back to 1 — the thing that makes a zoom usable in more than one pull.
  z.release();
  assert.equal(z.update(at0, { x: 300, y: 300 }), 0.35, 'the new grab holds the old scale');
  assert.equal(z.update(at0, { x: 600, y: 300 }), 1.4, 'and scales on from it');

  z.reset();
  assert.equal(z.scale, 1, 'reset is life size');
}

{
  const d = new DoubleBlink(700);
  // Counted on the eye reopening, so a close on its own is never half a pair.
  assert.equal(d.update(true, 0), false, 'closing is not a blink yet');
  assert.equal(d.update(false, 80), false, 'one completed blink');
  assert.equal(d.update(true, 300), false, 'closing again');
  assert.equal(d.update(false, 380), true, 'two inside the window fires');
  // Spent, so a third blink starts a fresh pair rather than firing again.
  assert.equal(d.update(true, 500), false, 'closing');
  assert.equal(d.update(false, 560), false, 'the third is a new first');
}
{
  const d = new DoubleBlink(700);
  d.update(true, 0); d.update(false, 50);
  d.update(true, 2000);
  assert.equal(d.update(false, 2050), false, 'too slow is two singles, not a double');
}
{
  // A long hold is one blink, not a flutter: only the reopening counts.
  const d = new DoubleBlink(700);
  d.update(true, 0);
  for (let t = 10; t < 600; t += 10) assert.equal(d.update(true, t), false, 'held shut');
  assert.equal(d.update(false, 600), false, 'one blink out of a long close');
}

// object-fit: cover fills and crops evenly; a label pointing at something
// drawn in the canvas has to travel the same path or it drifts.
{
  // 640x480 canvas into a 480x640 portrait viewport: crops the sides.
  const f = coverFit(640, 480, 480, 640);
  assert.equal(f.scale, 640 / 480, 'cover scales by the larger ratio');
  assert.ok(f.x < 0 && f.y === 0, 'the crop is horizontal here');
  // Mirrored: the canvas draws flipped, so x is measured back from the far edge.
  const mid = onScreen({ x: 320, y: 240 }, 640, f);
  near(mid.x, 240, 'the centre stays centred');
  near(mid.y, 320, 'and vertically too');
  const left = onScreen({ x: 0, y: 0 }, 640, f);
  const right = onScreen({ x: 640, y: 0 }, 640, f);
  assert.ok(right.x < left.x, 'mirrored: landmark x grows leftwards on screen');
}
{
  // Same aspect: no crop, no offset, a clean scale.
  const f = coverFit(640, 480, 1280, 960);
  assert.equal(f.scale, 2);
  assert.deepEqual([f.x, f.y], [0, 0], 'nothing to crop');
  near(onScreen({ x: 640, y: 480 }, 640, f).x, 0, 'the far edge mirrors to zero');
}
assert.deepEqual(coverFit(0, 0, 100, 100), { scale: 1, x: 0, y: 0 }, 'no canvas, no crash');

console.log('gesture + palette + pose + study + zoom + ui checks passed');
