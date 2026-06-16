import { getBot } from '../bot-registry.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { decorateResumeForWrapper } from '../setup/cli-selection.js';
import { buildSessionClosedCard } from '../im/lark/card-builder.js';
import { sessionAnchorId, type DaemonSession } from './types.js';
import type { Locale } from '../i18n/index.js';

/**
 * Build the same "session closed" card `/close` emits for a session that is
 * about to be displaced (e.g. a mid-session `/repo` switch reuses the SAME
 * anchor for a fresh session). Without this trace the old context vanishes —
 * relay/adopt/resume all hit `anchor_occupied` once the new session holds the
 * anchor — so the card keeps it visible and carries the terminal
 * `claude --resume` command as the real recovery path.
 *
 * MUST be called BEFORE killWorker/closeSession: it reads the live session's
 * identity (sessionId, cliSessionId, title, workingDir, anchor) straight off
 * `ds`. Returns the card JSON; the caller decides how to deliver it.
 */
export function buildClosedSessionCard(ds: DaemonSession, locale: Locale): string {
  const botCfg = getBot(ds.larkAppId).config;
  const closedSessionId = ds.session.sessionId;
  const closedCliId = ds.session.cliId ?? botCfg.cliId;
  const cliResumeCommand = (() => {
    try {
      const adapter = createCliAdapterSync(closedCliId, botCfg.cliPathOverride);
      const raw = adapter.buildResumeCommand?.({
        sessionId: closedSessionId,
        cliSessionId: ds.session.cliSessionId,
      }) ?? null;
      return raw ? decorateResumeForWrapper(raw, botCfg.wrapperCli) : null;
    } catch { return null; }
  })();
  return buildSessionClosedCard(
    closedSessionId,
    sessionAnchorId(ds),
    ds.session.title,
    closedCliId,
    ds.session.workingDir,
    cliResumeCommand,
    locale,
  );
}
