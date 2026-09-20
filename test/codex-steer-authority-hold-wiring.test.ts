import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

// The screen-ready idle heuristic released active-turn authority the moment the
// Codex transcript bridge stopped reporting a running/pre-start turn. A human
// steer into a busy Codex is written to the rollout only when Codex consumes it,
// which can lag the 20s pre-start lease — so the release fired first, the daemon
// cleared managedTurnOrigin, and the delayed human auth-request was rejected
// `origin_incomplete`. The fix holds that release across the consumption gap via
// a bounded, non-authorizing PendingAuthorityHold whose semantics (tuple-exact,
// generation-scoped, bounded recycle, invalidation) are proven in
// pending-authority-hold.test.ts. This file asserts the worker wires that record
// at the correct seams — the module-state-heavy parts that aren't unit-testable
// end-to-end without spawning a real worker + real Codex rollout.
describe('Codex steer authority-hold wiring', () => {
  it('consults the hold in the screen-ready release decision, not just durableTurnInFlight', () => {
    const marker = "releaseActiveTurnAuthority('prompt_ready')";
    const idx = workerSource.indexOf(marker);
    expect(idx).toBeGreaterThan(0);
    const region = workerSource.slice(idx - 600, idx + 120);
    // The release gate must AND in the hold check so a not-yet-consumed steer is
    // not released by the UI idle edge.
    expect(region).toContain('pendingAuthorityHold.holds(');
    expect(region).toContain('activeTurnAuthority.identity()');
    expect(region).toContain('cliSpawnGeneration');
    expect(region).toContain('!durableTurnInFlight && !holdsSteerAuthority');
  });

  it('begins the hold on the Codex transcript-bridge steer path only (not RPC/durable)', () => {
    // The call site (not the function definition) sits inside the
    // `codexBridgeActive && !writeRpcEngine` submit branch, after the bridge
    // mark — RPC turns keep authority via app-server ack and durable turns via
    // durableTurnInFlight.
    const begin = workerSource.indexOf('          beginAuthorityHoldForCurrentSteer();');
    expect(begin).toBeGreaterThan(0);
    const branch = workerSource.lastIndexOf('} else if (codexBridgeActive && !writeRpcEngine) {', begin);
    const nextBranch = workerSource.indexOf('} else if (lastInitConfig?.cliId === \'cursor\'', begin);
    expect(branch).toBeGreaterThan(0);
    expect(begin).toBeGreaterThan(branch);
    expect(begin).toBeLessThan(nextBranch);

    // The begin helper only arms for an ordinary human steer: no dispatchAttempt
    // (durable deliveries excluded) and not while durableTurnInFlight.
    const helperStart = workerSource.indexOf('function beginAuthorityHoldForCurrentSteer');
    expect(helperStart).toBeGreaterThan(0);
    const helper = workerSource.slice(helperStart, workerSource.indexOf('\n}', helperStart));
    expect(helper).toContain('if (durableTurnInFlight) return;');
    expect(helper).toContain('identity.dispatchAttempt !== undefined');
    expect(helper).toContain('pendingAuthorityHold.begin(');
    expect(helper).toContain('scheduleAuthorityHoldRecycle(');
  });

  it('clears the hold on a real release of its exact tuple (terminal / prompt-ready)', () => {
    const start = workerSource.indexOf('function releaseActiveTurnAuthority');
    const body = workerSource.slice(start, workerSource.indexOf('\n}', start));
    // A matching release is a lifecycle boundary — the hold must drop with it.
    expect(body).toContain('clearAuthorityHold()');
    expect(body).toContain('pendingAuthorityHold.holds(');
  });

  it('clears the hold on generation change / teardown (backend exit AND close)', () => {
    // Both teardown sites clear activeTurnAuthority directly (not via
    // releaseActiveTurnAuthority), so each must also drop the hold or a stale
    // record could outlive the CLI generation.
    const clears = [...workerSource.matchAll(/activeTurnAuthority\.clear\(\);/g)];
    expect(clears.length).toBeGreaterThanOrEqual(2);
    for (const m of clears) {
      // Skip the one inside releaseActiveTurnAuthority (covered above): it is the
      // `: activeTurnAuthority.clear();` ternary arm, not a teardown site.
      const around = workerSource.slice(m.index!, m.index! + 120);
      if (around.startsWith('activeTurnAuthority.clear();\n    if (!intentionalRestart')
        || around.startsWith('activeTurnAuthority.clear();\n  currentVcMeetingImTurnOrigin')) {
        expect(around).toContain('clearAuthorityHold()');
      }
    }
  });

  it('recycles a never-consumed steer by re-driving ready after the bounded window', () => {
    const start = workerSource.indexOf('function scheduleAuthorityHoldRecycle');
    expect(start).toBeGreaterThan(0);
    const body = workerSource.slice(start, workerSource.indexOf('\n}', start));
    expect(body).toContain('pendingAuthorityHold.clear()');
    // Re-drive the ready path so the now-unheld stale authority can release.
    expect(body).toContain('markPromptReady()');
    expect(body).toContain('unref');
  });
});
