import { afterEach, describe, expect, it, vi } from 'vitest';

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

// P1: the /api/current-actor route (host_lineage proof) must emit a
// request-correlated [attest-diag] record on rejection, verdict unchanged.

let ipc: IpcServerHandle | null = null;
let debugLines: string[] = [];

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  vi.restoreAllMocks();
});

function activeSession(): any {
  return {
    session: { sessionId: 's-actor', status: 'active' },
    chatId: 'oc_chat', larkAppId: 'cli_app', workerGeneration: 7,
    worker: { pid: process.pid, killed: false },
    localProcessAttestation: {
      backendType: 'pty', credentialIsolated: false,
      cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid), workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32), turnId: 'om_turn', callerOpenId: 'ou_current',
      preexistingProcessIdentities: [`${process.pid}:${readProcessStartIdentity(process.pid)}`],
    },
    initConfig: { apiOnly: false },
  };
}

describe('POST /api/current-actor emits attestation diagnostics', () => {
  it('records origin_incomplete (proofMode=host_lineage) when no human caller, verdict still 403', async () => {
    const ds = activeSession();
    delete ds.managedTurnOrigin.callerOpenId;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    debugLines = [];
    vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const res = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor' }),
    });
    expect(res.status).toBe(403);
    const d = debugLines.filter(l => l.startsWith('[attest-diag]'));
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('route=current-actor');
    expect(d[0]).toContain('proofMode=host_lineage');
    expect(d[0]).toContain('reason=origin_incomplete');
    expect(d[0]).toContain('session=s-actor');
  });

  it.skipIf(process.platform !== 'linux')('records ok on a live CLI descendant, verdict 200', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    debugLines = [];
    vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const res = await fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's-actor' }),
    });
    expect(res.status).toBe(200);
    const d = debugLines.filter(l => l.startsWith('[attest-diag]'));
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('reason=ok');
    expect(d[0]).toContain('proofMode=host_lineage');
  });
});
