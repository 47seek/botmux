/**
 * v3 runtime ⇄ ephemeral-pool IPC contract.
 *
 * This is the SHARED boundary between the two halves of the v3 engine:
 *   - scheduling / persistence side (claude): `runtime.ts` calls `runNode`,
 *     consumes the returned manifest, writes the next node's `inputs.json`.
 *   - execution / IPC side (codex): `ephemeral-pool.ts` implements `runNode`
 *     (spawns a throwaway worker in goal-mode), `manifest.ts` implements the
 *     `Manifest` validator.
 *
 * Both sides import the *types* from here so the contract can't silently drift.
 * Implementations live in their owners' files; this module is types + frozen
 * string constants only (no runtime logic).  See
 * `docs/design/2026-06-01-v3-mvp-engine-split.md` §2 for prose.
 */

import type { CliId } from '../../adapters/cli/types.js';
import type { V3GoalNode } from './dag.js';

// ─── Manifest (node product declaration) ───────────────────────────────────

/** Enumerated, NOT free-string (design Q8 / §7).  Unknown → validator rejects
 *  (or the producer downgrades to `binary`). */
export type ManifestFileKind =
  | 'markdown'
  | 'json'
  | 'text'
  | 'code'
  | 'log'
  | 'binary'
  | 'directory';

export const MANIFEST_FILE_KINDS: readonly ManifestFileKind[] = [
  'markdown', 'json', 'text', 'code', 'log', 'binary', 'directory',
];

/** Soft limits the manifest validator enforces (codex point 2). */
export const MANIFEST_SUMMARY_MAX_BYTES = 4 * 1024;
export const MANIFEST_PREVIEW_MAX_BYTES = 4 * 1024;

export interface ManifestFile {
  name: string;
  /** Relative to the node's `outputDir` — absolute paths are REJECTED by the
   *  validator (which canonicalizes `outputDir/path` and asserts it stays
   *  inside outputDir).  Downstream `inputs.json` carries the resolved
   *  absolute path; the manifest author may only write relative. */
  path: string;
  kind: ManifestFileKind;
  bytes: number;
  /** sha256 of the file; the empty string is the agreed sentinel for
   *  `kind: 'directory'`. */
  sha256: string;
  mime: string;
  /** Optional human-readable excerpt; validator truncates to
   *  MANIFEST_PREVIEW_MAX_BYTES. */
  preview?: string;
}

export type ManifestStatus = 'ok' | 'fail';

export const MANIFEST_STATUSES: readonly ManifestStatus[] = ['ok', 'fail'];

/**
 * Written by a goal-mode worker at `BOTMUX_GOAL_MANIFEST_PATH` before exit.
 * Invariants (enforced by the validator on codex's side):
 *   - `status:'ok'`  → `files.length >= 1`, `error` absent
 *   - `status:'fail'` → `error` required, `files` may be empty
 */
export interface Manifest {
  schemaVersion: 1;
  status: ManifestStatus;
  /** Truncated to MANIFEST_SUMMARY_MAX_BYTES. */
  summary: string;
  error?: { code: string; message: string; retryable?: boolean };
  files: ManifestFile[];
}

export const MANIFEST_SCHEMA_VERSION = 1 as const;

// ─── Downstream inputs (runtime writes, goal-mode reads) ────────────────────

/**
 * Written by the runtime at `BOTMUX_GOAL_INPUTS_PATH` for each node, resolved
 * from the manifests of the node's upstream `inputs.from`.  Unlike the
 * manifest, the `path` here is ABSOLUTE so the consuming agent can `Read` it
 * directly without knowing the upstream layout.
 */
export interface GoalInputs {
  inputs: Array<{
    from: string;          // upstream nodeId
    name: string;          // logical file name (from upstream manifest)
    path: string;          // ABSOLUTE path, ready to Read
    kind: ManifestFileKind;
    preview?: string;
  }>;
}

// ─── goal-mode env contract (runtime fills, skill reads) ────────────────────

/**
 * The fixed env keys the runtime injects into every goal-mode worker.  The
 * `botmux-goal` skill / bootstrap prompt reads these by name — keeping the
 * names here (not magic strings scattered across files) is the contract.
 */
export const GOAL_ENV = {
  /** Path to the single-sentence goal text file. */
  GOAL_PATH: 'BOTMUX_GOAL_PATH',
  /** Path to this node's resolved `GoalInputs` JSON. */
  INPUTS_PATH: 'BOTMUX_GOAL_INPUTS_PATH',
  /** Directory the worker may write products into (and ONLY here). */
  OUTPUT_DIR: 'BOTMUX_GOAL_OUTPUT_DIR',
  /** Path the worker MUST write its `Manifest` to before exiting. */
  MANIFEST_PATH: 'BOTMUX_GOAL_MANIFEST_PATH',
  /** This attempt's directory (logs, manifest, work/ live under it). */
  ATTEMPT_DIR: 'BOTMUX_GOAL_ATTEMPT_DIR',
  /** Set to '1' — marks a goal-mode run so worker chat/card/ask side effects
   *  stay silent (codex point 4). */
  V3_MARKER: 'BOTMUX_V3_GOAL',
} as const;

// ─── Supported CLIs ─────────────────────────────────────────────────────────

/**
 * v3 goal-mode is delivered via the native `/goal` command, which only Claude
 * Code, Codex, and Seed support (老滕 directive 2026-06-01, Seed added
 * 2026-06-02).  We deliberately do NOT abstract goal delivery across every CLI
 * — instead the feature is scoped to the CLIs whose command mechanism can host
 * `/goal`.  Seed is ByteDance's Claude Code fork (`@bytedance-seed/claude-code`,
 * binary `seed`): identical flags, slash commands, and session layout — it
 * reuses the entire claude-family adapter, so `/goal`, paste-detection
 * avoidance, and the manifest watcher all behave exactly as on claude-code with
 * zero CLI-specific branching.  The runtime rejects a run whose nodes resolve
 * to any other CLI at start time.
 */
export const V3_SUPPORTED_CLIS: readonly CliId[] = ['claude-code', 'codex', 'seed'];

export function isV3SupportedCli(cliId: CliId): boolean {
  return V3_SUPPORTED_CLIS.includes(cliId);
}

// ─── BotSnapshot (frozen at run start) ──────────────────────────────────────

/**
 * The spawn-relevant bot config, FROZEN when the run starts and persisted in
 * the runDir.  The pool spawns ephemeral workers from this snapshot rather
 * than re-reading `bots.json` at execution time, so a retry / daemon-restart
 * reproduces the original cliId / model / workingDir even if the live bot
 * config drifted (codex point 1).
 *
 * Deliberately omits `larkAppSecret`: secrets are not written into the runDir.
 * The pool re-reads the secret by `larkAppId` from the live registry at spawn
 * (secret rotation is not the drift we're guarding against).  If we later need
 * fully-hermetic replay we can revisit, but not at the cost of secrets on disk.
 */
export interface BotSnapshot {
  larkAppId: string;
  cliId: CliId;
  cliPathOverride?: string;
  model?: string;
  /** The resolved working directory for this run. */
  workingDir: string;
}

// ─── runNode (the single call across the boundary) ──────────────────────────

/** Returned alongside the result so dashboard terminal / replay / resume can
 *  attach later without a contract change (codex point 1).  All optional —
 *  MVP may leave it undefined. */
export interface WorkerSessionInfo {
  sessionId: string;
  webPort?: number;
  token?: string;
}

export interface RunNodeRequest {
  runId: string;
  /** Stable id e.g. `research/attempts/001`, used for sessionId / log naming. */
  attemptId: string;
  node: V3GoalNode;
  /** Frozen at run start; do NOT re-resolve the bot here. */
  botSnapshot: BotSnapshot;
  runDir: string;
  attemptDir: string;
  inputsPath: string;
  outputDir: string;
  /** Already includes the GOAL_ENV keys; pool merges into the worker env. */
  env: Record<string, string>;
  timeoutMs: number;
  cancelSignal?: AbortSignal;
  /** Called as soon as the worker web terminal is ready, before the node
   *  reaches terminal.  Runtime uses this to append `nodeSessionReady` so the
   *  dashboard can attach to an in-flight node instead of waiting for
   *  RunNodeResult at completion. */
  onSessionReady?: (info: WorkerSessionInfo & { ptyLogPath?: string }) => void | Promise<void>;
  /** Defaults to `${attemptDir}/stdout.log` when omitted. */
  stdoutPath?: string;
  /** Defaults to `${attemptDir}/stderr.log` when omitted. */
  stderrPath?: string;
}

export interface RunNodeResult {
  /** Process-level outcome.  Final node verdict = this AND manifest validation
   *  (runtime validates the manifest at `manifestPath` after `runNode`
   *  resolves — codex point 4: NOT v0.2 final_output semantics). */
  status: 'ok' | 'fail';
  /** Where the worker wrote its manifest (defaults to attemptDir/manifest.json
   *  but returned explicitly so the layout stays the pool's choice within
   *  attemptDir). */
  manifestPath: string;
  sessionInfo?: WorkerSessionInfo;
}

/**
 * Implemented by `ephemeral-pool.ts` (codex), called by `runtime.ts` (claude).
 * Spawns one throwaway worker that runs the node's goal in goal-mode, waits
 * for it to exit (or the timeout / cancel to fire), and resolves with the
 * process outcome + manifest location.  The pool does NOT interpret the
 * manifest — the runtime validates it.
 */
export type RunNode = (req: RunNodeRequest) => Promise<RunNodeResult>;

// ─── Manifest validation (codex implements, runtime calls) ──────────────────

export interface ManifestValidationResult {
  ok: boolean;
  /** Present when `ok` — the parsed, normalized manifest. */
  manifest?: Manifest;
  /** Present when `!ok` — the full problem list (mirror dag.ts's style). */
  problems?: string[];
}

/**
 * The runtime's view of manifest validation: read + validate the manifest at
 * `manifestPath` against `outputDir`, returning a result object (never throws,
 * so the dispatch loop stays branch-clean).
 *
 * codex's `manifest.ts` exposes the validation in a throw-based async form
 * (`readAndValidateManifest(path, outputDir): Promise<Manifest>`); the daemon /
 * CLI wiring adapts it to this shape at the injection boundary
 * (try → `{ok:true, manifest}` / catch `ManifestValidationError` →
 * `{ok:false, problems}`).  Async because the underlying impl reads the file
 * and hashes its contents.
 */
export type ValidateManifest = (
  manifestPath: string,
  outputDir: string,
) => Promise<ManifestValidationResult>;

// ─── Spec (grill 产物 → architect 输入) ──────────────────────────────────────

export const SPEC_SCHEMA_VERSION = 1;

/**
 * One prospective node in the requirement-decomposition sketch.  grill writes
 * these (the WHAT); architect turns them into formal dag.json nodes (the HOW).
 *
 * `input_needs` is FREE TEXT ("需要 research 阶段产出的竞品事实"), NOT a list of
 * upstream sketchIds — grill must not draw edges; architect parses `input_needs`
 * into the dag's `depends`. (codex review 2026-06-02.)  `risk_gate` → dag.json
 * humanGate on the corresponding node.
 */
export interface SpecNodeSketch {
  sketchId: string;
  goal: string;
  input_needs: string[];
  expected_outputs: string[];
  acceptance: string;
  risk_gate: boolean;
  unknowns: string[];
}

/**
 * The canonical, machine-readable spec.  `workflow spec-finalize` parses the
 * fenced ```json block out of spec.md, validates it, and materializes this as
 * `spec.json` (parse/validate failure blocks handoff — codex review 2026-06-02).
 * architect reads `spec.json` for STRUCTURE; `spec.md` is narrative context only.
 *
 * Node sketch ships as fenced JSON (not YAML) — dependency-free, mirrors v0.2's
 * JSON workflow definitions, and an LLM emits valid JSON reliably.
 */
export interface Spec {
  schemaVersion: number;
  runId: string;
  title: string;
  /** grill 收敛后的清晰需求陈述. */
  requirement: string;
  /** 整体验收标准（人读叙事在 spec.md，这里给 architect 的结构化副本）. */
  acceptance?: string;
  /** 明确不做的. */
  nonGoals?: string[];
  nodes: SpecNodeSketch[];
}

// ─── Architect seam ─────────────────────────────────────────────────────────
// `runArchitect(...)` + its `RunArchitectInput`/`RunArchitectResult` live in
// `architect.ts` (codex owns the architect goal-worker).  The host controller
// imports them from there directly — they are NOT redefined here (one-directional
// host→architect call, not a bidirectional injection contract like RunNode).
// The host still runs loadDag/validateDag on the returned dagPath; it does NOT
// trust architect's self-claim of validity. (seam agreed w/ codex 2026-06-02.)
