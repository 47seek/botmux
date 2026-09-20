import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

const REPO = join(__dirname, '..');
const CHILD = `
import { startIpcServer } from ${JSON.stringify(join(REPO, 'src/core/dashboard-ipc-server.js'))};
const ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
try {
  const res = await fetch('http://127.0.0.1:' + ipc.port + '/api/current-actor', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'realout-absent-session' }),
  });
  const body = await res.json();
  console.log('ATTEST_RESULT ' + JSON.stringify({ status: res.status, body }));
} finally {
  await ipc.close();
}
`;

function runChild(debug: boolean) {
  const env = { ...process.env };
  if (debug) env.DEBUG = '1';
  else delete env.DEBUG;
  const res = spawnSyncTsEvalWithRepoImports(CHILD, {
    cwd: REPO, encoding: 'utf8', timeout: 20_000, env,
  });
  expect(res.error).toBeUndefined();
  expect(res.status, String(res.stderr)).toBe(0);
  const stdout = String(res.stdout);
  const receipt = stdout.split('\n').find(line => line.startsWith('ATTEST_RESULT '));
  expect(receipt).toBeDefined();
  const result = JSON.parse(receipt!.slice('ATTEST_RESULT '.length));
  expect(result).toEqual({ status: 403, body: {
    schema: 'botmux.current-actor.v2', status: 'blocked', error: 'current_actor_unverified',
  } });
  return (stdout + String(res.stderr)).split('\n').filter(line => line.includes('[attest-diag]'));
}

describe.skipIf(process.platform !== 'linux')('attest-diag real handler output', () => {
  it('reports rejections with DEBUG enabled or unset', () => {
    const on = runChild(true);
    expect(on).toHaveLength(1);
    expect(on[0]).toContain('route=current-actor');
    expect(on[0]).toContain('reason=session_inactive');
    expect(runChild(false)).toHaveLength(1);
  }, 45_000);
});
