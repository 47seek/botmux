/**
 * Bounded authority hold for a human steer that is still awaiting Codex
 * consumption.
 *
 * The screen-ready idle heuristic (worker markPromptReady) releases the active
 * turn authority the moment the transcript bridge stops reporting a running or
 * bounded-pre-start turn. A human message steered into a busy Codex is recorded
 * in the rollout only when Codex actually consumes it, which can be later than
 * the 20s pre-start lease that keeps the queue head alive. Once that head is
 * pruned the bridge reports no turn, the idle heuristic releases authority, and
 * the delayed human auth-request is rejected `origin_incomplete`.
 *
 * This record is deliberately NON-authorizing: it never authorizes a send by
 * itself. It only answers one question at the release decision — "is the current
 * active authority a not-yet-consumed steer that must not be released by the UI
 * idle heuristic yet?" — and it is bound to the exact turn tuple, the CLI spawn
 * generation, and a bounded deadline. Any real lifecycle boundary (consumption,
 * terminal, supersession by a newer turn, generation change, teardown) clears
 * it; a never-consumed steer is recycled at the bounded deadline so a lost input
 * can never wedge authority open.
 */
export interface AuthorityHoldIdentity {
  turnId: string;
  dispatchAttempt?: number;
  generation: number;
}

interface AuthorityHoldRecord {
  turnId: string;
  dispatchAttempt?: number;
  generation: number;
  deadlineMs: number;
}

export class PendingAuthorityHold {
  private held?: AuthorityHoldRecord;

  /** Begin (or replace) the hold for a steer that has published authority but
   *  whose Codex consumption may lag the pre-start lease. Bounded by maxHoldMs. */
  begin(id: AuthorityHoldIdentity, nowMs: number, maxHoldMs: number): void {
    this.held = {
      turnId: id.turnId,
      ...(id.dispatchAttempt !== undefined ? { dispatchAttempt: id.dispatchAttempt } : {}),
      generation: id.generation,
      deadlineMs: nowMs + maxHoldMs,
    };
  }

  /** True only while a live hold matches this EXACT active tuple and spawn
   *  generation and is within its bounded window. A tuple mismatch (superseded
   *  by a newer turn), a generation change (restart), or an expired deadline all
   *  report not-held so the caller falls through to release (fail-open). */
  holds(
    active: { turnId?: string; dispatchAttempt?: number },
    generation: number,
    nowMs: number,
  ): boolean {
    const h = this.held;
    if (!h) return false;
    if (h.generation !== generation) return false;
    if (nowMs > h.deadlineMs) return false;
    if (!active.turnId || active.turnId !== h.turnId) return false;
    return active.dispatchAttempt === h.dispatchAttempt;
  }

  /** True while a hold record exists and has not passed its deadline, regardless
   *  of the current active tuple. Used to bound the recycle timer's work. */
  isLive(nowMs: number): boolean {
    return !!this.held && nowMs <= this.held.deadlineMs;
  }

  /** Invalidate the hold. Idempotent. Called on every real boundary:
   *  consumption/terminal (release), supersession (new started turn),
   *  generation change and teardown. */
  clear(): void {
    this.held = undefined;
  }

  snapshot(): Readonly<AuthorityHoldRecord> | undefined {
    return this.held ? { ...this.held } : undefined;
  }
}
