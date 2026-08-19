import type { InstallDiagnostics, InstallEntry } from '../utils/install-diagnostics.js';
import {
  formatGlobalInstallCommand,
  tryResolveGlobalInstallPlan,
  type GlobalInstallPlan,
} from '../utils/global-install.js';

export type PublishedSwitchBlockedReason =
  | 'no_published_install'
  | 'multiple_published_installs'
  | 'insufficient_disk_space'
  | 'storage_check_failed';

export interface PublishedSwitchStatus {
  supported: boolean;
  manager: GlobalInstallPlan['manager'] | 'unknown';
  targetRoot: string | null;
  command: string | null;
  blockedReason: PublishedSwitchBlockedReason | null;
  availableBytes?: number | null;
  requiredBytes?: number;
}

export interface PublishedSwitchResolution {
  status: PublishedSwitchStatus;
  plan: GlobalInstallPlan | null;
}

export type ActiveInstallEntry = InstallEntry & { active: boolean };

function normalizedPath(path: string, platform: NodeJS.Platform): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function appendBinPath(
  plan: GlobalInstallPlan,
  binPath: string,
  platform: NodeJS.Platform,
): GlobalInstallPlan {
  const binPaths = new Map<string, string>();
  for (const path of plan.binPaths ?? []) binPaths.set(normalizedPath(path, platform), path);
  binPaths.set(normalizedPath(binPath, platform), binPath);
  return { ...plan, binPaths: [...binPaths.values()] };
}

export function markActiveInstallEntries(
  installs: InstallDiagnostics,
  activeRoot: string,
  platform: NodeJS.Platform = process.platform,
): ActiveInstallEntry[] {
  const active = normalizedPath(activeRoot, platform);
  return installs.entries.map(entry => ({
    ...entry,
    active: normalizedPath(entry.root, platform) === active,
  }));
}

export function resolvePublishedSwitch(
  installs: InstallDiagnostics,
  activeRoot: string,
  platform: NodeJS.Platform = process.platform,
): PublishedSwitchResolution {
  const active = normalizedPath(activeRoot, platform);
  const plans = new Map<string, GlobalInstallPlan>();

  for (const entry of installs.entries) {
    if (normalizedPath(entry.root, platform) === active) continue;
    const plan = tryResolveGlobalInstallPlan(entry.root, platform);
    if (!plan) continue;
    const key = normalizedPath(plan.activePackageRoot, platform);
    plans.set(key, appendBinPath(plans.get(key) ?? plan, entry.binPath, platform));
  }

  if (plans.size !== 1) {
    return {
      plan: null,
      status: {
        supported: false,
        manager: 'unknown',
        targetRoot: null,
        command: null,
        blockedReason: plans.size === 0 ? 'no_published_install' : 'multiple_published_installs',
      },
    };
  }

  const plan = [...plans.values()][0];
  return {
    plan,
    status: {
      supported: true,
      manager: plan.manager,
      targetRoot: plan.activePackageRoot,
      command: formatGlobalInstallCommand(plan),
      blockedReason: null,
    },
  };
}
