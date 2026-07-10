import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotPolicyCard, SkillsInstallPanel } from '../src/dashboard/web/skills-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('dashboard skills React hook safety', () => {
  it('keeps hook order stable when the same bot card flips between error and normal states', () => {
    const onUpdate = vi.fn();
    const normalBot = { larkAppId: 'app-a', botName: 'Codex Bot', skills: { include: ['skill:deploy'] } };
    const errorBot = { larkAppId: 'app-a', botName: 'Codex Bot', error: 'daemon offline', skills: null };
    const skills = [{ name: 'deploy' }, { name: 'review' }];

    let renderer!: TestRenderer.ReactTestRenderer;
    expect(() => {
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: normalBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
    }).not.toThrow();

    expect(renderer.toJSON()).toMatchObject({ props: { 'data-appid': 'app-a' } });
  });

  it('keeps the configured skill detach action available', () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(BotPolicyCard, {
        bot: { larkAppId: 'app-a', botName: 'Codex Bot', skills: { include: ['skill:deploy'] } },
        installedNames: new Set(['deploy', 'review']),
        skills: [{ name: 'deploy' }, { name: 'review' }],
        status: null,
        busyKey: null,
        onUpdate,
      }));
    });

    const detach = renderer.root.findByProps({ 'data-action': 'detach-skill' });
    act(() => detach.props.onClick());

    expect(detach.props['aria-label']).toContain('deploy');
    expect(onUpdate).toHaveBeenCalledWith('app-a', 'detach', 'deploy');
  });

  it('constrains every bot card child to the card grid column', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.skills-bot-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(css).toMatch(/\.skills-policy-panel\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.skills-bot-head\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.skills-chip-list\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.skills-attach-row,[^{]*\{[^}]*min-width:\s*0/s);
  });
});

describe('dashboard skills install panel', () => {
  function renderInstallPanel(props: Partial<React.ComponentProps<typeof SkillsInstallPanel>> = {}): TestRenderer.ReactTestRenderer {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SkillsInstallPanel, {
        installSource: '',
        installPath: '',
        installRef: '',
        installStatus: null,
        installBusy: false,
        onInstallSourceChange: vi.fn(),
        onInstallPathChange: vi.fn(),
        onInstallRefChange: vi.fn(),
        onInstall: vi.fn(),
        onOpenNativeDiscovery: vi.fn(),
        ...props,
      }));
    });
    return renderer;
  }

  it('separates remote source scanning from local native skill discovery', () => {
    const renderer = renderInstallPanel();
    const root = renderer.root;

    const sourceControl = root.findByProps({ className: 'skills-source-control' });
    expect(sourceControl.findAllByProps({ 'data-action': 'discover-native-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'scan-source-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'open-native-skill-discovery' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'install' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'path' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install': 'ref' })).toHaveLength(1);
  });

  it('keeps advanced install fields visible beside the install action', () => {
    const renderer = renderInstallPanel();
    const root = renderer.root;
    const installGrid = root.findByProps({ className: 'skills-install-grid' });
    const path = installGrid.findByProps({ 'data-install': 'path' });
    const ref = installGrid.findByProps({ 'data-install': 'ref' });
    const install = installGrid.findByProps({ 'data-action': 'install' });

    expect(installGrid.findAllByProps({ 'data-skills-advanced': true })).toHaveLength(0);
    expect(installGrid.findAllByProps({ className: 'skills-advanced-marker' })).toHaveLength(0);
    expect(path.parent?.parent).toBe(installGrid);
    expect(ref.parent?.parent).toBe(installGrid);
    expect(install.parent?.parent).toBe(installGrid);
  });

  it('keeps multi-skill install selection inside the install confirmation dialog', () => {
    const renderer = renderInstallPanel({
      installSource: 'https://github.com/acme/skills',
      installSelectionOpen: true,
      installCandidates: [
        { name: 'deploy', path: 'skills/deploy', description: 'Deploy services' },
        { name: 'review', path: 'skills/review', description: 'Review code' },
      ],
      selectedInstallSkills: new Set(['deploy', 'review']),
      onToggleInstallSkill: vi.fn(),
      onSelectAllInstallSkills: vi.fn(),
      onConfirmInstallSelection: vi.fn(),
      onCloseInstallSelection: vi.fn(),
    });
    const root = renderer.root;

    expect(root.findAllByProps({ 'data-action': 'scan-source-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'install' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install-selection-dialog': true })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'confirm-install-selection' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'toggle-all-source-skills' })).toHaveLength(1);
    expect(root.findAllByProps({ className: 'skills-candidate-row' })).toHaveLength(2);
  });
});
