import { describe, expect, it } from 'vitest';
import { PendingAuthorityHold } from '../src/core/pending-authority-hold.js';

// A human steer into a busy Codex can be consumed only after its 20s pre-start
// lease expires. This record holds the screen-ready idle release across that gap
// WITHOUT authorizing anything itself, and must invalidate on every real
// lifecycle boundary: consumption/terminal (caller clears), supersession by a
// newer turn (tuple mismatch), generation change (restart), teardown (clear),
// and a bounded recycle deadline for a steer Codex never consumes.

const GEN = 7;
const MAX = 60_000;
const active = { turnId: 'om_steer', dispatchAttempt: undefined as number | undefined };

describe('PendingAuthorityHold', () => {
  it('holds the exact active tuple within the bounded window', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    expect(hold.holds(active, GEN, 1_000)).toBe(true);
    expect(hold.holds(active, GEN, 1_000 + MAX)).toBe(true);
  });

  it('recycles (stops holding) once the bounded deadline passes', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    expect(hold.holds(active, GEN, 1_000 + MAX + 1)).toBe(false);
    expect(hold.isLive(1_000 + MAX + 1)).toBe(false);
  });

  it('does not hold across a spawn generation change (restart)', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    expect(hold.holds(active, GEN + 1, 1_000)).toBe(false);
  });

  it('does not hold a superseded turn tuple (newer turn took authority)', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    // A newer human turn is now the active authority — the old hold must not
    // keep it alive.
    expect(hold.holds({ turnId: 'om_newer', dispatchAttempt: undefined }, GEN, 1_000)).toBe(false);
  });

  it('distinguishes dispatchAttempt so a durable replay is not held by a steer record', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    expect(hold.holds({ turnId: 'om_steer', dispatchAttempt: 3 }, GEN, 1_000)).toBe(false);
    expect(hold.holds({ turnId: 'om_steer', dispatchAttempt: undefined }, GEN, 1_000)).toBe(true);
  });

  it('reports not-held for an absent active turnId', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    expect(hold.holds({ turnId: undefined, dispatchAttempt: undefined }, GEN, 1_000)).toBe(false);
  });

  it('clear() invalidates the hold (consumption / terminal / teardown boundary)', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', generation: GEN }, 1_000, MAX);
    hold.clear();
    expect(hold.holds(active, GEN, 1_000)).toBe(false);
    expect(hold.isLive(1_000)).toBe(false);
    expect(hold.snapshot()).toBeUndefined();
  });

  it('begin() replaces a prior hold (latest steer wins)', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_first', generation: GEN }, 1_000, MAX);
    hold.begin({ turnId: 'om_second', generation: GEN }, 2_000, MAX);
    expect(hold.holds({ turnId: 'om_first', dispatchAttempt: undefined }, GEN, 2_000)).toBe(false);
    expect(hold.holds({ turnId: 'om_second', dispatchAttempt: undefined }, GEN, 2_000)).toBe(true);
    expect(hold.snapshot()).toMatchObject({ turnId: 'om_second', generation: GEN });
  });

  it('a dispatchAttempt-scoped steer hold matches its exact attempt', () => {
    const hold = new PendingAuthorityHold();
    hold.begin({ turnId: 'om_steer', dispatchAttempt: 2, generation: GEN }, 1_000, MAX);
    expect(hold.holds({ turnId: 'om_steer', dispatchAttempt: 2 }, GEN, 1_000)).toBe(true);
    expect(hold.holds({ turnId: 'om_steer', dispatchAttempt: undefined }, GEN, 1_000)).toBe(false);
  });
});
