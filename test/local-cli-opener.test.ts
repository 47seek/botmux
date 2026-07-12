/**
 * local-cli-opener: local terminal command construction and launch guards.
 * Run: pnpm vitest run test/local-cli-opener.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  appleScriptQuote,
  buildItermAppleScript,
  buildLocalCliOpenCommand,
  buildTerminalAppleScript,
  openLocalCliInIterm,
  shellQuote,
} from '../src/services/local-cli-opener.js';
import type { DaemonSession } from '../src/core/types.js';

function ds(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '',
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    workerPort: null,
    workerToken: null,
    workingDir: "/tmp/project's dir",
    session: {
      sessionId: 'botmux sid',
      cliSessionId: "native'id",
      cliId: 'codex',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'task',
      status: 'active',
      createdAt: new Date().toISOString(),
      workingDir: '/tmp/ignored',
    },
    ...overrides,
  } as DaemonSession;
}

describe('local-cli-opener', () => {
  it('quotes shell arguments for cwd and resume id', () => {
    expect(shellQuote("a'b c")).toBe("'a'\\''b c'");

    const result = buildLocalCliOpenCommand(ds(), {
      adapterFactory: () => ({
        buildResumeCommand: () => "codex resume native'id",
      }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/tmp/project'\\''s dir' && codex resume 'native'\\''id'",
    });
  });

  it('uses adapter resume for managed tmux sessions instead of tmux attach', () => {
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume native-managed' }));
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'tmux', cliSessionId: 'native-managed' },
    }), { adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "cd '/tmp/project'\\''s dir' && codex resume 'native-managed'",
    });
    expect(adapterFactory).toHaveBeenCalledWith('codex');
    expect(result.ok && result.command).not.toContain('tmux');
    expect(result.ok && result.command).not.toContain('attach');
  });

  it('uses adapter resume for adopted tmux sessions and falls back to adopted session id', () => {
    const adapterFactory = vi.fn((cliId) => ({
      buildResumeCommand: ({ cliSessionId }: { cliSessionId?: string }) => `${cliId} resume ${cliSessionId}`,
    }));
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'traex', cwd: '/repo', sessionId: 'adopt-native' },
      workingDir: undefined,
      session: { ...ds().session, cliId: 'traex', cliSessionId: undefined, workingDir: undefined },
    }), { adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "cd '/repo' && traex resume 'adopt-native'",
    });
    expect(adapterFactory).toHaveBeenCalledWith('traex');
    expect(result.ok && result.command).not.toContain('tmux');
    expect(result.ok && result.command).not.toContain('attach');
  });

  it('prefers adopted session id over a stale prior cliSessionId', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'codex', cwd: '/repo', sessionId: 'current-adopt-native' },
      workingDir: undefined,
      session: {
        ...ds().session,
        cliId: 'codex',
        cliSessionId: 'stale-prior-native',
        workingDir: undefined,
      },
    }), {
      adapterFactory: () => ({ buildResumeCommand: ({ cliSessionId }) => `codex resume ${cliSessionId}` }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/repo' && codex resume 'current-adopt-native'",
    });
    expect(result.ok && result.command).not.toContain('stale-prior-native');
    expect(result.ok && result.command).not.toContain('tmux');
  });

  it('falls back to persisted adopted metadata when live adopted metadata is absent', () => {
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: undefined,
      workingDir: undefined,
      session: {
        ...ds().session,
        cliId: 'codex',
        cliSessionId: undefined,
        workingDir: undefined,
        adoptedFrom: { source: 'tmux', tmuxTarget: 'dev:1.2', cliId: 'codex', cwd: '/persisted', sessionId: 'persisted-native' },
      },
    }), {
      adapterFactory: () => ({ buildResumeCommand: ({ cliSessionId }) => `codex resume ${cliSessionId}` }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/persisted' && codex resume 'persisted-native'",
    });
  });

  it('returns a clear error when adapter cannot resolve a resume id', () => {
    const result = buildLocalCliOpenCommand(ds(), {
      adapterFactory: () => ({ buildResumeCommand: () => null }),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('missing_resume_id');
  });

  it('rejects unsupported adapter resume commands, including URL schemes', () => {
    const unsupported = buildLocalCliOpenCommand(ds(), {
      adapterFactory: () => ({ buildResumeCommand: () => 'codex --resume sid' }),
    });
    expect(unsupported.ok).toBe(false);
    expect(!unsupported.ok && unsupported.error).toBe('missing_resume_id');
    expect(!unsupported.ok && unsupported.message).toContain('unsupported resume command');

    const scheme = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'native1' },
    }), {
      adapterFactory: () => ({ buildResumeCommand: () => 'traex://resume/native1' }),
    });
    expect(scheme.ok).toBe(false);
    expect(!scheme.ok && scheme.error).toBe('missing_resume_id');
    expect(!scheme.ok && scheme.message).toContain('unsupported resume command');
  });

  it('escapes AppleScript string literals used by terminal launch scripts', () => {
    expect(appleScriptQuote('echo "x" \\ done')).toBe('"echo \\"x\\" \\\\ done"');
    expect(buildItermAppleScript('echo "x"')).toContain('write text "echo \\"x\\""');
    expect(buildTerminalAppleScript('echo "x"')).toContain('do script "echo \\"x\\""');
  });

  it('rejects non-macOS before probing local terminal apps', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const adapterFactory = vi.fn(() => ({ buildResumeCommand: () => 'codex resume sid' }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'linux',
      runOsascript,
      adapterFactory,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('unsupported_platform');
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(runOsascript).not.toHaveBeenCalled();
  });

  it('launches iTerm by absolute app path first', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript).toHaveBeenCalledTimes(1);
    expect(runOsascript.mock.calls[0][0][0]).toBe('-e');
    const script = runOsascript.mock.calls[0][0][1];
    expect(script).toContain('tell application "/Applications/iTerm.app"');
    expect(script).toContain("codex resume 'sid'");
  });

  it('tries iTerm absolute path, bundle id, then app name before Terminal fallback', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'path failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'name failed' })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript.mock.calls[0][0][1]).toContain('tell application "/Applications/iTerm.app"');
    expect(runOsascript.mock.calls[1][0][1]).toContain('tell application id "com.googlecode.iterm2"');
    expect(runOsascript.mock.calls[2][0][1]).toContain('tell application "iTerm"');
    expect(runOsascript.mock.calls[3][0][1]).toContain('tell application "/System/Applications/Utilities/Terminal.app"');
  });

  it('tries Terminal bundle id after the absolute Terminal path fails', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'path failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'name failed' })
      .mockResolvedValueOnce({ ok: false, stderr: 'terminal path failed' })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript.mock.calls[4][0][1]).toContain('tell application id "com.apple.Terminal"');
  });

  it('reports a local terminal error when neither iTerm nor Terminal.app can be opened', async () => {
    const runOsascript = vi.fn(async () => ({ ok: false, stderr: 'automation denied' }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('terminal_unavailable');
    expect(!result.ok && result.message).toContain('Terminal.app');
    expect(runOsascript).toHaveBeenCalledTimes(5);
  });

  it('launches TRAE in iTerm with traex resume instead of URL schemes', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds({
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'trae-native' },
    }), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'traex resume trae-native' }),
    });

    expect(result.ok).toBe(true);
    const script = runOsascript.mock.calls[0][0][1];
    expect(script).toContain('tell application "/Applications/iTerm.app"');
    expect(script).toContain("traex resume 'trae-native'");
    expect(script).not.toMatch(/\b(?:trae|traex):\/\//);
  });
});
