/**
 * card-handler open_local_cli action: permission gate, active-session lookup,
 * CLI binding validation, and immediate opener ack.
 * Run: pnpm vitest run test/card-handler-open-local-cli.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/local-cli-opener.js', () => ({
  openLocalCliInIterm: vi.fn(),
}));

const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

function makeDs(cliId: 'codex' | 'traex' = 'codex'): DaemonSession {
  return {
    larkAppId: 'h1',
    chatId: 'oc_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '',
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    workerPort: null,
    workerToken: null,
    workingDir: '/repo/real',
    session: {
      sessionId: 'sess1',
      cliId,
      cliSessionId: 'native1',
      chatId: 'oc_1',
      rootMessageId: 'om_root',
      title: 'task',
      status: 'active',
      createdAt: new Date().toISOString(),
      workingDir: '/repo/real',
    },
  } as DaemonSession;
}

function action(operator: string, cliId?: string): any {
  return {
    operator: { open_id: operator },
    action: {
      value: {
        action: 'open_local_cli',
        root_id: 'om_root',
        session_id: 'sess1',
        ...(cliId ? { cli_id: cliId } : {}),
        cwd: '/tmp/card-value-must-not-be-used',
        command: 'rm -rf /',
      },
    },
  };
}

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const types = await import('../src/core/types.js');
  const opener = await import('../src/services/local-cli-opener.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  vi.mocked(opener.openLocalCliInIterm).mockReset();
  return { types, opener, handler };
}

beforeEach(() => {
  deps.activeSessions = new Map();
  deps.sessionReply = vi.fn(async () => 'mid');
  const dir = mkdtempSync(join(tmpdir(), 'botmux-open-local-cli-'));
  const cfg = join(dir, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'codex', allowedUsers: ['ou_owner'] }], null, 2));
  process.env.BOTS_CONFIG = cfg;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
});

describe('card-handler open_local_cli', () => {
  it('authorized operator opens the active session through the local opener', async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('codex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockReturnValueOnce(new Promise(() => {}) as any);

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(res.toast.content).toContain('正在打开');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledTimes(1);
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'codex' });
  });

  it('non-operator is blocked by the sensitive canOperate gate before local command execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_intruder', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('没有操作权限');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('stale card CLI mismatch is rejected before opener execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_owner', 'traex'), deps, 'h1');

    expect(res?.toast?.type).toBe('error');
    expect(res.toast.content).toContain('CLI');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('missing cli_id is rejected before opener execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_owner'), deps, 'h1');

    expect(res?.toast?.type).toBe('error');
    expect(res.toast.content).toContain('CLI');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('opener failure is handled asynchronously after an immediate ack', async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('traex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockResolvedValueOnce({
      ok: false,
      error: 'terminal_unavailable',
      message: 'No local terminal is available',
    });

    const res = await handler.handleCardAction(action('ou_owner', 'traex'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(res.toast.content).toContain('正在打开');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'traex' });
    await Promise.resolve();
    expect(deps.sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('No local terminal is available'),
      undefined,
      'h1',
    );
  });

  it('missing active session returns session_gone and does not trust card cwd/command', async () => {
    const { opener, handler } = await fresh();

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });
});
