import { describe, it, expect } from 'vitest';
import { resolveQuoteTarget, validateMentionDecision } from '../src/services/send-policy.js';

describe('resolveQuoteTarget', () => {
  const base = { isChatScope: true, sendTopLevel: false, noQuote: false };

  it('chat scope defaults to session quote target', () => {
    expect(resolveQuoteTarget({ ...base, sessionQuoteTargetId: 'om_a' })).toBe('om_a');
  });

  it('--quote overrides session target', () => {
    expect(resolveQuoteTarget({ ...base, explicitQuote: 'om_b', sessionQuoteTargetId: 'om_a' })).toBe('om_b');
  });

  it('--no-quote forces plain send', () => {
    expect(resolveQuoteTarget({ ...base, noQuote: true, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });

  it('no target available → plain send', () => {
    expect(resolveQuoteTarget({ ...base })).toBeNull();
    expect(resolveQuoteTarget({ ...base, sessionQuoteTargetId: '  ' })).toBeNull();
  });

  it('thread scope never quotes', () => {
    expect(resolveQuoteTarget({ ...base, isChatScope: false, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });

  it('--top-level never quotes', () => {
    expect(resolveQuoteTarget({ ...base, sendTopLevel: true, sessionQuoteTargetId: 'om_a' })).toBeNull();
  });
});

describe('validateMentionDecision', () => {
  const base = {
    enabled: true,
    sendTopLevel: false,
    hasMentionArgs: false,
    mentionBack: false,
    noMention: false,
    hasQuoteTargetSender: true,
    quoteTargetSenderIsBot: false,
  };

  it('passes when --mention given', () => {
    expect(validateMentionDecision({ ...base, hasMentionArgs: true }).ok).toBe(true);
  });

  it('passes when --mention-back given (with sender)', () => {
    expect(validateMentionDecision({ ...base, mentionBack: true }).ok).toBe(true);
  });

  it('passes when --no-mention given', () => {
    expect(validateMentionDecision({ ...base, noMention: true }).ok).toBe(true);
  });

  it('fails (no decision) replying to a human with human-specific hint', () => {
    const r = validateMentionDecision({ ...base, quoteTargetSenderIsBot: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('回复人必须 @');
  });

  it('fails (no decision) replying to a bot with bot-specific hint', () => {
    const r = validateMentionDecision({ ...base, quoteTargetSenderIsBot: true, quoteTargetSenderName: 'Codex' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Codex');
    expect(r.error).toContain('循环');
  });

  it('fails (no decision) with generic hint when no sender known', () => {
    const r = validateMentionDecision({ ...base, hasQuoteTargetSender: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('三选一');
  });

  it('rejects --no-mention combined with --mention', () => {
    const r = validateMentionDecision({ ...base, noMention: true, hasMentionArgs: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不能与');
  });

  it('rejects --mention-back with no known sender', () => {
    const r = validateMentionDecision({ ...base, mentionBack: true, hasQuoteTargetSender: false });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('无可 @ 对象');
  });

  it('disabled gate always passes', () => {
    expect(validateMentionDecision({ ...base, enabled: false }).ok).toBe(true);
  });

  it('--top-level exempt from gate', () => {
    expect(validateMentionDecision({ ...base, sendTopLevel: true }).ok).toBe(true);
  });
});
