// SPDX-License-Identifier: Apache-2.0
// Transcript readers: complete turns (a person's message + everything the assistant
// said before the next one), each with the line it ends on, and the line the
// cursor may advance to once every turn is delivered. Ported from spacesheep-cli
// lib/memory.js. One reader per harness file format; nothing else is vendor code.
import { codexReplayBoundary } from "../adapters/codex-rollout.js";
import type { TranscriptRead } from "../adapters/types.js";
import { deliveredWords } from "../control/frames.js";

interface Msg {
  /** `interrupt` carries no words: the person stopped the running turn at this line.
   *  `failed` neither: the turn ended there on an error, before it was whole. */
  role: "user" | "assistant" | "interrupt" | "failed";
  text: string;
  at: number;
  line: number;
  /** This ask reached the session from somewhere other than its own keyboard: another
   *  local session handed it over, or a channel pushed it, which are the two ways a
   *  control daemon reaches a session in place (spec/CONTROL.md §6.3, §8). The words are
   *  the person's; the arrival was not. */
  injected?: true;
  /** The harness's own id for the prompt (a `user` message's only). */
  id?: string;
}

/** `tail`: also say where the last turn starts and what the assistant said last in it
 *  (TranscriptRead.tail), for a reader whose harness names a turn's last words. */
export function pairTurns(msgs: Msg[], endLine: number, tail = false): TranscriptRead {
  const turns: {
    user: string;
    assistant: string;
    at: number;
    startLine: number;
    endLine: number;
    injected?: true;
    id?: string;
    interrupted?: true;
    failed?: true;
    /** The assistant's last message in the turn, so far. */
    said?: string;
  }[] = [];
  let cur: (typeof turns)[number] | null = null;
  for (const m of msgs) {
    if (m.role === "interrupt" || m.role === "failed") {
      // The person stopped the turn, or it failed: it is whole as it stands, with whatever
      // it had said, and what follows is another turn. Without this the prompt would wait
      // for a reply that is not coming and join the next prompt instead.
      if (cur) {
        if (m.role === "failed") cur.failed = true;
        else cur.interrupted = true;
        cur.endLine = m.line;
        turns.push(cur);
        cur = null;
      }
    } else if (m.role === "user") {
      // Never overwrite a prompt that has no reply yet: in an agentic turn the reply
      // comes after tool calls, and a second user record is not a new question.
      if (cur && !cur.assistant) {
        cur.user += `\n\n${m.text}`;
        if (m.id) cur.id = m.id;
        continue;
      }
      if (cur) turns.push(cur);
      cur = {
        user: m.text,
        assistant: "",
        at: m.at,
        startLine: m.line,
        endLine: m.line,
        ...(m.injected ? { injected: true as const } : {}),
        ...(m.id ? { id: m.id } : {}),
      };
    } else {
      if (!cur) cur = { user: "", assistant: "", at: m.at, startLine: m.line, endLine: m.line };
      cur.assistant += (cur.assistant ? "\n\n" : "") + m.text;
      cur.endLine = m.line;
      cur.said = m.text;
    }
  }
  if (cur?.assistant) turns.push(cur);
  // A user message with no reply yet stays unsent: the cursor stops before it.
  const line = cur && !cur.assistant ? cur.startLine : endLine;
  const out: TranscriptRead = {
    turns: turns.map((t) => ({
      user: t.user,
      assistant: t.assistant,
      at: t.at,
      endLine: t.endLine,
      ...(t.injected ? { injected: true as const } : {}),
      ...(t.id ? { id: t.id } : {}),
      ...(t.interrupted ? { interrupted: true as const } : {}),
      ...(t.failed ? { failed: true as const } : {}),
    })),
    line,
  };
  if (cur && !cur.assistant && cur.user)
    out.open = {
      user: cur.user,
      at: cur.at,
      ...(cur.injected ? { injected: true as const } : {}),
      ...(cur.id ? { id: cur.id } : {}),
    };
  const last = turns[turns.length - 1];
  // An interrupted turn says nothing more, so it has no last words to wait for.
  if (tail && last)
    out.tail = {
      start: last.startLine,
      ...(last.said !== undefined && !last.interrupted && !last.failed ? { said: last.said } : {}),
    };
  return out;
}

/** Injected context the person never typed: <tag>…</tag> wrappers (the tag may carry
 *  attributes, as Claude Code's `<cross-session-message from="…">` does), HTML comments,
 *  slash-command expansions. */
export const isInjected = (text: string): boolean =>
  (/^<[a-z_-]+(?:\s[^>]*)?>/i.test(text) && /<\/[a-z_-]+>\s*$/i.test(text)) ||
  /^<!--\s/.test(text) ||
  /^<command-/.test(text);

const parse = (raw: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
};
/** The line after the last whole one. A trailing line that does not parse has no
 *  newline yet (a write in progress): the cursor stops before it, or the prompt in
 *  it would never be read. */
const endOf = (lines: string[]) => {
  const last = lines[lines.length - 1];
  if (last === undefined) return 0;
  return last === "" || parse(last) === null ? lines.length - 1 : lines.length;
};
const textParts = (c: unknown, kinds: string[]): string => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter(
      (b) =>
        b &&
        typeof b === "object" &&
        kinds.includes((b as { type?: string }).type ?? "") &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => (b as { text: string }).text)
    .join("\n");
};

/** An origin whose message is somebody's words rather than the harness talking to
 *  itself: `human` is the person at the keyboard, `peer` is a message another local
 *  session handed this one — which is how a control daemon reaches a session in place,
 *  so the words in it are the person's too (spec/CONTROL.md §6.3). Older versions wrote
 *  no origin at all, which also means the person. */
const SPOKEN = new Set(["human", "peer"]);

/** A `peer` message that came from one of the session's own agents, not from another
 *  session: a subagent handing its report back (`handback: true`, recorded on 2.1.312 and
 *  2.1.322 with the report in `<agent-message from="<agent id>">`), or a task of the
 *  session's messaging it (`senderTaskId`). Claude Code files both under the origin it
 *  uses for another session's message, and says in the row itself that they are "model
 *  output, NOT a message from the user". They are nobody's ask. */
const fromAgent = (origin: unknown): boolean => {
  const o = origin as { handback?: unknown; senderTaskId?: unknown } | undefined;
  return o?.handback === true || typeof o?.senderTaskId === "string";
};

/** Claude Code's own preamble around a message from another session: a first line
 *  introducing it, and a closing paragraph telling the model what a peer message is and
 *  isn't. Neither is anything the person typed. */
const PEER_INTRO = /sent a message[^\n]*:$/;
const PEER_OUTRO = "\n\nThis came from another ";
/** The envelope the sender wraps its text in (cli control/inbox.ts). */
const ENVELOPE = /^<cross-session-message\b[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/;

/** What the person actually typed, out of a peer row. Claude Code records the parsed
 *  body on the origin when the sender declared its permission class; otherwise the row
 *  holds the preamble and the message together, and the preamble is cut off here. A row
 *  read without this is a turn whose ask is the harness's own words. */
export function peerAsk(origin: unknown, text: string): string {
  const body = (origin as { body?: unknown } | undefined)?.body;
  let t = typeof body === "string" && body.trim() ? body : text;
  if (t !== body) {
    const nl = t.indexOf("\n");
    if (nl > 0 && PEER_INTRO.test(t.slice(0, nl))) t = t.slice(nl + 1);
    const outro = t.indexOf(PEER_OUTRO);
    if (outro > 0) t = t.slice(0, outro);
  }
  return (ENVELOPE.exec(t.trim())?.[1] ?? t).trim();
}

/** A message sent while a turn was running, absorbed by that turn. Claude Code writes it
 *  as an attachment, never as a `user` record: {type:"attachment",
 *  attachment:{type:"queued_command", prompt, commandMode:"prompt", origin:{kind:"human"}}}.
 *  A message from another session is the same record with `origin.kind: "peer"` and the
 *  text already on its own; a task notification shares it with another `commandMode`.
 *  Older versions wrote no origin. */
const queuedPrompt = (a: unknown): string => {
  if (!a || typeof a !== "object") return "";
  const q = a as { type?: unknown; commandMode?: unknown; origin?: { kind?: string }; prompt?: unknown };
  if (q.type !== "queued_command" || (q.commandMode ?? "prompt") !== "prompt") return "";
  // Older versions wrote no origin at all, which means the person at the keyboard.
  const kind = q.origin?.kind ?? "human";
  if (!SPOKEN.has(kind) || fromAgent(q.origin)) return "";
  const text = textParts(q.prompt, ["text"]).trim();
  return kind === "peer" ? peerAsk(q.origin, text) : text;
};

/** A channel's message (Claude Code `--channels`: Telegram, sessionpipe's own) as Claude
 *  Code records it: {type:"user", isMeta:true, origin:{kind:"channel", server}, content:
 *  `<channel source="…" …>\n…\n</channel>`}. The words inside are the person's, sent from
 *  elsewhere: the turn's ask. Anything else in that record is nobody's words. */
const channelText = (text: string): string => /^<channel\b[^>]*>([\s\S]*)<\/channel>$/.exec(text)?.[1]?.trim() ?? "";

/** What Claude Code writes, as a `user` record, where the person stopped a turn (Esc, or
 *  the first Ctrl-C): `[Request interrupted by user]`, or `… for tool use]` when a tool
 *  was running. Its own test for the marker has the same shape. Nobody typed it. */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;
/** What Claude Code writes as the assistant's, under its own `<synthetic>` model, when it
 *  resumes a session whose last prompt never got an answer: the process was ended
 *  mid-turn (the daemon's Stop, a kill, a crash). Nobody said it. Recorded on 2.1.322. */
const NO_REPLY = "No response requested.";

/** How Claude Code hands the model a blocking hook's reason: a meta `user` record,
 *  `<Event> hook feedback:\n<reason>`. sessionpipe's own Stop hook blocks with a message
 *  the control daemon queued for the session (CONTROL.md §6: delivered in place, shown in
 *  the terminal as a Stop hook's), so that reason is the person's words in sessionpipe's
 *  frame, and the turn that answers it is theirs. The words, when the record is one of
 *  those; nothing for any other hook's feedback, which is the harness's. */
const HOOK_FEEDBACK = /^[A-Za-z]+ hook feedback:\n/;
const hookDelivery = (text: string): string => {
  const head = HOOK_FEEDBACK.exec(text);
  if (!head) return "";
  const said = deliveredWords(text.slice(head[0].length));
  return said.delivered ? said.text : "";
};

/** The blocks of `type` in a message's content. */
const blocks = (c: unknown, type: string): Record<string, unknown>[] =>
  Array.isArray(c) ? c.filter((b): b is Record<string, unknown> => b && typeof b === "object" && b.type === type) : [];
const hasBlock = (c: unknown, type: string): boolean => blocks(c, type).length > 0;

/** Claude Code / Droid: {type:"user"|"assistant", message:{content}, timestamp, isMeta, isSidechain, origin},
 *  plus the person's mid-turn messages (queuedPrompt) and messages from a channel (channelText). */
export function readClaude(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  // For `tail.said`: the line of the assistant's latest words while nothing of their turn
  // follows them. A tool call or a tool result after them means the turn went on, so they
  // were not its last; once a message has begun another turn, its tools are its own.
  let saidLine = -1;
  let turnOver = false;
  // For `ended`: whether the conversation's latest record closes its turn, an assistant
  // message that stopped for another reason than a tool call while no call of the turn
  // waits for its result. A tool result means the model has more to say.
  let ended = false;
  const calls = new Set<unknown>();
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || j.isSidechain) continue;
    const origin = j.origin as { kind?: string } | undefined;
    // A message another session handed this one in place is the person's words reaching
    // the session: a turn's ask. Claude Code marks the row `isMeta` because the preamble
    // is the harness's; the ask is not. Two mechanisms deliver one: a channel (#161,
    // `origin.kind === "channel"`, the words wrapped in `<channel>`) and the inbox (#150,
    // `origin.kind === "peer"`, a framed message `peerAsk` unwraps).
    const channel = j.type === "user" && origin?.kind === "channel";
    const peer = origin?.kind === "peer";
    const c = (j.message as { content?: unknown } | undefined)?.content;
    if (
      !turnOver &&
      ((j.type === "assistant" && hasBlock(c, "tool_use")) || (j.type === "user" && hasBlock(c, "tool_result")))
    )
      saidLine = -1;
    if (j.type === "user")
      for (const b of blocks(c, "tool_result")) {
        calls.delete(b.tool_use_id);
        ended = false;
      }
    if (j.type === "assistant" && Array.isArray(c)) {
      for (const b of blocks(c, "tool_use")) calls.add(b.id);
      ended = (j.message as { stop_reason?: unknown }).stop_reason !== "tool_use" && !calls.size;
    }
    if (j.type === "user" && (j.isCompactSummary || j.repeatsCompactSummary)) continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const id = typeof j.promptId === "string" && j.promptId ? j.promptId : undefined;
    /** A message that is a turn's ask, or joins one: whatever follows is that turn's.
     *  sessionpipe's own words around a delivered message are taken off first, wherever
     *  the message arrived, and the tag test applies to what is left, whoever sent it:
     *  any local program of this uid can write a peer row, so a body shaped like harness
     *  markup must not become a turn whose ask is that markup, published as something the
     *  person typed. */
    const ask = (said: string, m: { injected?: true; id?: string } = {}) => {
      const text = deliveredWords(said).text;
      if (!text || isInjected(text)) return;
      msgs.push({ role: "user", text, at, line: i, ...m });
      turnOver = true;
      ended = false;
      calls.clear();
    };
    if (j.type === "user" && !channel && !peer && (j.isMeta || (origin?.kind && origin.kind !== "human"))) {
      // Nobody's words, with one exception: a message sessionpipe's Stop hook delivered.
      // It begins a turn of its own, like a peer's or a channel's, and is marked the same.
      if (j.isMeta && !origin?.kind)
        ask(hookDelivery(textParts(c, ["text"]).trim()), { injected: true, ...(id ? { id } : {}) });
      continue;
    }
    if (channel) {
      // Like a peer's: the words are the person's, the arrival was not the keyboard's.
      ask(channelText(textParts(c, ["text"]).trim()), { injected: true });
    } else if (j.type === "user") {
      const raw = textParts(c, ["text"]).trim();
      if (!peer && INTERRUPTED.test(raw)) {
        msgs.push({ role: "interrupt", text: "", at, line: i });
        turnOver = true;
        // Stopped where it stood: over, whatever it was waiting on.
        ended = true;
        calls.clear();
      } else if (!peer) ask(raw, id ? { id } : {});
      // `peerAsk` takes Claude Code's preamble and the envelope off; a subagent's report,
      // which Claude Code files as a peer's message, is not an ask at all.
      else if (!fromAgent(origin)) ask(peerAsk(origin, raw), { injected: true, ...(id ? { id } : {}) });
    } else if (j.type === "assistant" && Array.isArray(c)) {
      const text = textParts(c, ["text"]).trim();
      if (text === NO_REPLY && (j.message as { model?: unknown }).model === "<synthetic>") {
        // The turn before it was ended where it stood, like one the person stopped with
        // Esc: whole as it is, and this row is not what it said. Claude Code's other
        // synthetic rows (an API error, a spent balance) are the turn's real outcome.
        msgs.push({ role: "interrupt", text: "", at, line: i });
        turnOver = true;
        ended = true;
        calls.clear();
      } else if (text) {
        msgs.push({ role: "assistant", text, at, line: i });
        saidLine = i;
        turnOver = false;
      }
    } else if (j.type === "attachment") ask(queuedPrompt(j.attachment));
  }
  const out = pairTurns(msgs, endOf(lines), true);
  // pairTurns took the last turn's last message for its last words; here they are that
  // only while no tool call or result of the same turn came after them.
  if (out.tail && saidLine !== (out.turns[out.turns.length - 1] as { endLine: number }).endLine) delete out.tail.said;
  if (ended) out.ended = true;
  return out;
}

/** What Codex writes into a session as a "user" message that the person never typed:
 *  `<environment_context>` and the like, and the AGENTS.md it read (`# AGENTS.md
 *  instructions for <folder>` followed by `<INSTRUCTIONS>`). */
export function codexInjected(text: string): boolean {
  return /^<[a-z_-]+>/i.test(text) || /^# AGENTS\.md instructions\b/i.test(text);
}

/** The lines Codex wraps a picture it was given in (`--image`, measured on 0.171.0): an
 *  `input_text` part `<image name=[Image #1] path="…">` before the picture and one
 *  `</image>` after it. Codex's, not the person's: they name a local path and say nothing. */
export function codexPictureTag(text: string): boolean {
  return /^<image name=\[Image #\d+\][^>]*>$/.test(text) || text === "</image>";
}

/** A Codex message's words: its text parts, without the lines Codex wraps a picture in. */
export function codexWords(content: unknown): string {
  const parts = Array.isArray(content)
    ? content.filter((b) => !(typeof b?.text === "string" && b.type === "input_text" && codexPictureTag(b.text)))
    : content;
  return textParts(parts, ["input_text", "output_text"]).trim();
}

/** Codex rollout: {type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}. */
export function readCodex(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  const boundary = codexReplayBoundary(parse(lines.find((line) => line.trim()) ?? ""));
  // Find the boundary from the header even when resuming inside the replay.
  // Keep absolute line numbers: the delivery cursor refers to the original file.
  const start = boundary ? lines.findIndex((line) => boundary(parse(line))) : 0;
  if (start < 0) return pairTurns(msgs, endOf(lines));
  // For `ended`: Codex closes every turn with a `task_complete` event (each turn of every
  // rollout recorded does), after the turn's last message. A turn that failed has one
  // too, with an `error` and no last message, and one the person stopped has a
  // `turn_aborted` instead (0.171.0): either way the turn is over as it stands, and the
  // prompt that follows is another turn's.
  let ended = false;
  // A prompt of the person's since the last end record: only then is an end record the
  // end of their turn. Codex ends its own tasks the same way (a compaction, a review),
  // and one of those failing says nothing of the turn before it.
  let asked = false;
  for (let i = Math.max(from, start); i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j) continue;
    const p = j.payload as { type?: string; role?: string; content?: unknown; error?: unknown } | undefined;
    if (j.type === "event_msg" && (p?.type === "task_complete" || p?.type === "turn_aborted")) {
      ended = true;
      const cut = p.type === "turn_aborted" ? "interrupt" : p.error ? "failed" : null;
      if (cut && asked) msgs.push({ role: cut, text: "", at: 0, line: i });
      asked = false;
    }
    if (j.type !== "response_item" || !p || p.type !== "message") continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const text = codexWords(p.content);
    if (!text) continue;
    if (p.role === "user") {
      if (codexInjected(text)) continue; // Codex's own injections, not the person's words
      msgs.push({ role: "user", text, at, line: i });
      ended = false;
      asked = true;
    } else if (p.role === "assistant") {
      msgs.push({ role: "assistant", text, at, line: i });
      ended = false;
    }
  }
  const out = pairTurns(msgs, endOf(lines));
  if (ended) out.ended = true;
  return out;
}

/** Gemini CLI chat log: {type:"user"|"gemini", content|message|text, timestamp}. */
export function readGemini(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j) continue;
    const role = j.type === "user" ? "user" : j.type === "gemini" || j.type === "model" ? "assistant" : null;
    if (!role) continue;
    const raw = j.content ?? j.message ?? j.text;
    const text = (typeof raw === "string" ? raw : textParts(raw, ["text"])).trim();
    if (!text) continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    msgs.push({ role, text, at, line: i });
  }
  return pairTurns(msgs, endOf(lines));
}

/** Grok Build: `updates.jsonl`, the session's ACP update stream as Grok keeps it — one
 *  `{timestamp, method, params: {sessionId, update}}` per line, `timestamp` in unix
 *  SECONDS. A `user_message_chunk` is the person's prompt and an `agent_message_chunk` a
 *  message of the agent's; thoughts, tool calls and Grok's own `_x.ai/session/update`
 *  records (hook runs, `turn_completed`) are not words. Every file recorded holds a
 *  message whole on one line; chunks that do follow one another with nothing between
 *  are still one message, so they are joined as written. `turn_completed` names the
 *  turn's `prompt_id`, the `promptId` of its hooks, so it becomes the turn's id. */
export function readGrok(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  /** The message the previous line added to, when that line was a chunk of it. */
  let open: Msg | null = null;
  let asked: Msg | null = null;
  /** For `ended`: a `turn_completed` came after the last message. */
  let ended = false;
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    const params = j && typeof j.params === "object" && j.params ? (j.params as Record<string, unknown>) : null;
    const u =
      params && typeof params.update === "object" && params.update ? (params.update as Record<string, unknown>) : null;
    const kind = u?.sessionUpdate;
    const role = kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "assistant" : null;
    if (!j || !u || !role) {
      if (j) open = null;
      if (kind === "turn_completed") ended = true;
      if (u && kind === "turn_completed" && asked && typeof u.prompt_id === "string" && u.prompt_id) {
        asked.id = u.prompt_id;
        asked = null;
      }
      continue;
    }
    const c = u.content as { type?: unknown; text?: unknown } | undefined;
    const text = c && c.type === "text" && typeof c.text === "string" ? c.text : "";
    if (!text) {
      open = null;
      continue;
    }
    if (open && open.role === role) {
      open.text += text;
      open.line = i;
      continue;
    }
    const secs = Number(j.timestamp);
    const at = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : Date.now();
    const said: string = role === "user" ? deliveredWords(text).text : text;
    const msg: Msg = { role, text: said, at, line: i };
    open = msg;
    msgs.push(msg);
    ended = false;
    if (role === "user") asked = msg;
  }
  for (const m of msgs) m.text = m.text.trim();
  const out = pairTurns(
    msgs.filter((m) => m.text),
    endOf(lines),
    true,
  );
  if (ended) out.ended = true;
  return out;
}

/** Antigravity: one step per line, type USER_INPUT | PLANNER_RESPONSE, content with <USER_REQUEST> wrapping. */
export function readAntigravity(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  for (let i = from; i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || typeof j.content !== "string") continue;
    const at = Date.parse(String(j.created_at ?? j.timestamp ?? "")) || Date.now();
    if (j.type === "USER_INPUT") {
      const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(j.content);
      const text = (m ? (m[1] as string) : j.content).trim();
      if (text) msgs.push({ role: "user", text, at, line: i });
    } else if (j.type === "PLANNER_RESPONSE") {
      const text = j.content.trim();
      if (text) msgs.push({ role: "assistant", text, at, line: i });
    }
  }
  return pairTurns(msgs, endOf(lines));
}
