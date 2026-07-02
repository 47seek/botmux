import { execSync, spawnSync } from 'node:child_process';

interface RunOptions {
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export interface UpgradeDeps {
  env: NodeJS.ProcessEnv;
  run: (command: string, args: string[], options?: RunOptions) => RunResult;
  log: (line: string) => void;
  error: (line: string) => void;
}

interface UpgradeOptions {
  withApp: boolean;
  appUrl: string | null;
  appNoOpen: boolean;
}

type UpgradeStage = 'preflight' | 'cli' | 'app';

class UpgradeStageError extends Error {
  constructor(readonly stage: UpgradeStage, message: string) {
    super(message);
  }
}

export function createDefaultUpgradeDeps(): UpgradeDeps {
  return {
    env: process.env,
    log: line => console.log(line),
    error: line => console.error(line),
    run: (command, args, options) => {
      // Keep npm upgrade streaming exactly like the old execSync path, but use
      // argv form for the app install step so user-supplied URLs are not shell-expanded.
      if (command === 'npm') {
        try {
          execSync([command, ...args].join(' '), { stdio: 'inherit', env: options?.env });
          return { status: 0 };
        } catch (error) {
          return { status: 1, error: error instanceof Error ? error : undefined };
        }
      }
      const result = spawnSync(command, args, {
        env: options?.env,
        stdio: 'inherit',
      });
      return { status: result.status, signal: result.signal, error: result.error };
    },
  };
}

export async function runUpgradeCommand(args: string[], deps: UpgradeDeps): Promise<number> {
  try {
    const options = parseUpgradeOptions(args);
    assertAppInstallPreflight(options, deps.env);

    deps.log('🔄 升级中...');
    runChecked(deps, 'cli', 'npm', ['install', '-g', 'botmux@latest'], { env: deps.env });

    if (options.withApp) {
      deps.log('\n🔄 更新 Botmux Desktop App...');
      const appEnv = { ...deps.env };
      if (options.appUrl) appEnv.BOTMUX_APP_INSTALL_URL = options.appUrl;
      const appArgs = ['app', 'install'];
      if (options.appNoOpen) appArgs.push('--no-open');
      runChecked(deps, 'app', 'botmux', appArgs, { env: appEnv });
      deps.log('✅ App 更新完成。');
    }

    deps.log(options.withApp
      ? '\n✅ 升级完成。运行 botmux restart 以应用 runtime 更新。'
      : '\n✅ 升级完成。运行 botmux restart 以应用更新。');
    return 0;
  } catch (error) {
    deps.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    const stage = error instanceof UpgradeStageError ? error.stage : 'preflight';
    if (stage === 'app') {
      deps.error('   可手动重试: botmux app install');
      deps.error('   CLI 可能已经更新；App 安装成功后再运行 botmux restart。');
    } else if (stage === 'preflight' && args.includes('--with-app')) {
      deps.error('   示例: botmux upgrade --with-app --app-url <Botmux-mac.zip>');
    } else {
      deps.error('   请手动运行: npm install -g botmux@latest');
    }
    return 1;
  }
}

function parseUpgradeOptions(args: string[]): UpgradeOptions {
  const options: UpgradeOptions = {
    withApp: false,
    appUrl: null,
    appNoOpen: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--with-app') {
      options.withApp = true;
    } else if (arg === '--app-url') {
      const value = args[index + 1];
      if (!value) throw new Error('--app-url 需要一个 App zip 下载地址。');
      options.withApp = true;
      options.appUrl = value;
      index += 1;
    } else if (arg === '--no-open') {
      options.appNoOpen = true;
    } else {
      throw new Error(`未知 upgrade 参数: ${arg}`);
    }
  }

  return options;
}

function assertAppInstallPreflight(options: UpgradeOptions, env: NodeJS.ProcessEnv): void {
  if (!options.withApp) return;
  const url = options.appUrl ?? env.BOTMUX_APP_INSTALL_URL ?? env.BOTMUX_DESKTOP_APP_URL;
  // Avoid a half-success where npm upgrades the CLI but the App stage then
  // fails immediately because no downloadable App artifact was supplied.
  if (!url) {
    throw new UpgradeStageError('preflight', '缺少 App 下载地址。请传 --app-url，或设置 BOTMUX_APP_INSTALL_URL。');
  }
}

function runChecked(
  deps: UpgradeDeps,
  stage: Exclude<UpgradeStage, 'preflight'>,
  command: string,
  args: string[],
  options?: RunOptions,
): void {
  const result = deps.run(command, args, options);
  if (result.error) throw new UpgradeStageError(stage, result.error.message);
  if (result.status !== 0) {
    const suffix = result.signal ? ` signal ${result.signal}` : ` exit ${result.status ?? 'unknown'}`;
    throw new UpgradeStageError(stage, `${command} ${args.join(' ')} 失败：${suffix}`);
  }
}
