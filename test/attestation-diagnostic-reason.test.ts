import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  attestCurrentTurnLoopbackPeer,
  type AttestationDiagnostic,
} from '../src/core/current-actor-attestation.js';

// Diagnostic-contract regression: attestCurrentTurnLoopbackPeer's `onDiagnostic`
// sink must classify WHY a request collapses to current_actor_unverified while
// leaving the verdict (null vs attestation object) byte-for-byte unchanged.

function procStat(pid: number, ppid: number, start: string): string {
  const tail = ['S', String(ppid), '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', start];
  return `${pid} (proc ${pid}) ${tail.join(' ')}\n`;
}
function writeProc(root: string, pid: number, ppid: number, start: string): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), procStat(pid, ppid, start));
}
function activeSession(): any {
  return {
    session: { sessionId: 's1', status: 'active' },
    worker: { pid: 90, killed: false },
    chatId: 'oc_chat',
    larkAppId: 'cli_app',
    workerGeneration: 7,
    localProcessAttestation: {
      backendType: 'pty', credentialIsolated: false,
      cliPid: 100, cliProcStart: '1000', workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32), turnId: 'om_turn', callerOpenId: 'ou_current',
      preexistingProcessIdentities: ['100:1000'],
    },
    initConfig: { apiOnly: false },
  };
}

function capture(procRoot: string, ds: any, peer: { pid: number; procStart: string }) {
  const diags: AttestationDiagnostic[] = [];
  const verdict = attestCurrentTurnLoopbackPeer({
    sessionId: 's1', peer, findSession: () => ds,
    procRoot, onDiagnostic: (d) => diags.push(d),
  });
  // The verdict with a sink must equal the verdict without one.
  const verdictNoSink = attestCurrentTurnLoopbackPeer({
    sessionId: 's1', peer, findSession: () => ds, procRoot,
  });
  return { diags, verdict, verdictNoSink };
}

describe('attestation diagnostic sink (instrumentation-only)', () => {
  it('reports lineage_hit_preexisting with the offending ancestor, verdict still null', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '1100');
    writeProc(procRoot, 102, 101, '1200');
    const ds = activeSession();
    ds.managedTurnOrigin.preexistingProcessIdentities = ['100:1000', '101:1100'];
    const { diags, verdict, verdictNoSink } = capture(procRoot, ds, { pid: 102, procStart: '1200' });
    expect(verdict).toBeNull();
    expect(verdictNoSink).toBeNull();
    expect(diags).toContainEqual({
      reason: 'lineage_hit_preexisting', peerPid: 102, cliPid: 100, ancestorPid: 101, ancestorStart: '1100',
    });
  });

  it('reports ok on a live direct descendant, verdict is the attestation', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    const { diags, verdict } = capture(procRoot, activeSession(), { pid: 101, procStart: '2000' });
    expect(verdict).not.toBeNull();
    expect(diags).toContainEqual({ reason: 'ok' });
  });

  it('reports cli_pid_missing for an adopt session that never published a pid', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.cliPid = undefined;
    ds.localProcessAttestation.cliProcStart = undefined;
    ds.managedTurnOrigin.preexistingProcessIdentities = undefined;
    const { diags, verdict } = capture(procRoot, ds, { pid: 100, procStart: '1000' });
    expect(verdict).toBeNull();
    expect(diags).toContainEqual({ reason: 'cli_pid_missing' });
  });

  it('reports worker_missing_or_stale for a stale worker generation', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.workerGeneration = 6;
    const { diags, verdict } = capture(procRoot, ds, { pid: 100, procStart: '1000' });
    expect(verdict).toBeNull();
    expect(diags).toContainEqual({ reason: 'worker_missing_or_stale' });
  });

  it('reports transport_disabled for an apiOnly session', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.initConfig.apiOnly = true;
    const { diags, verdict } = capture(procRoot, ds, { pid: 100, procStart: '1000' });
    expect(verdict).toBeNull();
    expect(diags).toContainEqual({ reason: 'transport_disabled' });
  });

  it('reports lineage_exhausted for a same-uid process outside the anchor lineage', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 1, '3000');
    const { diags, verdict } = capture(procRoot, activeSession(), { pid: 200, procStart: '3000' });
    expect(verdict).toBeNull();
    expect(diags).toContainEqual({ reason: 'lineage_exhausted', peerPid: 200, cliPid: 100 });
  });
});
