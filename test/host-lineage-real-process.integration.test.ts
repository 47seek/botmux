import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attestCurrentTurnLoopbackPeer,
  resolveLoopbackPeerProcesses,
  snapshotProcessIdentities,
} from '../src/core/current-actor-attestation.js';

/**
 * Phase-1 real-process experiment for the host-session lineage proof (chain A).
 *
 * current-actor-attestation.test.ts proves the gates against memfs /proc
 * fixtures. This drives REAL processes against the real kernel: a resident child
 * stands in for the codex host runner that is already alive at turn start; the
 * daemon takes a real `snapshotProcessIdentities` of the CLI anchor; then AFTER
 * the snapshot a fresh loopback client (the "current-turn command") is spawned.
 *
 *   REJECT  : client nested under the snapshotted host runner
 *             -> attest fails (walk hits the runner in the snapshot before the anchor)
 *   SUCCESS : client spawned directly under the anchor (control)
 *             -> attest passes (walk reaches cliPid before any snapshot member)
 *
 * Reads the real peer PID:start, the snapshot, and the verdict on both sides.
 */

const linux = process.platform === 'linux';
const NODE = process.execPath;
const MARKER = `bmx-lineage-exp-${process.pid}`;

const procStart = (pid: number): string => {
  const raw = readFileSync(join('/proc', String(pid), 'stat'), 'utf8');
  return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Resident helper (marked via MARKER env). Commands on stdin:
//   spawn-child        fork a child resident, print "SPAWNED <pid>"
//   to-child <text>    forward "<text>\n" to the child resident
//   connect <port>     fork a connector that opens a loopback client, print
//                      "CLIENT <pid> <localPort>", self-exits after 3s
const RESIDENT = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
let child;
const CONNECTOR = "const net=require('node:net');const p=Number(process.argv[1]);const s=net.connect(p,'127.0.0.1',()=>{process.stdout.write('CLIENT '+process.pid+' '+s.localPort+String.fromCharCode(10));});s.on('error',()=>{});setTimeout(()=>process.exit(0),3000);";
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
    }
  }
});
process.stdin.on('end',()=>process.exit(0));
`;

const residents = new Set<ChildProcess>();
const sockets = new Set<Socket>();
let server: Server | undefined;

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const p of residents) { if (p.exitCode === null && p.signalCode === null) { try { p.stdin?.end(); } catch { /* closed */ } p.kill('SIGKILL'); } }
  residents.clear();
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = undefined; }
  try { execFileSync('pkill', ['-9', '-f', MARKER], { stdio: 'ignore' }); } catch { /* none left */ }
});

function spawnResident(): ChildProcess {
  const p = spawn(NODE, ['-e', RESIDENT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, RESIDENT_SRC: RESIDENT, BMX_LINEAGE_MARKER: MARKER },
  });
  p.stdout!.setEncoding('utf8');
  residents.add(p);
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
    chatId: 'oc_real',
    larkAppId: 'cli_real',
    workerGeneration: 1,
    localProcessAttestation: {
      backendType: 'pty', credentialIsolated: false,
      cliPid: anchorPid, cliProcStart: anchorStart, workerGeneration: 1,
    },
    managedTurnOrigin: {
      capability: 'ca'.repeat(32),
      turnId: 'om_turn_real',
      callerOpenId: 'ou_realuser',
      preexistingProcessIdentities: snapshot,
    },
    initConfig: { apiOnly: false },
  };
}

describe.skipIf(!linux)('phase-1 real-process host-session lineage attestation', () => {
  it('rejects a client nested under a snapshotted host runner, passes a direct anchor child', async () => {
    server = createServer((s) => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const serverPort = (server.address() as any).port as number;

    // Real tree: anchor (cliPid) -> hostChild (resident runner, before the turn)
    const anchor = spawnResident();
    await sleep(150);
    anchor.stdin!.write('spawn-child\n');
    const hostChildPid = Number((await waitLine(anchor, /SPAWNED (\d+)/))[1]);
    const anchorPid = anchor.pid!;
    await sleep(150);
    const anchorStart = procStart(anchorPid);
    const hostChildStart = procStart(hostChildPid);

    // Daemon snapshot of the anchor lineage — taken BEFORE any turn command
    const snapshot = snapshotProcessIdentities(anchorPid, '/proc');
    expect(snapshot).toBeDefined();
    expect(snapshot).toContain(`${anchorPid}:${anchorStart}`);
    expect(snapshot).toContain(`${hostChildPid}:${hostChildStart}`);

    const attest = (peerPid: number, peerStart: string) => attestCurrentTurnLoopbackPeer({
      sessionId: 's-real',
      peer: { pid: peerPid, procStart: peerStart },
      findSession: () => activeSession(anchorPid, anchorStart, snapshot),
      procRoot: '/proc',
    });
    const resolvePeer = (ephem: number) => resolveLoopbackPeerProcesses({
      remoteAddress: '127.0.0.1', remotePort: ephem, localPort: serverPort, procRoot: '/proc',
    });

    // REJECT: current-turn client nested under the snapshotted host runner
    anchor.stdin!.write(`to-child connect ${serverPort}\n`);
    const rej = await waitLine(anchor, /CLIENT (\d+) (\d+)/);
    await sleep(120);
    const rejPeer = resolvePeer(Number(rej[2]));
    expect(rejPeer.ok).toBe(true);
    const rejVerdict = rejPeer.ok ? attest(rejPeer.peer.pid, rejPeer.peer.procStart) : null;
    expect(rejVerdict).toBeNull();

    // SUCCESS control: current-turn client spawned directly under the anchor
    anchor.stdin!.write(`connect ${serverPort}\n`);
    const ok = await waitLine(anchor, /CLIENT (\d+) (\d+)/);
    await sleep(120);
    const okPeer = resolvePeer(Number(ok[2]));
    expect(okPeer.ok).toBe(true);
    const okVerdict = okPeer.ok ? attest(okPeer.peer.pid, okPeer.peer.procStart) : null;
    expect(okVerdict).not.toBeNull();
    expect(okVerdict!.turnId).toBe('om_turn_real');
    expect(okVerdict!.cliPid).toBe(anchorPid);
    expect(okVerdict!.callerOpenId).toBe('ou_realuser');
  }, 30_000);
});
