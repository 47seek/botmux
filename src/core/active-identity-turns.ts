/**
 * Accepted-but-not-terminal turn ledger, per session.
 *
 * The daemon publishes an identity when a message is ACCEPTED, while the worker
 * may hold it in its type-ahead queue for a long time before executing. Terminal
 * identity garbage collection needs to keep that published material even though
 * no other daemon-side structure names the queued turn yet — the worker's own
 * PID marker is CLI-writable and therefore cannot anchor a retention decision.
 *
 * A turn is registered at publication and released on its exact terminal (or
 * rejection). Replays publish and register the same turn id again; a stale
 * terminal from an older dispatch attempt does not release the newer one
 * (callers gate the release on the attempt match).
 *
 * Daemon memory only: a restart clears the ledger, and surviving workers
 * re-publish (re-register) the turns they replay.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_TURNS_PER_SESSION = 256;

const sessions = new Map<string, Set<string>>();

function sessionKey(dataDir: string, sessionId: string): string {
  let canonical: string;
  try { canonical = realpathSync(dataDir); } catch { canonical = resolve(dataDir); }
  return JSON.stringify([canonical, sessionId]);
}

/** Mark a published turn as still alive (queued, preparing, or executing). */
export function registerActiveIdentityTurn(dataDir: string, sessionId: string, turnId: string): void {
  const key = sessionKey(dataDir, sessionId);
  let turns = sessions.get(key);
  if (!turns) { turns = new Set(); sessions.set(key, turns); }
  turns.add(turnId);
  // Defensive bound: a session that somehow never terminals stops accruing
  // beyond this many turns. Fail toward retention — GC simply cannot collect
  // anything for a session at the cap.
  if (turns.size > MAX_TURNS_PER_SESSION) turns.clear();
}

/** Release one turn after its terminal/rejection was observed. */
export function releaseActiveIdentityTurn(dataDir: string, sessionId: string, turnId: string): void {
  sessions.get(sessionKey(dataDir, sessionId))?.delete(turnId);
}

/** All still-alive published turn ids for a session. */
export function activeIdentityTurns(dataDir: string, sessionId: string): string[] {
  return [...(sessions.get(sessionKey(dataDir, sessionId)) ?? [])];
}

/** Drop the whole session ledger (teardown). */
export function clearActiveIdentityTurns(dataDir: string, sessionId: string): void {
  sessions.delete(sessionKey(dataDir, sessionId));
}
