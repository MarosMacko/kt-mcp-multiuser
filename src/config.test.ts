import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig } from './config.js';

function withEnv(env: Record<string, string>, run: () => void) {
  const saved = { ...process.env };
  try {
    process.env['PUBLIC_URL'] = 'https://kt.test';
    process.env['CREDENTIALS_KEY'] = randomBytes(32).toString('base64');
    delete process.env['PUBLIC_USER_COUNT'];
    Object.assign(process.env, env);
    run();
  } finally {
    process.env = saved;
  }
}

test('PUBLIC_USER_COUNT is off unless the operator opts in', () => {
  withEnv({}, () => assert.equal(loadConfig().publicUserCount, false));
  withEnv({ PUBLIC_USER_COUNT: 'true' }, () => assert.equal(loadConfig().publicUserCount, true));
  withEnv({ PUBLIC_USER_COUNT: 'off' }, () => assert.equal(loadConfig().publicUserCount, false));
  withEnv({ PUBLIC_USER_COUNT: 'maybe' }, () => assert.throws(() => loadConfig(), /PUBLIC_USER_COUNT/));
});
