import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { fetchCliAvailability } from '../src/dashboard/web/cli-availability.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const cliState = {
  options: [
    { id: 'traex', label: 'TraeX', available: false, command: 'traex', availabilityStatus: 'unknown' as const },
    { id: 'gemini', label: 'Gemini', available: false, command: 'gemini', availabilityStatus: 'unknown' as const },
  ],
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: [],
};
const renderers: TestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

function renderAgent(bot = { larkAppId: 'cli_test', cliId: 'traex' }) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(BotAgentSection, {
      bot, cliState, sessionFallback: 'traex', patchBot: vi.fn(),
    }));
  });
  renderers.push(renderer);
  return renderer;
}

describe('selected Dashboard CLI availability', () => {
  it('does not label a PATH-only miss as uninstalled while the complete probe is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const renderer = renderAgent();
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
  });

  it.each(['available', 'unavailable', 'unknown'] as const)('renders the complete %s result', async status => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status } : { models: [], source: 'static' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = renderAgent(); });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(status === 'unavailable' ? 1 : 0);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/cli-options/availability?key=traex&bot=cli_test', { signal: expect.any(AbortSignal) },
    );
  });

  it('ignores an old unavailable response after selecting another CLI', async () => {
    let resolveOld!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/availability?key=traex')) return await new Promise(resolve => { resolveOld = resolve; });
      return { ok: true, json: async () => url.includes('/availability?') ? { status: 'available' } : { models: [] } };
    }));
    const renderer = renderAgent();
    await act(async () => {
      renderer.root.findByProps({ dataInput: 'agentCliId' }).props.onChange('gemini');
    });
    await act(async () => { resolveOld({ ok: true, json: async () => ({ status: 'unavailable' }) }); });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
    expect(renderer.root.findByProps({ dataInput: 'agentCliId' }).props.value).toBe('gemini');
  });

  it('discards the old Bot readiness when its persisted configuration changes', async () => {
    const fetchSpy = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.includes('/availability?') ? { status: 'unavailable' } : { models: [] },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const renderer = renderAgent();
    await act(async () => {});
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(1);
    fetchSpy.mockImplementation(() => new Promise(() => {}));
    act(() => {
      renderer.update(React.createElement(BotAgentSection, {
        bot: { larkAppId: 'cli_test', cliId: 'traex', cliPathOverride: '/new/traex' },
        cliState, sessionFallback: 'traex', patchBot: vi.fn(),
      }));
    });
    expect(renderer.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
  });

  it('does not turn network/HTTP/invalid-body failures into a missing executable', async () => {
    for (const response of [
      { ok: false, json: async () => ({ status: 'unavailable' }) },
      { ok: true, json: async () => ({ status: 'malformed' }) },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      expect(await fetchCliAvailability('traex')).toBeNull();
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchCliAvailability('traex')).toBeNull();
  });
});
