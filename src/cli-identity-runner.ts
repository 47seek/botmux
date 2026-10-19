import { parseArgs } from 'node:util';
import { resolveCurrentExecution } from './cli/current-execution.js';
import { sessionIdentityPath } from './core/cli-identity.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '__cli-identity-runner') args.shift();
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string' }, 'session-id': { type: 'string' },
    'app-id': { type: 'string' }, 'ipc-port': { type: 'string' }, tool: { type: 'string' },
  } });
  if (!values['data-dir'] || !values['session-id'] || !values['app-id']
    || (values.tool !== 'lark-cli' && values.tool !== 'bytedcli')) {
    throw new Error('Invalid managed CLI identity invocation');
  }
  const execution = await resolveCurrentExecution({
    ipcPort: Number(values['ipc-port']), sessionId: values['session-id'], larkAppId: values['app-id'],
  });
  if (!execution.identityTurnId) throw new Error('current_execution_identity_unavailable');
  process.stdout.write(`${sessionIdentityPath(values['data-dir'], execution.sessionId, values.tool, execution.identityTurnId)}\n`);
}

await main().catch(error => {
  process.stderr.write(`botmux: ${error instanceof Error ? error.message : 'current_execution_unverified'}\n`);
  process.exitCode = 77;
});
