/**
 * local-cli-opener: local terminal command construction and launch guards.
 * Run: pnpm vitest run test/local-cli-opener.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import {
  appleScriptQuote,
  buildItermAppleScript,
  buildLocalCliOpenCommand,
  buildTmuxAttachCommand,
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

  it('uses tmux attach/select command before adapter resume for adopted tmux sessions', () => {
    const adapterFactory = vi.fn();
    const result = buildLocalCliOpenCommand(ds({
      adoptedFrom: { tmuxTarget: "dev's:2.3", cliId: 'traex', cwd: '/repo' },
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'trae-native' },
    }), { adapterFactory });

    expect(result.ok).toBe(true);
    expect(result.ok && result.command).toBe(
      "tmux select-window -t 'dev'\\''s:2' \\; select-pane -t 'dev'\\''s:2.3' \\; attach-session -t 'dev'\\''s'",
    );
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('attaches normal botmux-managed tmux sessions instead of opening a second resumed CLI', () => {
    const adapterFactory = vi.fn();
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, sessionId: 'abcdef12-3456', backendType: 'tmux', cliSessionId: undefined },
    }), { adapterFactory });

    expect(result).toEqual({
      ok: true,
      command: "tmux attach-session -t 'bmx-abcdef12'",
    });
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('falls back to adapter resume for non-tmux active sessions', () => {
    const result = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'pty' },
    }), {
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid-pty' }),
    });

    expect(result).toEqual({
      ok: true,
      command: "cd '/tmp/project'\\''s dir' && codex resume 'sid-pty'",
    });
  });

  it('rejects managed zellij/herdr active sessions instead of opening a second CLI', () => {
    const zellij = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'zellij' },
    }), {
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid-zellij' }),
    });
    expect(zellij.ok).toBe(false);
    expect(!zellij.ok && zellij.error).toBe('unsupported_adopt_backend');

    const herdr = buildLocalCliOpenCommand(ds({
      session: { ...ds().session, backendType: 'herdr' },
    }), {
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid-herdr' }),
    });
    expect(herdr.ok).toBe(false);
    expect(!herdr.ok && herdr.error).toBe('unsupported_adopt_backend');
  });

  it('rejects zellij/herdr adopted sessions instead of falling back', () => {
    const zellij = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'zellij', zellijSession: 'z', zellijPaneId: 'p', cliId: 'codex', cwd: '/repo' },
    }));
    expect(zellij.ok).toBe(false);
    expect(!zellij.ok && zellij.error).toBe('unsupported_adopt_backend');

    const herdr = buildLocalCliOpenCommand(ds({
      adoptedFrom: { source: 'herdr', herdrTarget: 'h', cliId: 'traex', cwd: '/repo' },
      session: { ...ds().session, cliId: 'traex' },
    }));
    expect(herdr.ok).toBe(false);
    expect(!herdr.ok && herdr.error).toBe('unsupported_adopt_backend');
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
  });

  it('rejects non-macOS before probing local terminal apps', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'linux',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('unsupported_platform');
    expect(runOsascript).not.toHaveBeenCalled();
  });

  it('probes iTerm by bundle id and launches via /usr/bin/osascript command payloads', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript).toHaveBeenNthCalledWith(1, ['-e', 'id of application id "com.googlecode.iterm2"']);
    expect(runOsascript.mock.calls[1][0][0]).toBe('-e');
    expect(runOsascript.mock.calls[1][0][1]).toContain('tell application id "com.googlecode.iterm2"');
    expect(runOsascript.mock.calls[1][0][1]).toContain("codex resume 'sid'");
  });

  it('tries the iTerm app name after the bundle-id probe fails', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id unavailable' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript).toHaveBeenNthCalledWith(1, ['-e', 'id of application id "com.googlecode.iterm2"']);
    expect(runOsascript).toHaveBeenNthCalledWith(2, ['-e', 'id of application "iTerm"']);
    const script = runOsascript.mock.calls[2][0][1];
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain("codex resume 'sid'");
  });

  it('tries the iTerm app name after bundle-id launch fails without falling back to Terminal.app', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, stderr: 'automation denied' })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(true);
    expect(runOsascript).toHaveBeenCalledTimes(4);
    expect(runOsascript).toHaveBeenNthCalledWith(3, ['-e', 'id of application "iTerm"']);
    const script = runOsascript.mock.calls[3][0][1];
    expect(script).toContain('tell application "iTerm"');
    expect(script).toContain("codex resume 'sid'");
    expect(runOsascript.mock.calls.some((call) => String(call[0][1]).includes('Terminal'))).toBe(false);
  });

  it('does not fall back to Terminal.app when iTerm cannot be opened', async () => {
    const runOsascript = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, stderr: 'bundle id unavailable' })
      .mockResolvedValueOnce({ ok: false, stderr: 'iTerm not found' });
    const result = await openLocalCliInIterm(ds(), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'codex resume sid' }),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('iterm_unavailable');
    expect(!result.ok && result.message).toContain('iTerm');
    expect(runOsascript).toHaveBeenCalledTimes(2);
    expect(runOsascript.mock.calls.some((call) => String(call[0][1]).includes('Terminal'))).toBe(false);
  });

  it('launches TRAE in iTerm with traex resume instead of Trae app or URL schemes', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds({
      session: { ...ds().session, cliId: 'traex', cliSessionId: 'trae-native' },
    }), {
      platform: 'darwin',
      runOsascript,
      adapterFactory: () => ({ buildResumeCommand: () => 'traex resume trae-native' }),
    });

    expect(result.ok).toBe(true);
    const script = runOsascript.mock.calls[1][0][1];
    expect(script).toContain('tell application id "com.googlecode.iterm2"');
    expect(script).toContain("traex resume 'trae-native'");
    expect(script).not.toContain('tell application "Trae"');
    expect(script).not.toMatch(/\b(?:trae|traex):\/\//);
  });

  it('launches managed tmux sessions in iTerm with tmux attach', async () => {
    const runOsascript = vi.fn(async () => ({ ok: true }));
    const result = await openLocalCliInIterm(ds({
      session: { ...ds().session, sessionId: 'abcdef12-3456', backendType: 'tmux', cliSessionId: undefined },
    }), {
      platform: 'darwin',
      runOsascript,
    });

    expect(result.ok).toBe(true);
    const script = runOsascript.mock.calls[1][0][1];
    expect(script).toContain('tell application id "com.googlecode.iterm2"');
    expect(script).toContain("tmux attach-session -t 'bmx-abcdef12'");
    expect(script).not.toContain('codex resume');
  });
});

describe('buildTmuxAttachCommand', () => {
  it('rejects targets without an attachable session/window target', () => {
    expect(buildTmuxAttachCommand('%1')).toBeNull();
  });
});
