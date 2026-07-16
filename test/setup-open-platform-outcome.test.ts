import { describe, expect, it } from 'vitest';
import {
  blocksSetupBotStart,
  classifySetupOpenPlatformOutcome,
  setupOpenPlatformOutcomeJson,
} from '../src/setup/open-platform-outcome.js';
import type { OpenPlatformAutomationResult } from '../src/setup/open-platform-automation.js';

function success(overrides: Partial<Extract<OpenPlatformAutomationResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    sessionFile: '/tmp/session.json',
    sessionSource: 'botmux_cache' as const,
    cookieCount: 2,
    scopeCount: 3,
    skippedScopeCount: 0,
    subscribedEventCount: 2,
    missingVcEvents: [],
    eventModeReady: true,
    versionId: 'v1',
    ...overrides,
  };
}

describe('classifySetupOpenPlatformOutcome', () => {
  it('distinguishes ready and warning-bearing success', () => {
    expect(classifySetupOpenPlatformOutcome(success()).status).toBe('ready');
    expect(classifySetupOpenPlatformOutcome(success({ scopeWarning: 'partial scope grant' })).status)
      .toBe('ready_with_warnings');
    expect(classifySetupOpenPlatformOutcome(success({ scopeCount: 0 })).status)
      .toBe('ready_with_warnings');
  });

  it('keeps Lark compatibility manual without treating it as a Feishu failure', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'unsupported_brand',
      message: 'only feishu is automated',
    });
    expect(outcome.status).toBe('manual');
    expect(blocksSetupBotStart(outcome)).toBe(false);
  });

  it('blocks bot start for critical Feishu automation failures and serializes details', () => {
    const outcome = classifySetupOpenPlatformOutcome({
      ok: false,
      reason: 'api_error',
      message: 'event callback missing',
      sessionFile: '/tmp/session.json',
      eventModeReady: false,
    });
    expect(outcome.status).toBe('failed');
    expect(blocksSetupBotStart(outcome)).toBe(true);
    expect(setupOpenPlatformOutcomeJson(outcome)).toEqual({
      status: 'failed',
      reason: 'api_error',
      message: 'event callback missing',
      sessionFile: '/tmp/session.json',
      eventModeReady: false,
    });
  });
});
