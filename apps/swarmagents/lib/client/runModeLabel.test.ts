import test from 'node:test';
import assert from 'node:assert/strict';
import { runModeLabel } from './runModeLabel';

test('runModeLabel maps every runMode value', () => {
  assert.equal(runModeLabel('gui'), 'Vision desktop');
  // gui with explicit vision flag
  assert.equal(runModeLabel({ mode: 'gui', capabilities: { vision: true } }), 'Vision desktop');
  assert.equal(runModeLabel({ mode: 'text-desktop' }), 'Text desktop (no vision)');
  assert.equal(runModeLabel({ mode: 'chat' }), 'Plain chat');
  assert.equal(runModeLabel({ mode: 'text' }), 'Text mode');
  assert.equal(runModeLabel({ mode: 'text', label: 'Text mode' }), 'Text mode');
  // missing runMode -> nothing
  assert.equal(runModeLabel(undefined), null);
  assert.equal(runModeLabel(null), null);
  assert.equal(runModeLabel({}), null);
  // older server with no mode but label
  assert.equal(runModeLabel({ label: 'Custom mode' }), 'Custom mode');
});
