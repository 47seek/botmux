import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectPublishedInstallStorage,
  runPublishedInstallTransaction,
} from '../src/dashboard/published-install.js';
import type { GlobalInstallPlan } from '../src/utils/global-install.js';

function seedPackage(root: string, version: string, marker: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'dist', 'cli.js'), marker);
}

describe('dashboard published install transaction', () => {
  let base: string;
  let packageRoot: string;
  let binPath: string;
  let plan: GlobalInstallPlan;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'botmux-published-install-'));
    packageRoot = join(base, 'lib', 'node_modules', 'botmux');
    binPath = join(base, 'bin', 'botmux');
    seedPackage(packageRoot, '3.9.2', 'old cli');
    mkdirSync(dirname(binPath), { recursive: true });
    symlinkSync('../lib/node_modules/botmux/dist/cli.js', binPath);
    plan = {
      manager: 'npm',
      command: 'npm',
      args: ['install', '-g', '--prefix', base, 'botmux@latest'],
      binPaths: [binPath],
      activePackageRoot: packageRoot,
    };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('blocks before mutation when available storage is below the floor', async () => {
    const storage = await inspectPublishedInstallStorage(plan, {
      minFreeBytes: 500,
      fs: {
        lstat: async path => (await import('node:fs/promises')).lstat(path),
        mkdir: async path => { mkdirSync(path, { recursive: true }); },
        readFile: async path => readFileSync(path),
        readlink: async path => readlinkSync(path),
        rename: async () => undefined,
        rm: async () => undefined,
        stat: async path => (await import('node:fs/promises')).stat(path),
        statfs: async () => ({ bavail: 4, bsize: 100 }),
        symlink: async () => undefined,
        writeFile: async () => undefined,
      },
    });
    expect(storage).toEqual({
      supported: false,
      availableBytes: 400,
      requiredBytes: 500,
      blockedReason: 'insufficient_disk_space',
    });
  });

  it('restores package root and launcher after install failure', async () => {
    const install = vi.fn(async () => {
      seedPackage(packageRoot, '3.10.0', 'partial cli');
      rmSync(binPath, { force: true });
      symlinkSync('../lib/node_modules/botmux/dist/partial.js', binPath);
      throw new Error('ENOSPC');
    });
    await expect(runPublishedInstallTransaction(plan, install, {
      minFreeBytes: 0,
      now: () => 42,
      pid: 7,
    })).rejects.toMatchObject({ name: 'PublishedInstallError', stage: 'install', message: 'ENOSPC' });
    expect(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version).toBe('3.9.2');
    expect(readFileSync(join(packageRoot, 'dist', 'cli.js'), 'utf8')).toBe('old cli');
    expect(readlinkSync(binPath)).toBe('../lib/node_modules/botmux/dist/cli.js');
    expect(readdirSync(dirname(packageRoot)).some(name => name.includes('dashboard-backup'))).toBe(false);
  });

  it('keeps verified replacement on success', async () => {
    const install = vi.fn(async () => {
      seedPackage(packageRoot, '3.10.0', 'new cli');
      symlinkSync('../lib/node_modules/botmux/dist/cli.js', binPath);
    });
    await expect(runPublishedInstallTransaction(plan, install, {
      minFreeBytes: 0,
      versionAt: root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    })).resolves.toBe('3.10.0');
    expect(readFileSync(join(packageRoot, 'dist', 'cli.js'), 'utf8')).toBe('new cli');
    expect(existsSync(binPath)).toBe(true);
  });
});
