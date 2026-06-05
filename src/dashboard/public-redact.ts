// src/dashboard/public-redact.ts
//
// Anonymous (tokenless) shaping of read-only dashboard payloads served when
// `config.dashboard.publicReadOnly` is on. Pure + side-effect free so they can
// be unit-tested without standing up the dashboard server (dashboard.ts starts
// an HTTP listener on import).
//
// The public "watch work" board only needs NAMES + status. Two read endpoints
// embed real filesystem / business content that an anonymous visitor must not
// see, so each gets a redactor here:
//   - /api/groups   → memberBots[].oncallChat = { chatId, workingDir }
//   - /api/schedules → row carries `prompt` (business instructions) + `workingDir`
// Both `workingDir`s are repo / customer-project paths; stripping them keeps
// the board functional (name-map, timing, status) while not leaking bound dirs
// — and keeps the "/api/bots oncall config is private" boundary honest.

/** Strip per-bot oncall bindings (which carry `workingDir`) from a `/api/groups`
 *  chats array for anonymous visitors. Returns a new array; never mutates the
 *  input. Bot/chat names and `inChat` membership are preserved so the board's
 *  name-map and matrix still render. */
export function redactGroupsForPublic(chats: unknown[]): unknown[] {
  if (!Array.isArray(chats)) return chats;
  return chats.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const chat = c as Record<string, unknown>;
    const memberBots = chat.memberBots;
    if (!Array.isArray(memberBots)) return chat;
    return {
      ...chat,
      memberBots: memberBots.map((mb) => {
        if (!mb || typeof mb !== 'object') return mb;
        return { ...(mb as Record<string, unknown>), oncallChat: null };
      }),
    };
  });
}

/** Drop `prompt` (business instructions) and `workingDir` (repo/customer path)
 *  from `/api/schedules` rows for anonymous visitors. Returns a new array; never
 *  mutates the input. Name / timing / status fields are preserved so the
 *  read-only schedules view still renders. */
export function redactSchedulesForPublic(schedules: unknown[]): unknown[] {
  if (!Array.isArray(schedules)) return schedules;
  return schedules.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const { prompt: _prompt, workingDir: _workingDir, ...rest } = s as Record<string, unknown>;
    return rest;
  });
}
