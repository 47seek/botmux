import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { runAppSmokeCommand, type AppSmokeDeps, type RunCaptureOptions, type RunCaptureResult } from './app-smoke.js';
import { resolveEffectiveBotmuxVersion } from '../utils/version-info.js';

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export interface AppInstallDeps {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  projectRoot: string;
  tmpRoot?: string;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  homeDir?: string;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  resolveAppVersion?: () => string;
  run: (command: string, args: string[], options?: RunOptions) => RunResult;
  runCapture: (command: string, args: string[], options?: RunCaptureOptions) => RunCaptureResult;
  log: (line: string) => void;
  error: (line: string) => void;
}

interface AppInstallOptions {
  destination: string;
  openAfterInstall: boolean;
  skipBuild: boolean;
  skipInstallDeps: boolean;
  fromSource: boolean;
  url: string | null;
}

const DEFAULT_DESTINATION = '/Applications/Botmux.app';
const DEFAULT_TMP_ROOT = join(tmpdir(), 'botmux-app-install');
// Global wrappers can cold-start Node and the bundled CLI graph slowly on macOS.
const GLOBAL_CLI_CHECK_TIMEOUT_MS = 15_000;
const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`;

export function createDefaultAppInstallDeps(projectRoot: string): AppInstallDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    projectRoot,
    tmpRoot: DEFAULT_TMP_ROOT,
    env: process.env,
    exists: existsSync,
    homeDir: homedir(),
    readFile: path => readFileSync(path, 'utf-8'),
    realpath: realpathSync,
    writeFile: writeFileSync,
    resolveAppVersion: () => resolveEffectiveBotmuxVersion({ rootDir: projectRoot }),
    log: line => console.log(line),
    error: line => console.error(line),
    run: (command, args, options) => {
      const result = spawnSync(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: 'inherit',
      });
      return { status: result.status, signal: result.signal, error: result.error };
    },
    runCapture: (command, args, options) => {
      const result = spawnSync(command, args, {
        encoding: 'utf-8',
        env: options?.env,
        timeout: options?.timeout,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        signal: result.signal,
        error: result.error,
      };
    },
  };
}

export async function runAppCommand(args: string[], deps: AppInstallDeps): Promise<number> {
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    deps.log(appUsage());
    return 0;
  }

  if (subcommand === 'install') {
    try {
      await installApp(args.slice(1), deps);
      return 0;
    } catch (error) {
      deps.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (subcommand === 'smoke') {
    return runAppSmokeCommand(args.slice(1), appInstallDepsToSmokeDeps(deps));
  }

  deps.error(`未知 app 子命令: ${subcommand}`);
  deps.error(appUsage());
  return 1;
}

function appUsage(): string {
  return `用法:
  botmux app install --url <Botmux-mac.zip> [--no-open] [--app-path /Applications/Botmux.app]
  BOTMUX_APP_INSTALL_URL=<Botmux-mac.zip> botmux app install
  botmux app install --from-source [--no-open] [--skip-build] [--skip-install]
  botmux app smoke [--app-path /Applications/Botmux.app] [--skip-dashboard]

说明:
  默认从预构建 zip 下载 Botmux.app，使用 ad-hoc 本地签名并去隔离属性后安装。
  --from-source 仅给开发者在源码仓库内本地编译安装使用，并会执行 pnpm link --global 让 App 使用同一份全局 CLI。
  这能绕过本机 Developer ID 分发流程，但不能让别人直接安装同一个未公证包。`;
}

function appInstallDepsToSmokeDeps(deps: AppInstallDeps): AppSmokeDeps {
  return {
    platform: deps.platform,
    env: deps.env,
    homeDir: deps.homeDir ?? deps.env.HOME ?? homedir(),
    exists: deps.exists,
    readFile: deps.readFile ?? (path => readFileSync(path, 'utf-8')),
    runCapture: deps.runCapture,
    log: deps.log,
    error: deps.error,
  };
}

async function installApp(args: string[], deps: AppInstallDeps): Promise<void> {
  if (deps.platform !== 'darwin') {
    throw new Error('botmux app install 目前只支持 macOS。');
  }

  const options = parseInstallOptions(args);
  assertSafeDestination(options.destination);

  if (options.fromSource) {
    installFromSource(options, deps);
  } else {
    installFromDownload(options, deps);
  }
}

function installFromSource(options: AppInstallOptions, deps: AppInstallDeps): void {
  assertSourceCheckout(deps);
  deps.log('==> 编译 Botmux Desktop');
  if (!options.skipInstallDeps && !deps.exists(join(deps.projectRoot, 'node_modules', '.bin', 'tsc'))) {
    runChecked(deps, 'pnpm', ['install']);
  }
  if (!options.skipBuild) {
    runChecked(deps, 'pnpm', ['build']);
  }
  linkSourceCliGlobally(deps);
  if (!options.skipBuild) {
    runChecked(deps, 'pnpm', ['desktop:bundle']);
    runChecked(deps, 'pnpm', ['exec', 'electron-builder', '--mac', 'dir', '--config', 'electron-builder.yml']);
  }

  const builtApp = findBuiltApp(deps);
  if (!builtApp) {
    throw new Error('未找到构建产物 dist/mac*/Botmux.app。请检查 electron-builder 输出。');
  }

  stampSourceAppVersion(builtApp, deps);
  signAndInstallApp(builtApp, join(deps.projectRoot, 'build', 'entitlements.mac.plist'), options, deps);
}

function linkSourceCliGlobally(deps: AppInstallDeps): void {
  deps.log('==> 链接当前源码到全局 CLI');
  // Desktop always talks to the global `botmux` command. In source installs,
  // pnpm link keeps local App testing on the same CLI contract as production.
  assertPnpmGlobalBinDirOnPath(deps);
  runChecked(deps, 'pnpm', ['link', '--global']);
  verifyLinkedGlobalCli(deps);
}

function assertPnpmGlobalBinDirOnPath(deps: AppInstallDeps): void {
  const globalBinDir = firstLine(runCaptureChecked(
    deps,
    'pnpm',
    ['bin', '-g'],
    '无法读取 pnpm global bin 目录。请先运行 pnpm setup，或执行 pnpm config set global-bin-dir <PATH 中的目录>。',
  ));
  if (!globalBinDir || globalBinDir === 'undefined' || globalBinDir === 'null') {
    throw new Error('pnpm global-bin-dir 未配置。请先运行 pnpm setup，或执行 pnpm config set global-bin-dir <PATH 中的目录>。');
  }
  if (!pathContainsDir(deps.env.PATH ?? '', globalBinDir, deps)) {
    throw new Error(
      `pnpm global-bin-dir 不在 PATH：${globalBinDir}。` +
      ` 请先把它加入 PATH，或执行 pnpm config set global-bin-dir <当前 PATH 中的目录> 后重试。`,
    );
  }
}

function verifyLinkedGlobalCli(deps: AppInstallDeps): void {
  const binPath = firstLine(runCaptureChecked(
    deps,
    '/bin/zsh',
    ['-lc', 'command -v botmux'],
    'pnpm link --global 已执行，但当前 PATH 找不到 botmux。请确认 pnpm global-bin-dir 已加入 PATH，或运行 pnpm setup。',
  ));
  if (!binPath) {
    throw new Error('pnpm link --global 已执行，但当前 PATH 找不到 botmux。请确认 pnpm global-bin-dir 已加入 PATH，或运行 pnpm setup。');
  }

  const linkedRoot = resolveGlobalBotmuxRoot(binPath, deps);
  const projectRoot = safeRealpath(deps.projectRoot, deps);
  if (!linkedRoot) {
    throw new Error(`无法确认全局 botmux 指向当前源码仓库：${binPath}。请检查 pnpm link --global 是否生成了有效 wrapper。`);
  }
  if (safeRealpath(linkedRoot, deps) !== projectRoot) {
    throw new Error(
      `全局 botmux 未指向当前源码仓库：${binPath} -> ${linkedRoot}，当前源码仓库是 ${projectRoot}。` +
      ' 请确认 pnpm global-bin-dir 在 PATH 中，然后重新运行 pnpm link --global。',
    );
  }

  const version = firstLine(runCaptureChecked(
    deps,
    'botmux',
    ['--version'],
    '全局 botmux 已解析到当前源码，但执行 botmux --version 失败。请检查 dist/cli.js 是否已构建。',
  ));
  deps.log(`==> 全局 CLI 已指向当前源码：${binPath}${version ? ` (${version})` : ''}`);
}

function resolveGlobalBotmuxRoot(binPath: string, deps: AppInstallDeps): string | null {
  const realBin = safeRealpath(binPath, deps);
  if (/[/\\]dist[/\\]cli\.js$/i.test(realBin)) return cliPathToRoot(realBin);

  let content = '';
  try {
    content = deps.readFile?.(binPath) ?? '';
  } catch {
    content = '';
  }
  if (!content) return null;

  // pnpm creates shell wrappers that exec ".../dist/cli.js"; resolving that
  // target lets us compare the real package root with the current source root.
  const match = content.match(/["']([^"']*[/\\]dist[/\\]cli\.js)["']/i);
  if (!match) return null;

  return cliPathToRoot(resolveWrapperPath(match[1], binPath));
}

function resolveWrapperPath(rawPath: string, binPath: string): string {
  const basedir = dirname(binPath);
  const withBasedir = rawPath
    .replace(/^\$basedir(?=[/\\])/, basedir)
    .replace(/^\$\{basedir\}(?=[/\\])/, basedir);
  return resolve(withBasedir);
}

function cliPathToRoot(cliPath: string): string {
  return cliPath.replace(/[/\\]dist[/\\]cli\.js$/i, '');
}

function runCaptureChecked(deps: AppInstallDeps, command: string, args: string[], errorMessage: string): string {
  const result = deps.runCapture(command, args, { env: deps.env, timeout: GLOBAL_CLI_CHECK_TIMEOUT_MS });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status ?? 'unknown'}`;
    throw new Error(`${errorMessage} (${detail})`);
  }
  return result.stdout.trim();
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}

function pathContainsDir(pathValue: string, expectedDir: string, deps: AppInstallDeps): boolean {
  const expected = normalizePathForCompare(expectedDir, deps);
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some(entry => normalizePathForCompare(entry, deps) === expected);
}

function normalizePathForCompare(path: string, deps: AppInstallDeps): string {
  return safeRealpath(resolve(path), deps);
}

function safeRealpath(path: string, deps: AppInstallDeps): string {
  try {
    return deps.realpath?.(path) ?? realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function installFromDownload(options: AppInstallOptions, deps: AppInstallDeps): void {
  const url = options.url ?? deps.env.BOTMUX_APP_INSTALL_URL ?? deps.env.BOTMUX_DESKTOP_APP_URL ?? null;
  if (!url) {
    throw new Error('缺少 App 下载地址。请传 --url <zip>，或设置 BOTMUX_APP_INSTALL_URL；开发者可用 --from-source。');
  }

  const tmpRoot = deps.tmpRoot ?? DEFAULT_TMP_ROOT;
  const archivePath = join(tmpRoot, 'Botmux.zip');
  const extractDir = join(tmpRoot, 'extract');
  const extractedApp = join(extractDir, 'Botmux.app');
  const entitlements = join(tmpRoot, 'entitlements.mac.plist');

  deps.log('==> 下载 Botmux Desktop 预构建 App');
  runChecked(deps, 'rm', ['-rf', tmpRoot]);
  runChecked(deps, 'mkdir', ['-p', extractDir]);
  runChecked(deps, 'curl', ['-L', '--fail', '--show-error', '--output', archivePath, url]);
  runChecked(deps, 'ditto', ['-x', '-k', archivePath, extractDir]);
  if (!deps.exists(extractedApp)) {
    throw new Error('下载包格式不正确：zip 根目录必须包含 Botmux.app。');
  }

  deps.writeFile(entitlements, ENTITLEMENTS_PLIST);
  signAndInstallApp(extractedApp, entitlements, options, deps);
}

function signAndInstallApp(sourceApp: string, entitlements: string, options: AppInstallOptions, deps: AppInstallDeps): void {
  // Best-effort quit keeps signing/replacement from racing the running shell.
  runOptional(deps, 'osascript', ['-e', 'tell application "Botmux" to quit']);

  deps.log('==> 使用本机 ad-hoc 签名');
  runChecked(deps, 'codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    sourceApp,
  ]);
  deps.log(`==> 安装到 ${options.destination}`);
  runChecked(deps, 'rm', ['-rf', options.destination]);
  runChecked(deps, 'ditto', [sourceApp, options.destination]);
  runOptional(deps, 'xattr', ['-dr', 'com.apple.quarantine', options.destination]);
  runChecked(deps, 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.destination]);

  if (options.openAfterInstall) {
    runOptional(deps, 'open', [options.destination]);
  }

  deps.log(`✅ Botmux Desktop 已本机安装完成：${options.destination}`);
  deps.log('   签名方式：ad-hoc 本地签名（适合本机安装测试，不适合对外分发）。');
}

function parseInstallOptions(args: string[]): AppInstallOptions {
  const options: AppInstallOptions = {
    destination: DEFAULT_DESTINATION,
    openAfterInstall: true,
    skipBuild: false,
    skipInstallDeps: false,
    fromSource: false,
    url: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--no-open') {
      options.openAfterInstall = false;
    } else if (arg === '--open') {
      options.openAfterInstall = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--skip-install') {
      options.skipInstallDeps = true;
    } else if (arg === '--from-source') {
      options.fromSource = true;
    } else if (arg === '--url') {
      const value = args[index + 1];
      if (!value) throw new Error('--url 需要一个下载地址。');
      options.url = value;
      index += 1;
    } else if (arg === '--app-path') {
      const value = args[index + 1];
      if (!value) throw new Error('--app-path 需要一个目标路径。');
      options.destination = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

function assertSourceCheckout(deps: AppInstallDeps): void {
  const required = [
    'package.json',
    join('src', 'desktop', 'main.ts'),
    'electron-builder.yml',
    join('build', 'entitlements.mac.plist'),
  ];
  const missing = required.filter(path => !deps.exists(join(deps.projectRoot, path)));
  if (missing.length > 0) {
    throw new Error(`需要在 botmux 源码仓库内运行；缺少 ${missing.join(', ')}。`);
  }
}

function assertSafeDestination(destination: string): void {
  // The command replaces the destination bundle, so keep the destructive rm
  // scoped to the expected Botmux app name even when --app-path is supplied.
  if (basename(destination) !== 'Botmux.app') {
    throw new Error('--app-path 必须指向名为 Botmux.app 的应用包。');
  }
}

function findBuiltApp(deps: AppInstallDeps): string | null {
  const candidates = [
    join(deps.projectRoot, 'dist', 'mac-arm64', 'Botmux.app'),
    join(deps.projectRoot, 'dist', 'mac', 'Botmux.app'),
    join(deps.projectRoot, 'dist', 'mac-universal', 'Botmux.app'),
  ];
  return candidates.find(candidate => deps.exists(candidate)) ?? null;
}

function stampSourceAppVersion(appPath: string, deps: AppInstallDeps): void {
  const version = deps.resolveAppVersion?.() ?? resolveEffectiveBotmuxVersion({ rootDir: deps.projectRoot });
  const infoPlist = join(appPath, 'Contents', 'Info.plist');
  // electron-builder reads package.json's placeholder 0.0.0 in source trees;
  // stamp the visible bundle version before signing so Desktop and smoke agree.
  deps.log(`==> 写入 Desktop 版本 ${version}`);
  runChecked(deps, 'plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, infoPlist]);
  runChecked(deps, 'plutil', ['-replace', 'CFBundleVersion', '-string', version, infoPlist]);
}

function runChecked(deps: AppInstallDeps, command: string, args: string[]): void {
  const result = deps.run(command, args, { cwd: deps.projectRoot, env: deps.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const suffix = result.signal ? ` signal ${result.signal}` : ` exit ${result.status ?? 'unknown'}`;
    throw new Error(`${command} ${args.join(' ')} 失败：${suffix}`);
  }
}

function runOptional(deps: AppInstallDeps, command: string, args: string[]): void {
  deps.run(command, args, { cwd: deps.projectRoot, env: deps.env });
}
