import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { UpdateCard } from '../src/dashboard/web/settings-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('dashboard update card', () => {
  it('keeps all update controls in the v4 update/other groups', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(UpdateCard, {
        canWrite: true,
        status: {
          current: '3.9.0',
          latest: '3.10.0',
          behind: true,
          cliBehind: false,
          cliUpdates: [],
          localDevInstall: true,
          updateSupported: false,
          updateManager: 'unknown',
          updateCommand: null,
          node: { version: '22.0.0', major: 22, required: 22, ok: true },
          installs: { entries: [], multiple: false },
          sourceUpdate: {
            supported: true,
            root: '/repo/source',
            branch: 'develop',
            upstream: 'origin/develop',
            head: 'abc',
            clean: true,
            blockedReason: null,
          },
          publishedSwitch: {
            supported: true,
            manager: 'npm',
            targetRoot: '/opt/lib/node_modules/botmux',
            command: 'npm install -g botmux@latest',
            blockedReason: null,
          },
        },
        statusError: null,
        changelog: null,
        changelogOpen: false,
        changelogOk: true,
        changelogRateLimited: false,
        releasesUrl: '',
        busy: false,
        message: null,
        onCheck: vi.fn(),
        onToggleChangelog: vi.fn(),
        onUpdate: vi.fn(),
        onSourceUpdate: vi.fn(),
        onPublishedSwitch: vi.fn(),
        onRestart: vi.fn(),
      } as any));
    });
    // v4 layout: two labelled groups separated by a divider.
    expect(renderer.root.findAllByProps({ className: 'update-group update-group-primary' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: 'update-group update-group-other' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: 'update-group-divider' })).toHaveLength(1);
    // All six original + source controls stay as fully rendered buttons.
    for (const action of ['source', 'published', 'check', 'changelog', 'update', 'restart']) {
      expect(renderer.root.findAllByProps({ 'data-up': action }), action).toHaveLength(1);
    }
    // In source mode the "update to latest" button is disabled with a reason label.
    const updateBtn = renderer.root.findByProps({ 'data-up': 'update' });
    expect(updateBtn.props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ className: 'update-action-reason' })).toHaveLength(1);
  });

  it('shows only the update-to-latest button for non-source installs', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(UpdateCard, {
        canWrite: true,
        status: {
          current: '3.9.0',
          latest: '3.10.0',
          behind: true,
          cliBehind: false,
          cliUpdates: [],
          localDevInstall: false,
          updateSupported: true,
          updateManager: 'npm',
          updateCommand: 'npm install -g botmux@latest',
          node: { version: '22.0.0', major: 22, required: 22, ok: true },
          installs: { entries: [], multiple: false },
          sourceUpdate: null,
          publishedSwitch: null,
        },
        statusError: null,
        changelog: null,
        changelogOpen: false,
        changelogOk: true,
        changelogRateLimited: false,
        releasesUrl: '',
        busy: false,
        message: null,
        onCheck: vi.fn(),
        onToggleChangelog: vi.fn(),
        onUpdate: vi.fn(),
        onSourceUpdate: vi.fn(),
        onPublishedSwitch: vi.fn(),
        onRestart: vi.fn(),
      } as any));
    });
    expect(renderer.root.findAllByProps({ 'data-up': 'source' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-up': 'published' })).toHaveLength(0);
    const updateBtn = renderer.root.findByProps({ 'data-up': 'update' });
    expect(updateBtn.props.disabled).toBe(false);
    for (const action of ['check', 'changelog', 'restart']) {
      expect(renderer.root.findAllByProps({ 'data-up': action }), action).toHaveLength(1);
    }
  });
});
