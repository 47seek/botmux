import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { GlobalInstallPlan } from '../utils/global-install.js';
import { botmuxVersionAt } from '../utils/install-info.js';

export const PUBLISHED_INSTALL_MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;

export type PublishedInstallBlockedReason =
  | 'insufficient_disk_space'
  | 'storage_check_failed';

export interface PublishedInstallStorageInspection {
  supported: boolean;
  availableBytes: number | null;
  requiredBytes: number;
  blockedReason: PublishedInstallBlockedReason | null;
}

interface BinSnapshot {
  path: string;
  kind: 'file' | 'symlink';
  contents: Buffer | string;
  mode?: number;
}

interface PublishedInstallFs {
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; mode: number }>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number }>;
  statfs(path: string): Promise<{ bavail: number; bsize: number }>;
  symlink(target: string, path: string): Promise<void>;
  writeFile(path: string, data: Buffer, options: { mode?: number }): Promise<void>;
}

export interface PublishedInstallOptions {
  fs?: PublishedInstallFs;
  minFreeBytes?: number;
  now?: () => number;
  pid?: number;
  versionAt?: (root: string) => string;
}

const defaultFs: PublishedInstallFs = {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
};

function dependencies(options: PublishedInstallOptions) {
  return {
    fs: options.fs ?? defaultFs,
    minFreeBytes: options.minFreeBytes ?? PUBLISHED_INSTALL_MIN_FREE_BYTES,
    now: options.now ?? Date.now,
    pid: options.pid ?? process.pid,
    versionAt: options.versionAt ?? botmuxVersionAt,
  };
}

export class PublishedInstallError extends Error {
  readonly stage: 'preflight' | 'install' | 'verify' | 'rollback';
  readonly reason?: PublishedInstallBlockedReason;

  constructor(
    stage: PublishedInstallError['stage'],
    message: string,
    reason?: PublishedInstallBlockedReason,
  ) {
    super(message);
    this.name = 'PublishedInstallError';
    this.stage = stage;
    this.reason = reason;
  }
}

export async function inspectPublishedInstallStorage(
  plan: GlobalInstallPlan,
  options: PublishedInstallOptions = {},
): Promise<PublishedInstallStorageInspection> {
  const deps = dependencies(options);
  try {
    const storage = await deps.fs.statfs(dirname(plan.activePackageRoot));
    const availableBytes = storage.bavail * storage.bsize;
    return {
      supported: availableBytes >= deps.minFreeBytes,
      availableBytes,
      requiredBytes: deps.minFreeBytes,
      blockedReason: availableBytes >= deps.minFreeBytes ? null : 'insufficient_disk_space',
    };
  } catch {
    return {
      supported: false,
      availableBytes: null,
      requiredBytes: deps.minFreeBytes,
      blockedReason: 'storage_check_failed',
    };
  }
}

async function pathExists(fs: PublishedInstallFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function snapshotBins(
  fs: PublishedInstallFs,
  paths: readonly string[],
): Promise<BinSnapshot[]> {
  const snapshots: BinSnapshot[] = [];
  for (const path of paths) {
    try {
      const entry = await fs.lstat(path);
      if (entry.isSymbolicLink()) {
        snapshots.push({ path, kind: 'symlink', contents: await fs.readlink(path) });
      } else if (entry.isFile()) {
        snapshots.push({
          path,
          kind: 'file',
          contents: await fs.readFile(path),
          mode: entry.mode,
        });
      }
    } catch {
      // Missing optional launcher entries need no restoration.
    }
  }
  return snapshots;
}

async function restoreBins(fs: PublishedInstallFs, snapshots: readonly BinSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await fs.rm(snapshot.path, { force: true });
    await fs.mkdir(dirname(snapshot.path), { recursive: true });
    if (snapshot.kind === 'symlink') {
      await fs.symlink(snapshot.contents as string, snapshot.path);
    } else {
      await fs.writeFile(snapshot.path, snapshot.contents as Buffer, { mode: snapshot.mode });
    }
  }
}

async function removeBins(fs: PublishedInstallFs, paths: readonly string[]): Promise<void> {
  for (const path of paths) await fs.rm(path, { force: true });
}

async function verifyPublishedInstall(
  plan: GlobalInstallPlan,
  options: PublishedInstallOptions,
): Promise<string> {
  const deps = dependencies(options);
  const packageJson = join(plan.activePackageRoot, 'package.json');
  const cliEntry = join(plan.activePackageRoot, 'dist', 'cli.js');
  try {
    const [packageStat, cliStat] = await Promise.all([
      deps.fs.stat(packageJson),
      deps.fs.stat(cliEntry),
    ]);
    if (!packageStat.isFile() || packageStat.size === 0) throw new Error('package.json is missing or empty');
    if (!cliStat.isFile() || cliStat.size === 0) throw new Error('dist/cli.js is missing or empty');
    for (const binPath of plan.binPaths ?? []) {
      const binStat = await deps.fs.stat(binPath);
      if (!binStat.isFile() || binStat.size === 0) {
        throw new Error(`launcher is missing or empty: ${binPath}`);
      }
    }
  } catch (error) {
    throw new PublishedInstallError(
      'verify',
      `Published install verification failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  const version = deps.versionAt(plan.activePackageRoot);
  if (!version || version === '0.0.0') {
    throw new PublishedInstallError('verify', `Published install has invalid version: ${version || 'missing'}`);
  }
  return version;
}

export async function runPublishedInstallTransaction(
  plan: GlobalInstallPlan,
  install: (plan: GlobalInstallPlan) => Promise<void>,
  options: PublishedInstallOptions = {},
): Promise<string> {
  const deps = dependencies(options);
  const storage = await inspectPublishedInstallStorage(plan, options);
  if (!storage.supported) {
    const available = storage.availableBytes === null
      ? 'unknown'
      : `${Math.floor(storage.availableBytes / (1024 * 1024))} MiB`;
    throw new PublishedInstallError(
      'preflight',
      `Published install requires at least ${Math.ceil(storage.requiredBytes / (1024 * 1024))} MiB free; available: ${available}`,
      storage.blockedReason ?? undefined,
    );
  }

  const root = plan.activePackageRoot;
  const backup = join(dirname(root), `.${basename(root)}-dashboard-backup-${deps.pid}-${deps.now()}`);
  const hadRoot = await pathExists(deps.fs, root);
  const binSnapshots = await snapshotBins(deps.fs, plan.binPaths ?? []);
  let rootBackedUp = false;

  try {
    if (hadRoot) {
      await deps.fs.rename(root, backup);
      rootBackedUp = true;
    }
    await removeBins(deps.fs, plan.binPaths ?? []);
    await install(plan);
    const version = await verifyPublishedInstall(plan, options);
    if (rootBackedUp) await deps.fs.rm(backup, { recursive: true, force: true });
    return version;
  } catch (error) {
    try {
      if (rootBackedUp) {
        await deps.fs.rm(root, { recursive: true, force: true });
        await deps.fs.rename(backup, root);
        await restoreBins(deps.fs, binSnapshots);
      }
    } catch (rollbackError) {
      throw new PublishedInstallError(
        'rollback',
        `${error instanceof Error ? error.message : error}\nPublished install rollback failed: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`,
      );
    }
    if (error instanceof PublishedInstallError) throw error;
    throw new PublishedInstallError(
      'install',
      error instanceof Error ? error.message : String(error),
    );
  }
}
