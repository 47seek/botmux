import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  attestCurrentTurnLoopbackPeer,
  type AttestationDiagnostic,
} from '../src/core/current-actor-attestation.js';

// Diagnostic-contract regression: attestCurrentTurnLoopbackPeer's `onDiagnostic`
// sink classifies WHY a request collapses (or that it is ok) while leaving the
// verdict (null vs attestation object) byte-for-byte unchanged. Every case runs
// through the shared `capture` helper, which asserts sink/no-sink equivalence —
// including the fields of the success object, not just null-vs-not-null.

function procStat(pid: number, ppid: number, start: string): string {
  const tail = ['S', String(ppid), '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', start];
  return `${pid} (proc ${pid}) ${tail.join(' ')}\n`;
}
function writeProc(root: string, pid: number, ppid: number, start: string): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), procStat(pid, ppid, start));
}
function writeRawProc(root: string, pid: number, raw: string): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stat'), raw);
}
function activeSession(): any {
  return {
    session: { sessionId: 's1', status: 'active' },
    worker: { pid: 90, killed: false },
    chatId: 'oc_chat', larkAppId: 'cli_app', workerGeneration: 7,
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

/** Run the attestation twice — with and without the sink — and assert the
 *  verdict is byte-for-byte identical (deep-equal, so the success object's
 *  fields are compared too). Returns the diagnostics captured with the sink. */
function capture(procRoot: string, ds: any, peer: { pid: number; procStart: string }): AttestationDiagnostic[] {
  const diags: AttestationDiagnostic[] = [];
  const withSink = attestCurrentTurnLoopbackPeer({
    sessionId: 's1', peer, findSession: () => ds, procRoot, onDiagnostic: (d) => diags.push(d),
  });
  const noSink = attestCurrentTurnLoopbackPeer({
    sessionId: 's1', peer, findSession: () => ds, procRoot,
  });
  expect(withSink).toEqual(noSink);
  return diags;
}

describe('attestation diagnostic sink (instrumentation-only)', () => {
  it('reports lineage_hit_preexisting with the offending ancestor', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '1100');
    writeProc(procRoot, 102, 101, '1200');
    const ds = activeSession();
    ds.managedTurnOrigin.preexistingProcessIdentities = ['100:1000', '101:1100'];
    expect(capture(procRoot, ds, { pid: 102, procStart: '1200' })).toContainEqual({
      reason: 'lineage_hit_preexisting', peerPid: 102, cliPid: 100, ancestorPid: 101, ancestorStart: '1100',
    });
  });

  it('reports lineage_stat_malformed (distinct from preexisting) for an unparseable ancestor', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    // 101 has a malformed start field (non-numeric) — not in the snapshot, so the
    // reject must be attributed to the malformed stat, not to preexisting.
    writeRawProc(procRoot, 101, `101 (proc 101) S 100 1 1 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 notanumber\n`);
    writeProc(procRoot, 102, 101, '1200');
    const diags = capture(procRoot, activeSession(), { pid: 102, procStart: '1200' });
    expect(diags).toContainEqual({ reason: 'lineage_stat_malformed', peerPid: 102, ancestorPid: 101 });
    expect(diags.some(d => d.reason === 'lineage_hit_preexisting')).toBe(false);
  });

  it('reports ok on a live direct descendant (verdict object preserved with sink)', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    expect(capture(procRoot, activeSession(), { pid: 101, procStart: '2000' }))
      .toContainEqual({ reason: 'ok' });
  });

  it('reports cli_pid_missing for an adopt session that never published a pid', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.cliPid = undefined;
    ds.localProcessAttestation.cliProcStart = undefined;
    ds.managedTurnOrigin.preexistingProcessIdentities = undefined;
    expect(capture(procRoot, ds, { pid: 100, procStart: '1000' }))
      .toContainEqual({ reason: 'cli_pid_missing' });
  });

  it('reports worker_missing_or_stale for a stale worker generation', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.localProcessAttestation.workerGeneration = 6;
    expect(capture(procRoot, ds, { pid: 100, procStart: '1000' }))
      .toContainEqual({ reason: 'worker_missing_or_stale' });
  });

  it('reports transport_disabled for an apiOnly session', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    ds.initConfig.apiOnly = true;
    expect(capture(procRoot, ds, { pid: 100, procStart: '1000' }))
      .toContainEqual({ reason: 'transport_disabled' });
  });

  it('reports origin_incomplete when the live turn has no human caller', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    const ds = activeSession();
    delete ds.managedTurnOrigin.callerOpenId;
    expect(capture(procRoot, ds, { pid: 100, procStart: '1000' }))
      .toContainEqual({ reason: 'origin_incomplete' });
  });

  it('reports lineage_exhausted for a same-uid process outside the anchor lineage', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 200, 1, '3000');
    expect(capture(procRoot, activeSession(), { pid: 200, procStart: '3000' }))
      .toContainEqual({ reason: 'lineage_exhausted', peerPid: 200, cliPid: 100 });
  });

  it('reports peer_proc_start_mismatch when the peer racefully restarted', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'diag-'));
    writeProc(procRoot, 90, 1, '900');
    writeProc(procRoot, 100, 1, '1000');
    writeProc(procRoot, 101, 100, '2000');
    // peer claims a start tick that no longer matches /proc (pid reused)
    const diags = capture(procRoot, activeSession(), { pid: 101, procStart: '9999' });
    expect(diags).toContainEqual({ reason: 'peer_proc_start_mismatch' });
  });
});
