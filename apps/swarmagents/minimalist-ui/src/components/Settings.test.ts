import test from 'node:test';
import assert from 'node:assert/strict';
import { countConfiguredProviders } from './Settings';

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
