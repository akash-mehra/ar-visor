// Run: npm test
import assert from 'node:assert/strict';
import { ArmSwitch, type Pt } from './gesture.ts';

const at = (d: number): [Pt, Pt] => [{ x: 0, y: 0 }, { x: d, y: 0 }];
const s = new ArmSwitch();

assert.equal(s.update(...at(0.1)), false, 'together but never armed');
assert.equal(s.update(...at(0.5)), false, 'arming alone must not fire');
assert.equal(s.update(...at(0.1)), true, 'apart -> together fires');
assert.equal(s.update(...at(0.1)), false, 'does not repeat while held');

// Hysteresis: bouncing in the dead zone after arming must not fire.
s.update(...at(0.5));
for (const d of [0.44, 0.3, 0.44, 0.26]) {
  assert.equal(s.update(...at(d)), false, `dead-zone ${d} must not fire`);
}
assert.equal(s.update(...at(0.2)), true, 'crossing the low threshold fires');

// Losing a hand disarms.
s.update(...at(0.5));
assert.equal(s.update(null, null), false);
assert.equal(s.update(...at(0.1)), false, 'lost hand must disarm');

console.log('gesture checks passed');
