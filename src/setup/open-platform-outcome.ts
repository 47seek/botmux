import type { OpenPlatformAutomationResult } from './open-platform-automation.js';

type OpenPlatformAutomationSuccess = Extract<OpenPlatformAutomationResult, { ok: true }>;
type OpenPlatformAutomationFailure = Extract<OpenPlatformAutomationResult, { ok: false }>;

export type SetupOpenPlatformOutcome =
  | { status: 'skipped' }
  | { status: 'ready'; result: OpenPlatformAutomationSuccess }
  | { status: 'ready_with_warnings'; result: OpenPlatformAutomationSuccess }
  | { status: 'manual'; result: OpenPlatformAutomationFailure }
  | { status: 'failed'; result: OpenPlatformAutomationFailure };

/**
 * Translate the low-level Open Platform response into setup completion
 * semantics. Lark's SDK compatibility path is intentionally manual because the
 * Feishu Web console automation does not apply there; it must not be reported
 * as a failed Feishu one-click setup.
 */
export function classifySetupOpenPlatformOutcome(
  result: OpenPlatformAutomationResult,
): Exclude<SetupOpenPlatformOutcome, { status: 'skipped' }> {
  if (!result.ok) {
    return result.reason === 'unsupported_brand'
      ? { status: 'manual', result }
      : { status: 'failed', result };
  }
  const hasWarnings = Boolean(result.scopeWarning || result.eventWarning || result.scopeCount === 0);
  return { status: hasWarnings ? 'ready_with_warnings' : 'ready', result };
}

/** Critical Feishu automation failures leave a persisted but not-yet-ready bot. */
export function blocksSetupBotStart(outcome: SetupOpenPlatformOutcome): boolean {
  return outcome.status === 'failed';
}

/** Secret-free JSON representation used by scripted setup output. */
export function setupOpenPlatformOutcomeJson(outcome: SetupOpenPlatformOutcome): Record<string, unknown> {
  if (outcome.status === 'skipped') return { status: outcome.status };
  const { ok: _ok, ...details } = outcome.result;
  return { status: outcome.status, ...details };
}
