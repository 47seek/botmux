import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectSourceUpdate,
  type SourceUpdateCommand,
  type SourceUpdateCommandResult,
  type SourceUpdateCommandRunner,
} from '../src/dashboard/source-update.js';

function result(code = 0, stdout = '', stderr = ''): SourceUpdateCommandResult {
  return { code, signal: null, stdout, stderr };
}

function commandKey(command: SourceUpdateCommand): string {
  return command.args.join(' ');
}

interface RunnerOptions {
  divergence?: string;
  dirty?: boolean;
  /** stdout for `@{upstream}` resolution; empty means no upstream (git exits 128). */
  upstream?: string | null;
  /** whether `origin/<branch>` remote-tracking ref exists. */
  originBranchExists?: boolean;
  branch?: string | null;
}

describe('dashboard source update preflight', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-source-preflight-'));
    mkdirSync(join(root, '.git'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(opts: RunnerOptions = {}): SourceUpdateCommandRunner {
    const {
      divergence = '0 2',
      dirty = false,
      upstream = 'origin/feature/settings',
      originBranchExists = false,
      branch = 'feature/settings',
    } = opts;
    return vi.fn(async command => {
      const key = commandKey(command);
      if (key === '--version') return result(0, 'git version 2.50.0\n');
      if (key === 'rev-parse --show-toplevel') return result(0, `${root}\n`);
      if (key === 'rev-parse HEAD') return result(0, 'abc123\n');
      if (key === 'status --porcelain=v1 --untracked-files=normal') {
        return result(0, dirty ? ' M src/x.ts\n' : '');
      }
      if (key === 'symbolic-ref --quiet --short HEAD') {
        return branch ? result(0, `${branch}\n`) : result(1, '');
      }
      if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return upstream ? result(0, `${upstream}\n`) : result(128, '', 'no upstream configured');
      }
      if (key === `rev-list --left-right --count HEAD...${upstream}`) {
        return result(0, `${divergence}\n`);
      }
      if (branch && key === `rev-parse --verify --quiet origin/${branch}^{commit}`) {
        return originBranchExists ? result(0, 'def456\n') : result(1, '');
      }
      throw new Error(`Unexpected command: ${key}`);
    });
  }

  it('allows a clean branch that is only ahead of its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: makeRunner({ divergence: '2 0' }) })).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
      branch: 'feature/settings',
      upstream: 'origin/feature/settings',
      needsStash: false,
      pullTarget: null,
    });
  });

  it('allows a clean branch that can fast-forward from its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: makeRunner({ divergence: '0 2' }) })).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
    });
  });

  it('blocks a branch that has diverged from its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: makeRunner({ divergence: '2 1' }) })).resolves.toMatchObject({
      supported: false,
      blockedReason: 'diverged',
      clean: true,
    });
  });

  it('does not block a dirty worktree; marks it as needing a stash', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: makeRunner({ dirty: true }) })).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
      clean: false,
      needsStash: true,
    });
  });

  it('falls back to origin/<branch> when there is no upstream but the remote branch exists', async () => {
    await expect(
      inspectSourceUpdate(root, { runCommand: makeRunner({ upstream: null, originBranchExists: true }) }),
    ).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
      upstream: null,
      pullTarget: 'origin/feature/settings',
    });
  });

  it('blocks when there is neither an upstream nor a matching origin branch', async () => {
    await expect(
      inspectSourceUpdate(root, { runCommand: makeRunner({ upstream: null, originBranchExists: false }) }),
    ).resolves.toMatchObject({
      supported: false,
      blockedReason: 'no_upstream',
      pullTarget: null,
    });
  });

  it('blocks a detached HEAD', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: makeRunner({ branch: null }) })).resolves.toMatchObject({
      supported: false,
      blockedReason: 'detached_head',
    });
  });
});
