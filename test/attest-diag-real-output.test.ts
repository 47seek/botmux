import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Real-output regression for [attest-diag] (issue #3 follow-up): drives a REAL
 * loopback HTTP request through the REAL source handler and the UNMOCKED logger,
 * in a child process, and asserts the diagnostic reaches stdout only when
 * DEBUG=1 (the logger's own gate, logger.ts). No spy — this exercises the actual
 * daemon logging path end to end, complementing the spy-based handler tests.
 */

const BUN = process.env.npm_execpath?.endsWith('bun') ? process.env.npm_execpath : '/root/.npm/_npx/22f2fe8d8bc13000/node_modules/.bin/bun';
const REPO = join(__dirname, '..');

// Child: start the real IPC server, POST /api/current-actor for an absent
// session (→ reason=session_inactive, verdict 403), print how many [attest-diag]
// lines the real logger wrote to stdout.
const CHILD = `
import { startIpcServer } from ${JSON.stringify(join(REPO, 'src/core/dashboard-ipc-server.js'))};
const captured = [];
const orig = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...r) => { try { captured.push(String(c)); } catch {} return true; };
const ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
const res = await fetch('http://127.0.0.1:' + ipc.port + '/api/current-actor', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'realout-absent-session' }),
});
const status = res.status;
await res.json().catch(() => {});
await ipc.close();
process.stdout.write = orig;
const lines = captured.join('').split('\\n').filter(l => l.includes('[attest-diag]'));
process.stdout.write(JSON.stringify({ status, count: lines.length, sample: lines[0] || null }) + '\\n');
`;

function runChild(debug: string): { status: number; count: number; sample: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'realout-'));
  const file = join(dir, 'child.mjs');
  writeFileSync(file, CHILD);
  const res = spawnSync(BUN, [file], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DEBUG: debug },
  });
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}';
  return JSON.parse(line);
}

describe.skipIf(process.platform !== 'linux')('attest-diag real handler output (unmocked logger)', () => {
  it('emits one [attest-diag] line under DEBUG=1 and none when DEBUG is unset, verdict 403 both times', () => {
    const on = runChild('1');
    expect(on.status).toBe(403);
    expect(on.count).toBe(1);
    expect(on.sample).toContain('[attest-diag]');
    expect(on.sample).toContain('route=current-actor');
    expect(on.sample).toContain('reason=session_inactive');

    const off = runChild('');
    expect(off.status).toBe(403);
    expect(off.count).toBe(0);
  }, 40_000);
});
