/**
 * Per-bot card-behaviour preferences. Mirrors the brand-store / oncall-store
 * pattern: cross-process file lock + atomic write of bots.json, plus an
 * in-memory registry sync so the daemon's own card builders pick up the change
 * without a restart.
 *
 * Two independent toggles:
 *   • disableStreamingCard      — suppress the live streaming session card
 *   • writableTerminalLinkInCard — embed a directly-usable writable terminal
 *                                  link in the streaming card body
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export interface BotCardPrefs {
  disableStreamingCard: boolean;
  writableTerminalLinkInCard: boolean;
}

/** Current card prefs for a bot (both default false when unset). */
export function getBotCardPrefs(larkAppId: string): BotCardPrefs {
  try {
    const c = getBot(larkAppId).config;
    return {
      disableStreamingCard: c.disableStreamingCard === true,
      writableTerminalLinkInCard: c.writableTerminalLinkInCard === true,
    };
  } catch {
    return { disableStreamingCard: false, writableTerminalLinkInCard: false };
  }
}

/**
 * Persist a partial card-prefs change. Only the keys present in `patch` are
 * touched; a `false` value removes the key (keeps bots.json tidy — absent means
 * the default). Returns the full resolved prefs after the write.
 */
export async function updateBotCardPrefs(
  larkAppId: string,
  patch: Partial<BotCardPrefs>,
): Promise<{ ok: true; prefs: BotCardPrefs } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const apply = (entry: any, key: keyof BotCardPrefs, val: boolean | undefined) => {
    if (val === undefined) return;
    if (val) entry[key] = true;
    else delete entry[key];
  };

  const r = await rmwBotEntry<BotCardPrefs>(larkAppId, (entry) => {
    apply(entry, 'disableStreamingCard', patch.disableStreamingCard);
    apply(entry, 'writableTerminalLinkInCard', patch.writableTerminalLinkInCard);
    return {
      write: true,
      result: {
        disableStreamingCard: entry.disableStreamingCard === true,
        writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true,
      },
    };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Sync in-memory config so live card builders react without a restart.
  if (patch.disableStreamingCard !== undefined) {
    bot.config.disableStreamingCard = patch.disableStreamingCard || undefined;
  }
  if (patch.writableTerminalLinkInCard !== undefined) {
    bot.config.writableTerminalLinkInCard = patch.writableTerminalLinkInCard || undefined;
  }
  logger.info(
    `[card-prefs:${larkAppId}] disableStreamingCard=${r.result.disableStreamingCard} ` +
    `writableTerminalLinkInCard=${r.result.writableTerminalLinkInCard}`,
  );
  return { ok: true, prefs: r.result };
}
