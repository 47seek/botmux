/**
 * v3 grill host controller.
 *
 * The thin orchestration layer that drives a run through the grill → architect
 * → human-approval pipeline.  It is NOT the v3 runtime and NOT the ephemeral
 * pool — it is the `botmux workflow <sub>` command surface the grill skill
 * shells out to, plus the grill.state.json status machine (grill-state.ts).
 *
 *   workflow new "<goal>"        → birth run (runId/runDir), status=grilling
 *   workflow spec-finalize <id>  → parse+validate spec.md → spec.json → spec_ready
 *   workflow approve-spec <id>   → gate-1: spec_ready → spec_approved
 *   workflow architect <id>      → spec_approved → architect_running → (runArchitect
 *                                  + host validateDag) → dag_ready | retreat
 *   workflow approve-dag <id>    → gate-2: dag_ready → dag_approved → kick `v3 run`
 *
 * The CORE operations below take injected deps so they unit-test without a real
 * worker; the CLI wrapper resolves real bot/secret + codex's `runArchitect` +
 * dag.ts's `loadDag`.  grill state is a conversation worktable — it does NOT
 * write the runtime journal (codex 2026-06-02).
 */
import { join } from 'node:path';
import {
  birthRun,
  readGrillState,
  transition,
  defaultBaseDir,
  type BirthResult,
  type GrillState,
} from './grill-state.js';
import { finalizeSpec, SpecValidationError } from './spec.js';
import { runArchitect as realRunArchitect, type RunArchitectInput, type RunArchitectResult } from './architect.js';
import { loadDag } from './dag.js';
import type { BotSnapshot } from './contract.js';

// ─── Core operations (dep-injected, pure of CLI / process concerns) ─────────

export function hostNew(opts: { goal: string; baseDir?: string; runId?: string; now?: Date }): BirthResult {
  return birthRun(opts);
}

export interface SpecFinalizeOutcome {
  ok: boolean;
  state?: GrillState;
  /** Present on failure — the parse/validate problems that BLOCK handoff. */
  problems?: string[];
}

/** Parse + validate spec.md → write spec.json → status=spec_ready.  On a
 *  SpecValidationError, returns {ok:false, problems} and leaves status untouched
 *  (grill stays grilling and relays the problems to the user). */
export function hostSpecFinalize(runDir: string, now: Date = new Date()): SpecFinalizeOutcome {
  const cur = readGrillState(runDir);
  if (!cur) throw new Error(`grill.state.json 不存在于 ${runDir}`);
  try {
    finalizeSpec(cur.specPath, cur.specJsonPath, cur.runId);
  } catch (err) {
    if (err instanceof SpecValidationError) return { ok: false, problems: err.problems };
    throw err;
  }
  const state = transition(runDir, 'spec_ready', { problems: undefined }, now);
  return { ok: true, state };
}

/** gate-1: spec_ready → spec_approved.  Rejects unless status is spec_ready. */
export function hostApproveSpec(runDir: string, now: Date = new Date()): GrillState {
  const cur = mustRead(runDir);
  if (cur.status !== 'spec_ready') {
    throw new HostGuardError(`approve-spec 需要 status=spec_ready，当前 ${cur.status}`);
  }
  return transition(runDir, 'spec_approved', {}, now);
}

export interface ArchitectDeps {
  runArchitect: (input: RunArchitectInput) => Promise<RunArchitectResult>;
  /** Throws on an invalid dag (dag.ts loadDag). */
  loadDag: (path: string) => unknown;
  botSnapshot: BotSnapshot;
  resolveLarkAppSecret: (larkAppId: string) => string | undefined | Promise<string | undefined>;
  timeoutMs?: number;
  cancelSignal?: AbortSignal;
}

export interface ArchitectOutcome {
  ok: boolean;
  state: GrillState;
  problems?: string[];
}

/**
 * spec_approved → architect_running → runArchitect → host loadDag/validateDag.
 * Encodes codex's three assertions:
 *  1. rejects unless status=spec_approved (don't skip gate-1);
 *  2. runArchitect-fail OR validateDag-fail → retreat to spec_approved with the
 *     problems recorded in grill.state.json (so grill can fix the spec) — NOT
 *     dag_ready;
 *  3. on success → dag_ready records dagPath/notesPath/architectManifestPath so
 *     approve-dag and the dashboard never re-guess paths.
 */
export async function hostArchitect(runDir: string, deps: ArchitectDeps, now: Date = new Date()): Promise<ArchitectOutcome> {
  const cur = mustRead(runDir);
  if (cur.status !== 'spec_approved') {
    throw new HostGuardError(`architect 需要 status=spec_approved（先 approve-spec），当前 ${cur.status}`);
  }
  transition(runDir, 'architect_running', { problems: undefined }, now);

  let res: RunArchitectResult;
  try {
    res = await deps.runArchitect({
      runId: cur.runId,
      runDir,
      specPath: cur.specPath,
      specJsonPath: cur.specJsonPath,
      botSnapshot: deps.botSnapshot,
      resolveLarkAppSecret: deps.resolveLarkAppSecret,
      timeoutMs: deps.timeoutMs,
      cancelSignal: deps.cancelSignal,
    });
  } catch (err) {
    const problems = [err instanceof Error ? err.message : String(err)];
    const state = transition(runDir, 'spec_approved', { problems }, now);
    return { ok: false, state, problems };
  }

  if (res.status !== 'ok' || !res.dagPath || !res.notesPath) {
    const problems = res.problems ?? [
      !res.dagPath ? 'architect 未产出 dag.json' : undefined,
      !res.notesPath ? 'architect 未产出 architect-notes.md' : undefined,
    ].filter((p): p is string => Boolean(p));
    const state = transition(runDir, 'spec_approved', { problems }, now);
    return { ok: false, state, problems };
  }

  // Assertion 2: do NOT trust architect's self-claim — host validates the dag.
  try {
    deps.loadDag(res.dagPath);
  } catch (err) {
    const problems = (err as { problems?: string[] }).problems ?? [err instanceof Error ? err.message : String(err)];
    const state = transition(runDir, 'spec_approved', { problems }, now);
    return { ok: false, state, problems };
  }

  const state = transition(
    runDir,
    'dag_ready',
    {
      dagPath: res.dagPath,
      notesPath: res.notesPath,
      architectManifestPath: res.manifestPath,
      problems: undefined,
    },
    now,
  );
  return { ok: true, state };
}

/** gate-2: dag_ready → dag_approved.  Returns the recorded dagPath for the
 *  runner.  Rejects unless status is dag_ready. */
export function hostApproveDag(runDir: string, now: Date = new Date()): { state: GrillState; dagPath: string } {
  const cur = mustRead(runDir);
  if (cur.status !== 'dag_ready') {
    throw new HostGuardError(`approve-dag 需要 status=dag_ready，当前 ${cur.status}`);
  }
  if (!cur.dagPath) throw new Error('dag_ready 状态缺 dagPath（内部不一致）');
  const state = transition(runDir, 'dag_approved', {}, now);
  return { state, dagPath: cur.dagPath };
}

export class HostGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostGuardError';
  }
}

function mustRead(runDir: string): GrillState {
  const s = readGrillState(runDir);
  if (!s) throw new Error(`grill.state.json 不存在于 ${runDir}`);
  return s;
}

// ─── CLI dispatch (resolves real deps) ──────────────────────────────────────

function runDirFor(runId: string, baseDir: string): string {
  return join(baseDir, runId);
}

/**
 * `botmux workflow <sub>` host-controller subcommands.  Dispatched from
 * `cmdWorkflow` for the v3-specific verbs (new/spec-finalize/approve-spec/
 * architect/approve-dag); v0.2 verbs (run/create/validate/…) stay in workflow.ts.
 */
export async function cmdWorkflowHost(sub: string, rest: string[]): Promise<void> {
  const baseDir = argValue(rest, '--base-dir') ?? defaultBaseDir();

  switch (sub) {
    case 'new': {
      const goal = firstPositional(rest);
      if (!goal) throw new Error('用法: botmux workflow new "<目标>" [--base-dir <dir>]');
      const { runId, runDir, state } = hostNew({ goal, baseDir });
      console.log(JSON.stringify({ runId, runDir, status: state.status, specPath: state.specPath }, null, 2));
      return;
    }
    case 'spec-finalize': {
      const runId = requireRunId(rest);
      const out = hostSpecFinalize(runDirFor(runId, baseDir));
      if (!out.ok) {
        console.error(`spec 校验失败（先修 spec.md 再 finalize）:\n  - ${out.problems!.join('\n  - ')}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ runId, status: out.state!.status, specJsonPath: out.state!.specJsonPath }, null, 2));
      return;
    }
    case 'approve-spec': {
      const runId = requireRunId(rest);
      const state = hostApproveSpec(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status }, null, 2));
      return;
    }
    case 'architect': {
      const runId = requireRunId(rest);
      const out = await runArchitectCli(runId, baseDir, rest);
      if (!out.ok) {
        console.error(`architect/validateDag 失败（已退回 spec_approved，可修 spec 重跑）:\n  - ${out.problems!.join('\n  - ')}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ runId, status: out.state.status, dagPath: out.state.dagPath, notesPath: out.state.notesPath }, null, 2));
      return;
    }
    case 'approve-dag': {
      const runId = requireRunId(rest);
      const { state, dagPath } = hostApproveDag(runDirFor(runId, baseDir));
      console.log(JSON.stringify({ runId, status: state.status, dagPath }, null, 2));
      console.log(`\n✅ DAG 已批准。开跑：botmux v3 run ${dagPath}`);
      return;
    }
    default:
      throw new Error(`未知 workflow 子命令: ${sub}`);
  }
}

/** True when `sub` is a v3 host-controller verb (so cmdWorkflow routes here). */
export function isHostSub(sub: string): boolean {
  return ['new', 'spec-finalize', 'approve-spec', 'architect', 'approve-dag'].includes(sub);
}

/** Resolve real bot/secret deps and run the architect step. */
async function runArchitectCli(runId: string, baseDir: string, rest: string[]): Promise<ArchitectOutcome> {
  const { loadBotConfigs } = await import('../../bot-registry.js');
  const bots = loadBotConfigs();
  if (bots.length === 0) throw new Error('没有可用 bot 配置（bots.json 为空）');
  const selector = argValue(rest, '--bot');
  const bot = selector
    ? bots.find((b) => b.larkAppId === selector || b.name === selector)
    : bots[0];
  if (!bot) throw new Error(`找不到 bot "${selector}"`);

  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  // Mirror cli-run.ts's BotConfig → BotSnapshot mapping exactly.
  const workingDir = argValue(rest, '--working-dir')
    ?? bot.defaultWorkingDir ?? bot.workingDir ?? bot.workingDirs?.[0] ?? '~';
  const botSnapshot: BotSnapshot = {
    larkAppId: bot.larkAppId,
    cliId: bot.cliId,
    ...(bot.cliPathOverride ? { cliPathOverride: bot.cliPathOverride } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    workingDir,
  };

  return hostArchitect(runDirFor(runId, baseDir), {
    runArchitect: realRunArchitect,
    loadDag,
    botSnapshot,
    resolveLarkAppSecret: (id: string) => secretById.get(id),
  });
}

// ─── Local arg parsers ──────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i++; continue; }
    return args[i];
  }
  return undefined;
}

function requireRunId(rest: string[]): string {
  const runId = firstPositional(rest);
  if (!runId) throw new Error('用法: botmux workflow <sub> <runId> [--base-dir <dir>]');
  return runId;
}
