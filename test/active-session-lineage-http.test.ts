import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

vi.mock('../src/im/lark/identity-cache.js', () => ({
  resolveVerifiedUserIdentity: vi.fn(async (_app: string, openId: string) => ({
    openId, type: 'user', email: 'current.user@example.com',
  })),
  getIdentity: vi.fn(() => undefined),
}));

import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import { logger } from '../src/utils/logger.js';

/**
 * §2.b active-session loopback-lineage verification through the REAL HTTP handler.
 *
 * The IPC-smoke harness only reached the early gates (session_inactive /
 * sessionCliIpcAuth). This drives a real loopback HTTP request against an ACTIVE
 * session so the daemon actually runs peerBelongsToCurrentTurn:
 *   SUCCESS : the session's attested cliPid is this test process (the real fetch
 *             client's ancestor) → the walk reaches cliPid → 200, reason=ok.
 *   REJECT  : the session attests an unrelated cliPid (not an ancestor of the
 *             fetch client) → the walk exhausts without hitting it → 403,
 *             reason=lineage_exhausted — the lineage branch, not an early gate.
 * Both assert the real [attest-diag] reason via the unmocked logger (DEBUG=1).
 */

const linux = process.platform === 'linux';
let ipc: IpcServerHandle | null = null;
let debugLines: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  for (const c of children) { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }
  children.clear();
  vi.restoreAllMocks();
});

/** A real live child of THIS process — its pid is resolvable in /proc but it is
 *  NOT on the loopback client's (process.pid) parent chain, so a lineage walk
 *  from the client will exhaust before reaching it. */
function spawnUnrelatedLiveChild(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  children.add(c);
  return c;
}

function activeSession(cliPid: number): any {
  const start = readProcessStartIdentity(cliPid) ?? '1';
  return {
    session: { sessionId: 's-actor', status: 'active' },
    chatId: 'oc_chat', larkAppId: 'cli_app', workerGeneration: 7,
    worker: { pid: process.pid, killed: false },
    localProcessAttestation: {
      backendType: 'pty', credentialIsolated: false,
      cliPid, cliProcStart: start, workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32), turnId: 'om_turn', callerOpenId: 'ou_current',
      preexistingProcessIdentities: [`${cliPid}:${start}`],
    },
    initConfig: { apiOnly: false },
  };
}

async function callActor(ds: any): Promise<{ status: number; diag?: string }> {
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
  debugLines = [];
  vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  const res = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-actor' }),
  });
  await res.json().catch(() => {});
  const diag = debugLines.filter(l => l.startsWith('[attest-diag]')).at(-1);
  return { status: res.status, diag };
}

describe.skipIf(!linux)('§2.b active-session loopback lineage (real HTTP handler)', () => {
  it('SUCCESS: attested cliPid is the fetch client ancestor → 200, reason=ok', async () => {
    // cliPid = this test process; the loopback fetch client is its descendant.
    const { status, diag } = await callActor(activeSession(process.pid));
    expect(status).toBe(200);
    expect(diag).toBeDefined();
    expect(diag).toContain('route=current-actor');
    expect(diag).toContain('reason=ok');
  });

  it('REJECT: attested cliPid is a live but unrelated pid → lineage branch, 403, reason=lineage_exhausted', async () => {
    // cliPid = a real live child of this process: resolvable in /proc (passes the
    // cli_proc_start gate) but NOT an ancestor of the loopback client, so the
    // walk exhausts in the lineage branch — proving we passed the early gates.
    const child = spawnUnrelatedLiveChild();
    // give it a moment to appear in /proc with a readable stat
    await new Promise(r => setTimeout(r, 150));
    const ds = activeSession(child.pid!);
    const { status, diag } = await callActor(ds);
    expect(status).toBe(403);
    expect(diag).toBeDefined();
    expect(diag).toContain('route=current-actor');
    // reached the lineage branch (NOT an early gate like session_inactive/cli_pid_missing)
    expect(diag).toMatch(/reason=lineage_(exhausted|hit_preexisting|walk_read_failed)/);
  });
});
