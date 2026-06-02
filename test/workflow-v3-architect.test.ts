import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  buildArchitectGoal,
  runArchitect,
} from '../src/workflows/v3/architect.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type Manifest,
  type RunNode,
} from '../src/workflows/v3/contract.js';

const BOT: BotSnapshot = {
  larkAppId: 'cli_architect',
  cliId: 'claude-code',
  workingDir: '/tmp',
};

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function writeProduct(outputDir: string, path: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, path), content);
  return {
    name: path,
    path,
    kind: path.endsWith('.json') ? 'json' : 'markdown',
    bytes: Buffer.byteLength(content),
    sha256: hash(content),
    mime: path.endsWith('.json') ? 'application/json' : 'text/markdown',
  };
}

function writeManifest(req: Parameters<RunNode>[0], manifest: Manifest): string {
  const p = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(p, JSON.stringify(manifest));
  return p;
}

describe('buildArchitectGoal', () => {
  it('pins architect to spec inputs, dag output, and no runtime start', () => {
    const goal = buildArchitectGoal('/r/spec.md', '/r/spec.json');
    expect(goal).toContain('/r/spec.json');
    expect(goal).toContain('/r/spec.md');
    expect(goal).toContain('dag.json');
    expect(goal).toContain('architect-notes.md');
    expect(goal).toContain('Do not start or run the workflow');
    expect(goal).toContain('The host will validate dag.json');
  });
});

describe('runArchitect', () => {
  it('runs a single architect goal worker and returns dag + notes paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-architect-ok-'));
    try {
      const specPath = join(dir, 'spec.md');
      const specJsonPath = join(dir, 'spec.json');
      writeFileSync(specPath, '# Spec');
      writeFileSync(specJsonPath, JSON.stringify({ title: 'x' }));

      let seenGoal = '';
      let seenInputs = '';
      const runNode: RunNode = async (req) => {
        seenGoal = req.node.goal;
        seenInputs = req.inputsPath;
        const dag = writeProduct(req.outputDir, 'dag.json', JSON.stringify({ runId: 'x', nodes: [] }));
        const notes = writeProduct(req.outputDir, 'architect-notes.md', '# Notes');
        const manifestPath = writeManifest(req, {
          schemaVersion: 1,
          status: 'ok',
          summary: 'architect ok',
          files: [dag, notes],
        });
        return { status: 'ok', manifestPath, sessionInfo: { sessionId: 's1' } };
      };

      const res = await runArchitect({
        runId: 'r1',
        runDir: dir,
        specPath,
        specJsonPath,
        botSnapshot: BOT,
        runNode,
      });

      expect(res.status).toBe('ok');
      expect(res.dagPath).toBe(join(dir, 'architect', 'attempts', '001', 'work', 'dag.json'));
      expect(res.notesPath).toBe(join(dir, 'architect', 'attempts', '001', 'work', 'architect-notes.md'));
      expect(res.sessionInfo?.sessionId).toBe('s1');
      expect(seenGoal).toContain(specJsonPath);
      expect(seenGoal).toContain('Do not start or run the workflow');
      expect(seenInputs).toBe(join(dir, 'architect', 'attempts', '001', 'inputs.json'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when architect omits architect-notes.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-architect-miss-'));
    try {
      const specPath = join(dir, 'spec.md');
      const specJsonPath = join(dir, 'spec.json');
      writeFileSync(specPath, '# Spec');
      writeFileSync(specJsonPath, '{}');

      const runNode: RunNode = async (req) => {
        const dag = writeProduct(req.outputDir, 'dag.json', JSON.stringify({ runId: 'x', nodes: [] }));
        return {
          status: 'ok',
          manifestPath: writeManifest(req, {
            schemaVersion: 1,
            status: 'ok',
            summary: 'missing notes',
            files: [dag],
          }),
        };
      };

      const res = await runArchitect({ runId: 'r1', runDir: dir, specPath, specJsonPath, botSnapshot: BOT, runNode });
      expect(res.status).toBe('fail');
      expect(res.problems).toContain('architect manifest must include architect-notes.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on invalid manifest paths before exposing dagPath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-architect-bad-'));
    try {
      const specPath = join(dir, 'spec.md');
      const specJsonPath = join(dir, 'spec.json');
      writeFileSync(specPath, '# Spec');
      writeFileSync(specJsonPath, '{}');

      const runNode: RunNode = async (req) => ({
        status: 'ok',
        manifestPath: writeManifest(req, {
          schemaVersion: 1,
          status: 'ok',
          summary: 'bad path',
          files: [
            { name: 'dag.json', path: '../dag.json', kind: 'json', bytes: 1, sha256: 'x', mime: 'application/json' },
            { name: 'architect-notes.md', path: 'architect-notes.md', kind: 'markdown', bytes: 1, sha256: 'x', mime: 'text/markdown' },
          ],
        }),
      });

      const res = await runArchitect({ runId: 'r1', runDir: dir, specPath, specJsonPath, botSnapshot: BOT, runNode });
      expect(res.status).toBe('fail');
      expect(res.dagPath).toBeUndefined();
      expect(res.problems?.join('\n')).toMatch(/must stay inside outputDir|does not exist|bytes mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
