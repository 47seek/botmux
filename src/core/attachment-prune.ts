/**
 * 附件目录 TTL 回收。
 *
 * 入站消息的图片/文件/视频下载到 dataDir/attachments/<appId>/<messageId>/，
 * 仅供产生它的那一个 CLI turn 引用；turn 结束后没有后续读者，旧实现永不清理，
 * 随消息量线性增长（现网单个 app 桶已达 976MB，且私聊文件长期留存有隐私面）。
 *
 * 回收策略：daemon 启动时对整个 attachments 根做一次 sweep，删除最后修改时间
 * 超过 maxAgeMs 的 messageId 目录。按目录 mtime（目录内文件写入会更新它），
 * 不依赖消息 id 编码时间；appId 桶目录本身保留。默认 14 天——远长于任何 turn
 * 的生命周期，活跃会话绝不会引用到这么旧的下载。
 *
 * 任何单个目录删除失败都跳过；不存在的根直接返回 0。fail-open，不阻断启动。
 */
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_ATTACHMENT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export interface PruneAttachmentsResult {
  removedDirs: number;
  appBuckets: number;
}

export function pruneOldAttachments(
  attachmentsRoot: string,
  maxAgeMs: number = DEFAULT_ATTACHMENT_MAX_AGE_MS,
  now: () => number = () => Date.now(),
): PruneAttachmentsResult {
  let appBuckets: string[];
  try {
    appBuckets = readdirSync(attachmentsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return { removedDirs: 0, appBuckets: 0 };
  }

  const cutoff = now() - maxAgeMs;
  let removedDirs = 0;
  for (const appId of appBuckets) {
    const bucket = join(attachmentsRoot, appId);
    let messageDirs: string[];
    try {
      messageDirs = readdirSync(bucket, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      continue;
    }
    for (const messageId of messageDirs) {
      const dir = join(bucket, messageId);
      try {
        if (statSync(dir).mtimeMs < cutoff) {
          rmSync(dir, { recursive: true, force: true });
          removedDirs += 1;
        }
      } catch {
        /* 单个旧目录删除失败不阻断其余回收 */
      }
    }
  }
  return { removedDirs, appBuckets: appBuckets.length };
}
