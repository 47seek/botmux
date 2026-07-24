/**
 * TRAE CLI (traex) hook adapter。
 *
 * traex 是 Codex 血统的内部版 CLI，但与 codex.ts 不同：本版本（0.200.x）**有**
 * 结构化的交互工具 `request_user_input`（提示词里叫 AskUserQuestion，实际落到
 * 该工具），并通过 Claude 兼容的 PreToolUse hook 在工具执行前触发。因此本 adapter
 * 走「结构化解析 + stdout directive 回填」路线（与 claude-code.ts 同构），而不是
 * codex.ts 的「恒返回 null」。
 *
 * PreToolUse payload 形状（tool_input 即 request_user_input 的入参
 * ToolRequestUserInputParams，见 `traex app-server generate-json-schema`）：
 *   {
 *     hook_event_name: 'PreToolUse',
 *     tool_name: 'request_user_input',
 *     tool_input: {
 *       questions: [
 *         {
 *           id: '<问题稳定 id>',
 *           header: '<短标签>',
 *           question: '<问题正文>',
 *           multiSelect?: boolean,          // 默认 false
 *           options?: [                     // 可为 null（纯自由文本问题）
 *             { label: '<按钮文本>', description: '<说明>', preview?: string|null }
 *           ]
 *         }
 *       ],
 *       itemId, threadId, turnId, isBlocking
 *     }
 *   }
 *
 * traex 期望的 answer directive（Claude 兼容的 hookSpecificOutput）：
 *   {
 *     hookSpecificOutput: {
 *       hookEventName: 'PreToolUse',
 *       permissionDecision: 'allow',
 *       updatedInput: {
 *         questions: <原始 questions 数组>,
 *         // 答案按 request_user_input 的响应形状（ToolRequestUserInputResponse）
 *         // 键为 question.id，值为 { answers: [选中的 label, ...] }。
 *         answers: { '<questionId>': { answers: ['label1', ...] }, ... }
 *       }
 *     }
 *   }
 * 二进制核实：PreToolUse 的 updatedInput 必须搭配 permissionDecision:'allow'
 * （"PreToolUse hook returned updatedInput without permissionDecision:allow" 报错）；
 * hookSpecificOutput 支持的字段含 permissionDecision / updatedInput / message /
 * interrupt / additionalContext。
 *
 * 来源：traex 0.200.19 二进制导出的 JSON Schema
 *   ToolRequestUserInputParams / ToolRequestUserInputResponse，
 *   以及 hooks 子系统的 PreToolUseHookSpecificOutputWire 契约。
 */

import type { AskQuestion } from '../ask-types.js';
import type { HookAskAdapter, ParsedAsk } from './types.js';

/** request_user_input 的工具名（提示词层叫 AskUserQuestion，实际工具名是这个）。 */
const TOOL_NAME = 'request_user_input';

/** 从 payload 中提取原始 questions 数组（用于写回 updatedInput.questions）。 */
function extractRawQuestions(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const toolInput = p.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return [];
  const ti = toolInput as Record<string, unknown>;
  const qs = ti.questions;
  if (!Array.isArray(qs)) return [];
  return qs as Array<Record<string, unknown>>;
}

/** 稳定 key：优先用 question.id；缺失时回落到序号，保证 formatAnswer 能重建答案键。 */
function questionKey(q: Record<string, unknown>, index: number): string {
  return typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${index}`;
}

const traexAdapter: HookAskAdapter = {
  parseQuestions(payload: unknown): ParsedAsk | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;

    // 仅处理 PreToolUse + request_user_input。PermissionRequest 保留为兼容入口。
    if (p.hook_event_name !== 'PreToolUse' && p.hook_event_name !== 'PermissionRequest') return null;
    if (p.tool_name !== TOOL_NAME) return null;

    const rawQuestions = extractRawQuestions(payload);
    if (rawQuestions.length === 0) return null;

    const questions: AskQuestion[] = rawQuestions.map((q) => {
      const qText = typeof q.question === 'string' ? q.question : String(q.question ?? '');
      const multiSelect = !!q.multiSelect;
      const rawOpts = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [];
      const options = rawOpts.map((opt) => {
        const label = typeof opt.label === 'string' ? opt.label : String(opt.label ?? '');
        // request_user_input 的 option 没有独立 key，用 label 作为 key（与 claude 一致）。
        return { key: label, label };
      });
      return { prompt: qText, options, multiSelect };
    });

    // 纯自由文本问题（options 为 null/空）在 ask 卡上无按钮，只能靠话题内打字作答；
    // 至少要有一个可解析问题才接管，否则放行让 traex 走原生 TUI 提问。
    if (questions.length === 0) return null;

    return { questions, raw: payload };
  },

  formatAnswer(
    answersByQuestion: ReadonlyArray<ReadonlyArray<string>>,
    parsed: ParsedAsk,
    comment?: string | null,
  ): string {
    const rawQuestions = extractRawQuestions(parsed.raw);
    const eventName = hookEventName(parsed.raw);
    const customText = (comment ?? '').trim();

    // updatedInput.answers：键为 question.id，值为 { answers: [label, ...] }
    // （request_user_input 的 ToolRequestUserInputResponse 形状）。
    // 缺席（无选中且无自定义文本）的问题不写键。
    const answers: Record<string, { answers: string[] }> = {};
    parsed.questions.forEach((q, i) => {
      const key = questionKey(rawQuestions[i] ?? {}, i);
      const selectedKeys = answersByQuestion[i];
      if (selectedKeys && selectedKeys.length > 0) {
        // key 即 label（parseQuestions 里 key=label），直接作为答案值。
        answers[key] = { answers: [...selectedKeys] };
      } else if (customText) {
        // 自定义回复（替代语义）：该问无选中项 → 回落到用户在话题里打的自由文本。
        answers[key] = { answers: [customText] };
      }
    });

    const directive = buildAllowDirective(eventName, rawQuestions, answers);
    return JSON.stringify(directive);
  },

  passthrough(_payload: unknown): string {
    // 真放行：空 stdout（+ exit 0）。traex 无 hook decision 时工具照常执行，
    // request_user_input 在终端原生提问。
    // 绝不能输出 allow + updatedInput：那会用空答案顶替本次提问（非 botmux 会话 /
    // daemon 不可达时尤其有害）。
    return '';
  },
};

function hookEventName(payload: unknown): 'PreToolUse' | 'PermissionRequest' {
  if (payload && typeof payload === 'object') {
    const eventName = (payload as Record<string, unknown>).hook_event_name;
    if (eventName === 'PermissionRequest') return 'PermissionRequest';
  }
  return 'PreToolUse';
}

function buildAllowDirective(
  eventName: 'PreToolUse' | 'PermissionRequest',
  questions: Array<Record<string, unknown>>,
  answers: Record<string, { answers: string[] }>,
): Record<string, unknown> {
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: { questions, answers },
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  };
}

export default traexAdapter;
