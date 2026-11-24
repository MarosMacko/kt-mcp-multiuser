import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUILD, versionLabel } from './version.js';

test('labels a build with its commit, and marks a modified one', () => {
  assert.equal(versionLabel({ version: '0.3.0', commit: 'a1b2c3d', dirty: false }), '0.3.0 (a1b2c3d)');
  assert.equal(versionLabel({ version: '0.3.0', commit: 'a1b2c3d', dirty: true }, 'upravená'), '0.3.0 (a1b2c3d, upravená)');
  assert.equal(versionLabel({ version: '0.3.0', commit: null, dirty: false }), '0.3.0');
});

test('reads the version written at build time', () => {
  assert.match(BUILD.version, /^\d+\.\d+\.\d+/);
});
