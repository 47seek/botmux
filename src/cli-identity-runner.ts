import { parseArgs } from 'node:util';
import { resolveCurrentExecutionIdentity } from './cli/current-execution.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '__cli-identity-runner') args.shift();
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string' }, 'session-id': { type: 'string' },
    'app-id': { type: 'string' }, 'ipc-port': { type: 'string' }, tool: { type: 'string' },
  } });
  if (!values['session-id'] || !values['app-id']
    || (values.tool !== 'lark-cli' && values.tool !== 'bytedcli')) {
    throw new Error('Invalid managed CLI identity invocation');
  }
  const execution = await resolveCurrentExecutionIdentity({
    ipcPort: Number(values['ipc-port']), sessionId: values['session-id'], larkAppId: values['app-id'],
    tool: values.tool,
  });
  // The daemon proved the caller's lineage and returns the identity env
  // ASSIGNMENTS themselves. Print only the body for the wrapper to eval; the
  // body never names a disk path, so nothing in the session can redirect it.
  process.stdout.write(execution.env);
}

await main().catch(error => {
  process.stderr.write(`botmux: ${error instanceof Error ? error.message : 'current_execution_unverified'}\n`);
  process.exitCode = 77;
});
