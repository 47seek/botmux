import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { logger } from '../src/utils/logger.js';

// P1 handler wiring regression: a rejected auth-request must emit exactly one
// request-correlated [attest-diag] record carrying proofMode + the reason that
// actually collapsed the request, without changing the response verdict.

const CAP = 'ab'.repeat(32);
let ipc: IpcServerHandle;
let session: any;
let debugLines: string[];

beforeEach(async () => {
  session = {
    session: { sessionId: 'auth-session', status: 'active' },
    larkAppId: 'cli_test', chatId: 'oc_test',
    worker: { killed: false }, workerGeneration: 4,
    managedTurnOrigin: { capability: CAP, turnId: 'om_turn', callerOpenId: 'ou_sender' },
  };
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 'auth-session' ? session : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-secret', triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } } } as any);
  vi.spyOn(identities, 'getIdentity').mockReturnValue(undefined);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue(undefined);
  vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({
    authUrl: 'https://x', scopes: ['im:chat:read'], expiresIn: 600, poll: vi.fn(),
  } as any);
  debugLines = [];
  vi.spyOn(logger, 'debug').mockImplementation((msg: string) => { debugLines.push(msg); });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await ipc.close();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

function post(overrides: Record<string, unknown> = {}) {
  const path = '/api/sessions/auth-session/auth-request';
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scopes: ['im:chat:read'], originCapability: CAP, originTurnId: 'om_turn', ...overrides }),
  });
}
const diags = () => debugLines.filter(l => l.startsWith('[attest-diag]'));

describe('auth-request handler emits attestation diagnostics', () => {
  it('records tuple_mismatch (proofMode=tuple) when the presented tuple is stale, verdict still 403', async () => {
    const res = await post({ originTurnId: 'om_earlier' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'current_actor_unverified' });
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('route=auth-request');
    expect(d[0]).toContain('proofMode=tuple');
    expect(d[0]).toContain('reason=tuple_mismatch');
    expect(d[0]).toContain('session=auth-session');
    expect(d[0]).toContain('turn=om_turn');
  });

  it('records origin_incomplete when the live turn has no human caller, verdict still 403', async () => {
    delete session.managedTurnOrigin.callerOpenId;
    const res = await post();
    expect(res.status).toBe(403);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('reason=origin_incomplete');
    // proofMode still reflects that a tuple was presented in the body
    expect(d[0]).toContain('proofMode=tuple');
  });

  it('records identity_unresolved_or_non_user when the caller resolves to non-user, verdict still 403', async () => {
    // tuple matches, origin complete, trigger enabled -> reaches identity gate
    vi.mocked(identities.resolveVerifiedUserIdentity).mockResolvedValue(undefined);
    vi.mocked(identities.getIdentity).mockReturnValue(undefined);
    const res = await post();
    expect(res.status).toBe(403);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('reason=identity_unresolved_or_non_user');
  });

  it('emits no diagnostic on a fully valid request (verdict 200)', async () => {
    vi.mocked(identities.getIdentity).mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender', updatedAt: 0 } as any);
    const res = await post();
    expect(res.status).toBe(200);
    // a granted request logs no rejection record
    expect(diags()).toHaveLength(0);
  });

  it('freezes turn=A and records observedTurn=B when the live turn rotates during identity await (repro #2)', async () => {
    // valid start on turn A; the identity lookup rotates the live session to B
    vi.mocked(identities.getIdentity).mockReturnValue(undefined);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockImplementation(async () => {
      session.managedTurnOrigin = { capability: 'cd'.repeat(32), turnId: 'om_turn_B', callerOpenId: 'ou_other' };
      return undefined;
    });
    const res = await post();
    expect(res.status).toBe(403);
    const d = diags();
    expect(d).toHaveLength(1);
    // the record is attributed to the turn the request STARTED on, not the rotated one
    expect(d[0]).toContain('turn=om_turn');
    expect(d[0]).not.toContain('turn=om_turn_B');
    // and the observed live rotation is recorded separately
    expect(d[0]).toContain('observedTurn=om_turn_B');
    expect(d[0]).toContain('reason=turn_changed_during_await');
  });

  it('records turn_changed_during_await on auth-status when the turn rotates after poll (repro #1)', async () => {
    vi.mocked(identities.getIdentity).mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender', updatedAt: 0 } as any);
    // poll rotates the live session so isCurrent() goes false after the await
    const poll = vi.fn().mockImplementation(async () => {
      session.managedTurnOrigin = { capability: 'cd'.repeat(32), turnId: 'om_turn_B', callerOpenId: 'ou_other' };
      return { status: 'pending' };
    });
    vi.mocked(tokens.requestUserAuthorization).mockResolvedValue({ authUrl: 'https://x', scopes: ['im:chat:read'], expiresIn: 600, poll } as any);
    const created = await post();
    expect(created.status).toBe(200);
    const { requestId } = await created.json() as any;
    debugLines.length = 0;
    const statusRes = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/auth-session/auth-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, originCapability: CAP, originTurnId: 'om_turn' }),
    });
    expect(statusRes.status).toBe(409);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('route=auth-status');
    expect(d[0]).toContain('reason=turn_changed_during_await');
    expect(d[0]).toContain('turn=om_turn');
    expect(d[0]).toContain('observedTurn=om_turn_B');
  });

  it('records identity_refresh_failed on auth-status when the identity file refresh fails (repro #1)', async () => {
    // First register a request via a valid auth-request, then poll auth-status.
    vi.mocked(identities.getIdentity).mockReturnValue({ openId: 'ou_sender', type: 'user', source: 'sender', updatedAt: 0 } as any);
    const poll = vi.fn().mockResolvedValue({ status: 'ready', token: 'tkn' });
    vi.mocked(tokens.requestUserAuthorization).mockResolvedValue({ authUrl: 'https://x', scopes: ['im:chat:read'], expiresIn: 600, poll } as any);
    const cliIdentity = await import('../src/core/cli-identity.js');
    vi.spyOn(cliIdentity, 'refreshSessionIdentity').mockReturnValue(false);
    const created = await post();
    expect(created.status).toBe(200);
    const { requestId } = await created.json() as any;
    debugLines.length = 0;
    const statusRes = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/auth-session/auth-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, originCapability: CAP, originTurnId: 'om_turn' }),
    });
    expect(statusRes.status).toBe(409);
    expect(await statusRes.json()).toEqual({ ok: false, error: 'auth_turn_changed' });
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0]).toContain('route=auth-status');
    expect(d[0]).toContain('reason=identity_refresh_failed');
  });
});
