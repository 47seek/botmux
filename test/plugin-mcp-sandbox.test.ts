import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareSandbox } from '../src/adapters/backend/sandbox.js';
import { installLocalPlugin } from '../src/core/plugins/install.js';
import { pluginMcpPrivatePath } from '../src/core/plugins/paths.js';
import {
  refreshSessionMcpRuntimeManifest,
  sessionMcpRuntimeManifestPath,
  sessionMcpRuntimeReadonlyRoots,
  sessionMcpRuntimeSensitivePaths,
} from '../src/core/plugins/mcp/session-runtime.js';

const builtCli = resolve('dist/cli.js');

describe.skipIf(process.platform !== 'linux' || !existsSync(builtCli))('plugin MCP Gateway sandbox integration', () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-mcp-sandbox-'));
    home = join(root, 'home');
    dataDir = join(home, '.botmux', 'data');
    project = join(root, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['default', 'custom'] as const)(
    'initializes, lists, and calls a session-scoped plugin MCP inside bwrap with %s data dir',
    async (dataDirMode) => {
    if (dataDirMode === 'custom') {
      dataDir = join(root, 'custom-botmux-home', 'data');
      mkdirSync(dataDir, { recursive: true });
      vi.stubEnv('SESSION_DATA_DIR', dataDir);
    }
    const sessionId = `mcp-sandbox-${Math.random().toString(36).slice(2)}`;
    const siblingSessionId = `${sessionId}-sibling`;
    const pluginId = 'plugin-a';
    const source = join(root, 'plugin-source');
    const fixture = resolve('test/fixtures/plugin-mcp-server.mjs');
    mkdirSync(join(source, 'dist', 'mcp'), { recursive: true });
    const installedMcpIndex = join(home, '.botmux', 'plugins', pluginId, 'dist', 'mcp', 'index.json');
    const privateDescriptor = pluginMcpPrivatePath(pluginId);
    const currentSnapshot = sessionMcpRuntimeManifestPath(sessionId, dataDir);
    const siblingSnapshot = sessionMcpRuntimeManifestPath(siblingSessionId, dataDir);
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-plugin-a',
      version: '0.1.0',
      type: 'module',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: pluginId },
    }));
    writeFileSync(join(source, 'dist', 'mcp', 'index.json'), JSON.stringify({
      transport: 'stdio',
      command: [
        '/bin/sh',
        '-c',
        'test ! -s "$1" && test ! -s "$2" && test ! -s "$3" && test -s "$4" || exit 78; shift 4; exec "$@"',
        'verify-session-mcp-isolation',
        installedMcpIndex,
        privateDescriptor,
        siblingSnapshot,
        currentSnapshot,
        process.execPath,
        fixture,
        'alpha',
      ],
    }));
    installLocalPlugin(source);

    refreshSessionMcpRuntimeManifest({
      sessionId: siblingSessionId,
      pluginIds: [pluginId],
      dataDir,
    });
    const runtime = refreshSessionMcpRuntimeManifest({
      sessionId,
      pluginIds: [pluginId],
      dataDir,
    });
    const gatewayBin = join(home, '.botmux', 'bin', 'botmux');
    mkdirSync(join(home, '.botmux', 'bin'), { recursive: true });
    writeFileSync(gatewayBin, '#!/bin/sh\nexit 99\n');
    chmodSync(gatewayBin, 0o755);

    let sandbox: ReturnType<typeof prepareSandbox> = null;
    let client: Client | null = null;
    let transport: StdioClientTransport | null = null;
    try {
      sandbox = prepareSandbox({
        enabled: true,
        cliId: 'codex',
        sessionId,
        sourceWorkingDir: project,
        dataDir,
        cliBin: gatewayBin,
        cliArgs: ['mcp', 'serve'],
        readonlyRoots: sessionMcpRuntimeReadonlyRoots(runtime, dataDir),
        postReadonlyHidePaths: sessionMcpRuntimeSensitivePaths(runtime),
        trustedBotmuxCommandPaths: [gatewayBin],
      });
      if (!sandbox) return; // Required Linux sandbox runtime is unavailable.

      transport = new StdioClientTransport({
        command: sandbox.bin,
        args: sandbox.args,
        cwd: project,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          ...sandbox.env,
          BOTMUX_SESSION_ID: sessionId,
        },
        stderr: 'pipe',
      });
      client = new Client({ name: 'sandbox-gateway-test', version: '1.0.0' });
      await client.connect(transport);

      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['alpha_unique', 'echo']);
      const result = await client.callTool({ name: 'echo', arguments: { value: 1 } });
      expect((result.content[0] as { text: string }).text).toContain(`alpha:echo:{\"value\":1}:session=${sessionId}`);
    } finally {
      if (client) await client.close().catch(() => undefined);
      else if (transport) await transport.close().catch(() => undefined);
      if (sandbox) sandbox.cleanup();
    }
    },
    20_000,
  );
});
