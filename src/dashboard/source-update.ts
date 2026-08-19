import { spawn } from 'node:child_process';
import { access, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type SourceUpdateBlockedReason =
  | 'not_source_checkout'
  | 'git_unavailable'
  | 'dirty_worktree'
  | 'detached_head'
  | 'no_upstream'
  | 'diverged'
  | 'preflight_failed';
export type SourceUpdateStage = 'preflight' | 'pull' | 'install' | 'build' | 'verify';

export interface SourceUpdateInspection {
  supported: boolean;
  root: string;
  branch: string | null;
  upstream: string | null;
  head: string | null;
  clean: boolean;
  /** Working tree has local changes that will be stashed before the update and restored after. */
  needsStash: boolean;
  /**
   * Resolved pull target. `null` for a branch with a configured upstream (plain `git pull --ff-only`).
   * For a branch without an upstream, this is `origin/<branch>` when that remote-tracking ref exists.
   */
  pullTarget: string | null;
  blockedReason: SourceUpdateBlockedReason | null;
}

export interface SourceUpdateResult {
  oldHead: string;
  newHead: string;
  changed: boolean;
  branch: string;
  upstream: string;
  /** Set when local changes were stashed but could not be restored cleanly after the update. */
  stashConflict?: {
    ref: string;
    detail: string;
  };
}

export interface SourceUpdateCommand {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  shell: false;
}

export interface SourceUpdateCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: NodeJS.ErrnoException;
}

export type SourceUpdateCommandRunner = (
  command: SourceUpdateCommand,
) => Promise<SourceUpdateCommandResult>;

interface SourceUpdateFs {
  access(path: string): Promise<void>;
  realpath(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
}

export interface SourceUpdateOptions {
  runCommand?: SourceUpdateCommandRunner;
  fs?: SourceUpdateFs;
  platform?: NodeJS.Platform;
  now?: () => number;
}

const defaultFs: SourceUpdateFs = { access, realpath, rename, rm, stat };
const PREFLIGHT_TIMEOUT_MS = 10_000;
const STASH_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_BYTES = 16 * 1024;
const DETAIL_LIMIT = 12 * 1024;

export class SourceUpdateError extends Error {
  readonly stage: SourceUpdateStage;
  readonly detail: string;

  constructor(stage: SourceUpdateStage, detail: string) {
    const boundedDetail = boundedTail(detail, DETAIL_LIMIT);
    super(boundedDetail);
    this.name = 'SourceUpdateError';
    this.stage = stage;
    this.detail = boundedDetail;
  }
}

type ResolvedDependencies = {
  runCommand: SourceUpdateCommandRunner;
  fs: SourceUpdateFs;
  platform: NodeJS.Platform;
  now: () => number;
};

function dependencies(options: SourceUpdateOptions): ResolvedDependencies {
  return {
    runCommand: options.runCommand ?? runSourceUpdateCommand,
    fs: options.fs ?? defaultFs,
    platform: options.platform ?? process.platform,
    now: options.now ?? Date.now,
  };
}

function boundedTail(value: string, limit: number): string {
  const withoutNul = value.replaceAll('\0', '').trim();
  return withoutNul.length <= limit ? withoutNul : `…${withoutNul.slice(-(limit - 1))}`;
}

function appendTail(current: string, chunk: Buffer | string): string {
  const combined = current + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
  if (Buffer.byteLength(combined, 'utf8') <= OUTPUT_TAIL_BYTES) return combined;
  return Buffer.from(combined, 'utf8').subarray(-OUTPUT_TAIL_BYTES).toString('utf8');
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise(resolveKill => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveKill();
    };
    killer.once('error', () => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      finish();
    });
    killer.once('close', finish);
  });
}

export async function runSourceUpdateCommand(
  command: SourceUpdateCommand,
): Promise<SourceUpdateCommandResult> {
  return new Promise(resolveResult => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    let treeTerminated = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    const child = spawn(command.file, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.stdout?.on('data', chunk => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendTail(stderr, chunk); });
    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error?: NodeJS.ErrnoException,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (groupPollTimer) clearInterval(groupPollTimer);
      resolveResult({ code, signal, stdout, stderr, timedOut, error });
    };
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => {
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      if (!timedOut || treeTerminated) finish(code, signal);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (!pid) return finish(null, null);
      if (process.platform === 'win32') {
        void killWindowsProcessTree(pid).then(() => {
          treeTerminated = true;
          if (childClosed) finish(closeCode, closeSignal);
        });
        return;
      }
      signalProcessGroup(pid, 'SIGTERM');
      const observeGroupExit = () => {
        if (processGroupAlive(pid)) return;
        treeTerminated = true;
        if (groupPollTimer) clearInterval(groupPollTimer);
        if (childClosed) finish(closeCode, closeSignal);
      };
      groupPollTimer = setInterval(observeGroupExit, 25);
      groupPollTimer.unref();
      forceKillTimer = setTimeout(() => signalProcessGroup(pid, 'SIGKILL'), 250);
      forceKillTimer.unref();
      observeGroupExit();
    }, command.timeoutMs);
    timeout.unref();
  });
}

function normalizedRoot(root: string): string | null {
  if (typeof root !== 'string' || root.trim().length === 0) return null;
  return isAbsolute(root) ? resolve(root) : resolve(process.cwd(), root);
}

function emptyInspection(root: string, blockedReason: SourceUpdateBlockedReason): SourceUpdateInspection {
  return {
    supported: false,
    root,
    branch: null,
    upstream: null,
    head: null,
    clean: false,
    needsStash: false,
    pullTarget: null,
    blockedReason,
  };
}

function gitCommand(
  deps: ResolvedDependencies,
  root: string,
  args: readonly string[],
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
): SourceUpdateCommand {
  return {
    file: deps.platform === 'win32' ? 'git.exe' : 'git',
    args,
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs,
    shell: false,
  };
}

function pnpmCommand(
  deps: ResolvedDependencies,
  root: string,
  args: readonly string[],
  timeoutMs: number,
): SourceUpdateCommand {
  if (deps.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
      cwd: root,
      env: { ...process.env },
      timeoutMs,
      shell: false,
    };
  }
  return { file: 'pnpm', args, cwd: root, env: { ...process.env }, timeoutMs, shell: false };
}

async function execute(
  deps: ResolvedDependencies,
  command: SourceUpdateCommand,
): Promise<SourceUpdateCommandResult> {
  try {
    return await deps.runCommand(command);
  } catch (error) {
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error as NodeJS.ErrnoException : new Error(String(error)),
    };
  }
}

function succeeded(result: SourceUpdateCommandResult): boolean {
  return result.code === 0 && !result.error && !result.timedOut;
}

function commandFailure(command: SourceUpdateCommand, result: SourceUpdateCommandResult): string {
  const output = boundedTail(result.stderr || result.stdout, DETAIL_LIMIT);
  const reason = result.timedOut
    ? `timed out after ${command.timeoutMs}ms`
    : result.error
      ? result.error.message
      : result.signal
        ? `terminated by ${result.signal}`
        : `exited with code ${result.code ?? 'unknown'}`;
  return boundedTail(
    `${[command.file, ...command.args].join(' ')} ${reason}${output ? `\n${output}` : ''}`,
    DETAIL_LIMIT,
  );
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function inspectWithDependencies(
  rootInput: string,
  deps: ResolvedDependencies,
): Promise<SourceUpdateInspection> {
  const root = normalizedRoot(rootInput);
  if (!root) return emptyInspection(rootInput, 'not_source_checkout');
  try {
    const rootStat = await deps.fs.stat(root);
    if (!rootStat.isDirectory()) return emptyInspection(root, 'not_source_checkout');
  } catch {
    return emptyInspection(root, 'not_source_checkout');
  }
  const version = await execute(deps, gitCommand(deps, root, ['--version']));
  if (version.error?.code === 'ENOENT') return emptyInspection(root, 'git_unavailable');
  if (!succeeded(version)) return emptyInspection(root, 'preflight_failed');
  const topLevel = await execute(deps, gitCommand(deps, root, ['rev-parse', '--show-toplevel']));
  if (topLevel.error?.code === 'ENOENT') return emptyInspection(root, 'git_unavailable');
  if (topLevel.error || topLevel.timedOut) return emptyInspection(root, 'preflight_failed');
  if (!succeeded(topLevel)) return emptyInspection(root, 'not_source_checkout');
  try {
    const [realRoot, realTopLevel] = await Promise.all([
      deps.fs.realpath(root),
      deps.fs.realpath(topLevel.stdout.trim()),
    ]);
    if (!samePath(realRoot, realTopLevel, deps.platform)) {
      return emptyInspection(root, 'not_source_checkout');
    }
  } catch {
    return emptyInspection(root, 'not_source_checkout');
  }
  const headResult = await execute(deps, gitCommand(deps, root, ['rev-parse', 'HEAD']));
  if (!succeeded(headResult) || !headResult.stdout.trim()) {
    return emptyInspection(root, 'preflight_failed');
  }
  const head = headResult.stdout.trim();
  const statusResult = await execute(
    deps,
    gitCommand(deps, root, ['status', '--porcelain=v1', '--untracked-files=normal']),
  );
  if (!succeeded(statusResult)) return { ...emptyInspection(root, 'preflight_failed'), head };
  const clean = statusResult.stdout.trim().length === 0;
  const branchResult = await execute(
    deps,
    gitCommand(deps, root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  );
  if (branchResult.error || branchResult.timedOut) {
    return { ...emptyInspection(root, 'preflight_failed'), head, clean };
  }
  const branch = succeeded(branchResult) && branchResult.stdout.trim()
    ? branchResult.stdout.trim()
    : null;
  if (!branch && branchResult.code !== 1) {
    return { ...emptyInspection(root, 'preflight_failed'), head, clean };
  }
  let upstream: string | null = null;
  let pullTarget: string | null = null;
  let diverged = false;
  if (branch) {
    const upstreamResult = await execute(
      deps,
      gitCommand(deps, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    );
    if (upstreamResult.error || upstreamResult.timedOut) {
      return { ...emptyInspection(root, 'preflight_failed'), branch, head, clean };
    }
    if (succeeded(upstreamResult) && upstreamResult.stdout.trim()) {
      upstream = upstreamResult.stdout.trim();
    } else if (upstreamResult.code !== 128) {
      return { ...emptyInspection(root, 'preflight_failed'), branch, head, clean };
    }
    if (upstream) {
      const divergenceResult = await execute(
        deps,
        gitCommand(deps, root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]),
      );
      if (!succeeded(divergenceResult)) {
        return { ...emptyInspection(root, 'preflight_failed'), branch, upstream, head, clean };
      }
      const [aheadRaw, behindRaw] = divergenceResult.stdout.trim().split(/\s+/);
      const ahead = Number(aheadRaw);
      const behind = Number(behindRaw);
      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
        return { ...emptyInspection(root, 'preflight_failed'), branch, upstream, head, clean };
      }
      diverged = ahead > 0 && behind > 0;
    } else {
      // No configured upstream: fall back to origin/<branch> when that remote-tracking ref exists,
      // so a freshly created/checked-out branch can still be fast-forwarded from origin.
      const originRef = `origin/${branch}`;
      const originResult = await execute(
        deps,
        gitCommand(deps, root, ['rev-parse', '--verify', '--quiet', `${originRef}^{commit}`]),
      );
      if (originResult.error || originResult.timedOut) {
        return { ...emptyInspection(root, 'preflight_failed'), branch, head, clean };
      }
      if (succeeded(originResult) && originResult.stdout.trim()) {
        pullTarget = originRef;
      } else if (originResult.code !== 1) {
        // `--verify --quiet` exits 1 when the ref is simply absent; any other code is unexpected.
        return { ...emptyInspection(root, 'preflight_failed'), branch, head, clean };
      }
    }
  }
  const needsStash = !clean;
  const blockedReason: SourceUpdateBlockedReason | null = !branch
    ? 'detached_head'
    : !upstream && !pullTarget
      ? 'no_upstream'
      : diverged
        ? 'diverged'
        : null;
  return {
    supported: blockedReason === null,
    root,
    branch,
    upstream,
    head,
    clean,
    needsStash,
    pullTarget,
    blockedReason,
  };
}

export async function inspectSourceUpdate(
  root: string,
  options: SourceUpdateOptions = {},
): Promise<SourceUpdateInspection> {
  return inspectWithDependencies(root, dependencies(options));
}

async function runRequiredCommand(
  stage: SourceUpdateStage,
  deps: ResolvedDependencies,
  command: SourceUpdateCommand,
): Promise<void> {
  const result = await execute(deps, command);
  if (!succeeded(result)) throw new SourceUpdateError(stage, commandFailure(command, result));
}

async function pathExists(fs: SourceUpdateFs, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function restoreDist(
  deps: ResolvedDependencies,
  distPath: string,
  backupPath: string,
  hadDist: boolean,
): Promise<string | null> {
  try {
    await deps.fs.rm(distPath, { recursive: true, force: true });
    if (hadDist) await deps.fs.rename(backupPath, distPath);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function withDistRollback<T>(
  deps: ResolvedDependencies,
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const distPath = join(root, 'dist');
  const backupPath = join(root, `.botmux-dist-backup-${process.pid}-${deps.now()}`);
  const hadDist = await pathExists(deps.fs, distPath);
  try {
    if (hadDist) await deps.fs.rename(distPath, backupPath);
  } catch (error) {
    throw new SourceUpdateError(
      'build',
      `Failed to back up the existing dist: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    const result = await operation();
    if (hadDist) await deps.fs.rm(backupPath, { recursive: true, force: true });
    return result;
  } catch (error) {
    const sourceError = error instanceof SourceUpdateError
      ? error
      : new SourceUpdateError('build', error instanceof Error ? error.message : String(error));
    const restoreError = await restoreDist(deps, distPath, backupPath, hadDist);
    if (!restoreError) throw sourceError;
    throw new SourceUpdateError(
      sourceError.stage,
      `${sourceError.detail}\nFailed to restore the previous dist: ${restoreError}`,
    );
  }
}

async function verifyBuiltCli(deps: ResolvedDependencies, root: string): Promise<void> {
  const cliPath = join(root, 'dist', 'cli.js');
  try {
    const cliStat = await deps.fs.stat(cliPath);
    if (!cliStat.isFile() || cliStat.size === 0) throw new Error('dist/cli.js is missing or empty');
  } catch (error) {
    throw new SourceUpdateError(
      'verify',
      `Built CLI verification failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function runSourceUpdate(
  root: string,
  options: SourceUpdateOptions = {},
): Promise<SourceUpdateResult> {
  const deps = dependencies(options);
  const inspection = await inspectWithDependencies(root, deps);
  if (!inspection.supported || !inspection.head || !inspection.branch) {
    throw new SourceUpdateError(
      'preflight',
      `Source update is blocked: ${inspection.blockedReason ?? 'preflight_failed'}`,
    );
  }
  const updateRoot = inspection.root;
  // Pull command: use the configured upstream when present (plain `git pull --ff-only`),
  // otherwise fall back to the resolved origin/<branch> target.
  const pullArgs: readonly string[] = inspection.pullTarget
    ? ['pull', '--ff-only', 'origin', inspection.branch]
    : ['pull', '--ff-only'];

  // Stash local changes before touching the tree, and always attempt to restore them afterward.
  const stashRef = inspection.needsStash
    ? `botmux-source-update-${process.pid}-${deps.now()}`
    : null;
  if (stashRef) {
    await runRequiredCommand(
      'pull',
      deps,
      gitCommand(deps, updateRoot, ['stash', 'push', '-u', '-m', stashRef], STASH_TIMEOUT_MS),
    );
  }

  let stashConflict: SourceUpdateResult['stashConflict'];
  let newHead: string;
  try {
    await runRequiredCommand(
      'pull',
      deps,
      gitCommand(deps, updateRoot, pullArgs, PULL_TIMEOUT_MS),
    );
    await runRequiredCommand(
      'install',
      deps,
      pnpmCommand(deps, updateRoot, ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS),
    );
    newHead = await withDistRollback(deps, updateRoot, async () => {
      await runRequiredCommand(
        'build',
        deps,
        pnpmCommand(deps, updateRoot, ['build'], BUILD_TIMEOUT_MS),
      );
      await verifyBuiltCli(deps, updateRoot);
      const headCommand = gitCommand(deps, updateRoot, ['rev-parse', 'HEAD']);
      const headResult = await execute(deps, headCommand);
      if (!succeeded(headResult) || !headResult.stdout.trim()) {
        throw new SourceUpdateError('verify', commandFailure(headCommand, headResult));
      }
      return headResult.stdout.trim();
    });
  } catch (error) {
    // The update failed (dist already rolled back by withDistRollback). Restore the user's
    // stashed changes before surfacing the failure so we never leave their work stranded.
    if (stashRef) {
      const popResult = await execute(
        deps,
        gitCommand(deps, updateRoot, ['stash', 'pop'], STASH_TIMEOUT_MS),
      );
      if (!succeeded(popResult) && error instanceof SourceUpdateError) {
        throw new SourceUpdateError(
          error.stage,
          `${error.detail}\nLocal changes could not be restored from the stash (${stashRef}); ` +
            `resolve it manually with \`git stash list\` / \`git stash pop\`.`,
        );
      }
    }
    throw error;
  }

  // Update succeeded; restore the stashed changes. A pop conflict must not undo the completed
  // upgrade — report it so the user can resolve the still-present stash by hand.
  if (stashRef) {
    const popResult = await execute(
      deps,
      gitCommand(deps, updateRoot, ['stash', 'pop'], STASH_TIMEOUT_MS),
    );
    if (!succeeded(popResult)) {
      stashConflict = {
        ref: stashRef,
        detail: boundedTail(
          commandFailure(gitCommand(deps, updateRoot, ['stash', 'pop']), popResult),
          DETAIL_LIMIT,
        ),
      };
    }
  }

  return {
    oldHead: inspection.head,
    newHead,
    changed: inspection.head !== newHead,
    branch: inspection.branch,
    upstream: inspection.upstream ?? inspection.pullTarget ?? inspection.branch,
    ...(stashConflict ? { stashConflict } : {}),
  };
}
