import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import traex from '../src/core/ask-hook/traex.js';
import { getHookAdapter } from '../src/core/ask-hook/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  const p = join(__dirname, 'fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

describe('TRAE (traex) hook adapter', () => {
  describe('registry', () => {
    it("getHookAdapter('traex') 返回 traex adapter（不再 undefined）", () => {
      expect(getHookAdapter('traex')).toBe(traex);
    });
  });

  describe('parseQuestions', () => {
    it('PreToolUse + request_user_input → 解析出 questions', () => {
      const payload = loadFixture('traex-ask-single.json');
      const parsed = traex.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(1);
      expect(parsed!.questions[0].prompt).toBe('继续部署还是回滚？');
      expect(parsed!.questions[0].multiSelect).toBe(false);
      expect(parsed!.questions[0].options).toHaveLength(2);
      expect(parsed!.questions[0].options[0].key).toBe('继续部署');
      expect(parsed!.questions[0].options[0].label).toBe('继续部署');
      expect(parsed!.questions[0].options[1].key).toBe('回滚');
    });

    it('PermissionRequest + request_user_input → 迁移期兼容解析', () => {
      const payload = { ...(loadFixture('traex-ask-single.json') as any), hook_event_name: 'PermissionRequest' };
      const parsed = traex.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions[0].prompt).toBe('继续部署还是回滚？');
    });

    it('多问题 + multiSelect=true → 正确解析', () => {
      const payload = loadFixture('traex-ask-multi.json');
      const parsed = traex.parseQuestions(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.questions).toHaveLength(2);
      expect(parsed!.questions[0].prompt).toBe('选择测试环境？');
      expect(parsed!.questions[0].multiSelect).toBe(true);
      expect(parsed!.questions[0].options).toHaveLength(3);
      expect(parsed!.questions[1].prompt).toBe('通知方式？');
      expect(parsed!.questions[1].multiSelect).toBe(false);
    });

    it('option 的 key 等于 label', () => {
      const parsed = traex.parseQuestions(loadFixture('traex-ask-single.json'))!;
      for (const opt of parsed.questions[0].options) {
        expect(opt.key).toBe(opt.label);
      }
    });

    it('非 request_user_input → null（含 codex 的 AskUserQuestion 不误接）', () => {
      expect(traex.parseQuestions({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull();
      // 提示词里叫 AskUserQuestion，但实际工具名是 request_user_input；工具名不符不接管
      expect(traex.parseQuestions({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: '?', options: [] }] },
      })).toBeNull();
    });

    it('非 PreToolUse/PermissionRequest → null', () => {
      const payload = { ...(loadFixture('traex-ask-single.json') as any), hook_event_name: 'PostToolUse' };
      expect(traex.parseQuestions(payload)).toBeNull();
    });

    it('tool_input.questions 为空数组 → null', () => {
      const payload = {
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_input: { questions: [] },
      };
      expect(traex.parseQuestions(payload)).toBeNull();
    });

    it('null / undefined → null', () => {
      expect(traex.parseQuestions(null)).toBeNull();
      expect(traex.parseQuestions(undefined)).toBeNull();
    });

    it('raw 保存原始 payload', () => {
      const payload = loadFixture('traex-ask-single.json');
      const parsed = traex.parseQuestions(payload)!;
      expect(parsed.raw).toBe(payload);
    });
  });

  describe('formatAnswer', () => {
    it('单问单选 → PreToolUse.updatedInput.answers 键为 question.id、值为 { answers: [label] }', () => {
      const payload = loadFixture('traex-ask-single.json');
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['继续部署']], parsed)) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      expect(hso.hookEventName).toBe('PreToolUse');
      expect(hso.permissionDecision).toBe('allow');
      const updatedInput = hso.updatedInput as Record<string, unknown>;
      expect(updatedInput.answers).toEqual({ q_env: { answers: ['继续部署'] } });
    });

    it('PermissionRequest payload → 走 decision.behavior=allow 形状', () => {
      const payload = { ...(loadFixture('traex-ask-single.json') as any), hook_event_name: 'PermissionRequest' };
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['继续部署']], parsed)) as Record<string, unknown>;
      const hso = directive.hookSpecificOutput as Record<string, unknown>;
      expect(hso.hookEventName).toBe('PermissionRequest');
      const decision = hso.decision as Record<string, unknown>;
      expect(decision.behavior).toBe('allow');
      const updatedInput = decision.updatedInput as Record<string, unknown>;
      expect(updatedInput.answers).toEqual({ q_env: { answers: ['继续部署'] } });
    });

    it('多选 → answers[id].answers 保留全部选中 label（数组，不拼字符串）', () => {
      const payload = loadFixture('traex-ask-multi.json');
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['staging', 'canary'], ['飞书']], parsed)) as Record<string, unknown>;
      const answers = (directive.hookSpecificOutput as any).updatedInput.answers as Record<string, { answers: string[] }>;
      expect(answers.q_test_env.answers).toEqual(['staging', 'canary']);
      expect(answers.q_notify.answers).toEqual(['飞书']);
    });

    it('未答的 question → answers 不含该 key', () => {
      const payload = loadFixture('traex-ask-multi.json');
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['staging'], []], parsed)) as Record<string, unknown>;
      const answers = (directive.hookSpecificOutput as any).updatedInput.answers as Record<string, unknown>;
      expect('q_test_env' in answers).toBe(true);
      expect('q_notify' in answers).toBe(false);
    });

    it('updatedInput.questions 回传原始 questions 数组', () => {
      const payload = loadFixture('traex-ask-single.json') as any;
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['继续部署']], parsed)) as Record<string, unknown>;
      const updatedInput = (directive.hookSpecificOutput as any).updatedInput as Record<string, unknown>;
      expect(updatedInput.questions).toEqual(payload.tool_input.questions);
    });

    it('输出为合法 JSON 字符串', () => {
      const parsed = traex.parseQuestions(loadFixture('traex-ask-single.json'))!;
      expect(() => JSON.parse(traex.formatAnswer([['继续部署']], parsed))).not.toThrow();
    });
  });

  describe('formatAnswer 自定义回复（comment）', () => {
    it('单问无选中 + comment → answers[id] = { answers: [自定义文字] }', () => {
      const payload = loadFixture('traex-ask-single.json');
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([[]], parsed, '我想先灰度 10% 再决定')) as Record<string, unknown>;
      const answers = (directive.hookSpecificOutput as any).updatedInput.answers as Record<string, { answers: string[] }>;
      expect(answers.q_env.answers).toEqual(['我想先灰度 10% 再决定']);
    });

    it('多问 + comment：未选中的问题用 comment，已选中的用 label', () => {
      const payload = loadFixture('traex-ask-multi.json');
      const parsed = traex.parseQuestions(payload)!;
      const directive = JSON.parse(traex.formatAnswer([['staging'], []], parsed, '我自己决定通知方式')) as Record<string, unknown>;
      const answers = (directive.hookSpecificOutput as any).updatedInput.answers as Record<string, { answers: string[] }>;
      expect(answers.q_test_env.answers).toEqual(['staging']);
      expect(answers.q_notify.answers).toEqual(['我自己决定通知方式']);
    });
  });

  describe('passthrough（真放行 = 空 stdout）', () => {
    it('非 request_user_input 事件 → 空字符串', () => {
      const payload = { ...(loadFixture('traex-ask-single.json') as any), tool_name: 'Bash' };
      expect(traex.passthrough(payload)).toBe('');
    });

    it('request_user_input 原始 payload → 仍是空字符串，不含 updatedInput/allow', () => {
      const out = traex.passthrough(loadFixture('traex-ask-single.json'));
      expect(out).toBe('');
      expect(out).not.toContain('updatedInput');
      expect(out).not.toContain('allow');
    });
  });
});
