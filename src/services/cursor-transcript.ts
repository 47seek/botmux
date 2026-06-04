/**
 * Reader for Cursor Agent's per-chat transcript JSONL.
 *
 * `cursor-agent` keeps each chat's authoritative store in a SQLite file
 *   ~/.cursor/chats/<projectHash>/<chatId>/store.db
 * (held open via fd for the whole session) and, in parallel, mirrors the
 * conversation into an append-only JSONL transcript at
 *   ~/.cursor/projects/<projectSlug>/agent-transcripts/<chatId>/<chatId>.jsonl
 *
 * The bridge reads the JSONL (not the SQLite store) because it's append-only
 * plain text — the same integration surface the Codex/CoCo bridges use. Each
 * line is `{ role: 'user' | 'assistant', message: { content: [...] } }` where
 * a content block is either `{ type: 'text', text }` or `{ type: 'tool_use',
 * name, input }`. Tool *results* are not recorded.
 *
 * Final-answer detection is simpler than Codex's `phase=final_answer`: the
 * model emits a `text + tool_use` line for every intermediate step and ends a
 * turn with a single `text`-only assistant line (no `tool_use`). So:
 *   - role=user                         → the user's prompt
 *   - role=assistant, text & no tool_use → the model's final reply
 * Intermediate assistant lines (any with a tool_use block) are skipped.
 *
 * Cursor's JSONL carries no per-event timestamp, so the worker baselines this
 * transcript by byte offset at adopt time (history is behind the offset and
 * never re-ingested) and stamps live events with the drain wall-clock. That's
 * why every emitted event uses `Date.now()` for `timestampMs` — enough for the
 * shared CodexBridgeQueue's freshness gates given the offset baseline.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';

const IS_LINUX = platform() === 'linux';

const CHAT_ID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Default `~/.cursor/projects` root. Overridable by callers (tests) so the
 *  scan doesn't depend on a real home directory. */
export function cursorProjectsRoot(): string {
  return join(homedir(), '.cursor', 'projects');
}

/** Extract the chatId encoded in a Cursor store.db path of the shape
 *  `.../.cursor/chats/<projectHash>/<chatId>/store.db` (also matches the
 *  `-wal` / `-shm` sidecar files SQLite keeps open). The chatId is the same
 *  UUID used to name the agent-transcript JSONL, so it's the bridge between
 *  the open fd and the transcript file. Returns undefined for non-matching
 *  paths. */
export function cursorChatIdFromStoreDbPath(path: string): string | undefined {
  const re = new RegExp(`/\\.cursor/chats/[^/]+/(${CHAT_ID_RE})/store\\.db(?:-wal|-shm)?$`, 'i');
  const m = re.exec(path);
  return m ? m[1] : undefined;
}

/** Find the chatId of an externally-running cursor-agent process by reading
 *  the store.db file it keeps open. cursor-agent holds an fd on its current
 *  chat's SQLite store for the whole session lifetime, which makes this the
 *  authoritative pid→chatId binding — far more reliable than scanning chat
 *  dirs by mtime (which would race with sibling cursor-agent panes).
 *
 *  Linux: `/proc/<pid>/fd/*` fast path. macOS / BSD: `lsof -p <pid> -Fn`
 *  fallback (same shape as codex-transcript.findCodexRolloutByPid). */
export function findCursorChatIdByPid(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const chatId = cursorChatIdFromStoreDbPath(target);
        if (chatId) return chatId;
      }
      return undefined;
    }
    // /proc unreadable — fall through to lsof.
  }
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const chatId = cursorChatIdFromStoreDbPath(line.slice(1));
    if (chatId) return chatId;
  }
  return undefined;
}

/** Locate the agent-transcript JSONL for a given chatId. The chatId is a
 *  globally-unique UUID, so a one-shot scan of the (small) projects root for
 *  `<slug>/agent-transcripts/<chatId>/<chatId>.jsonl` is unambiguous and
 *  avoids having to reproduce Cursor's opaque cwd→slug hashing. */
export function findCursorTranscriptByChatId(
  chatId: string,
  projectsRoot: string = cursorProjectsRoot(),
): string | undefined {
  if (!chatId || !existsSync(projectsRoot)) return undefined;
  let slugs: string[];
  try { slugs = readdirSync(projectsRoot); } catch { return undefined; }
  for (const slug of slugs) {
    const candidate = join(projectsRoot, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve the transcript path for an externally-running cursor-agent pid:
 *  pid → open store.db → chatId → agent-transcript JSONL. Returns both the
 *  path and the chatId so the caller can remember the chatId for a later
 *  retry if the JSONL isn't on disk yet. */
export function findCursorTranscriptByPid(
  pid: number,
  projectsRoot: string = cursorProjectsRoot(),
): { path: string; chatId: string } | undefined {
  const chatId = findCursorChatIdByPid(pid);
  if (!chatId) return undefined;
  const path = findCursorTranscriptByChatId(chatId, projectsRoot);
  return path ? { path, chatId } : undefined;
}

export interface CursorDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
}

/** Concatenate the text of all `type:'text'` blocks. Cursor uses the same
 *  `{type:'text', text}` shape for both user prompts and assistant replies;
 *  `tool_use` (and any other) blocks are ignored — the bridge only forwards
 *  text. Tolerates a bare-string content for defensiveness. */
function joinTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text') {
      const text = (block as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** True when an assistant content array contains at least one tool_use block,
 *  i.e. this is a mid-turn step rather than the final reply. */
function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(b => b && typeof b === 'object' && (b as any).type === 'tool_use');
}

/** Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 *  contract of codex-transcript.drainCodexRollout so the worker can reuse the
 *  same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue. */
export function drainCursorTranscript(path: string, fromOffset: number): CursorDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  // Truncated / rotated jsonl — re-read from the top (mirrors Codex/Claude).
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CodexBridgeEvent[] = [];
  // Track byte offset within the file so synthetic uuids are stable across
  // re-drains (the transcript is append-only).
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1; // the \n after an empty line
      continue;
    }
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // include \n
    const lineStart = cursor;
    cursor += lineByteLen;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const role = obj?.role ?? obj?.message?.role;
    const content = obj?.message?.content;
    // No per-event timestamp in Cursor's JSONL — stamp with the drain
    // wall-clock. Combined with byte-offset baselining at attach, this keeps
    // the CodexBridgeQueue freshness gates happy without a real timestamp.
    const timestampMs = Date.now();
    if (role === 'user') {
      const t = joinTextBlocks(content);
      if (!t) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text: t });
    } else if (role === 'assistant') {
      // A turn ends with a text-only assistant line; any line carrying a
      // tool_use block is an intermediate step and must not be forwarded.
      if (hasToolUse(content)) continue;
      const t = joinTextBlocks(content);
      if (!t) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: t });
    }
  }
  return { events, newOffset, pendingTail };
}
