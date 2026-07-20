import { describe, expect, it, vi } from 'vitest';
import { updateAndRestartBotmux } from '../src/dashboard/web/update-action.js';

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

describe('dashboard update and restart action', () => {
  it('installs first, then restarts with the installed version delta', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.0.0',
        newVersion: '3.1.0',
        changed: true,
      }))
      .mockResolvedValueOnce(json(202, { ok: true }));
    const phases: string[] = [];

    await expect(updateAndRestartBotmux(fetchImpl, phase => phases.push(phase))).resolves.toEqual({
      oldVersion: '3.0.0',
      newVersion: '3.1.0',
      changed: true,
      restarted: true,
    });
    expect(phases).toEqual(['updating', 'restarting']);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/update/run', { method: 'POST' });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/update/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update: { oldVersion: '3.0.0', newVersion: '3.1.0' } }),
    });
  });

  it('still restarts when another updater already installed the latest version', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.1.0',
        newVersion: '3.1.0',
        changed: false,
      }))
      .mockResolvedValueOnce(json(202, { ok: true }));

    await expect(updateAndRestartBotmux(fetchImpl)).resolves.toMatchObject({
      changed: false,
      restarted: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never restarts after an install failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(500, {
      ok: false,
      error: 'install_failed',
      detail: 'registry unavailable',
    }));

    await expect(updateAndRestartBotmux(fetchImpl)).rejects.toThrow('registry unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected restart instead of pretending to reconnect', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(200, {
        ok: true,
        oldVersion: '3.0.0',
        newVersion: '3.1.0',
        changed: true,
      }))
      .mockResolvedValueOnce(json(500, { ok: false, error: 'restart_failed' }));

    await expect(updateAndRestartBotmux(fetchImpl)).rejects.toThrow('restart_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed successful update response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { ok: true }));

    await expect(updateAndRestartBotmux(fetchImpl)).rejects.toThrow('Invalid update response');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
