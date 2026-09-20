import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { spawnTsEval } from './helpers/ts-runner.js';

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

const linux = process.platform === 'linux';
let ipc: IpcServerHandle | null = null;
let debugLines: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  await Promise.all([...children].map(async (c) => {
    if (c.exitCode !== null || c.signalCode !== null) return;
    const exited = once(c, 'exit');
    c.kill('SIGKILL');
    await exited;
    expect(c.signalCode).toBe('SIGKILL');
  }));
  children.clear();
  vi.restoreAllMocks();
});

async function spawnUnrelatedLiveChild(): Promise<ChildProcess> {
  const c = spawnTsEval('setTimeout(()=>{}, 60000)', { stdio: 'ignore' });
  children.add(c);
  await once(c, 'spawn');
  return c;
}

function activeSession(cliPid: number): any {
  const start = readProcessStartIdentity(cliPid);
  expect(start).toMatch(/^\d+$/);
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

async function callActor(ds: any) {
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
  debugLines = [];
  vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  const res = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-actor' }),
  });
  const body = await res.json();
  const diags = debugLines.filter(l => l.startsWith('[attest-diag]'));
  expect(diags).toHaveLength(1);
  return { status: res.status, body, fields: diags[0].split(' ') };
}

describe.skipIf(!linux)('§2.b active-session loopback lineage (real HTTP handler)', () => {
  it('accepts a socket peer whose PID equals the attested cliPid', async () => {
    const { status, body, fields } = await callActor(activeSession(process.pid));
    expect(status).toBe(200);
    expect(body).toMatchObject({ schema: 'botmux.current-actor.v2', status: 'verified' });
    expect(fields).toContain('route=current-actor');
    expect(fields).toContain('reason=ok');
  });

  it('REJECT: attested cliPid is a live but unrelated pid → lineage branch, 403, reason=lineage_exhausted', async () => {
    const child = await spawnUnrelatedLiveChild();
    const ds = activeSession(child.pid!);
    const { status, body, fields } = await callActor(ds);
    expect(status).toBe(403);
    expect(body).toEqual({ schema: 'botmux.current-actor.v2', status: 'blocked', error: 'current_actor_unverified' });
    expect(fields).toContain('route=current-actor');
    expect(fields).toContain('reason=lineage_exhausted');
    expect(fields).toContain(`peerPid=${process.pid}`);
    expect(fields).toContain(`cliPid=${child.pid}`);
  });
});
