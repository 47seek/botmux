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

describe('dashboard source update preflight', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-source-preflight-'));
    mkdirSync(join(root, '.git'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runner(divergence: string): SourceUpdateCommandRunner {
    return vi.fn(async command => {
      const key = commandKey(command);
      if (key === '--version') return result(0, 'git version 2.50.0\n');
      if (key === 'rev-parse --show-toplevel') return result(0, `${root}\n`);
      if (key === 'rev-parse HEAD') return result(0, 'abc123\n');
      if (key === 'status --porcelain=v1 --untracked-files=normal') return result();
      if (key === 'symbolic-ref --quiet --short HEAD') return result(0, 'feature/settings\n');
      if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return result(0, 'origin/feature/settings\n');
      }
      if (key === 'rev-list --left-right --count HEAD...origin/feature/settings') {
        return result(0, `${divergence}\n`);
      }
      throw new Error(`Unexpected command: ${key}`);
    });
  }

  it('allows a clean branch that is only ahead of its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: runner('2 0') })).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
      branch: 'feature/settings',
      upstream: 'origin/feature/settings',
    });
  });

  it('allows a clean branch that can fast-forward from its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: runner('0 2') })).resolves.toMatchObject({
      supported: true,
      blockedReason: null,
    });
  });

  it('blocks a branch that has diverged from its upstream', async () => {
    await expect(inspectSourceUpdate(root, { runCommand: runner('2 1') })).resolves.toMatchObject({
      supported: false,
      blockedReason: 'diverged',
      clean: true,
    });
  });
});
