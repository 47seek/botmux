import type { ServerResponse } from 'node:http';

import { jsonRes } from './http.js';
import {
  SourceUpdateError,
  type SourceUpdateInspection,
  type SourceUpdateResult,
} from './source-update.js';
import type { PublishedSwitchResolution } from './published-switch.js';
import type { NodeCheck } from '../utils/install-diagnostics.js';
import type { GlobalInstallPlan } from '../utils/global-install.js';
import {
  PublishedInstallError,
  type PublishedInstallStorageInspection,
} from './published-install.js';

type UpdateRestartIntent = {
  kind: 'update';
  oldVersion: string;
  newVersion: string;
  at: string;
};

interface RestartChild {
  pid?: number;
}

interface RestartLaunchDeps {
  spawnRestart: (reason: string, activePackageRoot: string, leaseId: string) => RestartChild;
  clearRestartLease: (leaseId: string) => void;
  clearRestartIntent: () => void;
  logRestartFailure: (message: string) => void;
}

export interface DirectUpdateApiDeps extends RestartLaunchDeps {
  isLocalDevInstall: () => boolean;
  getSourceRoot: () => string;
  inspectSourceUpdate: (root: string) => Promise<SourceUpdateInspection>;
  runSourceUpdate: (root: string) => Promise<SourceUpdateResult>;
  resolvePublishedSwitch: (sourceRoot: string) => PublishedSwitchResolution;
  inspectPublishedInstallStorage: (plan: GlobalInstallPlan) => Promise<PublishedInstallStorageInspection>;
  checkNode: () => NodeCheck;
  tryAcquireUpdateGate: () => boolean;
  releaseUpdateGate: () => void;
  withUpdateLock: (operation: () => Promise<void>) => Promise<void>;
  hasActiveRestartLease: () => boolean;
  claimRestartLease: () => string | null;
  writeManualIntentIfAbsent: () => void;
  writeRestartIntent: (intent: UpdateRestartIntent) => void;
  currentInstalledVersion: () => string;
  versionAt: (root: string) => string;
  runPublishedInstall: (plan: GlobalInstallPlan) => Promise<string>;
  nowIso?: () => string;
}

export interface DirectUpdateApi {
  runSource(res: ServerResponse, authed: boolean): Promise<void>;
  runPublished(res: ServerResponse, authed: boolean): Promise<void>;
}

export function launchRestartAfterResponse(
  res: ServerResponse,
  reason: string,
  activePackageRoot: string,
  leaseId: string,
  deps: RestartLaunchDeps,
): void {
  let launched = false;
  const launch = () => {
    if (launched) return;
    launched = true;
    try {
      const child = deps.spawnRestart(reason, activePackageRoot, leaseId);
      if (!child.pid) throw new Error('restart driver did not start');
    } catch (error) {
      deps.clearRestartLease(leaseId);
      deps.clearRestartIntent();
      deps.logRestartFailure(
        `[dashboard] ${reason} restart launch failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  if (res.destroyed || res.writableFinished) {
    launch();
  } else {
    res.once('finish', launch);
    res.once('close', launch);
  }
}

export function createDirectUpdateApi(deps: DirectUpdateApiDeps): DirectUpdateApi {
  const restartLaunchDeps: RestartLaunchDeps = deps;

  async function runSource(res: ServerResponse, authed: boolean): Promise<void> {
    if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
    if (!deps.isLocalDevInstall()) {
      return jsonRes(res, 400, { ok: false, error: 'source_update_unavailable' });
    }
    const sourceRoot = deps.getSourceRoot();
    const sourceStatus = await deps.inspectSourceUpdate(sourceRoot);
    if (!sourceStatus.supported) {
      return jsonRes(res, 422, {
        ok: false,
        error: 'source_update_blocked',
        stage: 'preflight',
        reason: sourceStatus.blockedReason,
      });
    }
    const node = deps.checkNode();
    if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
    if (!deps.tryAcquireUpdateGate()) {
      return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
    }

    let acquired = false;
    let blockedByRestart = false;
    let leaseId: string | null = null;
    let updateResult: SourceUpdateResult | null = null;
    try {
      await deps.withUpdateLock(async () => {
        acquired = true;
        if (deps.hasActiveRestartLease()) {
          blockedByRestart = true;
          return;
        }
        updateResult = await deps.runSourceUpdate(sourceRoot);
        leaseId = deps.claimRestartLease();
        if (!leaseId) {
          blockedByRestart = true;
          return;
        }
        try {
          deps.writeManualIntentIfAbsent();
        } catch (error) {
          deps.clearRestartLease(leaseId);
          leaseId = null;
          throw new Error(`restart intent failed: ${error instanceof Error ? error.message : error}`);
        }
      });
      if (blockedByRestart) {
        return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
      }
      const completedUpdate = updateResult as SourceUpdateResult | null;
      const claimedLeaseId = leaseId as string | null;
      if (!completedUpdate || !claimedLeaseId) {
        throw new Error('source update completed without restart handoff');
      }
      jsonRes(res, 202, {
        ok: true,
        operation: 'source-update',
        ...completedUpdate,
        restartScheduled: true,
      });
      launchRestartAfterResponse(
        res,
        'dashboard-source-update',
        sourceRoot,
        claimedLeaseId,
        restartLaunchDeps,
      );
    } catch (error) {
      if (leaseId) deps.clearRestartLease(leaseId);
      if (!acquired) {
        return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      }
      if (error instanceof SourceUpdateError) {
        return jsonRes(res, error.stage === 'preflight' ? 422 : 500, {
          ok: false,
          error: 'source_update_failed',
          stage: error.stage,
          detail: error.message,
        });
      }
      return jsonRes(res, 500, {
        ok: false,
        error: 'source_update_failed',
        stage: 'restart',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      deps.releaseUpdateGate();
    }
  }

  async function runPublished(res: ServerResponse, authed: boolean): Promise<void> {
    if (!authed) return jsonRes(res, 401, { ok: false, error: 'unauthorized' });
    if (!deps.isLocalDevInstall()) {
      return jsonRes(res, 400, { ok: false, error: 'published_switch_unavailable' });
    }
    const sourceRoot = deps.getSourceRoot();
    const resolution = deps.resolvePublishedSwitch(sourceRoot);
    if (!resolution.plan) {
      return jsonRes(res, 422, {
        ok: false,
        error: 'published_switch_blocked',
        stage: 'preflight',
        reason: resolution.status.blockedReason,
      });
    }
    const installPlan = resolution.plan;
    const storage = await deps.inspectPublishedInstallStorage(installPlan);
    if (!storage.supported) {
      return jsonRes(res, 422, {
        ok: false,
        error: 'published_switch_blocked',
        stage: 'preflight',
        reason: storage.blockedReason,
        availableBytes: storage.availableBytes,
        requiredBytes: storage.requiredBytes,
      });
    }
    const node = deps.checkNode();
    if (!node.ok) return jsonRes(res, 400, { ok: false, error: 'node_too_old', node });
    if (!deps.tryAcquireUpdateGate()) {
      return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
    }

    let acquired = false;
    let blockedByRestart = false;
    let leaseId: string | null = null;
    const oldVersion = deps.currentInstalledVersion();
    let previousTargetVersion = '';
    let newVersion = '';
    let failureStage: 'install' | 'restart' = 'install';
    try {
      await deps.withUpdateLock(async () => {
        acquired = true;
        if (deps.hasActiveRestartLease()) {
          blockedByRestart = true;
          return;
        }
        previousTargetVersion = deps.versionAt(installPlan.activePackageRoot);
        newVersion = await deps.runPublishedInstall(installPlan);
        failureStage = 'restart';
        leaseId = deps.claimRestartLease();
        if (!leaseId) {
          blockedByRestart = true;
          return;
        }
        try {
          if (oldVersion !== newVersion) {
            deps.writeRestartIntent({
              kind: 'update',
              oldVersion,
              newVersion,
              at: (deps.nowIso ?? (() => new Date().toISOString()))(),
            });
          } else {
            deps.writeManualIntentIfAbsent();
          }
        } catch (error) {
          deps.clearRestartLease(leaseId);
          leaseId = null;
          throw new Error(`restart intent failed: ${error instanceof Error ? error.message : error}`);
        }
      });
      if (blockedByRestart) {
        return jsonRes(res, 409, { ok: false, error: 'restart_in_flight' });
      }
      const claimedLeaseId = leaseId as string | null;
      if (!claimedLeaseId || !newVersion) {
        throw new Error('published install completed without restart handoff');
      }
      jsonRes(res, 202, {
        ok: true,
        operation: 'published-switch',
        manager: installPlan.manager,
        oldVersion,
        newVersion,
        changed: previousTargetVersion !== newVersion,
        targetRoot: installPlan.activePackageRoot,
        restartScheduled: true,
      });
      launchRestartAfterResponse(
        res,
        'dashboard-published-switch',
        installPlan.activePackageRoot,
        claimedLeaseId,
        restartLaunchDeps,
      );
    } catch (error) {
      if (leaseId) deps.clearRestartLease(leaseId);
      if (!acquired) {
        return jsonRes(res, 409, { ok: false, error: 'update_in_flight' });
      }
      if (error instanceof PublishedInstallError) {
        return jsonRes(res, error.stage === 'preflight' ? 422 : 500, {
          ok: false,
          error: 'published_switch_failed',
          stage: error.stage,
          reason: error.reason,
          detail: error.message,
        });
      }
      return jsonRes(res, 500, {
        ok: false,
        error: 'published_switch_failed',
        stage: failureStage,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      deps.releaseUpdateGate();
    }
  }

  return { runSource, runPublished };
}
