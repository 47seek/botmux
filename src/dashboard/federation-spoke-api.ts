/**
 * Federation SPOKE endpoints, mounted INSIDE the dashboard's token gate (these
 * are owner actions — the dashboard token already proves the owner). The spoke
 * makes OUTBOUND calls to a hub; it never needs to expose anything inbound.
 *   - POST /api/team/join-remote   { hubUrl, inviteCode }
 *   - GET  /api/team/remote-roster
 *   - POST /api/team/sync-remote
 *   - POST /api/team/leave-remote  { hubUrl, teamId }
 *
 * The long-lived syncToken is sent in the `Authorization: Bearer` header (never
 * in a URL, so it stays out of access/proxy logs). All hub calls have a timeout.
 * See docs/federation-design.md.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { jsonRes } from './workflow-api.js';
import { buildTeamRoster } from '../services/team-roster.js';
import { getDeploymentIdentity } from '../services/deployment-identity.js';
import { addMembership, listMemberships, removeMembership } from '../services/federation-membership-store.js';
import type { FederatedBot } from '../services/federation-store.js';

const HUB_TIMEOUT_MS = 8000;

/** Thrown by fetchWithTimeout when the hub doesn't answer in time. */
class HubTimeout extends Error { constructor() { super('hub_timeout'); this.name = 'HubTimeout'; } }

type Fetcher = typeof fetch;

/** Wrap a hub call with an abort timeout; surface a distinguishable timeout. */
async function fetchWithTimeout(fetcher: Fetcher, url: string, init: RequestInit = {}, ms = HUB_TIMEOUT_MS): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetcher(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === 'AbortError' || e instanceof HubTimeout) throw new HubTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Map an outbound hub-call failure to a stable {status, error}. */
function hubError(e: unknown): { status: number; error: string } {
  return e instanceof HubTimeout ? { status: 504, error: 'hub_timeout' } : { status: 502, error: 'hub_unreachable' };
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/** Normalize a hub base URL (strip trailing slash); only http/https allowed. */
function normalizeHubUrl(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(s)) return null;
  return s;
}

/** This deployment's bots, in the shape the hub federates (bots.json order). */
function localBots(dataDir: string): FederatedBot[] {
  return buildTeamRoster(dataDir).bots.map(b => ({
    larkAppId: b.larkAppId,
    botName: b.name,
    cliId: b.cliId,
    capability: b.capability,
    hasTeamRole: b.hasTeamRole,
    // botUnionId: resolved in P2 (needed for cross-app 拉群), best-effort/omitted now
  }));
}

/** Push this deployment's current bots to every joined hub. Best-effort. */
export async function syncAllMemberships(dataDir: string, fetcher: Fetcher = fetch): Promise<{ synced: number; failed: number }> {
  const bots = localBots(dataDir);
  let synced = 0, failed = 0;
  for (const m of listMemberships(dataDir)) {
    try {
      const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
        body: JSON.stringify({ syncToken: m.syncToken, bots }),
      });
      if (r.ok) synced++; else failed++;
    } catch { failed++; }
  }
  return { synced, failed };
}

export interface FederationSpokeDeps {
  dataDir?: string;
  fetcher?: Fetcher;
}

export async function handleFederationSpokeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FederationSpokeDeps = {},
): Promise<boolean> {
  const path = url.pathname;
  if (path !== '/api/team/join-remote' && path !== '/api/team/remote-roster'
    && path !== '/api/team/sync-remote' && path !== '/api/team/leave-remote') return false;
  const dataDir = deps.dataDir ?? config.session.dataDir;
  const fetcher = deps.fetcher ?? fetch;
  const method = req.method ?? 'GET';

  // Accept an invite from another deployment's hub: register our bots there.
  if (path === '/api/team/join-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const inviteCode = String(body?.inviteCode ?? '').trim();
    if (!hubUrl) { jsonRes(res, 400, { ok: false, error: 'bad_hub_url' }); return true; }
    if (!inviteCode) { jsonRes(res, 400, { ok: false, error: 'code_required' }); return true; }
    const me = getDeploymentIdentity(dataDir);
    let hubRes: Response;
    try {
      hubRes = await fetchWithTimeout(fetcher, `${hubUrl}/api/federation/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inviteCode, deployment: { deploymentId: me.deploymentId, name: me.name, bots: localBots(dataDir) } }),
      });
    } catch (e) {
      const he = hubError(e);
      jsonRes(res, he.status, { ok: false, error: he.error });
      return true;
    }
    const j = await hubRes.json().catch(() => ({} as any));
    if (!hubRes.ok || !j?.ok) {
      const status = hubRes.status === 403 || hubRes.status === 409 ? hubRes.status : 502;
      jsonRes(res, status, { ok: false, error: j?.error || `hub_${hubRes.status}` });
      return true;
    }
    addMembership(dataDir, { hubUrl, teamId: j.teamId, teamName: j.teamName, syncToken: j.syncToken, deploymentId: me.deploymentId });
    jsonRes(res, 200, { ok: true, hubUrl, teamId: j.teamId, teamName: j.teamName });
    return true;
  }

  // Pull each joined hub's aggregated roster for display (token in header).
  if (path === '/api/team/remote-roster' && method === 'GET') {
    const out: any[] = [];
    for (const m of listMemberships(dataDir)) {
      try {
        const r = await fetchWithTimeout(fetcher, `${m.hubUrl}/api/federation/roster`, {
          headers: { authorization: `Bearer ${m.syncToken}` },
        });
        const j = await r.json().catch(() => ({} as any));
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: r.ok && j?.ok, roster: j?.ok ? { deployments: j.deployments, bots: j.bots, team: j.team } : null, error: j?.error });
      } catch (e) {
        out.push({ hubUrl: m.hubUrl, teamId: m.teamId, teamName: m.teamName, ok: false, roster: null, error: hubError(e).error });
      }
    }
    jsonRes(res, 200, { ok: true, memberships: out });
    return true;
  }

  // Manually push bots + heartbeat to all joined hubs.
  if (path === '/api/team/sync-remote' && method === 'POST') {
    const r = await syncAllMemberships(dataDir, fetcher);
    jsonRes(res, 200, { ok: true, ...r });
    return true;
  }

  // Leave a remote team: best-effort revoke at the hub (so it drops our
  // deployment + token + stale bots), then forget the membership locally.
  if (path === '/api/team/leave-remote' && method === 'POST') {
    let body: any;
    try { body = await readBody(req); } catch { jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const hubUrl = normalizeHubUrl(body?.hubUrl);
    const teamId = String(body?.teamId ?? '').trim();
    if (!hubUrl || !teamId) { jsonRes(res, 400, { ok: false, error: 'bad_request' }); return true; }
    const m = listMemberships(dataDir).find(x => x.hubUrl === hubUrl && x.teamId === teamId);
    let hubRevoked = false;
    if (m) {
      try {
        const r = await fetchWithTimeout(fetcher, `${hubUrl}/api/federation/leave`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${m.syncToken}` },
          body: JSON.stringify({ syncToken: m.syncToken }),
        });
        hubRevoked = r.ok;
      } catch { /* hub unreachable — still forget locally below */ }
    }
    const removed = removeMembership(dataDir, hubUrl, teamId);
    jsonRes(res, removed ? 200 : 404, { ok: removed, hubRevoked });
    return true;
  }

  return false;
}
