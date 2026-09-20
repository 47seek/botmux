import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/identity-cache.js', () => ({
  resolveVerifiedUserIdentity: vi.fn(async (_app: string, openId: string) => ({
    openId, type: 'user', email: 'current.user@example.com',
  })),
  getIdentity: vi.fn(() => undefined),
}));

// Partial mock: keep the real attestation/resolution logic, but let each test
// override how the loopback peer resolves so a peer_unresolved path is
// deterministic on any platform (real /proc resolution is Linux-only).
const peerResolutionOverride: { value: any } = { value: undefined };
vi.mock('../src/core/current-actor-attestation.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/core/current-actor-attestation.js')>();
  return {
    ...actual,
    resolveLoopbackPeerProcesses: (input: any) =>
      peerResolutionOverride.value ?? actual.resolveLoopbackPeerProcesses(input),
  };
});

import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import * as workerPool from '../src/core/worker-pool.js';
import { logger } from '../src/utils/logger.js';

let ipc: IpcServerHandle | null = null;
let debugLines: string[] = [];

afterEach(async () => {
  if (ipc) await ipc.close();
  ipc = null;
  peerResolutionOverride.value = undefined;
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

async function callActor(): Promise<Response> {
  debugLines = [];
  vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
  vi.spyOn(logger, 'warn').mockImplementation((msg: string) => { debugLines.push(msg); });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  return fetch(`http://127.0.0.1:${ipc.port}/api/current-actor`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's-actor' }),
  });
}
const diags = () => debugLines.filter(l => l.startsWith('[attest-diag]'));

describe('POST /api/current-actor emits attestation diagnostics', () => {
  it('records peer_unresolved when the loopback peer cannot be resolved, verdict still 403 (repro #1)', async () => {
    peerResolutionOverride.value = { ok: false, reason: 'socket_unavailable' };
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    const res = await callActor();
    expect(res.status).toBe(403);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('route=current-actor');
    expect(d[0]).toContain('proofMode=host_lineage');
    expect(d[0]).toContain('reason=peer_unresolved');
    expect(d[0]).toContain('detail=socket_unavailable');
    expect(d[0]).toContain('session=s-actor');
  });

  it.skipIf(process.platform !== 'linux')('records origin_incomplete when no human caller (real peer), verdict still 403', async () => {
    const ds = activeSession();
    delete ds.managedTurnOrigin.callerOpenId;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const res = await callActor();
    expect(res.status).toBe(403);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('reason=origin_incomplete');
    expect(d[0]).toContain('proofMode=host_lineage');
  });

  it.skipIf(process.platform !== 'linux')('records ok on a live CLI descendant, verdict 200', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeSession());
    const res = await callActor();
    expect(res.status).toBe(200);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('reason=ok');
    expect(d[0]).toContain('proofMode=host_lineage');
  });
});
