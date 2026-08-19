import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createDirectUpdateApi, type DirectUpdateApiDeps } from '../src/dashboard/direct-update-api.js';

class TestResponse extends EventEmitter {
  destroyed = false;
  writableFinished = false;
  status = 0;
  body: Record<string, unknown> = {};

  writeHead(status: number): this {
    this.status = status;
    return this;
  }

  end(body?: string): this {
    this.body = body ? JSON.parse(body) as Record<string, unknown> : {};
    return this;
  }

  finish(): void {
    this.writableFinished = true;
    this.emit('finish');
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function makeDeps(overrides: Partial<DirectUpdateApiDeps> = {}) {
  let updateInFlight = false;
  const spawnRestart = vi.fn(() => ({ pid: 1234 }));
  const runSourceUpdate = vi.fn(async () => ({
    oldHead: 'old',
    newHead: 'new',
    changed: true,
    branch: 'develop',
    upstream: 'origin/develop',
  }));
  const runPublishedInstall = vi.fn(async () => '3.10.0');
  const deps: DirectUpdateApiDeps = {
    isLocalDevInstall: () => true,
    getSourceRoot: () => '/repo/source',
    inspectSourceUpdate: vi.fn(async () => ({
      supported: true,
      root: '/repo/source',
      branch: 'develop',
      upstream: 'origin/develop',
      head: 'old',
      clean: true,
      blockedReason: null,
    })),
    runSourceUpdate,
    resolvePublishedSwitch: () => ({
      plan: {
        manager: 'npm',
        command: 'npm',
        args: ['install', '-g', '--prefix', '/opt/homebrew', 'botmux@latest'],
        binPaths: ['/opt/homebrew/bin/botmux'],
        activePackageRoot: '/opt/homebrew/lib/node_modules/botmux',
      },
      status: {
        supported: true,
        manager: 'npm',
        targetRoot: '/opt/homebrew/lib/node_modules/botmux',
        command: 'npm install -g --prefix /opt/homebrew botmux@latest',
        blockedReason: null,
      },
    }),
    inspectPublishedInstallStorage: vi.fn(async () => ({
      supported: true,
      availableBytes: 10 * 1024 ** 3,
      requiredBytes: 3 * 1024 ** 3,
      blockedReason: null,
    })),
    checkNode: () => ({ version: 'v22.0.0', major: 22, required: 22, ok: true }),
    tryAcquireUpdateGate: () => {
      if (updateInFlight) return false;
      updateInFlight = true;
      return true;
    },
    releaseUpdateGate: () => { updateInFlight = false; },
    withUpdateLock: async operation => operation(),
    hasActiveRestartLease: () => false,
    claimRestartLease: () => 'lease-1',
    clearRestartLease: vi.fn(),
    clearRestartIntent: vi.fn(),
    writeManualIntentIfAbsent: vi.fn(),
    writeRestartIntent: vi.fn(),
    currentInstalledVersion: () => '3.9.2',
    versionAt: () => '3.9.2',
    runPublishedInstall,
    spawnRestart,
    logRestartFailure: vi.fn(),
    ...overrides,
  };
  return { deps, spawnRestart, runSourceUpdate, runPublishedInstall };
}

describe('dashboard direct update API', () => {
  it('acknowledges source update before restarting from the source root', async () => {
    const { deps, spawnRestart } = makeDeps();
    const response = new TestResponse();
    await createDirectUpdateApi(deps).runSource(response.asServerResponse(), true);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ operation: 'source-update', restartScheduled: true });
    expect(spawnRestart).not.toHaveBeenCalled();
    response.finish();
    expect(spawnRestart).toHaveBeenCalledWith('dashboard-source-update', '/repo/source', 'lease-1');
  });

  it('blocks published install before mutation when storage is insufficient', async () => {
    const { deps, runPublishedInstall } = makeDeps({
      inspectPublishedInstallStorage: vi.fn(async () => ({
        supported: false,
        availableBytes: 1024,
        requiredBytes: 2048,
        blockedReason: 'insufficient_disk_space',
      })),
    });
    const response = new TestResponse();
    await createDirectUpdateApi(deps).runPublished(response.asServerResponse(), true);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: 'published_switch_blocked',
      reason: 'insufficient_disk_space',
      availableBytes: 1024,
      requiredBytes: 2048,
    });
    expect(runPublishedInstall).not.toHaveBeenCalled();
  });
});
