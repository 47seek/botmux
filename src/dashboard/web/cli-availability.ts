import { useEffect, useState } from 'react';
import type { CliAvailabilityStatus } from '../../setup/cli-availability.js';

type Option = { available?: boolean; availabilityStatus?: CliAvailabilityStatus };

export function cliAvailabilityStatus(option: Option | undefined): CliAvailabilityStatus {
  // Old servers did not distinguish a PATH miss; retain their wire contract.
  return option?.availabilityStatus ?? (option?.available === false ? 'unavailable'
    : option?.available === true ? 'available' : 'unknown');
}

export async function fetchCliAvailability(
  key: string, appId?: string, signal?: AbortSignal,
): Promise<CliAvailabilityStatus | null> {
  try {
    const query = new URLSearchParams({ key });
    if (appId) query.set('bot', appId);
    const response = await fetch(`/api/cli-options/availability?${query}`, { signal });
    const body = await response.json();
    return response.ok && ['available', 'unavailable', 'unknown'].includes(body?.status) ? body.status : null;
  } catch {
    return null;
  }
}

/** Key and Bot revision also guard the render before effect cleanup runs. */
export function useCliAvailability(
  key: string, option: Option | undefined, appId?: string, revision?: unknown,
): CliAvailabilityStatus {
  const [result, setResult] = useState<{
    key: string; appId?: string; revision?: unknown; status: CliAvailabilityStatus | null;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    void fetchCliAvailability(key, appId, controller.signal).then(status => {
      clearTimeout(timer);
      if (!controller.signal.aborted) setResult({ key, appId, revision, status });
    });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, appId, revision]);
  return result?.key === key && result.appId === appId && result.revision === revision && result.status
    ? result.status : cliAvailabilityStatus(option);
}
