import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attestCurrentTurnLoopbackPeer,
  resolveLoopbackPeerProcesses,
  snapshotProcessIdentities,
  type AttestationDiagnostic,
} from '../src/core/current-actor-attestation.js';

/**
 * Phase-1 real-process experiment for the host-session lineage proof (chain A).
 *
 * current-actor-attestation.test.ts proves the gates against memfs /proc
 * fixtures. This drives REAL processes against the real kernel: a resident child
 * stands in for the codex host runner already alive at turn start; the daemon
 * takes a real `snapshotProcessIdentities` of the CLI anchor; then AFTER the
 * snapshot a fresh loopback client (the "current-turn command") is spawned and
 * HELD OPEN until explicit release, so the peer is resolvable throughout:
 *
 *   REJECT  : client nested under the snapshotted host runner
 *             -> attest fails, diagnostic reason=lineage_hit_preexisting with the
 *                offending ancestor == the snapshotted hostChild PID
 *   SUCCESS : client spawned directly under the anchor (control)
 *             -> attest passes; frozen turn matches
 *
 * Experiment children run in their own process group and are reaped in afterEach
 * (no `pkill -f` on an env marker).
 */

const linux = process.platform === 'linux';
const NODE = process.execPath;

const procStart = (pid: number): string => {
  const raw = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resident helper. Commands on stdin:
//   spawn-child        fork a child resident, print "SPAWNED <pid>"
//   to-child <text>    forward "<text>\n" to the child resident
//   connect <port>     fork a connector that opens a loopback client, prints
//                      "CLIENT <pid> <localPort>", and HOLDS until its stdin
//                      closes (released when this resident exits)
const RESIDENT = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
let child;
const connectors = [];
const CONNECTOR = "const net=require('node:net');const p=Number(process.argv[1]);const s=net.connect(p,'127.0.0.1',()=>{process.stdout.write('CLIENT '+process.pid+' '+s.localPort+String.fromCharCode(10));});s.on('error',()=>{});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
process.stdin.setEncoding('utf8');
let buf='';
process.stdin.on('data',(c)=>{
  buf+=c; let i;
  while((i=buf.indexOf(String.fromCharCode(10)))>=0){
    const t=buf.slice(0,i).trim(); buf=buf.slice(i+1); let m;
    if(t==='spawn-child'){
      child=spawn(process.execPath,['-e',process.env.RESIDENT_SRC],{stdio:['pipe','pipe','inherit'],env:process.env});
      child.stdout.setEncoding('utf8'); child.stdout.on('data',d=>process.stdout.write(d));
      process.stdout.write('SPAWNED '+child.pid+String.fromCharCode(10));
    }else if((m=t.match(/^to-child (.*)$/))){ if(child) child.stdin.write(m[1]+String.fromCharCode(10)); }
    else if((m=t.match(/^connect (\d+)$/))){
      const con=spawn(process.execPath,['-e',CONNECTOR,m[1]],{stdio:['pipe','pipe','inherit'],env:process.env});
      con.stdout.setEncoding('utf8'); con.stdout.on('data',d=>process.stdout.write(d));
      connectors.push(con);
    }
  }
});
process.stdin.on('end',()=>process.exit(0));
`;

const groupLeaders = new Set<ChildProcess>();
const sockets = new Set<Socket>();
let server: Server | undefined;

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  // Kill each experiment process group (leader spawned detached) and await exit.
  const waits: Promise<void>[] = [];
  for (const p of groupLeaders) {
    if (p.exitCode === null && p.signalCode === null && p.pid) {
      waits.push(new Promise<void>((r) => p.once('exit', () => r())));
      try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    }
  }
  groupLeaders.clear();
  await Promise.race([Promise.all(waits), sleep(3000)]);
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = undefined; }
});

function spawnLeader(): ChildProcess {
  const p = spawn(NODE, ['-e', RESIDENT], {
    stdio: ['pipe', 'pipe', 'inherit'], detached: true,
    env: { ...process.env, RESIDENT_SRC: RESIDENT },
  });
  p.stdout!.setEncoding('utf8');
  groupLeaders.add(p);
  return p;
}

function waitLine(proc: ChildProcess, re: RegExp, timeout = 6000): Promise<RegExpMatchArray> {
  return new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error(`timeout waiting ${re}`)), timeout);
    const onData = (d: string) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(re);
        if (m) { clearTimeout(to); proc.stdout!.off('data', onData); res(m); return; }
      }
    };
    proc.stdout!.on('data', onData);
  });
}

function activeSession(anchorPid: number, anchorStart: string, snapshot: string[] | undefined): any {
  return {
    session: { sessionId: 's-real', status: 'active' },
    worker: { pid: process.pid, killed: false },
    chatId: 'oc_real', larkAppId: 'cli_real', workerGeneration: 1,
    localProcessAttestation: {
      backendType: 'pty', credentialIsolated: false,
      cliPid: anchorPid, cliProcStart: anchorStart, workerGeneration: 1,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32), turnId: 'om_turn_real', callerOpenId: 'ou_realuser',
      preexistingProcessIdentities: snapshot,
    },
    initConfig: { apiOnly: false },
  };
}

describe.skipIf(!linux)('phase-1 real-process host-session lineage attestation', () => {
  it('rejects a held client nested under the snapshotted host runner, passes a direct anchor child', async () => {
    server = createServer((s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const serverPort = (server.address() as any).port as number;

    // Real tree: anchor (cliPid) -> hostChild (resident runner, before the turn)
    const anchor = spawnLeader();
    await sleep(150);
    anchor.stdin!.write('spawn-child\n');
    const hostChildPid = Number((await waitLine(anchor, /SPAWNED (\d+)/))[1]);
    const anchorPid = anchor.pid!;
    await sleep(150);
    const anchorStart = procStart(anchorPid);
    const hostChildStart = procStart(hostChildPid);

    // Daemon snapshot of the anchor lineage — taken BEFORE any turn command
    const snapshot = snapshotProcessIdentities(anchorPid, '/proc');
    expect(snapshot).toContain(`${anchorPid}:${anchorStart}`);
    expect(snapshot).toContain(`${hostChildPid}:${hostChildStart}`);

    const attestWithDiag = (peerPid: number, peerStart: string) => {
      const diags: AttestationDiagnostic[] = [];
      const verdict = attestCurrentTurnLoopbackPeer({
        sessionId: 's-real', peer: { pid: peerPid, procStart: peerStart },
        findSession: () => activeSession(anchorPid, anchorStart, snapshot),
        procRoot: '/proc', onDiagnostic: (d) => diags.push(d),
      });
      return { verdict, diags };
    };
    const resolvePeer = (ephem: number) => resolveLoopbackPeerProcesses({
      remoteAddress: '127.0.0.1', remotePort: ephem, localPort: serverPort, procRoot: '/proc',
    });

    // REJECT: current-turn client nested under the snapshotted host runner, held open
    anchor.stdin!.write(`to-child connect ${serverPort}\n`);
    const rej = await waitLine(anchor, /CLIENT (\d+) (\d+)/);
    const rejClientPid = Number(rej[1]);
    await sleep(120);
    const rejPeer = resolvePeer(Number(rej[2]));
    expect(rejPeer.ok).toBe(true);
    if (!rejPeer.ok) throw new Error('peer unresolved');
    // peer resolved from the kernel socket must be the held client itself
    expect(rejPeer.peer.pid).toBe(rejClientPid);
    const rejOut = attestWithDiag(rejPeer.peer.pid, rejPeer.peer.procStart);
    expect(rejOut.verdict).toBeNull();
    // the walk hit the snapshotted hostChild before reaching the anchor
    expect(rejOut.diags).toContainEqual({
      reason: 'lineage_hit_preexisting',
      peerPid: rejClientPid, cliPid: anchorPid, ancestorPid: hostChildPid, ancestorStart: hostChildStart,
    });

    // SUCCESS control: current-turn client spawned directly under the anchor, held open
    anchor.stdin!.write(`connect ${serverPort}\n`);
    const ok = await waitLine(anchor, /CLIENT (\d+) (\d+)/);
    const okClientPid = Number(ok[1]);
    await sleep(120);
    const okPeer = resolvePeer(Number(ok[2]));
    expect(okPeer.ok).toBe(true);
    if (!okPeer.ok) throw new Error('peer unresolved');
    expect(okPeer.peer.pid).toBe(okClientPid);
    const okOut = attestWithDiag(okPeer.peer.pid, okPeer.peer.procStart);
    expect(okOut.verdict).not.toBeNull();
    expect(okOut.diags).toContainEqual({ reason: 'ok' });
    expect(okOut.verdict!.turnId).toBe('om_turn_real');
    expect(okOut.verdict!.cliPid).toBe(anchorPid);
    expect(okOut.verdict!.callerOpenId).toBe('ou_realuser');
  }, 30_000);
});
