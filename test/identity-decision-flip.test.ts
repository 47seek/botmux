/**
 * N1/N2 flip replay: when the worker's spawn decision flips the identity model
 * relative to the daemon's last ACTUAL publication, the daemon must
 *  1. purge the wrong-model material FIRST (plaintext root files for proven;
 *     proven memory for single),
 *  2. replay the opening turn exactly once via refreshTurnCliIdentity — only
 *     while that turn is still live; a terminal turn is never resurrected.
 *
 * handleIdentityDecisionFlip lives in daemon.ts (it orchestrates daemon-only
 * publication), so it is exercised here by extracting the real function text
 * and running it with injected deps — the same technique as the
 * turn-cli-identity target harness.
 */
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';

const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const fnNode = source.statements.find(
  n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleIdentityDecisionFlip',
);
if (!fnNode) throw new Error('Missing handleIdentityDecisionFlip production handler');
const fnText = ts.transpileModule(fnNode.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function runHandler(ds: any, context: { model: 'single' | 'proven'; flipped: boolean; turnId?: string }, deps: any) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const handler = new Function('deps', 'with (deps) { ' + fnText + '; return handleIdentityDecisionFlip; }')(deps);
  return handler(ds, context);
}

function sessionFixture(extra: Record<string, unknown> = {}): any {
  return {
    session: { sessionId: 'flip-session', status: 'active', queuedActivationTurnId: undefined,
      ...('sessionExtra' in extra ? extra.sessionExtra as object : {}) },
    worker: { killed: false },
    currentTurnId: 'om_open',
    managedTurnOrigin: undefined,
    lastPublishedIdentityModel: 'single',
    ...extra,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    config: { session: { dataDir: '/tmp/flip-data' } },
    logger: { error: vi.fn(), warn: vi.fn() },
    clearSingleIdentityArtifacts: vi.fn(),
    forgetProvenIdentityContent: vi.fn(),
    refreshTurnCliIdentity: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('handleIdentityDecisionFlip', () => {
  it('does nothing without a flip or a turn id', async () => {
    const d = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: false, turnId: 'om_open' }, d);
    expect(d.clearSingleIdentityArtifacts).not.toHaveBeenCalled();
    expect(d.forgetProvenIdentityContent).not.toHaveBeenCalled();
    expect(d.refreshTurnCliIdentity).not.toHaveBeenCalled();

    const d2 = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: true }, d2);
    expect(d2.refreshTurnCliIdentity).not.toHaveBeenCalled();
  });

  it('purges plaintext before replaying a still-live proven turn', async () => {
    const d = deps();
    await runHandler(sessionFixture(), { model: 'proven', flipped: true, turnId: 'om_open' }, d);
    expect(d.clearSingleIdentityArtifacts).toHaveBeenCalledWith('/tmp/flip-data', 'flip-session');
    expect(d.forgetProvenIdentityContent).not.toHaveBeenCalled();
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledOnce();
    // Purge is ordered strictly before the replay (no plaintext/memory overlap).
    expect(d.clearSingleIdentityArtifacts.mock.invocationCallOrder[0])
      .toBeLessThan(d.refreshTurnCliIdentity.mock.invocationCallOrder[0]);
  });

  it('purges proven memory on a flip back to single', async () => {
    const d = deps();
    const ds = sessionFixture({ lastPublishedIdentityModel: 'proven' });
    await runHandler(ds, { model: 'single', flipped: true, turnId: 'om_open' }, d);
    expect(d.forgetProvenIdentityContent).toHaveBeenCalledWith('/tmp/flip-data', 'flip-session');
    expect(d.clearSingleIdentityArtifacts).not.toHaveBeenCalled();
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledWith(ds, 'om_open');
  });

  it('purges but never replays a terminal (no-longer-live) turn', async () => {
    const d = deps();
    const ds = sessionFixture({ currentTurnId: 'om_next' });
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_old' }, d);
    expect(d.clearSingleIdentityArtifacts).toHaveBeenCalledOnce();
    expect(d.refreshTurnCliIdentity).not.toHaveBeenCalled();
  });

  it('treats the queued opening turn and the managed-origin turn as live', async () => {
    const d1 = deps();
    const queued = sessionFixture({ currentTurnId: undefined, sessionExtra: { queuedActivationTurnId: 'om_q' } });
    await runHandler(queued, { model: 'proven', flipped: true, turnId: 'om_q' }, d1);
    expect(d1.refreshTurnCliIdentity).toHaveBeenCalledWith(queued, 'om_q');

    const d2 = deps();
    const originated = sessionFixture({ currentTurnId: undefined, managedTurnOrigin: { turnId: 'om_o' } });
    await runHandler(originated, { model: 'proven', flipped: true, turnId: 'om_o' }, d2);
    expect(d2.refreshTurnCliIdentity).toHaveBeenCalledWith(originated, 'om_o');
  });

  it('does not replay when the session is inactive or the worker is dead', async () => {
    const d1 = deps();
    const inactive = sessionFixture({ sessionExtra: { status: 'idle' } });
    await runHandler(inactive, { model: 'proven', flipped: true, turnId: 'om_open' }, d1);
    expect(d1.refreshTurnCliIdentity).not.toHaveBeenCalled();

    const d2 = deps();
    const dead = sessionFixture({ worker: { killed: true } });
    await runHandler(dead, { model: 'proven', flipped: true, turnId: 'om_open' }, d2);
    expect(d2.refreshTurnCliIdentity).not.toHaveBeenCalled();
  });

  it('replays the same model:turn only once', async () => {
    const d = deps();
    const ds = sessionFixture();
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_open' }, d);
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_open' }, d);
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledOnce();
    // A later turn still gets its own replay.
    ds.currentTurnId = 'om_two';
    await runHandler(ds, { model: 'proven', flipped: true, turnId: 'om_two' }, d);
    expect(d.refreshTurnCliIdentity).toHaveBeenCalledTimes(2);
  });
});
