import { describe, it, expect } from 'vitest';
import { buildReproduceCommand } from '../src/adapters/backend/reproduce-command.js';

// Dashboard「复现命令」跨后端准确性（codex review issue 1）。
describe('buildReproduceCommand', () => {
  const baseEnv = {
    SESSION_DATA_DIR: '/home/u/.botmux/data/s1',
    BOTMUX_SESSION_ID: 'sess-1',
    BOTMUX_LARK_APP_ID: 'cli_app',
    CLAUDE_CONFIG_DIR: '/home/u/.botmux/claude/cli_app',
    // 不在注入 allowlist 里的键不应出现：
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
  } as NodeJS.ProcessEnv;

  it('riff backend returns null (no local command — never fabricate one)', () => {
    expect(buildReproduceCommand({
      backendType: 'riff',
      bin: '/opt/claude',
      args: ['--session-id', 's1'],
      cwd: '/repo',
      env: baseEnv,
    })).toBeNull();
  });

  it('empty bin returns null', () => {
    expect(buildReproduceCommand({
      backendType: 'pty',
      bin: '',
      args: [],
      env: baseEnv,
    })).toBeNull();
  });

  it('pty backend: cd + injected botmux env + bin + args, shell-quoted', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: ['--session-id', 's1', '--model', 'x'],
      cwd: '/repo path',
      env: baseEnv,
    })!;
    expect(cmd).toContain("cd '/repo path' &&");
    // 权威注入 env（BOTMUX keys）必须在，带引号：
    expect(cmd).toContain("SESSION_DATA_DIR='/home/u/.botmux/data/s1'");
    expect(cmd).toContain("BOTMUX_SESSION_ID='sess-1'");
    expect(cmd).toContain("CLAUDE_CONFIG_DIR='/home/u/.botmux/claude/cli_app'");
    // 非 allowlist 的 PATH/HOME 不应作为前缀注入（由用户 rcfile 提供）：
    expect(cmd).not.toContain("PATH='/usr/bin:/bin'");
    expect(cmd).not.toContain("HOME='/home/u'");
    // bin + args：
    expect(cmd).toContain("'/opt/claude' '--session-id' 's1' '--model' 'x'");
  });

  it('tmux backend also emits the authoritative injected env (parity with pty)', () => {
    const cmd = buildReproduceCommand({
      backendType: 'tmux',
      bin: '/opt/codex',
      args: ['resume'],
      cwd: '/repo',
      env: { ...baseEnv, CODEX_HOME: '/home/u/.botmux/codex/cli_app' },
    })!;
    expect(cmd).toContain("CODEX_HOME='/home/u/.botmux/codex/cli_app'");
    expect(cmd).toContain("'/opt/codex' 'resume'");
  });

  it('per-bot injectEnv (provider creds) are included and quoted', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: [],
      env: baseEnv,
      injectEnv: { ANTHROPIC_API_KEY: 'sk-secret with space' },
    })!;
    expect(cmd).toContain("ANTHROPIC_API_KEY='sk-secret with space'");
  });

  it('single quotes in values are safely escaped for bash paste', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: ["it's"],
      env: {},
    })!;
    // ' → '\'' 序列
    expect(cmd).toContain("'it'\\''s'");
  });

  it('no cwd → command without leading cd', () => {
    const cmd = buildReproduceCommand({
      backendType: 'pty',
      bin: '/opt/claude',
      args: [],
      env: {},
    })!;
    expect(cmd.startsWith('cd ')).toBe(false);
    expect(cmd).toContain("'/opt/claude'");
  });
});
