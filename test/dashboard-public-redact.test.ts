import { describe, it, expect } from 'vitest';
import { redactGroupsForPublic, redactSchedulesForPublic } from '../src/dashboard/public-redact.js';

// A representative slice of the /api/groups `chats` payload that dashboard.ts
// builds (memberBots[].oncallChat = { chatId, workingDir } for bound bots).
function sampleChats() {
  return [
    {
      chatId: 'oc_chat1',
      name: '客户群 A',
      chatMode: 'group',
      memberBots: [
        {
          larkAppId: 'cli_a',
          botName: 'Claude',
          inChat: true,
          hasRole: true,
          oncallChat: { chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' },
        },
        {
          larkAppId: 'cli_b',
          botName: 'Codex',
          inChat: false,
          hasRole: false,
          oncallChat: null,
        },
      ],
    },
  ];
}

function sampleSchedules() {
  return [
    {
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      prompt: '部署到 /root/iserver/customer-secret 并通知客户',
      workingDir: '/root/iserver/customer-secret',
      chatId: 'oc_chat1',
    },
  ];
}

describe('redactGroupsForPublic', () => {
  it('strips memberBots[].oncallChat (workingDir) for anonymous visitors', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    for (const mb of out[0].memberBots) expect(mb.oncallChat).toBeNull();
    expect(JSON.stringify(out)).not.toContain('workingDir');
    expect(JSON.stringify(out)).not.toContain('customer-secret');
  });

  it('preserves the fields the board name-map / matrix needs', () => {
    const out = redactGroupsForPublic(sampleChats()) as any[];
    expect(out[0]).toMatchObject({ chatId: 'oc_chat1', name: '客户群 A', chatMode: 'group' });
    expect(out[0].memberBots.map((m: any) => ({ larkAppId: m.larkAppId, botName: m.botName, inChat: m.inChat, hasRole: m.hasRole })))
      .toEqual([
        { larkAppId: 'cli_a', botName: 'Claude', inChat: true, hasRole: true },
        { larkAppId: 'cli_b', botName: 'Codex', inChat: false, hasRole: false },
      ]);
  });

  it('does not mutate the input (authed callers keep the original oncallChat)', () => {
    const input = sampleChats();
    redactGroupsForPublic(input);
    expect(input[0].memberBots[0].oncallChat).toEqual({ chatId: 'oc_chat1', workingDir: '/root/iserver/customer-secret' });
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactGroupsForPublic([])).toEqual([]);
    expect(redactGroupsForPublic([{ chatId: 'x' }] as unknown[])).toEqual([{ chatId: 'x' }]);
    expect(redactGroupsForPublic([{ memberBots: 'nope' }] as unknown[])).toEqual([{ memberBots: 'nope' }]);
    expect(redactGroupsForPublic(null as unknown as unknown[])).toBeNull();
  });
});

describe('redactSchedulesForPublic', () => {
  it('strips prompt + workingDir for anonymous visitors', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).not.toHaveProperty('prompt');
    expect(out[0]).not.toHaveProperty('workingDir');
    expect(JSON.stringify(out)).not.toContain('customer-secret');
  });

  it('preserves name / timing / status fields', () => {
    const out = redactSchedulesForPublic(sampleSchedules()) as any[];
    expect(out[0]).toEqual({
      id: 'sch1',
      name: '每日构建',
      enabled: true,
      nextRunAt: '2026-06-07T01:00:00Z',
      lastStatus: 'ok',
      chatId: 'oc_chat1',
    });
  });

  it('does not mutate the input (authed callers keep prompt + workingDir)', () => {
    const input = sampleSchedules();
    redactSchedulesForPublic(input);
    expect(input[0]).toHaveProperty('prompt');
    expect(input[0].workingDir).toBe('/root/iserver/customer-secret');
  });

  it('tolerates malformed shapes without throwing', () => {
    expect(redactSchedulesForPublic([])).toEqual([]);
    expect(redactSchedulesForPublic([null] as unknown[])).toEqual([null]);
    expect(redactSchedulesForPublic(undefined as unknown as unknown[])).toBeUndefined();
  });
});
