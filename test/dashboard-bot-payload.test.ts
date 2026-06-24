import { describe, expect, it } from 'vitest';
import { botDefaultsPayload, botSummaryPayload } from '../src/dashboard/bot-payload.js';

describe('dashboard bot payload helpers', () => {
  it('includes authoritative cliId in group roster bot summaries', () => {
    expect(botSummaryPayload({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    })).toEqual({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      botAvatarUrl: 'https://example.test/avatar.png',
      cliId: 'traex',
    });
  });

  it('includes authoritative cliId in /api/bots success and error rows', () => {
    const daemon = { larkAppId: 'cli_traex', botName: 'TraeX', cliId: 'traex' };
    expect(botDefaultsPayload(daemon, { defaultOncall: { enabled: false } })).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
      defaultOncall: { enabled: false },
    });
    expect(botDefaultsPayload(daemon, undefined, 'http_503')).toMatchObject({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
      error: 'http_503',
    });
  });

  it('defaults auto grant request cards on and preserves explicit off', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      autoGrantRequestCards: true,
    });
    expect(botDefaultsPayload(daemon, { autoGrantRequestCards: false })).toMatchObject({
      autoGrantRequestCards: false,
    });
  });

  it('projects dashboard summary trigger prefs for /api/bots', () => {
    const daemon = { larkAppId: 'app_a', botName: 'BotA', cliId: 'codex' };
    expect(botDefaultsPayload(daemon, {})).toMatchObject({
      summaryTrigger: {
        enabled: false,
        keyword: '总结',
        limit: 50,
        sinceHours: 24,
      },
    });
    expect(botDefaultsPayload(daemon, {
      contentTriggers: [{
        name: 'dashboard-default-summary-trigger',
        enabled: true,
        scope: 'both',
        match: { type: 'keyword', pattern: '本次问题已解决', caseSensitive: false },
        history: {
          topic: { mode: 'current-thread' },
          regularGroup: { mode: 'recent-messages', limit: 0, sinceHours: 0 },
        },
        action: { type: 'start-or-wake-session', prompt: 'summary' },
      }],
    })).toMatchObject({
      summaryTrigger: {
        enabled: true,
        keyword: '本次问题已解决',
        limit: 0,
        sinceHours: 0,
      },
    });
  });
});
