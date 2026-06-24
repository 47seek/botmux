import {
  getBot,
  type ContentTriggerConfig,
} from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { logger } from '../utils/logger.js';

export const DASHBOARD_SUMMARY_TRIGGER_NAME = 'dashboard-default-summary-trigger';
export const DEFAULT_SUMMARY_KEYWORD = '总结';
export const DEFAULT_SUMMARY_LIMIT = 50;
export const DEFAULT_SUMMARY_SINCE_HOURS = 24;
export const DEFAULT_SUMMARY_PROMPT =
  '请根据当前会话历史生成总结。若是话题群，请总结当前话题；若是普通群，请总结配置范围内的群聊历史。总结需包含：背景、关键讨论、结论、待办事项。避免泄露无关隐私信息。';

export interface SummaryTriggerPrefs {
  enabled: boolean;
  keyword: string;
  limit: number;
  sinceHours: number;
}

export type SummaryTriggerUpdateResult = {
  ok: true;
  summaryTrigger: SummaryTriggerPrefs;
  contentTriggers: ContentTriggerConfig[];
} | {
  ok: false;
  reason: string;
};

function toNonNegativeInt(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

export function defaultSummaryTriggerPrefs(): SummaryTriggerPrefs {
  return {
    enabled: false,
    keyword: DEFAULT_SUMMARY_KEYWORD,
    limit: DEFAULT_SUMMARY_LIMIT,
    sinceHours: DEFAULT_SUMMARY_SINCE_HOURS,
  };
}

export function summaryTriggerFromContentTriggers(triggers: readonly ContentTriggerConfig[] | undefined): SummaryTriggerPrefs {
  const def = defaultSummaryTriggerPrefs();
  const trigger = triggers?.find(t => t.name === DASHBOARD_SUMMARY_TRIGGER_NAME);
  if (!trigger) return def;
  return {
    enabled: trigger.enabled === true,
    keyword: trigger.match.type === 'keyword' && trigger.match.pattern ? trigger.match.pattern : def.keyword,
    limit: toNonNegativeInt(trigger.history.regularGroup.limit, def.limit),
    sinceHours: toNonNegativeInt(trigger.history.regularGroup.sinceHours, def.sinceHours),
  };
}

export function buildDashboardSummaryTrigger(prefs: SummaryTriggerPrefs): ContentTriggerConfig {
  return {
    name: DASHBOARD_SUMMARY_TRIGGER_NAME,
    enabled: prefs.enabled,
    scope: 'both',
    match: {
      type: 'keyword',
      pattern: prefs.keyword,
      caseSensitive: false,
    },
    history: {
      topic: { mode: 'current-thread' },
      regularGroup: {
        mode: 'recent-messages',
        limit: prefs.limit,
        sinceHours: prefs.sinceHours,
      },
    },
    action: {
      type: 'start-or-wake-session',
      prompt: DEFAULT_SUMMARY_PROMPT,
    },
  };
}

export function upsertDashboardSummaryTrigger(
  existing: readonly ContentTriggerConfig[] | undefined,
  prefs: SummaryTriggerPrefs,
): ContentTriggerConfig[] {
  const next = [...(existing ?? [])].filter(t => t.name !== DASHBOARD_SUMMARY_TRIGGER_NAME);
  next.push(buildDashboardSummaryTrigger(prefs));
  return next;
}

type NormalizeSummaryPrefsResult =
  | { ok: true; prefs: SummaryTriggerPrefs }
  | { ok: false; reason: string };

function normalizeSummaryPrefs(raw: unknown): NormalizeSummaryPrefsResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_json' };
  const body = raw as Record<string, unknown>;
  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  if (!keyword) return { ok: false, reason: 'keyword_required' };
  const limit = body.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return { ok: false, reason: 'invalid_limit' };
  const sinceHours = body.sinceHours;
  if (typeof sinceHours !== 'number' || !Number.isInteger(sinceHours) || sinceHours < 0) {
    return { ok: false, reason: 'invalid_since_hours' };
  }
  return {
    ok: true,
    prefs: {
      enabled: body.enabled === true,
      keyword,
      limit,
      sinceHours,
    },
  };
}

export async function updateDashboardSummaryTrigger(
  larkAppId: string,
  rawBody: unknown,
): Promise<SummaryTriggerUpdateResult> {
  const normalized = normalizeSummaryPrefs(rawBody);
  if (!normalized.ok) return normalized;
  const prefs = normalized.prefs;

  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const nextForMemory = upsertDashboardSummaryTrigger(bot.config.contentTriggers, prefs);
  const r = await rmwBotEntry<ContentTriggerConfig[]>(larkAppId, (entry) => {
    const existingRaw = Array.isArray(entry.contentTriggers) ? entry.contentTriggers : [];
    const nextRaw = existingRaw.filter((t: unknown) =>
      !t || typeof t !== 'object' || Array.isArray(t) || (t as Record<string, unknown>).name !== DASHBOARD_SUMMARY_TRIGGER_NAME,
    );
    nextRaw.push(buildDashboardSummaryTrigger(prefs));
    entry.contentTriggers = nextRaw;
    return { write: true, result: nextForMemory };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.contentTriggers = nextForMemory;
  logger.info(`[content-trigger:${larkAppId}] dashboard summary trigger ${prefs.enabled ? 'enabled' : 'disabled'} keyword=${JSON.stringify(prefs.keyword)} limit=${prefs.limit} sinceHours=${prefs.sinceHours}`);
  return {
    ok: true,
    summaryTrigger: summaryTriggerFromContentTriggers(nextForMemory),
    contentTriggers: nextForMemory,
  };
}
