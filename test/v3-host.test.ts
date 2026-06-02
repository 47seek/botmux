import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hostNew,
  hostSpecFinalize,
  hostApproveSpec,
  hostArchitect,
  hostApproveDag,
  HostGuardError,
  type ArchitectDeps,
} from '../src/workflows/v3/host.js';
import { readGrillState } from '../src/workflows/v3/grill-state.js';
import { SPEC_SCHEMA_VERSION, type BotSnapshot } from '../src/workflows/v3/contract.js';
import { DagValidationError } from '../src/workflows/v3/dag.js';

function base(): string {
  return mkdtempSync(join(tmpdir(), 'v3-host-'));
}

function writeValidSpecMd(specPath: string, runId: string): void {
  const spec = {
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId,
    title: 'demo',
    requirement: '调研竞品出报告',
    nodes: [
      { sketchId: 'research', goal: '调研 X/Y/Z', input_needs: [], expected_outputs: ['facts.md'], acceptance: '含定价', risk_gate: false, unknowns: [] },
    ],
  };
  writeFileSync(specPath, `# Spec\n\n## 草图\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n`, 'utf-8');
}

const DUMMY_BOT: BotSnapshot = { larkAppId: 'cli_x', cliId: 'claude-code', workingDir: '/tmp' };

/** Drive a run to spec_approved (so architect tests can start there). */
function toApprovedSpec(baseDir: string): { runDir: string; runId: string } {
  const { runDir, runId } = hostNew({ goal: 'g', baseDir, runId: 'r' });
  writeValidSpecMd(join(runDir, 'spec.md'), runId);
  hostSpecFinalize(runDir);
  hostApproveSpec(runDir);
  return { runDir, runId };
}

describe('host — new / spec-finalize / approve-spec', () => {
  it('new 建 run；spec-finalize 校验通过 → spec_ready + 写 spec.json', () => {
    const b = base();
    try {
      const { runDir, runId } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(readGrillState(runDir)!.status).toBe('grilling');
      writeValidSpecMd(join(runDir, 'spec.md'), runId);
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(true);
      expect(out.state!.status).toBe('spec_ready');
      expect(existsSync(join(runDir, 'spec.json'))).toBe(true);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('spec-finalize：spec.md 非法 → {ok:false, problems}，状态留 grilling（阻断 handoff）', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      writeFileSync(join(runDir, 'spec.md'), '# Spec\n没有 json 块', 'utf-8');
      const out = hostSpecFinalize(runDir);
      expect(out.ok).toBe(false);
      expect(out.problems!.length).toBeGreaterThan(0);
      expect(readGrillState(runDir)!.status).toBe('grilling');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('approve-spec 只能从 spec_ready', () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      expect(() => hostApproveSpec(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — architect（codex 3 断言）', () => {
  it('断言1：非 spec_approved 跑 architect → HostGuardError', async () => {
    const b = base();
    try {
      const { runDir } = hostNew({ goal: 'g', baseDir: b, runId: 'r' });
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('不该被调用'); },
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await expect(hostArchitect(runDir, deps)).rejects.toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('成功：runArchitect ok + loadDag ok → dag_ready 且记录 dagPath/notesPath/manifestPath（断言3）', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          notesPath: join(input.runDir, 'architect/attempts/001/work/architect-notes.md'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => ({ runId: 'r', nodes: [] }), // 校验通过（不抛）
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(true);
      expect(out.state.status).toBe('dag_ready');
      expect(out.state.dagPath).toContain('dag.json');
      expect(out.state.notesPath).toContain('architect-notes.md');
      expect(out.state.architectManifestPath).toContain('manifest.json');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2a：runArchitect fail → 退回 spec_approved + 记 problems，不进 dag_ready', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => ({ status: 'fail', manifestPath: 'm', problems: ['architect 崩了'] }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['architect 崩了']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect throw → 退回 spec_approved + 记 problems，不卡 architect_running', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async () => { throw new Error('worker spawn failed'); },
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toEqual(['worker spawn failed']);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('runArchitect ok 但缺 notesPath → 退回 spec_approved', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'architect/attempts/001/work/dag.json'),
          manifestPath: join(input.runDir, 'architect/attempts/001/manifest.json'),
        }),
        loadDag: () => { throw new Error('不该到这'); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('architect 未产出 architect-notes.md');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('断言2b：dagPath 出来了但 host validateDag 失败 → 退回 spec_approved + 记 validation problems', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => { throw new DagValidationError(['node "x" depends on unknown node "y"']); },
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      const out = await hostArchitect(runDir, deps);
      expect(out.ok).toBe(false);
      expect(out.state.status).toBe('spec_approved');
      expect(out.state.problems).toContain('node "x" depends on unknown node "y"');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('host — approve-dag（gate-2）', () => {
  it('dag_ready → dag_approved，回 dagPath', async () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      const deps: ArchitectDeps = {
        runArchitect: async (input) => ({
          status: 'ok',
          dagPath: join(input.runDir, 'dag.json'),
          notesPath: join(input.runDir, 'notes.md'),
          manifestPath: join(input.runDir, 'manifest.json'),
        }),
        loadDag: () => ({}),
        botSnapshot: DUMMY_BOT,
        resolveLarkAppSecret: () => undefined,
      };
      await hostArchitect(runDir, deps);
      const { state, dagPath } = hostApproveDag(runDir);
      expect(state.status).toBe('dag_approved');
      expect(dagPath).toContain('dag.json');
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });

  it('非 dag_ready 时 approve-dag → HostGuardError', () => {
    const b = base();
    try {
      const { runDir } = toApprovedSpec(b);
      expect(() => hostApproveDag(runDir)).toThrow(HostGuardError);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
});
