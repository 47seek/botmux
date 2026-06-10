/**
 * Usage ledger tests — per-turn token usage deltas appended to daily JSONL.
 *
 * The ledger is the durable contract consumed by external trackers (kaboo):
 * each record is a self-describing JSON line with positive token deltas and
 * cumulative snapshots for self-validation.
 *
 * Run:  pnpm vitest run test/usage-ledger.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/core/cost-calculator.js', () => ({
  getSessionTokenUsage: vi.fn(() => null),
}));

import { getSessionTokenUsage } from '../src/core/cost-calculator.js';
import {
  recordSessionUsage,
  anchorSessionUsage,
  recordUsageForDaemonSession,
  anchorUsageForDaemonSession,
  type UsageLedgerRecord,
} from '../src/services/usage-ledger.js';
import type { SessionTokenUsage } from '../src/core/cost-calculator.js';

function cumulative(input: number, output: number, cacheRead = 0, cacheCreate = 0, model = 'claude-opus-4-7'): SessionTokenUsage {
  return {
    in: input + cacheRead + cacheCreate,
    out: output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheCreate,
    model,
    turns: 1,
  };
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    larkAppId: 'cli_app',
    sessionId: 'sess-1',
    cliId: 'claude-code',
    cliSessionId: 'cli-sess-1',
    chatId: 'oc_chat',
    title: '修复支付回调',
    workingDir: '/repo',
    callerOpenId: 'ou_caller',
    now: new Date('2026-06-10T12:00:00Z'),
    ...overrides,
  };
}

function ledgerLines(dir: string, date = '2026-06-10'): UsageLedgerRecord[] {
  const content = readFileSync(join(dir, `usage-${date}.jsonl`), 'utf8');
  return content.trim().split('\n').map((l) => JSON.parse(l));
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recordSessionUsage', () => {
  it('writes the first record with the full cumulative usage as delta', () => {
    const rec = recordSessionUsage({
      ...baseArgs(),
      ledgerDir: dir,
      usage: cumulative(100, 10, 5, 2),
    });

    expect(rec).toMatchObject({
      v: 1,
      larkAppId: 'cli_app',
      sessionId: 'sess-1',
      cliId: 'claude-code',
      cliSessionId: 'cli-sess-1',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/repo',
      callerOpenId: 'ou_caller',
      model: 'claude-opus-4-7',
      ts: '2026-06-10T12:00:00.000Z',
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreateTokens: 2,
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCacheReadTokens: 5,
      totalCacheCreateTokens: 2,
    });
    expect(rec!.recordId).toMatch(/[0-9a-f-]{36}/);

    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual(rec);
  });

  it('emits only the positive delta on subsequent records', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-10T12:05:00Z'), callerOpenId: 'ou_other' }),
      ledgerDir: dir,
      usage: cumulative(250, 30),
    });

    expect(rec).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      totalInputTokens: 250,
      totalOutputTokens: 30,
      callerOpenId: 'ou_other',
    });
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it('returns null and appends nothing when usage is unchanged', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    expect(rec).toBeNull();
    expect(ledgerLines(dir)).toHaveLength(1);
  });

  it('resets the baseline without a record when cumulative usage shrinks', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    // /clear or transcript rotation: cumulative drops — no negative record.
    const shrunk = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(40, 5) });
    expect(shrunk).toBeNull();

    // Growth from the new baseline is measured against 40/5, not 100/10.
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(90, 15) });
    expect(rec).toMatchObject({ inputTokens: 50, outputTokens: 10 });
    expect(ledgerLines(dir)).toHaveLength(2);
  });

  it('tracks sessions independently', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const rec = recordSessionUsage({
      ...baseArgs({ sessionId: 'sess-2', cliSessionId: 'cli-sess-2' }),
      ledgerDir: dir,
      usage: cumulative(7, 3),
    });

    expect(rec).toMatchObject({ sessionId: 'sess-2', inputTokens: 7, outputTokens: 3 });
  });

  it('rotates ledger files by UTC date', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    recordSessionUsage({
      ...baseArgs({ now: new Date('2026-06-11T01:00:00Z') }),
      ledgerDir: dir,
      usage: cumulative(250, 30),
    });

    expect(ledgerLines(dir, '2026-06-10')).toHaveLength(1);
    expect(ledgerLines(dir, '2026-06-11')).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-')).sort()).toEqual([
      'usage-2026-06-10.jsonl',
      'usage-2026-06-11.jsonl',
    ]);
  });

  it('assigns a unique recordId per record', () => {
    const a = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    const b = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(200, 20) });
    expect(a!.recordId).not.toBe(b!.recordId);
  });
});

describe('anchorSessionUsage', () => {
  it('sets the baseline without writing a record', () => {
    anchorSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });

    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);

    // Growth is measured from the anchored baseline, not from zero.
    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(250, 30) });
    expect(rec).toMatchObject({ inputTokens: 150, outputTokens: 20 });
  });

  it('overwrites an existing baseline (resume re-anchor)', () => {
    recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(100, 10) });
    // Transcript grew outside botmux (e.g. direct tmux use while daemon was
    // down) — re-anchoring on spawn keeps that growth out of the ledger.
    anchorSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(180, 25) });

    const rec = recordSessionUsage({ ...baseArgs(), ledgerDir: dir, usage: cumulative(200, 30) });
    expect(rec).toMatchObject({ inputTokens: 20, outputTokens: 5 });
    expect(ledgerLines(dir)).toHaveLength(2);
  });
});

describe('daemon-session wrappers', () => {
  const ds = {
    larkAppId: 'cli_app',
    workingDir: '/live-repo',
    session: {
      sessionId: 'sess-1',
      cliId: 'claude-code',
      cliSessionId: 'cli-sess-1',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/stored-repo',
      lastCallerOpenId: 'ou_last',
      creatorOpenId: 'ou_creator',
    },
  } as any;

  beforeEach(() => {
    vi.mocked(getSessionTokenUsage).mockReset();
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);
  });

  it('snapshots the transcript and appends the delta record', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(100, 10));

    const rec = recordUsageForDaemonSession(ds, { ledgerDir: dir, now: new Date('2026-06-10T12:00:00Z') });

    expect(getSessionTokenUsage).toHaveBeenCalledWith({
      cliId: 'claude-code',
      sessionId: 'sess-1',
      cliSessionId: 'cli-sess-1',
      cwd: '/live-repo',
      fresh: true,
    });
    expect(rec).toMatchObject({
      sessionId: 'sess-1',
      larkAppId: 'cli_app',
      cliId: 'claude-code',
      chatId: 'oc_chat',
      title: '修复支付回调',
      workingDir: '/live-repo',
      callerOpenId: 'ou_last',
      inputTokens: 100,
      outputTokens: 10,
    });
  });

  it('does nothing when the transcript has no usage', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(null);

    expect(recordUsageForDaemonSession(ds, { ledgerDir: dir })).toBeNull();
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);
  });

  it('anchorUsageForDaemonSession anchors without recording', () => {
    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(500, 50));
    anchorUsageForDaemonSession(ds, { ledgerDir: dir });
    expect(readdirSync(dir).filter((f) => f.startsWith('usage-'))).toHaveLength(0);

    vi.mocked(getSessionTokenUsage).mockReturnValue(cumulative(620, 80));
    const rec = recordUsageForDaemonSession(ds, { ledgerDir: dir });
    expect(rec).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });
});
