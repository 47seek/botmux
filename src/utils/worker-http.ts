import type { IncomingMessage } from 'node:http';

type EnvLike = Partial<Record<string, string | undefined>>;

export function resolveWorkerHttpHost(env: EnvLike = process.env): string {
  const raw = env.BOTMUX_WORKER_HTTP_HOST ?? env.BOTMUX_WORKER_HOST;
  const host = raw?.trim();
  return host || '127.0.0.1';
}

export function parseWorkerRequestUrl(req: Pick<IncomingMessage, 'url' | 'headers'>): URL | null {
  const host = typeof req.headers.host === 'string' && req.headers.host.trim()
    ? req.headers.host.trim()
    : 'localhost';
  try {
    return new URL(req.url ?? '/', `http://${host}`);
  } catch {
    return null;
  }
}
