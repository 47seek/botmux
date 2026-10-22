import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldAttachments, DEFAULT_ATTACHMENT_MAX_AGE_MS } from '../src/core/attachment-prune.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bm-att-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function msgDir(app: string, msg: string, ageMs: number): string {
  const d = join(root, app, msg);
  mkdirSync(d, { recursive: true });
  const f = join(d, 'image.png');
  writeFileSync(f, 'x');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(d, t, t);
  utimesSync(f, t, t);
  return d;
}

describe('pruneOldAttachments', () => {
  it('removes message dirs older than max age, keeps recent ones and app buckets', () => {
    const old = msgDir('cli_a', 'msg-old', 30 * 24 * 3600_000);
    const recent = msgDir('cli_a', 'msg-new', 1 * 24 * 3600_000);
    const other = msgDir('cli_b', 'msg-old2', 30 * 24 * 3600_000);

    const r = pruneOldAttachments(root, 14 * 24 * 3600_000);
    expect(r.removedDirs).toBe(2);
    expect(r.appBuckets).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(join(root, 'cli_a'))).toBe(true);
    expect(existsSync(join(root, 'cli_b'))).toBe(true); // 空 app 桶保留
  });

  it('removes nothing when all within age', () => {
    msgDir('cli_a', 'm1', 60_000);
    expect(pruneOldAttachments(root, 14 * 24 * 3600_000).removedDirs).toBe(0);
  });

  it('returns 0 for a missing root', () => {
    expect(pruneOldAttachments(join(root, 'nope')).removedDirs).toBe(0);
  });

  it('default max age is a positive multi-day window', () => {
    expect(DEFAULT_ATTACHMENT_MAX_AGE_MS).toBeGreaterThanOrEqual(7 * 24 * 3600_000);
  });
});
