import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_SUMMARY_TRIGGER_NAME,
  DEFAULT_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_SINCE_HOURS,
  defaultSummaryTriggerPrefs,
  summaryTriggerFromContentTriggers,
  upsertDashboardSummaryTrigger,
} from '../src/services/content-trigger-preset-store.js';
import type { ContentTriggerConfig } from '../src/bot-registry.js';

const otherTrigger: ContentTriggerConfig = {
  name: 'custom-trigger',
  enabled: true,
  scope: 'both',
  match: { type: 'keyword', pattern: '复盘', caseSensitive: false },
  history: {
    topic: { mode: 'current-thread' },
    regularGroup: { mode: 'recent-messages', limit: 10, sinceHours: 2 },
  },
  action: { type: 'start-or-wake-session', prompt: 'custom prompt' },
};

describe('dashboard summary trigger preset', () => {
  it('defaults to disabled summary with 50 messages and 24 hours', () => {
    expect(defaultSummaryTriggerPrefs()).toEqual({
      enabled: false,
      keyword: '总结',
      limit: DEFAULT_SUMMARY_LIMIT,
      sinceHours: DEFAULT_SUMMARY_SINCE_HOURS,
    });
    expect(summaryTriggerFromContentTriggers(undefined)).toEqual(defaultSummaryTriggerPrefs());
  });

  it('projects existing dashboard summary trigger values', () => {
    const triggers = upsertDashboardSummaryTrigger([otherTrigger], {
      enabled: true,
      keyword: '本次问题已解决',
      limit: 0,
      sinceHours: 0,
    });
    expect(summaryTriggerFromContentTriggers(triggers)).toEqual({
      enabled: true,
      keyword: '本次问题已解决',
      limit: 0,
      sinceHours: 0,
    });
  });

  it('upserts only the dashboard-managed trigger and preserves custom triggers', () => {
    const first = upsertDashboardSummaryTrigger([otherTrigger], {
      enabled: true,
      keyword: '总结',
      limit: 50,
      sinceHours: 24,
    });
    const second = upsertDashboardSummaryTrigger(first, {
      enabled: false,
      keyword: 'done',
      limit: 0,
      sinceHours: 12,
    });

    expect(second.map(t => t.name)).toEqual(['custom-trigger', DASHBOARD_SUMMARY_TRIGGER_NAME]);
    expect(second.find(t => t.name === 'custom-trigger')).toEqual(otherTrigger);
    expect(second.find(t => t.name === DASHBOARD_SUMMARY_TRIGGER_NAME)).toMatchObject({
      enabled: false,
      match: { pattern: 'done' },
      history: { regularGroup: { limit: 0, sinceHours: 12 } },
    });
  });
});
