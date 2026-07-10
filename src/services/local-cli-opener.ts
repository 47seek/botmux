import { execFile } from 'node:child_process';
import type { CliAdapter, CliId } from '../adapters/cli/types.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { DaemonSession } from '../core/types.js';
import { getSessionPersistentBackendType, persistentSessionName } from '../core/persistent-backend.js';

export type LocalCliId = Extract<CliId, 'codex' | 'traex'>;

export type LocalCliOpenError =
  | 'unsupported_cli'
  | 'unsupported_platform'
  | 'iterm_unavailable'
  | 'terminal_unavailable'
  | 'unsupported_adopt_backend'
  | 'invalid_tmux_target'
  | 'missing_working_dir'
  | 'missing_resume_id';

export type LocalCliOpenResult =
  | { ok: true; command: string }
  | { ok: false; error: LocalCliOpenError; message: string };

export interface LocalCliOpenerDeps {
  platform?: NodeJS.Platform;
  adapterFactory?: (cliId: LocalCliId) => Pick<CliAdapter, 'buildResumeCommand'>;
  runOsascript?: (args: string[]) => Promise<{ ok: boolean; stderr?: string }>;
}

const OSASCRIPT = '/usr/bin/osascript';
const ITERM_APPLICATIONS = [
  {
    probeScript: 'id of application id "com.googlecode.iterm2"',
    tellTarget: 'application id "com.googlecode.iterm2"',
  },
  {
    probeScript: 'id of application "iTerm"',
    tellTarget: 'application "iTerm"',
  },
] as const;
const TERMINAL_APPLICATION = {
  probeScript: 'id of application id "com.apple.Terminal"',
  tellTarget: 'application id "com.apple.Terminal"',
} as const;

function fail(error: LocalCliOpenError, message: string): LocalCliOpenResult {
  return { ok: false, error, message };
}

function localCliId(cliId: string | undefined): LocalCliId | undefined {
  return cliId === 'codex' || cliId === 'traex' ? cliId : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;
}

function sessionWorkingDir(ds: DaemonSession): string | undefined {
  return ds.workingDir ?? ds.session.workingDir ?? ds.adoptedFrom?.cwd ?? ds.session.adoptedFrom?.cwd;
}

function resumeBin(cliId: LocalCliId): string {
  return cliId === 'codex' ? 'codex' : 'traex';
}

function quoteKnownResumeCommand(cliId: LocalCliId, raw: string): string | null {
  const prefix = `${resumeBin(cliId)} resume `;
  if (!raw.startsWith(prefix)) return null;
  const sid = raw.slice(prefix.length).trim();
  if (!sid) return null;
  return `${resumeBin(cliId)} resume ${shellQuote(sid)}`;
}

export function buildTmuxAttachCommand(tmuxTarget: string): string | null {
  const target = tmuxTarget.trim();
  const colon = target.lastIndexOf(':');
  if (colon <= 0 || colon === target.length - 1) return null;

  const sessionTarget = target.slice(0, colon);
  const dot = target.lastIndexOf('.');
  const windowTarget = dot > colon ? target.slice(0, dot) : target;
  return [
    'tmux',
    'select-window',
    '-t',
    shellQuote(windowTarget),
    '\\;',
    'select-pane',
    '-t',
    shellQuote(target),
    '\\;',
    'attach-session',
    '-t',
    shellQuote(sessionTarget),
  ].join(' ');
}

export function buildItermAppleScript(command: string, tellTarget: string = ITERM_APPLICATIONS[0].tellTarget): string {
  return [
    `tell ${tellTarget}`,
    '  activate',
    '  set newWindow to (create window with default profile)',
    '  tell current session of newWindow',
    `    write text ${appleScriptQuote(command)}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

export function buildTerminalAppleScript(command: string, tellTarget: string = TERMINAL_APPLICATION.tellTarget): string {
  return [
    `tell ${tellTarget}`,
    '  activate',
    `  do script ${appleScriptQuote(command)}`,
    'end tell',
  ].join('\n');
}

export function buildLocalCliOpenCommand(
  ds: DaemonSession,
  opts: { cliId?: CliId; adapterFactory?: LocalCliOpenerDeps['adapterFactory'] } = {},
): LocalCliOpenResult {
  const cliId = localCliId(opts.cliId ?? ds.session.cliId ?? ds.adoptedFrom?.cliId ?? ds.session.adoptedFrom?.cliId);
  if (!cliId) return fail('unsupported_cli', 'Only Codex and TRAE can be opened locally.');

  const adopted = ds.adoptedFrom ?? ds.session.adoptedFrom;
  if (adopted) {
    if (adopted.tmuxTarget) {
      const command = buildTmuxAttachCommand(adopted.tmuxTarget);
      return command
        ? { ok: true, command }
        : fail('invalid_tmux_target', `Invalid tmux target: ${adopted.tmuxTarget}`);
    }
    const source = adopted.source ?? (adopted.zellijPaneId ? 'zellij' : adopted.herdrTarget ? 'herdr' : 'unknown');
    return fail('unsupported_adopt_backend', `${source} adopt sessions cannot be opened locally yet.`);
  }

  const backendType = getSessionPersistentBackendType(ds);
  if (backendType === 'tmux') {
    return {
      ok: true,
      command: `tmux attach-session -t ${shellQuote(persistentSessionName('tmux', ds.session.sessionId))}`,
    };
  }
  if (backendType === 'zellij' || backendType === 'herdr') {
    return fail('unsupported_adopt_backend', `${backendType} active sessions cannot be opened locally yet.`);
  }

  const workingDir = sessionWorkingDir(ds);
  if (!workingDir) return fail('missing_working_dir', 'Session working directory is missing.');

  const adapter = opts.adapterFactory?.(cliId) ?? createCliAdapterSync(cliId);
  const rawResume = adapter.buildResumeCommand?.({
    sessionId: ds.session.sessionId,
    cliSessionId: ds.session.cliSessionId,
  });
  if (!rawResume) return fail('missing_resume_id', `${resumeBin(cliId)} does not have a resumable session id yet.`);

  const resumeCommand = quoteKnownResumeCommand(cliId, rawResume);
  if (!resumeCommand) return fail('missing_resume_id', `${resumeBin(cliId)} returned an unsupported resume command.`);

  return { ok: true, command: `cd ${shellQuote(workingDir)} && ${resumeCommand}` };
}

function defaultRunOsascript(args: string[]): Promise<{ ok: boolean; stderr?: string }> {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, args, { timeout: 15_000 }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: stderr?.trim() || (err ? String(err) : undefined) });
    });
  });
}

function terminalUnavailableMessage(errors: string[]): string {
  const detail = [...errors].reverse().find((e) => e.trim().length > 0);
  const base = 'Neither iTerm nor Terminal.app could be opened with AppleScript.';
  return detail
    ? `${base} Install iTerm or allow Automation access, then retry. Last error: ${detail}`
    : `${base} Install iTerm or allow Automation access, then retry.`;
}

export async function openLocalCliInIterm(
  ds: DaemonSession,
  deps: LocalCliOpenerDeps & { cliId?: CliId } = {},
): Promise<LocalCliOpenResult> {
  const built = buildLocalCliOpenCommand(ds, { cliId: deps.cliId, adapterFactory: deps.adapterFactory });
  if (!built.ok) return built;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') {
    return fail('unsupported_platform', 'Opening a local CLI is only supported on macOS.');
  }

  const runOsascript = deps.runOsascript ?? defaultRunOsascript;
  const errors: string[] = [];
  for (const app of ITERM_APPLICATIONS) {
    const probe = await runOsascript(['-e', app.probeScript]);
    if (!probe.ok) {
      if (probe.stderr) errors.push(probe.stderr);
      continue;
    }
    const launched = await runOsascript(['-e', buildItermAppleScript(built.command, app.tellTarget)]);
    if (launched.ok) return built;
    if (launched.stderr) errors.push(launched.stderr);
  }

  const terminalProbe = await runOsascript(['-e', TERMINAL_APPLICATION.probeScript]);
  if (terminalProbe.ok) {
    const launched = await runOsascript(['-e', buildTerminalAppleScript(built.command)]);
    if (launched.ok) return built;
    if (launched.stderr) errors.push(launched.stderr);
  } else if (terminalProbe.stderr) {
    errors.push(terminalProbe.stderr);
  }

  return fail('terminal_unavailable', terminalUnavailableMessage(errors));
}
