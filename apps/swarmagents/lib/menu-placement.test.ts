import test from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu } from '../minimalist-ui/src/components/RoleAndVmBar';

// The role/strategy dropdowns are anchored to their trigger buttons and must
// never extend past the viewport edges — the original bug left the menu
// painted under the computer screen (hit-testing failed), and a placement
// beyond the viewport would be equally unreachable.
test('placeMenu puts a left-aligned menu below the trigger', () => {
  const pos = placeMenu({ left: 295, right: 545, bottom: 191 }, 1440, { width: 288 });
  assert.deepEqual(pos, { top: 197, left: 295 });
});

test('placeMenu right-aligns the menu to the trigger right edge', () => {
  const pos = placeMenu({ left: 400, right: 1049, bottom: 197 }, 1440, { width: 240, align: 'right' });
  assert.deepEqual(pos, { top: 203, left: 809 });
});

test('placeMenu clamps a left-aligned menu that would overflow the right edge', () => {
  const pos = placeMenu({ left: 1300, right: 1550, bottom: 191 }, 1440, { width: 288 });
  // 1300 + 288 = 1588 > 1440; clamp to 1440 - 288 - 8 = 1144.
  assert.deepEqual(pos, { top: 197, left: 1144 });
});

test('placeMenu clamps a right-aligned menu that would overflow the right edge', () => {
  const pos = placeMenu({ left: 1300, right: 1430, bottom: 191 }, 1440, { width: 240, align: 'right' });
  // right-align wants 1430 - 240 = 1190, which fits; no clamping.
  assert.deepEqual(pos, { top: 197, left: 1190 });
});

test('placeMenu respects a custom gap and padding', () => {
  const pos = placeMenu({ left: 4, right: 30, bottom: 150 }, 1440, { width: 200, gap: 12, padding: 16 });
  // left edge clamps up to padding (16), top uses the custom gap.
  assert.deepEqual(pos, { top: 162, left: 16 });
});
