import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { attestCurrentTurnLoopbackPeer, snapshotProcessIdentities } from '../src/core/current-actor-attestation.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

async function until(predicate: () => boolean, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for worker/process observation');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(process.platform !== 'linux')('Codex launcher current-turn attestation through worker IPC', () => {
  it('anchors the native CLI and retains old-process and session boundaries', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-launcher-attestation-')));
    const data = join(root, 'session');
    const home = join(root, 'codex-home');
    mkdirSync(data);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), '{"tokens":{"access_token":"fixture-only"}}', { mode: 0o600 });
    const observations = join(root, 'processes.jsonl');
    const command = join(root, 'command.json');
    const oldCommand = join(root, 'old-command');
    const script = join(root, 'process.cjs');
    writeFileSync(script, `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const role = process.argv[2];
if (role === 'cli') process.title = 'codex';
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ role, pid: process.pid }) + '\\n');
function child(role) { return spawn(process.execPath, [${JSON.stringify(script)}, role], { stdio: 'inherit' }); }
if (role === 'launcher') setTimeout(() => child('cli'), 300);
let last = '';
setInterval(() => {
  const path = role === 'cli' ? ${JSON.stringify(command)} : role === 'old-helper' ? ${JSON.stringify(oldCommand)} : '';
  if (!path || !fs.existsSync(path)) return;
  const value = fs.readFileSync(path, 'utf8');
  if (value === last) return;
  last = value;
  child(value);
}, 25);
process.stdin.resume();
`);
    const launcher = join(root, 'codex-launcher');
    writeFileSync(launcher, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.1.0'); process.exit(0); }
process.argv[2] = 'launcher';
require(${JSON.stringify(script)});
`, { mode: 0o755 });
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    let worker: ChildProcess | undefined;
    const rows = (): Array<{ role: string; pid: number }> => existsSync(observations)
      ? readFileSync(observations, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const pidFor = (role: string) => rows().find(row => row.role === role)?.pid;
    try {
      worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: { ...process.env, HOME: root, CODEX_HOME: home, SESSION_DATA_DIR: data,
          BOTMUX_SESSION_ID: 'launcher-test', BOTMUX_TIME_SCALE: '0.05', LARK_APP_ID: 'cli_fixture', LARK_APP_SECRET: 'fixture' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      worker.on('message', raw => messages.push(raw as WorkerToDaemon));
      worker.stdout?.on('data', chunk => logs.push(chunk.toString()));
      worker.stderr?.on('data', chunk => logs.push(chunk.toString()));
      worker.send({ type: 'init', sessionId: 'launcher-test', chatId: 'oc_fixture', rootMessageId: 'om_fixture',
        workingDir: data, cliId: 'codex', cliPathOverride: launcher, backendType: 'pty', prompt: '', readIsolation: false,
        cliInstanceBinding: { version: 1, source: 'default', instanceId: 'fixture', cliId: 'codex', codexHome: home, authMode: 'isolated' },
        larkAppId: 'cli_fixture', larkAppSecret: 'fixture',
      } satisfies DaemonToWorker);
      await until(() => !!pidFor('cli'));
      const cliPid = pidFor('cli')!;
      await until(() => messages.some(m => m.type === 'local_process_attestation' && m.cliPid === cliPid));
      const anchor = messages.findLast(m => m.type === 'local_process_attestation' && m.cliPid === cliPid);
      expect(anchor?.type).toBe('local_process_attestation');
      if (anchor?.type !== 'local_process_attestation') throw new Error('Missing worker attestation');
      expect(anchor.cliPid).not.toBe(pidFor('launcher'));
      writeFileSync(command, 'old-helper');
      await until(() => !!pidFor('old-helper'));
      const session: any = {
        session: { sessionId: 'launcher-test', status: 'active' }, chatId: 'oc_fixture', larkAppId: 'cli_fixture',
        worker, workerGeneration: 1,
        localProcessAttestation: { ...anchor, workerGeneration: 1 },
        managedTurnOrigin: { turnId: 'turn-new', callerOpenId: 'ou_current', capability: 'fixture-capability',
          preexistingProcessIdentities: snapshotProcessIdentities(cliPid) },
      };
      writeFileSync(command, 'new-tool');
      writeFileSync(oldCommand, 'old-tool');
      await until(() => !!pidFor('new-tool') && !!pidFor('old-tool'));
      const attest = (role: string, sessionId = 'launcher-test') => attestCurrentTurnLoopbackPeer({
        sessionId, peer: { pid: pidFor(role)!, procStart: readProcessStartIdentity(pidFor(role)!)! },
        findSession: id => id === 'launcher-test' ? session : {
          ...session, session: { sessionId: 'other-session', status: 'active' },
          localProcessAttestation: { ...session.localProcessAttestation,
            cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) },
          managedTurnOrigin: { ...session.managedTurnOrigin,
            preexistingProcessIdentities: snapshotProcessIdentities(process.pid) },
        },
      });
      expect(attest('new-tool')).not.toBeNull();
      expect(attest('old-tool')).toBeNull();
      expect(attest('new-tool', 'other-session')).toBeNull();
      session.workerGeneration = 2;
      expect(attest('new-tool')).toBeNull();
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\n${logs.join('')}`);
    } finally {
      if (worker?.connected) worker.send({ type: 'close' }, () => {});
      if (worker) await until(() => worker!.exitCode !== null || worker!.signalCode !== null, 3000).catch(() => worker!.kill('SIGKILL'));
      for (const { pid } of rows().reverse()) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
