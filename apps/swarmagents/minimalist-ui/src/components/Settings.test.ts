import test from 'node:test';
import assert from 'node:assert/strict';
import { countConfiguredProviders } from './Settings';
import { parseBudgetInput } from '../utils/budget';

// The Settings tab count must reflect the user's own configured providers:
// BYO providers saved in this browser plus providers configured on their
// account on the server. It used to count only the local list, so a user
// with only server providers saw "Providers · 0".
test('countConfiguredProviders adds local and server providers', () => {
  assert.equal(countConfiguredProviders(0, 0), 0);
  assert.equal(countConfiguredProviders(2, 0), 2);
  assert.equal(countConfiguredProviders(0, 3), 3);
  assert.equal(countConfiguredProviders(2, 3), 5);
});

test('parseBudgetInput validates budget inputs properly', () => {
  // Blank / empty string means uncapped (null)
  assert.deepEqual(parseBudgetInput(''), { valid: true, value: null });
  assert.deepEqual(parseBudgetInput('   '), { valid: true, value: null });

  // Non-negative numbers are valid
  assert.deepEqual(parseBudgetInput('0'), { valid: true, value: 0 });
  assert.deepEqual(parseBudgetInput('1.5'), { valid: true, value: 1.5 });
  assert.deepEqual(parseBudgetInput(' 25 '), { valid: true, value: 25 });

  // Negative numbers or invalid strings are rejected
  assert.equal(parseBudgetInput('-1').valid, false);
  assert.equal(parseBudgetInput('-0.01').valid, false);
  assert.equal(parseBudgetInput('abc').valid, false);
  assert.equal(parseBudgetInput('NaN').valid, false);
  assert.equal(parseBudgetInput('Infinity').valid, false);
});
