// SPDX-License-Identifier: Apache-2.0
// Transcript readers: complete turns (a person's message + everything the assistant
// said before the next one), each with the line it ends on, and the line the
// cursor may advance to once every turn is delivered. Ported from spacesheep-cli
// lib/memory.js. One reader per harness file format; nothing else is vendor code.
import { codexReplayBoundary } from "../adapters/codex-rollout.js";
import type { TranscriptRead } from "../adapters/types.js";

interface Msg {
  role: "user" | "assistant";
  text: string;
  at: number;
  line: number;
  /** This ask reached the session from somewhere other than its own keyboard: another
   *  local session handed it over, which is how a control daemon reaches a session in
   *  place (spec/CONTROL.md §6.3). The words are the person's; the arrival was not. */
  injected?: true;
}

export function pairTurns(msgs: Msg[], endLine: number): TranscriptRead {
  const turns: {
    user: string;
    assistant: string;
    at: number;
    startLine: number;
    endLine: number;
    injected?: true;
  }[] = [];
  let cur: (typeof turns)[number] | null = null;
  for (const m of msgs) {
    if (m.role === "user") {
      // Never overwrite a prompt that has no reply yet: in an agentic turn the reply
      // comes after tool calls, and a second user record is not a new question.
      if (cur && !cur.assistant) {
        cur.user += `\n\n${m.text}`;
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
      };
    } else {
      if (!cur) cur = { user: "", assistant: "", at: m.at, startLine: m.line, endLine: m.line };
      cur.assistant += (cur.assistant ? "\n\n" : "") + m.text;
      cur.endLine = m.line;
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
    })),
    line,
  };
  if (cur && !cur.assistant && cur.user)
    out.open = { user: cur.user, at: cur.at, ...(cur.injected ? { injected: true as const } : {}) };
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
  if (!SPOKEN.has(kind)) return "";
  const text = textParts(q.prompt, ["text"]).trim();
  return kind === "peer" ? peerAsk(q.origin, text) : text;
};

/** A channel's message (Claude Code `--channels`: Telegram, sessionpipe's own) as Claude
 *  Code records it: {type:"user", isMeta:true, origin:{kind:"channel", server}, content:
 *  `<channel source="…" …>\n…\n</channel>`}. The words inside are the person's, sent from
 *  elsewhere: the turn's ask. Anything else in that record is nobody's words. */
const channelText = (text: string): string => /^<channel\b[^>]*>([\s\S]*)<\/channel>$/.exec(text)?.[1]?.trim() ?? "";

/** Claude Code / Droid: {type:"user"|"assistant", message:{content}, timestamp, isMeta, isSidechain, origin},
 *  plus the person's mid-turn messages (queuedPrompt) and messages from a channel (channelText). */
export function readClaude(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
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
    if (j.type === "user" && (j.isCompactSummary || j.repeatsCompactSummary)) continue;
    if (j.type === "user" && !channel && !peer && (j.isMeta || (origin?.kind && origin.kind !== "human"))) continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const c = (j.message as { content?: unknown } | undefined)?.content;
    if (channel) {
      const text = channelText(textParts(c, ["text"]).trim());
      if (text) msgs.push({ role: "user", text, at, line: i });
    } else if (j.type === "user") {
      const raw = textParts(c, ["text"]).trim();
      const text = peer ? peerAsk(origin, raw) : raw;
      // The tag test applies to a peer row like any other. `peerAsk` has taken the
      // envelope off already, so what is left is the message itself — and any local
      // program of this uid can write one, so a body shaped like harness markup must not
      // become a turn whose ask is that markup, published as something the person typed.
      if (!text || isInjected(text)) continue;
      msgs.push({ role: "user", text, at, line: i, ...(peer ? { injected: true as const } : {}) });
    } else if (j.type === "assistant" && Array.isArray(c)) {
      const text = textParts(c, ["text"]).trim();
      if (text) msgs.push({ role: "assistant", text, at, line: i });
    } else if (j.type === "attachment") {
      const text = queuedPrompt(j.attachment);
      if (text && !isInjected(text)) msgs.push({ role: "user", text, at, line: i });
    }
  }
  return pairTurns(msgs, endOf(lines));
}

/** What Codex writes into a session as a "user" message that the person never typed:
 *  `<environment_context>` and the like, and the AGENTS.md it read (`# AGENTS.md
 *  instructions for <folder>` followed by `<INSTRUCTIONS>`). */
export function codexInjected(text: string): boolean {
  return /^<[a-z_-]+>/i.test(text) || /^# AGENTS\.md instructions\b/i.test(text);
}

/** Codex rollout: {type:"response_item", payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}. */
export function readCodex(lines: string[], from: number): TranscriptRead {
  const msgs: Msg[] = [];
  const boundary = codexReplayBoundary(parse(lines.find((line) => line.trim()) ?? ""));
  // Find the boundary from the header even when resuming inside the replay.
  // Keep absolute line numbers: the delivery cursor refers to the original file.
  const start = boundary ? lines.findIndex((line) => boundary(parse(line))) : 0;
  if (start < 0) return pairTurns(msgs, endOf(lines));
  for (let i = Math.max(from, start); i < lines.length; i++) {
    const j = lines[i] ? parse(lines[i] as string) : null;
    if (!j || j.type !== "response_item") continue;
    const p = j.payload as { type?: string; role?: string; content?: unknown } | undefined;
    if (!p || p.type !== "message") continue;
    const at = Date.parse(String(j.timestamp ?? "")) || Date.now();
    const text = textParts(p.content, ["input_text", "output_text"]).trim();
    if (!text) continue;
    if (p.role === "user") {
      if (codexInjected(text)) continue; // Codex's own injections, not the person's words
      msgs.push({ role: "user", text, at, line: i });
    } else if (p.role === "assistant") msgs.push({ role: "assistant", text, at, line: i });
  }
  return pairTurns(msgs, endOf(lines));
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
